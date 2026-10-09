// SPDX-License-Identifier: MIT
// The request-body float opt-in (`createServer({pyFloats})`, platform/server.js — JustVoice's
// app.js had it as installPyFloatBodies until 2026-10-08): a route that opts in reads `1.0` as
// a PyFloat in its free (`Any`) fields and as the plain number its model types, every body as
// sent rides on `c.get("sentBody")`, and an app that doesn't ask keeps plain JSON.parse bodies.
import { expect, test } from "vitest";
import { opt, T } from "../src/platform/models.js";
import { PyFloat, pyJson } from "../src/platform/pyjson.js";
import { createServer, input, installPyFloatBodies, readJson } from "../src/platform/server.js";

const Body = T.Object({ a: opt(T.Number(), 0), n: opt(T.Integer(), 0), free: opt(T.Record(T.String(), T.Any()), {}) });
/** What a handler saw: the stored text Python would write, and the body as sent. */
const seen = async (c) => {
  const body = c.req.valid("json");
  const sent = c.get("sentBody");
  return c.json({
    stored: pyJson(body),
    aIsNumber: typeof body?.a === "number",
    sent: sent === undefined ? "none" : pyJson(sent),
  });
};

function app(opts) {
  const a = createServer({ typeBase: "t/", ...opts });
  a.post("/opt", input({ body: Body, pyFloats: true }), seen);
  a.post("/plain", input({ body: Body }), seen);
  a.patch("/named", input({ body: Body }), seen);
  a.post("/free", async (c) => c.json({ stored: pyJson((await readJson(c)) ?? null) }));
  return a;
}
const json = { "content-type": "application/json" };
const BODY = '{"a": 1.0, "n": 2, "free": {"x": 1.0, "y": 2.5, "z": [1e3]}}';

test("an opted-in route keeps a free field's floats and types the model's numbers", async () => {
  const a = app({ pyFloats: { routes: ["PATCH /named"] } });
  const r = await a.request("/opt", { method: "POST", headers: json, body: BODY });
  expect(await r.json()).toEqual({
    stored: '{"a": 1, "n": 2, "free": {"x": 1.0, "y": 2.5, "z": [1000.0]}}',
    aIsNumber: true,
    sent: '{"a": 1, "n": 2, "free": {"x": 1.0, "y": 2.5, "z": [1000.0]}}',
  });
  // A kit-built route named in `routes` opts in the same way.
  const n = await a.request("/named", { method: "PATCH", headers: json, body: BODY });
  expect((await n.json()).stored).toBe('{"a": 1, "n": 2, "free": {"x": 1.0, "y": 2.5, "z": [1000.0]}}');
});

test("any other route reads plain JSON; the body as sent still rides along", async () => {
  const a = app({ pyFloats: { routes: [] } });
  const r = await a.request("/plain", { method: "POST", headers: json, body: '{"free": {"x": 1.0}}' });
  // the defaults filled after it was read are not part of what was sent
  expect(await r.json()).toEqual({ stored: '{"a": 0, "n": 0, "free": {"x": 1}}', aIsNumber: true, sent: '{"free": {"x": 1}}' });
  // no content type: read as JSON, as FastAPI does (sent as bytes — a string body would carry
  // text/plain)
  const free = await a.request("/free", { method: "POST", body: new TextEncoder().encode('{"v": 2.0}') });
  expect(await free.json()).toEqual({ stored: '{"v": 2}' });
});

test("bad JSON and an empty body answer as they do without the opt-in", async () => {
  const answers = [];
  for (const opts of [{ pyFloats: { routes: [] } }, {}]) {
    const a = app(opts);
    const bad = await a.request("/opt", { method: "POST", headers: json, body: '{"a": 1.0,' });
    const empty = await a.request("/free", { method: "POST", headers: json, body: "" });
    answers.push([bad.status, await bad.json(), await empty.json()]);
  }
  expect(answers[0]).toEqual(answers[1]);
  expect(answers[0][0]).toBe(422); // the kit's json_invalid, as FastAPI answers
  expect(answers[0][2]).toEqual({ stored: "null" });
});

test("without the option the server parses as before: no PyFloats, no sentBody", async () => {
  const a = app();
  const r = await a.request("/opt", { method: "POST", headers: json, body: BODY });
  expect(await r.json()).toEqual({ stored: '{"a": 1, "n": 2, "free": {"x": 1, "y": 2.5, "z": [1000]}}', aIsNumber: true, sent: "none" });
});

test("installPyFloatBodies on a bare server reads bodies as the option does", async () => {
  const a = createServer({ typeBase: "t/" });
  installPyFloatBodies(a); // before the route: a Hono middleware covers only the routes added after it
  let body;
  a.post("/x", async (c) => {
    body = await readJson(c, { pyFloats: true });
    return c.json({});
  });
  await a.request("/x", { method: "POST", headers: json, body: '{"k": 3.0}' });
  expect(body.k).toBeInstanceOf(PyFloat);
  expect(Number(body.k)).toBe(3);
});
