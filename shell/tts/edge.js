// Microsoft neural voices through edge-tts (free, needs internet), for Hinglish and Hindi, where Piper's
// voices sound robotic. Same shape as piper.synth, but the audio is MP3. If this fails, main uses Piper.
//
//   const { wav, durationMs } = await synth('Arre bhai, tension mat lo!', 'en-IN-NeerjaNeural');
//
// Setup (once): .venv/bin/pip install edge-tts

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SHELL = path.join(__dirname, '..');
const PYTHON =
  process.platform === 'win32' ? path.join(SHELL, '.venv', 'Scripts', 'python.exe') : path.join(SHELL, '.venv', 'bin', 'python');
const TIMEOUT_MS = 8000; // no audio by then (slow or no internet): Piper says it instead

let worker = null; // { proc, ready, pending, nextId }

function start() {
  if (worker) return worker.ready;
  if (!fs.existsSync(PYTHON)) return Promise.reject(new Error(`no ${PYTHON}`));
  const w = { proc: spawn(PYTHON, ['-I', path.join(__dirname, 'edge_worker.py')], { stdio: ['pipe', 'pipe', 'inherit'] }), pending: new Map(), nextId: 1 };
  worker = w;
  w.ready = new Promise((resolve, reject) => {
    readline.createInterface({ input: w.proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return console.log('[edge-tts]', line);
      }
      if (msg.ready) return resolve();
      const p = w.pending.get(msg.id);
      if (!p) return;
      w.pending.delete(msg.id);
      if (msg.error) return p.reject(new Error(msg.error));
      const mp3 = Buffer.from(msg.mp3, 'base64');
      // edge-tts sends 48 kbit/s MP3 at a constant rate, so its length gives the duration
      p.resolve({ wav: mp3, durationMs: Math.round((mp3.length * 8) / 48), synthMs: msg.synthMs });
    });
    w.proc.on('exit', (code) => {
      const err = new Error(`edge-tts worker exited (code ${code})`);
      reject(err);
      for (const p of w.pending.values()) p.reject(err);
      if (worker === w) worker = null; // the next synth() restarts it
    });
  });
  return w.ready;
}

/** Text -> { wav: MP3 Buffer, durationMs, synthMs }. lengthScale > 1 = slower (Piper's units). */
async function synth(text, voice, lengthScale) {
  await start();
  const w = worker;
  const id = w.nextId++;
  const rate = `${lengthScale ? Math.round((1 / lengthScale - 1) * 100) : 0}%`.replace(/^(\d)/, '+$1');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      w.pending.delete(id);
      reject(new Error(`no audio in ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    w.pending.set(id, {
      resolve: (r) => (clearTimeout(timer), resolve(r)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    w.proc.stdin.write(JSON.stringify({ id, text, voice, rate }) + '\n');
  });
}

function stop() {
  if (worker) worker.proc.kill();
}

module.exports = { start, synth, stop };
