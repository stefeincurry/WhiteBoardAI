// Tests for callModel's fallback chain with a fake fetch: no network, no keys used.
//   node --test shell/tests/
const test = require('node:test');
const assert = require('node:assert');

process.env.GROQ_API_KEY = 'fake';
process.env.GEMINI_API_KEY = 'fake';
const { callModel } = require('../llm/callModel');

const VALID = JSON.stringify({ topic: 't', steps: [{ say: 'Hello there.', actions: [] }] });
const groqReply = (text) => ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }], usage: {} }) });
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
const busy = () => ({ ok: false, status: 503, text: async () => JSON.stringify({ error: { message: 'high demand' } }) });

test('first model answers: valid script, no fallbacks', async () => {
  global.fetch = async () => groqReply(VALID);
  const r = await callModel({ question: 'q' });
  assert.ok(r.script);
  assert.strictEqual(r.failures.length, 0);
});

test('every model hangs: gives up at the overall deadline, not after 20s per model', async () => {
  global.fetch = async (_url, init) => hang(init);
  const t0 = Date.now();
  await assert.rejects(callModel({ question: 'q' }, { deadlineMs: 2500 }), /All models failed/);
  const ms = Date.now() - t0;
  assert.ok(ms < 3500, `took ${ms}ms`);
});

test('busy models are skipped and the next one answers', async () => {
  // Groq is busy; Gemini replies in Gemini's shape:
  global.fetch = async (url) =>
    url.includes('groq')
      ? busy()
      : { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: VALID }] } }], usageMetadata: {} }) };
  const r = await callModel({ question: 'q' });
  assert.ok(r.script);
  assert.match(r.model, /gemini/);
  assert.ok(r.failures.length >= 2);
});

test('invalid reply, then no model in time for the retry: keeps the first reply for the spoken fallback', async () => {
  let calls = 0;
  const broken = '{"topic":"t","steps":[{"say":"Rescue me.","actions":[{"type":"nope"}]}]}';
  global.fetch = async (_url, init) => (++calls === 1 ? groqReply(broken) : hang(init));
  const r = await callModel({ question: 'q' }, { deadlineMs: 2500 });
  assert.strictEqual(r.script, null);
  assert.strictEqual(r.raw, broken);
});

test('a schema-valid script that trips the layout clean-up still comes back', async () => {
  // draw_line without from/to used to crash tidy (and was then blamed on the model as "Invalid JSON")
  const odd = JSON.stringify({
    topic: 't',
    steps: [{ say: 'x', actions: [{ type: 'draw_line', points: [[1, 1], [9, 9]] }, { type: 'label', target: 'q', text: 'a', at: [5, 5] }] }],
  });
  global.fetch = async () => groqReply(odd);
  const r = await callModel({ question: 'q' });
  assert.ok(r.script);
  assert.strictEqual(r.attempts, 1);
});

test('a hanging first model times out alone: the next model still answers inside the deadline', async () => {
  global.fetch = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    return model === 'qwen/qwen3.8-27b' ? hang(init) : groqReply(VALID);
  };
  const t0 = Date.now();
  const r = await callModel({ question: 'q' });
  assert.ok(r.script);
  assert.strictEqual(r.model, 'openai/gpt-oss-120b');
  assert.ok(Date.now() - t0 < 10000, 'qwen gets its own short timeout, not the whole budget');
});
