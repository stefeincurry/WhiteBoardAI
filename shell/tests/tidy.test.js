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
