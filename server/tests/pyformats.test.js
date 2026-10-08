// SPDX-License-Identifier: MIT
// The Python-format helpers against Python itself: fixtures/python-formats.json was
// written by Python 3.12 (json.dumps, repr(float), round()) — the bytes old and new
// servers must agree on (plan §10 Q4).
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { pyFloat, pyJson, pyJsonCompact } from "../src/platform/pyjson.js";
import { cmp, pyRound, pySorted } from "../src/platform/py.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/python-formats.json", import.meta.url), "utf8"));

test("repr(float) and json.dumps(float)", () => {
  for (const [f, repr, dumped] of fx.floats) {
    expect(pyFloat(f)).toBe(repr);
    expect(pyJson(f, { floats: [null] })).toBe(dumped);
  }
});

test("round(x, n) is half-even on the exact double", () => {
  for (const [x, n, want] of fx.rounds) expect([x, n, pyRound(x, n)]).toEqual([x, n, want]);
});

test("json.dumps with each option set", () => {
  for (const [v, plain, compact, utf8, indented] of fx.dumps) {
    expect(pyJson(v)).toBe(plain);
    expect(pyJsonCompact(v)).toBe(compact);
    expect(pyJson(v, { ensureAscii: false })).toBe(utf8);
    expect(pyJson(v, { indent: 2 })).toBe(indented);
  }
});

test("a whole-number float is written 1.0 when its key is named", () => {
  expect(pyJson({ depth: 1, n: 2, xs: [1, 2.5] }, { floats: ["depth", "xs"] })).toBe(fx.float_field);
});

test("sorting compares like Python", () => {
  expect(pySorted(["b", "a", "B", "é", "z"])).toEqual(["B", "a", "b", "z", "é"]);
  expect(cmp([1, "b"], [1, "a"])).toBeGreaterThan(0);
  expect(pySorted([[2, "x"], [1, "y"], [1, "a"]])).toEqual([[1, "a"], [1, "y"], [2, "x"]]);
});
