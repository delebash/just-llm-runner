// SPDX-License-Identifier: MIT
// platform/cors.js — Starlette 1.3.1's CORSMiddleware. Every expected header below was
// measured on JustWrite's Python server (Starlette 1.3.1), 2026-10-08, when JustWrite's port
// was checked; the hook moved here from JustWrite the same day.
import { expect, test } from "vitest";
import { CorsMiddleware } from "../src/platform/cors.js";
import { createServer } from "../src/platform/server.js";

function client(opts) {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(CorsMiddleware, opts);
  app.route({ method: ["GET", "PUT"], url: "/v1/health", handler: async () => ({ ok: true }) });
  return app;
}

const cors = (r) =>
  Object.fromEntries(Object.entries(r.headers).filter(([k]) => k.startsWith("access-control") || k === "vary"));

const SETTINGS = {
  allowOrigins: ["http://ok.example"],
  allowOriginRegex: "https://.*\\.trusted\\.dev",
  allowCredentials: true,
  allowMethods: ["*"],
  allowHeaders: ["*"],
};
const ALLOW_ALL = { allowOrigins: ["*"], allowMethods: ["*"], allowHeaders: ["*"] };

test("no_origin_is_left_alone", async () => {
  const r = await client(ALLOW_ALL).inject({ method: "GET", url: "/v1/health" });
  expect(cors(r)).toEqual({});
});

test("allow_all_stamps_a_star", async () => {
  const r = await client(ALLOW_ALL).inject({ method: "GET", url: "/v1/health", headers: { origin: "app://justwrite" } });
  expect(r.statusCode).toBe(200);
  expect(cors(r)).toEqual({ "access-control-allow-origin": "*" });
});

test("listed_origins_are_mirrored_with_credentials", async () => {
  const app = client(SETTINGS);
  let r = await app.inject({ method: "GET", url: "/v1/health", headers: { origin: "http://ok.example" } });
  expect(cors(r)).toEqual({
    "access-control-allow-credentials": "true",
    "access-control-allow-origin": "http://ok.example",
    vary: "Origin",
  });
  r = await app.inject({ method: "GET", url: "/v1/health", headers: { origin: "https://a.trusted.dev" } });
  expect(r.headers["access-control-allow-origin"]).toBe("https://a.trusted.dev");
  // Not allowed: no origin header, but the credentials header still (Starlette does).
  r = await app.inject({ method: "GET", url: "/v1/health", headers: { origin: "http://evil.example" } });
  expect(cors(r)).toEqual({ "access-control-allow-credentials": "true" });
});

test("preflight_answers_ok_or_400", async () => {
  const app = client(SETTINGS);
  let r = await app.inject({
    method: "OPTIONS",
    url: "/v1/health",
    headers: {
      origin: "http://ok.example",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "Content-Type, X-Custom",
    },
  });
  expect(r.statusCode).toBe(200);
  expect(r.body).toBe("OK");
  expect(cors(r)).toEqual({
    vary: "Origin",
    "access-control-allow-methods": "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT",
    "access-control-max-age": "600",
    "access-control-allow-credentials": "true",
    "access-control-allow-origin": "http://ok.example",
    "access-control-allow-headers": "Content-Type, X-Custom",
  });
  r = await app.inject({
    method: "OPTIONS",
    url: "/v1/health",
    headers: { origin: "http://evil.example", "access-control-request-method": "PUT" },
  });
  expect(r.statusCode).toBe(400);
  expect(r.body).toBe("Disallowed CORS origin");
  expect(r.headers["access-control-allow-origin"]).toBeUndefined();
});
