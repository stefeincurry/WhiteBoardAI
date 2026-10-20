<<<<<<< HEAD
# AI Whiteboard Tutor

Hotkey, speak your doubt, and an AI tutor explains it out loud while drawing on a live whiteboard next to your screen.

- **Kabir = Person A** (pipeline: overlay, hotkey, mic, Whisper, AI calls, voice). Uses Claude Code. Folder: `/shell`
- **Aarav = Person B** (board: drawing, animation, sync). Uses Codex. Folder: `/board`
- **Both:** `/shared` (the contract). Read `SPEC.md` first.

If `SPEC.md` and `shared/contract.d.ts` disagree, **`shared/contract.d.ts` wins**.

## Folder map
```
SPEC.md                  the plan (read first)
CLAUDE.md                instructions for Kabir's Claude Code
AGENTS.md                instructions for Aarav's Codex
shared/                  THE CONTRACT: change only after telling each other
  contract.d.ts            types: Script, Step, Action, speak(), playStep()
  script.schema.json       JSON schema for the AI's output
  example-pythagoras.json  hardcoded test script
shell/                   Kabir: Electron overlay starter (untested) + prompts
board/                   Aarav: whiteboard test page (open index.html in a browser)
.env.example             copy to .env and add your keys (never commit .env)
```

## Kickoff checklist (tonight, ~30 min together)
1. **One of you** creates a GitHub repo, pushes this folder, adds the other as collaborator.
   ```
   git init && git add . && git commit -m "starter"
   git branch -M main
   git remote add origin <repo-url> && git push -u origin main
   ```
2. **Both** clone it, then `cp .env.example .env` and add your own keys.
   - Gemini key: aistudio.google.com (make your own, one per person)
   - Groq key: console.groq.com (backup brain)
3. **Read `shared/contract.d.ts` together** and agree. After this you can work separately.
4. **Kabir:** open the repo in Claude Code and say: "Read CLAUDE.md and do step 1."
   **Aarav:** open it in Codex and say: "Read AGENTS.md and do step 1."

## Git habits (avoids pain)
- `git pull` before you start, commit after each working piece, push often.
- Only edit your own folder. Need a change in the other's folder or in `/shared`? Message them.

## Check-in times
- **Midday tomorrow:** connect both halves, one full run (ugly is fine).
- **Day 2 afternoon:** record the backup demo video EARLY.
=======
# WhiteBoardAI
>>>>>>> 0261a39d5d8dd793f0c52f7d9cdb26f854581000
