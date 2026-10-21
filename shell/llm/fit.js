// Will the board have to wipe itself to fit this script's notes?
//
// Aarav's board places notes and formulas in free space; when a note can't fit anywhere it CLEARS THE
// WHOLE BOARD (diagram included) and carries on. That's fine for one long answer, but a follow-up that
// adds notes to a full board would erase the very drawing it is about. So before a script goes to the
// board we replay it through the board's own placement code (board/layout.js, read-only) with estimated
// text sizes, and drop the notes that would trigger a wipe. The voice still says everything.
//
//   fitNotes(script, existing, fixes)  -> mutates script (drops notes that would wipe the board)
//   noteRoom(existing)                 -> how many more short notes fit before a wipe (for the prompt)

let BoardLayout = null;
try {
  BoardLayout = require('../../board/layout.js');
} catch {
  // the board's layout module moved or broke: skip this check rather than crash the pipeline
}

const W = 800;
const CHAR_W = 13; // wider than the real ~11px average at 24px, so we err on the safe side
const LINE_H = 34;
const FORMULA_H = 72; // the board's own fallback height for a formula
const FORMULA_CHAR_W = 15;

const isNote = (a) => a.type === 'write_text' || a.type === 'write_formula';

/** Width/height the board would give this text or formula (estimates; the board measures real fonts). */
function measure(a, region) {
  const area = BoardLayout.region(region);
  const available = Math.max(32, a.at ? W - Math.max(16, a.at[0]) - 16 : area.width);
  if (a.type === 'write_formula') {
    const visible = String(a.latex || '').replace(/\\[a-zA-Z]+/g, 'x').replace(/[{}^_]/g, '');
    const width = Math.max(24, visible.length * FORMULA_CHAR_W);
    const scale = Math.min(1, available / width, 460 / FORMULA_H);
    return { w: Math.ceil(Math.min(available, width * scale)), h: Math.ceil(FORMULA_H * scale) };
  }
  const len = String(a.text || '').length * CHAR_W;
  const lines = Math.max(1, Math.ceil(len / available));
  return { w: Math.ceil(Math.min(available, Math.max(24, len))), h: lines * LINE_H };
}

const regionOf = (a) => a.region || (a.at ? (a.at[0] >= 400 ? 'right' : 'left') : a.type === 'write_formula' ? 'right' : 'left');

function diagramBox(a) {
  let pts = a.points || (Array.isArray(a.from) && Array.isArray(a.to) ? [a.from, a.to] : []);
  if (a.shape === 'circle' && pts.length >= 2) {
    const [[cx, cy], [ex, ey]] = pts;
    const r = Math.hypot(ex - cx, ey - cy);
    pts = [[cx - r, cy - r], [cx + r, cy + r]];
  }
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), diagram: true };
}

/** Mirrors board.js placeContent(): returns the box, or null if the board would have to wipe itself. */
function place(layout, a) {
  const region = regionOf(a);
  const { w, h } = measure(a, region);
  const at = a.at && [a.at[0], a.at[1] - (a.type === 'write_formula' ? 34 : 24)];
  const target = a.type === 'label' ? a.target : undefined;
  let box = layout.place(w, h, region, at, target);
  if (!box && !at && !target) {
    for (const alt of ['left', 'right', 'top', 'bottom']) {
      if (alt === region) continue;
      box = layout.place(w, h, alt);
      if (box) break;
    }
  }
  return box;
}

/** A layout with what's on the board already (getBoardState items, positions as they landed). */
function layoutFor(existing) {
  const layout = new BoardLayout();
  for (const it of Array.isArray(existing) ? existing : []) apply(layout, it, true);
  return layout;
}

/** Applies one action (or existing item) to the layout. Returns false if it would wipe the board. */
function apply(layout, a, already = false) {
  if (!a || typeof a !== 'object') return true;
  if (a.type === 'draw_shape' || a.type === 'draw_line' || a.type === 'arrow') {
    const box = diagramBox(a);
    if (box) layout.reserve(box, a.id);
  } else if (a.type === 'draw_svg') {
    layout.reserve({ x: 40, y: 80, width: 720, height: 340, diagram: true });
  } else if (a.type === 'erase') {
    if (a.target) layout.remove(a.target);
    else layout.items = [];
  } else if (isNote(a) || a.type === 'label') {
    if (already) {
      // Existing notes: the board state has where they actually landed.
      if (!Array.isArray(a.at)) return true;
      const { w, h } = measure(a, regionOf(a));
      layout.reserve({ x: a.at[0], y: a.at[1] - (a.type === 'write_formula' ? 34 : 24), width: w, height: h }, a.target);
      return true;
    }
    const box = place(layout, a);
    if (!box) return a.type === 'label'; // a label that can't fit is skipped by the board, never a wipe
    layout.reserve(box, a.target);
  }
  return true;
}

/** Drops the notes that would make the board wipe itself (diagram included). */
function fitNotes(script, existing, fixes) {
  if (!BoardLayout) return;
  const layout = layoutFor(existing);
  script.steps.forEach((step, s) => {
    step.actions = step.actions.filter((a) => {
      if (apply(layout, a)) return true;
      const what = a.type === 'write_formula' ? a.latex : a.text;
      fixes.push(`step ${s + 1} ${a.type} "${String(what).slice(0, 40)}": dropped (no room left: the board would wipe itself)`);
      return false;
    });
  });
}

/** How many more short notes (~20 characters) fit before the board would wipe itself. */
function noteRoom(existing, max = 8) {
  if (!BoardLayout) return null;
  const layout = layoutFor(existing);
  for (let n = 0; n < max; n++) {
    if (!apply(layout, { type: 'write_text', text: 'x'.repeat(20), region: 'right' })) return n;
  }
  return max;
}

module.exports = { fitNotes, noteRoom };
