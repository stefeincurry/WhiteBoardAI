// JSXGraph calculates the curve; output remains ordinary serialisable SVG actions.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./vendor/jsxgraph-1.14.0/jsxgraphcore.js'));
  else root.graphHelpers = factory(root.JXG);
})(typeof window !== 'undefined' ? window : globalThis, function (JXG) {
  let sequence = 0;
  const n = value => Number(value.toFixed(3));
  // Choose familiar 1/2/5 intervals instead of dividing the range into quarters.
  function ticks(min, max) {
    const rough = (max - min) / 6;
    const unit = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 5, 10].find(value => value * unit >= rough) * unit;
    const result = [];
    for (let i = Math.ceil(min / step); i <= Math.floor(max / step); i++) {
      result.push(Number((i * step).toPrecision(10)));
    }
    return result;
  }
  function functionPlot(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('Pass a local JavaScript function, not executable text.');
    const xRange = options.xRange || [-3, 3], yRange = options.yRange || [-1, 10];
    for (const range of [xRange, yRange]) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) ||
        range[0] >= range[1] || range[0] > 0 || range[1] < 0 || range[1] - range[0] > 1e6 || range[1] - range[0] < 1e-6) {
        throw new RangeError('Use finite increasing ranges containing zero, with a span between 0.000001 and 1000000.');
      }
    }
    const [xmin, xmax] = xRange, [ymin, ymax] = yRange;
    const sx = 360 / (xmax - xmin), sy = 280 / (ymax - ymin);
    const local = (x, y) => [n(40 + (x - xmin) * sx), n(20 + (ymax - y) * sy)];
    const toBoard = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < xmin || x > xmax || y < ymin || y > ymax) throw new RangeError('Point is outside the graph.');
      const p = local(x, y); return [p[0] + 40, p[1] + 80];
    };
    // Even NoRenderer expects a real container in a browser. Keep it detached:
    // it hosts no visible board and registers no pointer or resize handlers.
    const id = `plot-${++sequence}`;
    const container = typeof document === 'undefined' ? null : document.createElement('div');
    if (container) container.setAttribute('id', id);
    const board = new JXG.Board(container, new JXG.NoRenderer(), id,
      [-xmin * sx, ymax * sy], 1, 1, sx, sy, 360, 280,
      { ...JXG.Options.board, registerevents: false });
    let curve;
    let path = '', previous = null;
    try {
      curve = board.create('functiongraph', [fn, xmin, xmax], {
        doAdvancedPlot: false, numberPointsHigh: 240, numberPointsLow: 240, RDPsmoothing: false,
      });
      for (const point of curve.points.slice(0, curve.numberPoints)) {
        const [, x, y] = point.usrCoords;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < xmin || x > xmax || y < ymin || y > ymax) {
          previous = null; continue;
        }
        const p = local(x, y);
        const connected = previous && Math.abs(p[1] - previous[1]) < 168;
        path += `${connected ? 'L' : 'M'}${p[0]} ${p[1]} `;
        previous = p;
      }
    } finally {
      if (curve) board.removeObject(curve);
    }
    if (!path.includes('L')) throw new RangeError('No visible curve in these ranges.');
    const [ox, oy] = local(0, 0);
    let axes = `<path d="M40 ${oy} H408 M402 ${oy - 4} L408 ${oy} L402 ${oy + 4} M${ox} 300 V12 M${ox - 4} 18 L${ox} 12 L${ox + 4} 18" fill="none" stroke="#444" stroke-width="2"/>`;
    const text = (x, y, value, anchor = 'middle') => `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" font-size="16" font-family="sans-serif" fill="#444">${value}</text>`;
    for (const x of ticks(xmin, xmax)) {
      const px = local(x, 0)[0];
      axes += `<path d="M${px} ${oy - 4} v8" stroke="#777" fill="none"/>`;
      if (Math.abs(px - ox) >= 28) axes += text(px, oy + 22, x);
    }
    for (const y of ticks(ymin, ymax)) {
      const py = local(0, y)[1];
      axes += `<path d="M${ox - 4} ${py} h8" stroke="#777" fill="none"/>`;
      // Leave breathing room around the single origin label and x-axis labels.
      if (Math.abs(py - oy) >= 28) axes += text(ox - 10, py + 5, y, 'end');
    }
    axes += text(420, oy + 6, 'x') + text(ox + 14, 17, 'y') + text(ox - 10, oy + 20, '0');
    const action = svg => ({ type: 'draw_svg', svg: `<svg xmlns="http://www.w3.org/2000/svg" x="40" y="80" width="440" height="340" viewBox="0 0 440 340">${svg}</svg>`, region: 'left' });
    return {
      axes: action(axes),
      curve: action(`<path d="${path.trim()}" fill="none" stroke="#2454ad" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`),
      toBoard,
    };
  }

  function demo(kind = 'parabola') {
    const examples = {
      parabola: { title: 'A parabola', fn: x => x * x, xRange: [-3, 3], yRange: [-1, 10], latex: 'y = x^2',
        say: 'Squaring x produces this U shaped curve.', point: [0, 0], note: 'The vertex is at the origin.' },
      line: { title: 'A straight line', fn: x => 2 * x + 1, xRange: [-3, 3], yRange: [-6, 8], latex: 'y = 2x + 1',
        say: 'Each increase of one in x adds two to y.', point: [1, 3], note: 'At x = 1, y = 3.' },
      sine: { title: 'A sine wave', fn: Math.sin, xRange: [-Math.PI, Math.PI], yRange: [-1.5, 1.5], latex: 'y = \\sin(x)',
        say: 'The sine function rises and falls between minus one and one.', point: [Math.PI / 2, 1], note: 'At pi over two, sine is one.' },
    };
    const example = examples[kind];
    if (!example) throw new TypeError('Unknown graph demo.');
    const plot = functionPlot(example.fn, example);
    const [x, y] = plot.toBoard(...example.point);
    const id = `graph-point-${sequence}`;
    return { topic: example.title, steps: [
      { say: 'First draw the coordinate axes. The numbers show the scale.', actions: [
        { type: 'erase' }, { type: 'write_text', text: example.title, at: [40, 48] }, plot.axes,
      ] },
      { say: example.say, actions: [plot.curve, { type: 'write_formula', latex: example.latex, at: [520, 140] }] },
      { say: example.note, actions: [
        { type: 'draw_shape', shape: 'circle', id, points: [[x, y], [x + 6, y]] },
        { type: 'highlight', target: id, part: 'outline', color: '#d22' },
        { type: 'label', target: id, text: example.note, at: [520, 280] },
      ] },
    ] };
  }
  return { functionPlot, demo };
});
