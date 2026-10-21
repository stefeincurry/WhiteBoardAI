// Tests for the conversation loop (tutor.js) with a fake AI and a fake board: no Electron, no network.
//   node --test shell/tests/
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Swap in a fake callModel before tutor.js loads it.
const callModelPath = require.resolve(path.join(__dirname, '..', 'llm', 'callModel.js'));
let modelReplies = []; // each entry: () => Promise<result>
const modelInputs = []; // what each callModel got (question, boardState, history)
require.cache[callModelPath] = {
  id: callModelPath,
  filename: callModelPath,
  loaded: true,
  exports: {
    callModel: (input) => {
      modelInputs.push(input);
      return (modelReplies.shift() || (() => Promise.reject(new Error('no reply queued'))))();
    },
  },
};
const { createTutor, plainTextScript } = require('../tutor');

const tick = () => new Promise((r) => setImmediate(r));
const BOARD = [{ type: 'draw_shape', id: 't1', shape: 'triangle', points: [[100, 380], [100, 140], [340, 380]] }];
const script = (n, tag = 's') => ({ topic: 't', steps: Array.from({ length: n }, (_, i) => ({ say: `${tag}${i + 1}`, actions: [] })) });
const reply = (s, delay = 0) => () => new Promise((r) => setTimeout(() => r({ script: s, raw: '', model: 'fake', ms: delay, failures: [], fixes: [] }), delay));

function setup() {
  const log = { js: [], mic: [], steps: [], spoken: [] };
  let release = []; // pending playStep resolvers, so a test controls when a step "finishes"
  const tutor = createTutor({
    run: (js) => {
      log.js.push(js);
      if (js.startsWith('window.board.playStep(')) {
        log.steps.push(JSON.parse(js.slice('window.board.playStep('.length, js.lastIndexOf(', window.shell.speak)'))).say);
        return new Promise((r) => release.push(r));
      }
      if (js.startsWith('window.shell.speak(')) log.spoken.push(JSON.parse(js.slice('window.shell.speak('.length, -1)));
      if (js === 'window.board.getBoardState()') return Promise.resolve(BOARD);
      return Promise.resolve();
    },
    mic: (cmd) => log.mic.push(cmd),
    getScreenshot: () => null,
  });
  const finishStep = async () => {
    await tick();
    const r = release.shift();
    assert.ok(r, 'a step should be playing');
    r();
    await tick();
  };
  return { tutor, log, finishStep, pendingSteps: () => release.length };
}

test('full answer: steps play in order, board cleared first', async () => {
  const { tutor, log, finishStep } = setup();
  await tutor.hotkey(true);
  modelReplies.push(reply(script(2)));
  const answering = tutor.heard('why?', tutor.listenId);
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(tutor.state, 'playing');
  await finishStep();
  await finishStep();
  await answering;
  assert.deepStrictEqual(log.steps, ['s1', 's2']);
  assert.strictEqual(tutor.state, 'idle');
  const clears = log.js.filter((j) => j === 'window.board.clearBoard()').length;
  assert.strictEqual(clears, 2, 'cleared on open and again before the answer');
});

test('hotkey while listening sends stop, not a second start', async () => {
  const { tutor, log } = setup();
  await tutor.hotkey(true);
  await tutor.hotkey(false);
  assert.deepStrictEqual(log.mic, ['start', 'stop']);
  assert.strictEqual(tutor.state, 'listening', 'still waiting for the transcript');
});

test('interrupt while thinking: the late answer is dropped, the follow-up is answered', async () => {
  const { tutor, log, finishStep } = setup();
  await tutor.hotkey(true);
  modelReplies.push(reply(script(1, 'old'), 30));
  const first = tutor.heard('first?', tutor.listenId);
  await tick();
  assert.strictEqual(tutor.state, 'thinking');
  await tutor.hotkey(false); // interrupt -> listening again
  assert.strictEqual(tutor.state, 'listening');
  modelReplies.push(reply(script(1, 'new')));
  const second = tutor.heard('second?', tutor.listenId);
  await new Promise((r) => setTimeout(r, 40)); // the old reply arrives meanwhile and must be ignored
  await finishStep();
  await Promise.all([first, second]);
  assert.deepStrictEqual(log.steps, ['new1']);
});

test('interrupt while playing: stops after the current step, new answer waits for it', async () => {
  const { tutor, log, finishStep, pendingSteps } = setup();
  await tutor.hotkey(true);
  modelReplies.push(reply(script(3, 'a')));
  const first = tutor.heard('q1', tutor.listenId);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(log.steps, ['a1']);
  await tutor.hotkey(false); // interrupt during step a1
  modelReplies.push(reply(script(1, 'b')));
  const second = tutor.heard('q2', tutor.listenId);
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(pendingSteps(), 1, 'b1 must not start while a1 is still drawing');
  await finishStep(); // a1 finishes drawing
  await new Promise((r) => setTimeout(r, 5));
  await finishStep(); // b1
  await Promise.all([first, second]);
  assert.deepStrictEqual(log.steps, ['a1', 'b1']);
});

test('a transcript from an old recording is ignored', async () => {
  const { tutor, log } = setup();
  await tutor.hotkey(true);
  const oldId = tutor.listenId;
  tutor.reset(); // Esc
  await tutor.hotkey(true); // reopened and listening again
  await tutor.heard('stale question', oldId);
  assert.strictEqual(tutor.state, 'listening');
  assert.deepStrictEqual(log.steps, []);
});

test('nothing heard / mic broken: says so and goes idle', async () => {
  const { tutor, log } = setup();
  await tutor.hotkey(true);
  tutor.heardNothing('deaf');
  assert.strictEqual(tutor.state, 'idle');
  assert.match(log.spoken.at(-1), /can't hear/);
  tutor.heardNothing('nothing'); // a second one while idle does nothing
  assert.strictEqual(log.spoken.filter((s) => /hear/.test(s)).length, 1);
});

test('every model down: says sorry, goes idle, next hotkey listens', async () => {
  const { tutor, log } = setup();
  await tutor.hotkey(true);
  modelReplies.push(() => Promise.reject(new Error('All models failed:\n  x')));
  await tutor.heard('q', tutor.listenId);
  assert.strictEqual(tutor.state, 'idle');
  assert.match(log.spoken.at(-1), /can't reach my brain/);
  await tutor.hotkey(false);
  assert.strictEqual(tutor.state, 'listening');
});

test('invalid script twice: speaks the lines it can rescue, without drawings', async () => {
  const s = plainTextScript('{"topic":"x","steps":[{"say":"First \\"quoted\\" line.","actions":[{"type":"bad"}]},{"say":"Second", broken');
  assert.deepStrictEqual(s.steps.map((x) => x.say), ['First "quoted" line.', 'Second']);
  assert.ok(s.steps.every((x) => x.actions.length === 0));
  assert.match(plainTextScript('garbage').steps[0].say, /tangled/);
});

test('follow-ups: the first question starts clean, later ones get the board and the conversation', async () => {
  const { tutor, log, finishStep } = setup();
  modelInputs.length = 0;
  await tutor.hotkey(true);
  modelReplies.push(reply(script(2, 'a')));
  const q1 = tutor.heard('why is c the longest?', tutor.listenId);
  await new Promise((r) => setTimeout(r, 5));
  await finishStep();
  await finishStep();
  await q1;
  assert.strictEqual(modelInputs[0].boardState, undefined, 'first question: no board state');
  assert.strictEqual(modelInputs[0].history, undefined);
  const clearsAfterQ1 = log.js.filter((j) => j === 'window.board.clearBoard()').length;

  await tutor.hotkey(false); // follow-up from idle
  modelReplies.push(reply(script(1, 'b')));
  const q2 = tutor.heard('wait, why is it squared?', tutor.listenId);
  await new Promise((r) => setTimeout(r, 5));
  await finishStep();
  await q2;
  assert.deepStrictEqual(modelInputs[1].boardState, BOARD);
  assert.match(modelInputs[1].history, /why is c the longest\?/);
  assert.match(modelInputs[1].history, /"a1"[\s\S]*"a2"/);
  assert.doesNotMatch(modelInputs[1].history, /cut you off/);
  assert.strictEqual(log.js.filter((j) => j === 'window.board.clearBoard()').length, clearsAfterQ1, 'follow-up keeps the board');
  assert.deepStrictEqual(log.steps, ['a1', 'a2', 'b1']);
});

test('follow-up after an interrupt: says where it was cut off, waits for the step to finish drawing first', async () => {
  const { tutor, finishStep } = setup();
  modelInputs.length = 0;
  await tutor.hotkey(true);
  modelReplies.push(reply(script(3, 'a')));
  const q1 = tutor.heard('q1', tutor.listenId);
  await new Promise((r) => setTimeout(r, 5));
  await finishStep(); // a1 done
  await new Promise((r) => setTimeout(r, 5)); // a2 now playing
  await tutor.hotkey(false); // interrupt during a2
  modelReplies.push(reply(script(1, 'b')));
  const q2 = tutor.heard('why?', tutor.listenId);
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(modelInputs.length, 1, 'the model is asked only after a2 has finished drawing');
  await finishStep(); // a2 finishes drawing
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(modelInputs.length, 2);
  assert.match(modelInputs[1].history, /cut you off while you were saying: "a2"/);
  await finishStep(); // b1
  await Promise.all([q1, q2]);
});

test('closing (Esc) forgets the conversation: the next question is fresh again', async () => {
  const { tutor, finishStep } = setup();
  modelInputs.length = 0;
  await tutor.hotkey(true);
  modelReplies.push(reply(script(1)));
  const q1 = tutor.heard('q1', tutor.listenId);
  await new Promise((r) => setTimeout(r, 5));
  await finishStep();
  await q1;
  tutor.reset(); // Esc
  await tutor.hotkey(true);
  modelReplies.push(reply(script(1)));
  const q2 = tutor.heard('q2', tutor.listenId);
  await new Promise((r) => setTimeout(r, 5));
  await finishStep();
  await q2;
  assert.strictEqual(modelInputs[1].boardState, undefined);
  assert.strictEqual(modelInputs[1].history, undefined);
});
