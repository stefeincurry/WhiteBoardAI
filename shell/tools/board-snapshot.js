// Draws a script on Aarav's real board page (hidden window, no voice) and saves a PNG of the result.
// For checking what the AI's layouts actually look like without sitting through playback.
//
//   npx electron tools/board-snapshot.js tools/out/last-script.json            # -> tools/out/board-snapshot.png
//   npx electron tools/board-snapshot.js script.json out.png --raw             # --raw: skip tidyScript()

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { tidyScript } = require('../llm/tidy');

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const scriptPath = files.find((f) => f.endsWith('.json'));
const outPath = files.find((f) => f.endsWith('.png')) || path.join(__dirname, 'out', 'board-snapshot.png');

app.whenReady().then(async () => {
  try {
    let script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    if (!process.argv.includes('--raw')) script = tidyScript(script).script;
    // Drawing time follows the length of "say": a one-word line makes the board draw at its fastest.
    script.steps.forEach((s) => (s.say = '.'));

    const win = new BrowserWindow({ show: false, width: 900, height: 760 });
    // The board warns (instead of crashing) when it skips something: show those.
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[board ${level === 2 ? 'warn' : 'error'}] ${message.slice(0, 200)}`);
    });
    await win.loadFile(path.join(__dirname, '..', '..', 'board', 'index.html'));
    await win.webContents.executeJavaScript(
      `window.board.clearBoard(); window.board.playScript(${JSON.stringify(script)}, () => Promise.resolve())`
    );
    await new Promise((r) => setTimeout(r, 500)); // let the last fade-in settle
    const onBoard = await win.webContents.executeJavaScript(
      `window.board.getBoardState().map((s) => s.type + (s.id ? ':' + s.id : '')).join(', ')`
    );
    console.log(`on the board at the end: ${onBoard || '(nothing)'}`);
    const rect = await win.webContents.executeJavaScript(
      `(() => { const r = (document.querySelector('#board') || document.querySelector('svg')).getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, (await win.webContents.capturePage(rect)).toPNG());
    console.log(`saved ${outPath}`);
  } catch (e) {
    console.error('FAILED:', e.message);
  }
  app.exit(0);
});
