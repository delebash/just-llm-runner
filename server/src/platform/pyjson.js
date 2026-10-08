// SPDX-License-Identifier: MIT
// Python's text formats, byte for byte, wherever text is stored or hashed (the Electron
// move's §10 Q4): old and new servers then write the same bytes, so databases compare
// cell for cell and the render-cache keys survive.
//
// `pyJson(value, opts)` is `json.dumps(value, …)` for the options a call site passes:
//   separators  — default [", ", ": "] (json.dumps' own); compact is [",", ":"]
//   sortKeys    — sort_keys=True (UTF-16 order; differs from Python only for keys holding
//                 characters beyond U+FFFF)
//   ensureAscii — default true: every non-ASCII character as \uXXXX (surrogate pairs for
//                 astral ones, as Python writes them)
//   floats      — the keys whose numbers are floats. JavaScript can't tell 1.0 from 1, and
//                 Python writes a whole-number float as "1.0" — so a stored float field
//                 must be named here (or its value wrapped with `pyFloatValue`). Measured:
//                 the only difference a faithful port showed across 355 stored JSON cells.
//   indent      — json.dumps(indent=n)
//   allowNan    — default true; false is allow_nan=False: a NaN or infinity throws
//                 Python's ValueError instead of writing NaN / Infinity
//
// Beside json.dumps, what reads or writes a Python float in text: `json.loads` (jsonLoads,
// jsonLoadsExact — CPython's scanner and error words — and pyJsonParse, JSON.parse keeping a
// whole-number float a PyFloat), `str()` / `repr()` of a parsed value (pyStrOf, pyRepr,
// pyStrScalar), `float()` / `int()` of one (pyFloatOf, pyIntOfNumber, pyIntOf) and
// `format(x, ".Nf")` / `format(x, "g")` (pyFixed, pyFormatG). One copy for the family, since
// 2026-10-08.

import { asciiDigits, cmp, cpIndex, OverflowError, pyInt, pyStr, strip, strRepr, ValueError } from "./py.js";

/** A number Python holds as a float, whatever its key — `pyJson` writes it with a ".0". */
export class PyFloat {
  constructor(v) {
    this.v = v;
  }
  valueOf() {
    return this.v;
  }
  toJSON() {
    return this.v;
  }
  /** str(x): "2.0", as Python writes a float — not "[object Object]". */
  toString() {
    return pyFloat(this.v);
  }
}
export const pyFloatValue = (v) => new PyFloat(Number(v));

/** A deep copy that keeps PyFloat (structuredClone turns one into a plain `{v}` object). */
export function pyClone(v) {
  if (v === null || typeof v !== "object" || v instanceof PyFloat) return v;
  if (Array.isArray(v)) return v.map(pyClone);
  if (v instanceof Date) return new Date(v.getTime());
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = pyClone(x);
  return out;
}

/** Python's repr() of a float — the text json.dumps writes for it. */
export function pyFloat(x) {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mant, e] = x.toExponential().split("e");
  const exp = Number(e);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  if (exp >= -4 && exp < 16) {
    let s;
    if (exp >= 0) {
      const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
      const frac = digits.slice(exp + 1);
      s = `${intPart}.${frac || "0"}`;
    } else {
      s = `0.${"0".repeat(-exp - 1)}${digits}`;
    }
    return (neg ? "-" : "") + s;
  }
  const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${neg ? "-" : ""}${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

function pyStrLit(s, ensureAscii) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || (ensureAscii && c > 0x7e)) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

export function pyJson(value, opts = {}) {
  const indent = opts.indent ?? null;
  const separators = opts.separators || (indent != null ? [",", ": "] : [", ", ": "]);
  const sortKeys = !!opts.sortKeys;
  const ensureAscii = opts.ensureAscii ?? true;
  const floats = opts.floats instanceof Set ? opts.floats : new Set(opts.floats || []);
  const [itemSep, keySep] = separators;
  const pad = typeof indent === "number" ? " ".repeat(indent) : indent;
  const allowNan = opts.allowNan ?? true;
  const float = (x) => {
    if (!allowNan && !Number.isFinite(x)) {
      const word = Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
      throw new ValueError(`Out of range float values are not JSON compliant: ${word}`);
    }
    return pyFloat(x);
  };

  const enc = (v, key, depth) => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (v instanceof PyFloat) return float(v.v);
    if (typeof v === "number") return Number.isInteger(v) && !floats.has(key) ? String(v) : float(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return pyStrLit(v, ensureAscii);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      const parts = v.map((x) => enc(x, key, depth + 1));
      if (pad == null) return `[${parts.join(itemSep)}]`;
      const inner = `\n${pad.repeat(depth + 1)}`;
      return `[${inner}${parts.join(itemSep + inner)}\n${pad.repeat(depth)}]`;
    }
    if (typeof v === "object") {
      // A Map keeps its key order exactly (integer-like keys included, which a plain object
      // would move first) — what a dict read from a file holds in Python.
      const entries = v instanceof Map ? [...v.entries()].map(([k, x]) => [String(k), x]) : Object.entries(v);
      const items = entries.filter(([, x]) => x !== undefined);
      // sort_keys sorts by code point, as Python does (not UTF-16 units).
      if (sortKeys) items.sort((a, b) => cmp(a[0], b[0]));
      if (!items.length) return "{}";
      const parts = items.map(([k, x]) => `${pyStrLit(k, ensureAscii)}${keySep}${enc(x, k, depth + 1)}`);
      if (pad == null) return `{${parts.join(itemSep)}}`;
      const inner = `\n${pad.repeat(depth + 1)}`;
      return `{${inner}${parts.join(itemSep + inner)}\n${pad.repeat(depth)}}`;
    }
    throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
  };
  return enc(value, null, 0);
}

/** `json.dumps(v, sort_keys=True, separators=(",", ":"))` — the hashing form. */
export const pyJsonCompact = (value, opts = {}) => pyJson(value, { separators: [",", ":"], sortKeys: true, ...opts });

/** A PyFloat (a float kept for Python's text) read as its number; anything else as it is. */
export const unwrap = (v) => (v instanceof PyFloat ? v.v : v);

/** `int(v)` (py.js's pyInt) that also takes a PyFloat. */
export const pyIntOf = (v) => pyInt(unwrap(v));

// ── str() / repr() of a parsed JSON value ────────────────────────────────────

function intText(v) {
  if (Number.isSafeInteger(v)) return String(v);
  if (Number.isInteger(v)) return BigInt(v).toString();
  return pyFloat(v);
}

function floatText(x) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  return pyFloat(x);
}

/** `repr(v)` of a parsed JSON value. */
export function pyRepr(v) {
  return typeof v === "string" ? strRepr(v) : pyStrOf(v);
}

/** `str(v)` of a parsed JSON value (None, bool, int, float, str, list, dict) — a PyFloat is
 * a float ("2.0", "nan"), a whole number an int (digits past 2^53 included), a list or dict
 * its repr. */
export function pyStrOf(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (v instanceof PyFloat) return floatText(v.v);
  if (typeof v === "number") return Number.isFinite(v) ? intText(v) : floatText(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${strRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  return String(v);
}

/**
 * `str(v)` of a scalar headed for a TEXT column (the LLM stores' seed and switch values):
 * strings as they are, None/True/False as Python spells them, a PyFloat (or a non-integral
 * number) as Python's float repr, an integral number as Python's int. Unlike `pyStrOf` it
 * writes a NaN PyFloat "NaN", an integer past 1e21 in exponent form and a list or object as
 * JavaScript's String() — the values these columns take are none of those.
 */
export function pyStrScalar(v) {
  if (typeof v === "string") return v;
  if (v instanceof PyFloat) return pyFloat(v.v);
  if (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v)) return pyFloat(v);
  return pyStr(v);
}

// ── float() / int() of a parsed JSON value ───────────────────────────────────

/** `isinstance(v, (int, float))` — a bool is an int in Python. */
export const isNumber = (v) => typeof v === "number" || typeof v === "boolean" || v instanceof PyFloat;

const FLOAT_TEXT = /^[-+]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][-+]?\d(?:_?\d)*)?$/;

/**
 * `float(v)` of any value, as CPython reads it — TypeError for None, a list or a dict;
 * ValueError (with the str's repr) for a string it can't read; Python's whitespace around
 * and a decimal digit in any script accepted. (`py.pyFloatParse` is the narrower reader the
 * kit's own values use: ASCII digits, JavaScript's trim.)
 */
export function pyFloatOf(v) {
  if (v instanceof PyFloat) return v.v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = asciiDigits(strip(v));
    const low = t.toLowerCase();
    if (/^[-+]?(?:inf|infinity)$/.test(low)) return low.startsWith("-") ? -Infinity : Infinity;
    if (/^[-+]?nan$/.test(low)) return Number.NaN;
    if (!FLOAT_TEXT.test(t)) throw new ValueError(`could not convert string to float: ${strRepr(v)}`);
    return Number(t.replace(/_/g, ""));
  }
  const name = v === null || v === undefined ? "NoneType" : Array.isArray(v) ? "list" : "dict";
  throw new TypeError(`float() argument must be a string or a real number, not '${name}'`);
}

/** `int(v)` of a number (a parsed int, float or bool): truncated; NaN and infinities raise. */
export function pyIntOfNumber(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  const x = v instanceof PyFloat ? v.v : v;
  if (Number.isNaN(x)) throw new ValueError("cannot convert float NaN to integer");
  if (!Number.isFinite(x)) throw new OverflowError("cannot convert float infinity to integer");
  return Math.trunc(x);
}

// ── float formats ────────────────────────────────────────────────────────────

/** `format(x, f".{d}f")` — correctly rounded with ties to even, as Python formats a float
 * (JavaScript's toFixed breaks an exact tie upward: 0.125 → "0.13", Python "0.12"); the
 * sign kept on a negative that rounds to zero ("-0.00"). */
export function pyFixed(x, d) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  // From 1e21 toFixed answers in exponent form; such a double is a whole number.
  if (Math.abs(x) >= 1e21) return `${BigInt(x)}${d ? `.${"0".repeat(d)}` : ""}`;
  const wide = Math.abs(x).toFixed(Math.min(100, d + 30));
  const cut = wide.indexOf(".") + 1 + d; // where the kept digits end
  const rest = wide.slice(cut);
  let out = Math.abs(x).toFixed(d);
  if (/^50*$/.test(rest)) {
    // An exact tie: keep the even last digit.
    const kept = d ? wide.slice(0, cut) : wide.slice(0, cut - 1);
    const last = Number(kept[kept.length - 1]);
    if (last % 2 === 0) out = kept;
  }
  return x < 0 || Object.is(x, -0) ? `-${out}` : out;
}

/** The exact decimal expansion of a finite, non-negative double. */
function exactDecimal(ax) {
  if (ax >= 1e21) return BigInt(ax).toString(); // an integer
  // From 2^-20 up a double has at most 72 fraction digits: toFixed(100) writes them all.
  if (ax >= 2 ** -20) return ax.toFixed(100);
  // Below, mantissa × 2^-k exactly: the digits of mantissa × 5^k, k of them after the point.
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, ax);
  const bits = view.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let k = 1074; // a subnormal
  if (expBits !== 0) {
    mant |= 1n << 52n;
    k = 1075 - expBits;
  }
  const digits = (mant * 5n ** BigInt(k)).toString().padStart(k + 1, "0");
  return `${digits.slice(0, -k)}.${digits.slice(-k)}`;
}

/**
 * `format(x, "g")` — Python's general float format at precision 6, correctly rounded
 * (half-even on the double's exact decimal value, which JS's toPrecision does not do:
 * 123456.5 → "123456", not "123457").
 */
export function pyFormatG(x, precision = 6) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  if (x === 0) return neg ? "-0" : "0";
  const ax = Math.abs(x);
  const exact = exactDecimal(ax);
  const [ip, fp = ""] = exact.split(".");
  let exp10;
  let digits;
  if (ip !== "0") {
    exp10 = ip.length - 1;
    digits = ip + fp;
  } else {
    const lead = fp.length - fp.replace(/^0+/, "").length;
    exp10 = -(lead + 1);
    digits = fp.slice(lead);
  }
  const p = Math.max(1, precision);
  const keep = digits.slice(0, p).padEnd(p, "0");
  const rest = digits.slice(p);
  let n = BigInt(keep);
  const above = rest[0] > "5" || (rest[0] === "5" && /[1-9]/.test(rest.slice(1)));
  const tie = rest[0] === "5" && !/[1-9]/.test(rest.slice(1));
  if (above || (tie && n % 2n === 1n)) n += 1n;
  let sig = n.toString();
  if (sig.length > p) {
    exp10 += 1;
    sig = sig.slice(0, p);
  }
  let out;
  if (exp10 >= -4 && exp10 < p) {
    if (exp10 >= 0) {
      const intPart = sig.slice(0, exp10 + 1).padEnd(exp10 + 1, "0");
      const frac = sig.slice(exp10 + 1).replace(/0+$/, "");
      out = frac ? `${intPart}.${frac}` : intPart;
    } else {
      const frac = `${"0".repeat(-exp10 - 1)}${sig}`.replace(/0+$/, "");
      out = `0.${frac}`;
    }
  } else {
    const tail = sig.slice(1).replace(/0+$/, "");
    const mant = tail ? `${sig[0]}.${tail}` : sig[0];
    out = `${mant}e${exp10 < 0 ? "-" : "+"}${String(Math.abs(exp10)).padStart(2, "0")}`;
  }
  return (neg ? "-" : "") + out;
}

// ── json.loads ───────────────────────────────────────────────────────────────

/**
 * `json.loads` for stored text whose numbers have no model to type them (a free `dict`, an
 * effects chain): a whole-number FLOAT literal ("1.0", "-20.0", "1e3") comes back as a
 * PyFloat, so writing it again (pyJson) or hashing it keeps Python's "1.0". Everything else
 * is plain JSON.parse (its errors, a fractional float as a plain number) — a PyFloat reads as
 * its number through `Number(x)` / `+x`.
 */
export function pyJsonParse(text) {
  return JSON.parse(text, (_k, v, ctx) =>
    typeof v === "number" && Number.isInteger(v) && ctx?.source && /[.eE]/.test(ctx.source) ? pyFloatValue(v) : v,
  );
}

/** Python's JSONDecodeError (a ValueError): "<msg>: line L column C (char P)". */
export class JSONDecodeError extends ValueError {
  /** `pos` is a UTF-16 index into `doc`; the message counts code points, as Python does. */
  constructor(msg, doc, pos) {
    const cp = cpIndex(doc, pos);
    const before = doc.slice(0, pos);
    const lineno = before.split("\n").length;
    const nl = before.lastIndexOf("\n");
    const colno = nl < 0 ? cp + 1 : cp - cpIndex(doc, nl);
    super(`${msg}: line ${lineno} column ${colno} (char ${cp})`);
    this.name = "JSONDecodeError";
    this.msg = msg;
    this.pos = cp;
    this.lineno = lineno;
    this.colno = colno;
  }
}

class StopScan {
  constructor(pos) {
    this.pos = pos;
  }
}

const JSON_WS = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;

function skipWs(s, i) {
  while (i < s.length && JSON_WS(s[i])) i++;
  return i;
}

function scanString(s, start) {
  // start = the index after the opening quote (CPython's c_scanstring, strict).
  const begin = start - 1;
  let out = "";
  let i = start;
  for (;;) {
    let j = i;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 0x22 || c === 0x5c || c <= 0x1f) break;
      j++;
    }
    if (j >= s.length) throw new JSONDecodeError("Unterminated string starting at", s, begin);
    out += s.slice(i, j);
    const t = s[j];
    if (t === '"') return [out, j + 1];
    if (t !== "\\") throw new JSONDecodeError("Invalid control character at", s, j);
    const esc = s[j + 1];
    if (esc === undefined) throw new JSONDecodeError("Unterminated string starting at", s, begin);
    if (esc !== "u") {
      const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (!(esc in map)) throw new JSONDecodeError("Invalid \\escape", s, j);
      out += map[esc];
      i = j + 2;
      continue;
    }
    const hex = s.slice(j + 2, j + 6);
    if (j + 6 >= s.length || !/^[0-9A-Fa-f]{4}$/.test(hex)) throw new JSONDecodeError("Invalid \\uXXXX escape", s, j + 1);
    // A surrogate pair is two units in JavaScript either way: each escape decodes on its own.
    out += String.fromCharCode(Number.parseInt(hex, 16));
    i = j + 6;
  }
}

// The two shapes a parsed document can take (see jsonLoads / jsonLoadsExact).
const PLAIN = {
  object: () => ({}),
  set: (o, k, v) => {
    o[k] = v;
  },
  int: (text) => Number(text),
};
const EXACT = {
  object: () => new Map(),
  set: (o, k, v) => o.set(k, v), // a repeated key keeps its first place and its last value
  int: (text) => {
    const n = Number(text);
    return Number.isSafeInteger(n) ? (Object.is(n, -0) ? 0 : n) : BigInt(text);
  },
};

function scanOnce(s, idx, shape) {
  if (idx >= s.length) throw new StopScan(idx);
  const c = s[idx];
  if (c === '"') return scanString(s, idx + 1);
  if (c === "{") return parseObject(s, idx + 1, shape);
  if (c === "[") return parseArray(s, idx + 1, shape);
  if (c === "n" && s.startsWith("null", idx)) return [null, idx + 4];
  if (c === "t" && s.startsWith("true", idx)) return [true, idx + 4];
  if (c === "f" && s.startsWith("false", idx)) return [false, idx + 5];
  if (c === "N" && s.startsWith("NaN", idx)) return [new PyFloat(Number.NaN), idx + 3];
  if (c === "I" && s.startsWith("Infinity", idx)) return [new PyFloat(Infinity), idx + 8];
  if (c === "-" && s.startsWith("-Infinity", idx)) return [new PyFloat(-Infinity), idx + 9];
  NUMBER.lastIndex = idx;
  const m = NUMBER.exec(s);
  if (!m) throw new StopScan(idx);
  const text = m[0];
  const end = idx + text.length;
  return m[1] !== undefined || m[2] !== undefined ? [new PyFloat(Number(text)), end] : [shape.int(text), end];
}

function parseObject(s, idx, shape) {
  const out = shape.object();
  idx = skipWs(s, idx);
  if (idx < s.length && s[idx] === "}") return [out, idx + 1];
  for (;;) {
    if (idx >= s.length || s[idx] !== '"') {
      throw new JSONDecodeError("Expecting property name enclosed in double quotes", s, idx);
    }
    const [key, afterKey] = scanString(s, idx + 1);
    idx = skipWs(s, afterKey);
    if (idx >= s.length || s[idx] !== ":") throw new JSONDecodeError("Expecting ':' delimiter", s, idx);
    idx = skipWs(s, idx + 1);
    const [value, afterValue] = scanOnce(s, idx, shape);
    shape.set(out, key, value);
    idx = skipWs(s, afterValue);
    if (idx < s.length && s[idx] === "}") return [out, idx + 1];
    if (idx >= s.length || s[idx] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", s, idx);
    idx = skipWs(s, idx + 1);
  }
}

function parseArray(s, idx, shape) {
  const out = [];
  idx = skipWs(s, idx);
  if (idx < s.length && s[idx] === "]") return [out, idx + 1];
  for (;;) {
    const [value, after] = scanOnce(s, idx, shape);
    out.push(value);
    idx = skipWs(s, after);
    if (idx < s.length && s[idx] === "]") return [out, idx + 1];
    if (idx >= s.length || s[idx] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", s, idx);
    idx = skipWs(s, idx + 1);
  }
}

function rawDecode(s, idx, shape) {
  try {
    return scanOnce(s, idx, shape);
  } catch (e) {
    if (e instanceof StopScan) throw new JSONDecodeError("Expecting value", s, e.pos);
    throw e;
  }
}

function loads(s, shape) {
  if (s.startsWith("﻿")) throw new JSONDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", s, 0);
  const [value, end] = rawDecode(s, skipWs(s, 0), shape);
  const tail = skipWs(s, end);
  if (tail !== s.length) throw new JSONDecodeError("Extra data", s, tail);
  return value;
}

/** `json.JSONDecoder().raw_decode(s, idx)` → [value, end] (UTF-16 indexes), values as
 * `jsonLoads` gives them. */
export const jsonRawDecode = (s, idx = 0) => rawDecode(s, idx, PLAIN);

/**
 * `json.loads(s)` with CPython's C scanner's rules and its JSONDecodeError words and positions
 * (code points). Values as plain JavaScript: an object is a plain object, an int a number, a
 * float literal (and NaN / Infinity, which Python reads) a PyFloat — so `str(2.0)` is "2.0"
 * and an LLM answering `{"id": 2.0}` does not read as line 2. Like any plain object it moves
 * integer-like keys first and reads an int past 2^53 approximately; `jsonLoadsExact` keeps
 * both.
 */
export const jsonLoads = (s) => loads(s, PLAIN);

/**
 * `json.loads(text)` as `jsonLoads` reads it, kept exact: an object is a Map (the file's key
 * order, integer-like keys included — a rebuilt locale file keeps its source's order), an
 * int past 2^53 a BigInt, and "-0" the int 0. `text` is read as a string (`String(text)`).
 */
export const jsonLoadsExact = (text) => loads(String(text), EXACT);
