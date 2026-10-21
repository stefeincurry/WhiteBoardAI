const { test } = require('node:test');
const assert = require('node:assert/strict');
const setup = require('./test-board.cjs');

const line = { type: 'draw_line', id: 'kept', from: [80, 130], to: [340, 300] };
async function finish(s, promise) { await s.advance(100000); await promise; }

test('null and unknown actions are skipped before calculating timing; later steps play', async () => {
  const s = setup(), spoken = [];
  await finish(s, s.board.playScript({ steps: [null, 4, {},
    { say: 'First', actions: [null, 4, {}, { type: { toString: null } }, { type: 'constructor' }, { type: 'new_action' }, line] },
    { say: 'Next', actions: [{ type: 'highlight', target: 'kept' }] },
  ] }, async text => spoken.push(text)));
  assert.deepEqual(spoken, ['First', 'Next']);
  assert.equal(s.board.getBoardState().length, 2);
  assert(s.warnings.length >= 8);
  assert(s.animations.every(a => Number.isFinite(a.options.duration)));
});

test('malformed coordinates, shapes and content do not draw or erase good work', async () => {
  const s = setup();
  const bad = [
    { type: 'draw_line', from: [1, 2] }, { type: 'arrow', from: [NaN, 2], to: [3, 4] },
    { type: 'draw_shape', id: 'bad', shape: 'triangle', points: [[1, 2]] },
    { type: 'draw_shape', id: 'bad', shape: 'oops', points: [[1, 2], [3, 4], [5, 6]] },
    { type: 'draw_shape', id: 'bad', shape: { toString: null }, points: [[1, 2], [3, 4], [5, 6]] },
    { type: 'write_text', text: {} }, { type: 'write_formula', latex: null },
    { type: 'write_text', text: 'bad', at: [1, Infinity] },
    { type: 'label', text: 'bad', at: [1, 2] }, { type: 'highlight', target: null },
    { type: 'highlight', target: 'kept', color: 'url(https://example.com)' },
    ...['', null, false, 0].map(target => ({ type: 'erase', target })),
    { type: 'draw_svg', svg: 42 },
  ];
  await finish(s, s.board.playStep({ say: 'Continue', actions: [line, ...bad, { type: 'highlight', target: 'kept' }] }, async () => {}));
  assert.deepEqual(Array.from(s.board.getBoardState(), a => a.type), ['draw_line', 'highlight']);
  assert.equal(s.warnings.length, bad.length);
});

test('malformed scripts return safely, malformed action lists still allow narration', async () => {
  const s = setup(), spoken = [];
  for (const script of [null, [], 4, {}, { steps: {} }]) await s.board.playScript(script, async () => assert.fail());
  await finish(s, s.board.playScript({ steps: [
    { say: 'Speech only', actions: {} },
    { say: 'Then drawing', actions: [line] },
  ] }, async text => spoken.push(text)));
  assert.deepEqual(spoken, ['Speech only', 'Then drawing']);
  assert.equal(s.board.getBoardState().length, 1);
});

test('a rendering failure and missing targets do not stop later actions', async () => {
  const s = setup();
  s.context.Image = class { async decode() { throw new Error('Invalid SVG'); } };
  await finish(s, s.board.playStep({ say: 'Continue', actions: [
    { type: 'draw_svg', svg: '<broken>' },
    { type: 'label', target: 'missing', text: 'Absent', at: [40, 50] },
    { type: 'highlight', target: 'missing' }, line,
  ] }, async () => {}));
  assert.equal(s.board.getBoardState().length, 1);
  assert.equal(s.svg.querySelectorAll('image').length, 0);
  assert.equal(s.warnings.length, 3);
});

test('SVG markup and CSS stay inside an encoded image, never in live board markup', async () => {
  const s = setup();
  const source = '<svg x="40" y="80" width="720" height="340"><style>body{display:none}</style><script>bad()</script><path data-id="kept"/></svg>';
  await finish(s, s.board.playStep({ say: 'Diagram', actions: [{ type: 'draw_svg', svg: source }] }, async () => {}));
  const images = s.svg.querySelectorAll('image');
  assert.equal(images.length, 1);
  assert(images[0].getAttribute('href').startsWith('data:image/svg+xml;charset=utf-8,'));
  assert(decodeURIComponent(images[0].getAttribute('href').split(',')[1]).includes(source));
  assert.equal(s.svg.querySelectorAll('script, style, [data-id]').length, 0);
  assert.equal(s.board.getBoardState()[0].svg, source);
});

test('erase without a target still intentionally clears everything', async () => {
  const s = setup();
  await finish(s, s.board.playStep({ say: 'Clear', actions: [line, { type: 'erase' }] }, async () => {}));
  assert.equal(s.board.getBoardState().length, 0);
});
