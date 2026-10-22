// tidyScript(): small, deterministic clean-ups on the AI's script before it reaches Aarav's board,
// for layout mistakes models make a lot. It never changes what is said or drawn, only where/how:
//  - follow-up: new drawings that land on the notes/formulas already on the board, or cover the inside of
//    a shape that's there, move with their labels to the nearest free spot (sharing an edge is fine:
//    a square built on a triangle's side)
//  - lines/shapes without an id get one, and a label whose target was never drawn is pointed at the
//    nearest of them (the board skips labels with unknown targets)
//  - a note written on top of a shape becomes a label of that shape: the board lets labels sit on/in
//    their shape, but a note that collides makes it clear the whole board, diagram included
//  - a label crossing a line is pushed off it (labels inside a shape, like values in array boxes, stay)
//  - notes/formulas given exact coordinates in the right half join the board's right-hand stack
//  - a note that is pure maths ("3^2 + 4^2 = 25", "sqrt(25) = 5") becomes a write_formula, so KaTeX renders
//    it; a sentence with a bit of maths in it ("What is 6^2?") stays text, with "6²" instead of "6^2"
//  - points are pulled back onto the 800x500 board
//
//   const { script, fixes } = tidyScript(script);   // fixes = human-readable list of what changed
//   tidyScript(script, { existing: boardState })     // follow-up: knows what's on the board already
//                                                     // (its shapes are targets and obstacles, its ids are taken)

const { occupied, findSpot, overlaps, DRAW_AREA } = require('./space');

const W = 800;
const H = 500;
const CHAR_W = 12; // labels/text are 24px, anchored at the bottom-left corner
const TEXT_H = 18; // visible letter height at 24px (a bigger box nudges labels that aren't touching)
const RIGHT_HALF_X = 400;
const PUSH_STEP = 4;
const PUSH_MAX = 30; // steps, so at most 120px

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const textBox = ([x, y], text) => ({ x0: x, y0: y - TEXT_H, x1: x + CHAR_W * text.length, y1: y + 4 });
const boxCentre = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
const segments = (pts) => pts.slice(1).map((q, i) => [pts[i], q]);

/** Shape outline as points, closed polygons repeat the first point at the end. */
function outline(a) {
  const p = a.points || [];
  // The schema doesn't require from/to: a line missing one has no outline (the board drops it anyway).
  if (a.type === 'draw_line' || a.type === 'arrow') return Array.isArray(a.from) && Array.isArray(a.to) ? [a.from, a.to] : [];
  if (a.shape === 'rect' && p.length >= 2) {
    const [[x0, y0], [x1, y1]] = p;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  }
  if (a.shape === 'circle' && p.length >= 2) {
    const [[cx, cy], [ex, ey]] = p;
    const r = Math.hypot(ex - cx, ey - cy);
    return Array.from({ length: 17 }, (_, i) => [cx + r * Math.cos((i * Math.PI) / 8), cy + r * Math.sin((i * Math.PI) / 8)]);
  }
  return p.length > 2 ? [...p, p[0]] : p;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segmentsCross(p, q, r, s) {
  const d1 = cross(r, s, p), d2 = cross(r, s, q), d3 = cross(p, q, r), d4 = cross(p, q, s);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function segmentHitsBox(p, q, b) {
  const inBox = ([x, y]) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  if (inBox(p) || inBox(q)) return true;
  const c = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x0, b.y0]];
  for (let i = 0; i < 4; i++) if (segmentsCross(p, q, c[i], c[i + 1])) return true;
  return false;
}
function insidePolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const MATHS_WORDS = /\b(sqrt|frac|sin|cos|tan|log|ln|pi|theta|alpha|beta|lambda|Delta|times|cdot)\b/g;

const GEOMETRY = new Set(['draw_shape', 'draw_line', 'arrow']);

/**
 * Follow-up: the AI often draws its new shapes over the notes already on the board. If the new drawings
 * (with their labels) overlap existing notes/formulas, shift them together, keeping their layout,
 * to the nearest spot that is clear of everything (left half first: new notes stack on the right).
 */
function moveOffNotes(steps, existing, fixes) {
  const none = { dx: 0, dy: 0 };
  const boxes = occupied(existing);
  const acts = steps.flatMap((s) => s.actions).filter((a) => a && typeof a === 'object');
  const geo = acts.filter(hasGeometry);
  if (!geo.length) return none;
  const newIds = new Set(geo.map((a) => a.id).filter(Boolean));
  const geoBoxes = occupied(geo);
  const near = (at) => geoBoxes.some((b) => at[0] > b.x0 - 40 && at[0] < b.x1 + 40 && at[1] > b.y0 - 40 && at[1] < b.y1 + 40);
  const texts = acts.filter(
    (a) => (a.type === 'label' || a.type === 'write_text') && Array.isArray(a.at) && (newIds.has(a.target) || (a.type === 'write_text' && near(a.at)))
  );
  // A label far away from its own new shape is a mistake (it would make the group huge): put it under its shape.
  for (const a of texts) {
    const own = geo.find((s) => s.id === a.target);
    if (!own) continue;
    const [b] = occupied([own]);
    const far = a.at[0] < b.x0 - 40 || a.at[0] > b.x1 + 40 || a.at[1] < b.y0 - 40 || a.at[1] > b.y1 + 60;
    if (far) {
      const at = [Math.round((b.x0 + b.x1) / 2 - (CHAR_W * a.text.length) / 2), Math.round(b.y1 + 26)];
      fixes.push(`label "${a.text}": [${a.at}] -> [${at}] (was far from its shape "${a.target}")`);
      a.at = at;
    }
  }
  const group = [...geoBoxes, ...occupied(texts)];
  const g = {
    x0: Math.min(...group.map((b) => b.x0)), y0: Math.min(...group.map((b) => b.y0)),
    x1: Math.max(...group.map((b) => b.x1)), y1: Math.max(...group.map((b) => b.y1)),
  };
  const onNotes = boxes.some((b) => b.kind === 'text' && overlaps(g, b));
  const closedOld = existing.filter((it) => it && it.type === 'draw_shape').map(outline).filter((pts) => pts.length > 3);
  const onShape = geo.some((a) => a.type === 'draw_shape' && coveredFraction(outline(a), closedOld) > 0.15);
  if (!onNotes && !onShape) return none;
  const w = g.x1 - g.x0, h = g.y1 - g.y0;
  const spot = findSpot(boxes, w, h, [g.x0, g.y0], DRAW_AREA) || findSpot(boxes, w, h, [g.x0, g.y0]);
  if (!spot) {
    fixes.push(`follow-up drawing (${Math.round(w)}x${Math.round(h)}) sits on the notes, but there's no free spot that big`);
    return none;
  }
  const dx = Math.round(spot[0] - g.x0), dy = Math.round(spot[1] - g.y0);
  const shift = ([x, y]) => [x + dx, y + dy];
  for (const a of geo) shiftGeometry(a, dx, dy);
  for (const a of texts) a.at = shift(a.at);
  const what = onNotes ? 'the notes' : 'a shape';
  fixes.push(`follow-up drawing moved by [${dx},${dy}] off ${what} already on the board (${geo.length} shapes, ${texts.length} labels)`);
  return { dx, dy };
}

const hasGeometry = (a) => a && GEOMETRY.has(a.type) && (Array.isArray(a.points) || (Array.isArray(a.from) && Array.isArray(a.to)));

function shiftGeometry(a, dx, dy) {
  const shift = ([x, y]) => [x + dx, y + dy];
  if (Array.isArray(a.points)) a.points = a.points.map(shift);
  if (Array.isArray(a.from)) a.from = shift(a.from);
  if (Array.isArray(a.to)) a.to = shift(a.to);
}

/**
 * Follow-ups, one step at a time: the first step that draws something decides whether the new drawing
 * has to move off the notes/shapes already there; later steps move by the same offset, so shapes built
 * on each other (a square on a side drawn in step 1) stay together.
 * move: undefined = not decided yet, else { dx, dy, ids: new shape ids, boxes: where they were drawn }.
 */
function followUpMove(step, existing, move, fixes) {
  const geo = step.actions.filter(hasGeometry);
  if (move === undefined) {
    if (!geo.length) return undefined;
    const boxes = occupied(geo); // before moving: later notes are matched against where the AI meant them
    const { dx, dy } = moveOffNotes([step], existing, fixes);
    return { dx, dy, ids: new Set(geo.map((a) => a.id).filter(Boolean)), boxes };
  }
  if (!move.dx && !move.dy) return move;
  const geoBoxes = occupied(geo);
  for (const a of geo) if (a.id) move.ids.add(a.id);
  const near = (at) => [...move.boxes, ...geoBoxes].some((b) => at[0] > b.x0 - 40 && at[0] < b.x1 + 40 && at[1] > b.y0 - 40 && at[1] < b.y1 + 40);
  for (const a of step.actions) {
    if (!a || typeof a !== 'object') continue;
    if (hasGeometry(a)) shiftGeometry(a, move.dx, move.dy);
    else if (Array.isArray(a.at) && ((a.type === 'label' && move.ids.has(a.target)) || (a.type === 'write_text' && near(a.at)))) {
      a.at = [a.at[0] + move.dx, a.at[1] + move.dy];
    }
  }
  move.boxes.push(...geoBoxes);
  return move;
}

/** How much of a closed shape's inside is covered by other closed shapes (0..1), by sampling a 12x12 grid. */
function coveredFraction(pts, others) {
  if (pts.length <= 3 || !others.length) return 0;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let inside = 0, covered = 0;
  for (let i = 0.5; i < 12; i++) {
    for (let j = 0.5; j < 12; j++) {
      const p = [x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * j) / 12];
      if (!insidePolygon(p, pts)) continue;
      inside++;
      if (others.some((o) => insidePolygon(p, o))) covered++;
    }
  }
  return inside ? covered / inside : 0;
}

/** True for "a^2 + b^2 = c^2", "sqrt(25) = 5", "x_1^2" or "\sqrt{a^2}"; false once there are real words. */
function isPureMaths(text) {
  return !/[A-Za-z]{2,}/.test(text.replace(MATHS_WORDS, '')) && !/[%&#$]/.test(text); // KaTeX chokes on %&#$
}

/** Plain maths -> LaTeX: sqrt(x) -> \sqrt{x}, 2^10 -> 2^{10}, 2^(n+1) -> 2^{(n+1)}, pi -> \pi. */
function toLatex(text) {
  return text
    .replace(/(?<!\\)sqrt\(([^)]*)\)/g, '\\sqrt{$1}')
    .replace(/\^(\d{2,}|\d*\.\d+|\([^)]*\))/g, '^{$1}')
    .replace(/(?<!\\)\b(pi|theta|alpha|beta|lambda)\b/g, '\\$1');
}

const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', n: 'ⁿ' };
/** "6^2" -> "6²", "sqrt(25)" -> "√25", for maths inside an ordinary sentence. */
function prettyMaths(text) {
  return text
    .replace(/\^([0-9n])(?![0-9.])/g, (_, d) => SUPERSCRIPT[d])
    .replace(/sqrt\(([^()]*)\)/g, (_, x) => (/^[\w.]+$/.test(x) ? `√${x}` : `√(${x})`));
}

function pointSegmentDistance([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = dx || dy ? clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/**
 * The clean-up, one step at a time (for steps that stream in while the board is already drawing).
 *   const tidier = createTidier({ existing: boardState });
 *   const { step, fixes } = tidier.step(rawStep);   // call in order, once per step
 */
function createTidier({ existing = [] } = {}) {
  const shapes = new Map(); // id -> outline, for shapes on the board so far (only ids can be targeted)
  const lines = []; // every outline drawn so far, for "is this on a line?"
  const usedIds = new Set(); // ids already on the board or in this script: auto ids must not reuse them
  let autoId = 0;
  const newId = () => {
    let id;
    do id = `auto${++autoId}`;
    while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  // A follow-up continues on the board: its shapes are already there (getBoardState() items look like actions).
  for (const item of Array.isArray(existing) ? existing : []) {
    if (item && item.id) usedIds.add(item.id);
    if (item && (item.type === 'draw_shape' || item.type === 'draw_line' || item.type === 'arrow')) {
      const pts = outline(item);
      if (pts.length) {
        lines.push(pts);
        if (item.id) shapes.set(item.id, pts);
      }
    }
  }
  const followUp = Array.isArray(existing) && existing.length > 0;
  let index = 0;
  let clearsFirst = false; // the answer starts by wiping the board: a fresh start, nothing to avoid
  let move; // see followUpMove
  let somethingDrawn = Array.isArray(existing) && existing.length > 0; // a flowchart needs the board to itself

  /** The shape (id) whose outline is nearest to a text box, or null. */
  const nearestShape = (b) => {
    let best = null, bestD = Infinity;
    for (const [id, pts] of shapes) {
      for (const [p, q] of segments(pts)) {
        const d = pointSegmentDistance(boxCentre(b), p, q);
        if (d < bestD) (best = id), (bestD = d);
      }
    }
    return best;
  };
  /** The shape (id) whose outline is within maxD of a text box, nearest first, or null. */
  const nearShape = (b, maxD) => {
    let best = null, bestD = maxD;
    for (const [id, pts] of shapes) {
      for (const [p, q] of segments(pts)) {
        const d = pointSegmentDistance(boxCentre(b), p, q);
        if (d <= bestD) (best = id), (bestD = d);
      }
    }
    return best;
  };
  const crossesLine = (b) => lines.some((pts) => segments(pts).some(([p, q]) => segmentHitsBox(p, q, b)));
  const shapeUnder = (b) => {
    for (const [id, pts] of shapes) {
      const closed = pts.length > 3;
      if (segments(pts).some(([p, q]) => segmentHitsBox(p, q, b)) || (closed && insidePolygon(boxCentre(b), pts))) return id;
    }
    return null;
  };

  function tidyStep(input) {
    const step = JSON.parse(JSON.stringify(input));
    const s = index++;
    const fixes = [];
    step.actions = Array.isArray(step.actions) ? step.actions.filter((a) => a && typeof a === 'object') : [];
    for (const a of step.actions) if (a.id) usedIds.add(a.id);
    if (s === 0) clearsFirst = !!(step.actions[0] && step.actions[0].type === 'erase' && !step.actions[0].target);
    if (followUp && !clearsFirst) move = followUpMove(step, existing, move, fixes);

    // A flowchart fills the middle of the board: drawn over anything, it's unreadable. Clear first.
    const withClears = [];
    for (const a of step.actions) {
      if (a.type === 'flowchart' && somethingDrawn) {
        withClears.push({ type: 'erase' });
        fixes.push(`step ${s + 1}: cleared the board before the flowchart (it needs the whole middle)`);
      }
      if (a.type === 'erase' && !a.target) somethingDrawn = false;
      else if (a.type !== 'highlight') somethingDrawn = true;
      withClears.push(a);
    }
    step.actions = withClears;

    for (const a of step.actions) {
      const where = `step ${s + 1} ${a.type}`;

      for (const k of ['from', 'to', 'at']) {
        if (!Array.isArray(a[k])) continue;
        const [x, y] = a[k];
        const fixed = [clamp(x, 0, W), clamp(y, 0, H)];
        if (fixed[0] !== x || fixed[1] !== y) fixes.push(`${where}: ${k} [${x},${y}] -> [${fixed}] (was off the board)`);
        a[k] = fixed;
      }
      if (Array.isArray(a.points)) a.points = a.points.map(([x, y]) => [clamp(x, 0, W), clamp(y, 0, H)]);

      if (a.type === 'array' && a.id && Array.isArray(a.values)) {
        // The board draws it as a row of boxes <id>-0, <id>-1, ... (board/cs-helpers.js: 120x80, centred, y 170).
        const n = a.values.length, start = (W - 120 * n) / 2;
        for (let i = 0; i < n; i++) {
          const x = start + 120 * i;
          const pts = outline({ type: 'draw_shape', shape: 'rect', points: [[x, 170], [x + 120, 250]] });
          lines.push(pts);
          shapes.set(`${a.id}-${i}`, pts);
          usedIds.add(`${a.id}-${i}`);
        }
      }

      if (a.type === 'erase') {
        if (a.target) shapes.delete(a.target);
        else shapes.clear(), (lines.length = 0);
      } else if (a.type === 'draw_shape' || a.type === 'draw_line' || a.type === 'arrow') {
        const pts = outline(a);
        if (pts.length) {
          // (a line missing an end point has no outline: the board drops it, so it can't be a label target)
          lines.push(pts);
          if (!a.id && a.type !== 'arrow') a.id = newId(); // the contract has no id on arrows
          if (a.id) shapes.set(a.id, pts);
        }
      }

      if (a.type === 'write_text' && typeof a.text === 'string' && /\^|sqrt\(/.test(a.text)) {
        if (isPureMaths(a.text)) {
          fixes.push(`${where} "${a.text}": -> write_formula`);
          a.type = 'write_formula';
          a.latex = toLatex(a.text);
          delete a.text;
        } else {
          const pretty = prettyMaths(a.text);
          if (pretty !== a.text) fixes.push(`${where} "${a.text}" -> "${pretty}"`);
          a.text = pretty;
        }
      }

      // Notes/formulas with exact coordinates on the right: let the board stack them instead.
      if ((a.type === 'write_text' || a.type === 'write_formula') && Array.isArray(a.at) && a.at[0] >= RIGHT_HALF_X) {
        fixes.push(`${where}: at [${a.at}] -> region "right" (joins the right-hand stack)`);
        delete a.at;
        a.region = 'right';
      }

      // A note on top of a shape: make it that shape's label (the board would otherwise clear everything).
      if (a.type === 'write_text' && Array.isArray(a.at) && a.text) {
        const id = shapeUnder(textBox(a.at, a.text));
        if (id) {
          fixes.push(`${where} "${a.text}": on top of "${id}" -> label of "${id}"`);
          a.type = 'label';
          a.target = id;
          delete a.region;
        }
      }

      // No note keeps an exact position: if it collides with anything, the board wipes itself AT ONCE
      // (it only tries other spots for notes placed by region). Next to a shape -> that shape's label
      // (labels are skipped, never wiped); anywhere else -> placed by region, on the same side.
      if ((a.type === 'write_text' || a.type === 'write_formula') && Array.isArray(a.at)) {
        const near = a.type === 'write_text' && a.text ? nearShape(textBox(a.at, a.text), 60) : null;
        if (near) {
          fixes.push(`${where} "${a.text}": next to "${near}" -> label of "${near}"`);
          a.type = 'label';
          a.target = near;
          delete a.region;
        } else {
          a.region = a.at[0] >= RIGHT_HALF_X ? 'right' : 'left';
          fixes.push(`${where}: at [${a.at}] -> region "${a.region}" (an exact spot can make the board wipe itself)`);
          delete a.at;
        }
      }

      if (a.type === 'label' && Array.isArray(a.at) && a.text) {
        if (!shapes.has(a.target)) {
          const id = nearestShape(textBox(a.at, a.text));
          if (id) {
            fixes.push(`${where} "${a.text}": target "${a.target}" was never drawn -> "${id}" (nearest shape)`);
            a.target = id;
          }
        }
        if (crossesLine(textBox(a.at, a.text))) {
          // Nearest clear spot: away from the target's centre first, then up/down/left/right.
          const target = shapes.get(a.target);
          const pts = target ? target.slice(0, target.length > 3 ? -1 : undefined) : [a.at]; // drop the closing point
          const c = pts.reduce(([sx, sy], [x, y]) => [sx + x / pts.length, sy + y / pts.length], [0, 0]);
          const [bx, by] = boxCentre(textBox(a.at, a.text));
          const len = Math.hypot(bx - c[0], by - c[1]);
          const dirs = [len < 1 ? [0, -1] : [(bx - c[0]) / len, (by - c[1]) / len], [0, -1], [0, 1], [-1, 0], [1, 0]];
          let found = null;
          for (let i = 1; i <= PUSH_MAX && !found; i++) {
            for (const [dx, dy] of dirs) {
              const at = [Math.round(a.at[0] + dx * PUSH_STEP * i), Math.round(a.at[1] + dy * PUSH_STEP * i)];
              const b = textBox(at, a.text);
              const onBoard = b.x0 >= 0 && b.x1 <= W && b.y0 >= 0 && b.y1 <= H;
              if (onBoard && !crossesLine(b)) {
                found = at;
                break;
              }
            }
          }
          if (found) {
            fixes.push(`${where} "${a.text}": [${a.at}] -> [${found}] (was on a line)`);
            a.at = found;
          }
        }
        // keep the whole label on the board
        a.at = [clamp(a.at[0], 0, W - CHAR_W * a.text.length), clamp(a.at[1], TEXT_H, H)];
      }
    }
    return { step, fixes };
  }

  return { step: tidyStep };
}

/** The whole script at once (same rules as createTidier, step by step). */
function tidyScript(input, opts = {}) {
  const tidier = createTidier(opts);
  const fixes = [];
  const steps = (input.steps || []).map((raw) => {
    const r = tidier.step(raw);
    fixes.push(...r.fixes);
    return r.step;
  });
  return { script: { ...JSON.parse(JSON.stringify(input)), steps }, fixes };
}


module.exports = { tidyScript, createTidier };
