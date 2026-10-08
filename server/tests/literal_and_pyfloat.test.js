// SPDX-License-Identifier: MIT
// Three Python behaviours JustVoice's API wave found missing (2026-10-08): a Literal's 422 is
// ONE literal_error naming every value in Python's repr (pydantic 2.13's words, printed from
// TypeAdapter); bool(0.0) is False for a PyFloat; str() of a PyFloat is Python's float text.
import { expect, test } from "vitest";
import { literal, nullable, opt, T } from "../src/platform/models.js";
import { truthy } from "../src/platform/py.js";
import { PyFloat, pyFloatValue } from "../src/platform/pyjson.js";
import { createServer } from "../src/platform/server.js";

function app() {
  const a = createServer({ typeBase: "t/" });
  const body = T.Object({
    mode: opt(literal("auto", "gpu", "cpu"), "auto"),
    one: opt(T.Literal("x"), "x"),
    maybe: opt(nullable(literal("a", "b")), null),
    num: opt(literal(1, 2), 1),
  });
  a.post("/l", { schema: { body } }, async (r) => r.body);
  return a;
}

const errorsFor = async (payload) => (await app().inject({ method: "POST", url: "/l", payload })).json().errors;

test("a_literal_answers_one_literal_error_naming_every_value", async () => {
  expect(await errorsFor({ mode: "npu" })).toEqual([{ loc: ["body", "mode"], msg: "Input should be 'auto', 'gpu' or 'cpu'", type: "literal_error" }]);
  expect(await errorsFor({ one: "y" })).toEqual([{ loc: ["body", "one"], msg: "Input should be 'x'", type: "literal_error" }]);
  expect(await errorsFor({ maybe: "c" })).toEqual([{ loc: ["body", "maybe"], msg: "Input should be 'a' or 'b'", type: "literal_error" }]);
  expect(await errorsFor({ num: 3 })).toEqual([{ loc: ["body", "num"], msg: "Input should be 1 or 2", type: "literal_error" }]);
});

test("a_good_literal_still_passes", async () => {
  const r = await app().inject({ method: "POST", url: "/l", payload: { mode: "gpu", maybe: null, num: 2 } });
  expect(r.json()).toEqual({ mode: "gpu", one: "x", maybe: null, num: 2 });
});

test("a_pyfloat_is_truthy_as_its_number", () => {
  expect(truthy(pyFloatValue(0))).toBe(false);
  expect(truthy(new PyFloat(-0))).toBe(false);
  expect(truthy(pyFloatValue(2))).toBe(true);
  expect(truthy(pyFloatValue(Number.NaN))).toBe(true);
});

test("a_pyfloat_prints_as_python_writes_it", () => {
  expect(`${pyFloatValue(2)}`).toBe("2.0");
  expect(String(pyFloatValue(0.1))).toBe("0.1");
  expect(String(pyFloatValue(1e16))).toBe("1e+16");
});
