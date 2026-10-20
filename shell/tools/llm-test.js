// Risk test: can Gemini Flash return a valid tutor script, and how fast?
//
//   node tools/llm-test.js                         # asks "I don't get Pythagoras", text only
//   node tools/llm-test.js --image shot.png        # also sends a screenshot
//   node tools/llm-test.js -q "why is the sky blue"
//   node tools/llm-test.js --think low             # less thinking = faster (overrides GEMINI_THINKING)
//   node tools/llm-test.js --models                # list models your key can use
//
// Writes the script to tools/out/last-script.json so you can paste it into board/index.html.

const fs = require('fs');
const path = require('path');
const { callModel, listGeminiModels } = require('../llm/callModel');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

// Per-action required fields from shared/contract.d.ts (the JSON schema doesn't enforce these).
const REQUIRED = {
  draw_line: ['from', 'to'],
  draw_shape: ['id', 'shape', 'points'],
  write_text: ['text'],
  write_formula: ['latex'],
  label: ['target', 'text', 'at'],
  highlight: ['target'],
  arrow: ['from', 'to'],
  erase: [],
  draw_svg: ['svg'],
};

function contractWarnings(script) {
  const warnings = [];
  const ids = new Set();
  const offBoard = (p) => Array.isArray(p) && (p[0] < 0 || p[0] > 800 || p[1] < 0 || p[1] > 500);
  script.steps.forEach((step, s) => {
    if (/[\\^$]/.test(step.say)) warnings.push(`step ${s + 1}: "say" has LaTeX/symbols`);
    step.actions.forEach((a, i) => {
      const where = `step ${s + 1} action ${i + 1} (${a.type})`;
      for (const f of REQUIRED[a.type] || []) if (a[f] === undefined) warnings.push(`${where}: missing "${f}"`);
      if (a.target && !ids.has(a.target)) warnings.push(`${where}: target "${a.target}" not drawn yet`);
      const pts = [a.from, a.to, a.at, ...(a.points || [])];
      if (pts.some(offBoard)) warnings.push(`${where}: point outside 800x500 board`);
      if (a.id) ids.add(a.id);
    });
  });
  return warnings;
}

async function printModels() {
  const models = await listGeminiModels();
  const flash = models.filter((m) => m.includes('flash'));
  console.log('Flash models your key can use:\n  ' + (flash.length ? flash : models).join('\n  '));
}

async function main() {
  if (args.includes('--models')) return printModels();

  const question = flag('-q') || "I don't get Pythagoras";
  const imagePath = flag('--image');
  const screenshot = imagePath ? fs.readFileSync(imagePath) : undefined;

  console.log(`Asking: "${question}"${imagePath ? ` + screenshot ${imagePath}` : ' (text only)'}`);
  let r;
  try {
    r = await callModel({ question, screenshot }, { thinking: flag('--think') });
  } catch (e) {
    console.error('\nFAILED:', e.message);
    if (e.status === 404) {
      console.error('\nModel name is wrong. Pick one of these for GEMINI_MODEL in .env:');
      await printModels().catch((err) => console.error(err.message));
    }
    if (e.status === 429) {
      console.error('\nRate limited. If the message says "limit: 0", this model is not on your free tier:');
      console.error('run `node tools/llm-test.js --models` and try a different flash model in GEMINI_MODEL.');
    }
    process.exit(1);
  }

  console.log(`\nModel:    ${r.model}${r.thinking ? ` (thinking: ${r.thinking})` : ''}`);
  console.log(`Latency:  ${(r.ms / 1000).toFixed(1)}s (${r.attempts} attempt${r.attempts > 1 ? 's' : ''})`);
  if (r.usage) {
    const u = r.usage;
    console.log(`Tokens:   in ${u.promptTokenCount}, out ${u.candidatesTokenCount}, thinking ${u.thoughtsTokenCount || 0}`);
  }
  console.log(`Schema:   ${r.script ? 'VALID' : 'INVALID'}`);

  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  if (!r.script) {
    console.log('Problems:\n  ' + r.errors.join('\n  '));
    fs.writeFileSync(path.join(outDir, 'last-raw.txt'), r.raw);
    console.log('\nRaw output saved to tools/out/last-raw.txt');
    process.exit(1);
  }

  const warnings = contractWarnings(r.script);
  console.log(`Contract: ${warnings.length ? warnings.length + ' warning(s)' : 'OK'}`);
  warnings.forEach((w) => console.log('  - ' + w));

  console.log(`\nTopic: ${r.script.topic}  |  ${r.script.steps.length} steps`);
  r.script.steps.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.say}  [${s.actions.map((a) => a.type).join(', ') || 'no drawing'}]`);
  });

  fs.writeFileSync(path.join(outDir, 'last-script.json'), JSON.stringify(r.script, null, 2));
  console.log('\nScript saved to tools/out/last-script.json (paste into board/index.html to watch it)');
}

main();
