// SPDX-License-Identifier: MIT
// The reasoning-map router (llm/reasoning_map_api.js) — not a Python test file (Python
// tests the store and the resolver, in test_reasoning.py; reasoning.test.js ports those).
// The expected answers are what the Python router gave through FastAPI's TestClient on
// 2026-10-07, including Starlette's path matching.
import { beforeEach, expect, test } from "vitest";
import { makeReasoningMapRouter } from "../src/llm/reasoning_map_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

let app;
beforeEach(() => {
  const h = freshDb();
  h.tx(() => {
    seed.seedDefaultProviders(h);
    seed.seedDefaultReasoningMap(h);
  });
  app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(makeReasoningMapRouter(stores.getReasoningMapStore));
});
const call = async (method, url, payload) => {
  const r = await app.inject(payload === undefined ? { method, url } : { method, url, payload });
  return [r.statusCode, r.json()];
};

test("get and put by provider, levels in ascending order", async () => {
  expect((await call("GET", "/v1/ai/reasoning-map/local-llamacpp"))[1].rows.map((r) => r.level)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const [status, body] = await call("PUT", "/v1/ai/reasoning-map/local-llamacpp", { level: "high", word: "w", tokens: null });
  expect(status).toBe(200);
  expect(body.rows[2]).toEqual({ level: "high", word: "w", tokens: null }); // null stays null (no number form)
  expect(await call("PUT", "/v1/ai/reasoning-map/new-prov", { level: "low", word: "low" })).toEqual([
    200,
    { provider: "new-prov", rows: [{ level: "low", word: "low", tokens: null }] },
  ]);
});

test("refusals answer as FastAPI did", async () => {
  const [status, body] = await call("PUT", "/v1/ai/reasoning-map/local-llamacpp", { level: "ultra" });
  expect(status).toBe(400);
  expect(body.detail).toBe("level must be one of ('low', 'medium', 'high', 'xhigh', 'max')");
  expect(await call("GET", "/v1/ai/reasoning-map/%20")).toEqual([
    400,
    {
      type: "https://example.test/errors/bad-request",
      title: "Bad Request",
      status: 400,
      detail: "provider is required",
      instance: "/v1/ai/reasoning-map/ ",
    },
  ]);
  // Starlette's {provider} is one non-empty segment of the DECODED path
  expect(await call("GET", "/v1/ai/reasoning-map/a%2Fb")).toEqual([404, { detail: "Not Found" }]);
  expect(await call("GET", "/v1/ai/reasoning-map/")).toEqual([404, { detail: "Not Found" }]);
});
