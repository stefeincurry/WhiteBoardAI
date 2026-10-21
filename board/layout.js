// Pure placement logic for the contract's 800 x 500 board.
(function (root) {
  const regions = {
    left: { x: 40, y: 36, width: 344, bottom: 484 },
    right: { x: 440, y: 86, width: 344, bottom: 484 },
    top: { x: 40, y: 16, width: 744, bottom: 484 },
    bottom: { x: 40, y: 400, width: 744, bottom: 484 },
  };
  class BoardLayout {
    constructor() { this.items = []; }
    static region(name) { return regions[name] || regions.right; }
    reserve(box, owner) { this.items.push({ ...box, owner }); }
    remove(owner) { this.items = this.items.filter(item => item.owner !== owner); }
    place(width, height, region, at, ignore) {
      const area = BoardLayout.region(region);
      const x = Math.max(16, Math.min(at ? at[0] : area.x, 784 - width));
      const start = Math.max(16, Math.min(at ? at[1] : area.y, 484 - height));
      // A label may sit inside its own diagram, but not on an earlier label.
      const items = this.items.filter(item => !(ignore && item.owner === ignore && item.diagram));
      const candidates = [start, ...items.map(item => item.y + item.height + 12)]
        .filter(y => y >= start).sort((a, b) => a - b);
      for (const y of candidates) {
        if (y + height > area.bottom || width > 768 || height > 468) continue;
        if (items.every(item => x + width + 8 <= item.x || x >= item.x + item.width + 8 ||
          y + height + 8 <= item.y || y >= item.y + item.height + 8)) {
          return { x, y, width, height };
        }
      }
      return null;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = BoardLayout;
  else root.BoardLayout = BoardLayout;
})(typeof window !== 'undefined' ? window : globalThis);
