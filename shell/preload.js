// Bridge between the Electron main process and the board page.
const { contextBridge, ipcRenderer } = require('electron');

// ---- Voice (Piper runs in main; audio plays here) ----
let current = null; // the clip playing now: { audio, done }
let speechGen = 0; // bumped by stopSpeech(): a line whose audio was still being made then never plays
let lineSeq = 0, lastStarted = 0; // lines play in the order speak() was called, even if made out of order
let paused = false; // the Pause button: the current line stops where it is, the next one waits
let resumeWaiters = [];
const waiting = new Set(); // speak()'s fallback waits (no Piper), so stopSpeech can end them too

function cutCurrent() {
  if (!current) return;
  current.audio.pause();
  current.done();
}

function playWav(wav) {
  lastActive = Date.now();
  cutCurrent(); // one voice at a time: a new line cuts off the old one (e.g. the "let me think" filler)
  const type = wav[0] === 0x52 && wav[1] === 0x49 ? 'audio/wav' : 'audio/mpeg'; // "RIFF" = Piper, else the Microsoft voice's MP3
  const url = URL.createObjectURL(new Blob([wav], { type }));
  const audio = new Audio(url);
  return new Promise((resolve) => {
    const done = () => {
      if (current && current.audio === audio) current = null;
      URL.revokeObjectURL(url);
      resolve();
    };
    current = { audio, done };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

/** Extra (not in the contract yet): make the audio first, so the board knows durationMs before drawing. */
async function prepareSpeech(text) {
  const { wav, durationMs } = await ipcRenderer.invoke('tts', text);
  return { durationMs, play: () => playWav(wav) };
}

/** The contract's speak(): resolves when the audio has finished. Never rejects, so the board can't get stuck. */
async function speak(text) {
  const gen = speechGen;
  const my = ++lineSeq;
  try {
    const clip = await prepareSpeech(text);
    while (paused && gen === speechGen) await new Promise((r) => resumeWaiters.push(r));
    // Skip it if it was stopped while being made, a later line already started, or the mic is open.
    if (gen !== speechGen || my < lastStarted || recording) return;
    lastStarted = my;
    subtitle(text);
    await clip.play();
  } catch (e) {
    if (gen !== speechGen) return;
    console.warn('speak() failed, waiting instead:', e.message);
    // Wait about as long as the line would take to say, so the drawing keeps its pace. stopSpeech ends it.
    await new Promise((r) => {
      const end = () => (clearTimeout(t), waiting.delete(end), r());
      const t = setTimeout(end, Math.max(1500, text.length * 55));
      waiting.add(end);
    });
  }
}

/** Cuts off the current line, and any line still being made (for interruptions). Their speak() resolves. */
function stopSpeech() {
  speechGen++;
  cutCurrent();
  subtitle('');
  wakeResumeWaiters(); // a paused line that gets stopped just ends
  for (const end of waiting) end();
  waiting.clear();
}

// ---- Mic: records until you stop talking (or the hotkey again), then main transcribes it ----
const SILENCE_MS = 1200; // this much quiet after speech = done
const NO_SPEECH_MS = 8000; // gave up waiting for speech
const MAX_MS = 20000;
const IGNORE_STOP_MS = 800; // a 'stop' this soon after the mic opened, before any speech, is a double tap
const CALIBRATE_MS = 300; // listen to the room this long before the beep
const TICK_MS = 50;
const SPEECH_TICKS = 3; // loud ticks in a row (~150ms) that count as speech
const MIN_THRESHOLD = 0.015; // loudness (RMS) that counts as speech, whatever the room sounded like
const MAX_THRESHOLD = 0.04;
let recording = null; // { stop } while the mic is open

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A short tone as a cue. Never throws: a missing beep must not lose the student's question. */
function beep(freq) {
  try {
    tone(freq);
  } catch (e) {
    console.warn('beep failed:', e.message);
  }
}

function tone(freq) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  osc.connect(gain).connect(ctx.destination);
  osc.onended = () => ctx.close();
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
}

async function listen() {
  if (recording) return; // already listening
  setPaused(false, false); // asking something new un-pauses
  stopSpeech(); // don't record the tutor's own voice (an answer, a filler, "I didn't catch that")
  // Claim the mic slot before any await, so a 'stop' arriving early still stops this recording.
  // Until the recorder exists, "stop" just marks that it should stop as soon as it starts.
  const claimedAt = performance.now();
  let rec = null, stream = null, ctx = null, timer = null;
  let manual = false, heard = false;
  recording = {
    stop: () => {
      // A second tap right after the mic opened is a double-tap, not "I'm done": ignore it.
      if (!heard && performance.now() - claimedAt < IGNORE_STOP_MS) return ipcRenderer.send('mic', 'ignored a stop (double tap?)');
      manual = true;
      if (rec && rec.state !== 'inactive') rec.stop();
    },
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });

    // Loudness meter for "stopped talking" detection.
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const level = () => {
      analyser.getFloatTimeDomainData(buf);
      return Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
    };

    // Measure the room BEFORE the beep, so the student's first words can't count as background.
    // Quietest moment, skipping exact zeros (the meter hasn't started yet).
    let noise = Infinity;
    for (let t = 0; t < CALIBRATE_MS; t += TICK_MS) {
      await sleep(TICK_MS);
      const rms = level();
      if (rms > 1e-4) noise = Math.min(noise, rms);
    }
    if (!isFinite(noise)) noise = 0;
    // Clamped (a loud hall can't make it deaf, a dead-quiet room can't make it hear every breath),
    // but always above the room itself, or silence would never be detected.
    const threshold = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, 3 * noise), 1.5 * noise);

    beep(880); // "talk now": only once the mic is really ready
    await sleep(180); // don't record (or count) our own beep

    rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    const stop = () => rec.state !== 'inactive' && rec.stop();
    const t0 = performance.now();
    let lastLoud = 0, loudRun = 0;
    timer = setInterval(() => {
      const t = performance.now() - t0;
      // Speech = loud for ~150ms in a row: a click, a cough or a desk bump is not a question.
      loudRun = level() > threshold ? loudRun + 1 : 0;
      if (loudRun >= SPEECH_TICKS) (heard = true), (lastLoud = t);
      if ((heard && t - lastLoud > SILENCE_MS) || (!heard && t > NO_SPEECH_MS) || t > MAX_MS) stop();
    }, TICK_MS);

    rec.start();
    ipcRenderer.send('mic', `listening (room ${noise.toFixed(3)}, speech above ${threshold.toFixed(3)})`);
    if (manual) stop(); // the hotkey asked to stop before the recorder was ready
    await stopped;
    beep(440);

    const ms = Math.round(performance.now() - t0);
    if (!heard) { // no speech (even if stopped by hand): silence makes Whisper invent words like "Thank you."
      ipcRenderer.send('mic', `heard nothing in ${ms}ms`);
      return ipcRenderer.send('heard-nothing', 'nothing');
    }
    const audio = new Uint8Array(await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer());
    ipcRenderer.send('mic', `recorded ${ms}ms, ${Math.round(audio.length / 1024)} KB`);
    return ipcRenderer.invoke('transcribe', audio);
  } finally {
    // Whatever happened (even a throw halfway through setup), free the mic for the next question.
    clearInterval(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    recording = null;
  }
}

// Main says 'start' or 'stop' (explicit, not a toggle: a stray press can't open a second recording).
ipcRenderer.on('listen', (_event, cmd) => {
  if (cmd === 'stop') return void (recording && recording.stop());
  listen().catch((e) => {
    ipcRenderer.send('mic', `error: ${e.message}`);
    ipcRenderer.send('heard-nothing', 'deaf');
  });
});

contextBridge.exposeInMainWorld('shell', {
  // Called with { visible, screenshot } when the hotkey is pressed.
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_event, payload) => cb(payload)),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  hide: () => ipcRenderer.send('hide-overlay'),
  speak,
  prepareSpeech,
  stopSpeech,
  sticker, // e.g. window.shell.sticker('correct') to show a reaction without answering a question
});

// ---- Controls: our own small bar on top of Aarav's board page (his test toolbar is hidden) ----
// Pause/Resume, Stop, and Type (type a question or an answer instead of saying it).

function wakeResumeWaiters() {
  const waiters = resumeWaiters;
  resumeWaiters = [];
  waiters.forEach((r) => r());
}

/** notify = also tell main (so the tutor holds the next step); false when main already knows. */
function setPaused(p, notify = true) {
  if (paused === p) return;
  paused = p;
  if (current) p ? current.audio.pause() : current.audio.play().catch(() => {});
  if (!p) wakeResumeWaiters();
  const btn = document.getElementById('tutor-pause');
  if (btn) btn.innerHTML = icon(p ? 'play' : 'pause');
  if (notify) ipcRenderer.send('control', p ? 'pause' : 'resume');
}

// Line icons for the bar (drawn here so every theme can colour them)
const ICON = {
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  again: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  test: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4"/><path d="M12 17.2v.1"/>',
  snip: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  draw: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 6l3 3"/>',
  save: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  type: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  theme: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5s.9-2 2-2H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><path d="M7.5 11h.01M10 7.5h.01M14.5 7.5h.01"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`;
const THEMES = { whiteboard: 'Whiteboard', notebook: 'Notebook', chalk: 'Chalkboard', neon: 'Neon' };

function toast(text) {
  const t = document.getElementById('tutor-toast');
  if (!t) return;
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), 1400);
}

// ---- Fun mode: a small curated pack (school-safe, offline). {n} = the streak. ----
const PACK = {
  correct: [['🧠', 'Big brain move'], ['🎯', 'Nailed it'], ['😎', 'Einstein who?'], ['🔥', 'Absolute legend'], ['🏆', 'GG, too easy'],
    ['🚀', 'To the moon'], ['🍎', "Teacher's pet unlocked"], ['💯', 'No notes. Perfect.'], ['🥇', 'Gold medal answer'], ['🤯', 'Mind = blown']],
  wrong: [['🤏', 'So close!'], ['🌀', 'Plot twist… not quite'], ['💪', 'Almost there'], ['😅', 'Oof. Run it back'], ['📈', 'Mistakes = XP'],
    ['🧩', 'One piece off'], ['🐢', 'Slow down, you got this']],
  streak: [['🔥', '{n} in a row!'], ['⚡', '{n} streak. Unstoppable'], ['👑', '{n} straight. Royalty']],
  break: [['🧃', 'Brain break! Stretch for 2 min'], ['💧', 'Hydration check'], ['🌱', '25 min done. Touch grass'], ['🍪', 'You earned a snack']],
};
let lastPick = '';
let studyStart = Date.now(); // for brain breaks: reset after a break or a long idle
let lastActive = Date.now();

function confetti(fx) {
  const colors = ['#ff4f6d', '#ffc23d', '#3dd6a5', '#4fa8ff', '#b06bff', '#ff8f3d'];
  for (let i = 0; i < 46; i++) {
    const b = document.createElement('span');
    b.className = 'tutor-bit';
    b.style.left = `${Math.random() * 100}%`;
    b.style.background = colors[i % colors.length];
    b.style.animationDuration = `${1.3 + Math.random() * 1.4}s`;
    b.style.animationDelay = `${Math.random() * 0.35}s`;
    fx.appendChild(b);
    setTimeout(() => b.remove(), 3200);
  }
}

/** Pops a sticker on the board (Fun mode only). kind: correct | wrong | streak | break. gif: optional image URL. */
function sticker(kind, n = 0, gif = '') {
  if (!document.body.classList.contains('tutor-fun')) return;
  const stage = document.getElementById('stage');
  if (!stage) return;
  let fx = document.getElementById('tutor-fx');
  if (!fx) (fx = document.createElement('div')), (fx.id = 'tutor-fx'), stage.appendChild(fx);
  const options = PACK[kind].filter(([, t]) => t !== lastPick);
  const [emoji, text] = options[Math.floor(Math.random() * options.length)];
  lastPick = text;
  const card = document.createElement('div');
  card.className = `tutor-sticker ${kind}`;
  card.innerHTML = `${gif ? `<img src="${gif}" alt="">` : `<span class="e">${emoji}</span>`}${text.replace('{n}', n)}`;
  fx.appendChild(card);
  if (kind === 'correct' || kind === 'streak') confetti(fx);
  setTimeout(() => card.remove(), 3300);
}

// A brain break after 25 minutes of studying (a long idle starts the count again)
setInterval(() => {
  const now = Date.now();
  if (now - lastActive > 10 * 60 * 1000) studyStart = now;
  else if (now - studyStart > 25 * 60 * 1000) {
    studyStart = now;
    sticker('break');
  }
}, 60 * 1000);

function subtitle(text) {
  const cap = document.getElementById('caption');
  if (cap) cap.textContent = text;
}

const CSS = `
  @font-face { font-family: 'Hand'; src: url('../shell/assets/fonts/PatrickHand-Regular.ttf'); }
  @font-face { font-family: 'Hand'; src: url('../shell/assets/fonts/Kalam-Regular.ttf'); unicode-range: U+0900-097F; } /* Hindi letters */
  /* ---- Themes: the bar and panels use these variables; the board itself is skinned further down ---- */
  body { --chrome: rgba(22,25,31,.96); --panel: #1d2128; --btn: rgba(255,255,255,.07); --btn-h: rgba(255,255,255,.16); --fg: #e8ecf2; --muted: #98a2ad;
    --accent: #6aa8ff; --field: #12151a; --cap-bg: #1d2128; --cap-fg: #eef1f5; --cap-font: system-ui, "Segoe UI", sans-serif; background: #15181d !important; }
  body.theme-notebook { --chrome: #2a2420; --panel: #332b26; --btn: rgba(255,240,220,.08); --btn-h: rgba(255,240,220,.18); --fg: #f6ead8; --muted: #c4b29b; --accent: #f2a65a; --field: #1f1a17; --cap-bg: #332b26; --cap-fg: #fbf3e6; --cap-font: 'Hand', cursive; background: #241f1b !important; }
  body.theme-chalk { --chrome: #10201a; --panel: #16291f; --btn: rgba(220,255,230,.07); --btn-h: rgba(220,255,230,.16); --fg: #e6f4ea; --muted: #9dbba8; --accent: #9fe0a8; --field: #0b1712; --cap-bg: #16291f; --cap-fg: #f3fbf5; --cap-font: 'Hand', cursive; background: #0d1a14 !important; }
  body.theme-neon { --chrome: #0c0a1d; --panel: #141032; --btn: rgba(160,120,255,.10); --btn-h: rgba(255,79,216,.22); --fg: #f1eaff; --muted: #a99ad6; --accent: #ff4fd8; --field: #08061a; --cap-bg: #141032; --cap-fg: #ffffff; --cap-font: system-ui, "Segoe UI", sans-serif; background: #07051a !important; }

  #toolbar, body > details, #history-panel { display: none !important; }
  #tutor-bar { display: flex; gap: 4px; align-items: center; padding: 6px 8px; background: var(--chrome); color: var(--fg); -webkit-app-region: drag; user-select: none; border-bottom: 1px solid rgba(255,255,255,.06); }
  #tutor-bar .title { flex: 1; font-size: 13px; font-weight: 600; letter-spacing: .02em; color: var(--muted); padding-left: 4px; white-space: nowrap; overflow: hidden; }
  #tutor-bar .title b { color: var(--accent); }
  #tutor-bar button, #tutor-type button, #tutor-draw-row button, #tutor-history-panel button { -webkit-app-region: no-drag; background: var(--btn); color: var(--fg); border: 0; border-radius: 9px; padding: 6px 12px; font-size: 14px; cursor: pointer; transition: background .15s, transform .1s, box-shadow .15s; }
  #tutor-bar button { padding: 0; width: 32px; height: 32px; display: grid; place-items: center; flex-shrink: 0; }
  #tutor-bar button svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  #tutor-bar button:hover, #tutor-type button:hover, #tutor-draw-row button:hover, #tutor-history-panel button:hover { background: var(--btn-h); }
  #tutor-bar button:active { transform: scale(.92); }
  #tutor-bar button.on { color: var(--accent); background: var(--btn-h); }
  body.theme-neon #tutor-bar button:hover { box-shadow: 0 0 12px rgba(255,79,216,.55); }
  #tutor-bar select, #tutor-settings select { -webkit-app-region: no-drag; background: var(--btn); color: var(--fg); border: 0; border-radius: 9px; padding: 6px 8px; font-size: 13px; }
  #tutor-bar select option, #tutor-settings select option { background: var(--panel); color: var(--fg); }
  #tutor-settings { display: none; gap: 18px; align-items: center; padding: 8px 12px; background: var(--panel); color: var(--fg); font-size: 14px; flex-wrap: wrap; }
  #tutor-settings.open { display: flex; }
  #tutor-settings input[type=checkbox] { accent-color: var(--accent); }
  #caption { background: var(--cap-bg) !important; color: var(--cap-fg) !important; font-family: var(--cap-font) !important; font-size: 16px; padding: 9px 14px !important; border-top: 1px solid rgba(255,255,255,.06); }
  body.tutor-big #caption { font-size: 26px !important; line-height: 1.35; padding: 12px 16px !important; }
  body.tutor-easy #caption, body.tutor-easy foreignObject div { font-family: Verdana, "DejaVu Sans", Arial, sans-serif !important; letter-spacing: 0.04em; word-spacing: 0.12em; }
  #tutor-draw-row, #tutor-type { display: none; gap: 6px; padding: 6px 8px; background: var(--panel); }
  #tutor-draw-row.open, #tutor-type.open { display: flex; }
  #tutor-draw-row input, #tutor-type input { flex: 1; padding: 7px 10px; border-radius: 9px; border: 1px solid rgba(255,255,255,.08); background: var(--field); color: var(--fg); font-size: 14px; outline: none; }
  #tutor-draw-row input:focus, #tutor-type input:focus { border-color: var(--accent); }
  #tutor-canvas { display: none; position: absolute; inset: 0; width: 100%; height: 100%; z-index: 5; cursor: crosshair; touch-action: none; }
  #tutor-canvas.open { display: block; }
  #tutor-history-panel { display: none; max-height: 220px; overflow-y: auto; background: var(--panel); border-top: 1px solid rgba(255,255,255,.06); padding: 6px 8px; }
  #tutor-history-panel.open { display: grid; gap: 4px; }
  #tutor-history-panel .row { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 8px 10px; background: var(--btn); border-radius: 9px; cursor: pointer; color: var(--fg); font-size: 14px; }
  #tutor-history-panel .row:hover { background: var(--btn-h); }
  #tutor-history-panel .q, #tutor-history-panel .t, #tutor-history-panel .head { color: var(--muted); font-size: 12px; }
  #tutor-history-panel .t { flex-shrink: 0; }
  #tutor-history-panel .head { display: flex; justify-content: space-between; align-items: center; padding: 2px 2px 4px; }
  #tutor-toast { position: fixed; left: 50%; top: 56px; transform: translateX(-50%) translateY(-8px); background: var(--chrome); color: var(--fg); border: 1px solid var(--accent); padding: 6px 14px; border-radius: 999px; font-size: 13px; opacity: 0; transition: all .25s; pointer-events: none; z-index: 20; }
  #tutor-toast.on { opacity: 1; transform: translateX(-50%); }

  /* ---- The board, skinned from outside (Aarav's drawing code is untouched) ---- */
  #stage { transition: background .3s; }
  #board foreignObject { overflow: visible !important; }

  /* ---- Fun mode: stickers when the AI grades a practice answer, a streak, brain breaks ---- */
  #tutor-fx { position: absolute; inset: 0; pointer-events: none; z-index: 8; overflow: hidden; }
  body:not(.tutor-fun) #tutor-fx, body:not(.tutor-fun) #tutor-streak { display: none !important; }
  .tutor-sticker { position: absolute; right: 18px; top: 16px; max-width: 46%; background: #fff; color: #111; border: 4px solid #111; border-radius: 18px; padding: 10px 18px 12px;
    box-shadow: 6px 6px 0 #111; text-align: center; font: 900 24px/1.1 Impact, "Anton", "DejaVu Sans Condensed", "Arial Black", sans-serif; text-transform: uppercase; letter-spacing: .02em;
    transform: rotate(-5deg) scale(0); animation: tutor-pop .5s cubic-bezier(.2,1.6,.4,1) forwards, tutor-out .4s ease-in 2.7s forwards; }
  .tutor-sticker .e { display: block; font-size: 58px; line-height: 1.05; margin-bottom: 4px; }
  .tutor-sticker img { display: block; max-width: 220px; max-height: 150px; border-radius: 10px; margin: 0 auto 8px; }
  .tutor-sticker.wrong { background: #fff1b8; animation: tutor-pop .5s cubic-bezier(.2,1.6,.4,1) forwards, tutor-shake .5s .5s, tutor-out .4s ease-in 2.7s forwards; }
  .tutor-sticker.break { background: #d6f5ff; right: auto; left: 18px; transform: rotate(4deg) scale(0); }
  .tutor-sticker.streak { background: #ffe0cc; }
  body.theme-neon .tutor-sticker { background: #160f38; color: #fff; border-color: #ff4fd8; box-shadow: 0 0 18px rgba(255,79,216,.8); }
  body.theme-chalk .tutor-sticker { box-shadow: 6px 6px 0 #0b1712; }
  @keyframes tutor-pop { to { transform: rotate(-5deg) scale(1); } }
  @keyframes tutor-out { to { transform: rotate(-5deg) scale(.6) translateY(-30px); opacity: 0; } }
  @keyframes tutor-shake { 0%,100% { margin-right: 0 } 20%,60% { margin-right: 10px } 40%,80% { margin-right: -10px } }
  .tutor-bit { position: absolute; top: -12px; width: 9px; height: 14px; border-radius: 2px; animation: tutor-fall linear forwards; }
  @keyframes tutor-fall { to { transform: translateY(560px) rotate(720deg); opacity: .2; } }
  #tutor-streak { display: none; -webkit-app-region: no-drag; padding: 4px 10px; border-radius: 999px; background: rgba(255,140,60,.18); color: #ffb37a; font-weight: 700; font-size: 13px; white-space: nowrap; }
  #tutor-streak.on { display: inline-block; } /* text measured in one theme's font must not be clipped in another's */
  body:not(.theme-whiteboard) #board > rect:first-of-type { fill: transparent !important; }
  body.theme-notebook #stage { background: #fbf6e9 repeating-linear-gradient(to bottom, transparent 0 27px, rgba(80,130,200,.28) 27px 28px); }
  body.theme-notebook #stage::before { content: ''; position: absolute; top: 0; bottom: 0; left: 46px; width: 2px; background: rgba(220,80,80,.45); pointer-events: none; }
  body.theme-notebook #board foreignObject div:not([class*=katex]) { font-family: 'Hand', cursive !important; font-size: 24px !important; }
  body.theme-chalk #stage { background: radial-gradient(ellipse at 50% 40%, #2c5a45 0%, #1d3d2f 60%, #142a20 100%); box-shadow: inset 0 0 0 10px #6b4a2b, inset 0 0 0 12px #3d2a18; }
  body.theme-chalk #board { filter: invert(1) hue-rotate(180deg) brightness(1.08) drop-shadow(0 0 .6px rgba(255,255,255,.55)); }
  body.theme-chalk #board foreignObject div:not([class*=katex]) { font-family: 'Hand', cursive !important; font-size: 24px !important; }
  body.theme-neon #stage { background: #0b0820 linear-gradient(rgba(140,90,255,.10) 1px, transparent 1px) 0 0 / 32px 32px, #0b0820 linear-gradient(90deg, rgba(140,90,255,.10) 1px, transparent 1px) 0 0 / 32px 32px; }
  body.theme-neon #board { filter: invert(1) hue-rotate(180deg) saturate(2.4) drop-shadow(0 0 2px rgba(120,230,255,.9)) drop-shadow(0 0 7px rgba(200,90,255,.55)); }
`;

window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'tutor-bar';
  bar.innerHTML = `<span class="title"><b>●</b> Whiteboard tutor</span>
    <span id="tutor-streak" title="Practice answers right in a row"></span>
    <select id="tutor-level" title="Who is learning? Changes how it explains">
      <option value="kid">🧒 Kid</option><option value="student" selected>🎒 Student</option><option value="expert">🎓 Expert</option>
    </select>
    <select id="tutor-language" title="Language to listen and explain in">
      <option value="english" selected>English</option><option value="hinglish">Hinglish</option><option value="hindi">हिन्दी</option>
      <option value="spanish">Español</option><option value="german">Deutsch</option><option value="french">Français</option><option value="italian">Italiano</option>
    </select>
    <button id="tutor-pause" title="Pause / resume the explanation">${icon('pause')}</button>
    <button id="tutor-stop" title="Stop and close (Esc)">${icon('stop')}</button>
    <button id="tutor-again" title="Didn't get it? Explain it a different way">${icon('again')}</button>
    <button id="tutor-test" title="Test me: a practice question on this">${icon('test')}</button>
    <button id="tutor-snip" title="Snip: pick just the part of the screen you mean">${icon('snip')}</button>
    <button id="tutor-draw" title="Draw: sketch a problem and ask about it">${icon('draw')}</button>
    <button id="tutor-save" title="Save this board as notes (PDF + image)">${icon('save')}</button>
    <button id="tutor-type-btn" title="Type instead of talking">${icon('type')}</button>
    <button id="tutor-history" title="Saved boards">${icon('history')}</button>
    <button id="tutor-theme" title="Change the look: Whiteboard, Notebook, Chalkboard, Neon">${icon('theme')}</button>
    <button id="tutor-settings-btn" title="Settings: look, fun mode, voice speed, subtitles">${icon('settings')}</button>`;
  const typeRow = document.createElement('div');
  typeRow.id = 'tutor-type';
  typeRow.innerHTML = `<input id="tutor-input" placeholder="Type a question, or your answer to the tutor's question… (Enter to send)">
    <button id="tutor-send">Send</button>`;
  const settingsRow = document.createElement('div');
  settingsRow.id = 'tutor-settings';
  settingsRow.innerHTML = `<label>Look <select id="tutor-theme-pick">${Object.entries(THEMES).map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
    <label><input type="checkbox" id="tutor-fun" checked> Fun mode (stickers & memes)</label>
    <label>Voice speed <select id="tutor-speed"><option value="slow">Slow</option><option value="normal" selected>Normal</option><option value="fast">Fast</option></select></label>
    <label><input type="checkbox" id="tutor-bigtext"> Big subtitles</label>
    <label><input type="checkbox" id="tutor-easyfont"> Easy-read font</label>`;
  document.body.prepend(settingsRow);
  // ---- Draw input: a transparent layer over the board; the board + sketch go to the AI as the picture ----
  const drawRow = document.createElement('div');
  drawRow.id = 'tutor-draw-row';
  drawRow.innerHTML = `<input id="tutor-draw-q" placeholder="What do you want to know about your drawing? (optional)">
    <button id="tutor-draw-ask">Ask about my drawing</button><button id="tutor-draw-clear">Clear</button><button id="tutor-draw-close">Close</button>`;
  document.body.prepend(drawRow);
  const canvas = document.createElement('canvas');
  canvas.id = 'tutor-canvas';
  const ctx2d = canvas.getContext('2d');
  let drawing = false;
  const fitCanvas = () => {
    const stage = document.getElementById('stage');
    if (!stage) return;
    if (canvas.parentNode !== stage) stage.appendChild(canvas);
    const ratio = window.devicePixelRatio || 1;
    const keep = canvas.width ? ctx2d.getImageData(0, 0, canvas.width, canvas.height) : null;
    canvas.width = stage.clientWidth * ratio;
    canvas.height = stage.clientHeight * ratio;
    ctx2d.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (keep) ctx2d.putImageData(keep, 0, 0);
  };
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    ctx2d.strokeStyle = '#d0312d';
    ctx2d.lineWidth = 4;
    ctx2d.lineCap = 'round';
    ctx2d.lineJoin = 'round';
    ctx2d.beginPath();
    ctx2d.moveTo(...point(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    ctx2d.lineTo(...point(e));
    ctx2d.stroke();
  });
  canvas.addEventListener('pointerup', () => (drawing = false));
  const clearCanvas = () => ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  const openDrawing = (open) => {
    if (open) fitCanvas();
    drawRow.classList.toggle('open', open);
    canvas.classList.toggle('open', open);
    ipcRenderer.send('typing', open); // keys go to the question box, Esc doesn't close the overlay
  };
  window.addEventListener('resize', () => canvas.classList.contains('open') && fitCanvas());

  const historyPanel = document.createElement('div');
  historyPanel.id = 'tutor-history-panel';
  document.body.prepend(historyPanel);
  document.body.prepend(typeRow);
  document.body.prepend(bar);
  const toastEl = document.createElement('div');
  toastEl.id = 'tutor-toast';
  document.body.appendChild(toastEl);

  const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function showHistory() {
    const list = await ipcRenderer.invoke('history-list');
    historyPanel.innerHTML =
      `<div class="head"><span>Saved boards (${list.length})</span>${list.length ? '<button id="tutor-history-clear">Clear all</button>' : ''}</div>` +
      (list.length
        ? list
            .map((h) => {
              const when = new Date(h.timestamp).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
              return `<div class="row" data-i="${h.i}"><div><div>${esc(h.topic)}</div><div class="q">${esc(h.question)}</div></div><span class="t">${esc(when)}</span></div>`;
            })
            .join('')
        : '<div class="q" style="padding:8px 2px">No saved boards yet. Ask something first.</div>');
    historyPanel.querySelectorAll('.row').forEach((row) => {
      row.onclick = () => {
        historyPanel.classList.remove('open');
        ipcRenderer.invoke('history-open', Number(row.dataset.i));
      };
    });
    const clear = historyPanel.querySelector('#tutor-history-clear');
    if (clear) clear.onclick = async () => {
      await ipcRenderer.invoke('history-clear');
      showHistory();
    };
  }

  const input = typeRow.querySelector('input');
  const openTyping = (open) => {
    typeRow.classList.toggle('open', open);
    ipcRenderer.send('typing', open);
    if (open) input.focus();
  };
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    openTyping(false);
    ipcRenderer.send('typed', text);
  };
  bar.querySelector('#tutor-pause').onclick = () => setPaused(!paused);
  bar.querySelector('#tutor-stop').onclick = () => ipcRenderer.send('hide-overlay');
  bar.querySelector('#tutor-again').onclick = () => ipcRenderer.send('again');
  bar.querySelector('#tutor-test').onclick = () => ipcRenderer.send('test-me');
  bar.querySelector('#tutor-snip').onclick = () => ipcRenderer.send('snip');
  bar.querySelector('#tutor-draw').onclick = () => openDrawing(!drawRow.classList.contains('open'));
  drawRow.querySelector('#tutor-draw-clear').onclick = clearCanvas;
  drawRow.querySelector('#tutor-draw-close').onclick = () => (clearCanvas(), openDrawing(false));
  drawRow.querySelector('#tutor-draw-ask').onclick = async () => {
    const q = drawRow.querySelector('#tutor-draw-q');
    await ipcRenderer.invoke('drawn', q.value); // captured with the sketch still showing
    q.value = '';
    clearCanvas();
    openDrawing(false);
  };
  bar.querySelector('#tutor-save').onclick = async () => {
    try {
      subtitle(await ipcRenderer.invoke('save-notes'));
    } catch (e) {
      subtitle(`Couldn't save the notes: ${e.message}`);
    }
  };
  const level = bar.querySelector('#tutor-level');
  const language = bar.querySelector('#tutor-language');
  const speed = settingsRow.querySelector('#tutor-speed');
  const bigText = settingsRow.querySelector('#tutor-bigtext');
  const easyFont = settingsRow.querySelector('#tutor-easyfont');
  const themePick = settingsRow.querySelector('#tutor-theme-pick');
  const fun = settingsRow.querySelector('#tutor-fun');
  const applyLook = () => {
    document.body.classList.toggle('tutor-big', bigText.checked);
    document.body.classList.toggle('tutor-easy', easyFont.checked);
    for (const t of Object.keys(THEMES)) document.body.classList.toggle(`theme-${t}`, themePick.value === t);
    document.body.classList.toggle('tutor-fun', fun.checked);
  };
  const setTheme = (t) => {
    themePick.value = t;
    applyLook();
    ipcRenderer.send('settings-set', { theme: t });
  };
  bar.querySelector('#tutor-theme').onclick = () => {
    const names = Object.keys(THEMES);
    const next = names[(names.indexOf(themePick.value) + 1) % names.length];
    setTheme(next);
    toast(THEMES[next]);
  };
  themePick.onchange = () => setTheme(themePick.value);
  fun.onchange = () => (applyLook(), ipcRenderer.send('settings-set', { fun: fun.checked }));
  ipcRenderer
    .invoke('settings-get')
    .then((s) => {
      if (!s) return;
      if (s.level) level.value = s.level;
      if (s.language) language.value = s.language;
      if (s.speed) speed.value = s.speed;
      bigText.checked = !!s.bigText;
      easyFont.checked = !!s.easyFont;
      if (THEMES[s.theme]) themePick.value = s.theme;
      fun.checked = s.fun !== false;
      applyLook();
    })
    .catch(() => {});
  bar.querySelector('#tutor-settings-btn').onclick = () => settingsRow.classList.toggle('open');
  speed.onchange = () => ipcRenderer.send('settings-set', { speed: speed.value });
  bigText.onchange = () => (applyLook(), ipcRenderer.send('settings-set', { bigText: bigText.checked }));
  easyFont.onchange = () => (applyLook(), ipcRenderer.send('settings-set', { easyFont: easyFont.checked }));
  level.onchange = () => ipcRenderer.send('settings-set', { level: level.value });
  language.onchange = () => ipcRenderer.send('settings-set', { language: language.value });
  ipcRenderer.on('react', (_event, { kind, streak }) => {
    sticker(kind === 'correct' && streak >= 3 ? 'streak' : kind, streak);
    const pill = bar.querySelector('#tutor-streak');
    pill.textContent = `🔥 ${streak}`;
    pill.classList.toggle('on', streak >= 2);
  });
  bar.querySelector('#tutor-type-btn').onclick = () => openTyping(!typeRow.classList.contains('open'));
  // Saved boards live on disk (main keeps them); clicking one redraws it and follow-ups continue from it.
  ipcRenderer.on('open-history', () => {
    historyPanel.classList.add('open');
    showHistory();
  });
  bar.querySelector('#tutor-history').onclick = () => {
    const open = !historyPanel.classList.contains('open');
    historyPanel.classList.toggle('open', open);
    if (open) showHistory();
  };
  typeRow.querySelector('#tutor-send').onclick = send;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
    if (e.key === 'Escape') openTyping(false);
  });
});
