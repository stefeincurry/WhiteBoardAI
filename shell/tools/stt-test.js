// Speech-to-text test, no microphone needed: Piper says a question, Whisper writes it back down.
//
//   node tools/stt-test.js                                   # a few student-style questions
//   node tools/stt-test.js "why is the sky blue"
//   node tools/stt-test.js --file some-recording.webm        # transcribe a real recording
//
// Prints what Whisper heard and how long it took.

const fs = require('fs');
const piper = require('../tts/piper');
const { transcribe } = require('../stt/transcribe');

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');

async function main() {
  if (fileArg !== -1) {
    const file = args[fileArg + 1];
    const mime = file.endsWith('.wav') ? 'audio/wav' : file.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm';
    const { text, ms } = await transcribe(fs.readFileSync(file), mime);
    return console.log(`heard in ${ms}ms: "${text}"`);
  }

  const lines = args.length
    ? [args.join(' ')]
    : [
        "Bro I don't get Pythagoras, why is it a squared plus b squared?",
        'Wait, why do we take the square root at the end?',
        'How does binary search work on a sorted array?',
        'What does mitochondria actually do in a cell?',
      ];
  await piper.start();
  for (const said of lines) {
    const { wav } = await piper.synth(said);
    const { text, ms } = await transcribe(wav, 'audio/wav');
    const same = norm(text) === norm(said);
    console.log(`${same ? 'OK  ' : 'DIFF'} ${ms}ms\n  said:  "${said}"\n  heard: "${text}"`);
  }
  piper.stop();
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

main().catch((e) => {
  console.error('FAILED:', e.message);
  piper.stop();
  process.exit(1);
});
