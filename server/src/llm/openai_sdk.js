// SPDX-License-Identifier: MIT
// OpenAI + the OpenAI-shaped clouds over the official `openai` SDK (the port of
// llm/openai_sdk.py).
//
// Serves five provider types behind ONE adapter (registry.construct):
//   - `openai`    → the Responses API (`client.responses.create`), D3.
//   - `deepseek` / `openrouter` / `xai` / `mistral` → chat-completions
//     (`client.chat.completions.create`) at each vendor's base URL, D4.
//
// The SDK owns the wire + retries, and the samplers are an allowlist per type
// (TYPE_PARAM_PROFILES), so the `min_p` 400 unknown-field bug dies at the boundary:
// anything else in `extra` is DROPPED. Reasoning emission is per type (D5):
// EMIT_EFFORT_TYPES only; the rest run at the model's own default.
//
// Verified 2026-07-17 (Python SDK introspection + vendor docs, still true of the JS SDK's
// shapes): Responses stream events `response.output_text.delta` (.delta),
// `response.completed` (.response.usage), `response.failed`, `error`,
// `response.incomplete`; non-stream `output_text` (the SDK's aggregate),
// `usage.input_tokens/output_tokens`, `status`, `incomplete_details.reason`. OpenRouter
// documents `reasoning_effort` on chat-completions AND top_k / min_p /
// repetition_penalty; Mistral uses `random_seed` (NOT `seed`) and supports a real
// json_schema response_format; DeepSeek's response_format is json_object ONLY; xAI
// supports json_schema. (Record: docs/plans/2026-07-17-provider-native-dialects-plan.md.)
//
// JS SDK differences, handled here: the client's `timeout` is milliseconds; there is no
// `extra_body` — unknown params in the body object are sent verbatim, which is what
// Python's extra_body merge put on the wire; an HTTP-status error is an `APIError` with a
// numeric `status` (Python's APIStatusError, `.status_code`).

import * as http from "../platform/http.js";
import { getLogger } from "../platform/log.js";
import { pyInt, RuntimeError, rstrip, ValueError } from "../platform/py.js";
import {
  adapterHttpError,
  buildChatMessages,
  errText,
  isDict,
  LLMResponse,
  popReasoning,
  selectAllowed,
  splitSystem,
  StreamDelta,
} from "./base.js";

const log = getLogger("llm_runner.llm.openai_sdk");

let sdk = null;
/** The openai SDK, imported on first use. Python measured `import openai` at ~586 ms of
 * every boot (the registry builds an adapter for every configured provider) for an SDK
 * most sessions never call (history: llm/_lazy.py). */
export function loadOpenAI() {
  sdk ??= import("openai");
  return sdk;
}

/** Python's `isinstance(e, openai.APIStatusError)`: an SDK error that carries an HTTP status. */
async function isStatusError(e) {
  const m = await loadOpenAI();
  return e instanceof m.APIError && typeof e.status === "number";
}

/** The SDKs' HTTP goes through the kit's client (the env proxy httpx honoured; one door). */
export const sdkFetch = (url, init) => http.fetch(url, init);

// Per-type default base_url + default_model (used when the config leaves them blank).
export const PROVIDER_DEFAULTS = {
  openai: { base_url: "https://api.openai.com/v1", default_model: "gpt-4o-mini" },
  deepseek: { base_url: "https://api.deepseek.com/v1", default_model: "deepseek-chat" },
  openrouter: { base_url: "https://openrouter.ai/api/v1", default_model: "openai/gpt-4o-mini" },
  xai: { base_url: "https://api.x.ai/v1", default_model: "" },
  mistral: { base_url: "https://api.mistral.ai/v1", default_model: "" },
};

// The typed chat-completions params each cloud DOCUMENTS; everything else in `extra` is
// dropped (the min_p-400 fix on the SDK path). openrouter additionally documents the
// llama-family long-tail samplers (top_k/min_p/repetition_penalty), delivered as extra
// body keys (TYPE_EXTRA_BODY_RENAMES). (openai is NOT here — it rides the Responses path,
// which speaks only top_p among samplers.)
export const TYPE_PARAM_PROFILES = {
  deepseek: new Set(["top_p", "stop", "seed", "presence_penalty", "frequency_penalty", "response_format"]),
  openrouter: new Set([
    "top_p",
    "stop",
    "seed",
    "presence_penalty",
    "frequency_penalty",
    "response_format",
    "top_k",
    "min_p",
    "repeat_penalty",
  ]),
  xai: new Set(["top_p", "stop", "seed", "presence_penalty", "frequency_penalty", "response_format"]),
  mistral: new Set(["top_p", "stop", "presence_penalty", "frequency_penalty", "response_format", "seed"]),
};

// Source key → wire name for the profile params sent as extra body keys (not a typed CC
// param, or provider-renamed). openrouter: top_k/min_p pass through, repeat_penalty →
// repetition_penalty (OpenRouter's documented spelling). mistral: seed → random_seed
// (Mistral's documented name — verified 2026-07-17). Everything not listed is typed.
export const TYPE_EXTRA_BODY_RENAMES = {
  openrouter: { top_k: "top_k", min_p: "min_p", repeat_penalty: "repetition_penalty" },
  mistral: { seed: "random_seed" },
};

// D5: only these types emit a reasoning-effort param. openai → Responses
// reasoning.effort; openrouter → CC reasoning_effort (both documented).
// deepseek/xai/mistral emit NOTHING — the model thinks at its own default (DeepSeek has no
// such param, xAI varies by model generation, Mistral 422-rejects unknown params).
export const EMIT_EFFORT_TYPES = new Set(["openai", "openrouter"]);

/** Adapter for OpenAI (Responses API) and the OpenAI-shaped clouds (chat-completions). */
export class OpenAISDKAdapter {
  constructor(providerId, providerType, { apiKey = "", baseUrl = "", defaultModel = "", timeoutSeconds = 60 } = {}) {
    this.provider_id = providerId;
    this.provider_type = providerType;
    const defaults = Object.hasOwn(PROVIDER_DEFAULTS, providerType) ? PROVIDER_DEFAULTS[providerType] : {};
    this._baseUrl = rstrip(baseUrl || defaults.base_url || "", "/");
    this.default_model = defaultModel || defaults.default_model || "";
    if (!this._baseUrl) {
      throw new ValueError(
        `provider ${providerId} (${providerType}) has no base_url ` +
          "and no default available — set base_url in the provider config",
      );
    }
    this._apiKey = apiKey;
    this._timeoutSeconds = timeoutSeconds;
    // Lazy client: the SDK validates the key when the client is built (empty key + no
    // env → "Missing credentials"), so a seeded KEYLESS row registers fine and its first
    // real call surfaces the SDK's own no-key error (chat → "{type} request failed …";
    // models()/ping() swallow → []/false). The base_url check above stays eager — it's a
    // config error, not a key/network one.
    this._client = null;
  }

  /** Build the SDK client once, on first use. Keeps an already-set `_client` (tests
   * assign a fake), so it never rebuilds over one. */
  async _ensureClient() {
    if (this._client == null) {
      const { OpenAI } = await loadOpenAI();
      // D9: maxRetries 2 (the SDK default) + the provider's timeout + base URL.
      this._client = new OpenAI({
        apiKey: this._apiKey,
        baseURL: this._baseUrl,
        timeout: this._timeoutSeconds * 1000,
        maxRetries: 2,
        fetch: sdkFetch,
      });
    }
    return this._client;
  }

  // ── param mapping ───────────────────────────────────────────────

  /** Split the profile-allowed `extra` into `[typed, extraBody]`. Keys outside this
   * type's profile are DROPPED (the min_p-400 fix); the extra-body renames carry
   * openrouter's long-tail samplers + mistral's random_seed. */
  _ccParams(extra) {
    const pt = this.provider_type;
    const kept = selectAllowed(extra, TYPE_PARAM_PROFILES[pt] ?? new Set());
    // DeepSeek documents json_object ONLY — downgrade a json_schema response_format to
    // json_object. xai/mistral document real json_schema; openrouter forwards per model —
    // both pass through untouched.
    const rf = kept.response_format;
    if (pt === "deepseek" && isDict(rf) && rf.type === "json_schema") kept.response_format = { type: "json_object" };
    const renames = TYPE_EXTRA_BODY_RENAMES[pt] ?? {};
    const typed = {};
    const extraBody = {};
    for (const [k, v] of Object.entries(kept)) {
      if (Object.hasOwn(renames, k)) extraBody[renames[k]] = v;
      else typed[k] = v;
    }
    return [typed, extraBody];
  }

  /** A single user turn with no history → a plain string; else the typed input array
   * (assistant turns use output_text, everything else input_text). */
  static _responsesInput(turns) {
    if (turns.length === 1 && turns[0].role === "user") return turns[0].content;
    return turns.map((m) => ({
      role: m.role,
      content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
    }));
  }

  /** Responses `text` format from a response_format contract. json_schema → the
   * schema-enforced format with strict ALWAYS false (our schemas don't meet strict's
   * every-key-required rule — never mutate the schema); json_object → the json_object
   * format. A json_schema without a usable schema falls back to json_object. */
  static _responsesText(extra) {
    const rf = (extra || {}).response_format;
    if (!isDict(rf)) return null;
    const t = rf.type;
    if (t === "json_schema") {
      const js = rf.json_schema || {};
      const schema = js.schema;
      if (isDict(schema)) {
        return { format: { type: "json_schema", name: js.name || "response", strict: false, schema } };
      }
    }
    if (t === "json_schema" || t === "json_object" || t === "json") return { format: { type: "json_object" } };
    return null;
  }

  _responsesKwargs(messages, { model = null, temperature = null, maxTokens = null, system = null, think = false, extra = null }) {
    const [rest, effort] = popReasoning(extra);
    const [sysText, turns] = splitSystem(messages, system);
    const kwargs = {
      model: model || this.default_model,
      input: OpenAISDKAdapter._responsesInput(turns),
      store: false, // the never-persist ruling — no server-side interaction object
    };
    if (sysText) kwargs.instructions = sysText;
    if (temperature != null) kwargs.temperature = temperature;
    if (maxTokens != null) kwargs.max_output_tokens = maxTokens;
    // openai speaks only top_p among the samplers on Responses; the rest drop here.
    Object.assign(kwargs, selectAllowed(rest, new Set(["top_p"])));
    if (think && effort) kwargs.reasoning = { effort };
    const fmt = OpenAISDKAdapter._responsesText(rest);
    if (fmt !== null) kwargs.text = fmt;
    return kwargs;
  }

  _ccKwargs(
    messages,
    { model = null, temperature = null, maxTokens = null, system = null, think = false, extra = null, stream = false },
  ) {
    const [rest, effort] = popReasoning(extra);
    const [typed, extraBody] = this._ccParams(rest);
    const kwargs = {
      model: model || this.default_model,
      messages: buildChatMessages(messages, system),
    };
    if (temperature != null) kwargs.temperature = temperature;
    if (maxTokens != null) kwargs.max_tokens = maxTokens;
    if (stream) {
      kwargs.stream = true;
      kwargs.stream_options = { include_usage: true };
    }
    if (think && effort && EMIT_EFFORT_TYPES.has(this.provider_type)) kwargs.reasoning_effort = effort;
    Object.assign(kwargs, typed);
    // Python's `extra_body=`: merged into the request body. The JS SDK sends unknown body
    // keys verbatim, so the same keys land in the same JSON body.
    Object.assign(kwargs, extraBody);
    return kwargs;
  }

  /** Create a Responses call; when a reasoning model 400s on `temperature`, drop it and
   * retry ONCE with a single WARNING. */
  async _responsesCreate(kwargs, { stream }) {
    const client = await this._ensureClient();
    try {
      return await client.responses.create({ ...kwargs, stream });
    } catch (e) {
      if (
        (await isStatusError(e)) &&
        e.status === 400 &&
        Object.hasOwn(kwargs, "temperature") &&
        errText(e).toLowerCase().includes("temperature")
      ) {
        log.warning("openai Responses rejected temperature — retrying once without it (reasoning model)");
        delete kwargs.temperature;
        return await client.responses.create({ ...kwargs, stream });
      }
      throw e;
    }
  }

  /** The D10 mapping of an SDK failure: a status error keeps its status, anything else is
   * "request failed" (Python's `except APIStatusError` / `except Exception` pair). */
  async _d10(e, { stream = false } = {}) {
    const err = (await isStatusError(e))
      ? adapterHttpError(this.provider_type, e.status, errText(e), { stream })
      : adapterHttpError(this.provider_type, null, errText(e));
    err.cause = e;
    return err;
  }

  // ── the adapter contract ────────────────────────────────────────

  async chat(messages, { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {}) {
    const opts = { model, temperature, maxTokens, system, think, extra };
    if (this.provider_type === "openai") {
      const kwargs = this._responsesKwargs(messages, opts);
      let r;
      try {
        r = await this._responsesCreate(kwargs, { stream: false });
      } catch (e) {
        throw await this._d10(e);
      }
      const usage = r.usage ?? null;
      let finish = "stop";
      if (r.status === "incomplete") {
        const reason = r.incomplete_details?.reason ?? null;
        if (reason === "max_output_tokens") finish = "length";
      }
      return LLMResponse({
        text: r.output_text || "",
        model: r.model || kwargs.model,
        finish_reason: finish,
        prompt_tokens: usage ? pyInt(usage.input_tokens || 0) : 0,
        completion_tokens: usage ? pyInt(usage.output_tokens || 0) : 0,
        raw: r,
      });
    }

    const kwargs = this._ccKwargs(messages, { ...opts, stream: false });
    let resp;
    try {
      resp = await (await this._ensureClient()).chat.completions.create(kwargs);
    } catch (e) {
      throw await this._d10(e);
    }
    const choice = resp.choices?.length ? resp.choices[0] : null;
    const msg = choice ? (choice.message ?? null) : null;
    const usage = resp.usage ?? null;
    return LLMResponse({
      text: msg ? msg.content || "" : "",
      model: resp.model || kwargs.model,
      finish_reason: choice ? choice.finish_reason || "stop" : "stop",
      prompt_tokens: usage ? pyInt(usage.prompt_tokens || 0) : 0,
      completion_tokens: usage ? pyInt(usage.completion_tokens || 0) : 0,
      raw: resp,
    });
  }

  async *streamChat(
    messages,
    { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {},
  ) {
    const opts = { model, temperature, maxTokens, system, think, extra };
    if (this.provider_type === "openai") yield* this._streamResponses(messages, opts);
    else yield* this._streamCc(messages, opts);
  }

  async *_streamResponses(messages, opts) {
    const kwargs = this._responsesKwargs(messages, opts);
    let pt = 0;
    let ct = 0;
    let finish = "";
    try {
      const stream = await this._responsesCreate(kwargs, { stream: true });
      for await (const event of stream) {
        const etype = event?.type ?? null;
        if (etype === "response.output_text.delta") {
          const piece = event.delta || "";
          if (piece) yield StreamDelta({ text: piece });
        } else if (etype === "response.completed") {
          finish = "stop";
          const u = event.response?.usage ?? null;
          if (u != null) {
            pt = pyInt(u.input_tokens || 0);
            ct = pyInt(u.output_tokens || 0);
          }
        } else if (etype === "response.incomplete") {
          const reason = event.response?.incomplete_details?.reason ?? null;
          finish = reason === "max_output_tokens" ? "length" : reason || "";
        } else if (etype === "response.failed" || etype === "error") {
          throw adapterHttpError(this.provider_type, null, streamFailureDetail(event), { stream: true });
        }
        // every other event type (reasoning deltas, tool calls, …) is ignored
      }
    } catch (e) {
      if (e instanceof RuntimeError) throw e; // the D10 stream error just raised — don't re-wrap
      throw await this._d10(e, { stream: true });
    }
    yield StreamDelta({ done: true, prompt_tokens: pt, completion_tokens: ct, finish_reason: finish });
  }

  async *_streamCc(messages, opts) {
    const kwargs = this._ccKwargs(messages, { ...opts, stream: true });
    let pt = 0;
    let ct = 0;
    let finish = "";
    try {
      const stream = await (await this._ensureClient()).chat.completions.create(kwargs);
      for await (const chunk of stream) {
        const cu = chunk?.usage ?? null;
        if (cu != null) {
          pt = pyInt(cu.prompt_tokens || 0);
          ct = pyInt(cu.completion_tokens || 0);
        }
        // the final usage frame carries an empty choices list — guard it.
        for (const choice of chunk?.choices || []) {
          finish = choice.finish_reason || finish;
          const delta = choice.delta ?? null;
          const piece = delta ? delta.content : null;
          if (piece) yield StreamDelta({ text: piece });
        }
      }
    } catch (e) {
      throw await this._d10(e, { stream: true });
    }
    yield StreamDelta({ done: true, prompt_tokens: pt, completion_tokens: ct, finish_reason: finish });
  }

  async embed(texts, { model = null, taskType = "" } = {}) {
    // taskType accepted + ignored: OpenAI-shape embeddings have no task concept.
    let r;
    try {
      r = await (await this._ensureClient()).embeddings.create({ input: [...texts], model: model || this.default_model });
    } catch (e) {
      throw await this._d10(e);
    }
    return r.data.map((d) => [...d.embedding]);
  }

  async models() {
    try {
      const out = [];
      for await (const m of (await this._ensureClient()).models.list()) out.push(m.id);
      return out;
    } catch {
      return [];
    }
  }

  async ping() {
    try {
      await (await this._ensureClient()).models.list();
      return true;
    } catch (e) {
      if (await isStatusError(e)) return (e.status || 500) < 500;
      return false;
    }
  }
}

/** Best-effort message off a response.failed / error stream event (no HTTP status on a
 * mid-stream failure — the D10 helper renders the request-failed form). */
function streamFailureDetail(event) {
  const err = event?.response?.error ?? null;
  const msg = err?.message || event?.message || "stream failed";
  return String(msg);
}
