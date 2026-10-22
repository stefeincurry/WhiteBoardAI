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
  cutCurrent(); // one voice at a time: a new line cuts off the old one (e.g. the "let me think" filler)
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
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
  if (btn) btn.textContent = p ? '▶' : '⏸';
  if (notify) ipcRenderer.send('control', p ? 'pause' : 'resume');
}

function subtitle(text) {
  const cap = document.getElementById('caption');
  if (cap) cap.textContent = text;
}

const CSS = `
  #toolbar, body > details, #history-panel { display: none !important; }
  #tutor-bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; background: #2a2f35; -webkit-app-region: drag; user-select: none; }
  #tutor-bar .title { flex: 1; font-size: 13px; color: #9aa4ae; padding-left: 4px; }
  #tutor-bar button, #tutor-type button { -webkit-app-region: no-drag; background: #3a4048; color: #eee; border: 0; border-radius: 6px; padding: 6px 12px; font-size: 14px; cursor: pointer; }
  #tutor-bar button:hover, #tutor-type button:hover { background: #4a525c; }
  #tutor-bar select { -webkit-app-region: no-drag; background: #3a4048; color: #eee; border: 0; border-radius: 6px; padding: 6px 8px; font-size: 14px; }
  #tutor-type { display: none; gap: 6px; padding: 6px 8px; background: #2a2f35; }
  #tutor-type.open { display: flex; }
  #tutor-history-panel { display: none; max-height: 220px; overflow-y: auto; background: #232830; border-top: 1px solid #3a4048; padding: 6px 8px; }
  #tutor-history-panel.open { display: grid; gap: 4px; }
  #tutor-history-panel .row { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 7px 10px; background: #2e343b; border-radius: 6px; cursor: pointer; color: #eee; font-size: 14px; }
  #tutor-history-panel .row:hover { background: #3a434e; }
  #tutor-history-panel .q { color: #9aa4ae; font-size: 12px; }
  #tutor-history-panel .t { flex-shrink: 0; color: #9aa4ae; font-size: 12px; }
  #tutor-history-panel .head { display: flex; justify-content: space-between; align-items: center; color: #9aa4ae; font-size: 12px; padding: 2px 2px 4px; }
  #tutor-history-panel button { background: #3a4048; color: #eee; border: 0; border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
  #tutor-type input { flex: 1; padding: 6px 10px; border-radius: 6px; border: 0; background: #1b1f23; color: #eee; font-size: 14px; outline: none; }
`;

window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'tutor-bar';
  bar.innerHTML = `<span class="title">Whiteboard tutor</span>
    <select id="tutor-level" title="Who is learning? Changes how it explains">
      <option value="kid">🧒 Kid</option><option value="student" selected>🎒 Student</option><option value="expert">🎓 Expert</option>
    </select>
    <button id="tutor-pause" title="Pause / resume the explanation">⏸</button>
    <button id="tutor-stop" title="Stop and close (Esc)">⏹</button>
    <button id="tutor-again" title="Didn't get it? Explain it a different way">🔁</button>
    <button id="tutor-test" title="Test me: a practice question on this">🧠</button>
    <button id="tutor-save" title="Save this board as notes (PDF + image)">💾</button>
    <button id="tutor-type-btn" title="Type instead of talking">⌨</button>
    <button id="tutor-history" title="Saved boards">📋</button>`;
  const typeRow = document.createElement('div');
  typeRow.id = 'tutor-type';
  typeRow.innerHTML = `<input id="tutor-input" placeholder="Type a question, or your answer to the tutor's question… (Enter to send)">
    <button id="tutor-send">Send</button>`;
  const historyPanel = document.createElement('div');
  historyPanel.id = 'tutor-history-panel';
  document.body.prepend(historyPanel);
  document.body.prepend(typeRow);
  document.body.prepend(bar);

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
  bar.querySelector('#tutor-save').onclick = async () => {
    try {
      subtitle(await ipcRenderer.invoke('save-notes'));
    } catch (e) {
      subtitle(`Couldn't save the notes: ${e.message}`);
    }
  };
  const level = bar.querySelector('#tutor-level');
  ipcRenderer.invoke('settings-get').then((s) => s && s.level && (level.value = s.level)).catch(() => {});
  level.onchange = () => ipcRenderer.send('settings-set', { level: level.value });
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
