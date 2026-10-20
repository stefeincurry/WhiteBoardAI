// Starter whiteboard (Aarav's side). Plain SVG, no libraries yet.
// TODO (see AGENTS.md): rough.js look, KaTeX, JSXGraph, Mermaid, CS helpers.
//
// Public API (matches shared/contract.d.ts):
//   window.board.playScript(script, speak)
//   window.board.playStep(step, speak)
//   window.board.getBoardState()
//   window.board.clearBoard()

(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('board');
  const W = 800, H = 500;

  // Where text/formulas go when no `at` is given.
  const REGIONS = {
    left:   [40, 60],
    right:  [440, 120],
    top:    [40, 40],
    bottom: [40, 470],
  };

  // Everything drawn so far, for getBoardState() (sent back to the AI on follow-ups).
  let state = [];
  // Next free y-offset per region so repeated text doesn't overlap.
  let regionCursor = {};

  const el = (name, attrs = {}) => {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Estimated speech duration so drawing finishes about when the voice does.
  // Replace with the real audio duration if Kabir's speak() can report it.
  const estimateMs = (text) => Math.max(1200, text.split(/\s+/).length * 380);

  function shapeEl(a) {
    const pts = a.points || [];
    if (a.shape === 'circle' && pts.length >= 2) {
      const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      return el('circle', { cx: pts[0][0], cy: pts[0][1], r });
    }
    if (a.shape === 'rect' && pts.length >= 2) {
      const x = Math.min(pts[0][0], pts[1][0]), y = Math.min(pts[0][1], pts[1][1]);
      return el('rect', { x, y, width: Math.abs(pts[1][0] - pts[0][0]), height: Math.abs(pts[1][1] - pts[0][1]) });
    }
    return el('polygon', { points: pts.map(p => p.join(',')).join(' ') });
  }

  // Animate a stroke "drawing itself" over durationMs.
  function revealStroke(node, durationMs) {
    let len = 400;
    try { len = node.getTotalLength ? node.getTotalLength() : 400; } catch (e) {}
    node.style.strokeDasharray = len;
    node.style.strokeDashoffset = len;
    node.getBoundingClientRect(); // force layout
    node.style.transition = `stroke-dashoffset ${durationMs}ms linear`;
    node.style.strokeDashoffset = 0;
  }

  function placeText(a, fallbackRegion) {
    if (a.at) return a.at;
    const region = a.region || fallbackRegion || 'right';
    const base = REGIONS[region] || REGIONS.right;
    const n = regionCursor[region] || 0;
    regionCursor[region] = n + 1;
    return [base[0], base[1] + n * 50];
  }

  // Draw one action. Returns when its animation is done.
  async function drawAction(a, durationMs) {
    switch (a.type) {
      case 'draw_line':
      case 'arrow': {
        const line = el('line', {
          x1: a.from[0], y1: a.from[1], x2: a.to[0], y2: a.to[1],
          stroke: '#222', 'stroke-width': 3, 'stroke-linecap': 'round',
        });
        if (a.type === 'arrow') line.setAttribute('marker-end', 'url(#arrowhead)');
        svg.appendChild(line);
        revealStroke(line, durationMs);
        state.push({ type: a.type, id: a.id, from: a.from, to: a.to });
        break;
      }
      case 'draw_shape': {
        const s = shapeEl(a);
        s.setAttribute('fill', 'none');
        s.setAttribute('stroke', '#222');
        s.setAttribute('stroke-width', 3);
        s.setAttribute('stroke-linejoin', 'round');
        if (a.id) s.setAttribute('data-id', a.id);
        svg.appendChild(s);
        revealStroke(s, durationMs);
        state.push({ type: 'draw_shape', id: a.id, shape: a.shape, points: a.points });
        break;
      }
      case 'label':
      case 'write_text': {
        const [x, y] = a.type === 'label' ? a.at : placeText(a, 'left');
        const t = el('text', { x, y, 'font-size': 24, fill: '#1a3d7c', 'font-family': 'Comic Sans MS, cursive, sans-serif', opacity: 0 });
        t.textContent = a.text;
        svg.appendChild(t);
        t.style.transition = `opacity ${Math.min(durationMs, 500)}ms`;
        t.getBoundingClientRect();
        t.style.opacity = 1;
        state.push({ type: a.type, text: a.text, at: [x, y], target: a.target });
        break;
      }
      case 'write_formula': {
        // TODO: KaTeX. For now show the raw LaTeX as text.
        const [x, y] = placeText(a, 'right');
        const t = el('text', { x, y, 'font-size': 34, fill: '#8b1a1a', 'font-family': 'serif', opacity: 0 });
        t.textContent = a.latex;
        svg.appendChild(t);
        t.style.transition = `opacity ${Math.min(durationMs, 500)}ms`;
        t.getBoundingClientRect();
        t.style.opacity = 1;
        state.push({ type: 'write_formula', latex: a.latex, at: [x, y] });
        break;
      }
      case 'highlight': {
        const target = svg.querySelector(`[data-id="${a.target}"]`);
        if (!target) { console.warn('highlight: unknown target', a.target); break; }
        const color = a.color || 'red';
        if (a.part === 'hypotenuse' && target.tagName === 'polygon') {
          // For a triangle, the hypotenuse is the longest side.
          const pts = target.getAttribute('points').split(' ').map(p => p.split(',').map(Number));
          let best = null, bestLen = -1;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i], q = pts[(i + 1) % pts.length];
            const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (len > bestLen) { bestLen = len; best = [p, q]; }
          }
          const l = el('line', { x1: best[0][0], y1: best[0][1], x2: best[1][0], y2: best[1][1], stroke: color, 'stroke-width': 7, 'stroke-linecap': 'round' });
          svg.appendChild(l);
          revealStroke(l, durationMs);
        } else {
          target.setAttribute('stroke', color);
          target.setAttribute('stroke-width', 6);
        }
        state.push({ type: 'highlight', target: a.target, part: a.part, color });
        break;
      }
      case 'erase': {
        if (a.target) {
          const t = svg.querySelector(`[data-id="${a.target}"]`);
          if (t) t.remove();
          state = state.filter(s => s.id !== a.target);
        } else {
          clearBoard();
        }
        break;
      }
      case 'draw_svg': {
        // TODO: sanitise before trusting model-written SVG.
        const g = el('g');
        g.innerHTML = a.svg;
        svg.appendChild(g);
        state.push({ type: 'draw_svg' });
        break;
      }
      default:
        console.warn('Unknown action type, skipping:', a.type);
    }
    await sleep(durationMs);
  }

  // Plays one step: speech and drawing start together, resolves when BOTH finish.
  async function playStep(step, speak) {
    const total = estimateMs(step.say);
    const actions = step.actions || [];
    const per = actions.length ? Math.max(500, total / actions.length) : 0;

    const speaking = Promise.resolve(speak ? speak(step.say) : sleep(total));
    const drawing = (async () => {
      for (const a of actions) {
        try { await drawAction(a, per); }
        catch (e) { console.warn('action failed, skipping:', a && a.type, e); }
      }
    })();
    await Promise.all([speaking, drawing]);
  }

  async function playScript(script, speak) {
    for (const step of (script.steps || [])) {
      await playStep(step, speak);
    }
  }

  function getBoardState() { return JSON.parse(JSON.stringify(state)); }

  function clearBoard() {
    state = [];
    regionCursor = {};
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    addDefs();
  }

  function addDefs() {
    const defs = el('defs');
    const marker = el('marker', { id: 'arrowhead', markerWidth: 10, markerHeight: 7, refX: 9, refY: 3.5, orient: 'auto' });
    marker.appendChild(el('polygon', { points: '0 0, 10 3.5, 0 7', fill: '#222' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
  }

  addDefs();
  window.board = { playScript, playStep, getBoardState, clearBoard };
})();
