// SPDX-License-Identifier: MIT
// Anthropic Claude adapter over the official `@anthropic-ai/sdk` (the port of
// llm/anthropic.py).
//
// Speaks the Messages API through `client.messages.create` (the system prompt in a
// top-level `system` field, not a system-role message). The SDK owns the wire format,
// the `anthropic-version` header and retries; `_mapExtra` is an ALLOWLIST (only
// Anthropic's typed params survive), so the `min_p` 400 unknown-field bug class dies at
// the boundary. The model-generation table (GENERATIONS) and `_applyReasoning` are the
// adaptive / legacy logic: how each generation turns thinking off and whether it takes samplers.
// (Record: docs/plans/2026-07-17-provider-native-dialects-plan.md §0.5 / §5.)
//
// JS SDK differences, handled here: `timeout` is milliseconds; an HTTP-status error is an
// `APIError` with a numeric `status` (Python's APIStatusError, `.status_code`); the
// stream is an async iterable of the same raw events (snake_case wire names).

import * as http from "../platform/http.js";
import { errText, pyInt, rstrip } from "../platform/py.js";
import { adapterHttpError, LLMResponse, popReasoning, StreamDelta, selectAllowed, splitSystem } from "./base.js";

let sdk = null;
/** The Anthropic SDK, imported on first use (Python measured `import anthropic` at ~584 ms
 * of every boot — history: llm/_lazy.py). */
export function loadAnthropic() {
  sdk ??= import("@anthropic-ai/sdk");
  return sdk;
}

/** Python's `isinstance(e, anthropic.APIStatusError)`. */
async function isStatusError(e) {
  const m = await loadAnthropic();
  return e instanceof m.APIError && typeof e.status === "number";
}

/** The SDK's HTTP goes through the kit's client (the env proxy httpx honoured; one door). */
export const sdkFetch = (url, init) => http.fetch(url, init);

export const DEFAULT_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_MODEL = "claude-haiku-4-5";

// The keyless / offline fallback for models() (D8). Anthropic's /v1/models endpoint
// exists (since 2025) and models() prefers it; this curated list survives on ANY error so
// the works-without-a-key behaviour is kept. Re-verify the ids at each model launch.
export const CURATED_MODELS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
];

// Model generations (verified 2026-07-14 at platform.claude.com/docs effort +
// adaptive-thinking; the 5.x rows 2026-10-10 against the claude-api skill's model table of
// 2026-10-06). A model matching a row is NEW: ADAPTIVE thinking + output_config.effort (the
// effort WORD from the reasoning_map), and it 400-REJECTS the legacy budget_tokens. A model
// matching no row is LEGACY (claude-haiku-4-5 and older): the classic budget_tokens (the
// NUMBER from the reasoning_map, via the resolver), samplers allowed. Per row:
//   off       how thinking is turned off — "disabled", "between_tools" (Sonnet 5.5 400s on
//             disabled), or null where it can't be (Fable, Mythos, Opus 5.5 400 on disabled;
//             the field is left out and the model thinks anyway)
//   sampling  false where temperature / top_p / top_k 400 even with thinking off (removed, or
//             any non-default value rejected)
// First match wins, so a longer id sits above its prefix (opus-5-5 above opus-5).
// Re-verify at each model launch.
const GENERATIONS = [
  ["fable-5", { off: null, sampling: false }],
  ["mythos-5", { off: null, sampling: false }],
  ["opus-5-5", { off: null, sampling: false }],
  ["opus-5", { off: "disabled", sampling: false }],
  ["sonnet-5-5", { off: "between_tools", sampling: false }],
  ["sonnet-5", { off: "disabled", sampling: false }],
  ["haiku-5-5", { off: "disabled", sampling: false }],
  ["opus-4-8", { off: "disabled", sampling: false }],
  ["opus-4-7", { off: "disabled", sampling: false }],
  ["opus-4-6", { off: "disabled", sampling: true }],
  ["sonnet-4-6", { off: "disabled", sampling: true }],
];
const SAMPLERS = ["temperature", "top_p", "top_k"];

/** LLM adapter for Anthropic's Claude family over the official SDK. */
export class AnthropicAdapter {
  static _GENERATIONS = GENERATIONS;

  constructor(providerId, { apiKey, baseUrl = "", defaultModel = "", timeoutSeconds = 60 } = {}) {
    this.provider_id = providerId;
    this.provider_type = "anthropic";
    this._baseUrl = rstrip(baseUrl || DEFAULT_BASE_URL, "/");
    this.default_model = defaultModel || DEFAULT_MODEL;
    this._apiKey = apiKey;
    this._timeoutSeconds = timeoutSeconds;
    // Lazy client, the same shape as the other SDK adapters: construct stores config,
    // _ensureClient builds once. A keyless first call fails at request time.
    this._client = null;
  }

  /** Build the SDK client once, on first use. Keeps an already-set `_client` (tests
   * assign a fake), so it never rebuilds over one. */
  async _ensureClient() {
    if (this._client == null) {
      const { Anthropic } = await loadAnthropic();
      // D9: maxRetries 2 (the SDK default) + the provider's timeout + base URL (equal to
      // the default is harmless). The SDK owns the anthropic-version header.
      this._client = new Anthropic({
        apiKey: this._apiKey || "",
        baseURL: this._baseUrl,
        timeout: this._timeoutSeconds * 1000,
        maxRetries: 2,
        fetch: sdkFetch,
        // in a web worker (the phone's in-app server) the SDK must be told it's a browser's call:
        // it then sends Anthropic's browser-access header, without which its CORS answer refuses
        ...(typeof WorkerGlobalScope === "undefined" ? {} : { dangerouslyAllowBrowser: true }),
      });
    }
    return this._client;
  }

  // ── helpers ─────────────────────────────────────────────────────

  /** Anthropic wants the system text in a top-level field and only user/assistant turns
   * in `messages`: base.splitSystem, then the remainder as plain dicts. */
  _splitSystem(messages, system) {
    const [sysText, turns] = splitSystem(messages, system);
    return [sysText, turns.map((m) => ({ role: m.role, content: m.content }))];
  }

  /**
   * Anthropic extended thinking, model-aware (GENERATIONS). NEW models, on: adaptive
   * thinking + output_config.effort (the map WORD), samplers dropped (400-rejected under
   * thinking). NEW models, off: the generation's own off switch ("disabled" /
   * "between_tools", or none where the model can't stop thinking), samplers dropped where the
   * generation rejects them. LEGACY models: a `thinking` block with budget_tokens (the map
   * NUMBER, ≥1024 AND < max_tokens) + a max_tokens bump; drop the temperature override.
   */
  static _applyReasoning(body, think, effort, budget, model) {
    const m = (model || "").toLowerCase();
    const gen = GENERATIONS.find(([s]) => m.includes(s))?.[1] ?? null;
    if (!think) {
      if (gen?.off) body.thinking = { type: gen.off };
      if (gen && !gen.sampling) for (const k of SAMPLERS) delete body[k];
      return;
    }
    if (gen) {
      body.thinking = { type: "adaptive" };
      if (effort) body.output_config = { effort };
      for (const k of SAMPLERS) delete body[k]; // 400-rejected under thinking
    } else {
      const b = budget != null ? budget : 4096;
      body.thinking = { type: "enabled", budget_tokens: b };
      body.max_tokens = Math.max(pyInt(body.max_tokens || 4096), b + 2048);
      delete body.temperature; // thinking requires the default temperature
    }
  }

  /** Allowlist — Anthropic's typed params only (top_p/top_k/metadata) + the
   * stop → stop_sequences rename. Everything else (min_p, mirostat*, dry_*, xtc_*, seed,
   * samplers, response_format) is DROPPED — the Messages API has none of them. Nothing
   * left → null. */
  static _mapExtra(extra) {
    const out = selectAllowed(extra, new Set(["top_p", "top_k", "metadata", "stop"]), { stop: "stop_sequences" });
    return Object.keys(out).length ? out : null;
  }

  /** The messages.create params: model / messages / max_tokens (default 4096 — Anthropic
   * requires it) / temperature if set / system if any + the allowlisted extra + the
   * model-aware reasoning mutation. */
  _buildKwargs(messages, { model, temperature, maxTokens, system, think, extra }) {
    const [sysPrompt, msgs] = this._splitSystem(messages, system);
    const modelId = model || this.default_model;
    const kwargs = { model: modelId, messages: msgs, max_tokens: maxTokens || 4096 };
    if (temperature != null) kwargs.temperature = temperature;
    if (sysPrompt) kwargs.system = sysPrompt;
    const [rest, effort, budget] = popReasoning(extra);
    const mapped = AnthropicAdapter._mapExtra(rest);
    if (mapped) Object.assign(kwargs, mapped);
    AnthropicAdapter._applyReasoning(kwargs, think, effort, budget, modelId);
    return kwargs;
  }

  async _d10(e, { stream = false } = {}) {
    const err = (await isStatusError(e))
      ? adapterHttpError("anthropic", e.status, errText(e), { stream })
      : adapterHttpError("anthropic", null, errText(e)); // connection / timeout / other
    err.cause = e;
    return err;
  }

  // ── the adapter contract ────────────────────────────────────────

  async chat(messages, { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {}) {
    const kwargs = this._buildKwargs(messages, { model, temperature, maxTokens, system, think, extra });
    let msg;
    try {
      msg = await (await this._ensureClient()).messages.create(kwargs);
    } catch (e) {
      throw await this._d10(e);
    }
    const text = msg.content
      .filter((blk) => blk?.type === "text")
      .map((blk) => blk.text)
      .join("");
    const usage = msg.usage;
    return LLMResponse({
      text,
      model: msg.model || kwargs.model,
      finish_reason: msg.stop_reason || "stop",
      prompt_tokens: pyInt(usage?.input_tokens || 0),
      completion_tokens: pyInt(usage?.output_tokens || 0),
      raw: msg,
    });
  }

  async *streamChat(
    messages,
    { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {},
  ) {
    const kwargs = this._buildKwargs(messages, { model, temperature, maxTokens, system, think, extra });
    let pt = 0;
    let ct = 0;
    let finish = "";
    try {
      const events = await (await this._ensureClient()).messages.create({ ...kwargs, stream: true });
      // Raw stream events: message_start carries usage on .message.usage;
      // content_block_delta with a text_delta carries .delta.text; message_delta carries
      // the running output_tokens on .usage.
      for await (const event of events) {
        const etype = event?.type ?? null;
        if (etype === "message_start") {
          const u = event.message?.usage ?? null;
          if (u != null && u.input_tokens != null) pt = pyInt(u.input_tokens || 0);
        } else if (etype === "content_block_delta") {
          const delta = event.delta ?? null;
          if (delta != null && delta.type === "text_delta") {
            const chunk = delta.text || "";
            if (chunk) yield StreamDelta({ text: chunk });
          }
        } else if (etype === "message_delta") {
          const reason = event.delta?.stop_reason ?? null;
          if (reason) finish = reason === "max_tokens" ? "length" : reason;
          const u = event.usage ?? null;
          if (u != null && u.output_tokens != null) ct = pyInt(u.output_tokens || 0);
        }
      }
    } catch (e) {
      throw await this._d10(e, { stream: true });
    }
    yield StreamDelta({ done: true, prompt_tokens: pt, completion_tokens: ct, finish_reason: finish });
  }

  async models() {
    // D8: the real /v1/models endpoint; the curated list on ANY error, so the
    // works-without-a-key behaviour survives.
    try {
      const out = [];
      for await (const m of (await this._ensureClient()).models.list()) out.push(m.id);
      return out;
    } catch {
      return [...CURATED_MODELS];
    }
  }

  // No embed(): Anthropic exposes no embeddings endpoint. The contract's embed is
  // optional — leaving the method out makes /v1/ai/embeddings report its clear 400.

  async ping() {
    try {
      // Tiny ping: ask for 1 token. Cheap + validates the key.
      await (await this._ensureClient()).messages.create({
        model: this.default_model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
      return true;
    } catch (e) {
      // reachable but rejected (e.g. 401) = up; a ≥500 = down.
      if (await isStatusError(e)) return (e.status || 500) < 500;
      return false;
    }
  }
}
