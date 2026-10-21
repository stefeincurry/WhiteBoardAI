// The conversation loop: what happens after you ask, and what the hotkey means at each moment.
//
//   idle --hotkey--> listening --(you stop talking)--> thinking --(AI script)--> playing --> idle
//
//   hotkey while listening          = stop listening now
//   hotkey while thinking / playing = drop that answer, cut the voice, listen again (a follow-up)
//
// Steps go to Aarav's board one at a time (window.board.playStep), because the board can't cancel
// a script halfway: between steps we check whether the answer was dropped.

const { callModel } = require('./llm/callModel');

// Spoken while the AI thinks, so the student isn't left in silence.
const FILLERS = ['Okay, let me sketch this out.', 'Good question. Let me draw it.', 'Alright, give me a second.', 'Hmm, let me think.'];
const LINES = {
  nothing: "I didn't catch that. Press the hotkey and ask again.",
  deaf: "Sorry, I can't hear properly right now. Check the mic, then try again.",
  offline: "Sorry, I can't reach my brain right now. Give it a few seconds and ask again.",
  tangled: 'Sorry, I got tangled up drawing that one. Can you ask it a different way?',
};
// Fixed lines, so main can make their audio once at startup instead of on demand.
const PHRASES = [...FILLERS, ...Object.values(LINES)];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * run(js)        executes js in the board page and resolves with its result (webContents.executeJavaScript)
 * mic(cmd)       'start' or 'stop' the page's mic ('stop' does nothing if it isn't recording)
 * getScreenshot  the screenshot taken when the overlay opened (data URL), or null
 * prepareSpeech  starts making a line's audio early; returns a promise that settles when it's ready
 */
function createTutor({ run, mic, getScreenshot, prepareSpeech = async () => {} }) {
  let state = 'idle'; // idle | listening | thinking | playing
  let turn = 0; // bumps whenever the answer in progress should be dropped (new question, interrupt, Esc)
  let listenId = 0; // bumps on every listen, so a late transcript of an old recording is ignored
  let playing = Promise.resolve(); // the board step playing right now; the board can't run two at once
  let askedAt = 0;

  const say = (text) => run(`window.shell.speak(${JSON.stringify(text)})`).catch(() => {});

  function listen() {
    state = 'listening';
    listenId++;
    mic('start'); // the page cuts any line still playing before it opens the mic
  }

  /** The hotkey was pressed. opened = the overlay just appeared (fresh board). */
  async function hotkey(opened) {
    if (opened) {
      turn++;
      await run('window.board.clearBoard()').catch((e) => console.warn('[board] clear failed:', e.message));
      return listen();
    }
    if (state === 'listening') return mic('stop'); // stops the mic; Whisper's text comes back via heard()
    if (state === 'thinking' || state === 'playing') {
      turn++; // drop the answer in progress
      console.log(`[tutor] interrupted while ${state}`);
    }
    listen();
  }

  /** Whisper's text for recording number `id`. */
  async function heard(question, id) {
    if (state !== 'listening' || id !== listenId) return console.log('[ask] dropped (an old recording)');
    if (!question) return heardNothing('nothing', id);
    const myTurn = ++turn;
    state = 'thinking';
    askedAt = Date.now();
    console.log(`[ask] "${question}"`);
    say(FILLERS[myTurn % FILLERS.length]);

    let r;
    try {
      r = await callModel({ question, screenshot: getScreenshot() });
    } catch (e) {
      if (myTurn !== turn) return;
      console.warn('[ai] every model failed:', e.message.split('\n').slice(0, 4).join(' | '));
      state = 'idle';
      return say(LINES.offline);
    }
    if (myTurn !== turn) return console.log('[ai] answer dropped (interrupted)');
    const skipped = r.failures.length ? `, skipped ${r.failures.length}` : '';
    console.log(`[ai] ${r.model} in ${r.ms}ms${skipped}: ${r.script ? `${r.script.steps.length} steps, ${r.fixes.length} layout fixes` : 'no valid script, speaking without drawings'}`);

    // Each new answer gets a clean board. (Step 7: follow-ups send the board state and keep it.)
    await playing; // a dropped answer's last step may still be drawing, and clearBoard can't cancel it
    if (myTurn !== turn) return;
    await run('window.board.clearBoard()').catch((e) => console.warn('[board] clear failed:', e.message));
    await playScript(r.script || plainTextScript(r.raw), myTurn);
  }

  /** The mic closed without a usable question. why: 'nothing' (silence) or 'deaf' (mic/Whisper broken). */
  function heardNothing(why, id = listenId) {
    if (state !== 'listening' || id !== listenId) return;
    console.log(`[ask] ${why === 'deaf' ? 'mic or transcription failed' : 'heard nothing'}`);
    state = 'idle';
    say(LINES[why] || LINES.nothing);
  }

  /** Plays a script step by step. Stops between steps if the answer is dropped. */
  async function playScript(script, myTurn = turn) {
    await playing; // a dropped answer's last step may still be drawing
    if (myTurn !== turn) return;
    state = 'playing';
    // Start drawing step 1 only once its voice is ready, so they begin together (the filler covers the wait).
    if (script.steps[0]) await Promise.race([prepareSpeech(script.steps[0].say), sleep(3000)]);
    for (const [i, step] of script.steps.entries()) {
      if (myTurn !== turn) return;
      if (script.steps[i + 1]) prepareSpeech(script.steps[i + 1].say); // made while this step plays
      const lag = i === 0 && askedAt ? ` (${((Date.now() - askedAt) / 1000).toFixed(1)}s after the question)` : '';
      console.log(`[step ${i + 1}/${script.steps.length}]${lag} ${step.say.slice(0, 60)}`);
      playing = run(`window.board.playStep(${JSON.stringify(step)}, window.shell.speak)`).catch((e) =>
        console.warn(`[step ${i + 1}] failed:`, e.message)
      );
      await playing;
    }
    if (myTurn === turn) {
      state = 'idle';
      console.log('[tutor] done; hotkey to ask a follow-up, Esc to close');
    }
  }

  /** The page was reloaded (Esc): nothing is playing or listening any more. */
  function reset() {
    turn++;
    listenId++;
    state = 'idle';
    playing = Promise.resolve();
  }

  return {
    hotkey,
    heard,
    heardNothing,
    playScript,
    reset,
    get state() {
      return state;
    },
    get listenId() {
      return listenId;
    },
  };
}

/** CLAUDE.md fallback when the AI's JSON was broken twice: speak its lines without drawings. */
function plainTextScript(raw = '') {
  const lines = [];
  for (const m of raw.matchAll(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      lines.push(JSON.parse(`"${m[1]}"`));
    } catch {}
  }
  return { topic: 'fallback', steps: (lines.length ? lines : [LINES.tangled]).map((say) => ({ say, actions: [] })) };
}

module.exports = { createTutor, plainTextScript, PHRASES };
