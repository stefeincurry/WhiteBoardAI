// Optional ES-module entry for the already loaded board page. Do not initialise
// another renderer or reload board.js: both entry points share one board state.
function api() {
  const board = globalThis.window?.board;
  if (!board) throw new Error('Load the board page and its board.js before calling the board module.');
  return board;
}

export function playScript(script, speak) { return api().playScript(script, speak); }
export function playStep(step, speak) { return api().playStep(step, speak); }
export function getBoardState() { return api().getBoardState(); }
export function clearBoard() { return api().clearBoard(); }
export function getHistory() { return api().getHistory(); }
export function clearHistory() { return api().clearHistory(); }
