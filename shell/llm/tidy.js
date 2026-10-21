// tidyScript(): small, deterministic clean-ups on the AI's script before it reaches Aarav's board,
// for layout mistakes models make a lot. It never changes what is said or drawn, only where/how:
//  - lines/shapes without an id get one, and a label whose target was never drawn is pointed at the
//    nearest of them (the board skips labels with unknown targets)
//  - a note written on top of a shape becomes a label of that shape: the board lets labels sit on/in
//    their shape, but a note that collides makes it clear the whole board, diagram included
//  - a label crossing a line is pushed off it (labels inside a shape, like values in array boxes, stay)
//  - notes/formulas given exact coordinates in the right half join the board's right-hand stack
//  - a note with maths in it ("3^2 + 4^2", "sqrt(25)") becomes a write_formula, so KaTeX renders it
//  - points are pulled back onto the 800x500 board
//
//   const { script, fixes } = tidyScript(script);   // fixes = human-readable list of what changed

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
  if (a.type === 'draw_line' || a.type === 'arrow') return [a.from, a.to];
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

function pointSegmentDistance([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = dx || dy ? clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function tidyScript(input) {
  const script = JSON.parse(JSON.stringify(input));
  const fixes = [];
  const shapes = new Map(); // id -> outline, for shapes on the board so far (only ids can be targeted)
  const lines = []; // every outline drawn so far, for "is this on a line?"
  let autoId = 0;

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
  const crossesLine = (b) => lines.some((pts) => segments(pts).some(([p, q]) => segmentHitsBox(p, q, b)));
  const shapeUnder = (b) => {
    for (const [id, pts] of shapes) {
      const closed = pts.length > 3;
      if (segments(pts).some(([p, q]) => segmentHitsBox(p, q, b)) || (closed && insidePolygon(boxCentre(b), pts))) return id;
    }
    return null;
  };

  script.steps.forEach((step, s) => {
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

      if (a.type === 'erase') {
        if (a.target) shapes.delete(a.target);
        else shapes.clear(), (lines.length = 0);
      } else if (a.type === 'draw_shape' || a.type === 'draw_line' || a.type === 'arrow') {
        const pts = outline(a);
        lines.push(pts);
        if (!a.id && a.type !== 'arrow') a.id = `auto${++autoId}`; // the contract has no id on arrows
        if (a.id) shapes.set(a.id, pts);
      }

      if (a.type === 'write_text' && typeof a.text === 'string' && /\^|sqrt\(/.test(a.text)) {
        fixes.push(`${where} "${a.text}": -> write_formula`);
        a.type = 'write_formula';
        a.latex = a.text.replace(/sqrt\(([^)]*)\)/g, '\\sqrt{$1}');
        delete a.text;
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
  });
  return { script, fixes };
}

module.exports = { tidyScript };
