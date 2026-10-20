// Voice test: is Piper fast enough and does it sound OK? (no Electron needed)
//
//   node tools/tts-test.js                          # speaks a few tutor lines
//   node tools/tts-test.js "any text you like"
//   PIPER_LENGTH_SCALE=1.15 node tools/tts-test.js  # slower speech
//
// Prints load time, how long each line took to make vs how long it plays, then plays it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const piper = require('../tts/piper');

const LINES = process.argv[2]
  ? [process.argv[2]]
  : [
      "Hey! Don't worry, Pythagoras is just a handy rule for right-angled triangles.",
      'The longest side, right across from the square corner, is called the hypotenuse.',
      'So three squared is nine, four squared is sixteen, and nine plus sixteen is twenty-five.',
    ];

const PLAYER = process.platform === 'darwin' ? 'afplay' : 'paplay';

async function main() {
  const t0 = Date.now();
  await piper.start();
  console.log(`Voice loaded in ${Date.now() - t0}ms\n`);

  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'last-speech.wav');

  for (const text of LINES) {
    const { wav, durationMs, synthMs } = await piper.synth(text);
    console.log(`made in ${synthMs}ms, plays for ${(durationMs / 1000).toFixed(1)}s  "${text}"`);
    fs.writeFileSync(file, wav);
    const r = spawnSync(PLAYER, [file], { stdio: 'inherit' });
    if (r.error) console.log(`  (couldn't play: ${r.error.message}; file is ${file})`);
  }
  piper.stop();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  piper.stop();
  process.exit(1);
});
