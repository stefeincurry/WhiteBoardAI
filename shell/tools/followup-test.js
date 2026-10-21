// Follow-up test with the real AI and Aarav's real board (hidden window, no voice, no mic):
// asks a question, draws the answer, then asks a follow-up WITH the board state and the conversation,
// and draws that on top. Saves a PNG after each, so you can see whether it builds on the drawing.
//
//   npx electron tools/followup-test.js
//   npx electron tools/followup-test.js "why is the hypotenuse the longest side" "wait, why is it squared?"
//   ... --wait   pause 60s between the questions (Groq's qwen allows ~1 answer a minute)

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { callModel } = require('../llm/callModel');
const { describeHistory } = require('../tutor');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [q1 = "I don't get why the hypotenuse is the longest side", q2 = 'wait, why do we square the sides?'] = args.slice(-2).length === 2 ? args.slice(-2) : [];
const OUT = path.join(__dirname, 'out');

async function draw(win, script) {
  const fast = { ...script, steps: script.steps.map((s) => ({ ...s, say: '.' })) }; // draw at full speed
  for (const step of fast.steps) await win.webContents.executeJavaScript(`window.board.playStep(${JSON.stringify(step)}, () => Promise.resolve())`);
  await new Promise((r) => setTimeout(r, 400));
}

async function snapshot(win, file) {
  const rect = await win.webContents.executeJavaScript(
    `(() => { const r = document.querySelector('#board').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`
  );
  fs.writeFileSync(file, (await win.webContents.capturePage(rect)).toPNG());
  console.log(`  saved ${path.relative(process.cwd(), file)}`);
}

function report(label, r) {
  console.log(`\n${label}: ${r.model} in ${r.ms}ms, ${r.script ? r.script.steps.length + ' steps' : 'NO VALID SCRIPT'}, ${r.fixes.length} layout fixes`);
  for (const f of r.failures) console.log(`  skipped ${f.slice(0, 120)}`);
  if (r.script) for (const s of r.script.steps) console.log(`  - ${s.say}  [${s.actions.map((a) => a.type + (a.target ? '>' + a.target : a.id ? ':' + a.id : '')).join(', ')}]`);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const win = new BrowserWindow({ show: false, width: 900, height: 760 });
    win.webContents.on('console-message', (_e, level, msg) => level >= 2 && !msg.includes('Security Warning') && console.log(`  [board] ${msg.slice(0, 160)}`));
    await win.loadFile(path.join(__dirname, '..', '..', 'board', 'index.html'));
    await win.webContents.executeJavaScript('window.board.clearBoard()');

    console.log(`Q1: "${q1}"`);
    const r1 = await callModel({ question: q1 });
    report('Answer 1', r1);
    if (!r1.script) throw new Error('first answer had no valid script');
    await draw(win, r1.script);
    await snapshot(win, path.join(OUT, 'followup-1.png'));

    if (process.argv.includes('--wait')) {
      console.log('\n(waiting 60s for the rate limit)');
      await new Promise((r) => setTimeout(r, 60000));
    }
    const boardState = await win.webContents.executeJavaScript('window.board.getBoardState()');
    const history = describeHistory([{ question: q1, said: r1.script.steps.map((s) => s.say), cut: false }]);
    console.log(`\nQ2 (follow-up, ${boardState.length} things on the board): "${q2}"`);
    const r2 = await callModel({ question: q2, boardState, history });
    report('Answer 2', r2);
    if (r2.script) {
      const ids = new Set(boardState.map((b) => b.id).filter(Boolean));
      const reused = r2.script.steps.flatMap((s) => s.actions).filter((a) => ids.has(a.target)).length;
      const redrawn = r2.script.steps.flatMap((s) => s.actions).filter((a) => a.type === 'draw_shape' && ids.has(a.id)).length;
      console.log(`  builds on the board: ${reused} action(s) target existing shapes, ${redrawn} redraw an existing id`);
      await draw(win, r2.script);
      await snapshot(win, path.join(OUT, 'followup-2.png'));
    }
  } catch (e) {
    console.error('FAILED:', e.message);
  }
  app.exit(0);
});
