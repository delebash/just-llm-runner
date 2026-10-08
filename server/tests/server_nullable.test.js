// SPDX-License-Identifier: MIT
// The family server keeps pydantic's null: a nullable field arrives as null, never ""/0
// (ajv's coercion did that inside a nullable union), and query text converts as pydantic does.
import { expect, test } from "vitest";
import { nullable, opt, strictObject, T } from "../src/platform/models.js";
import { createServer } from "../src/platform/server.js";

function app() {
  const a = createServer({ typeBase: "t/" });
  a.post("/b", { schema: { body: T.Object({ a: opt(nullable(T.String()), null), b: opt(nullable(T.Integer()), null), n: opt(T.Number(), 1.5) }) } }, async (r) => r.body);
  a.post("/s", { schema: { body: strictObject({ x: opt(T.Integer(), 0) }) } }, async (r) => r.body);
  a.get("/q", { schema: { querystring: T.Object({ n: opt(nullable(T.Integer()), null), f: opt(T.Boolean(), false), ids: opt(T.Array(T.String()), []) }) } }, async (r) => r.query);
  return a;
}

test("nullable body fields stay null; numbers convert as pydantic", async () => {
  const a = app();
  expect((await a.inject({ method: "POST", url: "/b", payload: {} })).json()).toEqual({ a: null, b: null, n: 1.5 });
  expect((await a.inject({ method: "POST", url: "/b", payload: { a: null, b: null } })).json()).toEqual({ a: null, b: null, n: 1.5 });
  expect((await a.inject({ method: "POST", url: "/b", payload: { a: "", b: "7", n: "2" } })).json()).toEqual({ a: "", b: 7, n: 2 });
  const bad = await a.inject({ method: "POST", url: "/b", payload: { a: 5 } });
  expect(bad.statusCode).toBe(422);
  expect(bad.json().errors[0]).toMatchObject({ loc: ["body", "a"], type: "string_type" });
});

test("a forbidding model answers extra_forbidden", async () => {
  const r = await app().inject({ method: "POST", url: "/s", payload: { x: 1, y: 2 } });
  expect(r.statusCode).toBe(422);
  expect(r.json().errors).toEqual([{ loc: ["body", "y"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }]);
});

test("query text converts as pydantic: ints, bools, lists, null default", async () => {
  const a = app();
  expect((await a.inject({ url: "/q" })).json()).toEqual({ n: null, f: false, ids: [] });
  expect((await a.inject({ url: "/q?n=3&f=yes&ids=a" })).json()).toEqual({ n: 3, f: true, ids: ["a"] });
  expect((await a.inject({ url: "/q?ids=a&ids=b&n=1&n=2" })).json()).toEqual({ n: 2, f: false, ids: ["a", "b"] });
  expect((await a.inject({ url: "/q?n=x" })).statusCode).toBe(422);
});

test("errors come in field-declaration order, as pydantic reports them", async () => {
  // ajv reports `required` misses first; pydantic walks the fields in order (JustWrite's
  // `POST /v1/images {"name": 5}`, measured on Python 2026-10-08: name, then data).
  const a = createServer({ typeBase: "t/" });
  a.post("/img", { schema: { body: T.Object({ name: T.String(), data: T.String(), alt: opt(T.String(), "") }) } }, async (r) => r.body);
  const r = await a.inject({ method: "POST", url: "/img", payload: { name: 5, alt: 3 } });
  expect(r.statusCode).toBe(422);
  expect(r.json().errors.map((e) => [e.loc.join("."), e.type])).toEqual([
    ["body.name", "string_type"],
    ["body.data", "missing"],
    ["body.alt", "string_type"],
  ]);
});

test("model keeps a PyFloat and names its error", async () => {
  const { PyFloat } = await import("../src/platform/pyjson.js");
  const { model, ModelValidationError, T } = await import("../src/platform/models.js");
  const S = T.Object({ chain: T.Any(), n: T.Integer() });
  const v = model(S, { chain: { gain: new PyFloat(1) }, n: 2 });
  expect(v.chain.gain).toBeInstanceOf(PyFloat);
  try {
    model(S, { n: "x" });
    throw new Error("no error");
  } catch (e) {
    expect(e).toBeInstanceOf(ModelValidationError);
    expect(e.name).toBe("ModelValidationError");
  }
});
