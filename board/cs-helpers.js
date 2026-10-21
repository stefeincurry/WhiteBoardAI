// Local authoring helpers. Outputs use only existing shared/contract.d.ts actions.
(function (root) {
  let sequence = 0;
  function values(input, max, length) {
    if (!Array.isArray(input) || !input.length || input.length > max) {
      throw new RangeError(`Provide between 1 and ${max} values.`);
    }
    return input.map(value => {
      if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
        throw new TypeError('Diagram values must be strings or finite numbers.');
      }
      const text = String(value);
      if (!text.trim() || text.length > length || /[\r\n\t]/.test(text)) throw new RangeError(`Keep each value on one line, between 1 and ${length} characters.`);
      return text;
    });
  }
  function prefix(options) {
    const id = options.prefix || `cs-${++sequence}`;
    if (typeof id !== 'string' || !/^[a-zA-Z][\w-]*$/.test(id)) throw new TypeError('Use a letter followed by letters, numbers, underscores or hyphens for the prefix.');
    return id;
  }
  const rect = (id, x, y, width, height) => ({ type: 'draw_shape', shape: 'rect', id, points: [[x, y], [x + width, y + height]] });
  const label = (target, text, x, y) => ({ type: 'label', target, text, at: [x, y] });
  const arrow = (from, to) => ({ type: 'arrow', from, to });

  function array(input, options = {}) {
    const data = values(input, 6, 6), id = prefix(options), actions = [];
    const width = 120, start = (800 - width * data.length) / 2;
    data.forEach((value, i) => {
      const x = start + i * width, target = `${id}-${i}`;
      actions.push(rect(target, x, 170, width, 80));
    });
    data.forEach((value, i) => {
      const x = start + i * width, target = `${id}-${i}`;
      actions.push(label(target, value, x + 16, 218), label(target, String(i), x + 44, 290));
    });
    return actions;
  }

  function linkedList(input, options = {}) {
    const data = values(input, 4, 3), id = prefix(options), actions = [];
    data.forEach((value, i) => actions.push(rect(`${id}-${i}`, 40 + i * 164, 190, 112, 70)));
    data.forEach((value, i) => {
      const x = 40 + i * 164, target = `${id}-${i}`;
      actions.push({ type: 'draw_line', from: [x + 76, 190], to: [x + 76, 260] });
      actions.push(label(target, value, x + 16, 232));
      actions.push(arrow([x + 92, 225], [x + 156, 225]));
    });
    actions.push({ type: 'write_text', text: 'null', at: [40 + data.length * 164, 238] });
    return actions;
  }

  function binaryTree(input, options = {}) {
    // Input is level order: root, left, right, then the next level.
    const data = values(input, 7, 3), id = prefix(options), actions = [];
    const positions = [[400, 110], [220, 245], [580, 245], [130, 370], [310, 370], [490, 370], [670, 370]];
    data.forEach((value, i) => {
      const [x, y] = positions[i];
      actions.push({ type: 'draw_shape', shape: 'circle', id: `${id}-${i}`, points: [[x, y], [x + 34, y]] });
      if (i) {
        const [px, py] = positions[Math.floor((i - 1) / 2)];
        const distance = Math.hypot(x - px, y - py);
        const dx = (x - px) / distance, dy = (y - py) / distance;
        actions.push(arrow([px + dx * 40, py + dy * 40], [x - dx * 40, y - dy * 40]));
      }
    });
    data.forEach((value, i) => {
      const [x, y] = positions[i];
      actions.push(label(`${id}-${i}`, value, x - value.length * 7, y + 10));
    });
    return actions;
  }

  function stackFrames(input, options = {}) {
    // Input is oldest call first; newest is drawn at the top.
    const data = values(input, 4, 20), id = prefix(options), actions = [];
    data.forEach((value, i) => {
      const y = 85 + (data.length - 1 - i) * 80;
      actions.push(rect(`${id}-${i}`, 230, y, 340, 64));
    });
    data.forEach((value, i) => {
      const y = 85 + (data.length - 1 - i) * 80;
      actions.push(label(`${id}-${i}`, value, 250, y + 40));
    });
    return actions;
  }

  function demo(kind) {
    const examples = {
      array: { title: 'Array indexing', values: [10, 20, 30, 40], build: array,
        say: 'An array stores values in order. The labels below show each index, starting at zero.',
        focus: 2, explain: 'Index two contains thirty.', note: 'Index 2 contains 30.' },
      linkedList: { title: 'Linked list', values: [10, 20, 30], build: linkedList,
        say: 'Each node stores a value and a pointer. Follow the arrows to visit the next node.',
        focus: 1, explain: 'The second node points to the third. The final pointer is null.', note: 'Follow next pointers until null.' },
      binaryTree: { title: 'Binary tree', values: [8, 4, 12, 2, 6, 10, 14], build: binaryTree,
        say: 'This binary tree has one root. Each node has at most two children.',
        focus: 0, explain: 'Eight is the root. Four and twelve are its children.', note: 'Root: 8. Children: 4 and 12.' },
      stackFrames: { title: 'Call stack', values: ['main()', 'factorial(3)', 'factorial(2)'], build: stackFrames,
        say: 'Each function call adds a frame. The newest call is at the top.',
        focus: 2, explain: 'Factorial of two returns first, and its frame is removed.', note: 'The newest call returns first.', pop: true },
    };
    const example = examples[kind];
    if (!example) throw new TypeError('Unknown CS demo.');
    const id = prefix({});
    const target = `${id}-${example.focus}`;
    const steps = [
      { say: example.say, actions: [{ type: 'erase' },
        { type: 'write_text', text: example.title, at: [40, 48] },
        ...example.build(example.values, { prefix: id })] },
      { say: example.explain, actions: [{ type: 'highlight', target, part: 'outline', color: '#d22' }] },
    ];
    if (example.pop) steps.push({ say: 'Now the caller continues.', actions: [{ type: 'erase', target }] });
    steps.push({ say: example.note, actions: [{ type: 'write_text', text: example.note, at: [40, 462] }] });
    return { topic: example.title, steps };
  }

  const helpers = { array, linkedList, binaryTree, stackFrames, demo };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  else root.boardHelpers = helpers;
})(typeof window !== 'undefined' ? window : globalThis);
