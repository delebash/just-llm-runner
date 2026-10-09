// SPDX-License-Identifier: MIT
// The family server keeps pydantic's null: a nullable field arrives as null, never ""/0
// (ajv's coercion did that inside a nullable union), and query text converts as pydantic does.
import { expect, test } from "vitest";
import { nullable, opt, strictObject, T } from "../src/platform/models.js";
import { createServer, input } from "../src/platform/server.js";

function app() {
  const a = createServer({ typeBase: "t/" });
  a.post("/b", input({ body: T.Object({ a: opt(nullable(T.String()), null), b: opt(nullable(T.Integer()), null), n: opt(T.Number(), 1.5) }) }), (c) => c.json(c.req.valid("json")));
  a.post("/s", input({ body: strictObject({ x: opt(T.Integer(), 0) }) }), (c) => c.json(c.req.valid("json")));
  a.get("/q", input({ querystring: T.Object({ n: opt(nullable(T.Integer()), null), f: opt(T.Boolean(), false), ids: opt(T.Array(T.String()), []) }) }), (c) => c.json(c.req.valid("query")));
  return a;
}

/** A JSON body POSTed, with its content type. */
const post = (a, url, payload) =>
  a.request(url, { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });

test("nullable body fields stay null; numbers convert as pydantic", async () => {
  const a = app();
  expect(await (await post(a, "/b", {})).json()).toEqual({ a: null, b: null, n: 1.5 });
  expect(await (await post(a, "/b", { a: null, b: null })).json()).toEqual({ a: null, b: null, n: 1.5 });
  expect(await (await post(a, "/b", { a: "", b: "7", n: "2" })).json()).toEqual({ a: "", b: 7, n: 2 });
  const bad = await post(a, "/b", { a: 5 });
  expect(bad.status).toBe(422);
  expect((await bad.json()).errors[0]).toMatchObject({ loc: ["body", "a"], type: "string_type" });
});

test("a forbidding model answers extra_forbidden", async () => {
  const r = await post(app(), "/s", { x: 1, y: 2 });
  expect(r.status).toBe(422);
  expect((await r.json()).errors).toEqual([{ loc: ["body", "y"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }]);
});

test("query text converts as pydantic: ints, bools, lists, null default", async () => {
  const a = app();
  expect(await (await a.request("/q")).json()).toEqual({ n: null, f: false, ids: [] });
  expect(await (await a.request("/q?n=3&f=yes&ids=a")).json()).toEqual({ n: 3, f: true, ids: ["a"] });
  expect(await (await a.request("/q?ids=a&ids=b&n=1&n=2")).json()).toEqual({ n: 2, f: false, ids: ["a", "b"] });
  expect((await a.request("/q?n=x")).status).toBe(422);
});

test("errors come in field-declaration order, as pydantic reports them", async () => {
  // ajv reports `required` misses first; pydantic walks the fields in order (JustWrite's
  // `POST /v1/images {"name": 5}`, measured on Python 2026-10-08: name, then data).
  const a = createServer({ typeBase: "t/" });
  a.post("/img", input({ body: T.Object({ name: T.String(), data: T.String(), alt: opt(T.String(), "") }) }), (c) => c.json(c.req.valid("json")));
  const r = await post(a, "/img", { name: 5, alt: 3 });
  expect(r.status).toBe(422);
  expect((await r.json()).errors.map((e) => [e.loc.join("."), e.type])).toEqual([
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
