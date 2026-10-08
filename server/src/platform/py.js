// SPDX-License-Identifier: MIT
// Python's semantics where JavaScript's differ and a port would silently change results.
// Each helper names the Python it stands for.

export class ValueError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "ValueError";
  }
}
export class KeyError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "KeyError";
  }
}
export class RuntimeError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "RuntimeError";
  }
}
export class FileNotFoundError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "FileNotFoundError";
    this.code = "ENOENT";
  }
}

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";
/** sys.platform: "win32" | "darwin" | "linux". */
export const SYS_PLATFORM = process.platform;

/** round(x, nd) — half to even on the double's exact value, as Python rounds. */
export function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  if (nd === 0) {
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  // toFixed with enough digits shows the double's exact decimal expansion's head; a true
  // tie (…5 followed only by zeros) rounds to even.
  const s = Math.abs(x).toFixed(Math.min(100, nd + 30));
  const [ip, fp = ""] = s.split(".");
  const keep = fp.slice(0, nd);
  const rest = fp.slice(nd);
  let digits = BigInt(ip + keep);
  const above = rest[0] > "5" || (rest[0] === "5" && /[1-9]/.test(rest.slice(1)));
  const tie = rest[0] === "5" && !/[1-9]/.test(rest.slice(1));
  if (above || (tie && digits % 2n === 1n)) digits += 1n;
  const txt = digits.toString().padStart(nd + 1, "0");
  const out = Number(`${txt.slice(0, -nd)}.${txt.slice(-nd)}`);
  return x < 0 ? -out : out;
}

/** a % b with Python's sign (the divisor's). */
export const pyMod = (a, b) => ((a % b) + b) % b;
/** a // b */
export const floorDiv = (a, b) => Math.floor(a / b);

/** str(v) for the values the kit stringifies: None/True/False and numbers. */
export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  }
  return String(v);
}

/** bool(v) — Python truthiness (empty containers are false). */
export function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

/** int(v): a number truncated, or a base-10 integer string, else ValueError. */
export function pyInt(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ValueError(`cannot convert float ${v} to integer`);
    return Math.trunc(v);
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  // An underscore only between digits, as Python's int() reads it ("1_0" yes, "_1" no).
  const t = String(v).trim();
  if (!/^[-+]?\d+(?:_\d+)*$/.test(t)) throw new ValueError(`invalid literal for int() with base 10: '${v}'`);
  return Number(t.replace(/_/g, ""));
}

/** float(v): a number, or a number string (incl. inf / nan), else ValueError. */
export function pyFloatParse(v) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const raw = String(v).trim().toLowerCase();
  // An underscore only between digits, as Python's float() reads it.
  if (/(^|[^0-9])_|_($|[^0-9])/.test(raw)) throw new ValueError(`could not convert string to float: '${v}'`);
  const s = raw.replace(/_/g, "");
  if (["inf", "+inf", "infinity", "+infinity"].includes(s)) return Number.POSITIVE_INFINITY;
  if (["-inf", "-infinity"].includes(s)) return Number.NEGATIVE_INFINITY;
  if (["nan", "+nan", "-nan"].includes(s)) return Number.NaN;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(s)) throw new ValueError(`could not convert string to float: '${v}'`);
  return Number(s);
}

/** Compare like Python: numbers, strings by code point, arrays as tuples. */
export function cmp(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return 0;
    const A = [...a];
    const B = [...b];
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      const d = A[i].codePointAt(0) - B[i].codePointAt(0);
      if (d) return d;
    }
    return A.length - B.length;
  }
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** sorted(xs, key=…, reverse=…) — stable, Python ordering. */
export function pySorted(xs, key = (x) => x, reverse = false) {
  const arr = [...xs].map((x, i) => [key(x), i, x]);
  arr.sort((p, q) => (reverse ? cmp(q[0], p[0]) : cmp(p[0], q[0])) || p[1] - q[1]);
  return arr.map((p) => p[2]);
}

/** max(xs, key=…) — the FIRST of equals wins, as in Python. */
export function pyMax(xs, key = (x) => x) {
  let best;
  let bk;
  let first = true;
  for (const x of xs) {
    const k = key(x);
    if (first || cmp(k, bk) > 0) {
      best = x;
      bk = k;
      first = false;
    }
  }
  if (first) throw new ValueError("max() arg is an empty sequence");
  return best;
}

/** min(xs, key=…) — the FIRST of equals wins, as in Python. */
export function pyMin(xs, key = (x) => x) {
  let best;
  let bk;
  let first = true;
  for (const x of xs) {
    const k = key(x);
    if (first || cmp(k, bk) < 0) {
      best = x;
      bk = k;
      first = false;
    }
  }
  if (first) throw new ValueError("min() arg is an empty sequence");
  return best;
}

/** str.split() with no argument: runs of whitespace, no empty strings. */
export function splitWs(s) {
  const t = String(s).trim();
  return t ? t.split(/\s+/u) : [];
}

function stripSet(s, chars, left, right) {
  if (chars == null) return left && right ? s.trim() : left ? s.trimStart() : s.trimEnd();
  let a = 0;
  let b = s.length;
  if (left) while (a < b && chars.includes(s[a])) a++;
  if (right) while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
/** str.strip(chars) — no chars = whitespace. */
export const strip = (s, chars) => stripSet(String(s), chars, true, true);
export const lstrip = (s, chars) => stripSet(String(s), chars, true, false);
export const rstrip = (s, chars) => stripSet(String(s), chars, false, true);

/** str.casefold() — lower case plus the full case folds Python applies (the common ones). */
export function casefold(s) {
  return String(s)
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ẞ/g, "ss")
    .replace(/ς/g, "σ")
    .replace(/ſ/g, "s")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/ﬀ/g, "ff")
    .replace(/ﬃ/g, "ffi")
    .replace(/ﬄ/g, "ffl")
    .replace(/[ﬅﬆ]/g, "st");
}

/** Python `re`'s `\w` on str — letters, every number category, `_` (measured: not combining
 * marks, not other connector punctuation) — for a pattern built with the `u` flag. */
export const W = "[\\p{L}\\p{N}_]";
/** Python `re`'s `\W`. */
export const NOT_W = "[^\\p{L}\\p{N}_]";
/** Python `re`'s `\b`, for a pattern built with the `u` flag. */
export const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

/** os.path.expanduser */
export function expandUser(p) {
  if (typeof p === "string" && (p === "~" || p.startsWith("~/") || p.startsWith("~\\"))) {
    return (process.env.USERPROFILE || process.env.HOME || "") + p.slice(1);
  }
  return p;
}
