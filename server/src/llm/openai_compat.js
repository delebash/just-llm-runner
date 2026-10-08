// SPDX-License-Identifier: MIT
// OpenAI-compatible adapter for LOCAL servers (the port of llm/openai_compat.py): the
// generic `openai-compat` gateway (vLLM, LM Studio, a self-hosted box) and the bundled
// `local-llamacpp` runner, both speaking POST /chat/completions in the OpenAI shape, over
// platform/http.js. The true clouds (OpenAI/DeepSeek/OpenRouter/xAI/Mistral) ride the
// official SDK adapter (openai_sdk.js); this file keeps byte-for-byte pass-through (the
// samplers order array, llama-server's `prompt_progress` frames) the SDK path doesn't touch.

import { pyInt, pyStr, RuntimeError, rstrip, truthy, ValueError } from "../platform/py.js";
import { pyFloatValue } from "../platform/pyjson.js";
import {
  buildChatMessages,
  head,
  httpxRequest,
  httpxStream,
  isDict,
  iterLines,
  LLMResponse,
  popReasoning,
  setdefault,
  StreamDelta,
  TransportError,
} from "./base.js";
import * as dispatch from "./dispatch.js";

// Per-provider default base URLs, used when the config's baseUrl is empty.
export const PROVIDER_DEFAULTS = {
  "openai-compat": {
    // No real default — a "compat" provider always has a custom URL.
    base_url: "http://localhost:11434/v1",
    default_model: "llama3.2",
  },
  "local-llamacpp": {
    // A FALLBACK for a host with no runner service wired (standalone use, adapter tests).
    // When one IS wired the live router URL wins — the port is allocated at spawn, so
    // this number is the preferred one, not the actual one (`_apiBase`). default_model is
    // empty — the model is whatever GGUF the runner loaded; llama-server accepts any id.
    base_url: "http://127.0.0.1:8080/v1",
    default_model: "",
  },
};

export class OpenAICompatAdapter {
  constructor(providerId, providerType, { apiKey, baseUrl = "", defaultModel = "", timeoutSeconds = 60 } = {}) {
    this.provider_id = providerId;
    this.provider_type = providerType;
    this._apiKey = apiKey;
    const defaults = Object.hasOwn(PROVIDER_DEFAULTS, providerType) ? PROVIDER_DEFAULTS[providerType] : {};
    this._baseUrl = rstrip(baseUrl || defaults.base_url || "", "/");
    this.default_model = defaultModel || defaults.default_model || "";
    if (!this._baseUrl) {
      throw new ValueError(
        `provider ${providerId} (${providerType}) has no base_url ` +
          "and no default available — set base_url in the provider config",
      );
    }
    // httpx.Client(timeout=t): connect / each read / each write bounded by t, built on
    // first use (base.agentFor). Python built the client lazily because httpx loads the
    // system CA bundle at construction (~210 ms × every configured provider at boot).
    this._timeoutSeconds = timeoutSeconds;
  }

  _headers() {
    const h = { "content-type": "application/json" };
    if (this._apiKey) h.authorization = `Bearer ${this._apiKey}`;
    return h;
  }

  /**
   * The base URL for THIS request — resolved every time for the bundled runner.
   *
   * `local-llamacpp` does not listen on a fixed port: the router binds a free one at
   * spawn, because two family apps both assuming :8080 meant the second app's traffic
   * reached the first app's engine. A base URL frozen at registry-build time cannot be
   * trusted — the host wires `setLocalRunnerBaseUrl` to the running service and we ask
   * it per call. Every other type (`openai-compat` — LM Studio, vLLM, a self-hosted box)
   * keeps its configured URL: that one IS a user-chosen endpoint. With no resolver wired
   * (standalone host, adapter tests) the configured value stands.
   */
  get _apiBase() {
    if (this.provider_type !== "local-llamacpp") return this._baseUrl;
    const resolver = dispatch.getLocalRunnerBaseUrl();
    if (resolver == null) return this._baseUrl;
    const live = rstrip(resolver() || "", "/");
    if (!live) {
      // Deliberately NOT falling back to the configured port. That fallback is the
      // original defect: :8080 may well answer — as somebody else's engine.
      throw new RuntimeError(
        "the bundled llama.cpp engine isn't running — load a model first " +
          "(POST /v1/llm-runner/load), then retry",
      );
    }
    return `${live}/v1`;
  }

  /**
   * Emit this LOCAL server's native reasoning control from the RESOLVED values. The
   * bundled llama.cpp runner gets the explicit `chat_template_kwargs.enable_thinking`
   * toggle BOTH ways (ONE resident model serves thinking-on chat AND thinking-off
   * extraction per request, no reload — box-verified at b9870) PLUS the per-request
   * `reasoning_budget_tokens` (b9982+, grepped from tools/server/server-common.cpp): the
   * resolver's budget when on, 0 when off (belt and braces — the toggle already
   * suppresses). A generic `openai-compat` server keeps the conservative
   * on → enable_thinking / off → nothing (we don't own its chat template). (`effort` is
   * unused here — the cloud reasoning_effort emission lives in openai_sdk.js; the param
   * stays for the call contract shared with every adapter.)
   */
  _applyReasoning(body, think, effort, budget) {
    if (this.provider_type === "local-llamacpp") {
      setdefault(body, "chat_template_kwargs", {}).enable_thinking = think;
      body.reasoning_budget_tokens = think && budget != null ? budget : 0;
      return;
    }
    if (!think) return;
    if (this.provider_type === "openai-compat") {
      setdefault(body, "chat_template_kwargs", {}).enable_thinking = true;
    }
  }

  async chat(messages, { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {}) {
    const body = {
      model: model || this.default_model,
      messages: buildChatMessages(messages, system),
    };
    if (temperature != null) body.temperature = pyFloatValue(temperature);
    if (maxTokens != null) body.max_tokens = maxTokens;
    const [rest, effort, budget] = popReasoning(extra);
    if (truthy(rest)) Object.assign(body, rest);
    // response_format passes through UNCHANGED for every provider type. llama-server reads
    // a json_schema schema ONLY from the OpenAI-standard nested form (server-common.cpp,
    // same at b9993/b10437/b10964); the flat form its README documents is silently read
    // as "any JSON" (observed 2026-09-19).
    this._applyReasoning(body, think, effort, budget);

    const url = `${this._apiBase}/chat/completions`;
    let r;
    try {
      r = await httpxRequest("POST", url, { json: body, headers: this._headers(), timeout: this._timeoutSeconds });
    } catch (e) {
      if (e instanceof TransportError) {
        const err = new RuntimeError(`${this.provider_type} request failed: ${e.message}`);
        err.cause = e;
        throw err;
      }
      throw e;
    }
    if (r.status >= 400) throw new RuntimeError(`${this.provider_type} ${r.status}: ${head(r.text, 400)}`);

    const payload = r.json();
    const choice = (truthy(payload.choices) ? payload.choices : [{}])[0];
    const message = choice.message || {};
    const usage = payload.usage || {};
    return LLMResponse({
      text: message.content || "",
      model: payload.model || body.model,
      finish_reason: choice.finish_reason || "stop",
      prompt_tokens: pyInt(usage.prompt_tokens || 0),
      completion_tokens: pyInt(usage.completion_tokens || 0),
      raw: payload,
    });
  }

  async *streamChat(
    messages,
    { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {},
  ) {
    const body = {
      model: model || this.default_model,
      messages: buildChatMessages(messages, system),
      stream: true,
      // Ask for a final usage frame (servers that don't support it ignore the field;
      // we just report 0 tokens then).
      stream_options: { include_usage: true },
    };
    if (temperature != null) body.temperature = pyFloatValue(temperature);
    if (this.provider_type === "local-llamacpp") {
      // The builtin engine reports prompt-eval progress in the stream (llama-server
      // `return_progress`, PR 15827 — works on the OAI chat endpoint; chunks carry a
      // top-level `prompt_progress`). Other servers never see the field.
      body.return_progress = true;
    }
    if (maxTokens != null) body.max_tokens = maxTokens;
    const [rest, effort, budget] = popReasoning(extra);
    if (truthy(rest)) Object.assign(body, rest);
    // response_format passes through UNCHANGED (see chat above).
    this._applyReasoning(body, think, effort, budget);

    const url = `${this._apiBase}/chat/completions`;
    let pt = 0;
    let ct = 0;
    let finish = "";
    // A transport failure propagates as itself (Python's stream path doesn't wrap httpx
    // errors) — a TransportError carrying the cause's text.
    const r = await httpxStream("POST", url, { json: body, headers: this._headers(), timeout: this._timeoutSeconds });
    if (r.status >= 400) {
      const detail = await r.text();
      throw new RuntimeError(`${this.provider_type} stream ${r.status}: ${head(detail, 400)}`);
    }
    for await (const line of iterLines(r.body)) {
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      const usage = evt.usage;
      if (truthy(usage)) {
        pt = pyInt(usage.prompt_tokens || 0);
        ct = pyInt(usage.completion_tokens || 0);
      }
      // Prompt-eval progress chunks (builtin engine only — see return_progress above).
      // Overall progress = processed/total per the upstream contract; guard total=0.
      const prog = evt.prompt_progress;
      if (isDict(prog)) {
        const total = pyInt(prog.total || 0);
        const processed = pyInt(prog.processed || 0);
        if (total > 0) yield StreamDelta({ progress: Math.min(1.0, processed / total) });
      }
      // The final usage frame carries an empty choices list.
      for (const choice of evt.choices || []) {
        finish = choice.finish_reason || finish;
        const d = choice.delta || {};
        // The model's thinking, before its answer (llama.cpp's default reasoning_format
        // splits it out) — its own event, never answer text.
        const thought = d.reasoning_content || "";
        if (thought) yield StreamDelta({ reasoning: thought });
        const chunk = d.content || "";
        if (chunk) yield StreamDelta({ text: chunk });
      }
    }
    yield StreamDelta({ done: true, prompt_tokens: pt, completion_tokens: ct, finish_reason: finish });
  }

  /** GET /models — most OpenAI-compat servers expose it. */
  async models() {
    const url = `${this._apiBase}/models`;
    let payload;
    try {
      const r = await httpxRequest("GET", url, { headers: this._headers(), timeout: this._timeoutSeconds });
      if (r.status >= 400) return [];
      payload = r.json();
    } catch (e) {
      if (e instanceof TransportError || e instanceof SyntaxError) return [];
      throw e;
    }
    // OpenAI shape: {data: [{id, ...}, ...]}
    const data = payload.data || [];
    return data.filter((m) => m.id).map((m) => pyStr(m.id));
  }

  /** POST /embeddings (OpenAI shape: {data: [{embedding}, ...]}). `taskType` is accepted
   * and IGNORED — the OpenAI embeddings API has no task-side concept. */
  async embed(texts, { model = null, taskType = "" } = {}) {
    const body = { model: model || this.default_model, input: [...texts] };
    const url = `${this._apiBase}/embeddings`;
    let r;
    try {
      r = await httpxRequest("POST", url, { json: body, headers: this._headers(), timeout: this._timeoutSeconds });
    } catch (e) {
      if (e instanceof TransportError) {
        const err = new RuntimeError(`${this.provider_type} embeddings request failed: ${e.message}`);
        err.cause = e;
        throw err;
      }
      throw e;
    }
    if (r.status >= 400) throw new RuntimeError(`${this.provider_type} embeddings ${r.status}: ${head(r.text, 400)}`);
    const data = r.json().data || [];
    return data.map((d) => [...(d.embedding || [])]);
  }

  async ping() {
    const url = `${this._apiBase}/models`;
    try {
      const r = await httpxRequest("GET", url, { headers: this._headers(), timeout: 5.0 });
      return r.status < 500;
    } catch (e) {
      if (e instanceof TransportError) return false;
      throw e;
    }
  }
}
