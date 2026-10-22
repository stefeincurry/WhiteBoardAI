// SVG whiteboard with local rough.js strokes and KaTeX formulas.
// Subject authoring helpers live in cs-helpers.js, graph-helpers.js and flow-helpers.js.
//
// Public API (matches shared/contract.d.ts):
//   window.board.playScript(script, speak)
//   window.board.playStep(step, speak)
//   window.board.getBoardState()
//   window.board.clearBoard()

(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('board');
  const pen = rough.svg(svg);
  let layout = new BoardLayout();
  const PEN = { stroke: '#222', strokeWidth: 3, roughness: 1, bowing: 0.8 };
  const W = 800, H = 500;

  // Everything drawn so far, for getBoardState() (sent back to the AI on follow-ups).
  let state = [];
  // Notes and formulas in the order they were placed, so a full board can drop its oldest notes
  // instead of wiping the diagrams too: { owner, node, at }.
  let notes = [];
  let noteSeq = 0;
  let history = [];

  const el = (name, attrs = {}) => {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Estimated speech duration so drawing finishes about when the voice does.
  // Replace with the real audio duration if Kabir's speak() can report it.
  const estimateMs = (text) => Math.max(1200, (text.trim().match(/\S+/g) || []).length * 380);

  // Share one time budget; diagrams get longer than short labels.
  const ACTION_WEIGHT = {
    draw_line: 2, arrow: 2, draw_shape: 3, highlight: 2,
    label: 0.75, write_text: 1, write_formula: 1.5, draw_svg: 1, erase: 0,
    array: 3, flowchart: 3, // helper actions: the board lays these out itself (cs-helpers, flow-helpers)
    linked_list: 3, binary_tree: 3, call_stack: 3, plot: 3,
  };

  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  const name = value => typeof value === 'string' && value.trim().length > 0;
  function validAction(a) {
    if (!object(a) || typeof a.type !== 'string' || !Object.hasOwn(ACTION_WEIGHT, a.type)) {
      console.warn('Unknown action type, skipping:', a && a.type);
      return false;
    }
    let valid = (a.id === undefined || name(a.id)) &&
      (a.region === undefined || ['left', 'right', 'top', 'bottom'].includes(a.region)) &&
      (a.at === undefined || point(a.at));
    switch (a.type) {
      case 'draw_line': case 'arrow': valid &&= point(a.from) && point(a.to); break;
      case 'draw_shape': {
        const counts = { triangle: 3, rect: 2, circle: 2, polygon: 3 };
        const count = typeof a.shape === 'string' && Object.hasOwn(counts, a.shape) ? counts[a.shape] : undefined;
        valid &&= name(a.id) && count !== undefined && Array.isArray(a.points) &&
          a.points.length >= count && (a.shape === 'polygon' || a.points.length === count) && a.points.every(point);
        break;
      }
      case 'write_text': valid &&= typeof a.text === 'string'; break;
      case 'write_formula': valid &&= typeof a.latex === 'string'; break;
      case 'label': valid &&= name(a.target) && typeof a.text === 'string' && point(a.at); break;
      case 'highlight':
        valid &&= name(a.target) && (a.part === undefined || ['hypotenuse', 'outline'].includes(a.part)) &&
          (a.color === undefined || (name(a.color) && !/url\s*\(/i.test(a.color)));
        break;
      case 'erase': valid &&= a.target === undefined || name(a.target); break;
      case 'draw_svg': valid &&= name(a.svg); break;
      case 'array':
        valid &&= Array.isArray(a.values) && a.values.length >= 1 && a.values.length <= 6 &&
          a.values.every((v) => (typeof v === 'string' || typeof v === 'number') && String(v).length <= 6);
        break;
      case 'flowchart': valid &&= typeof a.source === 'string' && a.source.length <= 4000; break;
      case 'linked_list': case 'binary_tree': case 'call_stack': {
        const max = { linked_list: [4, 3], binary_tree: [7, 3], call_stack: [4, 20] }[a.type];
        valid &&= Array.isArray(a.values) && a.values.length >= 1 && a.values.length <= max[0] &&
          a.values.every((v) => (typeof v === 'string' || typeof v === 'number') && String(v).length <= max[1]);
        break;
      }
      case 'plot': {
        const range = (r) => r === undefined || (Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] < r[1]);
        valid &&= typeof a.fn === 'string' && a.fn.length <= 100 && range(a.xRange) && range(a.yRange);
        break;
      }
    }
    if (!valid) console.warn('Malformed action, skipping:', a.type);
    return valid;
  }

  async function svgImage(source) {
    // SVG image context isolates styles, disables scripts and external resources.
    // Never insert model-written markup into the live document.
    const markup = `<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${source}</svg>`;
    const href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    const preview = new Image();
    preview.src = href;
    await preview.decode(); // Invalid XML is skipped before changing the board.
    const image = el('image', { x: 0, y: 0, width: W, height: H, href, 'pointer-events': 'none' });
    // Root viewport dimensions are only a layout hint, never a security filter.
    const root = source.match(/^\s*<svg\b([^>]*)>/i);
    const bounds = { x: 0, y: 0, width: W, height: H };
    if (root) for (const key of Object.keys(bounds)) {
      const attr = root[1].match(new RegExp(`(?:^|\\s)${key}=["']([\\d.eE+\\-]+)(?:px)?["']`));
      if (attr && Number.isFinite(Number(attr[1])) && (key === 'x' || key === 'y' || Number(attr[1]) > 0)) bounds[key] = Number(attr[1]);
    }
    return { image, bounds };
  }

  function fadeIn(node, durationMs) {
    node.style.opacity = 1;
    return node.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: Math.min(durationMs, 500), easing: 'linear',
    }).finished;
  }

  function shapeEl(a) {
    const pts = a.points || [];
    if (a.shape === 'circle' && pts.length >= 2) {
      const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      return pen.circle(pts[0][0], pts[0][1], r * 2, PEN);
    }
    if (a.shape === 'rect' && pts.length >= 2) {
      const x = Math.min(pts[0][0], pts[1][0]), y = Math.min(pts[0][1], pts[1][1]);
      return pen.rectangle(x, y, Math.abs(pts[1][0] - pts[0][0]), Math.abs(pts[1][1] - pts[0][1]), PEN);
    }
    return pen.polygon(pts, PEN);
  }

  // Animate a stroke "drawing itself" over durationMs.
  function revealStroke(node, durationMs) {
    // RoughSVG returns groups; reveal their actual paths in sequence.
    const paths = node.matches('path') ? [node] : [...node.querySelectorAll('path')];
    const lengths = paths.map(path => Math.max(1, path.getTotalLength()));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let delay = 0;
    const finished = paths.map((path, i) => {
      const length = lengths[i];
      const duration = durationMs * length / total;
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.style.strokeDasharray = `${length} ${length}`;
      const animation = path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
        duration, delay, easing: 'linear', fill: 'both',
      });
      delay += duration;
      return animation.finished;
    });
    return Promise.all(finished);
  }

  function record(entry) {
    // Own the snapshot: later edits to a caller's script must not change it.
    state.push(JSON.parse(JSON.stringify(entry)));
  }

  function findTarget(id) {
    const node = [...svg.querySelectorAll('[data-id]')]
      .find(node => node.getAttribute('data-id') === id);
    return node ? { node } : null;
  }

  function reserveDrawing(a, node) {
    let points = a.points || (a.from ? [a.from, a.to] : []);
    if (a.shape === 'circle' && points.length >= 2) {
      const [cx, cy] = points[0];
      const radius = Math.hypot(points[1][0] - cx, points[1][1] - cy);
      points = [[cx - radius, cy - radius], [cx + radius, cy + radius]];
    }
    let box;
    if (points.length) {
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    } else {
      try { const b = node.getBBox(); box = { x: b.x, y: b.y, width: b.width, height: b.height }; }
      catch { box = { x: 0, y: 0, width: W, height: H }; }
    }
    layout.reserve({ ...box, diagram: true }, a.id);
  }

  async function placeContent(a, node, content, formula = false) {
    const target = a.type === 'label' ? findTarget(a.target) : null;
    if (a.type === 'label' && !target) { console.warn('label: unknown target', a.target); return null; }
    const region = a.region || (a.at ? (a.at[0] >= 400 ? 'right' : 'left') : formula ? 'right' : 'left');
    const area = BoardLayout.region(region);
    const available = Math.max(32, a.at ? W - Math.max(16, a.at[0]) - 16 : area.width);
    node.setAttribute('width', available);
    node.setAttribute('height', H);
    content.style.display = 'inline-block';
    content.style.width = 'max-content';
    content.style.maxWidth = formula ? 'none' : `${available}px`;
    svg.appendChild(node);
    // Fonts must be loaded before using their actual size for collision checks.
    if (document.fonts) await document.fonts.ready;
    const fallbackWidth = Math.min(available, Math.max(24, (a.text || a.latex || '').length * 14));
    const width = content.scrollWidth || fallbackWidth;
    const height = content.scrollHeight || (formula ? 72 : 34 * Math.max(1, Math.ceil((a.text || '').length * 14 / available)));
    const scale = Math.min(1, available / width, 460 / height);
    const w = Math.min(available, Math.ceil(width * scale));
    const h = Math.ceil(height * scale);
    content.style.transformOrigin = 'top left';
    content.style.transform = `scale(${scale})`;
    const at = a.at && [a.at[0], a.at[1] - (formula ? 34 : 24)];
    const anywhere = () => {
      for (const alternative of [region, 'left', 'right', 'top', 'bottom']) {
        const b = layout.place(w, h, alternative);
        if (b) return b;
      }
      return null;
    };
    let box = layout.place(w, h, region, at, target && a.target);
    // A note whose exact spot is taken goes wherever there is room.
    if (!box && !target) box = anywhere();
    // Board full: drop the oldest notes (never diagrams or their labels) until this one fits.
    while (!box && !target && notes.length) {
      dropOldestNote();
      box = anywhere();
    }
    if (!box) {
      // Keep a label with its diagram instead of erasing its own target.
      if (target) { node.remove(); console.warn('No room for label:', a.target); return null; }
      clearBoard(); // last resort: even an empty-of-notes board has no room
      box = layout.place(w, h, region, at) || anywhere();
      svg.appendChild(node);
    }
    if (!box) { node.remove(); throw new Error('Content cannot fit on a blank board'); }
    for (const [key, value] of Object.entries({ x: box.x, y: box.y, width: w, height: h })) node.setAttribute(key, value);
    if (a.target) node.setAttribute('data-owner', a.target);
    const placedAt = [box.x, box.y + (formula ? 34 : 24)];
    if (target) {
      layout.reserve(box, a.target);
    } else {
      const owner = `note-${++noteSeq}`;
      layout.reserve(box, owner);
      notes.push({ owner, node, at: placedAt });
    }
    return { at: placedAt };
  }

  /** Removes the oldest note or formula: its drawing, its reserved space and its board-state entry. */
  function dropOldestNote() {
    const note = notes.shift();
    note.node.remove();
    layout.remove(note.owner);
    state = state.filter((s) => !((s.type === 'write_text' || s.type === 'write_formula') && !s.target &&
      s.at && s.at[0] === note.at[0] && s.at[1] === note.at[1]));
  }

  // Draw one action. Returns when its animation is done.
  async function drawAction(a, durationMs) {
    let animation = Promise.resolve();
    switch (a.type) {
      case 'draw_line':
      case 'arrow': {
        const line = pen.line(...a.from, ...a.to, PEN);
        if (a.id) line.setAttribute('data-id', a.id);
        if (a.type === 'arrow') {
          const angle = Math.atan2(a.to[1] - a.from[1], a.to[0] - a.from[0]);
          const wing = offset => [a.to[0] - 16 * Math.cos(angle + offset), a.to[1] - 16 * Math.sin(angle + offset)];
          line.appendChild(pen.linearPath([wing(-0.5), a.to, wing(0.5)], PEN));
        }
        svg.appendChild(line);
        reserveDrawing(a, line);
        animation = revealStroke(line, durationMs);
        record({ type: a.type, id: a.id, from: a.from, to: a.to });
        break;
      }
      case 'draw_shape': {
        const s = shapeEl(a);
        if (a.id) s.setAttribute('data-id', a.id);
        svg.appendChild(s);
        reserveDrawing(a, s);
        animation = revealStroke(s, durationMs);
        record({ type: 'draw_shape', id: a.id, shape: a.shape, points: a.points });
        break;
      }
      case 'label':
      case 'write_text': {
        const t = el('foreignObject', { opacity: 0 });
        const content = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        content.style.cssText = 'font:24px/1.35 "Comic Sans MS",cursive,sans-serif;color:#1a3d7c;white-space:pre-wrap;overflow-wrap:anywhere;padding:2px 0;';
        content.textContent = a.text;
        t.appendChild(content);
        const placed = await placeContent(a, t, content);
        if (!placed) return;
        animation = fadeIn(t, durationMs);
        record({ type: a.type, text: a.text, at: placed.at, target: a.target });
        break;
      }
      case 'write_formula': {
        // HTML inside SVG scales with the board and clears with it.
        const t = el('foreignObject', { opacity: 0 });
        const content = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        content.style.cssText = 'font-size:28px;color:#8b1a1a;padding:4px 0;overflow-wrap:anywhere;';
        try {
          katex.render(a.latex, content, {
            throwOnError: false, trust: false, output: 'htmlAndMathml',
            maxSize: 10, maxExpand: 1000,
          });
        } catch (error) {
          console.warn('Formula rendering failed; showing source:', error);
          content.textContent = a.latex;
        }
        t.appendChild(content);
        const placed = await placeContent(a, t, content, true);
        animation = fadeIn(t, durationMs);
        record({ type: 'write_formula', latex: a.latex, at: placed.at });
        break;
      }
      case 'highlight': {
        const found = findTarget(a.target);
        if (!found) { console.warn('highlight: unknown target', a.target); return; }
        const target = found.node;
        const color = a.color || 'red';
        const shape = state.find(s => s.type === 'draw_shape' && s.id === a.target);
        if (a.part === 'hypotenuse' && shape && shape.shape === 'triangle') {
          // For a triangle, the hypotenuse is the longest side.
          const pts = shape.points;
          let best = null, bestLen = -1;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i], q = pts[(i + 1) % pts.length];
            const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (len > bestLen) { bestLen = len; best = [p, q]; }
          }
          const l = pen.line(...best[0], ...best[1], { ...PEN, stroke: color, strokeWidth: 6 });
          target.appendChild(l);
          animation = revealStroke(l, durationMs);
        } else {
          const outline = target.cloneNode(true);
          outline.removeAttribute('data-id');
          outline.querySelectorAll('path').forEach(path => {
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', 6);
          });
          target.appendChild(outline);
          animation = revealStroke(outline, durationMs);
        }
        record({ type: 'highlight', target: a.target, part: a.part, color });
        break;
      }
      case 'erase': {
        if (a.target) {
          for (const node of svg.querySelectorAll('[data-id], [data-owner]')) {
            if (node.getAttribute('data-id') === a.target || node.getAttribute('data-owner') === a.target) node.remove();
          }
          layout.remove(a.target);
          state = state.filter(s => s.id !== a.target && s.target !== a.target);
        } else {
          clearBoard();
        }
        break;
      }
      case 'draw_svg': {
        const { image, bounds } = await svgImage(a.svg);
        svg.appendChild(image);
        layout.reserve({ ...bounds, diagram: true });
        animation = fadeIn(image, durationMs);
        record({ type: 'draw_svg', svg: a.svg });
        break;
      }
      case 'array': {
        // Expands into ordinary boxes and labels (ids: <id>-0, <id>-1, ...) so later steps can target them.
        const parts = window.boardHelpers.array(a.values, a.id ? { prefix: a.id } : {});
        for (const part of parts) if (validAction(part)) await drawAction(part, durationMs / parts.length);
        return;
      }
      case 'flowchart': {
        // Mermaid renders a draw_svg (strict security, no HTML labels).
        const diagram = await window.flowHelpers.flowchart(a.source);
        return drawAction(diagram, durationMs);
      }
      case 'linked_list': case 'binary_tree': case 'call_stack': {
        const helper = { linked_list: 'linkedList', binary_tree: 'binaryTree', call_stack: 'stackFrames' }[a.type];
        const parts = window.boardHelpers[helper](a.values, a.id ? { prefix: a.id } : {});
        for (const part of parts) if (validAction(part)) await drawAction(part, durationMs / parts.length);
        return;
      }
      case 'plot': {
        // The AI's formula is read by expr.js (no eval), sampled to pick ranges, drawn by graph-helpers.
        const fn = window.parseExpr(a.fn);
        let [xmin, xmax] = a.xRange || [-5, 5];
        xmin = Math.min(xmin, 0); xmax = Math.max(xmax, 0); // the helper's axes need 0 in range
        let yRange = a.yRange;
        if (!yRange) {
          const ys = [];
          for (let i = 0; i <= 200; i++) {
            const y = fn(xmin + ((xmax - xmin) * i) / 200);
            if (Number.isFinite(y) && Math.abs(y) < 1e6) ys.push(y);
          }
          const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys), pad = (hi - lo) * 0.1 || 1;
          yRange = [lo - pad, hi + pad];
        } else {
          yRange = [Math.min(yRange[0], 0), Math.max(yRange[1], 0)];
        }
        const graph = window.graphHelpers.functionPlot(fn, { xRange: [xmin, xmax], yRange });
        await drawAction(graph.axes, durationMs / 3);
        return drawAction(graph.curve, (durationMs * 2) / 3);
      }
      default:
        console.warn('Unknown action type, skipping:', a.type);
        return;
    }
    // Wait for actual animation completion as well as the narration time slot.
    await Promise.all([sleep(durationMs), animation]);
  }

  // Plays one step: speech and drawing start together, resolves when BOTH finish.
  async function playStep(step, speak) {
    if (!object(step) || typeof step.say !== 'string') {
      console.warn('Malformed step, skipping:', step);
      return;
    }
    const total = estimateMs(step.say);
    if (!Array.isArray(step.actions)) console.warn('Malformed actions, using speech only');
    const actions = Array.isArray(step.actions) ? step.actions.filter(validAction) : [];
    const weight = actions.reduce((sum, action) => sum + (ACTION_WEIGHT[action.type] || 0), 0);

    const speaking = (async () => {
      if (speak) await speak(step.say);
      else await sleep(total);
    })();
    const drawing = (async () => {
      for (const a of actions) {
        const duration = weight ? total * (ACTION_WEIGHT[a.type] || 0) / weight : 0;
        try { await drawAction(a, duration); }
        catch (e) { console.warn('action failed, skipping:', a && a.type, e); }
      }
    })();
    const results = await Promise.allSettled([speaking, drawing]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  async function playScript(script, speak) {
    if (!object(script) || !Array.isArray(script.steps)) {
      console.warn('Malformed script, skipping: expected a steps array');
      return;
    }
    for (const step of script.steps) {
      await playStep(step, speak);
    }
    // Save to history after successful playback.
    history.push({
      topic: script.topic || 'Untitled',
      script: JSON.parse(JSON.stringify(script)),
      snapshot: getBoardState(),
      timestamp: Date.now(),
    });
  }

  function getBoardState() { return JSON.parse(JSON.stringify(state)); }

  function clearBoard() {
    state = [];
    notes = [];
    layout = new BoardLayout();
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    addDefs();
  }

  function addDefs() {
    svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, rx: 8, fill: '#fdfdf8', 'pointer-events': 'none' }));
    const defs = el('defs');
    const marker = el('marker', { id: 'arrowhead', markerWidth: 10, markerHeight: 7, refX: 9, refY: 3.5, orient: 'auto' });
    marker.appendChild(el('polygon', { points: '0 0, 10 3.5, 0 7', fill: '#222' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
  }

  function getHistory() { return JSON.parse(JSON.stringify(history)); }
  function clearHistory() { history = []; }

  addDefs();
  window.board = { playScript, playStep, getBoardState, clearBoard, getHistory, clearHistory };
  // CommonJS consumers run this in the renderer, after its DOM and libraries
  // are ready. The normal browser page keeps using window.board.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.playScript = playScript;
    module.exports.playStep = playStep;
    module.exports.getBoardState = getBoardState;
    module.exports.clearBoard = clearBoard;
    module.exports.getHistory = getHistory;
    module.exports.clearHistory = clearHistory;
  }
})();
