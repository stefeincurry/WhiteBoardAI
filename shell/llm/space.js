// Where things are on the 800x500 board, and where there's room: for follow-ups, which add to a board
// that already has drawings and notes on it.
//
//   occupied(boardState)        -> [{ x0, y0, x1, y1, kind }]   kind: 'shape' or 'text'
//   emptyAreas(boxes, n, within)        -> the n biggest empty rectangles, biggest first
//   findSpot(boxes, w, h, near, within) -> top-left [x, y] for a w x h box clear of every box, closest to `near`
//   within: the part of the board to search, e.g. DRAW_AREA (the left half: the right column is for notes)

const W = 800;
const H = 500;
const MARGIN = 20; // keep away from the board's edges
const PAD = 12; // breathing room around things
const CELL = 20; // grid size for the empty-space search
const CHAR_W = 12;
const LINE_H = 32;
const NOTE_WIDTH = 340; // the board wraps notes at about this width

const box = (x0, y0, x1, y1, kind) => ({ x0, y0, x1, y1, kind });
const BOARD_AREA = box(MARGIN, MARGIN, W - MARGIN, H - MARGIN);
const DRAW_AREA = box(MARGIN, MARGIN, 400, H - MARGIN); // the board stacks new notes on the right
const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Rough boxes for what getBoardState() says is on the board. */
function occupied(state = []) {
  const out = [];
  for (const it of Array.isArray(state) ? state : []) {
    if (!it || typeof it !== 'object') continue;
    const pts = it.points || (Array.isArray(it.from) && Array.isArray(it.to) ? [it.from, it.to] : null);
    if ((it.type === 'draw_shape' || it.type === 'draw_line' || it.type === 'arrow') && Array.isArray(pts) && pts.length) {
      let xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      if (it.shape === 'circle' && pts.length >= 2) {
        const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        xs = [pts[0][0] - r, pts[0][0] + r];
        ys = [pts[0][1] - r, pts[0][1] + r];
      }
      out.push(box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 'shape'));
    } else if ((it.type === 'write_text' || it.type === 'label') && Array.isArray(it.at) && it.text) {
      const width = Math.min(CHAR_W * it.text.length, NOTE_WIDTH);
      const lines = Math.ceil((CHAR_W * it.text.length) / NOTE_WIDTH);
      out.push(box(it.at[0], it.at[1] - 26, it.at[0] + width, it.at[1] - 26 + lines * LINE_H, it.type === 'label' ? 'label' : 'text'));
    } else if (it.type === 'write_formula' && Array.isArray(it.at)) {
      const width = Math.min(14 * String(it.latex || '').length, NOTE_WIDTH);
      out.push(box(it.at[0], it.at[1] - 36, it.at[0] + width, it.at[1] + 12, 'text'));
    } else if (it.type === 'draw_svg') {
      out.push(box(40, 80, 760, 420, 'shape')); // generated diagrams fill the middle of the board
    }
  }
  return out;
}

/** Grid of free cells (true = empty) inside `within`, with PAD around every box. */
function freeGrid(boxes, within) {
  const cols = Math.floor((within.x1 - within.x0) / CELL), rows = Math.floor((within.y1 - within.y0) / CELL);
  const grid = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const cell = box(within.x0 + c * CELL, within.y0 + r * CELL, within.x0 + (c + 1) * CELL, within.y0 + (r + 1) * CELL);
      return !boxes.some((b) => overlaps(cell, box(b.x0 - PAD, b.y0 - PAD, b.x1 + PAD, b.y1 + PAD)));
    })
  );
  return { grid, rows, cols, within };
}

/** The n biggest empty rectangles (by area), found one at a time on the free grid. */
function emptyAreas(boxes, n = 2, within = BOARD_AREA) {
  const taken = [...boxes];
  const areas = [];
  for (let k = 0; k < n; k++) {
    const { grid, rows, cols } = freeGrid(taken, within);
    // Largest rectangle of free cells: for each row, a histogram of free cells above, then a stack scan.
    const heights = new Array(cols).fill(0);
    let best = null;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) heights[c] = grid[r][c] ? heights[c] + 1 : 0;
      const stack = [];
      for (let c = 0; c <= cols; c++) {
        const h = c < cols ? heights[c] : 0;
        while (stack.length && heights[stack[stack.length - 1]] >= h) {
          const top = stack.pop();
          const height = heights[top];
          const left = stack.length ? stack[stack.length - 1] + 1 : 0;
          const area = height * (c - left);
          if (height && (!best || area > best.area)) best = { area, c0: left, c1: c, r0: r - height + 1, r1: r + 1 };
        }
        stack.push(c);
      }
    }
    if (!best || best.area < 12) break; // smaller than ~5x2 cells isn't worth mentioning
    const area = box(within.x0 + best.c0 * CELL, within.y0 + best.r0 * CELL, within.x0 + best.c1 * CELL, within.y0 + best.r1 * CELL);
    areas.push(area);
    taken.push(area);
  }
  return areas;
}

/** Top-left corner for a w x h box clear of every box (with PAD), as close as possible to `near`. */
function findSpot(boxes, w, h, near = [MARGIN, MARGIN], within = BOARD_AREA) {
  let best = null;
  for (let y = within.y0; y + h <= within.y1; y += 10) {
    for (let x = within.x0; x + w <= within.x1; x += 10) {
      const b = box(x, y, x + w, y + h);
      if (boxes.some((o) => overlaps(b, box(o.x0 - PAD, o.y0 - PAD, o.x1 + PAD, o.y1 + PAD)))) continue;
      const d = Math.hypot(x - near[0], y - near[1]);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best && [best.x, best.y];
}

const describeArea = (a) => `x ${Math.round(a.x0)}-${Math.round(a.x1)}, y ${Math.round(a.y0)}-${Math.round(a.y1)}`;

module.exports = { occupied, emptyAreas, findSpot, overlaps, describeArea, DRAW_AREA, BOARD_AREA };
