// Safe maths-expression reader for {"type":"plot","fn":"x^2 - 2x + 1"}: turns the AI's text into a
// function of x WITHOUT eval. Supports numbers, x, pi, e, + - * / ^, brackets, implicit multiplication
// ("2x", "3(x+1)", "2sin(x)") and sin cos tan asin acos atan sqrt abs log (base 10) ln exp.
(function (root) {
  const FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sqrt: Math.sqrt, abs: Math.abs, log: Math.log10, ln: Math.log, exp: Math.exp,
  };
  const CONSTS = { pi: Math.PI, e: Math.E };

  function parseExpr(text) {
    if (typeof text !== 'string' || text.length > 100) throw new TypeError('Formula must be a short string.');
    const src = text.replace(/\*\*/g, '^').replace(/^\s*y\s*=\s*/i, '').toLowerCase();
    const tokens = src.match(/\d*\.\d+|\d+|[a-z]+|[-+*/^()]|\S/g) || [];
    let i = 0;
    const peek = () => tokens[i];
    const take = (t) => {
      if (t !== undefined && tokens[i] !== t) throw new SyntaxError(`Expected "${t}" in formula "${text}"`);
      return tokens[i++];
    };
    // Grammar: sum := product (('+'|'-') product)*  ;  product := unary (('*'|'/'|implicit) unary)*
    //          unary := '-' unary | power  ;  power := atom ('^' unary)?
    function sum() {
      let f = product();
      while (peek() === '+' || peek() === '-') {
        const op = take(), g = product(), a = f;
        f = op === '+' ? (x) => a(x) + g(x) : (x) => a(x) - g(x);
      }
      return f;
    }
    const startsAtom = (t) => t !== undefined && (t === '(' || /^[\d.]/.test(t) || /^[a-z]/.test(t));
    function product() {
      let f = unary();
      for (;;) {
        const t = peek();
        if (t === '*' || t === '/') {
          take();
          const g = unary(), a = f;
          f = t === '*' ? (x) => a(x) * g(x) : (x) => a(x) / g(x);
        } else if (startsAtom(t)) {
          const g = power(), a = f; // implicit multiplication: 2x, 3(x+1), 2sin(x)
          f = (x) => a(x) * g(x);
        } else return f;
      }
    }
    function unary() {
      if (peek() === '-') {
        take();
        const g = unary();
        return (x) => -g(x);
      }
      if (peek() === '+') take();
      return power();
    }
    function power() {
      const base = atom();
      if (peek() !== '^') return base;
      take();
      const exp = unary(); // right-associative: 2^3^2 = 2^9
      return (x) => Math.pow(base(x), exp(x));
    }
    function atom() {
      const t = take();
      if (t === undefined) throw new SyntaxError(`Formula "${text}" ends too early`);
      if (t === '(') {
        const f = sum();
        take(')');
        return f;
      }
      if (/^[\d.]/.test(t)) {
        const v = Number(t);
        if (!Number.isFinite(v)) throw new SyntaxError(`Bad number "${t}"`);
        return () => v;
      }
      if (t === 'x') return (x) => x;
      if (Object.hasOwn(CONSTS, t)) return () => CONSTS[t];
      if (Object.hasOwn(FUNCS, t)) {
        const fn = FUNCS[t];
        if (peek() === '(') {
          take('(');
          const arg = sum();
          take(')');
          return (x) => fn(arg(x));
        }
        const arg = power(); // "sin x"
        return (x) => fn(arg(x));
      }
      throw new SyntaxError(`Unknown "${t}" in formula "${text}"`);
    }
    const f = sum();
    if (i !== tokens.length) throw new SyntaxError(`Unexpected "${tokens[i]}" in formula "${text}"`);
    return f;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { parseExpr };
  else root.parseExpr = parseExpr;
})(typeof window !== 'undefined' ? window : globalThis);
