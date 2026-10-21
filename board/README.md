# Board testing

Open `index.html` directly in a browser. All drawing libraries and fonts are local.

The board stays fully visible at a fixed view. There is no zoom, dragging or page history.

Click **Full-board demo**, choose **Silent test: fast**, then **Play script** to test filling the board.
Notes wrap and use free space; when there is no room, the same board clears and continues.
**Formula demo** checks formula rendering.

After reloading, load and play **Parabola** and **Water cycle** with **Silent test: fast**.
The parabola should show x ticks -3 to 3 in steps of 1, positive y ticks 2 to 10 in steps of 2,
and a single origin label with no nearby negative label. Flowchart labels now have a 200px
wrapping width so words such as Condensation have room. Reloading alone does not update
the JSON already in the editor: load each demo again before playing.
These appearance fixes need fresh browser screenshots; automated tests check tick generation
and Mermaid configuration, rather than the final font measurements.

The board keeps the contract's 800 x 500 drawing coordinates.
Text and formulas are measured after fonts load and placed below occupied space.
Automatic text placement tries other regions before clearing. Wide formulas scale to fit.
Explicit diagram geometry stays at its supplied coordinates; the script must still provide sensible,
in-bounds diagram points. Labels can sit inside their target diagram and avoid earlier labels.

`getBoardState()` contains only what is on the current board. Cleared drawings are removed from the snapshot and can no
longer be targeted. Prefer an explicit `erase` between sections when the script knows a clean
breakpoint. A label that cannot fit is skipped with a warning instead of clearing its own diagram.

Run automated timing and layout checks with Node:

```text
node --test board/tests/api.test.cjs board/tests/sync.test.cjs board/tests/layout.test.cjs board/tests/cs-helpers.test.cjs board/tests/graphs.test.cjs board/tests/browser-graphs.test.cjs board/tests/flows.test.cjs
```

The tests use controlled SVG/HTML measurements and animation completion signals. They verify placement
and sequencing, but are not a substitute for checking real browser rendering.

## CS helpers

Choose **Array**, **Linked list**, **Binary tree**, or **Call stack**, click **Load CS demo**,
then **Play script**. Choose browser voice or any silent test mode.
Watch the red highlight; the call-stack demo removes the top frame when the call returns.

`cs-helpers.js` exposes `window.boardHelpers` in a browser, or CommonJS exports for local tests.
These are local authoring helpers, not new AI action types. Each returns an array of existing
contract actions that can be placed in a step's `actions` field:

```js
boardHelpers.array([10, 20, 30], { prefix: 'scores' });
boardHelpers.linkedList([10, 20, 30]);
boardHelpers.binaryTree([8, 4, 12, 2, 6, 10, 14]);
boardHelpers.stackFrames(['main()', 'factorial(3)', 'factorial(2)']);
```

Array: 1–6 values, up to 6 characters each. Linked list: 1–4 values, up to 3 characters.
Binary tree: 1–7 values in level order, up to 3 characters. Call stack: 1–4 frame names,
up to 20 characters, oldest first. Keep values on a single line. Oversized inputs raise a
clear error instead of making an unreadable diagram. Automatic ID prefixes prevent collisions;
an explicit prefix lets a later highlight or erase target a node such as `scores-2`.

`boardHelpers.demo(kind)` returns a complete CS example script.

## Function graphs

Choose **Parabola**, **Straight line**, or **Sine wave**, click **Load graph demo**, then **Play script**.
Axes and scale labels appear first, followed by the animated curve, formula and a marked point.
The graph stays inside the same board, with no zoom or dragging.

`graph-helpers.js` exposes `window.graphHelpers` (or CommonJS exports). JSXGraph's NoRenderer computes
curve points; the helper converts them to the existing `draw_svg` action. No second visible board is
created. A detached HTML container satisfies JSXGraph's browser constructor requirements. All SVG
assets are generated locally, and the JSXGraph library is vendored for offline use.

```js
const plot = graphHelpers.functionPlot(x => x * x, {
  xRange: [-3, 3], yRange: [-1, 10]
});
// Put plot.axes and plot.curve in script actions, in separate steps if desired.
// plot.toBoard(0, 0) maps a mathematical point to board coordinates.
```

The helper accepts local function callbacks, never executable strings from model output.
Its actions and demo scripts are JSON-serialisable. Ranges must be finite, increasing, and contain
zero. Curves are sampled approximations; out-of-range and non-finite samples break the stroke.
This is a teaching plotter, not symbolic math verification. Sharp or very rapid changes may need
a narrower range. `graphHelpers.demo('parabola' | 'line' | 'sine')` creates a complete lesson script.
`getBoardState()` now includes SVG content for SVG actions, so follow-ups can see the graph.

## Flowcharts and cycles

Choose **Even or odd?** or **Water cycle**, click **Load flow demo**, wait for preparation, then
**Play script**. The diagram draws during speech; a short check question appears below it.
Try both browser voice and silent speech. The same board remains fixed, with no zoom or page stack.

`flow-helpers.js` exposes `window.flowHelpers`. It prepares Mermaid diagrams before playback:

```js
const action = await flowHelpers.flowchart('flowchart LR\n A[Read] --> B[Think] --> C[Answer]');
// Use action inside a normal step's actions array.
const script = await flowHelpers.demo('decision'); // or 'water'
```

Output is the existing JSON-serialisable `draw_svg` action; the shared contract is unchanged.
Source must be a plain flowchart/graph definition (up to 4000 characters), without HTML, links,
custom styling or configuration directives. Mermaid uses strict security and SVG text labels.
The generated diagram fits within [40,80]–[760,420], leaving room for the title and question.
Unique IDs preserve scoped SVG styles and markers. Failed renders do not block later requests.

Mermaid is local and bundled for direct file:// use. Rendering needs a browser's SVG/text measurement
APIs. Automated flow tests verify the bundled API, helper wiring, sizing and playback using a render
fixture; they do not verify real Mermaid label metrics. Check both demos in a real browser.

## Public API for Kabir (step 6)

The board page loads the local rough.js, KaTeX and layout dependencies before `board.js`.
Use these four functions in the renderer after that page has loaded:

```js
await window.board.playScript(script, window.shell.speak);
await window.board.playStep(step, window.shell.speak);
const snapshot = window.board.getBoardState();
window.board.clearBoard();
```

`playScript` runs steps in order. `playStep` starts speech and drawing together and resolves after
both finish. A voice failure rejects after the drawing finishes and prevents subsequent script
steps from running. Without a speak function the test fallback is a silent word-count timer.
There is no duration-reporting extension to Speak; the shared contract remains unchanged.

`getBoardState` returns a detached, JSON-serialisable array of the currently visible content.
Mutating either that array or the original input script does not change the board's stored state.
`clearBoard` clears drawings and layout reservations synchronously. It is not a cancellation API:
await active playback before clearing or starting another call. Script playback does not implicitly
clear earlier work, so follow-up steps can label or highlight existing diagram IDs.

`board.js` also exports the same four functions through CommonJS `module.exports`. This entry still
needs the renderer DOM and the same page dependencies; it is not a Node-only drawing engine.
For ES-module consumers, `board.mjs` forwards to the already loaded board without reinitialising it:

```js
import { playScript, playStep, getBoardState, clearBoard } from './board/board.mjs';
await playScript(script, speak);
```

Adjust the import path to the consuming file. ES modules need a supported served-page/Electron
module environment; the direct file:// test page continues using ordinary scripts and window.board.
Calling the module functions before board.js has loaded reports a clear initialisation error.

API tests exercise the real module exports and fake-speech follow-ups. Kabir's real Electron/Piper
connection still needs an end-to-end run on the configured pipeline; no shell files were changed.

## Recovery and robustness (step 7)

Reload the page, click **Recovery demo**, choose **Silent test: fast**, then **Play script**.
The rectangle should stay visible, turn green, and show **Still working!** to its right.
The deliberately bad step, unknown action, missing target and malformed line/erase are skipped
with console warnings. Playback should reach **done**. No Kabir pipeline is required.

The public API validates actions before sharing out drawing time. Invalid script containers return
with a warning; invalid steps are skipped. A valid narration with a malformed actions list still
speaks. An empty/null erase target is invalid; only an omitted target clears the whole board.
Rendering errors skip that action and allow later actions to run. Voice failures retain the step 6
behaviour: wait for drawing, then reject playback.

Raw `draw_svg` content now decodes as an isolated SVG image, with a board-sized wrapper for
fragments. It never enters the live page as markup. SVG image context disables scripts and external
resources and isolates diagram CSS ([MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)).
Inline Mermaid styles and markers remain inside the image. SVG diagrams fade in together; regular
rough.js shapes and arrows still reveal individual strokes. Malformed XML is skipped if decoding fails.
SVGs should contain their own styles/resources; an Electron content policy must allow `img-src data:`.

Run all automated checks with `node --test board/tests/*.test.cjs`. Image decode is mocked in these
tests: they verify isolation, recovery, timing and helper playback, rather than actual browser rendering.
After reloading, also play a graph and both flow demos to check their image rendering in the browser.
