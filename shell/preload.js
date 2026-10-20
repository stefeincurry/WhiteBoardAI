// Bridge between the Electron main process and the board page.
const { contextBridge, ipcRenderer } = require('electron');

// ---- Voice (Piper runs in main; audio plays here) ----
let current = null; // the clip playing now: { audio, done }

function playWav(wav) {
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
  try {
    await (await prepareSpeech(text)).play();
  } catch (e) {
    console.warn('speak() failed, waiting instead:', e.message);
    await new Promise((r) => setTimeout(r, Math.max(1500, text.length * 55)));
  }
}

/** Cuts off the current line (for interruptions). Its speak() promise resolves right away. */
function stopSpeech() {
  if (!current) return;
  current.audio.pause();
  current.done();
}

// ---- Mic: records until you stop talking (or the hotkey again), then main transcribes it ----
const SILENCE_MS = 1200; // this much quiet after speech = done
const NO_SPEECH_MS = 8000; // gave up waiting for speech
const MAX_MS = 20000;
let recording = null; // { stop } while the mic is open

function beep(freq) {
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
  if (recording) return recording.stop(); // hotkey while listening = stop now
  beep(880);
  await new Promise((r) => setTimeout(r, 180)); // don't record our own beep
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  // Loudness meter for "stopped talking" detection.
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let noise = 0, samples = 0, heard = false, lastLoud = 0, manual = false;
  const t0 = performance.now();

  const stopped = new Promise((r) => (rec.onstop = r));
  const stop = () => rec.state !== 'inactive' && rec.stop();
  recording = { stop: () => ((manual = true), stop()) };
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
    const t = performance.now() - t0;
    if (t < 300) return void ((noise += rms), samples++); // learn the room's background level first
    if (rms > Math.max(0.015, (3 * noise) / Math.max(samples, 1))) (heard = true), (lastLoud = t);
    if ((heard && t - lastLoud > SILENCE_MS) || (!heard && t > NO_SPEECH_MS) || t > MAX_MS) stop();
  }, 50);

  rec.start();
  ipcRenderer.send('mic', 'listening');
  await stopped;
  clearInterval(timer);
  stream.getTracks().forEach((t) => t.stop());
  ctx.close();
  recording = null;
  beep(440);

  const ms = Math.round(performance.now() - t0);
  if (!heard && !manual) return ipcRenderer.send('mic', `heard nothing in ${ms}ms`);
  const audio = new Uint8Array(await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer());
  ipcRenderer.send('mic', `recorded ${ms}ms, ${Math.round(audio.length / 1024)} KB`);
  return ipcRenderer.invoke('transcribe', audio);
}

ipcRenderer.on('listen', () => listen().catch((e) => ipcRenderer.send('mic', `error: ${e.message}`)));

contextBridge.exposeInMainWorld('shell', {
  // Called with { visible, screenshot } when the hotkey is pressed.
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_event, payload) => cb(payload)),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  hide: () => ipcRenderer.send('hide-overlay'),
  speak,
  prepareSpeech,
  stopSpeech,
});
