// SPDX-License-Identifier: MIT
// The guards' `prefixes` (2026-10-08): the bearer auth and the CSRF Origin check guard `/v1` by
// default, and an app may name more path prefixes — JustVoice guards its MCP endpoint, `/mcp`,
// like its API. Paths outside every prefix stay open, as the static UI always was.
import { expect, test } from "vitest";
import { bearerAuth } from "../src/platform/auth.js";
import { csrfOrigin } from "../src/platform/csrf.js";
import { createServer } from "../src/platform/server.js";

const TYPE_BASE = "https://example.test/errors/";
const REMOTE = "192.0.2.10";

function app(opts = {}) {
  const a = createServer({ typeBase: TYPE_BASE });
  a.use("*", csrfOrigin({ typeBase: TYPE_BASE, ...opts }));
  a.use("*", bearerAuth({ readAuth: () => [["t"], true], typeBase: TYPE_BASE, ...opts }));
  for (const p of ["/v1/things", "/mcp", "/ui/page"]) a.on(["GET", "POST"], p, (c) => c.json({ ok: true }));
  return a;
}

// The client at REMOTE, as @hono/node-server hands its socket to the app (`clientHost` reads it).
const status = async (a, method, url, headers = {}) =>
  (await a.request(url, { method, headers }, { incoming: { socket: { remoteAddress: REMOTE } } })).status;

test("by_default_only_v1_is_guarded", async () => {
  const a = app();
  expect(await status(a, "GET", "/v1/things")).toBe(401);
  expect(await status(a, "GET", "/mcp")).toBe(200);
  expect(await status(a, "POST", "/mcp", { origin: "http://evil.example" })).toBe(200);
});

test("an_apps_own_prefixes_are_guarded_like_v1", async () => {
  const a = app({ prefixes: ["/v1", "/mcp"] });
  expect(await status(a, "GET", "/mcp")).toBe(401);
  expect(await status(a, "GET", "/mcp", { authorization: "Bearer t" })).toBe(200);
  expect(await status(a, "GET", "/mcp", { authorization: "Bearer x" })).toBe(403);
  expect(await status(a, "POST", "/mcp", { origin: "http://evil.example", authorization: "Bearer t" })).toBe(403);
  expect(await status(a, "GET", "/v1/things")).toBe(401); // the API stays guarded
  expect(await status(a, "GET", "/ui/page")).toBe(200); // everything else stays open
});
