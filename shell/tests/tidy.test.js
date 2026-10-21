// Tests for tidyScript's layout clean-up (llm/tidy.js).
//   node --test shell/tests/
const test = require('node:test');
const assert = require('node:assert');
const { tidyScript } = require('../llm/tidy');

const tidy = (actions) => tidyScript({ topic: 't', steps: [{ say: 'x', actions }] });
const note = (text) => ({ type: 'write_text', text, region: 'right' });

test('maths notes: pure maths becomes LaTeX, sentences stay text', () => {
  const cases = {
    'a^2 + b^2 = c^2': ['write_formula', 'a^2 + b^2 = c^2'],
    'c = \\sqrt{a^2 + b^2}': ['write_formula', 'c = \\sqrt{a^2 + b^2}'],
    'x_1^2 + x_2^2': ['write_formula', 'x_1^2 + x_2^2'],
    '2^10 = 1024': ['write_formula', '2^{10} = 1024'],
    'A = pi r^2': ['write_formula', 'A = \\pi r^2'],
    'sqrt(25) = 5': ['write_formula', '\\sqrt{25} = 5'],
    'What is 6^2 + 8^2?': ['write_text', 'What is 6² + 8²?'],
    'x^2 grows 100% faster': ['write_text', 'x² grows 100% faster'],
    'So 9^0.5 = 3': ['write_text', 'So 9^0.5 = 3'],
  };
  for (const [input, [type, out]] of Object.entries(cases)) {
    const a = tidy([note(input)]).script.steps[0].actions[0];
    assert.strictEqual(a.type, type, input);
    assert.strictEqual(a.latex || a.text, out, input);
  }
});

test('a label whose target was never drawn moves to the nearest real shape', () => {
  const { script } = tidy([
    { type: 'draw_line', from: [100, 100], to: [100, 300] },
    { type: 'draw_line', from: [100, 300], to: [300, 300] },
    { type: 'label', target: 't1', text: 'b', at: [190, 330] },
  ]);
  const [, bottom, label] = script.steps[0].actions;
  assert.strictEqual(label.target, bottom.id);
});

test('a line missing an end point is never a label target, and does not crash anything', () => {
  const { script } = tidy([
    { type: 'draw_line', id: 'broken', points: [[1, 1], [9, 9]] },
    { type: 'draw_shape', id: 'box', shape: 'rect', points: [[100, 100], [200, 200]] },
    { type: 'label', target: 'broken', text: 'x', at: [150, 150] },
  ]);
  assert.strictEqual(script.steps[0].actions[2].target, 'box');
});

test('a note written on top of a shape becomes its label (the board would clear everything otherwise)', () => {
  const { script } = tidy([
    { type: 'draw_shape', id: 'sq', shape: 'rect', points: [[150, 350], [350, 450]] },
    { type: 'write_text', text: 'square on a', at: [250, 420] },
  ]);
  const a = script.steps[0].actions[1];
  assert.strictEqual(a.type, 'label');
  assert.strictEqual(a.target, 'sq');
});

test('a label on a line is pushed clear of it', () => {
  const { script, fixes } = tidy([
    { type: 'draw_shape', id: 't1', shape: 'triangle', points: [[120, 400], [120, 160], [380, 400]] },
    { type: 'label', target: 't1', text: 'c', at: [205, 245] },
  ]);
  assert.notDeepStrictEqual(script.steps[0].actions[1].at, [205, 245]);
  assert.ok(fixes.some((f) => f.includes('was on a line')));
});

test('follow-up: knows the existing board (targets, obstacles, ids already taken)', () => {
  const board = [
    { type: 'draw_shape', id: 't1', shape: 'triangle', points: [[100, 380], [100, 140], [340, 380]] },
    { type: 'draw_line', id: 'auto1', from: [400, 100], to: [400, 300] },
  ];
  const { script } = tidyScript(
    { topic: 'f', steps: [{ say: 'x', actions: [
      { type: 'label', target: 't1', text: 'c', at: [215, 262] },
      { type: 'draw_line', from: [500, 100], to: [600, 100] },
    ] }] },
    { existing: board }
  );
  const [label, line] = script.steps[0].actions;
  assert.strictEqual(label.target, 't1', 'a label on an existing shape keeps its target');
  assert.notDeepStrictEqual(label.at, [215, 262], 'and is pushed off its line');
  assert.notStrictEqual(line.id, 'auto1', 'new auto ids skip ids already on the board');
});

const NOTES_BOARD = [
  { type: 'draw_shape', id: 'tri', shape: 'triangle', points: [[90, 185], [90, 405], [330, 405]] },
  { type: 'write_text', text: 'a and b: direct', at: [440, 120] },
  { type: 'write_text', text: 'c: the shortcut across', at: [440, 168] },
  { type: 'write_text', text: 'so c is the longest', at: [440, 216] },
];

test('follow-up: new shapes drawn over the notes move (with their labels) to free space', () => {
  const { script, fixes } = tidyScript(
    { topic: 'f', steps: [{ say: 'x', actions: [
      { type: 'draw_shape', id: 'sa', shape: 'rect', points: [[440, 100], [490, 150]] },
      { type: 'label', target: 'sa', text: 'a', at: [460, 390] }, // far from its square: snapped under it first
    ] }] },
    { existing: NOTES_BOARD }
  );
  const [sq, label] = script.steps[0].actions;
  assert.ok(sq.points[1][0] <= 400, 'moved to the drawing side');
  assert.ok(Math.abs(label.at[1] - sq.points[1][1]) < 40, 'label stays with its square');
  assert.ok(fixes.some((f) => f.includes('off the notes')));
});

test('follow-up: a shape built on an existing shape (not on notes) stays where it is', () => {
  const sq = { type: 'draw_shape', id: 'sq', shape: 'rect', points: [[90, 405], [330, 480]] };
  const { script } = tidyScript({ topic: 'f', steps: [{ say: 'x', actions: [sq] }] }, { existing: NOTES_BOARD });
  assert.deepStrictEqual(script.steps[0].actions[0].points, sq.points);
});

test('follow-up that starts by clearing the board is treated as a fresh drawing', () => {
  const sq = { type: 'draw_shape', id: 'sq', shape: 'rect', points: [[440, 100], [490, 150]] };
  const { script } = tidyScript({ topic: 'f', steps: [{ say: 'x', actions: [{ type: 'erase' }, sq] }] }, { existing: NOTES_BOARD });
  assert.deepStrictEqual(script.steps[0].actions[1].points, sq.points);
});

test('follow-up: a new shape drawn across the inside of an existing one moves to free space', () => {
  const board = [{ type: 'draw_shape', id: 'tri', shape: 'triangle', points: [[100, 150], [100, 405], [350, 405]] }];
  const { script, fixes } = tidyScript(
    { topic: 'f', steps: [{ say: 'x', actions: [{ type: 'draw_shape', id: 'sq', shape: 'rect', points: [[120, 300], [200, 380]] }] }] },
    { existing: board }
  );
  assert.notDeepStrictEqual(script.steps[0].actions[0].points, [[120, 300], [200, 380]]);
  assert.ok(fixes.some((f) => f.includes('off a shape')));
});
