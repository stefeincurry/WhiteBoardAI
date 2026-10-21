// Exercise the real library's browser branch without opening a browser or
// rendering pixels. The normal Node tests do not execute this branch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browserContext() {
  const created = [];
  const document = {
    getElementById: () => null, getElementsByTagName: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  function element(tag) {
    const node = {
      tagName: tag, ownerDocument: document, style: {}, attrs: {}, children: [],
      getElementsByTagName: () => [],
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      appendChild(node) { this.children.push(node); return node; },
      removeChild() {}, addEventListener() {}, removeEventListener() {},
    };
    created.push(node); return node;
  }
  document.createElement = element;
  document.createElementNS = (_, tag) => element(tag);
  document.body = element('body');
  document.documentElement = element('html');
  const window = { document, navigator: { userAgent: 'Graph regression test' }, addEventListener() {}, removeEventListener() {} };
  window.window = window;
  const context = vm.createContext({ document, window, navigator: window.navigator,
    console, setTimeout, clearTimeout, setInterval, clearInterval });
  for (const file of ['vendor/jsxgraph-1.14.0/jsxgraphcore.js', 'graph-helpers.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  }
  return { context, window, document, created };
}

test('browser-mode JSXGraph rejects a null container, reproducing the reported error', () => {
  const { window } = browserContext();
  const JXG = window.JXG;
  assert.equal(JXG.isBrowser, true);
  assert.throws(() => new JXG.Board(null, new JXG.NoRenderer(), 'old-plot',
    [0, 0], 1, 1, 1, 1, 360, 280, { ...JXG.Options.board, registerevents: false }), /getAttribute/);
});

test('all graph demos load in browser mode with detached containers', () => {
  const { window, document, created } = browserContext();
  const before = Object.keys(window.JXG.boards).length;
  for (const kind of ['parabola', 'line', 'sine']) {
    const script = window.graphHelpers.demo(kind);
    assert.equal(script.steps.length, 3);
    assert(script.steps[1].actions[0].svg.includes('<path'));
  }
  const containers = created.filter(node => /^plot-/.test(node.attrs.id || ''));
  assert.equal(containers.length, 3);
  assert.equal(new Set(containers.map(node => node.attrs.id)).size, 3);
  assert.equal(document.body.children.length, 0);
  assert.equal(Object.keys(window.JXG.boards).length, before);
});
