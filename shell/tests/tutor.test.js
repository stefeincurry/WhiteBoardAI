// Tests for the conversation loop (tutor.js) with a fake AI and a fake board: no Electron, no network.
//   node --test shell/tests/
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Swap in a fake callModel before tutor.js loads it.
const callModelPath = require.resolve(path.join(__dirname, '..', 'llm', 'callModel.js'));
let modelReplies = []; // each entry: () => Promise<result>
const modelInputs = []; // what each callModel got (question, boardState, history)
const modelOpts = []; // and its options (onStep, signal)
require.cache[callModelPath] = {
  id: callModelPath,
  filename: callModelPath,
  loaded: true,
  exports: {
    callModel: (input, opts) => {
      modelInputs.push(input);
      modelOpts.push(opts);
      return (modelReplies.shift() || (() => Promise.reject(new Error('no reply queued'))))(opts);
    },
  },
};
const { createTutor, plainTextScript } = require('../tutor');

const tick = () => new Promise((r) => setImmediate(r));
/** Waits until cond() is true (tests run in parallel, so fixed sleeps can be too short on a busy CPU). */
async function until(cond, ms = 1000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}
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
  await until(() => tutor.state === 'playing');
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

/** A fake streaming answer: hands steps to onStep gapMs apart, then resolves with the whole script. */
const streamReply = (s, gapMs = 30) => (opts) =>
  new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (opts.signal && opts.signal.aborted) return reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      if (i < s.steps.length) {
        opts.onStep(s.steps[i++]);
        return setTimeout(next, gapMs);
      }
      resolve({ script: s, raw: '', model: 'fake', ms: 0, failures: [], fixes: [], streamed: true });
    };
    setTimeout(next, gapMs);
  });

test('streaming: the first step plays while the AI is still writing the rest', async () => {
  const { tutor, log, finishStep } = setup();
  await tutor.hotkey(true);
  modelReplies.push(streamReply(script(3, 's'), 40));
  const answering = tutor.heard('q', tutor.listenId);
  await new Promise((r) => setTimeout(r, 60)); // only the first step has been written
  assert.deepStrictEqual(log.steps, ['s1'], 'step 1 is playing before the answer is complete');
  assert.strictEqual(tutor.state, 'playing');
  await new Promise((r) => setTimeout(r, 100)); // the rest arrives
  await finishStep();
  await finishStep();
  await finishStep();
  await answering;
  assert.deepStrictEqual(log.steps, ['s1', 's2', 's3']);
  assert.strictEqual(tutor.state, 'idle');
});

test('streaming: interrupting cancels the AI call, and the follow-up still gets the steps that played', async () => {
  const { tutor, finishStep } = setup();
  modelOpts.length = 0;
  modelInputs.length = 0;
  await tutor.hotkey(true);
  modelReplies.push(streamReply(script(4, 'a'), 40));
  const first = tutor.heard('q1', tutor.listenId);
  await new Promise((r) => setTimeout(r, 60));
  await tutor.hotkey(false); // interrupt while a1 plays and a2..a4 are still being written
  assert.strictEqual(modelOpts[0].signal.aborted, true, 'the AI call was cancelled');
  modelReplies.push(reply(script(1, 'b')));
  const second = tutor.heard('why?', tutor.listenId);
  await finishStep(); // a1 finishes drawing
  await new Promise((r) => setTimeout(r, 20));
  await finishStep(); // b1
  await Promise.all([first, second]);
  assert.match(modelInputs[1].history, /"a1"/);
  assert.doesNotMatch(modelInputs[1].history, /"a2"/);
  assert.match(modelInputs[1].history, /cut you off while you were saying: "a1"/);
});

test('streaming: interrupted while thinking (nothing said yet) leaves no trace in the conversation', async () => {
  const { tutor, finishStep } = setup();
  modelInputs.length = 0;
  await tutor.hotkey(true);
  modelReplies.push(streamReply(script(2, 'a'), 200));
  const first = tutor.heard('q1', tutor.listenId);
  await new Promise((r) => setTimeout(r, 20));
  await tutor.hotkey(false); // before any step arrived
  modelReplies.push(reply(script(1, 'b')));
  const second = tutor.heard('q2', tutor.listenId);
  await new Promise((r) => setTimeout(r, 10));
  await finishStep();
  await Promise.all([first, second]);
  assert.strictEqual(modelInputs[1].history, undefined, 'q2 is a fresh question, not a follow-up of nothing');
});

test('pause holds the next step until resume', async () => {
  const { tutor, log, finishStep } = setup();
  await tutor.hotkey(true);
  modelReplies.push(reply(script(2, 'p')));
  const answering = tutor.heard('q', tutor.listenId);
  await until(() => log.steps.length === 1);
  tutor.pause(true);
  await finishStep(); // p1 ends while paused
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(log.steps, ['p1'], 'p2 waits while paused');
  tutor.pause(false);
  await until(() => log.steps.length === 2);
  await finishStep();
  await answering;
});

test('typing mid-answer interrupts it and asks the typed question as a follow-up', async () => {
  const { tutor, log, finishStep } = setup();
  modelInputs.length = 0;
  await tutor.hotkey(true);
  modelReplies.push(reply(script(3, 'a')));
  const first = tutor.heard('q1', tutor.listenId);
  await until(() => log.steps.length === 1);
  modelReplies.push(reply(script(1, 'b')));
  const second = tutor.typed('wait, why?');
  await finishStep(); // a1 finishes drawing
  await until(() => log.steps.includes('b1'));
  await finishStep();
  await Promise.all([first, second]);
  assert.deepStrictEqual(log.steps, ['a1', 'b1']);
  assert.strictEqual(modelInputs.at(-1).question, 'wait, why?');
  assert.match(modelInputs.at(-1).history, /cut you off/);
});

test('"explain it differently" re-asks the last question for a fresh approach', async () => {
  const { tutor, log, finishStep } = setup();
  modelInputs.length = 0;
  await tutor.hotkey(true);
  modelReplies.push(reply(script(1, 'a')));
  const first = tutor.heard('why is c the longest?', tutor.listenId);
  await until(() => log.steps.length === 1);
  await finishStep();
  await first;
  modelReplies.push(reply(script(1, 'b')));
  const second = tutor.again();
  await until(() => log.steps.length === 2);
  await finishStep();
  await second;
  assert.match(modelInputs[1].question, /completely different way/);
  assert.match(modelInputs[1].history, /why is c the longest\?/, 'the AI knows what "that" was from the conversation');
});

test('"test me" asks for one practice question on the conversation; nothing to test before a question', async () => {
  const { tutor, log, finishStep } = setup();
  modelInputs.length = 0;
  await tutor.hotkey(true);
  tutor.testMe();
  assert.match(log.spoken.at(-1), /Ask me something first/);
  modelReplies.push(reply(script(1, 'a')));
  const first = tutor.heard('what is multiplication?', tutor.listenId);
  await until(() => log.steps.length === 1);
  await finishStep();
  await first;
  modelReplies.push(reply(script(1, 'q')));
  const test = tutor.testMe();
  await until(() => log.steps.length === 2);
  await finishStep();
  await test;
  assert.match(modelInputs[1].question, /practice question/);
  assert.match(modelInputs[1].history, /what is multiplication\?/);
});
