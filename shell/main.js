// Electron overlay (Kabir's side): window, hotkey, screenshot, and the wiring between the pieces.
//
//  - Global hotkey Ctrl/Cmd+Shift+Space. First press: screenshot (BEFORE the overlay shows, so it
//    doesn't capture itself), overlay docks to the right 40% of the screen, mic starts (beep).
//  - You stop talking (~1.2s quiet, lower beep) -> Whisper (stt/transcribe.js) -> callModel()
//    (llm/callModel.js, with the screenshot) -> tidyScript() -> Aarav's board + Piper voice.
//    What the hotkey means after that (stop mic / interrupt / follow-up) lives in tutor.js.
//  - Esc (overlay focused) closes it and stops everything.
//  - Voice: Piper (tts/piper.js), given to the page as window.shell.speak(text).
//  - Saves the screenshot the AI sees to tools/out/last-screenshot.jpg.
//
// Testing: `npm start -- --fire-hotkey` fakes one hotkey press;
//          `npm start -- --play tools/out/some-script.json` plays a saved script instead of asking.

const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const piper = require('./tts/piper');
const { tidyScript } = require('./llm/tidy');
const { transcribe } = require('./stt/transcribe');
const { createTutor, PHRASES } = require('./tutor');

const OUT_DIR = path.join(__dirname, 'tools', 'out');
const SHOT_MAX_WIDTH = 1280; // smaller image = faster upload and fewer image tokens for the AI

const playArg = process.argv.indexOf('--play');
const playFile = playArg === -1 ? null : path.resolve(process.argv[playArg + 1]);

let win = null;
let screenshot = null; // taken when the overlay opens, sent with the question
let tutor = null;
let opening = false; // the overlay is on its way up (screenshot, page load): ignore more presses until it's open
let closes = 0; // counts dismiss() calls, so an open that was Esc'd halfway doesn't carry on
const speechAhead = new Map(); // text -> Promise of Piper audio, made early (the next step's line while this one plays)
const fixedSpeech = new Map(); // text -> Promise of Piper audio for the tutor's fixed phrases, made once at startup

/** Starts making a line's audio now; resolves when it's ready (never rejects). */
function prepareSpeech(text) {
  if (fixedSpeech.has(text)) return fixedSpeech.get(text).catch(() => {});
  if (!speechAhead.has(text)) {
    const audio = piper.synth(text);
    audio.catch(() => {}); // a line made ahead and never used shouldn't crash anything
    speechAhead.set(text, audio);
  }
  return speechAhead.get(text).catch(() => {});
}

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

  // Esc while the overlay is focused closes it (a global Esc would steal it from every app).
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') dismiss('Esc');
  });

  tutor = createTutor({
    run: (js) => win.webContents.executeJavaScript(js),
    mic: (cmd) => win.webContents.send('listen', cmd),
    getScreenshot: () => screenshot,
    prepareSpeech,
  });
}

/** Close the overlay and stop everything: reloading the page cuts the voice, the drawing and the mic. */
function dismiss(why) {
  closes++;
  speechAhead.clear();
  win.hide();
  win.webContents.reload();
  tutor.reset();
  console.log(`[overlay] closed (${why})`);
}

/** Resolves once the board page is loaded (it reloads after every Esc). */
function pageReady() {
  return win.webContents.isLoading() ? new Promise((r) => win.webContents.once('did-finish-load', r)) : Promise.resolve();
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
  let img = sources[0].thumbnail;
  if (img.getSize().width > SHOT_MAX_WIDTH) img = img.resize({ width: SHOT_MAX_WIDTH, quality: 'good' });
  const jpg = img.toJPEG(80);
  fs.promises
    .mkdir(OUT_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(path.join(OUT_DIR, 'last-screenshot.jpg'), jpg))
    .catch((e) => console.warn('[shot] could not save:', e.message));
  const { width, height } = img.getSize();
  console.log(`[shot] ${width}x${height}, ${Math.round(jpg.length / 1024)} KB in ${Date.now() - t0}ms`);
  return `data:image/jpeg;base64,${jpg.toString('base64')}`;
}

async function onHotkey() {
  if (opening) return console.log('[hotkey] ignored (still opening)');
  if (win.isVisible()) {
    console.log(`[hotkey] pressed while ${tutor.state}`);
    if (!playFile) tutor.hotkey(false);
    return;
  }
  console.log('[hotkey] pressed');
  opening = true;
  const closesBefore = closes;
  try {
    screenshot = await captureScreen(); // capture first, then show
    win.show();
    await pageReady();
    if (closes !== closesBefore) return console.log('[hotkey] open cancelled (closed meanwhile)');
    win.webContents.send('hotkey', { visible: false });
    if (playFile) {
      const { script, fixes } = tidyScript(JSON.parse(fs.readFileSync(playFile, 'utf8')));
      console.log(`[play] ${path.basename(playFile)}: ${script.steps.length} steps, ${fixes.length} layout fixes`);
      await win.webContents.executeJavaScript('window.board.clearBoard()');
      tutor.playScript(script);
    } else {
      await tutor.hotkey(true);
    }
  } catch (e) {
    console.warn('[hotkey] failed to open:', e.message);
  } finally {
    opening = false;
  }
}

ipcMain.handle('capture-screen', captureScreen);
ipcMain.on('mic', (_event, status) => console.log(`[mic] ${status}`));
ipcMain.on('heard-nothing', (_event, why) => tutor.heardNothing(why === 'deaf' ? 'deaf' : 'nothing'));
ipcMain.handle('transcribe', async (_event, audio) => {
  const id = tutor.listenId; // if the overlay is closed or re-asked meanwhile, this transcript is stale
  let text;
  try {
    const r = await transcribe(Buffer.from(audio), 'audio/webm');
    text = r.text;
    console.log(`[heard] "${text}" (${r.ms}ms)`);
  } catch (e) {
    console.warn('[heard] failed:', e.message);
    tutor.heardNothing('deaf', id);
    return '';
  }
  tutor.heard(text, id); // runs the whole answer; the page doesn't wait for it
  return text;
});
ipcMain.handle('tts', async (_event, text) => {
  const ahead = fixedSpeech.get(text) || speechAhead.get(text);
  speechAhead.delete(text);
  const { wav, durationMs, synthMs } = await (ahead || piper.synth(text));
  const how = ahead ? 'made ahead' : `made in ${synthMs}ms`;
  console.log(`[voice] ${(durationMs / 1000).toFixed(1)}s of speech ${how}: "${text.slice(0, 50)}"`);
  return { wav, durationMs };
});
ipcMain.on('hide-overlay', () => win && dismiss('page asked'));

app.whenReady().then(() => {
  piper
    .start() // load the voice now, not on the first line
    .then(() =>
      PHRASES.forEach((text) => {
        const audio = piper.synth(text);
        audio.catch(() => {}); // if Piper dies, speak() falls back to waiting; don't crash main
        fixedSpeech.set(text, audio);
      })
    )
    .catch((e) => console.warn('[piper] not available:', e.message));
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
