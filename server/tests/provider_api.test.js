// SPDX-License-Identifier: MIT
// Port of tests/test_provider_api.py — the shared provider-CRUD router factory (over an
// in-memory ProviderStore).
import { expect, test, vi } from "vitest";
import { makeProviderRouter, PROVIDER_TYPES } from "../src/llm/provider_api.js";
import { getLlmRegistry } from "../src/llm/registry.js";
import * as http from "../src/platform/http.js";
import { createServer } from "../src/platform/server.js";

/** In-memory ProviderStore for tests. */
class MemStore {
  constructor() {
    this.rows = [];
  }
  list() {
    return [...this.rows];
  }
  get(pid) {
    return this.rows.find((p) => p.id === pid) ?? null;
  }
  add(cfg) {
    this.rows.push(cfg);
  }
  replace(pid, cfg) {
    this.rows = this.rows.map((p) => (p.id === pid ? cfg : p));
  }
  remove(pid) {
    this.rows = this.rows.filter((p) => p.id !== pid);
  }
}

function client(store, allowKeyReveal = false) {
  getLlmRegistry()._adapters = new Map();
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", makeProviderRouter(() => store, allowKeyReveal));
  // an object payload goes as JSON, with its content type
  const send = (method) => (url, payload) =>
    app.request(
      url,
      payload === undefined
        ? { method }
        : { method, body: JSON.stringify(payload), headers: { "content-type": "application/json" } },
    );
  return {
    get: (url) => app.request(url, { method: "GET" }),
    post: send("POST"),
    patch: send("PATCH"),
    delete: (url) => app.request(url, { method: "DELETE" }),
  };
}

test("crud_lifecycle_and_registry_sync", async () => {
  const store = new MemStore();
  const c = client(store);

  // create — persisted + registered live
  let r = await c.post("/v1/llm-providers", { id: "oa", name: "OpenAI", providerType: "openai", apiKey: "sk-x", defaultModel: "gpt-4o-mini" });
  expect(r.status).toBe(201);
  const body = await r.json();
  expect(body.hasApiKey === true && !("apiKey" in body) && body.registered === true).toBe(true);
  expect(body.local).toBe(true); // default Local/Online choice round-trips
  expect(getLlmRegistry().ids()).toContain("oa");

  // list reflects the registered flag, never echoes the key
  const lst = await (await c.get("/v1/llm-providers")).json();
  expect(lst.providers.map((p) => p.id)).toEqual(["oa"]);
  expect(lst.providerTypes).toContain("openai");

  // duplicate id rejected
  expect((await c.post("/v1/llm-providers", { id: "oa", name: "x", providerType: "openai" })).status).toBe(400);
  // bad type rejected
  expect((await c.post("/v1/llm-providers", { id: "z", name: "x", providerType: "nope" })).status).toBe(400);

  // patch — empty apiKey preserves the prior key
  r = await c.patch("/v1/llm-providers/oa", { id: "oa", name: "OpenAI 2", providerType: "openai", apiKey: "", defaultModel: "gpt-4o" });
  expect(r.status === 200 && (await r.json()).name === "OpenAI 2").toBe(true);
  expect(store.get("oa").apiKey).toBe("sk-x"); // preserved
  expect(store.get("oa").defaultModel).toBe("gpt-4o");

  // patch missing → 404
  expect((await c.patch("/v1/llm-providers/nope", { id: "nope", name: "x", providerType: "openai" })).status).toBe(404);

  // delete — removed + deregistered
  expect(await (await c.delete("/v1/llm-providers/oa")).json()).toEqual({ deleted: true });
  expect(store.get("oa") === null && !getLlmRegistry().ids().includes("oa")).toBe(true);
  expect((await c.delete("/v1/llm-providers/oa")).status).toBe(404);
});

test("id_derived_from_name_and_local_flag", async () => {
  // No id supplied → slug derived from name (+ deduped); the Local/Online choice is stored
  // and echoed, not inferred from the URL.
  const store = new MemStore();
  const c = client(store);

  const r = await c.post("/v1/llm-providers", { name: "My Local LLM", providerType: "openai-compat", local: true });
  expect(r.status).toBe(201);
  const created = await r.json();
  expect(created.id === "my-local-llm" && created.local === true).toBe(true);

  // same name again → deduped, not a collision error
  const r2 = await c.post("/v1/llm-providers", { name: "My Local LLM", providerType: "openai-compat" });
  expect(r2.status === 201 && (await r2.json()).id === "my-local-llm-2").toBe(true);

  // an online provider keeps local=false even at a non-URL-revealing endpoint
  const r3 = await c.post("/v1/llm-providers", { name: "OpenAI", providerType: "openai", local: false });
  const online = await r3.json();
  expect(online.id === "openai" && online.local === false).toBe(true);
});

test("patch_apikey_empty_preserves_even_when_local_flips", async () => {
  // #1 regression (2026-07-08): the form used to send apiKey=None whenever the where-it-runs
  // toggle read Local, silently wiping a stored key. Contract: "" preserves the key no matter
  // what `local` says; null stays the EXPLICIT clear for deliberate clients.
  const store = new MemStore();
  const c = client(store);
  await c.post("/v1/llm-providers", { name: "Claude", providerType: "anthropic", apiKey: "sk-a", local: false });
  expect(store.get("claude").apiKey).toBe("sk-a");

  // the fixed-form edit body: "" preserves — even with local=true in the same body
  let r = await c.patch("/v1/llm-providers/claude", { name: "Claude", providerType: "anthropic", apiKey: "", local: true });
  expect(r.status).toBe(200);
  expect(store.get("claude").apiKey).toBe("sk-a");
  expect((await r.json()).hasApiKey).toBe(true);

  // explicit clear remains available: null wipes
  r = await c.patch("/v1/llm-providers/claude", { name: "Claude", providerType: "anthropic", apiKey: null, local: false });
  expect(r.status).toBe(200);
  expect(store.get("claude").apiKey).toBeNull();
  expect((await r.json()).hasApiKey).toBe(false);
});

test("key_reveal_opt_in_returns_stored_key", async () => {
  // #12 C6: when the host opts in, POST /key/reveal returns the stored plaintext key so the
  // form can pre-fill a masked, editable field; an unknown id 404s.
  const store = new MemStore();
  const c = client(store, true);
  await c.post("/v1/llm-providers", { name: "Claude", providerType: "anthropic", apiKey: "sk-secret", local: false });
  const r = await c.post("/v1/llm-providers/claude/key/reveal");
  const revealed = await r.json();
  expect(r.status === 200 && revealed.apiKey === "sk-secret").toBe(true);
  expect(revealed).toEqual({ apiKey: "sk-secret" });
  // a provider with no stored key reveals ""
  await c.post("/v1/llm-providers", { name: "Keyless", providerType: "openai-compat", local: true });
  expect(await (await c.post("/v1/llm-providers/keyless/key/reveal")).json()).toEqual({ apiKey: "" });
  // unknown id → 404
  expect((await c.post("/v1/llm-providers/nope/key/reveal")).status).toBe(404);
});

test("key_reveal_absent_by_default", async () => {
  // The SAFE default (allowKeyReveal off) — the credential-returning route is simply NOT
  // registered (404).
  const store = new MemStore();
  const c = client(store); // default allowKeyReveal=false
  await c.post("/v1/llm-providers", { name: "Claude", providerType: "anthropic", apiKey: "sk-secret", local: false });
  expect((await c.post("/v1/llm-providers/claude/key/reveal")).status).toBe(404);
});

test("detect_local", async () => {
  vi.spyOn(http, "fetch").mockImplementation(async (url) => {
    if (url.includes("11434")) return Response.json({ models: [{ name: "qwen3:14b" }] }); // Ollama /api/tags
    if (url.includes("1234")) return Response.json({ data: [{ id: "lmstudio-model" }] }); // LM Studio /v1/models
    throw new Error("down");
  });
  const det = (await (await client(new MemStore()).get("/v1/llm-providers/detect-local")).json()).detected;
  const byType = Object.fromEntries(det.map((d) => [d.providerType, d]));
  expect(byType.ollama.models).toContain("qwen3:14b");
  expect(byType.ollama.alreadyRegistered).toBe(false);
  // LM Studio must detect as the CANONICAL openai-compat — a creatable PROVIDER_TYPES value,
  // not "openai_compat" which would 400 on create.
  expect(byType["openai-compat"].models).toContain("lmstudio-model");
  expect(det.every((d) => PROVIDER_TYPES.includes(d.providerType))).toBe(true);
});

// Not in the Python file: the answers' exact shapes (checked against the Python router).
test("the provider router answers as FastAPI did", async () => {
  const store = new MemStore();
  const c = client(store);
  let r = await c.post("/v1/llm-providers", { name: "Ollama Box", providerType: "ollama", baseUrl: "http://x:1" });
  expect(await r.json()).toEqual({
    id: "ollama-box",
    name: "Ollama Box",
    providerType: "ollama",
    baseUrl: "http://x:1",
    defaultModel: "",
    embeddingModel: "",
    hasApiKey: false,
    registered: true,
    timeoutSeconds: 60,
    local: true,
  });
  r = await c.post("/v1/llm-providers", { name: "x", providerType: "nope" });
  expect((await r.json()).detail).toBe(
    "unknown providerType 'nope'. Allowed: anthropic, openai, openai-compat, gemini, ollama, deepseek, openrouter, xai, mistral, local-llamacpp",
  );
  r = await c.post("/v1/llm-providers", { name: "", providerType: "openai" });
  expect(r.status).toBe(422);
  expect((await r.json()).errors).toEqual([{ loc: ["body", "name"], msg: "String should have at least 1 character", type: "string_too_short" }]);
  r = await c.post("/v1/llm-providers", { name: "  ++Weird Name!! ", providerType: "openai" });
  expect((await r.json()).id).toBe("weird-name");
  r = await c.post("/v1/llm-providers", { name: "ollama box", providerType: "ollama" });
  expect((await r.json()).id).toBe("ollama-box-2");
  r = await c.post("/v1/llm-providers", { id: "oa", name: "x", providerType: "openai" });
  r = await c.post("/v1/llm-providers", { id: "oa", name: "x", providerType: "openai" });
  expect((await r.json()).detail).toBe("LLM provider id 'oa' already exists");
  r = await c.patch("/v1/llm-providers/nope", { name: "x", providerType: "openai" });
  expect((await r.json()).detail).toBe("LLM provider nope");
  expect((await (await c.get("/v1/llm-providers")).json()).providerTypes).toEqual(PROVIDER_TYPES);
  // pydantic never turns a number into a str
  r = await c.post("/v1/llm-providers", { id: "n5", name: 5, providerType: "openai" });
  expect(r.status).toBe(422);
  expect((await r.json()).errors).toEqual([{ loc: ["body", "name"], msg: "Input should be a valid string", type: "string_type" }]);
});
