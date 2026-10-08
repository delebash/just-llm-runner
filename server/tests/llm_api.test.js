// SPDX-License-Identifier: MIT
// Port of tests/test_llm_api.py — the shared storage-free LLM router (usage / ping / models /
// embeddings). The built-in provider's branch reaches runner/lifecycle.js, runner/models.js
// and the catalog store lazily; the tests spy all three (Python monkeypatched the modules).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { router } from "../src/llm/api.js";
import { LLMResponse } from "../src/llm/base.js";
import { chat } from "../src/llm/dispatch.js";
import { getLlmRegistry } from "../src/llm/registry.js";
import { LLMConfig } from "../src/llm/schema.js";
import * as stores from "../src/llm/stores.js";
import { getLedger } from "../src/llm/usage.js";
import { createServer } from "../src/platform/server.js";
import * as lifecycle from "../src/runner/lifecycle.js";
import * as runnerModels from "../src/runner/models.js";

class FakeAdapter {
  provider_id = "fake";
  provider_type = "openai-compat";
  default_model = "m";
  async chat() {
    return LLMResponse({ text: "ok", model: "m", prompt_tokens: 2, completion_tokens: 3 });
  }
  async *streamChat() {
    yield "ok";
  }
  async models() {
    return ["m1", "m2"];
  }
  async ping() {
    return true;
  }
}

function client() {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(router);
  return {
    get: (url) => app.inject({ method: "GET", url }),
    post: (url, payload) => app.inject({ method: "POST", url, payload }),
    delete: (url) => app.inject({ method: "DELETE", url }),
  };
}

test("ping_and_models_use_registry", async () => {
  const reg = getLlmRegistry();
  reg._adapters = new Map();
  reg.register(new FakeAdapter());
  const c = client();
  expect((await c.post("/v1/llm-providers/fake/ping")).json()).toEqual({ ok: true });
  // The models endpoint returns the back-compatible {models, embeddings, hiddenCount} shape
  // (#8). No rules resolver is wired in this bare-router test → passthrough.
  expect((await c.get("/v1/llm-providers/fake/models")).json()).toEqual({ models: ["m1", "m2"], embeddings: [], hiddenCount: 0 });
  expect((await c.post("/v1/llm-providers/nope/ping")).statusCode).toBe(404);
  reg._adapters = new Map();
});

/** Wire the built-in branch's three lazy imports (they resolve at CALL time, so spying the
 * modules' namespaces is what reaches them). */
function builtinFixture({ cachedRepos, installed = true }) {
  const tmp = mkdtempSync(join(tmpdir(), "kit-test-"));
  const rows = [
    { id: "on-disk", hfRepo: "org/a", quant: "Q4_K_M", mmproj: null },
    { id: "catalog-only", hfRepo: "org/b", quant: "Q4_K_M", mmproj: null },
  ];
  vi.spyOn(lifecycle, "getService").mockReturnValue({
    engineStatus: () => ({ installed, build: "b9993", gpu: "cuda" }),
    cacheRoot: tmp,
  });
  vi.spyOn(stores, "getModelCatalogStore").mockReturnValue({ list: () => rows });
  vi.spyOn(runnerModels, "isCached").mockImplementation((repo, _quant, { cacheRoot }) => {
    expect(cacheRoot).toBe(join(tmp, "hf"));
    return cachedRepos.has(repo);
  });
}

test("builtin_models_lists_only_downloaded", async () => {
  // The built-in provider answers "what can run RIGHT NOW" — the models list is what is ON
  // DISK, never every catalog row (user ruling 2026-07-16). The catalog is the place you
  // download FROM.
  builtinFixture({ cachedRepos: new Set(["org/a"]) });
  const body = (await client().get("/v1/llm-providers/local-llamacpp/models")).json();
  expect(body.models).toEqual(["on-disk"]); // the un-downloaded row is NOT offered
  expect("error" in body).toBe(false);
});

test("builtin_health_counts_downloaded_and_total", async () => {
  // The health line names BOTH numbers: a short/empty picker reads as "download one", not as
  // a broken provider. And a catalog with nothing on disk is NOT ok.
  builtinFixture({ cachedRepos: new Set() });
  const body = (await client().get("/v1/llm-providers/local-llamacpp/models")).json();
  expect(body.models).toEqual([]);
  expect(body.error).toContain("0 of 2 models downloaded");
});

class FakeEmbedAdapter extends FakeAdapter {
  provider_id = "emb";
  seenTaskType = null; // records what the route passed through (#15 C5)
  async embed(texts, { model = null, taskType = "" } = {}) {
    void model;
    this.seenTaskType = taskType;
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
}

test("embeddings_via_registry", async () => {
  const reg = getLlmRegistry();
  reg._adapters = new Map();
  reg.register(new FakeEmbedAdapter());
  reg.register(new FakeAdapter()); // has no embed()
  const c = client();
  const r = await c.post("/v1/ai/embeddings", { providerId: "emb", model: "e", input: ["a", "b"] });
  expect(r.statusCode).toBe(200);
  const body = r.json();
  expect(body.embeddings.length === 2 && JSON.stringify(body.embeddings[0]) === "[0.1,0.2,0.3]").toBe(true);
  expect(body.model).toBe("e");
  // A registered provider with no embeddings support → clear 400.
  expect((await c.post("/v1/ai/embeddings", { providerId: "fake", input: ["x"] })).statusCode).toBe(400);
  // Unregistered → 404.
  expect((await c.post("/v1/ai/embeddings", { providerId: "nope", input: ["x"] })).statusCode).toBe(404);
  reg._adapters = new Map();
});

test("embeddings_passes_task_type_through", async () => {
  // C5: the route calls embed(taskType) UNCONDITIONALLY (no signature sniffing) — a Gemini
  // embed model needs the RETRIEVAL_* side.
  const reg = getLlmRegistry();
  reg._adapters = new Map();
  const fake = new FakeEmbedAdapter();
  reg.register(fake);
  const r = await client().post("/v1/ai/embeddings", { providerId: "emb", model: "e", input: ["a"], taskType: "query" });
  expect(r.statusCode).toBe(200);
  expect(fake.seenTaskType).toBe("query"); // the route handed body.taskType to the adapter
  reg._adapters = new Map();
});

test("ai_usage_reflects_ledger", async () => {
  getLedger().clear();
  const reg = getLlmRegistry();
  reg._adapters = new Map();
  reg.register(new FakeAdapter());
  await chat({ config: LLMConfig(), feature: "demo", messages: [] });
  const c = client();
  const snap = (await c.get("/v1/ai-usage")).json();
  expect(snap.total_calls === 1 && snap.by_feature.demo.calls === 1).toBe(true);
  expect((await c.delete("/v1/ai-usage")).json()).toEqual({ cleared: true });
  expect((await c.get("/v1/ai-usage")).json().total_calls).toBe(0);
  reg._adapters = new Map();
});
