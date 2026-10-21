const { test } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../cs-helpers.js');
const setup = require('./test-board.cjs');

test('helpers output JSON-safe contract actions with in-bounds coordinates', () => {
  const allowed = new Set(['draw_shape', 'draw_line', 'label', 'arrow', 'write_text']);
  for (const [kind, input] of [
    ['array', [1, 2, 3, 4, 5, 6]], ['linkedList', [1, 2, 3, 4]],
    ['binaryTree', [8, 4, 12, 2, 6, 10, 14]], ['stackFrames', ['main()', 'a()', 'b()', 'c()']],
  ]) {
    const actions = helpers[kind](input);
    assert.deepEqual(JSON.parse(JSON.stringify(actions)), actions);
    const ids = new Set(actions.filter(a => a.id).map(a => a.id));
    assert.equal(ids.size, input.length);
    for (const action of actions) {
      assert(allowed.has(action.type));
      if (action.target) assert(ids.has(action.target));
      const points = [...(action.points || []), ...(action.at ? [action.at] : []), ...(action.from ? [action.from, action.to] : [])];
      for (const [x, y] of points) assert(x >= 16 && x <= 784 && y >= 16 && y <= 484);
    }
  }
});

test('generated IDs do not collide and invalid input fails before drawing', () => {
  const first = helpers.array([1])[0].id;
  assert.notEqual(first, helpers.array([1])[0].id);
  assert.throws(() => helpers.array([]), RangeError);
  assert.throws(() => helpers.linkedList([1, 2, 3, 4, 5]), RangeError);
  assert.throws(() => helpers.array(['too long']), RangeError);
  assert.throws(() => helpers.binaryTree(['1\n2']), RangeError);
  assert.throws(() => helpers.array([Infinity]), TypeError);
  assert.throws(() => helpers.array([{}]), TypeError);
  assert.throws(() => helpers.array([1], { prefix: 'bad id' }), TypeError);
});

for (const kind of ['array', 'linkedList', 'binaryTree', 'stackFrames']) {
  test(`${kind} demo plays, highlights and clears with fake speech`, async () => {
    const s = setup(); const spoken = [];
    const script = helpers.demo(kind);
    const playing = s.board.playScript(script, async text => { spoken.push(text); });
    await s.advance(100000); await playing;
    assert.equal(s.warnings.length, 0, JSON.stringify(s.warnings));
    assert.equal(spoken.length, script.steps.length);
    const snapshot = s.board.getBoardState();
    assert(snapshot.some(entry => entry.type === 'draw_shape'));
    assert(snapshot.some(entry => entry.text === script.steps.at(-1).say));
    const highlight = script.steps[1].actions[0];
    if (kind === 'stackFrames') {
      assert(!snapshot.some(entry => entry.id === highlight.target || entry.target === highlight.target));
      assert.equal(snapshot.filter(entry => entry.type === 'draw_shape').length, 2);
    } else {
      assert(snapshot.some(entry => entry.type === 'highlight' && entry.target === highlight.target));
    }
    s.board.clearBoard(); assert.equal(s.board.getBoardState().length, 0);
  });
}
