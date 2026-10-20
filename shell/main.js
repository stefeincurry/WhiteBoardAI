// Minimal Electron overlay starter (Kabir's side). UNTESTED: expect to fix things.
//
// What it does:
//  - Global hotkey Ctrl/Cmd+Shift+Space
//  - Takes a screenshot BEFORE showing the overlay (so it doesn't capture itself)
//  - Shows a frameless, always-on-top window docked to the right 40% of the screen
//  - Loads Aarav's board page and sends it the screenshot over IPC
//
// TODO (see CLAUDE.md): mic + Whisper, callModel, speak(), wiring to board.playScript().

const { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

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
}

async function captureScreen() {
  const { size } = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: size.width, height: size.height },
  });
  if (!sources.length) return null;
  return sources[0].thumbnail.toDataURL(); // data:image/png;base64,...
}

async function onHotkey() {
  // Hotkey while visible = "interrupt / ask a follow-up" (TODO: start mic). For now it toggles.
  if (win.isVisible()) {
    win.webContents.send('hotkey', { visible: true });
    return;
  }
  const screenshot = await captureScreen(); // capture first, then show
  win.show();
  win.webContents.send('hotkey', { visible: false, screenshot });
}

ipcMain.handle('capture-screen', captureScreen);
ipcMain.on('hide-overlay', () => win && win.hide());

app.whenReady().then(() => {
  createWindow();
  const ok = globalShortcut.register('CommandOrControl+Shift+Space', onHotkey);
  if (!ok) console.warn('Could not register hotkey (is another app using it?)');
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
