// SPDX-License-Identifier: MIT
// The request-body float opt-in (`createServer({pyFloats})`, platform/server.js — JustVoice's
// app.js had it as installPyFloatBodies until 2026-10-08): a route that opts in reads `1.0` as
// a PyFloat in its free (`Any`) fields and as the plain number its model types, every body as
// sent rides on `req.sentBody`, and an app that doesn't ask keeps plain JSON.parse bodies.
import { expect, test } from "vitest";
import { opt, T } from "../src/platform/models.js";
import { PyFloat, pyJson } from "../src/platform/pyjson.js";
import { createServer, installPyFloatBodies } from "../src/platform/server.js";

const Body = T.Object({ a: opt(T.Number(), 0), n: opt(T.Integer(), 0), free: opt(T.Record(T.String(), T.Any()), {}) });
/** What a handler saw: the stored text Python would write, and the body as sent. */
const seen = async (req) => ({
  stored: pyJson(req.body),
  aIsNumber: typeof req.body?.a === "number",
  sent: req.sentBody === undefined ? "none" : pyJson(req.sentBody),
});

function app(opts) {
  const a = createServer({ typeBase: "t/", ...opts });
  a.post("/opt", { schema: { body: Body }, config: { pyFloats: true } }, seen);
  a.post("/plain", { schema: { body: Body } }, seen);
  a.patch("/named", { schema: { body: Body } }, seen);
  a.post("/free", async (req) => ({ stored: pyJson(req.body ?? null) }));
  return a;
}
const json = { "content-type": "application/json" };
const BODY = '{"a": 1.0, "n": 2, "free": {"x": 1.0, "y": 2.5, "z": [1e3]}}';

test("an opted-in route keeps a free field's floats and types the model's numbers", async () => {
  const a = app({ pyFloats: { routes: ["PATCH /named"] } });
  const r = await a.inject({ method: "POST", url: "/opt", headers: json, payload: BODY });
  expect(r.json()).toEqual({
    stored: '{"a": 1, "n": 2, "free": {"x": 1.0, "y": 2.5, "z": [1000.0]}}',
    aIsNumber: true,
    sent: '{"a": 1, "n": 2, "free": {"x": 1.0, "y": 2.5, "z": [1000.0]}}',
  });
  // A kit-built route named in `routes` opts in the same way.
  const n = await a.inject({ method: "PATCH", url: "/named", headers: json, payload: BODY });
  expect(n.json().stored).toBe('{"a": 1, "n": 2, "free": {"x": 1.0, "y": 2.5, "z": [1000.0]}}');
});

test("any other route reads plain JSON; the body as sent still rides along", async () => {
  const a = app({ pyFloats: { routes: [] } });
  const r = await a.inject({ method: "POST", url: "/plain", headers: json, payload: '{"free": {"x": 1.0}}' });
  // the defaults filled after it was read are not part of what was sent
  expect(r.json()).toEqual({ stored: '{"a": 0, "n": 0, "free": {"x": 1}}', aIsNumber: true, sent: '{"free": {"x": 1}}' });
  // no content type: read as JSON, as FastAPI does
  const free = await a.inject({ method: "POST", url: "/free", payload: '{"v": 2.0}' });
  expect(free.json()).toEqual({ stored: '{"v": 2}' });
});

test("bad JSON and an empty body answer as they do without the opt-in", async () => {
  const answers = [];
  for (const opts of [{ pyFloats: { routes: [] } }, {}]) {
    const a = app(opts);
    const bad = await a.inject({ method: "POST", url: "/opt", headers: json, payload: '{"a": 1.0,' });
    const empty = await a.inject({ method: "POST", url: "/free", headers: json, payload: "" });
    answers.push([bad.statusCode, bad.json(), empty.json()]);
  }
  expect(answers[0]).toEqual(answers[1]);
  expect(answers[0][0]).toBe(422); // the kit's json_invalid, as FastAPI answers
  expect(answers[0][2]).toEqual({ stored: "null" });
});

test("without the option the server parses as before: no PyFloats, no sentBody", async () => {
  const a = app();
  const r = await a.inject({ method: "POST", url: "/opt", headers: json, payload: BODY });
  expect(r.json()).toEqual({ stored: '{"a": 1, "n": 2, "free": {"x": 1, "y": 2.5, "z": [1000]}}', aIsNumber: true, sent: "none" });
});

test("installPyFloatBodies on a bare server reads bodies as the option does", async () => {
  const a = createServer({ typeBase: "t/" });
  installPyFloatBodies(a);
  let body;
  a.post("/x", { config: { pyFloats: true } }, async (req) => {
    body = req.body;
    return {};
  });
  await a.inject({ method: "POST", url: "/x", headers: json, payload: '{"k": 3.0}' });
  expect(body.k).toBeInstanceOf(PyFloat);
  expect(Number(body.k)).toBe(3);
});
