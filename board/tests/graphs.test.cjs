const { test } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../graph-helpers.js');
const JXG = require('../vendor/jsxgraph-1.14.0/jsxgraphcore.js');
const setup = require('./test-board.cjs');

test('real JSXGraph produces a bounded parabola, coordinates and SVG actions', () => {
  const plot = helpers.functionPlot(x => x * x);
  assert.equal(plot.axes.type, 'draw_svg');
  assert.equal(plot.curve.type, 'draw_svg');
  assert.deepEqual(JSON.parse(JSON.stringify(plot.curve)), plot.curve);
  const origin = plot.toBoard(0, 0);
  assert.equal(origin[0], 260);
  assert(Math.abs(origin[1] - 354.545) < 0.001);
  const data = plot.curve.svg.match(/d="([^"]+)"/)[1];
  const points = [...data.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert(points.length > 50);
  for (const [x, y] of points) {
    assert(x >= 40 && x <= 400 && y >= 20 && y <= 300);
    const mathX = (x - 40) / 60 - 3;
    const mathY = 10 - (y - 20) * 11 / 280;
    assert(Math.abs(mathY - mathX * mathX) < 0.002);
  }
});

test('discontinuous functions do not draw across clipped asymptotes', () => {
  const plot = helpers.functionPlot(x => 1 / x, { xRange: [-3, 3], yRange: [-5, 5] });
  const data = plot.curve.svg.match(/d="([^"]+)"/)[1];
  assert((data.match(/M/g) || []).length >= 2);
  assert(!/NaN|Infinity/.test(plot.curve.svg));
});

test('parabola ticks use whole numbers and leave space around the origin', () => {
  const plot = helpers.functionPlot(x => x * x);
  const labels = [...plot.axes.svg.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*>([^<]+)<\/text>/g)]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]), text: m[3] }));
  const numeric = labels.filter(label => Number.isFinite(Number(label.text)));
  assert(numeric.every(label => Number.isInteger(Number(label.text))));
  assert.equal(numeric.filter(label => label.text === '0').length, 1);
  const [originX, originY] = plot.toBoard(0, 0).map((v, i) => v - [40, 80][i]);
  const vertical = numeric.filter(label => label.text !== '0' && label.x === originX - 10);
  assert.deepEqual(vertical.map(label => Number(label.text)), [2, 4, 6, 8, 10]);
  assert(vertical.every(label => Math.abs(label.y - 5 - originY) >= 28));
  assert.deepEqual(numeric.filter(label => label.y === originY + 22).map(label => Number(label.text)), [-3, -2, -1, 1, 2, 3]);
});

test('invalid ranges, executable strings, invisible curves and off-plot points fail clearly', () => {
  assert.throws(() => helpers.functionPlot('x*x'), TypeError);
  assert.throws(() => helpers.functionPlot(x => x, { xRange: [3, -3] }), RangeError);
  assert.throws(() => helpers.functionPlot(x => x, { yRange: [1, 2] }), RangeError);
  assert.throws(() => helpers.functionPlot(x => x, { yRange: [0, Infinity] }), RangeError);
  assert.throws(() => helpers.functionPlot(() => NaN), RangeError);
  assert.throws(() => helpers.functionPlot(() => 1000), RangeError);
  assert.throws(() => helpers.functionPlot(x => x).toBoard(99, 0), RangeError);
});

test('numerical helper does not register visible boards or event listeners', () => {
  const before = Object.keys(JXG.boards).length;
  for (let i = 0; i < 10; i++) helpers.functionPlot(Math.sin, { xRange: [-3, 3], yRange: [-2, 2] });
  assert.equal(Object.keys(JXG.boards).length, before);
});

for (const kind of ['parabola', 'line', 'sine']) {
  test(`${kind} lesson draws axes then curve, marks a point and works with fake speech`, async () => {
    const script = helpers.demo(kind);
    assert.deepEqual(JSON.parse(JSON.stringify(script)), script);
    const s = setup(); const spoken = [];
    const playing = s.board.playScript(script, async text => { spoken.push(text); });
    await s.advance(100000); await playing;
    assert.equal(s.warnings.length, 0, JSON.stringify(s.warnings));
    assert.equal(spoken.length, 3);
    const state = s.board.getBoardState();
    assert.equal(state.filter(entry => entry.type === 'draw_svg').length, 2);
    assert(state.some(entry => entry.type === 'write_formula'));
    assert(state.some(entry => entry.type === 'highlight'));
    assert(state.some(entry => entry.type === 'label'));
    assert(s.animations.length > 5);
    assert(!/script|onload|href=/i.test(script.steps[1].actions[0].svg));
  });
}
