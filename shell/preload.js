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

contextBridge.exposeInMainWorld('shell', {
  // Called with { visible, screenshot } when the hotkey is pressed.
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_event, payload) => cb(payload)),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  hide: () => ipcRenderer.send('hide-overlay'),
  speak,
  prepareSpeech,
  stopSpeech,
});
