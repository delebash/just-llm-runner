// SPDX-License-Identifier: MIT
// Port of tests/test_adapter_extra.py — per-call `extra` routing into each backend's shape
// (Ollama options/format, Gemini's typed config, the SDK allowlists), the reasoning
// emission per adapter, and each SDK adapter's chat / stream / models / embed / errors
// over a fake client.
//
// JS port notes:
//  - The Python fakes stood in for the Python SDK clients; these stand in for the JS SDK
//    clients (one params object per call, same keys as Python's kwargs). The Python
//    fixtures/fake objects become the JS SDKs' shapes: Gemini's camelCase (`finishReason`,
//    `usageMetadata`, `supportedActions`, `taskType`), OpenAI's and Anthropic's plain wire
//    JSON. An HTTP-status error is the JS SDK's own (`APIError.generate`, `ApiError`).
//  - `_build_config` returns the JS SDK's camelCase config fields; where the Python test
//    built a REAL typed config (`GenerateContentConfig(**cfg)` raises on an unknown key),
//    this one sends the config through the REAL JS SDK and checks the wire body.
//  - The openai-compat stream tests replaced the adapter's httpx client with a fake; here
//    `http.fetch` is spied (the kit's one HTTP door) and serves the SSE text.
//  - No network: every test starts with http.fetch refusing to be called.
//  - All 45 Python tests are ported (same names); the three `wire:` tests at the end are
//    extra — the request bodies the real JS SDKs send, against the Python SDKs' capture.
import { APIError as AnthropicAPIError } from "@anthropic-ai/sdk";
import { ApiError, EmbedContentResponse, GenerateContentResponse } from "@google/genai";
import { APIError as OpenAIAPIError } from "openai";
import { beforeEach, expect, test, vi } from "vitest";
import { AnthropicAdapter } from "../src/llm/anthropic.js";
import { LLMMessage, popReasoning } from "../src/llm/base.js";
import { GeminiAdapter } from "../src/llm/gemini.js";
import { OllamaAdapter } from "../src/llm/ollama.js";
import { OpenAICompatAdapter } from "../src/llm/openai_compat.js";
import { OpenAISDKAdapter } from "../src/llm/openai_sdk.js";
import * as http from "../src/platform/http.js";
import { camelize, jsonResponse, KwargsCapture, loadFixture, textResponse } from "./_sdk_fakes.js";

beforeEach(() => {
  vi.spyOn(http, "fetch").mockImplementation(async (url) => {
    throw new Error(`a test reached the network: ${url}`);
  });
});

const user = (content) => LLMMessage("user", content);
const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};
const textOf = (deltas) =>
  deltas
    .filter((d) => d.text)
    .map((d) => d.text)
    .join("");

test("ollama_extra_nests_under_options_and_format", () => {
  const body = { options: { temperature: 0.7 } };
  OllamaAdapter._applyExtra(body, { top_p: 0.9, top_k: 40, min_p: 0.05, response_format: { type: "json_object" } });
  expect(body.options.top_p).toBe(0.9);
  expect(body.options.top_k).toBe(40);
  expect(body.options.min_p).toBe(0.05); // long-tail samplers reach Ollama now
  expect(body.format).toBe("json"); // structured output → top-level format
  expect("top_p" in body).toBe(false); // NOT left at the top level (the bug)
});

test("gemini_build_config_maps_typed_and_drops_unsupported", async () => {
  // _buildConfig keeps ONLY Gemini's typed params + the stop rename; the min_p-400 trigger
  // bug dies here — unsupported samplers are DROPPED, never merged.
  const extra = { top_p: 0.9, top_k: 40, seed: 7, stop: ["END"], min_p: 0.05, mirostat: 2, samplers: ["top_k", "top_p"] };
  const cfg = GeminiAdapter._buildConfig({ system: "s", temperature: 0.7, maxTokens: 64, think: false, effort: "", budget: null, extra });
  expect(cfg.topP).toBe(0.9);
  expect(cfg.topK).toBe(40);
  expect(cfg.seed).toBe(7);
  expect(cfg.stopSequences).toEqual(["END"]); // renamed
  expect("stop" in cfg).toBe(false);
  expect(cfg.systemInstruction).toBe("s");
  expect(cfg.maxOutputTokens).toBe(64);
  for (const k of ["min_p", "minP", "mirostat", "samplers"]) expect(k in cfg).toBe(false);
  // The REAL SDK takes it: a chat through @google/genai puts exactly these on the wire.
  let sent;
  http.fetch.mockImplementation(async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return jsonResponse(camelize(loadFixture("gemini-sdk/chat-create.json")));
  });
  const a = new GeminiAdapter("p", { apiKey: "x" });
  await a.chat([LLMMessage("system", "s"), user("hi")], { temperature: 0.7, maxTokens: 64, extra });
  expect(sent.url).toContain("/models/gemini-flash-lite-latest:generateContent");
  expect(sent.body.systemInstruction).toEqual({ parts: [{ text: "s" }], role: "user" });
  expect(sent.body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  expect(sent.body.generationConfig).toEqual({
    temperature: 0.7,
    maxOutputTokens: 64,
    topP: 0.9,
    topK: 40,
    seed: 7,
    stopSequences: ["END"],
  });
});

test("gemini_build_config_empty_extra_is_bare", () => {
  const cfg = GeminiAdapter._buildConfig({ system: null, temperature: null, maxTokens: null, think: false, effort: "", budget: null, extra: null });
  expect(cfg).toEqual({});
});

test("ollama_apply_extra_none_is_noop", () => {
  const body = { options: {} };
  OllamaAdapter._applyExtra(body, null);
  expect(body).toEqual({ options: {} });
});

// ── reasoning: the resolved word/budget → each backend's native control ──

test("pop_reasoning_splits_both_reserved_keys_without_leaking", () => {
  const [extra, effort, budget] = popReasoning({ top_k: 40, reasoning_effort: "high", reasoning_budget_tokens: 1024 });
  expect(effort).toBe("high");
  expect(budget).toBe(1024);
  expect(extra).toEqual({ top_k: 40 }); // both removed (no leak)
  expect(popReasoning(null)).toEqual([null, "", null]);
  expect(popReasoning({ top_k: 40 })).toEqual([{ top_k: 40 }, "", null]);
});

test("ollama_reasoning_maps_level_or_bool", () => {
  let b = {};
  OllamaAdapter._applyReasoning(b, true, "high");
  expect(b.think).toBe("high"); // the resolved level word passes straight through
  b = {};
  OllamaAdapter._applyReasoning(b, true, "");
  expect(b.think).toBe(true); // on, no level → bool true
  b = {};
  OllamaAdapter._applyReasoning(b, false, "high");
  // off → an EXPLICIT false, not omission (changed 2026-07-27). Omitting inherits the
  // model's own default, so a thinking-BY-DEFAULT model kept reasoning while the UI control
  // said off. The level word is ignored when off — `false`, never "high".
  expect(b.think).toBe(false);
});

test("anthropic_reasoning_legacy_vs_new_model", () => {
  // LEGACY model (haiku-4-5): classic budget_tokens = the resolved map NUMBER + max bump.
  const b = { max_tokens: 4096, temperature: 0.7 };
  AnthropicAdapter._applyReasoning(b, true, "high", 8192, "claude-haiku-4-5");
  expect(b.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  expect(b.max_tokens).toBe(8192 + 2048);
  expect("temperature" in b).toBe(false);
  // NEW model (opus-4-8): adaptive + output_config.effort (the WORD); sampler params dropped.
  const b2 = { max_tokens: 4096, temperature: 0.7, top_p: 0.9 };
  AnthropicAdapter._applyReasoning(b2, true, "high", 8192, "claude-opus-4-8");
  expect(b2.thinking).toEqual({ type: "adaptive" });
  expect(b2.output_config).toEqual({ effort: "high" });
  expect("temperature" in b2 || "top_p" in b2 || "budget_tokens" in b2.thinking).toBe(false);
  // NEW model, think off → explicit disabled.
  const b3 = {};
  AnthropicAdapter._applyReasoning(b3, false, "high", null, "claude-sonnet-5");
  expect(b3.thinking).toEqual({ type: "disabled" });
  // Fable (always thinks), off → no thinking config forced.
  const b4 = {};
  AnthropicAdapter._applyReasoning(b4, false, "high", null, "claude-fable-5");
  expect("thinking" in b4).toBe(false);
  // LEGACY off → untouched.
  const b5 = { temperature: 0.7 };
  AnthropicAdapter._applyReasoning(b5, false, "high", 8192, "claude-haiku-4-5");
  expect("thinking" in b5).toBe(false);
  expect(b5.temperature).toBe(0.7);
});

test("anthropic_reasoning_5x_generations", () => {
  // Opus 5.5 can't stop thinking: off leaves the field out, and the samplers go (a 400 otherwise).
  const a = { temperature: 0.7, top_p: 0.9 };
  AnthropicAdapter._applyReasoning(a, false, "high", null, "claude-opus-5-5");
  expect("thinking" in a || "temperature" in a || "top_p" in a).toBe(false);
  // Sonnet 5.5 turns thinking off with between_tools ({type: "disabled"} is a 400).
  const s = { temperature: 0.7 };
  AnthropicAdapter._applyReasoning(s, false, "high", null, "claude-sonnet-5-5");
  expect(s.thinking).toEqual({ type: "between_tools" });
  expect("temperature" in s).toBe(false);
  // Haiku 5.5 is a new model: adaptive + the effort word, never budget_tokens.
  const h = { max_tokens: 4096 };
  AnthropicAdapter._applyReasoning(h, true, "low", 8192, "claude-haiku-5-5");
  expect(h.thinking).toEqual({ type: "adaptive" });
  expect(h.output_config).toEqual({ effort: "low" });
  expect(h.max_tokens).toBe(4096);
  // Opus 5 (not 5.5): off is disabled.
  const o = {};
  AnthropicAdapter._applyReasoning(o, false, "high", null, "claude-opus-5");
  expect(o.thinking).toEqual({ type: "disabled" });
  // Opus 4.6 still takes samplers with thinking off.
  const o46 = { temperature: 0.2 };
  AnthropicAdapter._applyReasoning(o46, false, "high", null, "claude-opus-4-6");
  expect(o46.temperature).toBe(0.2);
});

test("gemini_build_config_thinking_off_word_number", () => {
  const base = { system: null, temperature: null, maxTokens: null, extra: null };
  // off → OMIT thinkingConfig (model default = today's semantics)
  expect("thinkingConfig" in GeminiAdapter._buildConfig({ think: false, effort: "", budget: 2048, ...base })).toBe(false);
  // think on + a NUMBER → thinkingBudget (the resolved map value, not a table lookup)
  const tc = GeminiAdapter._buildConfig({ think: true, effort: "", budget: 2048, ...base }).thinkingConfig;
  expect(tc.thinkingBudget).toBe(2048);
  expect(tc.thinkingLevel).toBeUndefined();
  // -1 passes through verbatim (documented dynamic/unlimited — the gemini `max` seed)
  expect(GeminiAdapter._buildConfig({ think: true, effort: "", budget: -1, ...base }).thinkingConfig.thinkingBudget).toBe(-1);
  // think on + a WORD → thinkingLevel (forward-compat branch, D6-A; the wire enum is
  // upper-case, which Python's case-insensitive enum produced from "high")
  const tl = GeminiAdapter._buildConfig({ think: true, effort: "high", budget: null, ...base }).thinkingConfig;
  expect(tl.thinkingLevel).toBe("HIGH");
  expect(tl.thinkingBudget).toBeUndefined();
  // think on but neither a word nor a number resolved → still OMIT (claim nothing)
  expect("thinkingConfig" in GeminiAdapter._buildConfig({ think: true, effort: "", budget: null, ...base })).toBe(false);
});

test("openai_compat_reasoning_local_and_generic", () => {
  // Compat serves ONLY local-llamacpp + the generic openai-compat gateway (the cloud
  // reasoning_effort emission lives in openai_sdk.js).
  // local: enable_thinking BOTH ways + the per-request reasoning_budget_tokens.
  const local = new OpenAICompatAdapter("p", "local-llamacpp", { apiKey: "" });
  let b = {};
  local._applyReasoning(b, true, "", 1024);
  expect(b.chat_template_kwargs).toEqual({ enable_thinking: true });
  expect(b.reasoning_budget_tokens).toBe(1024); // the resolved per-request budget
  expect("reasoning_effort" in b).toBe(false);
  b = {};
  local._applyReasoning(b, false, "", 1024);
  expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(b.reasoning_budget_tokens).toBe(0); // off → 0 (belt and braces)
  // generic openai-compat: conservative — on → enable_thinking, off → nothing; never a
  // reasoning_effort.
  const compat = new OpenAICompatAdapter("p", "openai-compat", { apiKey: "" });
  b = {};
  compat._applyReasoning(b, true, "high", null);
  expect(b.chat_template_kwargs).toEqual({ enable_thinking: true });
  expect("reasoning_effort" in b).toBe(false);
  b = {};
  compat._applyReasoning(b, false, "high", null);
  expect(b).toEqual({});
});

test("ollama_schema_rides_format", () => {
  // A json_schema response_format puts the SCHEMA OBJECT in Ollama's `format` (structured
  // outputs); plain json stays the "json" string.
  let body = {};
  OllamaAdapter._applyExtra(body, {
    response_format: { type: "json_schema", json_schema: { name: "k", schema: { type: "object" }, strict: true } },
  });
  expect(body.format).toEqual({ type: "object" });
  body = {};
  OllamaAdapter._applyExtra(body, { response_format: { type: "json_object" } });
  expect(body.format).toBe("json");
});

test("gemini_build_config_response_schema_and_json_object", () => {
  const base = { system: null, temperature: null, maxTokens: null, think: false, effort: "", budget: null };
  // json_schema → the RAW JSON Schema rides responseJsonSchema + the JSON mime (proof item 4)
  const cfg = GeminiAdapter._buildConfig({
    extra: { response_format: { type: "json_schema", json_schema: { name: "k", schema: { type: "object" }, strict: true } } },
    ...base,
  });
  expect(cfg.responseMimeType).toBe("application/json");
  expect(cfg.responseJsonSchema).toEqual({ type: "object" });
  // json_object → the mime ONLY, no schema
  const cfg2 = GeminiAdapter._buildConfig({ extra: { response_format: { type: "json_object" } }, ...base });
  expect(cfg2).toEqual({ responseMimeType: "application/json" });
});

// ── the google-genai SDK surface (chat/stream/models/embed/errors) over a fake client,
//    with response objects rebuilt from the committed LIVE-PROOF fixtures ──

/** Fake google-genai `client.models` surface (flat: the adapter calls
 * `_client.models.<method>`). Captures params into `last`; returns canned SDK objects, or
 * throws a preset error. */
class FakeGenaiModels extends KwargsCapture {
  constructor({ response = null, stream = null, modelList = null, embed = null, error = null } = {}) {
    super();
    this.models = this; // flat: .models.generateContent etc. resolve to this object
    this._response = response;
    this._stream = stream || [];
    this._modelList = modelList || [];
    this._embed = embed;
    this._error = error;
  }

  async generateContent(params) {
    this._capture(params);
    if (this._error) throw this._error;
    return this._response;
  }

  async generateContentStream(params) {
    this._capture(params);
    if (this._error) throw this._error;
    return (async function* (xs) {
      yield* xs;
    })(this._stream);
  }

  async list() {
    if (this._error) throw this._error;
    return this._modelList;
  }

  async embedContent(params) {
    this._capture(params);
    if (this._error) throw this._error;
    return this._embed;
  }
}

function gemini(fake) {
  const a = new GeminiAdapter("p", { apiKey: "x" });
  a._client = new FakeGenaiModels(fake);
  return a;
}

/** The fixture as the JS SDK's GenerateContentResponse (the wire's camelCase). */
const resp = (data) => Object.assign(new GenerateContentResponse(), camelize(data));

test("gemini_chat_parses_text_usage_finish", async () => {
  const a = gemini({ response: resp(loadFixture("gemini-sdk/chat-create.json")) });
  const r = await a.chat([user("hi")], { model: "models/gemini-3.1-flash-lite" });
  expect(r.text).toBe("OK.");
  expect(r.prompt_tokens).toBe(11);
  expect(r.completion_tokens).toBe(2);
  expect(r.finish_reason).toBe("stop");
  expect(r.model).toBe("gemini-3.1-flash-lite"); // the models/ prefix is stripped
  expect(a._client.last.model).toBe("gemini-3.1-flash-lite");
  // the turn was mapped to a Content/Part (role "user")
  const sent = a._client.last.contents[0];
  expect(sent.role).toBe("user");
  expect(sent.parts[0].text).toBe("hi");
});

test("gemini_chat_max_tokens_maps_to_length", async () => {
  const data = loadFixture("gemini-sdk/chat-create.json");
  data.candidates[0].finish_reason = "MAX_TOKENS";
  const r = await gemini({ response: resp(data) }).chat([user("hi")]);
  expect(r.finish_reason).toBe("length");
});

test("gemini_stream_assembles_text_and_final_usage", async () => {
  const chunks = loadFixture("gemini-sdk/chat-stream.json").map(resp);
  const deltas = await collect(gemini({ stream: chunks }).streamChat([user("count")]));
  expect(textOf(deltas)).toBe("One, two, three, four, five.");
  const done = deltas.at(-1);
  expect(done.done).toBe(true);
  expect(done.prompt_tokens).toBe(7);
  expect(done.completion_tokens).toBe(10);
});

test("gemini_models_filters_to_usable_and_strips_prefix", async () => {
  const ms = [
    { name: "models/gemini-3.1-flash-lite", supportedActions: ["generateContent"] },
    { name: "models/gemini-embedding-001", supportedActions: ["embedContent"] },
    { name: "models/veo-3", supportedActions: ["predictLongRunning"] }, // noise
    { name: "models/mystery" }, // no supportedActions → KEEP
  ];
  const out = await gemini({ modelList: ms }).models();
  expect(out).toContain("gemini-3.1-flash-lite");
  expect(out).toContain("gemini-embedding-001");
  expect(out).not.toContain("veo-3"); // no generate/embed action → dropped (D7)
  expect(out).toContain("mystery"); // missing supportedActions treated as keep
  expect(out.every((m) => !m.startsWith("models/"))).toBe(true);
});

test("gemini_embed_maps_task_type_and_extracts_vectors", async () => {
  const er = Object.assign(new EmbedContentResponse(), { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3] }] });
  const a = gemini({ embed: er });
  expect(await a.embed(["a", "b"], { taskType: "document" })).toEqual([[0.1, 0.2], [0.3]]);
  expect(a._client.last.model).toBe("gemini-embedding-001"); // default embed model
  expect(a._client.last.config.taskType).toBe("RETRIEVAL_DOCUMENT"); // mapped task side
  const a2 = gemini({ embed: er });
  await a2.embed(["a"], { taskType: "" });
  expect(a2._client.last.config).toBeUndefined(); // "" → no config (Python's None)
});

/** Fake google-genai models surface for embeddings. Returns `perCall` vectors per call
 * (fixed — mimics gemini-embedding-2, which returns ONE for any list), or contents.length
 * when perCall is null (mimics gemini-embedding-001's real batching). Records the length of
 * every call's contents. */
class FakeEmbedGenai {
  constructor(perCall) {
    this.models = this;
    this.perCall = perCall;
    this.calls = [];
  }

  async embedContent({ contents }) {
    this.calls.push([...contents]);
    const n = this.perCall ?? contents.length;
    return { embeddings: Array.from({ length: n }, () => ({ values: [0.1, 0.2] })) };
  }
}

test("gemini_embed_falls_back_to_per_text_when_the_model_ignores_batch", async () => {
  // gemini-embedding-2 returns ONE vector for a list (verified live 2026-07-18) — the
  // adapter must still return one per input, so it falls back to a call per text.
  const a = new GeminiAdapter("p", { apiKey: "x" });
  a._client = new FakeEmbedGenai(1);
  const out = await a.embed(["a", "b", "c"], { model: "gemini-embedding-2" });
  expect(out.length).toBe(3); // one vector per input
  expect(a._embedNoBatch).toEqual(new Set(["gemini-embedding-2"])); // the model is remembered
  expect(a._client.calls.map((c) => c.length)).toEqual([3, 1, 1, 1]); // batch try, then per text
  // a SECOND batch skips the now-known-futile batch call and goes straight to per text
  a._client.calls.length = 0;
  await a.embed(["d", "e"], { model: "gemini-embedding-2" });
  expect(a._client.calls.map((c) => c.length)).toEqual([1, 1]);
});

test("gemini_embed_batches_when_the_model_supports_it", async () => {
  const a = new GeminiAdapter("p", { apiKey: "x" });
  a._client = new FakeEmbedGenai(null); // returns contents.length
  const out = await a.embed(["a", "b", "c"], { model: "gemini-embedding-001" });
  expect(out.length).toBe(3);
  expect(a._embedNoBatch).toEqual(new Set()); // no fallback needed
  expect(a._client.calls.map((c) => c.length)).toEqual([3]); // ONE batch call
});

test("gemini_chat_error_maps_to_d10", async () => {
  const err = new ApiError({
    message: JSON.stringify({ error: { code: 404, message: "nope", status: "NOT_FOUND" } }),
    status: 404,
  });
  await expect(gemini({ error: err }).chat([user("hi")])).rejects.toThrow(/^gemini 404:/);
});

// ── lazy SDK-client construction: each SDK adapter constructs cheap (stores config only)
//    and builds its vendor client on the first real call, so a seeded KEYLESS provider
//    registers with no placeholder key; the first real call surfaces the SDK's own no-key
//    error (chat → "… request failed …"), while models()/ping() swallow it → []/false. ──

test("gemini_lazy_keyless_construct_and_degrade", async () => {
  vi.stubEnv("GEMINI_API_KEY", undefined);
  vi.stubEnv("GOOGLE_API_KEY", undefined);
  const a = new GeminiAdapter("p", { apiKey: "" });
  expect(a._client).toBeNull(); // nothing built at construct (no dummy key)
  expect(await a.models()).toEqual([]); // keyless degrades (the no-key error swallowed)
  expect(await a.ping()).toBe(false);
  await expect(a.chat([user("hi")])).rejects.toThrow(/^gemini request failed/); // a real call surfaces it
});

test("openai_sdk_lazy_keyless_construct_and_degrade", async () => {
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("OPENAI_ADMIN_KEY", undefined); // the JS SDK (like Python's) also accepts an admin key
  const a = new OpenAISDKAdapter("p", "openai", { apiKey: "" });
  expect(a._client).toBeNull(); // no dummy key built at construct
  expect(await a.models()).toEqual([]); // keyless degrades (the SDK's OpenAIError swallowed)
  expect(await a.ping()).toBe(false);
  await expect(a.chat([user("hi")])).rejects.toThrow(/^openai request failed/);
});

test("anthropic_lazy_client_built_once", async () => {
  // Anthropic never needed a dummy (its SDK constructs fine keyless), but the SDK-adapter
  // shape is shared: construct stores config, _ensureClient builds once and caches.
  const a = new AnthropicAdapter("p", { apiKey: "" });
  expect(a._client).toBeNull();
  const c1 = await a._ensureClient();
  expect(c1.constructor.name).toBe("Anthropic");
  expect(await a._ensureClient()).toBe(c1); // built once, cached
});

// ── the anthropic SDK surface (allowlist / chat / stream / models / errors) ──

test("anthropic_map_extra_is_an_allowlist", () => {
  // _mapExtra is an ALLOWLIST over base.selectAllowed — only Anthropic's typed params
  // survive (top_p/top_k/metadata + the stop → stop_sequences rename); min_p / mirostat /
  // seed / samplers / response_format are DROPPED at the boundary.
  const out = AnthropicAdapter._mapExtra({
    top_p: 0.9,
    top_k: 40,
    metadata: { user_id: "u" },
    stop: ["END"],
    min_p: 0.05,
    mirostat: 2,
    seed: 7,
    samplers: ["top_k"],
    response_format: { type: "json_object" },
  });
  expect(out).toEqual({ top_p: 0.9, top_k: 40, metadata: { user_id: "u" }, stop_sequences: ["END"] });
  expect(AnthropicAdapter._mapExtra(null)).toBeNull();
  expect(AnthropicAdapter._mapExtra({ min_p: 0.05 })).toBeNull(); // nothing survives → null
});

class FakeAnthropicModels {
  constructor(modelList = null, error = null) {
    this._modelList = modelList || [];
    this._error = error;
  }

  list() {
    if (this._error) throw this._error;
    return this._modelList;
  }
}

/** Fake anthropic client (flat: the adapter calls `_client.messages.create` /
 * `_client.models.list`). `.messages.create` captures params and returns a canned Message,
 * or with stream: true a canned event iterator, or throws a preset error. */
class FakeAnthropic extends KwargsCapture {
  constructor({ message = null, stream = null, modelList = null, error = null, listError = null } = {}) {
    super();
    this.messages = this; // flat: .messages.create → this.create
    this.models = new FakeAnthropicModels(modelList, listError);
    this._message = message;
    this._stream = stream || [];
    this._error = error;
  }

  async create(params) {
    this._capture(params);
    if (this._error) throw this._error;
    if (params.stream) return this._stream;
    return this._message;
  }
}

function anthropic(fake) {
  const a = new AnthropicAdapter("p", { apiKey: "x" });
  a._client = new FakeAnthropic(fake);
  return a;
}

test("anthropic_chat_assembles_kwargs_and_parses", async () => {
  const msg = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 11, output_tokens: 5 },
  };
  const a = anthropic({ message: msg });
  const r = await a.chat([LLMMessage("system", "be brief"), user("hi")], {
    model: "claude-haiku-4-5",
    temperature: 0.5,
    maxTokens: 256,
    extra: { top_p: 0.9, stop: ["END"], min_p: 0.05 },
  });
  expect(r.text).toBe("Hello"); // text blocks concatenated
  expect(r.finish_reason).toBe("end_turn");
  expect(r.prompt_tokens).toBe(11);
  expect(r.completion_tokens).toBe(5);
  const sent = a._client.last;
  expect(sent.model).toBe("claude-haiku-4-5");
  expect(sent.system).toBe("be brief"); // swept out via splitSystem
  expect(sent.messages).toEqual([{ role: "user", content: "hi" }]); // only the user turn
  expect(sent.temperature).toBe(0.5);
  expect(sent.max_tokens).toBe(256);
  expect(sent.top_p).toBe(0.9);
  expect(sent.stop_sequences).toEqual(["END"]); // allowlisted + renamed
  expect("min_p" in sent).toBe(false); // dropped at the boundary
});

test("anthropic_stream_parses_events_and_final_usage", async () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 11 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
    { type: "message_delta", usage: { output_tokens: 7 } },
  ];
  const a = anthropic({ stream: events });
  const deltas = await collect(a.streamChat([user("hi")]));
  expect(textOf(deltas)).toBe("Hello");
  expect(a._client.last.stream).toBe(true);
  const done = deltas.at(-1);
  expect(done.done).toBe(true);
  expect(done.prompt_tokens).toBe(11);
  expect(done.completion_tokens).toBe(7);
});

test("anthropic_models_live_then_curated_fallback", async () => {
  const live = await anthropic({ modelList: [{ id: "claude-opus-4-8" }, { id: "claude-haiku-4-5" }] }).models();
  expect(live).toEqual(["claude-opus-4-8", "claude-haiku-4-5"]); // D8: the live /v1/models list
  const fellBack = await anthropic({ listError: new Error("boom") }).models();
  expect(fellBack).toContain("claude-haiku-4-5");
  expect(fellBack.length).toBeGreaterThanOrEqual(5); // curated fallback on error
});

test("anthropic_chat_error_maps_to_d10", async () => {
  const err = AnthropicAPIError.generate(429, undefined, "slow down", new Headers()); // status 429
  await expect(anthropic({ error: err }).chat([user("hi")])).rejects.toThrow(/^anthropic 429:/);
});

// ── the openai SDK adapter — Responses (openai) + CC (deepseek/openrouter/xai/mistral).
//    Fakes are thin subclasses of the _sdk_fakes KwargsCapture base. ──

/** Fake client.responses: create() captures params, returns a Response (or, with
 * stream: true, an event iterator), or throws. `tempError` fires on the FIRST call only
 * (the temperature-retry-once proof). */
class FakeResponses extends KwargsCapture {
  constructor({ response = null, stream = null, error = null, tempError = null } = {}) {
    super();
    this._response = response;
    this._stream = stream || [];
    this._error = error;
    this._tempError = tempError;
    this._calls = 0;
  }

  async create(params) {
    this._capture(params);
    this._calls += 1;
    if (this._tempError !== null && this._calls === 1) throw this._tempError;
    if (this._error) throw this._error;
    if (params.stream) return this._stream;
    return this._response;
  }
}

/** Fake client.chat.completions: create() captures params + returns a completion or, with
 * stream: true, a chunk iterator, or throws. */
class FakeChatCompletions extends KwargsCapture {
  constructor({ completion = null, stream = null, error = null } = {}) {
    super();
    this._completion = completion;
    this._stream = stream || [];
    this._error = error;
  }

  async create(params) {
    this._capture(params);
    if (this._error) throw this._error;
    if (params.stream) return this._stream;
    return this._completion;
  }
}

class FakeEmbeddings extends KwargsCapture {
  constructor({ data = null, error = null } = {}) {
    super();
    this._data = data || [];
    this._error = error;
  }

  async create(params) {
    this._capture(params);
    if (this._error) throw this._error;
    return { data: this._data };
  }
}

class FakeModelsList {
  constructor({ modelList = null, error = null } = {}) {
    this._modelList = modelList || [];
    this._error = error;
  }

  list() {
    if (this._error) throw this._error;
    return this._modelList;
  }
}

class FakeOpenAIClient {
  constructor({ responses = null, completions = null, embeddings = null, models = null } = {}) {
    this.responses = responses || new FakeResponses();
    this.chat = { completions: completions || new FakeChatCompletions() };
    this.embeddings = embeddings || new FakeEmbeddings();
    this.models = models || new FakeModelsList();
  }
}

function sdk(providerType, client = {}) {
  const a = new OpenAISDKAdapter("p", providerType, { apiKey: "x" });
  a._client = new FakeOpenAIClient(client);
  return a;
}

test("openai_sdk_cc_profiles_filter_and_rename", () => {
  // openrouter KEEPS top_k/min_p (extra body) + renames repeat_penalty →
  // repetition_penalty (OpenRouter's documented name); top_p/seed stay typed; the samplers
  // order array + mirostat are DROPPED (the min_p-400 fix).
  let [typed, eb] = sdk("openrouter")._ccParams({
    top_p: 0.9,
    seed: 7,
    top_k: 40,
    min_p: 0.05,
    repeat_penalty: 1.1,
    samplers: ["top_k"],
    mirostat: 2,
  });
  expect(typed).toEqual({ top_p: 0.9, seed: 7 });
  expect(eb).toEqual({ top_k: 40, min_p: 0.05, repetition_penalty: 1.1 });
  // deepseek + xai DROP min_p/top_k (not in profile); seed stays typed; no extra body.
  for (const pt of ["deepseek", "xai"]) {
    [typed, eb] = sdk(pt)._ccParams({ top_p: 0.9, min_p: 0.05, top_k: 40, seed: 7 });
    expect(typed, pt).toEqual({ top_p: 0.9, seed: 7 });
    expect(eb, pt).toEqual({});
  }
  // mistral renames seed → random_seed via the extra body (Mistral's documented name).
  [typed, eb] = sdk("mistral")._ccParams({ seed: 7, top_p: 0.9, min_p: 0.05 });
  expect(typed).toEqual({ top_p: 0.9 });
  expect(eb).toEqual({ random_seed: 7 });
});

test("openai_sdk_cc_response_format_downgrade_and_passthrough", () => {
  const js = { type: "json_schema", json_schema: { name: "k", schema: { type: "object" }, strict: true } };
  // deepseek documents json_object ONLY → a json_schema downgrades to json_object.
  let [typed] = sdk("deepseek")._ccParams({ response_format: js });
  expect(typed.response_format).toEqual({ type: "json_object" });
  // xai/mistral document real json_schema → passes through untouched.
  for (const pt of ["xai", "mistral"]) {
    [typed] = sdk(pt)._ccParams({ response_format: js });
    expect(typed.response_format, pt).toEqual(js);
  }
});

test("openai_sdk_reasoning_emission_per_type", () => {
  const turn = [user("hi")];
  const base = { model: "m", temperature: null, maxTokens: null, system: null, think: true };
  // openai (Responses): think + word → reasoning = {effort: w}
  let kw = sdk("openai")._responsesKwargs(turn, { extra: { reasoning_effort: "high" }, ...base });
  expect(kw.reasoning).toEqual({ effort: "high" });
  // openrouter (CC): think + word → reasoning_effort
  kw = sdk("openrouter")._ccKwargs(turn, { extra: { reasoning_effort: "high" }, stream: false, ...base });
  expect(kw.reasoning_effort).toBe("high");
  // deepseek/xai/mistral emit NOTHING even with a word + think on (D5 EMIT_EFFORT_TYPES).
  for (const pt of ["deepseek", "xai", "mistral"]) {
    kw = sdk(pt)._ccKwargs(turn, { extra: { reasoning_effort: "high" }, stream: false, ...base });
    expect("reasoning_effort" in kw, pt).toBe(false);
  }
});

test("openai_sdk_responses_store_false_and_input_shapes", () => {
  const a = sdk("openai");
  const kw = a._responsesKwargs([user("hi")], {
    model: "gpt-5",
    temperature: 0.5,
    maxTokens: 64,
    system: "be nice",
    think: false,
    extra: { top_p: 0.8, min_p: 0.05 },
  });
  expect(kw.store).toBe(false); // never persist — D2/D3
  expect(kw.input).toBe("hi"); // single user turn → plain string
  expect(kw.instructions).toBe("be nice"); // system swept into instructions
  expect(kw.temperature).toBe(0.5);
  expect(kw.max_output_tokens).toBe(64);
  expect(kw.top_p).toBe(0.8);
  expect("min_p" in kw).toBe(false); // only top_p survives on Responses
  // multi-turn → the typed input array (assistant → output_text, user → input_text).
  const kw2 = a._responsesKwargs([user("q1"), LLMMessage("assistant", "a1"), user("q2")], {
    model: "gpt-5",
    temperature: null,
    maxTokens: null,
    system: null,
    think: false,
    extra: null,
  });
  expect(Array.isArray(kw2.input)).toBe(true);
  expect(kw2.input.length).toBe(3);
  expect(kw2.input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "a1" }] });
  expect(kw2.input[0].content[0].type).toBe("input_text");
  expect("instructions" in kw2).toBe(false); // no system → no instructions key
});

test("openai_sdk_responses_text_format_strict_false_and_json_object", () => {
  const a = sdk("openai");
  const base = { model: "gpt-5", temperature: null, maxTokens: null, system: null, think: false };
  const kw = a._responsesKwargs([user("hi")], {
    ...base,
    extra: { response_format: { type: "json_schema", json_schema: { name: "sweep", schema: { type: "object" }, strict: true } } },
  });
  // strict ALWAYS false (our schemas don't meet strict's every-key-required rule).
  expect(kw.text).toEqual({ format: { type: "json_schema", name: "sweep", strict: false, schema: { type: "object" } } });
  const kw2 = a._responsesKwargs([user("hi")], { ...base, extra: { response_format: { type: "json_object" } } });
  expect(kw2.text).toEqual({ format: { type: "json_object" } });
});

test("openai_sdk_responses_parse_incomplete_maps_to_length", async () => {
  const response = {
    output_text: "hello",
    usage: { input_tokens: 12, output_tokens: 3 },
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    model: "gpt-5",
  };
  const r = await sdk("openai", { responses: new FakeResponses({ response }) }).chat([user("hi")], { model: "gpt-5" });
  expect(r.text).toBe("hello");
  expect(r.finish_reason).toBe("length"); // incomplete + max_output_tokens → length
  expect(r.prompt_tokens).toBe(12);
  expect(r.completion_tokens).toBe(3);
});

test("openai_sdk_responses_temperature_retry_once", async () => {
  const err = OpenAIAPIError.generate(
    400,
    undefined,
    "Unsupported parameter: 'temperature' is not supported with this model.",
    new Headers(),
  );
  const response = {
    output_text: "ok",
    usage: { input_tokens: 1, output_tokens: 1 },
    status: "completed",
    incomplete_details: null,
    model: "o3",
  };
  const fake = new FakeResponses({ response, tempError: err });
  const r = await sdk("openai", { responses: fake }).chat([user("hi")], { model: "o3", temperature: 0.7 });
  expect(r.text).toBe("ok"); // retried WITHOUT temperature → succeeded
  expect(fake._calls).toBe(2); // exactly one retry
  expect("temperature" in fake.last).toBe(false); // the retry dropped temperature
});

test("openai_sdk_responses_stream_parses_text_and_usage", async () => {
  const events = [
    { type: "response.output_text.delta", delta: "Hel" },
    { type: "response.output_text.delta", delta: "lo" },
    { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 5 } } },
  ];
  const deltas = await collect(sdk("openai", { responses: new FakeResponses({ stream: events }) }).streamChat([user("hi")], { model: "gpt-5" }));
  expect(textOf(deltas)).toBe("Hello");
  const done = deltas.at(-1);
  expect(done.done).toBe(true);
  expect(done.prompt_tokens).toBe(8);
  expect(done.completion_tokens).toBe(5);
});

test("openai_sdk_cc_chat_parses_and_builds_messages", async () => {
  const completion = {
    choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
    model: "deepseek-chat",
  };
  const a = sdk("deepseek", { completions: new FakeChatCompletions({ completion }) });
  const r = await a.chat([LLMMessage("system", "sys"), user("hi")], { model: "deepseek-chat", extra: { min_p: 0.05, top_p: 0.9 } });
  expect(r.text).toBe("hi there");
  expect(r.finish_reason).toBe("stop");
  expect(r.prompt_tokens).toBe(5);
  expect(r.completion_tokens).toBe(2);
  const sent = a._client.chat.completions.last;
  expect(sent.messages[0]).toEqual({ role: "system", content: "sys" }); // buildChatMessages
  expect(sent.top_p).toBe(0.9);
  expect("min_p" in sent).toBe(false); // min_p dropped at the boundary
});

test("openai_sdk_cc_stream_parses_text_and_usage", async () => {
  const chunks = [
    { usage: null, choices: [{ delta: { content: "Hel" } }] },
    { usage: null, choices: [{ delta: { content: "lo" } }] },
    { usage: { prompt_tokens: 9, completion_tokens: 4 }, choices: [] }, // final usage frame, empty choices
  ];
  const a = sdk("deepseek", { completions: new FakeChatCompletions({ stream: chunks }) });
  const deltas = await collect(a.streamChat([user("hi")], { model: "deepseek-chat" }));
  expect(textOf(deltas)).toBe("Hello");
  const done = deltas.at(-1);
  expect(done.done).toBe(true);
  expect(done.prompt_tokens).toBe(9);
  expect(done.completion_tokens).toBe(4);
  const sent = a._client.chat.completions.last;
  expect(sent.stream).toBe(true);
  expect(sent.stream_options).toEqual({ include_usage: true });
});

test("openai_sdk_embed_extracts_index_ordered_vectors", async () => {
  const data = [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }];
  const a = sdk("openai", { embeddings: new FakeEmbeddings({ data }) });
  const out = await a.embed(["a", "b"], { model: "text-embedding-3-small", taskType: "document" }); // taskType ignored
  expect(out).toEqual([
    [0.1, 0.2],
    [0.3, 0.4],
  ]);
  expect(a._client.embeddings.last.model).toBe("text-embedding-3-small");
});

test("openai_sdk_cc_error_maps_to_d10", async () => {
  const err = OpenAIAPIError.generate(429, undefined, "rate limited", new Headers());
  const a = sdk("deepseek", { completions: new FakeChatCompletions({ error: err }) });
  await expect(a.chat([user("hi")], { model: "deepseek-chat" })).rejects.toThrow(/^deepseek 429:/);
});

// ── return_progress + prompt_progress on the builtin engine ──

/** The http.fetch spy serving canned SSE lines; records each request's JSON body. */
function serveSse(lines) {
  const seen = { last_body: null, url: null };
  http.fetch.mockImplementation(async (url, init) => {
    seen.url = url;
    seen.last_body = JSON.parse(init.body);
    return textResponse(`${lines.join("\n")}\n`);
  });
  return seen;
}

test("stream_chat_return_progress_only_for_builtin", async () => {
  // The builtin engine asks llama-server for prompt-eval progress (return_progress,
  // PR 15827); other compat servers never see the field.
  const lines = ['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"];
  for (const [ptype, expected] of [
    ["local-llamacpp", true],
    ["openai-compat", false],
    ["openai-compat", false],
  ]) {
    const seen = serveSse(lines);
    const a = new OpenAICompatAdapter("p", ptype, { apiKey: "" });
    await collect(a.streamChat([user("q")]));
    expect(seen.last_body.return_progress === true, ptype).toBe(expected);
  }
});

test("stream_chat_parses_prompt_progress_frames", async () => {
  // Overall progress = processed/total per the upstream contract; progress deltas are
  // progress-only (no text), and the final delta stays the done event with the usage.
  serveSse([
    'data: {"prompt_progress": {"total": 200, "cache": 0, "processed": 100, "time_ms": 5}}',
    'data: {"prompt_progress": {"total": 200, "cache": 0, "processed": 200, "time_ms": 9}}',
    'data: {"choices":[{"delta":{"content":"tok"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":1}}',
    "data: [DONE]",
  ]);
  const deltas = await collect(new OpenAICompatAdapter("p", "local-llamacpp", { apiKey: "" }).streamChat([user("q")]));
  expect(deltas.filter((d) => d.progress !== null).map((d) => d.progress)).toEqual([0.5, 1.0]);
  expect(deltas.filter((d) => d.text).map((d) => d.text)).toEqual(["tok"]);
  const done = deltas.at(-1);
  expect(done.done).toBe(true);
  expect(done.prompt_tokens).toBe(200);
  expect(done.completion_tokens).toBe(1);
});

test("stream_chat_prompt_progress_guards_zero_total", async () => {
  // A total of 0 must not divide — the frame is simply skipped.
  serveSse(['data: {"prompt_progress": {"total": 0, "processed": 0}}', "data: [DONE]"]);
  const deltas = await collect(new OpenAICompatAdapter("p", "local-llamacpp", { apiKey: "" }).streamChat([user("q")]));
  expect(deltas.every((d) => d.progress === null)).toBe(true);
});

// ── the streamed done event says why generation ended (2026-09-28) ──
// llama.cpp sends NO error when the context fills mid-answer, only finish_reason "length"
// on the last chunk — a caller must see it to know the reply was cut off.
test("openai_compat_stream_carries_finish_reason", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"[{\\"id\\": \\"D0\\""}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":30000,"completion_tokens":2766}}',
    "data: [DONE]",
    "",
  ].join("\n");
  http.fetch.mockImplementation(async () => textResponse(sse));
  const a = new OpenAICompatAdapter("local-llamacpp", "local-llamacpp", {
    apiKey: "",
    baseUrl: "http://router.test/v1",
    defaultModel: "m",
  });
  const done = (await collect(a.streamChat([user("x")]))).at(-1);
  expect(done.done).toBe(true);
  expect(done.finish_reason).toBe("length");
  expect(done.completion_tokens).toBe(2766);
});

test("anthropic_stream_maps_max_tokens_to_length", async () => {
  const events = [{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 3 } }];
  const done = (await collect(anthropic({ stream: events }).streamChat([user("hi")]))).at(-1);
  expect(done.finish_reason).toBe("length");
});

test("gemini_stream_reports_stop", async () => {
  const chunks = loadFixture("gemini-sdk/chat-stream.json").map(resp);
  const done = (await collect(gemini({ stream: chunks }).streamChat([user("count")]))).at(-1);
  expect(done.finish_reason).toBe("stop");
});

// ── Not in the Python file: what the REAL JS SDKs put on the wire is what the Python SDKs
//    put there (bodies captured from the Python adapters through httpx.MockTransport,
//    2026-10-07). The SDKs' HTTP goes through http.fetch, so the spy sees it. ──

const WIRE_MSGS = [LLMMessage("system", "be nice"), user("hi")];
const WIRE_EXTRA = {
  top_p: 0.8,
  min_p: 0.05,
  seed: 7,
  top_k: 40,
  repeat_penalty: 1.1,
  stop: ["END"],
  reasoning_effort: "high",
  reasoning_budget_tokens: 2048,
};
const WIRE_CHAT = { model: "m1", temperature: 0.5, maxTokens: 64, think: true };

/** Serve `reply` for every request; return the captured {method, url, body} list. */
function captureWire(reply) {
  const seen = [];
  http.fetch.mockImplementation(async (url, init) => {
    seen.push({ method: init.method, url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return jsonResponse(typeof reply === "function" ? reply(String(url)) : reply);
  });
  return seen;
}

const CC_REPLY = {
  id: "c",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

test("wire: openai Responses and the chat-completions clouds send Python's bodies", async () => {
  let seen = captureWire({
    id: "r",
    object: "response",
    model: "gpt-5",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const r = await new OpenAISDKAdapter("p", "openai", { apiKey: "k" }).chat(WIRE_MSGS, { ...WIRE_CHAT, extra: { ...WIRE_EXTRA } });
  expect(r.text).toBe("ok"); // the SDK's own output_text aggregate
  expect(seen).toEqual([
    {
      method: "POST",
      url: "https://api.openai.com/v1/responses",
      body: {
        input: "hi",
        instructions: "be nice",
        max_output_tokens: 64,
        model: "m1",
        reasoning: { effort: "high" },
        store: false,
        stream: false,
        temperature: 0.5,
        top_p: 0.8,
      },
    },
  ]);
  const expected = {
    openrouter: {
      url: "https://openrouter.ai/api/v1/chat/completions",
      body: {
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
        model: "m1",
        max_tokens: 64,
        reasoning_effort: "high",
        seed: 7,
        stop: ["END"],
        temperature: 0.5,
        top_p: 0.8,
        min_p: 0.05,
        top_k: 40,
        repetition_penalty: 1.1,
      },
    },
    mistral: {
      url: "https://api.mistral.ai/v1/chat/completions",
      body: {
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
        model: "m1",
        max_tokens: 64,
        stop: ["END"],
        temperature: 0.5,
        top_p: 0.8,
        random_seed: 7,
      },
    },
    deepseek: {
      url: "https://api.deepseek.com/v1/chat/completions",
      body: {
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
        model: "m1",
        max_tokens: 64,
        seed: 7,
        stop: ["END"],
        temperature: 0.5,
        top_p: 0.8,
      },
    },
  };
  for (const [pt, want] of Object.entries(expected)) {
    seen = captureWire(CC_REPLY);
    const out = await new OpenAISDKAdapter("p", pt, { apiKey: "k" }).chat(WIRE_MSGS, { ...WIRE_CHAT, extra: { ...WIRE_EXTRA } });
    expect(out.text, pt).toBe("ok");
    expect(seen, pt).toEqual([{ method: "POST", ...want }]);
  }
});

test("wire: anthropic legacy and adaptive models send Python's bodies", async () => {
  const seen = captureWire({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const a = new AnthropicAdapter("p", { apiKey: "k" });
  await a.chat(WIRE_MSGS, { ...WIRE_CHAT, model: "claude-haiku-4-5", extra: { ...WIRE_EXTRA } });
  await a.chat(WIRE_MSGS, { ...WIRE_CHAT, model: "claude-opus-4-8", extra: { ...WIRE_EXTRA } });
  expect(seen).toEqual([
    {
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      body: {
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        model: "claude-haiku-4-5",
        stop_sequences: ["END"],
        system: "be nice",
        thinking: { type: "enabled", budget_tokens: 2048 },
        top_k: 40,
        top_p: 0.8,
      },
    },
    {
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      body: {
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        model: "claude-opus-4-8",
        output_config: { effort: "high" },
        stop_sequences: ["END"],
        system: "be nice",
        thinking: { type: "adaptive" },
      },
    },
  ]);
});

test("wire: gemini generateContent and embed send Python's bodies", async () => {
  const seen = captureWire((url) =>
    url.includes("Embed")
      ? { embeddings: [{ values: [0.1] }] }
      : {
          candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        },
  );
  const g = new GeminiAdapter("p", { apiKey: "k" });
  const r = await g.chat(WIRE_MSGS, {
    ...WIRE_CHAT,
    model: "models/gemini-x",
    extra: { ...WIRE_EXTRA, response_format: { type: "json_schema", json_schema: { name: "k", schema: { type: "object" } } } },
  });
  expect([r.text, r.finish_reason, r.prompt_tokens, r.completion_tokens]).toEqual(["ok", "stop", 1, 1]);
  expect(await g.embed(["a"], { model: "gemini-embedding-001", taskType: "query" })).toEqual([[0.1]]);
  expect(seen).toEqual([
    {
      method: "POST",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent",
      body: {
        contents: [{ parts: [{ text: "hi" }], role: "user" }],
        systemInstruction: { parts: [{ text: "be nice" }], role: "user" },
        generationConfig: {
          temperature: 0.5,
          topP: 0.8,
          topK: 40, // Python's SDK types topK as a float and sends 40.0 — the same JSON number
          maxOutputTokens: 64,
          stopSequences: ["END"],
          seed: 7,
          responseMimeType: "application/json",
          responseJsonSchema: { type: "object" },
          // Python's SDK sends this inner key snake_case (`thinking_level`); the API reads
          // both spellings (proto3 JSON). Unreachable under D6-A today (numeric seed rows).
          thinkingConfig: { thinkingLevel: "HIGH" },
        },
      },
    },
    {
      method: "POST",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
      body: {
        requests: [
          {
            content: { parts: [{ text: "a" }], role: "user" },
            taskType: "RETRIEVAL_QUERY",
            model: "models/gemini-embedding-001",
          },
        ],
      },
    },
  ]);
});
