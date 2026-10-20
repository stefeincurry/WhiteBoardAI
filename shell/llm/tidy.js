// tidyScript(): small, deterministic clean-ups on the AI's script before it reaches the board,
// for layout mistakes models make a lot. It never changes what is said or drawn, only where:
//  - a label touching a line, or sitting inside its shape, is pushed outward until it's clear
//  - notes/formulas given exact coordinates in the right half join the board's right-hand stack,
//    so they can't land on top of the stacked ones; long notes there are split (the board doesn't wrap)
//  - points are pulled back onto the 800x500 board
//
//   const { script, fixes } = tidyScript(script);   // fixes = human-readable list of what moved

const W = 800;
const H = 500;
const CHAR_W = 12; // board.js draws labels/text at 24px, anchored at the bottom-left corner
const TEXT_H = 18; // visible letter height at 24px (a bigger box nudges labels that aren't touching)
const MAX_NOTE_CHARS = 28; // the right column starts at x 440, so ~28 characters fit
const RIGHT_HALF_X = 400;
const PUSH_STEP = 4;
const PUSH_MAX = 25; // steps, so at most 100px

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const textBox = ([x, y], text) => ({ x0: x, y0: y - TEXT_H, x1: x + CHAR_W * text.length, y1: y + 4 });

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

function tidyScript(input) {
  const script = JSON.parse(JSON.stringify(input));
  const fixes = [];
  const shapes = new Map(); // id (or anon key) -> outline, as drawn so far
  let anon = 0;

  script.steps.forEach((step, s) => {
    const out = [];
    for (const a of step.actions) {
      const where = `step ${s + 1} ${a.type}`;

      if ((a.type === 'write_text' || a.type === 'write_formula') && Array.isArray(a.at) && a.at[0] >= RIGHT_HALF_X) {
        fixes.push(`${where}: at [${a.at}] -> region "right" (joins the right-hand stack)`);
        delete a.at;
        a.region = 'right';
      }

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
        else shapes.clear();
      } else if (a.type === 'draw_shape' || a.type === 'draw_line' || a.type === 'arrow') {
        shapes.set(a.id || `#${anon++}`, outline(a));
      }

      if (a.type === 'label' && Array.isArray(a.at) && a.text) {
        const target = shapes.get(a.target);
        const segs = [...shapes.values()].flatMap((pts) => pts.slice(1).map((q, i) => [pts[i], q]));
        const blocked = (at) => {
          const b = textBox(at, a.text);
          const centre = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
          return segs.some(([p, q]) => segmentHitsBox(p, q, b)) || (target && target.length > 3 && insidePolygon(centre, target));
        };
        if (blocked(a.at)) {
          // Push away from the target's centre (or straight up if there's no target).
          const pts = target ? target.slice(0, target.length > 3 ? -1 : undefined) : [a.at]; // drop the closing point
          const c = pts.reduce(([sx, sy], [x, y]) => [sx + x / pts.length, sy + y / pts.length], [0, 0]);
          const b = textBox(a.at, a.text);
          let dx = (b.x0 + b.x1) / 2 - c[0], dy = (b.y0 + b.y1) / 2 - c[1];
          const len = Math.hypot(dx, dy);
          [dx, dy] = len < 1 ? [0, -1] : [dx / len, dy / len];
          let at = a.at;
          for (let i = 1; i <= PUSH_MAX && blocked(at); i++) {
            at = [Math.round(a.at[0] + dx * PUSH_STEP * i), Math.round(a.at[1] + dy * PUSH_STEP * i)];
          }
          if (!blocked(at)) {
            fixes.push(`${where} "${a.text}": [${a.at}] -> [${at}] (was on a line / inside the shape)`);
            a.at = at;
          }
        }
        // keep the whole label on the board
        a.at = [clamp(a.at[0], 0, W - CHAR_W * a.text.length), clamp(a.at[1], TEXT_H, H)];
      }

      // Long notes placed by region: split into lines the board can fit (it stacks region text 50px apart).
      if (a.type === 'write_text' && !a.at && a.text && a.text.length > MAX_NOTE_CHARS) {
        const lines = [];
        for (const word of a.text.split(/\s+/)) {
          const last = lines[lines.length - 1];
          if (last && (last + ' ' + word).length <= MAX_NOTE_CHARS) lines[lines.length - 1] = last + ' ' + word;
          else lines.push(word);
        }
        fixes.push(`${where}: split "${a.text.slice(0, 30)}..." into ${lines.length} lines`);
        for (const line of lines) out.push({ ...a, text: line });
        continue;
      }
      out.push(a);
    }
    step.actions = out;
  });
  return { script, fixes };
}

module.exports = { tidyScript };
