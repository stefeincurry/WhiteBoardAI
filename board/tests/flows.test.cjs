const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createHelpers = require('../flow-helpers.js');
const setup = require('./test-board.cjs');

const svg = id => `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width:500px" viewBox="-4 -8 500 250"><style>#${id} text{fill:blue}</style><rect width="120" height="40"/><path d="M0 0 L100 100"/></svg>`;
function fixture() {
  const calls = [], configurations = [];
  const helpers = createHelpers({
    initialize: config => configurations.push(config),
    render: async (id, source) => { calls.push({ id, source }); return { svg: svg(id) }; },
  });
  return { helpers, calls, configurations };
}

test('vendored browser bundle loads and exposes the expected Mermaid API offline', () => {
  const context = vm.createContext({ console, setTimeout, clearTimeout, structuredClone, TextEncoder, TextDecoder, URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../vendor/mermaid-12.2.0/mermaid.min.js'), 'utf8'), context);
  assert.equal(typeof context.mermaid.render, 'function');
  assert.equal(typeof context.mermaid.initialize, 'function');
  assert.equal(typeof context.mermaid.parse, 'function');
  // Actual SVG rendering requires browser text metrics; it is not mocked as a
  // successful real Mermaid render in these tests.
});

test('helper configures strict SVG labels and sizes only the root SVG', async () => {
  const { helpers, calls, configurations } = fixture();
  const action = await helpers.flowchart('flowchart LR\n A --> B');
  assert.equal(action.type, 'draw_svg');
  assert(action.svg.includes('x="40" y="80" width="720" height="340"'));
  assert(action.svg.includes('viewBox="-4 -8 500 250"'));
  assert(action.svg.includes('<rect width="120" height="40"/>'));
  assert(action.svg.includes(`#${calls[0].id} text`));
  assert(!action.svg.includes('max-width:500px'));
  assert.equal(configurations[0].securityLevel, 'strict');
  assert.equal(configurations[0].htmlLabels, false);
  assert.equal(configurations[0].startOnLoad, false);
  assert.equal(configurations[0].flowchart.wrappingWidth, 200);
  await helpers.flowchart('graph TD\n A --> C');
  assert.equal(configurations.length, 1);
  assert.notEqual(calls[0].id, calls[1].id);
});

test('invalid or interactive source is rejected before calling the renderer', async () => {
  const { helpers, calls } = fixture();
  for (const source of ['', 'x'.repeat(4001), 'sequenceDiagram\n A->>B: Hi',
    'flowchart LR\n A[<img src=x>]', 'flowchart LR\n click A callback',
    'flowchart LR\n %%{init: {securityLevel: loose}}%%\n A-->B']) {
    await assert.rejects(helpers.flowchart(source));
  }
  assert.equal(calls.length, 0);
  await helpers.flowchart('flowchart LR\n A-->B');
  assert.equal(calls.length, 1);
  assert.throws(() => helpers.fitSvg('<svg><path/></svg>'), /viewBox/);
});

test('render errors recover and concurrent calls are serialised', async () => {
  let active = 0, maxActive = 0, count = 0;
  const helpers = createHelpers({ initialize() {}, render: async id => {
    active++; maxActive = Math.max(maxActive, active);
    await Promise.resolve(); active--;
    if (++count === 1) throw new Error('Bad syntax');
    return { svg: svg(id) };
  } });
  await assert.rejects(helpers.flowchart('flowchart LR\n A-->B'), /Bad syntax/);
  const actions = await Promise.all([helpers.flowchart('flowchart LR\n A-->B'), helpers.flowchart('flowchart LR\n B-->C')]);
  assert.equal(actions.length, 2); assert.equal(maxActive, 1);
});

for (const kind of ['decision', 'water']) {
  test(`${kind} demo produces a serialisable lesson and plays with fake speech`, async () => {
    const { helpers, calls } = fixture();
    const script = await helpers.demo(kind);
    assert.deepEqual(JSON.parse(JSON.stringify(script)), script);
    assert(calls[0].source.includes(kind === 'decision' ? '|Yes|' : 'D --> A'));
    const s = setup(), spoken = [];
    const playing = s.board.playScript(script, async text => { spoken.push(text); });
    await s.advance(100000); await playing;
    assert.equal(s.warnings.length, 0, JSON.stringify(s.warnings));
    assert.equal(spoken.length, 2);
    assert(s.board.getBoardState().some(entry => entry.type === 'draw_svg'));
    assert(s.board.getBoardState().some(entry => entry.text === script.steps[1].say));
    s.board.clearBoard(); assert.equal(s.board.getBoardState().length, 0);
  });
}
