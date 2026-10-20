// Minimal Electron overlay starter (Kabir's side). UNTESTED: expect to fix things.
//
// What it does:
//  - Global hotkey Ctrl/Cmd+Shift+Space
//  - Takes a screenshot BEFORE showing the overlay (so it doesn't capture itself)
//  - Shows a frameless, always-on-top window docked to the right 40% of the screen
//  - Loads Aarav's board page and sends it the screenshot over IPC
//
//  - Esc hides it again. `npm start -- --fire-hotkey` fakes one hotkey press (testing).
//  - Voice: Piper (tts/piper.js), exposed to the page as window.shell.speak(text).
//    `npm start -- --play tools/out/some-script.json` plays that script with the real voice on hotkey.
//  - Mic: the overlay listens after it opens (beep), stops after ~1.2s of quiet (lower beep),
//    then Whisper (stt/transcribe.js) writes it down. Hotkey while listening = stop now.
//  - Saves the last screenshot to tools/out/last-screenshot.png (check it doesn't show the overlay)
//
// TODO (see CLAUDE.md): mic + Whisper, callModel, speak(), wiring to board.playScript().

const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const piper = require('./tts/piper');
const { tidyScript } = require('./llm/tidy');
const { transcribe } = require('./stt/transcribe');

const OUT_DIR = path.join(__dirname, 'tools', 'out');
let win = null;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.round(workArea.width * 0.4);

  win = new BrowserWindow({
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height: workArea.height,
    frame: false,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'board', 'index.html'));

  // Esc while the overlay is focused hides it (a global Esc would steal it from every app).
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      win.hide();
      win.webContents.reload(); // Esc = done: stops the voice and drawing, fresh board next time
      console.log('[overlay] hidden (Esc), stopped');
    }
  });
}

async function captureScreen() {
  const t0 = Date.now();
  const { size } = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: size.width, height: size.height },
  });
  if (!sources.length) {
    console.warn('[shot] no screen sources (screen capture blocked?)');
    return null;
  }
  const img = sources[0].thumbnail;
  const png = img.toPNG();
  fs.promises
    .mkdir(OUT_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(path.join(OUT_DIR, 'last-screenshot.png'), png))
    .catch((e) => console.warn('[shot] could not save:', e.message));
  const { width, height } = img.getSize();
  console.log(`[shot] ${width}x${height}, ${Math.round(png.length / 1024)} KB in ${Date.now() - t0}ms`);
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function onHotkey() {
  // Hotkey while visible: stops the mic if it's listening, otherwise listens again (follow-up, step 7).
  if (win.isVisible()) {
    console.log('[hotkey] pressed while open');
    win.webContents.send('hotkey', { visible: true });
    if (!playFile) win.webContents.send('listen');
    return;
  }
  console.log('[hotkey] pressed');
  const screenshot = await captureScreen(); // capture first, then show
  win.show();
  console.log('[overlay] shown at', JSON.stringify(win.getBounds()));
  win.webContents.send('hotkey', { visible: false, screenshot });
  if (playFile) playTestScript(playFile);
  else win.webContents.send('listen');
}

// Testing only (until step 5 wires the real flow): play a saved script with the real voice.
const playArg = process.argv.indexOf('--play');
const playFile = playArg === -1 ? null : path.resolve(process.argv[playArg + 1]);
function playTestScript(file) {
  const { script, fixes } = tidyScript(JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log(`[play] ${path.basename(file)}: ${script.steps.length} steps, ${fixes.length} layout fixes`);
  win.webContents
    .executeJavaScript(`window.board.clearBoard(); window.board.playScript(${JSON.stringify(script)}, window.shell.speak)`)
    .then(() => console.log('[play] done'))
    .catch((e) => console.warn('[play] failed:', e.message));
}

ipcMain.handle('capture-screen', captureScreen);
ipcMain.on('mic', (_event, status) => console.log(`[mic] ${status}`));
ipcMain.handle('transcribe', async (_event, audio) => {
  try {
    const { text, ms } = await transcribe(Buffer.from(audio), 'audio/webm');
    console.log(`[heard] "${text}" (${ms}ms)`);
    // TODO step 5: callModel({ question: text, screenshot }) -> board.playScript(script, speak)
    return text;
  } catch (e) {
    console.warn('[heard] failed:', e.message);
    return '';
  }
});
ipcMain.handle('tts', async (_event, text) => {
  const { wav, durationMs, synthMs } = await piper.synth(text);
  console.log(`[voice] ${(durationMs / 1000).toFixed(1)}s of speech made in ${synthMs}ms: "${text.slice(0, 50)}"`);
  return { wav, durationMs };
});
ipcMain.on('hide-overlay', () => win && win.hide());

app.whenReady().then(() => {
  piper.start().catch((e) => console.warn('[piper] not available:', e.message)); // load the voice now, not on first line
  createWindow();
  const ok = globalShortcut.register('CommandOrControl+Shift+Space', onHotkey);
  console.log(ok ? '[hotkey] Ctrl/Cmd+Shift+Space registered' : '[hotkey] could NOT register (another app using it?)');
  if (process.argv.includes('--fire-hotkey')) win.webContents.once('did-finish-load', () => setTimeout(onHotkey, 500));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  piper.stop();
});
app.on('window-all-closed', () => app.quit());
