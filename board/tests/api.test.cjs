const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const setup = require('./test-board.cjs');

const names = ['clearBoard', 'getBoardState', 'playScript', 'playStep'];
const triangle = { type: 'draw_shape', id: 't', shape: 'triangle', points: [[100, 300], [100, 100], [300, 300]] };

test('board.js exports the same four functions as window.board for CommonJS renderers', async () => {
  const s = setup(0, [], true);
  const exported = s.context.module.exports;
  assert.deepEqual(Object.keys(exported).sort(), names);
  for (const name of names) assert.equal(exported[name], s.board[name]);
  const playing = exported.playStep({ say: 'Triangle', actions: [triangle] }, s.speak(1200));
  await s.advance(1200); await playing;
  assert.equal(exported.getBoardState()[0].id, 't');
  exported.clearBoard(); assert.equal(s.board.getBoardState().length, 0);
});

test('native ES-module exports operate on the existing board without resetting it', async () => {
  const s = setup();
  const oldWindow = globalThis.window;
  globalThis.window = s.context.window;
  try {
    const first = s.board.playStep({ say: 'Triangle', actions: [triangle] }, s.speak(1200));
    await s.advance(1200); await first;
    const exported = await import(pathToFileURL(path.join(__dirname, '../board.mjs')).href);
    assert.deepEqual(Object.keys(exported).sort(), names);
    assert.equal(exported.getBoardState()[0].id, 't');
    const spoken = [];
    const playing = exported.playScript({ topic: 'Follow up', steps: [
      { say: 'The longest side', actions: [{ type: 'highlight', target: 't', part: 'hypotenuse', color: 'red' }] },
      { say: 'A right triangle', actions: [{ type: 'label', target: 't', text: 'right angle', at: [110, 280] }] },
    ] }, async text => { spoken.push(text); });
    await s.advance(20000); await playing;
    assert.deepEqual(spoken, ['The longest side', 'A right triangle']);
    assert.equal(s.warnings.length, 0, JSON.stringify(s.warnings));
    assert(exported.getBoardState().some(item => item.type === 'highlight'));
    assert(exported.getBoardState().some(item => item.type === 'label'));
    exported.clearBoard(); assert.equal(s.board.getBoardState().length, 0);
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

test('snapshots are serialisable, detached from callers, and reset by clearBoard', async () => {
  const s = setup();
  const action = JSON.parse(JSON.stringify(triangle));
  const playing = s.board.playStep({ say: 'Triangle', actions: [action] }, async () => {});
  await s.advance(1200); await playing;
  action.points[0][0] = 999;
  const snapshot = s.board.getBoardState();
  assert.equal(snapshot[0].points[0][0], 100);
  snapshot[0].points[0][0] = 777;
  assert.equal(s.board.getBoardState()[0].points[0][0], 100);
  assert.equal(JSON.parse(JSON.stringify(snapshot))[0].shape, 'triangle');
  s.board.clearBoard(); assert.equal(s.board.getBoardState().length, 0);
});

test('ES-module calls before renderer initialisation report how to initialise', async () => {
  const oldWindow = globalThis.window;
  delete globalThis.window;
  try {
    const exported = await import(pathToFileURL(path.join(__dirname, '../board.mjs')).href);
    assert.throws(() => exported.getBoardState(), /Load the board page/);
  } finally {
    if (oldWindow !== undefined) globalThis.window = oldWindow;
  }
});
