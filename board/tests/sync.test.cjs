// No browser or pipeline required. A controlled clock also simulates late frames.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const setup = require('./test-board.cjs');

const line = { type: 'draw_line', from: [10, 10], to: [100, 100] };
const step = (actions = [line]) => ({ say: 'One', actions });

test('speech and drawing start together; fast speech still waits for drawing', async () => {
  const s = setup(); let started, done = false;
  const playing = s.board.playStep(step(), () => { started = s.now(); return s.speak(200)(); }).then(() => { done = true; });
  assert.equal(started, 0); assert.equal(s.animations[0].at, 0);
  await s.advance(200); assert.equal(done, false);
  await s.advance(1199); assert.equal(done, false);
  await s.advance(1200); await playing; assert.equal(done, true);
});

test('slow speech blocks the next script step after drawing is finished', async () => {
  const s = setup(); const starts = [];
  const playing = s.board.playScript({ steps: [step(), step()] }, () => {
    starts.push(s.now()); return s.speak(2400)();
  });
  await s.advance(1200); assert.deepEqual(starts, [0]);
  await s.advance(2400); assert.deepEqual(starts, [0, 2400]);
  await s.advance(4800); await playing;
});

test('many actions share one speech estimate without a 500ms minimum each', async () => {
  const s = setup(); let done = false;
  const playing = s.board.playStep(step(Array(8).fill(line)), s.speak(1200)).then(() => { done = true; });
  await s.advance(1200); await playing;
  assert.equal(done, true); assert.equal(s.animations.length, 8);
  assert.equal(s.animations.at(-1).at + s.animations.at(-1).options.duration, 1200);
});

test('actual animation completion is awaited even when frames arrive late', async () => {
  const s = setup(100); let done = false;
  const playing = s.board.playStep(step(), s.speak(100)).then(() => { done = true; });
  await s.advance(1200); assert.equal(done, false);
  await s.advance(1300); await playing; assert.equal(done, true);
});

test('speech-only steps wait for speech and empty steps resolve', async () => {
  const s = setup(); let done = false;
  const playing = s.board.playStep(step([]), s.speak(300)).then(() => { done = true; });
  await s.advance(299); assert.equal(done, false);
  await s.advance(300); await playing;
  await s.board.playStep({ say: '', actions: [] }, async () => {});
});

test('text fades are awaited; diagrams receive more time than labels', async () => {
  const s = setup();
  const playing = s.board.playStep(step([
    { type: 'draw_shape', id: 't', shape: 'triangle', points: [[0, 0], [0, 20], [20, 20]] },
    { type: 'label', target: 't', text: 'A', at: [10, 10] },
  ]), s.speak(1200));
  await s.advance(1200); await playing;
  assert.equal(s.animations[0].options.duration, 960);
  assert.equal(s.animations[1].options.duration, 240);
});

test('voice failures wait for drawing then reject without playing another step', async () => {
  for (const speak of [() => { throw new Error('voice failed'); }, async () => { throw new Error('voice failed'); }]) {
    const s = setup(); let error;
    const playing = s.board.playScript({ steps: [step(), step()] }, speak).catch(e => { error = e; });
    await s.advance(1199); assert.equal(error, undefined);
    await s.advance(1200); await playing;
    assert.equal(error.message, 'voice failed'); assert.equal(s.animations.length, 1);
  }
});

test('unknown actions skip immediately without stretching the drawing budget', async () => {
  const s = setup();
  const playing = s.board.playStep(step([{ type: 'unknown' }, line]), s.speak(1200));
  await s.advance(1200); await playing;
  assert.equal(s.warnings.length, 1); assert.equal(s.animations[0].options.duration, 1200);
});
