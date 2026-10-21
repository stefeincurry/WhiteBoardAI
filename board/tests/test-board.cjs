const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function setup(animationLag = 0, measurements = [], commonjs = false) {
  let now = 0;
  const jobs = [], animations = [], warnings = [];
  const schedule = (resolve, ms) => jobs.push({ at: now + ms, resolve });
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.attrs = {}; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    set innerHTML(markup) {
      // Minimal SVG adapter for playback tests, not a browser renderer.
      const root = markup.match(/<svg\b([^>]*)>/);
      if (root) {
        const attrs = Object.fromEntries([...root[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        this.box = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(attrs[key] || 0)]));
      }
      for (const match of markup.matchAll(/<path\b([^>]*)\/?\s*>/g)) {
        const node = new Node('path');
        for (const attribute of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attribute[1], attribute[2]);
        this.appendChild(node);
      }
    }
    getBBox() { return this.box || { x: 0, y: 0, width: 800, height: 500 }; }
    appendChild(n) { if (n.parentNode) n.remove(); n.parentNode = this; this.children.push(n); return n; }
    get firstChild() { return this.children[0]; }
    removeChild(n) { this.children.splice(this.children.indexOf(n), 1); n.parentNode = null; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    scrollIntoView() {}
    cloneNode() { const n = new Node(this.tagName); n.attrs = { ...this.attrs }; this.children.forEach(c => n.appendChild(c.cloneNode())); return n; }
    matches(tag) {
      return tag.split(',').some(selector => {
        const match = selector.trim().match(/^\[([^\]]+)\]$/);
        return match ? this.attrs[match[1]] !== undefined : this.tagName === selector.trim();
      });
    }
    querySelectorAll(tag) {
      return this.children.flatMap(n => [...(n.matches(tag) ? [n] : []), ...n.querySelectorAll(tag)]);
    }
    getTotalLength() { return 100; }
    animate(frames, options) {
      animations.push({ at: now, frames, options });
      return { finished: new Promise(resolve => schedule(resolve, options.duration + (options.delay || 0) + animationLag)) };
    }
  }
  const svg = new Node('svg');
  const container = new Node('div'); container.appendChild(svg);
  const shape = () => { const g = new Node('g'); g.appendChild(new Node('path')); return g; };
  const pen = { line: shape, polygon: shape, circle: shape, rectangle: shape, linearPath: shape };
  const context = {
    window: {}, BoardLayout: require('../layout.js'), rough: { svg: () => pen },
    katex: { render: (latex, node) => { node.textContent = latex; } },
    document: {
      getElementById: id => id === 'board' ? svg : null,
      createElementNS: (ns, tag) => {
        const node = new Node(tag);
        if (ns === 'http://www.w3.org/1999/xhtml' && tag === 'div' && measurements.length) Object.assign(node, measurements.shift());
        return node;
      },
    },
    setTimeout: schedule, console: { warn: (...args) => warnings.push(args) },
    // Image decoding itself is a browser responsibility; tests inspect isolation
    // and simulate a decode failure separately, without claiming a real render.
    Image: class { async decode() {} },
  };
  if (commonjs) context.module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../board.js'), 'utf8'), context);
  async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  async function advance(time) {
    await flush();
    while (true) {
      jobs.sort((a, b) => a.at - b.at);
      if (!jobs.length || jobs[0].at > time) break;
      const job = jobs.shift(); now = job.at; job.resolve(); await flush();
    }
    now = time; await flush();
  }
  return { board: context.window.board, context, svg, container, animations, warnings, advance,
    speak: ms => () => new Promise(resolve => schedule(resolve, ms)), now: () => now };
}

module.exports = setup;
