# AGENTS.md: instructions for Aarav's Codex (Person B: the board)

You are helping Aarav build **AI Whiteboard Tutor** with his friend **Kabir** (Person A, uses Claude Code, owns the pipeline).
**Read `SPEC.md` and `shared/contract.d.ts` before doing anything.** Keep answers short, explain changes in plain words, and say how to test them.

## Your lane
- You own **`/board`**. You may read `/shared` and `/shell`.
- **Do NOT edit `/shell`** (Kabir's) or change `/shared` yourself. If the contract needs a change, stop and tell Aarav so he can agree it with Kabir first.

## What already exists
- `board/index.html` + `board/board.js`: a working starter. Open `index.html` in a browser, paste a script JSON (the Pythagoras example is pre-filled), press Play. It draws with plain SVG and speaks with the browser's built-in voice as a stand-in for Kabir's `speak()`.
- `shared/`: contract, JSON schema, example script.

## Build order (one step at a time; commit after each working step)
1. **Run the starter.** Open `board/index.html`, press Play, confirm the triangle draws while the voice speaks and the red hypotenuse highlight appears. Tell Aarav what works and what looks off.
2. **Hand-drawn look:** use **rough.js** for shapes and strokes, with animated drawing (stroke reveal) so it looks like a teacher drawing.
3. **Formulas:** use **KaTeX** for `write_formula` (currently shows raw LaTeX text).
4. **Sync quality:** match drawing duration to speech. If `speak()` can report audio duration (Kabir may add it), use it; otherwise keep the word-count estimate. A step finishes only when BOTH speech and drawing are done.
5. **More actions + layout:** make sure nothing overlaps (named regions `left/right/top/bottom`, auto-offset for repeated text). Add helpers per subject:
   - graphs and function plots (**JSXGraph**)
   - flows and cycles (**Mermaid**)
   - CS boxes-and-arrows: arrays, linked lists, trees, stack frames
6. **Public API Kabir will call** (export from `board.js`, also on `window.board`):
   - `playScript(script, speak)` plays all steps in order
   - `playStep(step, speak)` plays one step (resolves when speech AND drawing finish)
   - `getBoardState()` returns a JSON-serialisable snapshot of what is on the board (for follow-up questions)
   - `clearBoard()`
7. **Make it robust:** unknown action types must be skipped with a console warning, never crash the board.

## Rules
- Everything must work with `speak` swapped for a fake, so you never wait for Kabir.
- Prefer a plain browser page with CDN or npm libraries that work inside Electron. No frameworks needed.
- Small commits. Don't refactor things that work.
- If a diagram is hard to draw well, simplify it. A clean simple drawing beats a broken fancy one.
- Use the strongest model for planning and nasty bugs, a lighter one for routine work, to save Aarav's usage limit.
