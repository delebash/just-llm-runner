// SPDX-License-Identifier: MIT
// Port of tests/test_routing_api.py — makeRoutingRouter: GET merges catalog + the global
// default; PUT persists the default. Per-feature pins were removed 2026-07-15 (the preset is
// the one source).
import { expect, test } from "vitest";
import { FeatureCatalogEntry, makeRoutingRouter, RoutingConfig } from "../src/llm/routing_api.js";
import { model } from "../src/platform/models.js";
import { createServer } from "../src/platform/server.js";

class MemStore {
  constructor() {
    this.cfg = model(RoutingConfig, {});
  }
  getRouting() {
    return this.cfg;
  }
  setRouting(cfg) {
    this.cfg = cfg;
  }
}

const CATALOG = [
  FeatureCatalogEntry({ key: "critique", label: "Critique", hint: "line notes", group: "Analysis" }),
  FeatureCatalogEntry({ key: "brainstorm", label: "Brainstorm", hint: "ideas", group: "Drafting" }),
];

function client() {
  const store = new MemStore();
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(makeRoutingRouter(() => store, () => CATALOG));
  return [app, store];
}

test("get_merges_catalog_with_default", async () => {
  const [c] = client();
  const body = (await c.inject({ method: "GET", url: "/v1/ai/routing" })).json();
  expect(body.default).toEqual({ llmId: "", model: "", embeddingId: "", embeddingModel: "" });
  const feats = Object.fromEntries(body.features.map((f) => [f.key, f]));
  expect(new Set(Object.keys(feats))).toEqual(new Set(["critique", "brainstorm"]));
  expect(feats.critique.label === "Critique" && feats.critique.group === "Analysis").toBe(true);
  // Per-feature pins are gone — the row is catalog metadata only, and there is no `pins`
  // map on the response any more.
  expect("providerId" in feats.critique).toBe(false);
  expect("pins" in body).toBe(false);
});

test("put_persists_defaults", async () => {
  const [c, store] = client();
  const r = await c.inject({ method: "PUT", url: "/v1/ai/routing", payload: { default: { llmId: "openai", embeddingId: "ollama-local" } } });
  expect(r.statusCode).toBe(200);
  expect(store.getRouting().default.llmId).toBe("openai");
  const body = (await c.inject({ method: "GET", url: "/v1/ai/routing" })).json();
  expect(body.default.llmId).toBe("openai");
  expect(body.default.embeddingId).toBe("ollama-local");
  // the defaults pydantic fills inside the nested model reach the store too
  expect(body.default).toEqual({ llmId: "openai", model: "", embeddingId: "ollama-local", embeddingModel: "" });
});

test("put_response_is_the_merged_view", async () => {
  const [c] = client();
  const body = (await c.inject({ method: "PUT", url: "/v1/ai/routing", payload: { default: { llmId: "x", embeddingId: "" } } })).json();
  expect(body.default.llmId).toBe("x");
  expect(body.features.length).toBe(2); // catalog still rendered
});
