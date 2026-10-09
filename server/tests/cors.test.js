// SPDX-License-Identifier: MIT
// platform/cors.js — Starlette 1.3.1's CORSMiddleware. Every expected header below was
// measured on JustWrite's Python server (Starlette 1.3.1), 2026-10-08, when JustWrite's port
// was checked; the hook moved here from JustWrite the same day.
import { expect, test } from "vitest";
import { starletteCors } from "../src/platform/cors.js";
import { createServer } from "../src/platform/server.js";

function client(opts) {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.use("*", starletteCors(opts));
  app.on(["GET", "PUT"], "/v1/health", (c) => c.json({ ok: true }));
  return app;
}

const cors = (r) => Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("access-control") || k === "vary"));

const SETTINGS = {
  allowOrigins: ["http://ok.example"],
  allowOriginRegex: "https://.*\\.trusted\\.dev",
  allowCredentials: true,
  allowMethods: ["*"],
  allowHeaders: ["*"],
};
const ALLOW_ALL = { allowOrigins: ["*"], allowMethods: ["*"], allowHeaders: ["*"] };

test("no_origin_is_left_alone", async () => {
  const r = await client(ALLOW_ALL).request("/v1/health", { method: "GET" });
  expect(cors(r)).toEqual({});
});

test("allow_all_stamps_a_star", async () => {
  const r = await client(ALLOW_ALL).request("/v1/health", { method: "GET", headers: { origin: "app://justwrite" } });
  expect(r.status).toBe(200);
  expect(cors(r)).toEqual({ "access-control-allow-origin": "*" });
});

test("listed_origins_are_mirrored_with_credentials", async () => {
  const app = client(SETTINGS);
  let r = await app.request("/v1/health", { method: "GET", headers: { origin: "http://ok.example" } });
  expect(cors(r)).toEqual({
    "access-control-allow-credentials": "true",
    "access-control-allow-origin": "http://ok.example",
    vary: "Origin",
  });
  r = await app.request("/v1/health", { method: "GET", headers: { origin: "https://a.trusted.dev" } });
  expect(r.headers.get("access-control-allow-origin")).toBe("https://a.trusted.dev");
  // Not allowed: no origin header, but the credentials header still (Starlette does).
  r = await app.request("/v1/health", { method: "GET", headers: { origin: "http://evil.example" } });
  expect(cors(r)).toEqual({ "access-control-allow-credentials": "true" });
});

test("preflight_answers_ok_or_400", async () => {
  const app = client(SETTINGS);
  let r = await app.request("/v1/health", {
    method: "OPTIONS",
    headers: {
      origin: "http://ok.example",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "Content-Type, X-Custom",
    },
  });
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("OK");
  expect(cors(r)).toEqual({
    vary: "Origin",
    "access-control-allow-methods": "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT",
    "access-control-max-age": "600",
    "access-control-allow-credentials": "true",
    "access-control-allow-origin": "http://ok.example",
    "access-control-allow-headers": "Content-Type, X-Custom",
  });
  r = await app.request("/v1/health", {
    method: "OPTIONS",
    headers: { origin: "http://evil.example", "access-control-request-method": "PUT" },
  });
  expect(r.status).toBe(400);
  expect(await r.text()).toBe("Disallowed CORS origin");
  // a header that is absent reads as null on a web Response
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
});
