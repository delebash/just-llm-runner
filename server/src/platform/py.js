// SPDX-License-Identifier: MIT
// Python's semantics where JavaScript's differ and a port would silently change results.
// Each helper names the Python it stands for. One copy for the family (the family-sameness
// law): the apps' own copies were folded in here on 2026-10-08 (JustVoice's py_compat.js,
// JustWrite's book_io, docgen's jsonio and the kit's own scattered ones). What reads or
// writes a parsed JSON value's floats (`PyFloat`) lives in pyjson.js, which imports this
// module (never the other way round).

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
export class NotImplementedError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "NotImplementedError";
  }
}
export class FileNotFoundError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "FileNotFoundError";
    this.code = "ENOENT";
  }
}
export class AttributeError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "AttributeError";
  }
}
export class IndexError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "IndexError";
  }
}
export class OverflowError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "OverflowError";
  }
}
export class AssertionError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "AssertionError";
  }
}

/** `str(e)` of an exception — the message alone (JavaScript's String(e) prefixes the class
 * name); anything else thrown is `String(e)`. */
export function errText(e) {
  if (e instanceof Error) return e.message;
  return String(e);
}

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";
/** sys.platform: "win32" | "darwin" | "linux". */
export const SYS_PLATFORM = process.platform;

/** round(x, nd) — half to even on the double's exact value, as Python rounds. */
export function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  // Every double this large is already a whole number (and toFixed would switch to
  // exponent notation past 1e21).
  if (Math.abs(x) >= 2 ** 53) return x;
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

/** bool(v) — Python truthiness (empty containers are false; a PyFloat is its number —
 * pyjson's class, recognised by its constructor's name, since pyjson imports this module). */
export function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v?.constructor?.name === "PyFloat") return v.v !== 0; // bool(nan) is True too
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

/** `v or d` — Python's truthiness (`truthy`). */
export const pyOr = (v, d) => (truthy(v) ? v : d);

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

/** Python's whitespace — `str.isspace()`, what `split()` / `strip()` use: the ASCII controls
 * \t \n \v \f \r and \x1c-\x1f, space, \x85, and Unicode's space separators and line /
 * paragraph separators. Unlike JavaScript's, NOT U+FEFF (measured). */
export const PY_WS = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
/** Python `re`'s `\s` on str, for a pattern built with the `u` flag. */
export const S = `[${PY_WS}]`;
/** Python `re`'s `\d` on str (every decimal digit, Nd), for a pattern with the `u` flag. */
export const D = "\\p{Nd}";
const WS_RUN = new RegExp(`${S}+`, "u");

/** str.split() with no argument: runs of Python whitespace, no empty strings. */
export function splitWs(s) {
  const t = strip(String(s));
  return t ? t.split(WS_RUN) : [];
}

function stripSet(s, chars, left, right) {
  if (chars == null) chars = PY_WS;
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

/** Python's `$` without MULTILINE, for a pattern built with the `u` flag: the end, or just
 * before a newline that ends the string. */
export const END = "(?=\\n?$)";

// ── dicts ────────────────────────────────────────────────────────────────────

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * `isinstance(v, dict)`: a Map (a dict read in file order — docgen's `jsonLoadsExact`) or a
 * plain object. Not an array, a PyFloat, a Buffer, a Date or any other class instance.
 */
export const isDict = (v) => v instanceof Map || isPlainObject(v);

/**
 * Any non-null object that is not an array — what JSON.parse makes of a `{…}`. For values
 * straight from JSON.parse it answers as `isDict`; it differs on what JSON never makes: a
 * class instance (a PyFloat, a Buffer, a Date) passes here and not there. The kit's LLM
 * adapters, its prefs and cache-registry readers and JustVoice's effects, runtime and
 * settings readers test with this one.
 */
export const isJsonObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `dict.setdefault(k, d)` — returns the existing value even when it is null. */
export function setdefault(obj, key, dflt) {
  if (!Object.hasOwn(obj, key)) obj[key] = dflt;
  return obj[key];
}

/** `type(v).__name__` of a JSON-shaped value, for the error texts Python would raise. (A
 * PyFloat — pyjson's class, known by its constructor's name, since pyjson imports this
 * module — is a float; a BigInt an int.) */
export function pyTypeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "str";
  if (typeof v === "bigint") return "int";
  if (v?.constructor?.name === "PyFloat") return "float";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  if (isDict(v)) return "dict";
  return typeof v;
}

/** `for x in v` — a list's items, a str's characters, a dict's keys (a Map's or a plain
 * object's), a set's items; anything else is Python's TypeError. */
export function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (v instanceof Map) return [...v.keys()];
  if (v instanceof Set) return [...v];
  if (isPlainObject(v)) return Object.keys(v);
  throw new TypeError(`'${pyTypeName(v)}' object is not iterable`);
}

/** `d.get(k, dflt)` on a Map or a plain object — a present-but-null value stays null; a
 * non-dict has no `.get` (Python's AttributeError). */
export function pyGet(d, k, dflt = null) {
  if (d instanceof Map) return d.has(k) ? d.get(k) : dflt;
  if (isPlainObject(d)) return Object.hasOwn(d, k) ? d[k] : dflt;
  throw new AttributeError(`'${pyTypeName(d)}' object has no attribute 'get'`);
}

// ── repr() of a str ──────────────────────────────────────────────────────────

/**
 * `repr(s)` of a str: single quotes unless the text holds one and no double quote; the
 * backslash, the quote, \n \r \t and the other control characters (C0, DEL, C1) escaped.
 * CPython escapes every other non-printable character too (U+00A0, U+00AD, U+200B, U+2028,
 * U+FEFF, unassigned code points — `str.isprintable()`); this one passes them through, as
 * the copies it replaced did (the 2026-10-08 sweep's report lists the copies that differ).
 */
export function strRepr(s) {
  const str = String(s);
  const q = str.includes("'") && !str.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += `\\${q}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0)) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + q;
}

// ── code points (Python indexes a str by code point; JavaScript by UTF-16 unit) ──

const SURROGATE = /[\uD800-\uDFFF]/;

/** `len(s)` — code points. */
export function cpLen(s) {
  if (!SURROGATE.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** `s[a:b]` with code-point indexes (negatives count from the end, `b` may be omitted). */
export function cpSlice(s, a = 0, b = undefined) {
  const str = String(s);
  if (!SURROGATE.test(str)) return str.slice(a, b);
  return Array.from(str).slice(a, b).join("");
}

/** The code-point index of UTF-16 index `i` in `s` (what Python reports as a position). */
export function cpIndex(s, i) {
  if (!SURROGATE.test(s)) return i;
  return cpLen(s.slice(0, i));
}

// ── str methods ──────────────────────────────────────────────────────────────

// \r\n, \n, \r, \v, \f, \x1c-\x1e, \x85 and the line and paragraph separators — those two built
// from char codes (one written into source would end a regex literal).
const LINE_BREAK = new RegExp(`\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85${String.fromCharCode(0x2028, 0x2029)}]`);

/** `str.splitlines()` — every line boundary Python knows, no trailing empty line. (httpx's
 * `iter_lines()` is this too, applied as the text arrives.) null and undefined read as "". */
export function splitlines(s) {
  const str = String(s ?? "");
  if (!str) return [];
  const parts = str.split(LINE_BREAK);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const CASED = /[\p{Lowercase}\p{Uppercase}\p{Lt}]/u;
const CASE_IGNORABLE = /\p{Case_Ignorable}/u;

// Unicode's titlecase where it is not the uppercase: the four digraph letters, the
// special-cased ligatures and ß, and Georgian Mkhedruli (titlecase = itself).
const TITLE = new Map([
  ..."ǄǅǆǇǈǉǊǋǌǱǲǳ".split("").map((c, i) => [c, "ǅǅǅǈǈǈǋǋǋǲǲǲ"[i]]),
  ["ß", "Ss"],
  ["ﬀ", "Ff"],
  ["ﬁ", "Fi"],
  ["ﬂ", "Fl"],
  ["ﬃ", "Ffi"],
  ["ﬄ", "Ffl"],
  ["ﬅ", "St"],
  ["ﬆ", "St"],
  ["և", "Եւ"],
  ["ﬓ", "Մն"],
  ["ﬔ", "Մե"],
  ["ﬕ", "Մի"],
  ["ﬖ", "Վն"],
  ["ﬗ", "Մխ"],
]);
const titleOf = (ch) => {
  const c = ch.codePointAt(0);
  if ((c >= 0x10d0 && c <= 0x10fa) || (c >= 0x10fd && c <= 0x10ff)) return ch;
  return TITLE.get(ch) ?? ch.toUpperCase();
};

/** The lower case of the character at `i` of `cps` — Σ by Unicode's Final_Sigma rule (ς at a
 * word's end, after a cased letter), as CPython's lower() reads it in context. */
function lowerAt(cps, i) {
  const ch = cps[i];
  if (ch !== "Σ") return ch.toLowerCase();
  let j = i - 1;
  while (j >= 0 && CASE_IGNORABLE.test(cps[j])) j--;
  const before = j >= 0 && CASED.test(cps[j]);
  let k = i + 1;
  while (k < cps.length && CASE_IGNORABLE.test(cps[k])) k++;
  const after = k < cps.length && CASED.test(cps[k]);
  return before && !after ? "ς" : "σ";
}

/** `str.title()`: a cased character after another cased one goes lower, any other to its
 * titlecase. */
export function pyTitle(s) {
  const cps = Array.from(s);
  let out = "";
  let prevCased = false;
  cps.forEach((ch, i) => {
    out += prevCased ? lowerAt(cps, i) : titleOf(ch);
    prevCased = CASED.test(ch);
  });
  return out;
}

/** `str.isupper()`: at least one cased character, and none lower or title case. */
export const pyIsUpper = (s) => !/[\p{Lowercase}\p{Lt}]/u.test(s) && /\p{Uppercase}/u.test(s);

/** `str.capitalize()`: the first character to its titlecase, the rest lower. */
export function pyCapitalize(s) {
  const cps = Array.from(s);
  if (!cps.length) return "";
  return titleOf(cps[0]) + cps.slice(1).map((_, k) => lowerAt(cps, k + 1)).join("");
}

// ── re.escape ────────────────────────────────────────────────────────────────

/** `re.escape(s)` for a pattern built with the `u` flag: only the syntax characters (a
 * `u` pattern refuses an escaped ordinary character — `\-` outside a class among them; the
 * match is the same). */
export const reEscape = (s) => String(s).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

const PY_SPECIAL = new Set(Array.from("()[]{}?*+-|^$\\.&~# \t\n\r\v\f"));

/** `len(re.escape(s))` — Python escapes more than a `u`-flag JavaScript pattern allows
 * (a space, `-`, `#`, `&`, `~`), and names are sorted by their escaped length. */
export function pyEscapedLen(s) {
  let n = 0;
  for (const ch of s) n += PY_SPECIAL.has(ch) ? 2 : 1;
  return n;
}

// ── int() of text ────────────────────────────────────────────────────────────

let ndZeros = null;
/** The value of one Unicode decimal digit (`\p{Nd}`), as `int()` reads it; -1 for anything
 * else. */
export function digitValue(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (ndZeros === null) {
    // Nd runs are whole decimal blocks: each run starts on a zero (Unicode's stability rule).
    ndZeros = [];
    const nd = /\p{Nd}/u;
    let runStart = -1;
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (nd.test(String.fromCodePoint(cp))) {
        if (runStart < 0) runStart = cp;
      } else if (runStart >= 0) {
        ndZeros.push([runStart, cp - 1]);
        runStart = -1;
      }
    }
  }
  for (const [a, b] of ndZeros) if (c >= a && c <= b) return (c - a) % 10;
  return -1;
}

/** `int(s)` of a run of `\p{Nd}` digits in any script (Python's int() reads "٣" as 3). */
export function digitsToInt(s) {
  let n = 0;
  for (const ch of s) n = n * 10 + digitValue(ch);
  return n;
}

/** Every `\p{Nd}` digit as its ASCII digit (`float()` and `int()` read them all). */
export const asciiDigits = (s) => s.replace(/\p{Nd}/gu, (ch) => String(digitValue(ch)));

/** `int(s)` of a str: Python whitespace around, a sign, any decimal digits (with single
 * underscores between them); anything else is a ValueError. */
export function pyIntOfStr(s) {
  const t = asciiDigits(strip(s));
  if (!/^[-+]?\d(?:_?\d)*$/.test(t)) throw new ValueError(`invalid literal for int() with base 10: ${strRepr(s)}`);
  return Number(t.replace(/_/g, ""));
}

// ── bytes.decode("utf-8") ────────────────────────────────────────────────────

export class UnicodeDecodeError extends ValueError {
  constructor(encoding, buf, start, end, reason) {
    const what =
      end === start + 1
        ? `can't decode byte 0x${buf[start].toString(16).padStart(2, "0")} in position ${start}`
        : `can't decode bytes in position ${start}-${end - 1}`;
    super(`'${encoding}' codec ${what}: ${reason}`);
    this.name = "UnicodeDecodeError";
  }
}

const isCont = (b) => b >= 0x80 && b <= 0xbf;

/** The first error CPython's UTF-8 decoder reports in `buf`: [start, end, reason] or null. */
function utf8Error(buf) {
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const ch = buf[i];
    if (ch < 0x80) {
      i++;
      continue;
    }
    const left = n - i;
    let bad = 0; // 1 invalid start, 2..4 invalid continuation (CPython's codes), -1 end of data
    let size = 0;
    if (ch < 0xc2) bad = 1;
    else if (ch < 0xe0) {
      if (left < 2) bad = -1;
      else if (!isCont(buf[i + 1])) bad = 2;
      else size = 2;
    } else if (ch < 0xf0) {
      const c2 = buf[i + 1];
      if (left < 3) {
        if (left < 2) bad = -1;
        else if (!isCont(c2) || (c2 < 0xa0 ? ch === 0xe0 : ch === 0xed)) bad = 2;
        else bad = -1;
      } else if (!isCont(c2) || (ch === 0xe0 && c2 < 0xa0) || (ch === 0xed && c2 >= 0xa0)) bad = 2;
      else if (!isCont(buf[i + 2])) bad = 3;
      else size = 3;
    } else if (ch < 0xf5) {
      const c2 = buf[i + 1];
      if (left < 4) {
        if (left < 2) bad = -1;
        else if (!isCont(c2) || (c2 < 0x90 ? ch === 0xf0 : ch === 0xf4)) bad = 2;
        else if (left < 3) bad = -1;
        else if (!isCont(buf[i + 2])) bad = 3;
        else bad = -1;
      } else if (!isCont(c2) || (ch === 0xf0 && c2 < 0x90) || (ch === 0xf4 && c2 >= 0x90)) bad = 2;
      else if (!isCont(buf[i + 2])) bad = 3;
      else if (!isCont(buf[i + 3])) bad = 4;
      else size = 4;
    } else bad = 1;
    if (bad === 0) {
      i += size;
      continue;
    }
    if (bad === -1) return [i, n, "unexpected end of data"];
    if (bad === 1) return [i, i + 1, "invalid start byte"];
    return [i, i + bad - 1, "invalid continuation byte"];
  }
  return null;
}

const STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const REPLACE = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/**
 * `buf.decode("utf-8")` (`sig`: "utf-8-sig", one leading BOM dropped; `replace`:
 * errors="replace"). A strict decode that fails throws UnicodeDecodeError in Python's words —
 * positions after the BOM under utf-8-sig, as CPython reports them.
 */
export function decodeUtf8(buf, { sig = false, replace = false } = {}) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (sig && b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  if (replace) return REPLACE.decode(b);
  const err = utf8Error(b);
  if (err) throw new UnicodeDecodeError("utf-8", b, ...err);
  return STRICT.decode(b);
}

// ── base64.b64decode ─────────────────────────────────────────────────────────

/** binascii.Error (a ValueError). */
export class Base64Error extends ValueError {
  constructor(m) {
    super(m);
    this.name = "Error";
  }
}

const B64_TABLE = new Int16Array(256).fill(-1);
for (const [i, c] of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].entries()) {
  B64_TABLE[c.charCodeAt(0)] = i;
}

/**
 * `base64.b64decode(s, validate=…)` — a port of CPython 3.12's `binascii.a2b_base64`
 * (validate = its strict mode), messages included (measured against Python 2026-10-08).
 * Non-strict skips characters outside the alphabet and stops at a complete padding run;
 * strict refuses them. A str holding non-ASCII is Python's ValueError.
 */
export function b64decode(s, validate = false) {
  if (typeof s === "string" && /[^\x00-\x7f]/.test(s)) throw new ValueError("string argument should contain only ASCII characters");
  const data = typeof s === "string" ? Buffer.from(s, "latin1") : Buffer.from(s);
  const out = Buffer.alloc(Math.floor((data.length * 3) / 4) + 3);
  let n = 0;
  let quadPos = 0;
  let leftchar = 0;
  let pads = 0;
  let paddingStarted = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === 0x3d) {
      paddingStarted = true;
      if (validate && quadPos === 0) throw new Base64Error(i === 0 ? "Leading padding not allowed" : "Excess padding not allowed");
      if (quadPos >= 2 && quadPos + ++pads >= 4) {
        // A pad sequence means no more input is parsed; strict mode refuses data after it.
        if (validate && i + 1 < data.length) throw new Base64Error("Excess data after padding");
        return out.subarray(0, n);
      }
      continue;
    }
    const v = B64_TABLE[ch];
    if (v < 0) {
      if (validate) throw new Base64Error("Only base64 data is allowed");
      continue;
    }
    if (validate && paddingStarted) throw new Base64Error("Discontinuous padding not allowed");
    pads = 0;
    switch (quadPos) {
      case 0:
        quadPos = 1;
        leftchar = v;
        break;
      case 1:
        quadPos = 2;
        out[n++] = ((leftchar << 2) | (v >> 4)) & 0xff;
        leftchar = v & 0x0f;
        break;
      case 2:
        quadPos = 3;
        out[n++] = ((leftchar << 4) | (v >> 2)) & 0xff;
        leftchar = v & 0x03;
        break;
      default:
        quadPos = 0;
        out[n++] = ((leftchar << 6) | v) & 0xff;
        leftchar = 0;
    }
  }
  if (quadPos === 1) {
    throw new Base64Error(
      `Invalid base64-encoded string: number of data characters (${Math.floor(n / 3) * 4 + 1}) cannot be 1 more than a multiple of 4`,
    );
  }
  if (quadPos !== 0) throw new Base64Error("Incorrect padding");
  return out.subarray(0, n);
}
