// callModel(): the ONE place we talk to the AI. Swap models/providers here, nothing else changes.
//
//   const { script, raw, model, ms, attempts, errors } = await callModel({ question, screenshot, boardState, history });
//
// - question:   what the student said (text)
// - screenshot: optional image as a data URL ("data:image/jpeg;base64,...") or a PNG Buffer
// - boardState: optional getBoardState() snapshot, for follow-ups (the answer continues on that board)
// - history:    optional text: the conversation so far (earlier questions, what was said, where it was cut off)
//
// Returns script = a valid Script (shared/contract.d.ts), or null if the model failed twice.
// Valid scripts go through tidyScript() (llm/tidy.js): labels pushed off lines, long notes split.
//
// Streaming (CLAUDE.md step 6): callModel(input, { onStep, signal }) hands each step to onStep as soon as
// it is complete (checked and tidied), so the board can start while the AI is still writing.
// signal (an AbortSignal) cancels the call, e.g. when the student interrupts.
// Fallback chain: every GROQ_MODEL, then every GEMINI_MODEL (comma lists; providers without a key are skipped).
// On 429/5xx we retry once, then try the next model.
// TODO (CLAUDE.md step 8): optional Gemini with Aarav's key after ours.

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { tidyScript, createTidier } = require('./tidy');
const { createStepParser } = require('./stream');
const { occupied, emptyAreas, describeArea, DRAW_AREA } = require('./space');

const ROOT = path.join(__dirname, '..', '..');
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
// Tried in order. Pinned so both laptops match. Risk test: 3.1-flash-lite 3.9s, 3.5-flash-lite 37s,
// 3.8-flash 98s, and all of them returned 503 at some point under load.
const DEFAULT_GEMINI_MODELS = 'gemini-3.1-flash-lite,gemini-3.5-flash-lite'; // 3.8-flash took 98s: never in time
const DEFAULT_GROQ_MODELS = 'qwen/qwen3.8-27b,openai/gpt-oss-120b';
const GROQ_VISION = new Set(['qwen/qwen3.8-27b']); // gpt-oss is text-only: it gets told about the screenshot instead
// Groq's free tier caps qwen at 1000 OUTPUT tokens per minute, and refuses a request outright ("Request too
// large") if it might need more. Without max_tokens it assumes 2048, so every qwen call failed.
const GROQ_MAX_TOKENS = { 'qwen/qwen3.8-27b': 950 };
// Models that stream. Without JSON mode: Groq holds a JSON-mode stream back until the whole answer is
// checked, which makes streaming pointless. Each step is checked against the schema as it arrives instead.
const STREAM_MODELS = new Set(['qwen/qwen3.8-27b', 'openai/gpt-oss-120b']);
// How long to wait for a stream's FIRST step before trying the next model. qwen's first step normally
// lands in under 1s, so 3s of silence means it's stuck; gpt-oss thinks first (1.5-4s).
const FIRST_STEP_MS = { 'qwen/qwen3.8-27b': 3000, 'openai/gpt-oss-120b': 6000 };
const RETRYABLE = new Set([429, 500, 503]);
const TIMEOUT_MS = 8000; // per model: qwen ~3s, gpt-oss ~5s, flash-lite ~4s. Slower = stuck, try the next one
const DEADLINE_MS = 20000; // the whole call, every model and the retry included: after this, say sorry

require('../env'); // keys from the repo-root .env

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'tutor.md'), 'utf8');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'script.schema.json'), 'utf8'));
const validateSchema = new Ajv({ allErrors: true }).compile(schema);

/** Returns [] if valid, else a list of human-readable problems. */
function validateScript(obj) {
  if (validateSchema(obj)) return [];
  return validateSchema.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`);
}

/** Strip ```json fences and parse. Throws on bad JSON. */
function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function imagePart(screenshot) {
  if (!screenshot) return null;
  if (Buffer.isBuffer(screenshot)) {
    return { inlineData: { mimeType: 'image/png', data: screenshot.toString('base64') } };
  }
  const m = /^data:(image\/\w+);base64,(.*)$/s.exec(screenshot);
  if (!m) throw new Error('screenshot must be a Buffer or a base64 data URL');
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

function buildUserParts({ question, screenshot, boardState, history }) {
  const parts = [];
  const img = imagePart(screenshot);
  if (img) parts.push(img);
  if (history) parts.push({ text: `Conversation so far:\n${history}` });
  if (boardState && boardState.length) {
    const free = emptyAreas(occupied(boardState), 2, DRAW_AREA);
    const space = free.length
      ? `Empty space for new drawings: ${free.map(describeArea).join('; ')}. New notes stack on the right by themselves.`
      : 'The drawing side is full: build on the shapes that are there, or erase one ({"type":"erase","target":"id"}) before drawing something new.';
    parts.push({
      text:
        'Current board state: already drawn, one item per line, positions as they actually landed. ' +
        `Continue from it; reuse these ids:\n${compactBoardState(boardState)}\n${space}`,
    });
  }
  parts.push({ text: `Student says: ${question}` });
  return parts;
}

/** Board state for the prompt: one item per line, whole-number coordinates, big SVGs reduced to a note. */
function compactBoardState(state) {
  return state
    .map((item) => {
      const it = JSON.parse(JSON.stringify(item, (k, v) => (typeof v === 'number' ? Math.round(v) : v)));
      if (typeof it.svg === 'string') it.svg = `(an SVG diagram, ${it.svg.length} characters)`;
      return JSON.stringify(it);
    })
    .join('\n');
}

async function geminiGenerate(contents, { model, apiKey, thinking, timeoutMs, signal }) {
  const generationConfig = { responseMimeType: 'application/json' };
  // Gemini 3.x thinks at "medium" by default, which costs seconds. GEMINI_THINKING=low trades depth for speed.
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking };
  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig,
    }),
    signal: withTimeout(timeoutMs, signal),
  });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error(`Gemini returned no text: ${JSON.stringify(data).slice(0, 500)}`);
  const u = data.usageMetadata || {};
  return { text, usage: { in: u.promptTokenCount, out: u.candidatesTokenCount, thinking: u.thoughtsTokenCount || 0 } };
}

/** Converts our Gemini-style history to OpenAI-style messages (Groq speaks the OpenAI API). */
function toOpenAiMessages(contents, vision) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const { role, parts } of contents) {
    const texts = parts.filter((p) => p.text).map((p) => p.text);
    const img = parts.find((p) => p.inlineData)?.inlineData;
    if (role === 'model') {
      messages.push({ role: 'assistant', content: texts.join('\n\n') });
    } else if (img && vision) {
      const url = `data:${img.mimeType};base64,${img.data}`;
      messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url } }, ...texts.map((text) => ({ type: 'text', text }))] });
    } else {
      if (img) texts.unshift('(The student shared a screenshot, but you cannot see it. Go by their words.)');
      messages.push({ role: 'user', content: texts.join('\n\n') });
    }
  }
  return messages;
}

async function groqGenerate(contents, { model, apiKey, timeoutMs, signal }) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: toOpenAiMessages(contents, GROQ_VISION.has(model)),
      response_format: { type: 'json_object' },
      ...(GROQ_MAX_TOKENS[model] && { max_tokens: GROQ_MAX_TOKENS[model] }),
    }),
    signal: withTimeout(timeoutMs, signal),
  });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`Groq returned no text: ${JSON.stringify(data).slice(0, 500)}`);
  const u = data.usage || {};
  return { text, usage: { in: u.prompt_tokens, out: u.completion_tokens, thinking: u.completion_tokens_details?.reasoning_tokens || 0 } };
}

const GENERATE = { gemini: geminiGenerate, groq: groqGenerate };

/** A fetch signal that fires after ms, or when `signal` (the caller's cancel) fires. */
const withTimeout = (ms, signal) => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms));

/** Streams a Groq answer (server-sent events), calling onText(chunk) as the text arrives. */
async function groqStream(contents, { model, apiKey, signal }, onText) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: toOpenAiMessages(contents, GROQ_VISION.has(model)),
      stream: true,
      ...(GROQ_MAX_TOKENS[model] && { max_tokens: GROQ_MAX_TOKENS[model] }),
    }),
    signal,
  });
  if (!res.ok) throw await httpError(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage;
  for (;;) {
    const { done, value } = await reader.read();
    if (signal && signal.aborted) {
      reader.cancel().catch(() => {});
      throw signal.reason || cancelled();
    }
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) {
        const err = new Error(`stream error: ${event.error.message || JSON.stringify(event.error)}`);
        err.status = event.error.status_code;
        throw err;
      }
      const text = event.choices?.[0]?.delta?.content;
      if (text) onText(text);
      const u = event.x_groq?.usage || event.usage;
      if (u) usage = { in: u.prompt_tokens, out: u.completion_tokens, thinking: u.completion_tokens_details?.reasoning_tokens || 0 };
    }
  }
  return { usage };
}

/** Builds an Error with the provider's message (both APIs send {"error":{"message"}}). */
async function httpError(res) {
  const body = await res.text();
  let msg = body.slice(0, 300);
  try {
    msg = JSON.parse(body).error.message;
  } catch {}
  const err = new Error(`HTTP ${res.status}: ${msg}`);
  err.status = res.status;
  return err;
}

/** The ordered list of {provider, model, apiKey} to try. Providers without a key in .env are skipped. */
function buildChain(providers) {
  const list = (v, fallback) => (v || fallback).split(',').map((m) => m.trim()).filter(Boolean);
  const chain = [];
  const add = (provider, apiKey, models) => {
    if (!apiKey || (providers && !providers.includes(provider))) return;
    for (const model of models) chain.push({ provider, model, apiKey });
  };
  // Groq first: answered every risk-test call in ~3s, while Gemini gave 503s/timeouts (54s before Groq got a turn).
  add('groq', process.env.GROQ_API_KEY, list(process.env.GROQ_MODEL, DEFAULT_GROQ_MODELS));
  add('gemini', process.env.GEMINI_API_KEY, list(process.env.GEMINI_MODEL, DEFAULT_GEMINI_MODELS));
  return chain;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tries each model in order. Busy (429/5xx): wait 1s, retry once. Timeout or other error: next model.
 * Stops at `deadline` (a Date.now() time): each attempt only gets the time that's left.
 */
async function generateWithFallback(contents, chain, thinking, failures, deadline, deadlineMs, signal) {
  let lastStatus;
  for (const { provider, model, apiKey } of chain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 1500) {
        failures.push(`out of time (${deadlineMs / 1000}s) before ${model}`);
        return outOfModels(failures, lastStatus);
      }
      const timeoutMs = Math.min(TIMEOUT_MS, left);
      try {
        return { ...(await GENERATE[provider](contents, { model, apiKey, thinking, timeoutMs, signal })), model };
      } catch (e) {
        if (signal && signal.aborted) throw cancelled();
        const timedOut = e.name === 'TimeoutError';
        lastStatus = e.status;
        failures.push(`${model}: ${timedOut ? `no answer in ${(timeoutMs / 1000).toFixed(1)}s` : e.message}`);
        if (timedOut || !worthRetrying(e) || attempt === 2) break;
        await sleep(1000);
      }
    }
  }
  return outOfModels(failures, lastStatus);
}

/** Busy (429/5xx) or Groq's one-off "Failed to generate JSON" 400: retry the same model once, after 1s. */
function worthRetrying(e) {
  const badJson = e.status === 400 && /Failed to generate JSON/.test(e.message);
  // "try again in 15.8s" (Groq's per-minute limits): a 1s retry is pointless, go to the next model.
  const waitS = Number((/try again in ([\d.]+)s/i.exec(e.message) || [])[1] || 0);
  return (RETRYABLE.has(e.status) || badJson) && waitS <= 2;
}

function cancelled() {
  const err = new Error('cancelled');
  err.name = 'AbortError';
  return err;
}

function outOfModels(failures, status) {
  const err = new Error(`All models failed:\n  ${failures.join('\n  ')}`);
  err.status = status;
  throw err;
}

/** opts.providers: e.g. ['groq'] to skip Gemini (testing). opts.thinking: Gemini thinking level. opts.deadlineMs: overall limit. */
async function callModel(input, opts = {}) {
  if (opts.onStep) return callModelStreaming(input, opts);
  const chain = buildChain(opts.providers);
  const thinking = opts.thinking || process.env.GEMINI_THINKING;
  if (!chain.length) throw new Error('No API keys: put GEMINI_API_KEY and/or GROQ_API_KEY in the repo-root .env');

  const contents = [{ role: 'user', parts: buildUserParts(input) }];
  const t0 = Date.now();
  const deadlineMs = opts.deadlineMs || DEADLINE_MS;
  const deadline = t0 + deadlineMs;
  let raw = '';
  let errors = [];
  let usage;
  let model;
  const failures = []; // models that were busy/timed out before one answered

  // Try once; if the JSON is broken or off-schema, retry once with the error message.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      ({ text: raw, usage, model } = await generateWithFallback(contents, chain, thinking, failures, deadline, deadlineMs, opts.signal));
    } catch (e) {
      if (attempt === 1) throw e;
      break; // the retry found no model in time: keep the first reply (the tutor speaks its lines without drawings)
    }
    let parsed;
    try {
      parsed = parseJson(raw);
      errors = validateScript(parsed);
    } catch (e) {
      errors = [`Invalid JSON: ${e.message}`];
    }
    if (!errors.length) {
      let tidied;
      try {
        tidied = tidyScript(parsed, { existing: input.boardState });
      } catch (e) {
        // a tidy bug must never count against the model's (valid) answer
        console.warn('[tidy] skipped:', e.message);
        tidied = { script: parsed, fixes: [] };
      }
      return { script: tidied.script, raw, model, thinking, ms: Date.now() - t0, attempts: attempt, usage, errors, failures, fixes: tidied.fixes };
    }
    contents.push({ role: 'model', parts: [{ text: raw }] });
    contents.push({
      role: 'user',
      parts: [{ text: `Your output was not valid. Problems:\n${errors.join('\n')}\nReturn ONLY the corrected JSON object.` }],
    });
  }
  return { script: null, raw, model, thinking, ms: Date.now() - t0, attempts: 2, usage, errors, failures, fixes: [] };
}

/**
 * Streaming: each step goes to opts.onStep(step, index) as soon as it is complete, checked against the
 * schema and tidied. Only STREAM_MODELS stream; if none of them gets a single step out (busy, wrong
 * format), the normal chain (whole answers, JSON mode) runs with the time that's left and its steps go
 * to onStep afterwards. A stream cut off halfway keeps the steps it already delivered.
 */
async function callModelStreaming(input, opts) {
  const t0 = Date.now();
  const deadlineMs = opts.deadlineMs || DEADLINE_MS;
  const deadline = t0 + deadlineMs;
  const chain = buildChain(opts.providers).filter((c) => c.provider === 'groq' && STREAM_MODELS.has(c.model));
  const contents = [{ role: 'user', parts: buildUserParts(input) }];
  const failures = [];

  models: for (const { model, apiKey } of chain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (opts.signal && opts.signal.aborted) throw cancelled();
      const left = deadline - Date.now();
      if (left < 1500) break models;
      const tidier = createTidier({ existing: input.boardState });
      const parser = createStepParser();
      const steps = [];
      const fixes = [];
      // TIMEOUT_MS now means "no first step in time"; after that the stream may run to the deadline.
      const firstStep = new AbortController();
      const firstStepMs = Math.min(FIRST_STEP_MS[model] || TIMEOUT_MS, left);
      const timer = setTimeout(() => firstStep.abort(new DOMException('no first step', 'TimeoutError')), firstStepMs);
      const signal = AbortSignal.any([firstStep.signal, AbortSignal.timeout(left), opts.signal].filter(Boolean));
      const take = (raw) => {
        if (opts.signal && opts.signal.aborted) return; // cancelled: no more steps for the board
        const errs = validateScript({ topic: 't', steps: [raw] });
        if (errs.length) return void fixes.push(`an invalid step was skipped (${errs[0]})`);
        const r = tidier.step(raw);
        fixes.push(...r.fixes);
        clearTimeout(timer);
        steps.push(r.step);
        opts.onStep(r.step, steps.length - 1);
      };
      let usage, error = null;
      try {
        ({ usage } = await groqStream(contents, { model, apiKey, signal }, (chunk) => parser.push(chunk).forEach(take)));
      } catch (e) {
        error = e;
      } finally {
        clearTimeout(timer);
      }
      // qwen sometimes answers a clarifying question in its own shape ({"question": "..."}): ask it anyway.
      if (!steps.length && !error) {
        const asked = rescueQuestion(parser.text);
        if (asked) {
          fixes.push(`answered in its own format; asking its question as one step`);
          take(asked);
        }
      }
      if (steps.length) {
        if (error && !(opts.signal && opts.signal.aborted)) failures.push(`${model}: stream cut off after ${steps.length} steps (${error.message})`);
        const script = { topic: parser.topic || '', steps };
        return { script, raw: parser.text, model, ms: Date.now() - t0, attempts: attempt, usage, errors: [], failures, fixes, streamed: true };
      }
      if (opts.signal && opts.signal.aborted) throw cancelled();
      const timedOut = error && error.name === 'TimeoutError';
      const why = !error ? 'answered in the wrong format' : timedOut ? `no step in ${(firstStepMs / 1000).toFixed(1)}s` : error.message;
      failures.push(`${model} (streaming): ${why}`);
      // Only qwen can see the screenshot: if it's just rate-limited for a few seconds, wait for it rather
      // than letting a model that can't see the screen ask the student to type the question out.
      const waitS = Number((/try again in ([\d.]+)s/i.exec((error && error.message) || '') || [])[1] || 0);
      const seesScreen = input.screenshot && GROQ_VISION.has(model);
      if (seesScreen && error && error.status === 429 && waitS > 0 && waitS <= 10 && attempt === 1 && deadline - Date.now() > waitS * 1000 + 4000) {
        failures.push(`${model}: waited ${waitS.toFixed(1)}s for it (the only model that can see the screen)`);
        await sleep(waitS * 1000 + 300);
        continue;
      }
      if (!error || timedOut || !worthRetrying(error) || attempt === 2) break;
      await sleep(1000);
    }
  }

  // No stream gave a single step: whole answers (JSON mode keeps the format right) with the time left.
  const left = deadline - Date.now();
  if (left < 1500) outOfModels([...failures, `out of time (${deadlineMs / 1000}s)`]);
  let r;
  try {
    r = await callModel(input, { ...opts, onStep: undefined, deadlineMs: left });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    outOfModels([...failures, ...e.message.split('\n').slice(1).map((l) => l.trim())], e.status);
  }
  r.failures = [...failures, ...r.failures];
  r.ms = Date.now() - t0;
  if (r.script) r.script.steps.forEach((step, i) => opts.onStep(step, i));
  return r;
}

/** {"question": "Which part?"} (no steps) -> one step that asks it, or null. */
function rescueQuestion(text) {
  let obj;
  try {
    obj = parseJson(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj.steps)) return null;
  const say = ['say', 'question', 'answer', 'message', 'text'].map((k) => obj[k]).find((v) => typeof v === 'string' && v.trim());
  return say ? { say: say.trim(), actions: [] } : null;
}

/** Lists Gemini models this key can call generateContent on (for picking GEMINI_MODEL). */
async function listGeminiModels(apiKey = process.env.GEMINI_API_KEY) {
  const res = await fetch(`${GEMINI_BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) throw new Error(`List models HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const { models = [] } = await res.json();
  return models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}

module.exports = { callModel, validateScript, listGeminiModels };
