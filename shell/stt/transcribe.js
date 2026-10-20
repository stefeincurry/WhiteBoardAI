// Speech to text, the ONE place we turn the student's voice into words.
//
//   const { text, ms } = await transcribe(audioBuffer, 'audio/webm');
//
// Uses Groq's hosted Whisper for now: fast, free tier, works on a laptop with no NVIDIA GPU.
// TODO: STT_PROVIDER=local -> faster-whisper server on the RTX 4070 machine (CLAUDE.md step 3).
// Env (optional): STT_MODEL=whisper-large-v3-turbo, STT_LANGUAGE=en

require('../env');

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
// Steers Whisper towards school-subject words (it's a hint, not a script).
const PROMPT = 'A student asks a tutor about maths, physics, chemistry, biology or computer science.';

async function transcribe(audio, mimeType = 'audio/webm') {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY missing (repo-root .env)');
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') ? 'ogg' : 'webm';

  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), `speech.${ext}`);
  form.append('model', process.env.STT_MODEL || 'whisper-large-v3-turbo');
  form.append('language', process.env.STT_LANGUAGE || 'en');
  form.append('prompt', PROMPT);
  form.append('temperature', '0');
  form.append('response_format', 'json');

  const t0 = Date.now();
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300);
    try {
      msg = JSON.parse(body).error.message;
    } catch {}
    throw new Error(`Whisper HTTP ${res.status}: ${msg}`);
  }
  const { text = '' } = await res.json();
  return { text: text.trim(), ms: Date.now() - t0 };
}

module.exports = { transcribe };
