// SPDX-License-Identifier: MIT
// Port of tests/test_auth_middleware.py — the family's bearer-auth policy
// (platform/auth.js).
//
// What these pin: no tokens → open; tokens → loopback open unless "require a token even
// on localhost"; the lockout escape (health and the server-auth door answer from the
// machine itself); and an app's own `loopbackOpenPaths` (2026-09-30 — JustVoice's
// `/v1/shutdown`, so its shell can close the server with that setting on), which stay
// gated from anywhere else. The parametrized Python test runs its two cases in one test.
import { expect, test } from "vitest";
import { BearerAuthMiddleware, isLoopback } from "../src/platform/auth.js";
import { CsrfOriginMiddleware } from "../src/platform/csrf.js";
import { createServer } from "../src/platform/server.js";

const LOCAL = "127.0.0.1";
const REMOTE = "192.0.2.10";

function client(tokens, requireForLoopback, where, opts = {}) {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(BearerAuthMiddleware, {
    readAuth: () => [tokens, requireForLoopback],
    typeBase: "https://example.test/errors/",
    ...opts,
  });
  for (const p of ["/v1/health", "/v1/server-auth", "/v1/shutdown", "/v1/things"]) {
    app.route({ method: ["GET", "POST"], url: p, handler: async () => ({ ok: true }) });
  }
  const call = (method) => async (url, headers = {}) =>
    (await app.inject({ method, url, headers, remoteAddress: where })).statusCode;
  return { get: call("GET"), post: call("POST"), app };
}

test("no_tokens_means_no_auth", async () => {
  expect(await client([], true, REMOTE).get("/v1/things")).toBe(200);
});

test("loopback_passes_unless_a_token_is_required_there_too", async () => {
  expect(await client(["t"], false, LOCAL).get("/v1/things")).toBe(200);
  expect(await client(["t"], true, LOCAL).get("/v1/things")).toBe(401);
  expect(await client(["t"], true, LOCAL).get("/v1/things", { Authorization: "Bearer t" })).toBe(200);
  expect(await client(["t"], true, LOCAL).get("/v1/things", { Authorization: "Bearer x" })).toBe(403);
});

test("the_lockout_escape_answers_from_the_machine_only", async () => {
  for (const p of ["/v1/health", "/v1/server-auth"]) {
    expect(await client(["t"], true, LOCAL).get(p)).toBe(200);
    expect(await client(["t"], true, REMOTE).get(p)).toBe(401);
  }
});

test("an_apps_own_open_paths_answer_from_the_machine_only", async () => {
  for (const [where, status] of [
    [LOCAL, 200],
    [REMOTE, 401],
  ]) {
    const c = client(["t"], true, where, { loopbackOpenPaths: ["/v1/shutdown"] });
    expect(await c.post("/v1/shutdown")).toBe(status);
    expect(await c.get("/v1/things")).toBe(401); // nothing else opened
  }
});

test("an_app_that_names_no_paths_is_unchanged", async () => {
  expect(await client(["t"], true, LOCAL).post("/v1/shutdown")).toBe(401);
});

// Not in the Python file: the bodies Python sends (measured against the Python
// middleware, 2026-10-07), the gate running before routing, and the loopback test.
test("the_answers_match_the_python_middleware", async () => {
  const { app } = client(["t"], true, REMOTE);
  let r = await app.inject({ method: "GET", url: "/v1/things", remoteAddress: REMOTE });
  expect(r.headers["content-type"]).toMatch(/^application\/problem\+json/);
  expect(r.json()).toEqual({
    type: "https://example.test/errors/unauthorized",
    title: "Unauthorized",
    status: 401,
    detail: "Authorization header missing or malformed",
    instance: "/v1/things",
  });
  r = await app.inject({ method: "GET", url: "/v1/things", remoteAddress: REMOTE, headers: { authorization: "Bearer x" } });
  expect(r.json()).toEqual({
    type: "https://example.test/errors/forbidden",
    title: "Forbidden",
    status: 403,
    detail: "Bearer token not accepted",
    instance: "/v1/things",
  });
  // an unknown /v1 path is gated before it can be a 404 — as the middleware was
  r = await app.inject({ method: "GET", url: "/v1/nothing", remoteAddress: REMOTE });
  expect(r.statusCode).toBe(401);
  r = await app.inject({ method: "GET", url: "/v1/nothing", remoteAddress: REMOTE, headers: { authorization: "Bearer t" } });
  expect(r.statusCode).toBe(404);
  expect(r.json()).toEqual({ detail: "Not Found" });
  // outside /v1 nothing is gated
  r = await app.inject({ method: "GET", url: "/ui/x", remoteAddress: REMOTE });
  expect(r.statusCode).toBe(404);
  for (const [h, want] of [
    ["::ffff:127.0.0.1", true],
    ["127.0.0.2", true],
    ["0:0:0:0:0:0:0:1", true],
    ["::1", true],
    ["localhost", true],
    ["192.0.2.10", false],
    ["x", false],
  ]) {
    expect([h, isLoopback(h)]).toEqual([h, want]);
  }
});

// Not in any Python file (csrf.py has no test there): the CSRF hook's allow/deny and its
// 403 body, as the Python middleware answered (measured 2026-10-07).
test("csrf_rejects_foreign_origins_on_mutations_only", async () => {
  const app = createServer({ typeBase: "https://x.test/errors/" });
  // the route first, the hook after: the hook still covers it (Fastify applies a
  // context's hooks to every route in it, whenever it was declared)
  app.route({ method: ["GET", "POST"], url: "/v1/things", handler: async () => ({ ok: true }) });
  app.register(CsrfOriginMiddleware, {
    appOrigins: ["http://localhost:1430"],
    originRegex: "https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?",
    typeBase: "https://x.test/errors/",
  });
  const post = (origin) =>
    app.inject({ method: "POST", url: "/v1/things", headers: { host: "myhost:1234", ...(origin ? { origin } : {}) } });
  let r = await post("https://evil.test");
  expect(r.statusCode).toBe(403);
  expect(r.json()).toEqual({
    type: "https://x.test/errors/cross-origin",
    title: "Forbidden",
    status: 403,
    detail: "cross-origin request rejected",
    instance: "/v1/things",
  });
  for (const ok of [null, "", "http://localhost:1430", "http://localhost:9999", "tauri://localhost", "https://localhost", "capacitor://localhost", "http://myhost:1234"]) {
    expect([ok, (await post(ok)).statusCode]).toEqual([ok, 200]); // last one: the same origin
  }
  expect((await post("http://myhost:9999")).statusCode).toBe(403); // re.match anchors the start only…
  expect((await post("http://localhost:1430.evil.test")).statusCode).toBe(200); // …so this passes, as in Python
  r = await app.inject({ method: "GET", url: "/v1/things", headers: { origin: "https://evil.test" } });
  expect(r.statusCode).toBe(200); // reads are never rejected
});
