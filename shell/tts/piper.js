// Piper text-to-speech for the main process. One long-lived Python worker per voice keeps it loaded,
// so each line costs only the synthesis time, not a ~1s model load. Voices for other languages start
// the first time they're used.
//
//   const { wav, durationMs, synthMs } = await synth('Hello there');               // the default voice
//   const { wav } = await synth('Hola', 'es_ES-davefx-medium');                      // another voice
//
// Setup (once): see "Voice" in shell/README.md (python venv + piper-tts + voices in shell/voices/).
// Env (optional): PIPER_VOICE=en_US-lessac-medium, PIPER_LENGTH_SCALE=1.1 (>1 = slower, clearer).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SHELL = path.join(__dirname, '..');
const PYTHON =
  process.platform === 'win32'
    ? path.join(SHELL, '.venv', 'Scripts', 'python.exe')
    : path.join(SHELL, '.venv', 'bin', 'python');
const DEFAULT_VOICE = process.env.PIPER_VOICE || 'en_US-lessac-medium';

const workers = new Map(); // voice -> { proc, ready, pending, nextId }

/** Starts the worker for a voice (safe to call many times). Resolves when the voice is loaded. */
function start(voice = DEFAULT_VOICE) {
  const existing = workers.get(voice);
  if (existing) return existing.ready;
  const model = path.join(SHELL, 'voices', `${voice}.onnx`);
  if (!fs.existsSync(PYTHON)) return Promise.reject(new Error(`Piper not installed (no ${PYTHON})`));
  if (!fs.existsSync(model)) return Promise.reject(new Error(`Voice missing: ${model}`));

  const args = ['-I', path.join(__dirname, 'piper_worker.py'), model];
  if (process.env.PIPER_LENGTH_SCALE) args.push(process.env.PIPER_LENGTH_SCALE);
  const w = { proc: spawn(PYTHON, args, { stdio: ['pipe', 'pipe', 'inherit'] }), pending: new Map(), nextId: 1 };
  workers.set(voice, w);

  w.ready = new Promise((resolve, reject) => {
    readline.createInterface({ input: w.proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return console.log('[piper]', line);
      }
      if (msg.ready) {
        console.log(`[piper] ${voice} ready in ${msg.loadMs}ms`);
        return resolve();
      }
      const p = w.pending.get(msg.id);
      if (!p) return;
      w.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve({ wav: Buffer.from(msg.wav, 'base64'), durationMs: msg.durationMs, synthMs: msg.synthMs });
    });
    w.proc.on('exit', (code) => {
      const err = new Error(`Piper worker for ${voice} exited (code ${code})`);
      reject(err);
      for (const p of w.pending.values()) p.reject(err);
      w.pending.clear();
      workers.delete(voice); // the next synth() restarts it
    });
  });
  return w.ready;
}

/** Text -> { wav: Buffer, durationMs, synthMs }, in the given voice (default: English). lengthScale > 1 = slower. */
async function synth(text, voice = DEFAULT_VOICE, lengthScale) {
  await start(voice);
  const w = workers.get(voice);
  const id = w.nextId++;
  return new Promise((resolve, reject) => {
    w.pending.set(id, { resolve, reject });
    w.proc.stdin.write(JSON.stringify({ id, text, ...(lengthScale && { length_scale: lengthScale }) }) + '\n');
  });
}

function stop() {
  for (const w of workers.values()) w.proc.kill();
}

module.exports = { start, synth, stop, DEFAULT_VOICE };
