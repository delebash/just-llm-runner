// SPDX-License-Identifier: MIT
// Google Gemini adapter over the official `@google/genai` SDK (the port of llm/gemini.py).
//
// Speaks the SDK's first-class typed surface `client.models.generateContent` /
// `generateContentStream` (D2, ruled 2026-07-17 "so use generate_content" — NOT the SDK's
// `interactions` plumbing; generate_content is stateless by construction, creating no
// server-side object, which satisfies the never-persist ruling). Gemini's wire quirks —
// roles "user"|"model" (not "assistant"), the system prompt in a top-level
// `systemInstruction`, thinking via `thinkingConfig` — are typed SDK fields, so
// `_buildConfig` only ever sets params Gemini speaks (the min_p-400 fix).
//
// Thinking (D6-A, the user's HELD ruling 2026-07-17: "also keep numeric rows … unless the
// interactions sdk changes that"): the reasoning map keeps its NUMERIC seed rows —
// think-off OMITS `thinkingConfig` (model default), think-on + a number →
// `thinkingBudget: n` (incl. -1 = documented dynamic), think-on + a word →
// `thinkingLevel`. If the adapter ever moves to the `interactions` surface (which speaks
// thinking-level words), the mapping REOPENS for a fresh ruling.
// (Record: docs/plans/2026-07-17-provider-native-dialects-plan.md §0.5, the live proof.)
//
// JS SDK differences, handled here: config fields are camelCase (Python's snake names are
// converted to the same camelCase wire by its SDK); `thinkingLevel` is sent upper-case
// (Python's case-insensitive enum turns "high" into "HIGH"); an empty API key only WARNS
// in the JS SDK and the request goes out keyless, so `_ensureClient` raises Python's
// "No API key was provided" itself; an HTTP-status error is `ApiError` with `.status`
// (Python's APIError `.code`).

import * as http from "../platform/http.js";
import { errText, isJsonObject, rstrip, ValueError } from "../platform/py.js";
import { adapterHttpError, LLMResponse, popReasoning, removePrefix, StreamDelta, selectAllowed, splitSystem } from "./base.js";

let sdk = null;
/** The google-genai SDK, imported on first use (Python measured the import at ~918 ms of
 * every boot — the largest single item of the cold start; history: llm/_lazy.py). */
export function loadGenai() {
  sdk ??= import("@google/genai");
  return sdk;
}

/** Python's `isinstance(e, gerrors.APIError)`. */
async function isApiError(e) {
  const m = await loadGenai();
  return e instanceof m.ApiError;
}

/** The SDK's HTTP goes through the kit's client (the env proxy httpx honoured; one door). */
export const sdkFetch = (url, init) => http.fetch(url, init);

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
// gemini-2.5-* is new-user-blocked on current keys (404 "no longer available to new
// users", live-proven 2026-07-17). The flash-lite alias is live-proven on this tier and
// tracks Google's current flash-lite tier instead of rotting like a dated default.
export const DEFAULT_MODEL = "gemini-flash-lite-latest";

// House embed task side ("document"|"query") → EmbedContentConfig.taskType; "" (or any
// other value) sends no task type.
const TASK_MAP = { document: "RETRIEVAL_DOCUMENT", query: "RETRIEVAL_QUERY" };

// The FinishReason name (lowered) → the house LLMResponse.finish_reason contract.
const FINISH_MAP = { max_tokens: "length", stop: "stop" };

// Gemini's typed sampler set (house key → the SDK's camelCase field), incl. the
// stop → stopSequences rename; everything else drops via the shared allowlist.
const SAMPLERS = new Set(["top_p", "top_k", "seed", "presence_penalty", "frequency_penalty", "stop"]);
const SAMPLER_FIELDS = {
  top_p: "topP",
  top_k: "topK",
  seed: "seed",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  stop: "stopSequences",
};

const finishName = (fr) => {
  const name = String(fr).toLowerCase();
  return Object.hasOwn(FINISH_MAP, name) ? FINISH_MAP[name] : name;
};

/** LLM adapter for Google Gemini over the official SDK. */
export class GeminiAdapter {
  constructor(providerId, { apiKey, baseUrl = "", defaultModel = "", timeoutSeconds = 60 } = {}) {
    this.provider_id = providerId;
    this.provider_type = "gemini";
    this.default_model = defaultModel || DEFAULT_MODEL;
    this._apiKey = apiKey;
    this._baseUrl = baseUrl ? rstrip(baseUrl, "/") : "";
    this._timeoutMs = timeoutSeconds * 1000; // the SDK wants ms
    // Lazy client: construct stores config only; the client is built on the first real
    // call, so a seeded KEYLESS row registers and its first real call surfaces the no-key
    // error honestly (chat → "gemini request failed …"; models()/ping() swallow it →
    // []/false — the keyless degradation).
    this._client = null;
    // Embed models that ignore batching (ONE vector back for a list of N — e.g.
    // gemini-embedding-2, verified 2026-07-18). Learned on the first mismatch so later
    // batches skip the wasted batch call and go straight to per-text.
    this._embedNoBatch = new Set();
  }

  /** Build the SDK client once, on first use. Keeps an already-set `_client` (tests
   * assign a fake), so it never rebuilds over one. */
  async _ensureClient() {
    if (this._client == null) {
      // Python's Client takes `api_key or GOOGLE_API_KEY or GEMINI_API_KEY` and REFUSES to
      // build without one; the JS SDK only warns and would send the request keyless.
      const key = this._apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
      if (!key) {
        throw new ValueError(
          "No API key was provided. Please pass a valid API key. Learn how to create an API key at https://ai.google.dev/gemini-api/docs/api-key.",
        );
      }
      const { GoogleGenAI } = await loadGenai();
      const httpOptions = { timeout: this._timeoutMs, fetch: sdkFetch };
      if (this._baseUrl) httpOptions.baseUrl = this._baseUrl;
      this._client = new GoogleGenAI({ apiKey: key, httpOptions });
    }
    return this._client;
  }

  /** The house call contract → GenerateContentConfig fields. Typed fields ONLY — anything
   * Gemini doesn't speak is dropped HERE (the min_p-400 fix). */
  static _buildConfig({ system, temperature, maxTokens, think, effort, budget, extra }) {
    const cfg = {};
    if (system) cfg.systemInstruction = system;
    if (temperature != null) cfg.temperature = temperature;
    if (maxTokens != null) cfg.maxOutputTokens = maxTokens;
    Object.assign(cfg, selectAllowed(extra, SAMPLERS, SAMPLER_FIELDS));
    const rf = (extra || {}).response_format;
    if (isJsonObject(rf) && ["json_object", "json", "json_schema"].includes(rf.type)) {
      cfg.responseMimeType = "application/json";
      const schema = (rf.json_schema || {}).schema;
      if (rf.type === "json_schema" && isJsonObject(schema)) cfg.responseJsonSchema = schema; // raw JSON Schema
    }
    // Thinking (D6-A): off → OMIT thinkingConfig (model default); on + number →
    // thinkingBudget (incl. -1 dynamic); on + word → thinkingLevel.
    if (think) {
      if (["minimal", "low", "medium", "high"].includes(effort)) {
        // FORWARD-COMPAT / currently unreachable: gemini's seed rows are NUMERIC and the
        // Reasoning-levels editor hides gemini's word column, so no word reaches here
        // under D6-A today.
        cfg.thinkingConfig = { thinkingLevel: effort.toUpperCase() };
      } else if (budget != null) {
        cfg.thinkingConfig = { thinkingBudget: budget };
      }
    }
    return cfg;
  }

  /** Turns → the SDK's Content/Part shape (role "model" for the assistant). */
  static _contents(turns) {
    return turns.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  }

  async _d10(e, { stream = false } = {}) {
    const err = (await isApiError(e))
      ? adapterHttpError("gemini", e.status, errText(e), { stream })
      : adapterHttpError("gemini", null, errText(e)); // transport / other
    err.cause = e;
    return err;
  }

  _prepare(messages, { model, temperature, maxTokens, system, think, extra }) {
    const [rest, effort, budget] = popReasoning(extra);
    const [sysText, turns] = splitSystem(messages, system);
    const config = GeminiAdapter._buildConfig({ system: sysText, temperature, maxTokens, think, effort, budget, extra: rest });
    const modelId = removePrefix(model || this.default_model, "models/");
    return { modelId, contents: GeminiAdapter._contents(turns), config };
  }

  async chat(messages, { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {}) {
    const { modelId, contents, config } = this._prepare(messages, { model, temperature, maxTokens, system, think, extra });
    let r;
    try {
      r = await (await this._ensureClient()).models.generateContent({ model: modelId, contents, config });
    } catch (e) {
      throw await this._d10(e);
    }
    const cand = r.candidates?.length ? r.candidates[0] : null;
    const parts = (cand?.content ? cand.content.parts : null) || [];
    // NOT the SDK's `text` getter — it warns on non-text parts (thought signatures etc.).
    const text = parts.map((p) => p.text || "").join("");
    let finish = "stop";
    if (cand != null && cand.finishReason != null) finish = finishName(cand.finishReason);
    const um = r.usageMetadata;
    return LLMResponse({
      text,
      model: modelId,
      finish_reason: finish,
      prompt_tokens: um ? um.promptTokenCount || 0 : 0,
      completion_tokens: um ? um.candidatesTokenCount || 0 : 0,
      raw: r,
    });
  }

  async *streamChat(
    messages,
    { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {},
  ) {
    const { modelId, contents, config } = this._prepare(messages, { model, temperature, maxTokens, system, think, extra });
    let pt = 0;
    let ct = 0;
    let finish = "";
    try {
      const stream = await (await this._ensureClient()).models.generateContentStream({ model: modelId, contents, config });
      for await (const chunk of stream) {
        const um = chunk.usageMetadata;
        if (um != null) {
          // the final chunk is authoritative (proof item 2)
          if (um.promptTokenCount != null) pt = um.promptTokenCount;
          if (um.candidatesTokenCount != null) ct = um.candidatesTokenCount;
        }
        const cand = chunk.candidates?.length ? chunk.candidates[0] : null;
        const parts = (cand?.content ? cand.content.parts : null) || [];
        const piece = parts.map((p) => p.text || "").join("");
        if (cand != null && cand.finishReason != null) finish = finishName(cand.finishReason);
        if (piece) yield StreamDelta({ text: piece });
      }
    } catch (e) {
      throw await this._d10(e, { stream: true });
    }
    yield StreamDelta({ done: true, prompt_tokens: pt, completion_tokens: ct, finish_reason: finish });
  }

  async models() {
    try {
      const out = [];
      for await (const m of await (await this._ensureClient()).models.list()) {
        const actions = m.supportedActions;
        // D7: keep only chat/embed-capable ids (drops veo/imagen/lyria/aqa/… noise); a
        // missing supportedActions is treated as KEEP.
        if (actions?.length && !actions.some((a) => a === "generateContent" || a === "embedContent")) continue;
        const mid = removePrefix(m.name || "", "models/");
        if (mid) out.push(mid);
      }
      return out;
    } catch {
      return [];
    }
  }

  async _embedCall(m, contents, cfg) {
    let r;
    try {
      r = await (await this._ensureClient()).models.embedContent({ model: m, contents, config: cfg });
    } catch (e) {
      throw await this._d10(e);
    }
    return r.embeddings.map((e) => [...e.values]);
  }

  async embed(texts, { model = null, taskType = "" } = {}) {
    const m = removePrefix(model || "gemini-embedding-001", "models/");
    const cfg = Object.hasOwn(TASK_MAP, taskType) ? { taskType: TASK_MAP[taskType] } : undefined;
    const arr = [...texts];
    if (!arr.length) return [];
    // Most Gemini embed models batch (one vector per input). gemini-embedding-2 does NOT —
    // it returns a SINGLE vector for a list (verified 2026-07-18), which the caller reads
    // as "response length didn't match the batch size". Try the batch; on a count
    // mismatch, remember the model and fall back to one call per text.
    if (arr.length > 1 && !this._embedNoBatch.has(m)) {
      const vecs = await this._embedCall(m, arr, cfg);
      if (vecs.length === arr.length) return vecs;
      this._embedNoBatch.add(m);
    }
    const out = [];
    for (const t of arr) out.push((await this._embedCall(m, [t], cfg))[0]);
    return out;
  }

  async ping() {
    try {
      await (await this._ensureClient()).models.list(); // fetches page 1 (a real call)
      return true;
    } catch (e) {
      if (await isApiError(e)) return Number.isInteger(e.status) ? e.status < 500 : false;
      return false;
    }
  }
}
