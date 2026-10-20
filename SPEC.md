# AI Whiteboard Tutor (working title)

## What are we building? (simple version)
You're watching a video or reading something on your PC and you get stuck.
You press a hotkey and say: "bro I don't get this."
A small whiteboard opens next to your screen. The AI **talks and draws at the same time**, like a teacher at a board.
You can interrupt anytime ("wait, why is that squared?") and it continues from what's already on the board.

Works for maths, physics, chem, bio and CS.

## The demo we MUST get working
1. Open a YouTube video or a webpage.
2. Press the hotkey, speak the doubt.
3. The whiteboard opens beside it.
4. AI explains step by step. Voice and drawing start together.
5. Press the hotkey in the middle, ask a follow-up, it carries on.

If we only get this one thing perfect, that's enough. Many topics is a bonus.

## How it works (the flow)
```
Hotkey pressed
  -> take screenshot + start mic
  -> speech turns into text (Whisper, runs on our laptop GPU)
  -> send text + screenshot to the AI (cloud, free tier)
  -> AI sends back a SCRIPT (list of steps)
  -> for each step: voice speaks it (Piper) + board draws it, at the same time
```

## The tools we use (all free)
| Job | Tool |
|---|---|
| App window + hotkey | Electron |
| Hearing (speech to text) | Whisper, local on GPU |
| Seeing the screen | Screenshot sent to a free-tier cloud AI (try Gemini first) |
| Thinking | Cloud AI call that returns the script (free tier) |
| Speaking | Piper TTS, local (runs on CPU) |
| Hand-drawn look | rough.js |
| Formulas | KaTeX |
| Graphs and functions | JSXGraph |
| Flowcharts and cycles | Mermaid |
| CS (arrays, trees, code steps) | our own boxes-and-arrows drawing + code tracer |
| Checking maths answers | Sympy |

Put the AI call in ONE function called `callModel()`. Then we can switch models later without rewriting anything.

Note: our Claude Pro / ChatGPT Plus subscriptions do NOT cover API calls from our own app. That's why we use a free tier.

## THE CONTRACT: the script format (agree on this first, don't change it without telling each other)
```json
{
  "topic": "Pythagorean theorem",
  "steps": [
    {
      "say": "Imagine a right triangle. One angle is exactly 90 degrees.",
      "actions": [
        { "type": "draw_shape", "shape": "triangle", "id": "t1",
          "points": [[100,300],[100,100],[350,300]], "region": "left" },
        { "type": "label", "target": "t1", "text": "right angle", "at": [100,300] }
      ]
    },
    {
      "say": "The longest side is the hypotenuse.",
      "actions": [
        { "type": "highlight", "target": "t1", "part": "hypotenuse", "color": "red" }
      ]
    },
    {
      "say": "The rule: a squared plus b squared equals c squared.",
      "actions": [
        { "type": "write_formula", "latex": "a^2 + b^2 = c^2", "region": "right" }
      ]
    }
  ]
}
```

### Allowed drawing actions
`draw_line`, `draw_shape`, `write_text`, `write_formula`, `label`, `highlight`, `arrow`, `erase`
plus `draw_svg` as a backup for weird topics.

The board has a fixed size and named areas: `left`, `right`, `top`, `bottom`. The AI must put things in these areas so nothing overlaps.

## How the AI should teach (this goes in the system prompt)
1. Find out where I'm stuck (ask one quick question if needed).
2. If a basic idea is missing, explain that first.
3. Show the idea with a picture BEFORE the formula.
4. Go in small steps: one short sentence + one drawing.
5. Do one small example live.
6. End with a check: ask me to try the next step.

## Who does what

### Person A: the pipeline (everything up to the script)
- Electron app, overlay, hotkey, window next to the video
- Screenshot, mic, Whisper
- The AI calls: prompts, streaming, `callModel()`
- Checking the script JSON is valid, retry if it's broken
- Piper voice, exposed as `speak(text)` which finishes when speech ends
- Follow-up questions: send the current board + new question back to the AI

### Person B: the board (everything after the script)
- The whiteboard: rough.js style, animated drawing, formulas
- Every drawing action and how it animates
- The step player: `playStep(step)` runs the drawing and `speak()` together, and finishes when BOTH are done
- A test page where you paste a script JSON and watch it draw (so B never waits for A)
- Drawing helpers for each subject (graphs, flows, CS boxes, Sympy checks)

### The two things A and B connect through
1. The script JSON above
2. `speak(text)` (from A) and `playStep(step)` (from B)

B starts with a fake Pythagoras script, so nothing waits on A.

## Plan (2 days)
- **Day 1 morning:** A does overlay, hotkey, mic, Whisper. B does the board with a fake script.
- **Day 1 afternoon:** connect everything. One full run working by the middle of the day, even if it looks ugly.
- **Day 2 morning:** add the interrupt/follow-up feature, make it start speaking fast, test 4-5 topics (one each: maths, physics, CS, bio or chem).
- **Day 2 afternoon:** polish, record a backup demo video EARLY, submit.

Whoever finishes first helps the other. Usually the board needs more help.

## What can go wrong, and the fix
| Problem | Fix |
|---|---|
| AI draws messy or wrong pictures | Use only the allowed actions + named areas, check the script, retry once |
| Slow response | Start speaking step 1 as soon as it arrives (don't wait for the whole script) |
| Free tier is slow or hits its limit | Test early, record a backup video, keep `callModel()` swappable |
| AI is wrong on hard topics | Show steps so mistakes are visible, check maths with Sympy |
| Demo laptop slows down (heat, battery) | Plug in, high-performance mode, close other apps, test 30 min before |
| Running out of time | Cut the live screenshot and use a typed or spoken topic, or demo on one fixed video |

## Rules for both of us (whatever AI tool we each use)
- The repo is the source of truth. Update this file when the plan changes.
- Folders: `/shell` is A's, `/board` is B's, `/shared` is for the script format and types.
- Small commits, push often.
- API keys go in `.env`. Never commit them.
- Tell the other person BEFORE changing the script format or action names.
- Use the same model names and versions on both laptops.
