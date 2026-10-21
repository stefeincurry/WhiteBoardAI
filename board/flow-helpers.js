// Mermaid is used while authoring. Playback only receives existing SVG actions.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory;
  else root.flowHelpers = factory(root.mermaid);
})(typeof window !== 'undefined' ? window : globalThis, function createFlowHelpers(mermaid) {
  let sequence = 0, initialized = false, queue = Promise.resolve();
  const examples = {
    decision: {
      title: 'Even or odd?',
      source: 'flowchart LR\n A[Read a whole number] --> B{Divisible by 2?}\n B -->|Yes| C[Even]\n B -->|No| D[Odd]',
      say: 'Check whether the whole number is divisible by two. Yes means even. No means odd.',
      question: 'Try 7. Which branch should we follow?',
    },
    water: {
      title: 'The water cycle',
      source: 'flowchart LR\n A[Evaporation] --> B[Condensation]\n B --> C[Precipitation]\n C --> D[Collection]\n D --> A',
      say: 'Water evaporates, condenses into clouds, falls as precipitation, and collects. Then the cycle repeats.',
      question: 'What happens after condensation?',
    },
  };

  function validate(source) {
    if (typeof source !== 'string' || !source.trim() || source.length > 4000) throw new RangeError('Use a flowchart definition between 1 and 4000 characters.');
    if (!/^(?:flowchart|graph)\s+(?:LR|RL|TB|TD|BT)\b/.test(source.trim())) throw new TypeError('Start with flowchart LR or flowchart TD.');
    // This helper supports plain study diagrams, without links, HTML or config.
    if (/%%\{|---\s*\n|<|@\{|https?:|javascript:|data:|@import|url\s*\(|^\s*(?:click|style|classDef|class|linkStyle)\s/im.test(source)) {
      throw new TypeError('Use plain nodes and arrows, without HTML, links, styles or directives.');
    }
    return source.trim();
  }

  function fitSvg(svg) {
    if (typeof svg !== 'string') throw new Error('Mermaid did not return SVG.');
    const root = svg.match(/<svg\b([^>]*)>/i);
    const box = root && root[1].match(/\bviewBox="([^"]+)"/i);
    const bounds = box && box[1].trim().split(/[\s,]+/).map(Number);
    if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= 0 || bounds[3] <= 0) {
      throw new Error('The diagram has no valid viewBox.');
    }
    // Keep Mermaid's unique ID and scoped stylesheet. Size only the root SVG;
    // nested node rectangles retain their own dimensions.
    const attrs = root[1].replace(/\s(?:x|y|width|height|style|preserveAspectRatio)="[^"]*"/gi, '');
    return svg.replace(root[0], `<svg${attrs} x="40" y="80" width="720" height="340" preserveAspectRatio="xMidYMid meet">`);
  }

  function flowchart(source) {
    // Do not let a rejected render poison the queue for later requests.
    const job = queue.then(async () => {
      const text = validate(source);
      if (!mermaid || typeof mermaid.render !== 'function') throw new Error('The local Mermaid library is unavailable.');
      if (!initialized) {
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
          maxTextSize: 4000, maxEdges: 40, theme: 'base', look: 'classic',
          fontFamily: 'Arial, sans-serif',
          themeVariables: { fontFamily: 'Arial, sans-serif', fontSize: '20px',
            primaryColor: '#eef5ff', primaryTextColor: '#1a3d7c', primaryBorderColor: '#355a80',
            lineColor: '#355a80', edgeLabelBackground: '#fdfdf8' },
          // Mermaid's default 120px wrap splits words such as Condensation.
          flowchart: { htmlLabels: false, useMaxWidth: false, wrappingWidth: 200,
            curve: 'linear', nodeSpacing: 24, rankSpacing: 36 },
        });
        initialized = true;
      }
      const id = `study-flow-${++sequence}`;
      try {
        const { svg } = await mermaid.render(id, text);
        return { type: 'draw_svg', svg: fitSvg(svg) };
      } finally {
        // Mermaid may leave its error placeholder when syntax is invalid.
        if (typeof document !== 'undefined') document.getElementById(`d${id}`)?.remove();
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  async function demo(kind = 'decision') {
    const example = examples[kind];
    if (!example) throw new TypeError('Unknown flowchart demo.');
    const diagram = await flowchart(example.source);
    return { topic: example.title, steps: [
      { say: example.say, actions: [{ type: 'erase' },
        { type: 'write_text', text: example.title, at: [40, 48] }, diagram] },
      { say: example.question, actions: [{ type: 'write_text', text: example.question, at: [40, 460] }] },
    ] };
  }
  return { flowchart, demo, fitSvg, sources: Object.fromEntries(Object.entries(examples).map(([key, value]) => [key, value.source])) };
});
