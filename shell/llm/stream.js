// Pulls complete steps out of the AI's script while it is still streaming in.
//
// The model writes {"topic": "...", "steps": [ {...}, {...}, ... ]}. Every time a step object closes
// we can give it to the board, without waiting for the rest of the answer (CLAUDE.md step 6).
//
//   const parser = createStepParser();
//   for (const step of parser.push(chunk)) ...   // the steps completed by this chunk (parsed objects)
//   parser.topic, parser.text                     // the topic once seen; everything received so far

function createStepParser() {
  let text = '';
  let pos = 0; // next character to scan
  const stack = []; // open containers: { type: '{' | '[', key: the key it belongs to (in an object) }
  let inString = false, escaped = false;
  let stringStart = -1, lastString = null, pendingKey = null;
  let stepStart = -1;
  let topic = null;

  function push(chunk) {
    text += chunk;
    const steps = [];
    for (; pos < text.length; pos++) {
      const ch = text[pos];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') {
          inString = false;
          lastString = text.slice(stringStart, pos + 1);
          // "topic": "..." at the top level
          const top = stack[stack.length - 1];
          if (stack.length === 1 && top.type === '{' && pendingKey === 'topic' && topic === null) {
            try {
              topic = JSON.parse(lastString);
            } catch {}
          }
        }
        continue;
      }
      if (!stack.length && ch !== '{') continue; // anything before the JSON starts (e.g. ```json)
      if (ch === '"') {
        inString = true;
        stringStart = pos;
      } else if (ch === ':') {
        try {
          pendingKey = JSON.parse(lastString);
        } catch {
          pendingKey = null;
        }
      } else if (ch === ',') {
        pendingKey = null;
      } else if (ch === '{' || ch === '[') {
        const parent = stack[stack.length - 1];
        const key = parent && parent.type === '{' ? pendingKey : null;
        stack.push({ type: ch, key });
        // a step = an object directly inside the top-level "steps" array
        if (ch === '{' && parent && parent.type === '[' && parent.key === 'steps' && stack.length === 3) stepStart = pos;
        pendingKey = null;
      } else if (ch === '}' || ch === ']') {
        stack.pop();
        if (ch === '}' && stepStart !== -1 && stack.length === 2) {
          try {
            steps.push(JSON.parse(text.slice(stepStart, pos + 1)));
          } catch {}
          stepStart = -1;
        }
      }
    }
    return steps;
  }

  return {
    push,
    get topic() {
      return topic;
    },
    get text() {
      return text;
    },
  };
}

module.exports = { createStepParser };
