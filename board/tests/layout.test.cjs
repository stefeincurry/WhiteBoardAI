const { test } = require('node:test');
const assert = require('node:assert/strict');
const BoardLayout = require('../layout.js');
const setup = require('./test-board.cjs');

const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y;
const notes = count => Array.from({ length: count }, (_, i) => ({
  type: i % 3 === 2 ? 'write_formula' : 'write_text',
  text: `Note ${i}: Energy can move between kinetic and potential forms.`,
  latex: 'E = \\frac{1}{2}mv^2', region: 'left',
}));
async function play(s, actions) {
  const pending = s.board.playStep({ say: 'Notes', actions }, async () => {});
  await s.advance(s.now() + 100000);
  await pending;
  assert.equal(s.warnings.length, 0, JSON.stringify(s.warnings));
}

test('placement respects all four regions and avoids occupied diagram bounds', () => {
  const layout = new BoardLayout();
  layout.reserve({ x: 40, y: 36, width: 344, height: 200, diagram: true }, 'diagram');
  for (const region of ['left', 'right', 'top', 'bottom']) {
    const box = layout.place(100, 40, region);
    assert(box); assert(box.x >= 16 && box.x + box.width <= 784);
    assert(box.y >= 16 && box.y + box.height <= 484);
    assert(!overlap(box, layout.items[0]));
  }
});

test('a label can sit within its diagram but cannot overlap another label', () => {
  const layout = new BoardLayout();
  layout.reserve({ x: 40, y: 36, width: 344, height: 300, diagram: true }, 'triangle');
  const first = layout.place(120, 34, 'left', [60, 60], 'triangle');
  assert.equal(first.y, 60);
  layout.reserve(first, 'triangle');
  const second = layout.place(120, 34, 'left', [60, 60], 'triangle');
  assert(!overlap(first, second));
});

test('full region reports overflow and erase frees its reserved space', () => {
  const layout = new BoardLayout();
  layout.reserve({ x: 0, y: 0, width: 800, height: 500 }, 'full');
  assert.equal(layout.place(300, 80, 'left'), null);
  layout.remove('full');
  assert(layout.place(300, 80, 'left'));
});

test('growing notes reuse one board and discard erased content from the snapshot', async () => {
  const s = setup(); await play(s, notes(18));
  assert.equal(s.container.children.length, 1);
  assert(s.board.getBoardState().length > 0 && s.board.getBoardState().length < 18);
  for (const page of s.container.children) {
    const boxes = page.querySelectorAll('foreignObject').map(node => Object.fromEntries(
      ['x', 'y', 'width', 'height'].map(key => [key, Number(node.getAttribute(key))])));
    for (let i = 0; i < boxes.length; i++) {
      assert(boxes[i].y + boxes[i].height <= 484);
      assert(boxes[i].x + boxes[i].width <= 784);
      for (let j = i + 1; j < boxes.length; j++) assert(!overlap(boxes[i], boxes[j]));
    }
  }
  const snapshot = s.board.getBoardState();
  assert(snapshot.every(entry => entry.page === undefined));
  snapshot[0].text = 'changed';
  assert.notEqual(s.board.getBoardState()[0].text, 'changed');
});

test('measured text height controls spacing and an oversized formula scales to fit', async () => {
  const s = setup(0, [
    { scrollWidth: 344, scrollHeight: 250 },
    { scrollWidth: 344, scrollHeight: 250 },
    { scrollWidth: 1200, scrollHeight: 80 },
  ]);
  await play(s, [
    { type: 'write_text', text: 'Tall wrapped notes', at: [40, 60] },
    { type: 'write_text', text: 'More tall notes', at: [40, 60] },
    { type: 'write_formula', latex: 'x+y+z', region: 'right' },
  ]);
  assert.equal(s.container.children.length, 1);
  assert.equal(s.board.getBoardState().length, 2);
  assert.equal(Number(s.svg.querySelectorAll('foreignObject')[0].getAttribute('height')), 250);
  const formula = s.svg.querySelectorAll('foreignObject').at(-1);
  assert.equal(Number(formula.getAttribute('width')), 344);
  assert.match(formula.children[0].style.transform, /^scale\(0\./);
});

test('labels and highlights stay with the current diagram; erase cleans them', async () => {
  const s = setup();
  await play(s, [{ type: 'draw_shape', id: 'triangle', shape: 'triangle', points: [[100, 100], [100, 300], [300, 300]] }]);
  await play(s, [
    { type: 'label', target: 'triangle', text: 'right angle', at: [110, 280] },
    { type: 'highlight', target: 'triangle', part: 'hypotenuse', color: 'red' },
  ]);
  assert.equal(s.board.getBoardState().at(-1).target, 'triangle');
  assert.equal(s.board.getBoardState().at(-2).target, 'triangle');
  await play(s, [{ type: 'erase', target: 'triangle' }]);
  assert(!s.board.getBoardState().some(entry => entry.id === 'triangle' || entry.target === 'triangle'));
  assert.equal(s.svg.querySelectorAll('[data-id], [data-owner]').length, 0);
  s.board.clearBoard();
  assert.equal(s.container.children.length, 1);
  assert.equal(s.board.getBoardState().length, 0);
  await play(s, [{ type: 'write_text', text: 'Fresh notes', region: 'left' }]);
  assert.equal(s.board.getBoardState()[0].text, 'Fresh notes');
});

test('automatic placement uses the other half before clearing the board', async () => {
  const s = setup(0, [
    { scrollWidth: 344, scrollHeight: 440 },
    { scrollWidth: 344, scrollHeight: 100 },
  ]);
  await play(s, [
    { type: 'write_text', text: 'Left notes', region: 'left' },
    { type: 'write_text', text: 'More notes', region: 'left' },
  ]);
  assert.equal(s.board.getBoardState().length, 2);
  assert.equal(s.board.getBoardState()[1].at[0], 440);
});
