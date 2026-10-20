# CLAUDE.md: instructions for Kabir's Claude Code (Person A: the pipeline)

You are helping Kabir build **AI Whiteboard Tutor** with his friend **Aarav** (Person B, uses Codex, owns the board).
**Read `SPEC.md` and `shared/contract.d.ts` before doing anything.** Kabir is casual and direct: keep answers short, recommend one option, explain what you changed in plain words, and say how to test it.

## Your lane
- You own **`/shell`**. You may read `/shared` and `/board`.
- **Do NOT edit `/board`** (Aarav's) or change `/shared` yourself. If the contract needs a change, stop and tell Kabir so he can agree it with Aarav first.

## What already exists
- `shell/main.js`, `preload.js`, `package.json`: minimal Electron overlay starter (**untested**). Global hotkey Ctrl/Cmd+Shift+Space, window docked to the right 40% of the screen, loads `../board/index.html`, screenshot via IPC.
- `shell/prompts/tutor.md`: starter system prompt for the tutor.
- `shared/`: contract, JSON schema, example script.
- `board/`: Aarav's test page (plays the example script with browser voice).

## Build order (one step at a time; commit after each working step)
1. **RISK TEST FIRST.** Write `shell/llm/callModel.js` and `shell/tools/llm-test.js`. Send a screenshot (or just text) + a question like "I don't get Pythagoras" to **Gemini Flash** using `shell/prompts/tutor.md` as the system prompt. Print: latency, whether the output is valid against `shared/script.schema.json`. Everything depends on this. Tell Kabir the results.
2. **Hotkey + overlay:** `cd shell && npm install && npm start`. Make sure the hotkey fires and the window docks. Note: the screenshot must be taken BEFORE the overlay appears, otherwise it captures itself.
3. **Mic + Whisper:** record with MediaRecorder, send audio to a small local Python server running `faster-whisper` (model "small" or "base", CUDA). Note: the browser Web Speech API is unreliable inside Electron, so don't use it.
4. **Voice:** `speak(text): Promise<void>` using the **Piper** binary through `child_process` (write a wav, play it, resolve on `ended`). Expose audio duration if possible so Aarav can match animation length.
5. **Wire it:** hotkey, then mic, then Whisper, then callModel, then script, then Aarav's `playScript(script, speak)`.
6. **Streaming:** have the model output one step per line (NDJSON) so step 1 plays within ~3 seconds.
7. **Follow-ups:** hotkey mid-explanation sends `getBoardState()` + the new question; model continues from the current board.
8. **Fallback chain in `callModel()`:** Gemini (yours), then Gemini (Aarav's key, optional), then Groq. On HTTP 429 wait briefly and retry, then fall through.

## Rules
- Keys live in `.env` only. Never print or commit them.
- Validate every model response against the schema; on invalid JSON retry once with the error message, then fall back to a plain text explanation.
- Small commits. Don't refactor things that work.
- When something is hard to test (audio, hotkeys, Windows vs Mac), say so and give Kabir exact steps to test by hand.
- Use the strongest model for planning and nasty bugs, a faster one for routine work, to save Kabir's usage limit.
