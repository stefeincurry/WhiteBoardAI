// Electron overlay (Kabir's side): window, hotkey, screenshot, and the wiring between the pieces.
//
//  - Global hotkey Ctrl/Cmd+Shift+Space. First press: screenshot (BEFORE the overlay shows, so it
//    doesn't capture itself), a board-shaped overlay docks top-right (40% wide, resizable), mic starts (beep).
//  - Our bar on top (preload.js): Pause/Resume, Stop, Type (type instead of talking).
//  - You stop talking (~1.2s quiet, lower beep) -> Whisper (stt/transcribe.js) -> callModel()
//    (llm/callModel.js, with the screenshot) -> tidyScript() -> Aarav's board + Piper voice.
//    What the hotkey means after that (stop mic / interrupt / follow-up) lives in tutor.js.
//  - Esc (overlay focused) closes it and stops everything.
//  - Voice: Piper (tts/piper.js), given to the page as window.shell.speak(text).
//  - Saves the screenshot the AI sees to tools/out/last-screenshot.jpg.
//
// Testing: `npm start -- --fire-hotkey` fakes one hotkey press;
//          `npm start -- --play tools/out/some-script.json` plays a saved script instead of asking.

const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain, Tray, Menu, nativeImage, Notification } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const piper = require('./tts/piper');
const edge = require('./tts/edge');
const { tidyScript } = require('./llm/tidy');
const { transcribe } = require('./stt/transcribe');
const { createTutor, PHRASES } = require('./tutor');
const { warmUp } = require('./llm/callModel');

const OUT_DIR = path.join(__dirname, 'tools', 'out');
const HISTORY_MAX = 50;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { level: 'student', language: 'english', speed: 'normal', bigText: false, easyFont: false };
const SPEEDS = { slow: 1.25, normal: undefined, fast: 0.85 }; // Piper length_scale (> 1 = slower)
// Language picker: Piper voice + Whisper language for each (Hinglish uses the English voice, Roman letters).
const LANGUAGES = {
  english: { voice: 'en_US-lessac-medium', stt: 'en' },
  // neural: a Microsoft voice (tts/edge.js, needs internet), much more natural; Piper is the backup
  hinglish: { voice: 'en_US-lessac-medium', neural: 'en-IN-NeerjaNeural', stt: 'en' },
  hindi: { voice: 'hi_IN-pratham-medium', neural: 'hi-IN-SwaraNeural', stt: 'hi' },
  spanish: { voice: 'es_ES-davefx-medium', stt: 'es' },
  german: { voice: 'de_DE-thorsten-medium', stt: 'de' },
  french: { voice: 'fr_FR-siwis-medium', stt: 'fr' },
  italian: { voice: 'it_IT-paola-medium', stt: 'it' },
};
const lang = () => LANGUAGES[settings.language] || LANGUAGES.english;
function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {}
}
function saveSettings() {
  fs.promises.writeFile(settingsFile(), JSON.stringify(settings)).catch(() => {});
}
const historyFile = () => path.join(app.getPath('userData'), 'board-history.json'); // ~/.config/<app>/ on Linux

/** Saved boards, newest last. Kept on disk so they survive Stop, Esc and restarts. */
function loadHistory() {
  try {
    const list = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function saveHistory(list) {
  fs.promises
    .mkdir(path.dirname(historyFile()), { recursive: true })
    .then(() => fs.promises.writeFile(historyFile(), JSON.stringify(list.slice(-HISTORY_MAX))))
    .catch((e) => console.warn('[history] could not save:', e.message));
}
const SHOT_MAX_WIDTH = 1280; // smaller image = faster upload and fewer image tokens for the AI

const playArg = process.argv.indexOf('--play');
const playFile = playArg === -1 ? null : path.resolve(process.argv[playArg + 1]);

let win = null;
let screenshot = null; // taken when the overlay opens, sent with the question
let fullShot = null; // the same screenshot at full size, for snipping a region out of it
let tutor = null;
let tray = null; // kept in a variable so it isn't garbage-collected (the icon would vanish)
let opening = false; // the overlay is on its way up (screenshot, page load): ignore more presses until it's open
let typingOpen = false; // the type box has focus: Esc closes the box, not the overlay
let closes = 0; // counts dismiss() calls, so an open that was Esc'd halfway doesn't carry on
const speechAhead = new Map(); // text -> Promise of Piper audio, made early (the next step's line while this one plays)
const fixedSpeech = new Map(); // same keys -> audio for the tutor's fixed phrases, made once per voice and speed

const speechKey = (text) => `${lang().neural || lang().voice}|${settings.speed}|${text}`;

/** A line's audio in the current language's voice: the Microsoft voice if it has one, else (or if that fails) Piper. */
function makeAudio(text, timeoutMs) {
  const { voice, neural } = lang();
  const speed = SPEEDS[settings.speed];
  if (!neural) return piper.synth(text, voice, speed);
  return edge.synth(text, neural, speed, timeoutMs).catch((e) => {
    console.warn(`[voice] ${neural} failed (${e.message}): Piper says this line`);
    return piper.synth(text, voice, speed);
  });
}

/** Starts making a line's audio now; resolves when it's ready (never rejects). */
function prepareSpeech(text) {
  const key = speechKey(text);
  if (fixedSpeech.has(key)) return fixedSpeech.get(key).catch(() => {});
  if (!speechAhead.has(key)) {
    const audio = makeAudio(text);
    audio.catch(() => {}); // a line made ahead and never used shouldn't crash anything
    speechAhead.set(key, audio);
  }
  return speechAhead.get(key).catch(() => {});
}

/** Makes the fixed phrases ("Hmm, let me think.") in the current voice and speed, once. */
function prepareFixedPhrases() {
  for (const text of PHRASES) {
    const key = speechKey(text);
    if (fixedSpeech.has(key)) continue;
    const audio = makeAudio(text, 30000); // not urgent, and the first lines to Microsoft are slow
    audio.catch(() => fixedSpeech.delete(key)); // failed: made on demand next time
    fixedSpeech.set(key, audio);
  }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.round(workArea.width * 0.4);
  // Board-shaped (it's 800x500) plus our bar and the subtitle line, docked top-right: no dead space,
  // and it covers less of the video. Resizable from the edges.
  const height = Math.min(workArea.height, Math.round((width * 500) / 800) + 90);

  win = new BrowserWindow({
    x: workArea.x + workArea.width - width,
    y: workArea.y,
    width,
    height,
    frame: false, // our own bar (preload.js) is the title bar: drag it to move, drag the edges to resize
    resizable: true,
    minWidth: 360,
    minHeight: 300,
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
    if (input.type === 'keyDown' && input.key === 'Escape' && !typingOpen) dismiss('Esc');
  });

  tutor = createTutor({
    run: (js) => win.webContents.executeJavaScript(js),
    mic: (cmd) => win.webContents.send('listen', cmd),
    getScreenshot: () => screenshot,
    prepareSpeech,
    getLevel: () => settings.level,
    getLanguage: () => settings.language,
    onAnswer: (entry) => {
      const list = loadHistory();
      list.push({ ...entry, timestamp: Date.now() });
      saveHistory(list);
      console.log(`[history] saved "${entry.topic}" (${Math.min(list.length, HISTORY_MAX)} boards)`);
    },
  });
}

/** Close the overlay and stop everything: reloading the page cuts the voice, the drawing and the mic. */
function dismiss(why) {
  closes++;
  typingOpen = false;
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
  fullShot = img;
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
    const r = await transcribe(Buffer.from(audio), 'audio/webm', lang().stt);
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
  const key = speechKey(text);
  const ahead = fixedSpeech.get(key) || speechAhead.get(key);
  speechAhead.delete(key);
  const { wav, durationMs, synthMs } = await (ahead || makeAudio(text));
  const how = ahead ? 'made ahead' : `made in ${synthMs}ms`;
  console.log(`[voice] ${(durationMs / 1000).toFixed(1)}s of speech ${how}: "${text.slice(0, 50)}"`);
  return { wav, durationMs };
});
ipcMain.on('hide-overlay', () => win && dismiss('Stop button'));
ipcMain.on('control', (_event, cmd) => tutor.pause(cmd === 'pause'));
ipcMain.handle('history-list', () =>
  loadHistory()
    .map((h, i) => ({ i, topic: h.topic, question: h.question, timestamp: h.timestamp }))
    .reverse()
);
ipcMain.handle('history-open', (_event, i) => {
  const entry = loadHistory()[i];
  if (entry) tutor.restore(entry);
});
ipcMain.handle('history-clear', () => saveHistory([]));
ipcMain.on('typed', (_event, text) => tutor.typed(String(text).slice(0, 500)));
ipcMain.on('again', () => tutor.again());
ipcMain.on('test-me', () => tutor.testMe());
// ---- Snip: drag a box around just the part of the screen you mean ----
let snipWin = null;
ipcMain.on('snip', () => {
  if (!fullShot || snipWin) return;
  const { bounds } = screen.getPrimaryDisplay();
  win.hide();
  snipWin = new BrowserWindow({ ...bounds, frame: false, alwaysOnTop: true, skipTaskbar: true, show: false, fullscreen: true });
  const shot = `data:image/jpeg;base64,${fullShot.toJPEG(90).toString('base64')}`;
  // The page reports the box through its title (no preload needed): {"x":..,"y":..,"w":..,"h":..,"vw":..,"vh":..} or "cancel".
  const html = `<html><body style="margin:0;overflow:hidden;cursor:crosshair;user-select:none">
    <img src="${shot}" style="position:fixed;inset:0;width:100vw;height:100vh;opacity:0.85" draggable="false">
    <div id="hint" style="position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#1a3d7c;color:#fff;font:16px sans-serif;padding:8px 14px;border-radius:8px">Drag a box around the part you mean · Esc to cancel</div>
    <div id="box" style="position:fixed;border:3px solid #d0312d;background:rgba(208,49,45,0.12);display:none"></div>
    <script>
      let start = null; const box = document.getElementById('box');
      addEventListener('mousedown', (e) => { start = [e.clientX, e.clientY]; box.style.display = 'block'; });
      addEventListener('mousemove', (e) => { if (!start) return;
        const [x, y] = start; Object.assign(box.style, { left: Math.min(x, e.clientX) + 'px', top: Math.min(y, e.clientY) + 'px',
          width: Math.abs(e.clientX - x) + 'px', height: Math.abs(e.clientY - y) + 'px' }); });
      addEventListener('mouseup', (e) => { if (!start) return; const [x, y] = start; start = null;
        const r = { x: Math.min(x, e.clientX), y: Math.min(y, e.clientY), w: Math.abs(e.clientX - x), h: Math.abs(e.clientY - y), vw: innerWidth, vh: innerHeight };
        document.title = r.w > 10 && r.h > 10 ? JSON.stringify(r) : 'cancel'; });
      addEventListener('keydown', (e) => { if (e.key === 'Escape') document.title = 'cancel'; });
    </script></body></html>`;
  snipWin.webContents.on('page-title-updated', (_e, title) => {
    if (title !== 'cancel' && !title.startsWith('{')) return; // Electron's own title updates while loading
    let r = null;
    try {
      r = JSON.parse(title);
    } catch {}
    snipWin.close();
    snipWin = null;
    win.show();
    if (!r) return console.log('[snip] cancelled');
    const { width, height } = fullShot.getSize();
    const sx = width / r.vw, sy = height / r.vh;
    let crop = fullShot.crop({ x: Math.round(r.x * sx), y: Math.round(r.y * sy), width: Math.round(r.w * sx), height: Math.round(r.h * sy) });
    if (crop.getSize().width > SHOT_MAX_WIDTH) crop = crop.resize({ width: SHOT_MAX_WIDTH, quality: 'good' });
    screenshot = `data:image/jpeg;base64,${crop.toJPEG(85).toString('base64')}`;
    console.log(`[snip] using a ${crop.getSize().width}x${crop.getSize().height} part of the screen`);
    tutor.focusScreen(); // the next question is about this region: only models that can see it
    if (tutor.state !== 'listening') tutor.hotkey(false); // ask about it
  });
  snipWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  snipWin.once('ready-to-show', () => snipWin && (snipWin.show(), snipWin.focus()));
});

ipcMain.handle('drawn', async (_event, text) => {
  // The board with the student's sketch on top, as the picture the AI looks at (only qwen can see images).
  const rect = await win.webContents.executeJavaScript(
    `(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`
  );
  const jpg = (await win.webContents.capturePage(rect)).toJPEG(85);
  const question = String(text || '').trim().slice(0, 500) || 'Look at what I drew on the board. Explain it, or check it and tell me if it is right.';
  tutor.typed(`${question}\n\n(The image is the board with the student's own drawing on top, in red.)`, `data:image/jpeg;base64,${jpg.toString('base64')}`);
});
ipcMain.handle('save-notes', async () => {
  // The board as it looks now -> Documents/WhiteBoardAI Notes/<topic> <date>.png and .pdf
  const rect = await win.webContents.executeJavaScript(
    `(() => { const r = document.querySelector('#board').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`
  );
  const png = (await win.webContents.capturePage(rect)).toPNG();
  const dir = path.join(app.getPath('documents'), 'WhiteBoardAI Notes');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  const name = `${String(tutor.topic).replace(/[^\w\s-]/g, '').trim().slice(0, 50) || 'whiteboard'} ${stamp}`;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${name}.png`), png);
  // PDF: the same picture on a landscape A4 page, with the topic as a heading.
  const page = new BrowserWindow({ show: false });
  const title = String(tutor.topic).replace(/[<&]/g, '');
  await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
    `<html><body style="margin:24px;font-family:sans-serif"><h2 style="color:#1a3d7c">${title}</h2>` +
      `<img style="width:100%" src="data:image/png;base64,${png.toString('base64')}"></body></html>`
  )}`);
  await fs.promises.writeFile(path.join(dir, `${name}.pdf`), await page.webContents.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true }));
  page.destroy();
  console.log(`[notes] saved "${name}" (png + pdf) in ${dir}`);
  return `Saved to Documents/WhiteBoardAI Notes: ${name}`;
});
ipcMain.handle('settings-get', () => settings);
ipcMain.on('settings-set', (_event, change) => {
  if (change && ['kid', 'student', 'expert'].includes(change.level)) settings.level = change.level;
  if (change && Object.hasOwn(SPEEDS, change.speed)) settings.speed = change.speed;
  if (change && typeof change.bigText === 'boolean') settings.bigText = change.bigText;
  if (change && typeof change.easyFont === 'boolean') settings.easyFont = change.easyFont;
  if (change && LANGUAGES[change.language]) {
    settings.language = change.language;
    piper.start(lang().voice).catch((e) => console.warn('[piper]', e.message)); // load that voice now, not on the first line
  }
  prepareFixedPhrases(); // in the new voice or speed
  saveSettings();
  console.log(`[settings] ${JSON.stringify(settings)}`);
});
ipcMain.on('typing', (_event, open) => {
  typingOpen = !!open;
  if (open) tutor.cancelListening();
});

// ---- Revision reminders: spaced repetition over saved boards (1, 3, 7, 21 days) ----
const DAY = 24 * 60 * 60 * 1000;
const INTERVALS = [1, 3, 7, 21].map((d) => d * DAY);

/** Topics due for revision: the latest board of each topic, whose next review time has passed. */
function dueForRevision(now = Date.now()) {
  const latest = new Map();
  loadHistory().forEach((h, i) => latest.set(String(h.topic || h.question).toLowerCase(), { ...h, i }));
  return [...latest.values()]
    .filter((h) => {
      const reviews = h.reviews || [];
      if (reviews.length >= INTERVALS.length) return false;
      return now - (reviews[reviews.length - 1] || h.timestamp) >= INTERVALS[reviews.length];
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Opens a saved board and quizzes the student on it ("Test me"), and records the review. */
async function revise(entry) {
  if (!win.isVisible()) {
    win.show();
    await pageReady();
  }
  const list = loadHistory();
  if (list[entry.i]) {
    list[entry.i].reviews = [...(list[entry.i].reviews || []), Date.now()];
    saveHistory(list);
  }
  await tutor.restore(list[entry.i] || entry);
  tutor.testMe();
  console.log(`[revise] quiz on "${entry.topic}"`);
}

function remindToRevise() {
  const due = dueForRevision();
  if (tray) tray.setContextMenu(trayMenu());
  if (!due.length || !Notification.isSupported()) return;
  const first = due[0];
  const days = Math.max(1, Math.round((Date.now() - first.timestamp) / DAY));
  const more = due.length > 1 ? ` (+${due.length - 1} more in the tray menu)` : '';
  const note = new Notification({
    title: 'Time to revise',
    body: `${first.topic}, learned ${days} day${days > 1 ? 's' : ''} ago. Click for a quick quiz.${more}`,
  });
  note.on('click', () => revise(first));
  note.show();
  console.log(`[revise] reminder: "${first.topic}" (${due.length} due)`);
}

// ---- Tray icon: the app lives in the background; this is how you find it ----
const AUTOSTART_FILE = path.join(os.homedir(), '.config', 'autostart', 'whiteboard-tutor.desktop');
function startsWithComputer() {
  if (process.platform === 'linux') return fs.existsSync(AUTOSTART_FILE);
  return app.getLoginItemSettings().openAtLogin;
}
function setStartWithComputer(on) {
  if (process.platform === 'linux') {
    // Electron's login-item API doesn't cover Linux: use the standard XDG autostart entry.
    if (!on) return fs.rmSync(AUTOSTART_FILE, { force: true });
    fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
    const run = `"${process.execPath}" "${__dirname}"`;
    fs.writeFileSync(AUTOSTART_FILE, `[Desktop Entry]\nType=Application\nName=Whiteboard Tutor\nExec=${run}\nX-GNOME-Autostart-enabled=true\n`);
  } else {
    app.setLoginItemSettings({ openAtLogin: on });
  }
}
function trayMenu() {
  const due = dueForRevision();
  return Menu.buildFromTemplate([
      { label: 'Open whiteboard (Ctrl/Cmd+Shift+Space)', click: () => onHotkey() },
      {
        label: due.length ? `Revise (${due.length} due)` : 'Revise (nothing due)',
        enabled: due.length > 0,
        submenu: due.length ? due.slice(0, 10).map((h) => ({ label: String(h.topic).slice(0, 60), click: () => revise(h) })) : undefined,
      },
      {
        label: 'Saved boards',
        click: async () => {
          if (!win.isVisible()) {
            win.show();
            await pageReady();
          }
          win.webContents.send('open-history');
        },
      },
      { type: 'separator' },
      {
        label: 'Start with my computer',
        type: 'checkbox',
        checked: startsWithComputer(),
        click: (item) => {
          setStartWithComputer(item.checked);
          tray.setContextMenu(trayMenu());
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip('Whiteboard Tutor (Ctrl/Cmd+Shift+Space)');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => onHotkey());
}

app.whenReady().then(() => {
  loadSettings();
  buildTray();
  setTimeout(remindToRevise, 15000); // once the app has settled, then every 3 hours
  setInterval(remindToRevise, 3 * 60 * 60 * 1000);
  warmUp(); // the local model (OLLAMA_MODEL), if any
  piper
    .start() // load the voice now, not on the first line
    .then(prepareFixedPhrases)
    .catch((e) => console.warn('[piper] not available:', e.message));
  createWindow();
  const ok = globalShortcut.register('CommandOrControl+Shift+Space', onHotkey);
  console.log(ok ? '[hotkey] Ctrl/Cmd+Shift+Space registered' : '[hotkey] could NOT register (another app using it?)');
  if (process.argv.includes('--fire-hotkey')) win.webContents.once('did-finish-load', () => setTimeout(onHotkey, 500));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  piper.stop();
  edge.stop();
});
app.on('window-all-closed', () => app.quit());
