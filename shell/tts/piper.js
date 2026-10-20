// Piper text-to-speech for the main process. One long-lived Python worker keeps the voice loaded,
// so each line costs only the synthesis time, not a ~1s model load.
//
//   const { wav, durationMs, synthMs } = await synth('Hello there');   // wav = Buffer (a .wav file)
//
// Setup (once): see "Voice" in shell/README.md (python venv + piper-tts + a voice in shell/voices/).
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

let worker = null;
let ready = null; // Promise that resolves once the voice is loaded
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject }

/** Starts the worker (safe to call many times). Resolves when the voice is loaded. */
function start() {
  if (ready) return ready;
  const voice = process.env.PIPER_VOICE || 'en_US-lessac-medium';
  const model = path.join(SHELL, 'voices', `${voice}.onnx`);
  if (!fs.existsSync(PYTHON)) return Promise.reject(new Error(`Piper not installed (no ${PYTHON})`));
  if (!fs.existsSync(model)) return Promise.reject(new Error(`Voice missing: ${model}`));

  const args = ['-I', path.join(__dirname, 'piper_worker.py'), model];
  if (process.env.PIPER_LENGTH_SCALE) args.push(process.env.PIPER_LENGTH_SCALE);
  worker = spawn(PYTHON, args, { stdio: ['pipe', 'pipe', 'inherit'] });

  ready = new Promise((resolve, reject) => {
    readline.createInterface({ input: worker.stdout }).on('line', (line) => {
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
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve({ wav: Buffer.from(msg.wav, 'base64'), durationMs: msg.durationMs, synthMs: msg.synthMs });
    });
    worker.on('exit', (code) => {
      const err = new Error(`Piper worker exited (code ${code})`);
      reject(err);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      worker = null;
      ready = null; // next synth() restarts it
    });
  });
  return ready;
}

/** Text -> { wav: Buffer, durationMs, synthMs }. */
async function synth(text) {
  await start();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.stdin.write(JSON.stringify({ id, text }) + '\n');
  });
}

function stop() {
  if (worker) worker.kill();
}

module.exports = { start, synth, stop };
