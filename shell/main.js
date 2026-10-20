// Minimal Electron overlay starter (Kabir's side). UNTESTED: expect to fix things.
//
// What it does:
//  - Global hotkey Ctrl/Cmd+Shift+Space
//  - Takes a screenshot BEFORE showing the overlay (so it doesn't capture itself)
//  - Shows a frameless, always-on-top window docked to the right 40% of the screen
//  - Loads Aarav's board page and sends it the screenshot over IPC
//
//  - Esc hides it again. `npm start -- --fire-hotkey` fakes one hotkey press (testing).
//  - Saves the last screenshot to tools/out/last-screenshot.png (check it doesn't show the overlay)
//
// TODO (see CLAUDE.md): mic + Whisper, callModel, speak(), wiring to board.playScript().

const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

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
      console.log('[overlay] hidden (Esc)');
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
  // Hotkey while visible = "interrupt / ask a follow-up" (TODO: start mic). For now it toggles.
  if (win.isVisible()) {
    console.log('[hotkey] pressed while open (follow-up: not wired yet, Esc to hide)');
    win.webContents.send('hotkey', { visible: true });
    return;
  }
  console.log('[hotkey] pressed');
  const screenshot = await captureScreen(); // capture first, then show
  win.show();
  console.log('[overlay] shown at', JSON.stringify(win.getBounds()));
  win.webContents.send('hotkey', { visible: false, screenshot });
}

ipcMain.handle('capture-screen', captureScreen);
ipcMain.on('hide-overlay', () => win && win.hide());

app.whenReady().then(() => {
  createWindow();
  const ok = globalShortcut.register('CommandOrControl+Shift+Space', onHotkey);
  console.log(ok ? '[hotkey] Ctrl/Cmd+Shift+Space registered' : '[hotkey] could NOT register (another app using it?)');
  if (process.argv.includes('--fire-hotkey')) win.webContents.once('did-finish-load', () => setTimeout(onHotkey, 500));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
