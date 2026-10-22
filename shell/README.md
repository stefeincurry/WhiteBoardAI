# shell (Kabir): Electron overlay + AI + voice

## Setup (once per machine)
```bash
cd shell
npm install
npx electron --version   # if this says "failed to install correctly", see "Electron" below
```
Keys go in the repo-root `.env` (never committed):
```
GROQ_API_KEY=...      # console.groq.com (tried first)
GEMINI_API_KEY=...    # aistudio.google.com (backup)
```

### Voice (Piper)
```bash
cd shell
python3 -m venv .venv
.venv/bin/pip install piper-tts==1.8.0          # Windows: .venv\Scripts\pip
mkdir -p voices
B=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium
curl -L -o voices/en_US-lessac-medium.onnx      $B/en_US-lessac-medium.onnx
curl -L -o voices/en_US-lessac-medium.onnx.json $B/en_US-lessac-medium.onnx.json
node tools/tts-test.js                           # should speak 3 lines
```
Optional in `.env`: `PIPER_VOICE=en_US-lessac-medium`, `PIPER_LENGTH_SCALE=1.1` (>1 = slower).

### Electron
On very new Node (26+), Electron's installer can exit "successfully" without unpacking. Fix:
```bash
cd shell/node_modules/electron && rm -rf dist && unzip -q ~/.cache/electron/*/electron-v*-linux-x64.zip -d dist && printf electron > path.txt
```

## Run
```bash
npm start            # Ctrl/Cmd+Shift+Space: screenshot, overlay opens, beep = talk. Stop talking -> it answers.
```
- Hotkey while it's listening: stop listening now. While it's thinking or talking: cut it off and ask a follow-up.
- Follow-ups continue on the same board (the AI gets the board and what was said so far). The first question
  after opening starts on a clean board.
- Esc (overlay focused): close and stop everything. Ctrl+C in the terminal quits.
- The terminal logs every stage with timings: `[heard]`, `[ai]`, `[step 1/8] (2.7s after the question)`.

Testing tools:
```bash
npm start -- --play tools/out/qwen_qwen3.8-27b.json   # on hotkey, play a saved script instead of asking
node tools/llm-test.js                                 # AI: latency + schema check (+ --image shot.jpg, --provider groq, --stream)
node tools/tts-test.js "any text"                      # voice
node tools/stt-test.js                                 # Whisper, with Piper as the speaker (no mic needed)
npx electron tools/board-snapshot.js tools/out/last-script.json   # draw a script on the real board -> PNG
npx electron tools/followup-test.js --wait             # real question + follow-up on the real board -> 2 PNGs
node --test tests/                                     # tutor state machine, fallback chain, layout clean-up
```
Fake mic (no talking needed): add `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=question.wav` to `npx electron . --fire-hotkey`.

## How a question flows
`main.js` (hotkey, screenshot, overlay) -> `preload.js` (mic until 1.2s of quiet) -> `stt/transcribe.js` (Groq Whisper)
-> `tutor.js` (state machine, filler line, conversation) -> `llm/callModel.js` (streams Groq qwen -> gpt-oss; whole
answers from Groq/Gemini as fallback; 8s to the first step per model, 20s total) -> `llm/stream.js` (steps out of the
stream as they close) -> `llm/tidy.js` (layout clean-up per step; `space.js` free space, `fit.js` no board wipes)
-> board `playStep` one step at a time, with `speak()` (Piper; each line's audio made as soon as its step arrives).
First step ~1.7s after you stop talking.



## What the page gets (`window.shell`)
- `speak(text)`: contract `Speak`, resolves when the audio ends (never rejects)
- `prepareSpeech(text)` → `{ durationMs, play() }`: extra, so the board can know the length before drawing
- `stopSpeech()`: cuts the current line (for interruptions)
- `onHotkey(cb)`, `captureScreen()`, `hide()`
