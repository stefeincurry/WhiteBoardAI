// callModel(): the ONE place we talk to the AI. Swap models/providers here, nothing else changes.
//
//   const { script, raw, model, ms, attempts, errors } = await callModel({ question, screenshot, boardState });
//
// - question:   what the student said (text)
// - screenshot: optional PNG as a data URL ("data:image/png;base64,...") or a Buffer
// - boardState: optional getBoardState() snapshot, for follow-ups
//
// Returns script = a valid Script (shared/contract.d.ts), or null if the model failed twice.
// TODO (CLAUDE.md step 8): fallback chain Gemini -> Gemini (Aarav) -> Groq, 429 retry.

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const ROOT = path.join(__dirname, '..', '..');
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite'; // pinned so both laptops match. Only model under 5s in the risk test (3.8-flash: 98s / 503s under load)

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
  });
  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error(`Gemini returned no text: ${JSON.stringify(data).slice(0, 500)}`);
  return { text, usage: data.usageMetadata };
}

async function callModel(input, opts = {}) {
  const model = opts.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  const thinking = opts.thinking || process.env.GEMINI_THINKING;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing (put it in the repo-root .env)');

  const contents = [{ role: 'user', parts: buildUserParts(input) }];
  const t0 = Date.now();
  let raw = '';
  let errors = [];
  let usage;

  // Try once; if the JSON is broken or off-schema, retry once with the error message.
  for (let attempt = 1; attempt <= 2; attempt++) {
    ({ text: raw, usage } = await geminiGenerate(contents, { model, apiKey, thinking }));
    try {
      const script = parseJson(raw);
      errors = validateScript(script);
      if (!errors.length) return { script, raw, model, thinking, ms: Date.now() - t0, attempts: attempt, usage, errors };
    } catch (e) {
      errors = [`Invalid JSON: ${e.message}`];
    }
    contents.push({ role: 'model', parts: [{ text: raw }] });
    contents.push({
      role: 'user',
      parts: [{ text: `Your output was not valid. Problems:\n${errors.join('\n')}\nReturn ONLY the corrected JSON object.` }],
    });
  }
  return { script: null, raw, model, thinking, ms: Date.now() - t0, attempts: 2, usage, errors };
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
