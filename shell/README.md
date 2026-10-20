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
npm start                                              # Ctrl/Cmd+Shift+Space opens, Esc hides, Ctrl+C quits
npm start -- --play tools/out/qwen_qwen3.8-27b.json   # on hotkey, plays a saved script with the real voice
node tools/llm-test.js                                 # AI risk test (latency + schema check)
node tools/tts-test.js "any text"                      # voice test
```

## What the page gets (`window.shell`)
- `speak(text)`: contract `Speak`, resolves when the audio ends (never rejects)
- `prepareSpeech(text)` → `{ durationMs, play() }`: extra, so the board can know the length before drawing
- `stopSpeech()`: cuts the current line (for interruptions)
- `onHotkey(cb)`, `captureScreen()`, `hide()`
