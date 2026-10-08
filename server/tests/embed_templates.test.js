// SPDX-License-Identifier: MIT
// Port of tests/test_embed_templates.py — per-model embedding task templates (Move 0, RAG
// build 2026-07-11): /v1/ai/embeddings wraps inputs with the model's catalog template per
// taskType (nomic prefixes both sides, Qwen3 instructs the query side; no row = raw), the
// rows are seeded + editable, and the generic feature-prompt stale-heal carries a host's
// prompt-text revision to unedited existing DBs.
import { afterEach, expect, test } from "vitest";
import { router, setEmbedTemplateResolver } from "../src/llm/api.js";
import { LLMResponse } from "../src/llm/base.js";
import { makeEmbedTemplatesRouter } from "../src/llm/embed_templates_api.js";
import { getLlmRegistry } from "../src/llm/registry.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

class RecordingEmbedAdapter {
  static lastTexts = null;
  provider_id = "emb";
  provider_type = "openai-compat";
  default_model = "m";

  async chat() {
    return LLMResponse({ text: "ok", model: "m", prompt_tokens: 1, completion_tokens: 1 });
  }

  async embed(texts) {
    // taskType accepted + ignored — the route passes it unconditionally (#15 C5); this fake
    // records the (already template-wrapped) texts.
    RecordingEmbedAdapter.lastTexts = [...texts];
    return texts.map(() => [0.1, 0.2]);
  }
}

const tplRow = (document = "", query = "") => ({ documentTemplate: document, queryTemplate: query });

function client() {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(router);
  return { post: (url, payload) => app.inject({ method: "POST", url, payload }) };
}

function withFakeRegistry() {
  const reg = getLlmRegistry();
  reg._adapters = new Map();
  reg.register(new RecordingEmbedAdapter());
  RecordingEmbedAdapter.lastTexts = null;
}

afterEach(() => {
  setEmbedTemplateResolver(null);
  getLlmRegistry()._adapters = new Map();
});

test("embeddings_apply_document_and_query_templates", async () => {
  withFakeRegistry();
  setEmbedTemplateResolver((mid) => (mid === "nomic" ? tplRow("search_document: {text}", "search_query: {text}") : null));
  const c = client();
  const r = await c.post("/v1/ai/embeddings", { providerId: "emb", model: "nomic", input: ["a", "b"], taskType: "document" });
  expect(r.statusCode).toBe(200);
  expect(RecordingEmbedAdapter.lastTexts).toEqual(["search_document: a", "search_document: b"]);

  await c.post("/v1/ai/embeddings", { providerId: "emb", model: "nomic", input: ["who is X"], taskType: "query" });
  expect(RecordingEmbedAdapter.lastTexts).toEqual(["search_query: who is X"]);
});

test("embeddings_pass_through_cases", async () => {
  withFakeRegistry();
  setEmbedTemplateResolver((mid) => (mid === "qwen" ? tplRow("", "Instruct: task\nQuery: {text}") : null));
  const c = client();
  // No template row for the model (online/BYO) → raw.
  await c.post("/v1/ai/embeddings", { providerId: "emb", model: "text-embedding-3-small", input: ["a"], taskType: "query" });
  expect(RecordingEmbedAdapter.lastTexts).toEqual(["a"]);
  // Empty taskType → raw even when a row exists.
  await c.post("/v1/ai/embeddings", { providerId: "emb", model: "qwen", input: ["a"] });
  expect(RecordingEmbedAdapter.lastTexts).toEqual(["a"]);
  // Document side empty on a query-only model → raw documents.
  await c.post("/v1/ai/embeddings", { providerId: "emb", model: "qwen", input: ["a"], taskType: "document" });
  expect(RecordingEmbedAdapter.lastTexts).toEqual(["a"]);
  // Query side applies.
  await c.post("/v1/ai/embeddings", { providerId: "emb", model: "qwen", input: ["a"], taskType: "query" });
  expect(RecordingEmbedAdapter.lastTexts).toEqual(["Instruct: task\nQuery: a"]);
});

test("embeddings_no_resolver_is_raw", async () => {
  withFakeRegistry();
  setEmbedTemplateResolver(null);
  await client().post("/v1/ai/embeddings", { providerId: "emb", model: "nomic-embed-text", input: ["a"], taskType: "document" });
  expect(RecordingEmbedAdapter.lastTexts).toEqual(["a"]);
});

// ── DB: seed + store + router round-trip ─────────────────────────────────────

test("shared_seed_is_empty_and_registered_app_templates_seed", () => {
  // Decision ④ (family parity batch 2026-08-05): an embed template describes an APP's
  // catalog row, so the shared DEFAULT_EMBED_TEMPLATES is empty and an app registers its own
  // via installLlm({embedTemplates}) — carried on both seed paths by the app registration.
  expect(seed.DEFAULT_EMBED_TEMPLATES).toEqual([]);
  const h = freshDb();
  seed.configureAppSeed({ embedTemplates: [{ id: "app-embed", document: "", query: "Instruct: app task\nQuery: {text}" }] });
  try {
    h.tx(() => seed.seedDefaultEmbedTemplates(h));
    const row = stores.getEmbedTemplateStore().get("app-embed");
    expect(row.documentTemplate).toBe("");
    expect(row.queryTemplate.startsWith("Instruct: ")).toBe(true);
  } finally {
    seed.configureAppSeed({ embedTemplates: [] }); // never leak into sibling tests
  }
});

test("seed_never_clobbers_user_edit", () => {
  const h = freshDb();
  seed.configureAppSeed({ embedTemplates: [{ id: "app-embed", document: "", query: "Instruct: app task\nQuery: {text}" }] });
  try {
    h.tx(() => seed.seedDefaultEmbedTemplates(h));
    const st = stores.getEmbedTemplateStore();
    st.upsert({ modelId: "app-embed", documentTemplate: "my: {text}", queryTemplate: "" });
    h.tx(() => seed.seedDefaultEmbedTemplates(h)); // reseed = merge-by-id
    expect(st.get("app-embed").documentTemplate).toBe("my: {text}");
  } finally {
    seed.configureAppSeed({ embedTemplates: [] });
  }
});

test("router_crud_round_trip", async () => {
  freshDb();
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(makeEmbedTemplatesRouter(stores.getEmbedTemplateStore));
  let r = await app.inject({
    method: "PUT",
    url: "/v1/ai/embed-templates",
    payload: { modelId: "my-embed", documentTemplate: "d: {text}", queryTemplate: "q: {text}" },
  });
  expect(r.statusCode).toBe(200);
  const rows = Object.fromEntries(r.json().rows.map((x) => [x.modelId, x]));
  expect(rows["my-embed"].documentTemplate).toBe("d: {text}");
  r = await app.inject({ method: "DELETE", url: "/v1/ai/embed-templates?modelId=my-embed" });
  expect(r.json().rows.every((x) => x.modelId !== "my-embed")).toBe(true);
  expect((await app.inject({ method: "PUT", url: "/v1/ai/embed-templates", payload: { modelId: " " } })).statusCode).toBe(400);
});

// ── the generic feature-prompt stale-heal (host-provided map) ────────────────

test("prompt_heal_refreshes_only_unedited_rows", () => {
  const h = freshDb();
  const oldText = "OLD chat system";
  const newText = "NEW chat system with story bible";
  seed.configureAppSeed({
    featurePrompts: {
      chat: { feature: "chat", system: oldText, user_template: "u1" },
      other: { feature: "other", system: "other sys", user_template: "u2" },
    },
  });
  try {
    h.tx(() => seed.seedDefaultFeaturePrompts(h));
    // The host revises the seed text and registers the heal for the OLD text.
    seed.configureAppSeed({
      featurePrompts: {
        chat: { feature: "chat", system: newText, user_template: "u1-new" },
        other: { feature: "other", system: "other sys CHANGED", user_template: "u2" },
      },
      featurePromptHeals: { chat: [oldText] },
    });
    h.tx(() => seed.seedDefaultFeaturePrompts(h));
    const chatRow = h.get("feature_prompts", "chat");
    const otherRow = h.get("feature_prompts", "other");
    // Healed: system byte-equalled the registered old text → system refreshed;
    // user_template is deliberately NOT healed (a user may have edited it).
    expect(chatRow.system).toBe(newText);
    expect(chatRow.user_template).toBe("u1");
    // No heal registered for "other" → insert-if-missing leaves it stale (by design).
    expect(otherRow.system).toBe("other sys");

    // A USER-EDITED prompt is never touched, even with the heal registered.
    h.update("feature_prompts", { system: "the user's own words" }, { key: "chat" });
    h.tx(() => seed.seedDefaultFeaturePrompts(h));
    expect(h.get("feature_prompts", "chat").system).toBe("the user's own words");
  } finally {
    seed.configureAppSeed({ featurePrompts: {}, featurePromptHeals: {} });
  }
});
