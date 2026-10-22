// The conversation loop: what happens after you ask, and what the hotkey means at each moment.
//
//   idle --hotkey--> listening --(you stop talking)--> thinking --(AI script)--> playing --> idle
//
//   hotkey while listening          = stop listening now
//   hotkey while thinking / playing = drop that answer, cut the voice, listen again (a follow-up)
//
// The first question after the overlay opens gets a clean board. Every later one is a follow-up: the AI
// gets the board state and the conversation so far, and continues on the same board.
//
// Steps go to Aarav's board one at a time (window.board.playStep), because the board can't cancel
// a script halfway: between steps we check whether the answer was dropped. They stream in (step 6):
// each step plays as soon as the AI has finished writing it, its voice made the moment it lands.

const fs = require('fs');
const path = require('path');
const { callModel } = require('./llm/callModel');

// The last answer's script (and the board it was drawn on), for finding out what went wrong on the board.
const LAST_ANSWER = path.join(__dirname, 'tools', 'out', 'last-answer.json');

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
function createTutor({ run, mic, getScreenshot, prepareSpeech = async () => {}, onAnswer = () => {}, getLevel = () => 'student' }) {
  let state = 'idle'; // idle | listening | thinking | playing
  let turn = 0; // bumps whenever the answer in progress should be dropped (new question, interrupt, Esc)
  let listenId = 0; // bumps on every listen, so a late transcript of an old recording is ignored
  let playing = Promise.resolve(); // the board step playing right now; the board can't run two at once
  let askedAt = 0;
  let history = []; // answered questions since the overlay opened: { question, said: [lines], cut }
  let answer = null; // AbortController for the AI call in progress (an interrupt cancels it)
  let paused = false; // the Pause button: the next step waits until Resume
  let pauseWaiters = [];

  const say = (text) => run(`window.shell.speak(${JSON.stringify(text)})`).catch(() => {});

  function pause(p) {
    paused = p;
    console.log(`[tutor] ${p ? 'paused' : 'resumed'}`);
    if (!p) {
      const waiters = pauseWaiters;
      pauseWaiters = [];
      waiters.forEach((r) => r());
    }
  }

  /** Drop the answer in progress (thinking or playing): cut it off and stop the AI writing the rest. */
  function interrupt() {
    turn++;
    if (answer) answer.abort();
    const last = history[history.length - 1];
    if (last && !last.said.length) history.pop(); // nothing was said yet: it never happened
    else if (last && state === 'playing') last.cut = true;
    console.log(`[tutor] interrupted while ${state}`);
  }

  function listen() {
    if (paused) pause(false);
    state = 'listening';
    listenId++;
    mic('start'); // the page cuts any line still playing before it opens the mic
  }

  /** The hotkey was pressed. opened = the overlay just appeared (fresh board). */
  async function hotkey(opened) {
    if (opened) {
      turn++;
      history = [];
      await run('window.board.clearBoard()').catch((e) => console.warn('[board] clear failed:', e.message));
      return listen();
    }
    if (state === 'listening') return mic('stop'); // stops the mic; Whisper's text comes back via heard()
    if (state === 'thinking' || state === 'playing') interrupt();
    listen();
  }

  /** The student typed a question (or an answer to the tutor's question) instead of saying it. */
  function typed(text) {
    if (state === 'thinking' || state === 'playing') interrupt();
    if (paused) pause(false);
    if (state === 'listening') mic('stop');
    listenId++; // a recording still going, or its transcript, no longer counts
    state = 'listening';
    console.log(`[typed] "${text}"`);
    return heard(text, listenId);
  }

  /** "Explain it differently": the last question again, with a fresh approach on a clean board. */
  function again() {
    if (!history.length) return say('Ask me something first, then I can explain it a different way.');
    // The conversation goes along, so the AI knows what "that" was (the topic, not the student's last reply).
    return typed(
      'I did not understand that. Explain it again in a completely different way: a new analogy, a new picture, ' +
        'simpler steps. Do not repeat what you said before. Start the first step with {"type":"erase"} to clear the board.'
    );
  }

  /** "Test me": one practice question on what was just covered; the student's answer is checked as a follow-up. */
  function testMe() {
    if (!history.length) return say('Ask me something first, then I can test you on it.');
    return typed(
      'Test me: give me ONE practice question on what we just covered, at my level. Ask it out loud and draw what I need ' +
        'to see, then stop and wait for my answer. Do not give the answer. Start the first step with {"type":"erase"}.'
    );
  }

  /** The type box opened while listening: stop waiting for speech (and don't say "I didn't catch that"). */
  function cancelListening() {
    if (state !== 'listening') return;
    listenId++;
    state = 'idle';
    mic('stop');
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

    // A follow-up continues on the same board: wait for an interrupted step to finish drawing, so the
    // snapshot includes it, and send the board and the conversation along. A new question starts clean.
    const followUp = history.length > 0;
    await playing; // a dropped answer's last step may still be drawing, and clearBoard can't cancel it
    if (myTurn !== turn) return;
    let boardState;
    if (followUp) {
      boardState = await run('window.board.getBoardState()').catch(() => undefined);
      console.log(`[ask] follow-up: ${boardState ? boardState.length : 0} things on the board`);
    } else {
      await run('window.board.clearBoard()').catch((e) => console.warn('[board] clear failed:', e.message));
    }
    if (myTurn !== turn) return;

    const steps = stepQueue();
    const historyText = followUp ? describeHistory(history) : undefined;
    const exchange = { question, said: [], cut: false, steps: [], topic: '' };
    history.push(exchange);
    const myAnswer = (answer = new AbortController());
    let failed = null;
    const answering = callModel(
      { question, screenshot: getScreenshot(), boardState, history: historyText, level: getLevel() },
      {
        signal: myAnswer.signal,
        onStep: (step) => {
          if (myTurn !== turn) return;
          prepareSpeech(step.say); // its voice is made while earlier steps play
          steps.push(step);
        },
      }
    )
      .then((r) => {
        if (r.script && r.script.topic) exchange.topic = r.script.topic;
        const record = { question, followUp, boardBefore: boardState || [], model: r.model, script: r.script, fixes: r.fixes };
        fs.promises
          .mkdir(path.dirname(LAST_ANSWER), { recursive: true })
          .then(() => fs.promises.writeFile(LAST_ANSWER, JSON.stringify(record, null, 2)))
          .catch(() => {});
        if (myTurn !== turn) return;
        const skipped = r.failures.length ? `, skipped ${r.failures.length}` : '';
        const how = r.streamed ? ' (streamed)' : '';
        console.log(`[ai] ${r.model}${how} in ${r.ms}ms${skipped}: ${r.script ? `${r.script.steps.length} steps, ${r.fixes.length} layout fixes` : 'no valid script, speaking without drawings'}`);
        for (const f of r.failures) console.log(`[ai]   skipped ${f.slice(0, 140)}`);
        // Steps that weren't streamed (a whole answer, or lines rescued from broken JSON) play now.
        if (!steps.items.length) for (const step of (r.script || plainTextScript(r.raw)).steps) steps.push(step);
      })
      .catch((e) => {
        failed = e;
      })
      .finally(() => steps.end());

    await playScript(steps, myTurn, exchange);
    if (exchange.steps.length) {
      // Saved board history (main writes it to disk): what was asked, what was played, how the board looks now.
      run('window.board.getBoardState()')
        .then((snapshot) => onAnswer({ question, topic: exchange.topic || question, steps: exchange.steps, snapshot }))
        .catch(() => {});
    }
    await answering;
    if (myTurn !== turn || !failed) return;
    if (exchange.said.length) return; // the answer broke off halfway: what was said stands
    history.pop();
    console.warn('[ai] every model failed:', failed.message.split('\n').slice(0, 4).join(' | '));
    state = 'idle';
    return say(LINES.offline);
  }

  /** The mic closed without a usable question. why: 'nothing' (silence) or 'deaf' (mic/Whisper broken). */
  function heardNothing(why, id = listenId) {
    if (state !== 'listening' || id !== listenId) return;
    console.log(`[ask] ${why === 'deaf' ? 'mic or transcription failed' : 'heard nothing'}`);
    state = 'idle';
    say(LINES[why] || LINES.nothing);
  }

  /**
   * Plays steps one by one: a whole script ({ steps: [...] }) or a stepQueue the AI is still filling.
   * Stops between steps if the answer is dropped.
   */
  async function playScript(script, myTurn = turn, exchange = null) {
    await playing; // a dropped answer's last step may still be drawing
    if (myTurn !== turn) return;
    const list = Array.isArray(script && script.steps) ? script.steps : null;
    let i = 0;
    for await (const step of list || script) {
      while (paused && myTurn === turn) await new Promise((r) => pauseWaiters.push(r));
      if (myTurn !== turn) return;
      if (i === 0) {
        state = 'playing';
        // Start drawing step 1 only once its voice is ready, so they begin together (the filler covers the wait).
        await Promise.race([prepareSpeech(step.say), sleep(3000)]);
        if (myTurn !== turn) return;
      }
      if (list && list[i + 1]) prepareSpeech(list[i + 1].say); // made while this step plays
      const lag = i === 0 && askedAt ? ` (${((Date.now() - askedAt) / 1000).toFixed(1)}s after the question)` : '';
      console.log(`[step ${i + 1}${list ? '/' + list.length : ''}]${lag} ${step.say.slice(0, 60)}`);
      if (exchange) exchange.said.push(step.say), exchange.steps.push(step);
      const n = i + 1;
      playing = run(`window.board.playStep(${JSON.stringify(step)}, window.shell.speak)`).catch((e) =>
        console.warn(`[step ${n}] failed:`, e.message)
      );
      await playing;
      i++;
    }
    if (myTurn === turn) {
      state = 'idle';
      if (i) console.log('[tutor] done; hotkey to ask a follow-up, Esc to close');
    }
  }

  /** The page was reloaded (Esc): nothing is playing or listening any more. */
  /** Brings back a saved board: redraws it at once, and follow-ups continue from it. */
  async function restore(entry) {
    if (state === 'thinking' || state === 'playing') interrupt();
    turn++;
    if (answer) answer.abort();
    if (state === 'listening') mic('stop');
    listenId++;
    state = 'idle';
    history = [{ question: entry.question, said: (entry.steps || []).map((st) => st.say), cut: false }];
    await playing;
    await run('window.board.clearBoard()').catch(() => {});
    const all = { say: '.', actions: entry.snapshot || [] };
    playing = run(`window.board.playStep(${JSON.stringify(all)}, () => Promise.resolve())`).catch(() => {});
    console.log(`[history] reopened "${entry.topic}"`);
    await playing;
  }

  function reset() {
    turn++;
    if (answer) answer.abort();
    if (paused) pause(false);
    history = [];
    listenId++;
    state = 'idle';
    playing = Promise.resolve();
  }

  return {
    hotkey,
    heard,
    typed,
    again,
    testMe,
    restore,
    cancelListening,
    pause,
    heardNothing,
    playScript,
    reset,
    get state() {
      return state;
    },
    get listenId() {
      return listenId;
    },
    /** What the board is about right now (for naming saved notes). */
    get topic() {
      const last = history[history.length - 1];
      return (last && (last.topic || last.question)) || 'whiteboard';
    },
  };
}

/** Steps as the AI streams them in; the player waits on it (for await) until end() is called. */
function stepQueue() {
  const items = [];
  let wake = null;
  let ended = false;
  const notify = () => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  return {
    items,
    push(step) {
      items.push(step);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; ; i++) {
        while (i >= items.length) {
          if (ended) return;
          await new Promise((r) => (wake = r));
        }
        yield items[i];
      }
    },
  };
}

/** The conversation so far, for the AI: the last two questions, what was said, and where it was cut off. */
function describeHistory(history) {
  return history
    .slice(-2)
    .map(({ question, said, cut }) => {
      const lines = said.slice(-8).map((line) => `  "${line}"`).join('\n');
      const cutNote = cut && said.length ? `\nThe student cut you off while you were saying: "${said[said.length - 1]}"` : '';
      return `The student asked: "${question}"\nYou said:\n${lines || '  (nothing yet)'}${cutNote}`;
    })
    .join('\n\n');
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

module.exports = { createTutor, plainTextScript, describeHistory, PHRASES };
