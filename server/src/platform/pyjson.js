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

import { cmp, ValueError } from "./py.js";

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
