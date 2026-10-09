// SPDX-License-Identifier: MIT
// Port of tests/test_probe_models.py — the draft-model-probe endpoint: lists a provider's
// models from an UNSAVED draft (the Add/Edit form's "Fetch models" before the provider is
// registered).
import { expect, test } from "vitest";
import { router } from "../src/llm/api.js";
import { createServer } from "../src/platform/server.js";

function post(payload) {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", router());
  return app.request("/v1/llm-providers/probe-models", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

test("unknown_provider_type_400", async () => {
  const r = await post({ providerType: "nope" });
  expect(r.status).toBe(400);
});

test("known_type_unreachable_is_graceful", async () => {
  // A constructable type pointed at a dead port returns 200 with an empty list (never a
  // 500). The openai-compat adapter swallows its own connection error and returns [], so the
  // form just shows "no models" rather than crashing.
  const r = await post({ providerType: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" });
  expect(r.status).toBe(200);
  expect((await r.json()).models).toEqual([]);
});
