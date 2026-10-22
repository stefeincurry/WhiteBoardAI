// Tests for callModel's fallback chain with a fake fetch: no network, no keys used.
//   node --test shell/tests/
const test = require('node:test');
const assert = require('node:assert');

process.env.GROQ_API_KEY = 'fake';
process.env.GEMINI_API_KEY = 'fake';
process.env.OLLAMA_MODEL = ''; // tests that want the local model load their own copy
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

// ---- streaming (step 6) ----
const STREAM_SCRIPT = JSON.stringify({
  topic: 't',
  steps: [{ say: 'One.', actions: [] }, { say: 'Two.', actions: [] }, { say: 'Three.', actions: [] }],
});

/** A fake Groq SSE response that sends `text` in pieces, `gapMs` apart (optionally failing after `failAfter` pieces). */
function sse(text, { pieces = 12, gapMs = 20, failAfter = Infinity } = {}) {
  const size = Math.ceil(text.length / pieces);
  let i = 0;
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, gapMs));
        if (i >= failAfter) return controller.error(new Error('connection reset'));
        if (i * size >= text.length) {
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          return controller.close();
        }
        const delta = text.slice(i * size, ++i * size);
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}
const isStream = (init) => JSON.parse(init.body).stream === true;

test('streaming: each step reaches onStep as soon as it is written, before the answer is finished', async () => {
  global.fetch = async (_url, init) => sse(STREAM_SCRIPT, { pieces: 12, gapMs: 25 });
  const t0 = Date.now();
  const arrived = [];
  const r = await callModel({ question: 'q' }, { onStep: (step) => arrived.push([step.say, Date.now() - t0]) });
  const total = Date.now() - t0;
  assert.deepStrictEqual(arrived.map((a) => a[0]), ['One.', 'Two.', 'Three.']);
  assert.ok(arrived[0][1] < total - 100, `first step at ${arrived[0][1]}ms of ${total}ms`);
  assert.strictEqual(r.streamed, true);
  assert.strictEqual(r.script.steps.length, 3);
});

test('streaming: an answer in the wrong format falls back to whole answers (JSON mode)', async () => {
  global.fetch = async (_url, init) => (isStream(init) ? sse('Sure! Here is how Pythagoras works...') : groqReply(VALID));
  const arrived = [];
  const r = await callModel({ question: 'q' }, { onStep: (step) => arrived.push(step.say) });
  assert.deepStrictEqual(arrived, ['Hello there.']);
  assert.ok(!r.streamed);
  assert.ok(r.failures.some((f) => f.includes('wrong format')));
});

test("streaming: a clarifying question in the model's own format is asked as one step", async () => {
  global.fetch = async () => sse(JSON.stringify({ question: 'Which part confuses you?' }), { pieces: 3 });
  const arrived = [];
  await callModel({ question: 'q' }, { onStep: (step) => arrived.push(step.say) });
  assert.deepStrictEqual(arrived, ['Which part confuses you?']);
});

test('streaming: a stream cut off halfway keeps the steps it already delivered', async () => {
  global.fetch = async () => sse(STREAM_SCRIPT, { pieces: 12, failAfter: 8 });
  const arrived = [];
  const r = await callModel({ question: 'q' }, { onStep: (step) => arrived.push(step.say) });
  assert.ok(arrived.length >= 1 && arrived.length < 3, `got ${arrived.length} steps`);
  assert.strictEqual(r.script.steps.length, arrived.length);
  assert.ok(r.failures.some((f) => f.includes('cut off')));
});

test('streaming: cancelling before any step arrives stops the whole call', async () => {
  global.fetch = async (_url, init) => sse(STREAM_SCRIPT, { pieces: 12, gapMs: 200 });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(callModel({ question: 'q' }, { onStep: () => {}, signal: ctrl.signal }), (e) => e.name === 'AbortError');
});

test('streaming: with a screenshot, a briefly rate-limited qwen is waited for (only it can see the screen)', async () => {
  let qwenCalls = 0;
  global.fetch = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    if (model !== 'qwen/qwen3.8-27b') return sse(STREAM_SCRIPT); // gpt-oss: would answer blind
    if (++qwenCalls === 1) return { ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 0.5s.' } }) };
    return sse(STREAM_SCRIPT);
  };
  const shot = 'data:image/jpeg;base64,' + Buffer.from('fake').toString('base64');
  const r = await callModel({ question: 'q', screenshot: shot }, { onStep: () => {} });
  assert.strictEqual(r.model, 'qwen/qwen3.8-27b');
  assert.strictEqual(qwenCalls, 2);
});

test('the level picker reaches the model (kid gets simple words, student adds nothing)', async () => {
  const sent = [];
  global.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body).messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
    return groqReply(VALID);
  };
  await callModel({ question: 'q', level: 'kid' });
  await callModel({ question: 'q', level: 'student' });
  assert.match(sent[0], /child, about 8 to 12/);
  assert.doesNotMatch(sent[1], /Level:/);
});

test('a drawing (imageRequired) never goes to a model that cannot see images', async () => {
  const asked = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body.model || url.match(/models\/([^:]+)/)[1]);
    if (body.model === 'qwen/qwen3.8-27b') return { ok: false, status: 503, text: async () => '{"error":{"message":"busy"}}' };
    if (url.includes('gemini')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: VALID }] } }], usageMetadata: {} }) };
    return groqReply(VALID);
  };
  const shot = 'data:image/jpeg;base64,' + Buffer.from('fake').toString('base64');
  const r = await callModel({ question: 'look at my drawing', screenshot: shot }, { onStep: () => {}, imageRequired: true });
  assert.ok(!asked.includes('openai/gpt-oss-120b'), `asked: ${asked.join(', ')}`);
  assert.match(r.model, /gemini/);
});

test('screen questions ask the vision models at once: the fast one wins, the slow one is not waited for', async () => {
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.model) return { ok: false, status: 429, text: async () => '{"error":{"message":"Rate limit reached. Please try again in 30s."}}' };
    if (url.includes('gemini-3.1')) {
      await new Promise((r, j) => { const t = setTimeout(r, 5000); init.signal.addEventListener('abort', () => { clearTimeout(t); j(init.signal.reason); }); });
    }
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: VALID }] } }], usageMetadata: {} }) };
  };
  const shot = 'data:image/jpeg;base64,' + Buffer.from('fake').toString('base64');
  const t0 = Date.now();
  const r = await callModel({ question: 'answer this circuit on my screen', screenshot: shot }, { onStep: () => {}, imageRequired: true });
  assert.match(r.model, /gemini-3\.5/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
});

test('a local Ollama model (OLLAMA_MODEL) is asked first, streams its steps and gets the screenshot', async () => {
  process.env.OLLAMA_MODEL = 'qwen2.5vl:7b';
  delete require.cache[require.resolve('../llm/callModel')];
  const local = require('../llm/callModel');
  process.env.OLLAMA_MODEL = '';
  const asked = [];
  global.fetch = async (url, init) => {
    asked.push(url);
    const body = JSON.parse(init.body);
    assert.ok(url.endsWith('/api/chat'), url);
    assert.strictEqual(body.options.num_ctx, 8192);
    assert.deepStrictEqual(body.messages.at(-1).images, ['ZmFrZQ==']);
    const lines = [...STREAM_SCRIPT].reduce((a, ch, i) => (i % 15 ? ((a[a.length - 1] += ch), a) : [...a, ch]), [])
      .map((content) => JSON.stringify({ message: { content }, done: false }) + '\n');
    lines.push(JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 5 }) + '\n');
    const enc = new TextEncoder();
    return { ok: true, body: new ReadableStream({ start(c) { lines.forEach((l) => c.enqueue(enc.encode(l))); c.close(); } }) };
  };
  const got = [];
  const r = await local.callModel({ question: 'solve this', screenshot: 'data:image/jpeg;base64,ZmFrZQ==' }, { onStep: (s) => got.push(s), imageRequired: true });
  assert.strictEqual(r.model, 'qwen2.5vl:7b');
  assert.ok(got.length >= 1);
  assert.strictEqual(asked.length, 1);
});

test('a local model that is not running costs one try, then the cloud answers', async () => {
  process.env.OLLAMA_MODEL = 'qwen2.5vl:7b';
  delete require.cache[require.resolve('../llm/callModel')];
  const local = require('../llm/callModel');
  process.env.OLLAMA_MODEL = '';
  let localTries = 0;
  global.fetch = async (url, init) => {
    if (url.includes('11434')) {
      localTries++;
      throw new TypeError('fetch failed');
    }
    return sse(STREAM_SCRIPT);
  };
  const r = await local.callModel({ question: 'q' }, { onStep: () => {} });
  assert.strictEqual(localTries, 1);
  assert.match(r.model, /qwen\/qwen3|gpt-oss/);
});

test('a second Groq key (GROQ_API_KEY_2) is tried when the first one hits its daily limit', async () => {
  process.env.GROQ_API_KEY_2 = 'second';
  const keys = [];
  global.fetch = async (url, init) => {
    keys.push(init.headers.Authorization);
    if (init.headers.Authorization === 'Bearer fake') return { ok: false, status: 429, text: async () => '{"error":{"message":"Rate limit reached on tokens per day (TPD). Please try again in 3m42s."}}' };
    return sse(STREAM_SCRIPT);
  };
  try {
    const r = await callModel({ question: 'q' }, { onStep: () => {} });
    assert.strictEqual(r.model, 'qwen/qwen3.8-27b');
    assert.deepStrictEqual(keys, ['Bearer fake', 'Bearer second']);
  } finally {
    delete process.env.GROQ_API_KEY_2;
  }
});
