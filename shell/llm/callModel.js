// callModel(): the ONE place we talk to the AI. Swap models/providers here, nothing else changes.
//
//   const { script, raw, model, ms, attempts, errors } = await callModel({ question, screenshot, boardState });
//
// - question:   what the student said (text)
// - screenshot: optional PNG as a data URL ("data:image/png;base64,...") or a Buffer
// - boardState: optional getBoardState() snapshot, for follow-ups
//
// Returns script = a valid Script (shared/contract.d.ts), or null if the model failed twice.
// Model fallback: GEMINI_MODEL can be a comma list; on 429/5xx we retry once, then try the next model.
// TODO (CLAUDE.md step 8): add Gemini (Aarav's key) -> Groq after the Gemini models.

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const ROOT = path.join(__dirname, '..', '..');
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Tried in order. Pinned so both laptops match. Risk test: 3.1-flash-lite 3.9s, 3.5-flash-lite 37s,
// 3.8-flash 98s, and all of them returned 503 at some point under load.
const DEFAULT_MODELS = 'gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-3.8-flash';
const RETRYABLE = new Set([429, 500, 503]);
const TIMEOUT_MS = 20000; // a 98s answer is useless mid-demo; give up and try the next model

// Keys live in the repo-root .env (see README). Real env vars win over the file.
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
loadEnv();

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

function buildUserParts({ question, screenshot, boardState }) {
  const parts = [];
  const img = imagePart(screenshot);
  if (img) parts.push(img);
  if (boardState) {
    parts.push({ text: `Current board state (already drawn, continue from here):\n${JSON.stringify(boardState)}` });
  }
  parts.push({ text: `Student says: ${question}` });
  return parts;
}

async function geminiGenerate(contents, { model, apiKey, thinking }) {
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300);
    try {
      msg = JSON.parse(body).error.message;
    } catch {}
    const err = new Error(`HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error(`Gemini returned no text: ${JSON.stringify(data).slice(0, 500)}`);
  return { text, usage: data.usageMetadata };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tries each model in order. Busy (429/5xx): wait 1s, retry once. Timeout or other error: next model. */
async function generateWithFallback(contents, { models, apiKey, thinking }, failures) {
  let lastStatus;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return { ...(await geminiGenerate(contents, { model, apiKey, thinking })), model };
      } catch (e) {
        const timedOut = e.name === 'TimeoutError';
        lastStatus = e.status;
        failures.push(`${model}: ${timedOut ? `no answer in ${TIMEOUT_MS / 1000}s` : e.message}`);
        if (timedOut || !RETRYABLE.has(e.status) || attempt === 2) break;
        await sleep(1000);
      }
    }
  }
  const err = new Error(`All models failed:\n  ${failures.join('\n  ')}`);
  err.status = lastStatus;
  throw err;
}

async function callModel(input, opts = {}) {
  const models = (opts.model || process.env.GEMINI_MODEL || DEFAULT_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  const thinking = opts.thinking || process.env.GEMINI_THINKING;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing (put it in the repo-root .env)');

  const contents = [{ role: 'user', parts: buildUserParts(input) }];
  const t0 = Date.now();
  let raw = '';
  let errors = [];
  let usage;
  let model;
  const failures = []; // models that were busy/timed out before one answered

  // Try once; if the JSON is broken or off-schema, retry once with the error message.
  for (let attempt = 1; attempt <= 2; attempt++) {
    ({ text: raw, usage, model } = await generateWithFallback(contents, { models, apiKey, thinking }, failures));
    try {
      const script = parseJson(raw);
      errors = validateScript(script);
      if (!errors.length) return { script, raw, model, thinking, ms: Date.now() - t0, attempts: attempt, usage, errors, failures };
    } catch (e) {
      errors = [`Invalid JSON: ${e.message}`];
    }
    contents.push({ role: 'model', parts: [{ text: raw }] });
    contents.push({
      role: 'user',
      parts: [{ text: `Your output was not valid. Problems:\n${errors.join('\n')}\nReturn ONLY the corrected JSON object.` }],
    });
  }
  return { script: null, raw, model, thinking, ms: Date.now() - t0, attempts: 2, usage, errors, failures };
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
