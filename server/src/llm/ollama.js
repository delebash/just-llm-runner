// SPDX-License-Identifier: MIT
// Ollama adapter (the port of llm/ollama.py), over platform/http.js.
//
// Local-first: defaults to http://localhost:11434. Speaks Ollama's native `/api/chat` (not
// `/v1/chat/completions`) so the `think` flag for reasoning models (deepseek-r1,
// qwen3-thinking) actually surfaces their thinking.

import { pyInt, RuntimeError, rstrip, truthy } from "../platform/py.js";
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

export const DEFAULT_BASE_URL = "http://localhost:11434";
export const DEFAULT_MODEL = "llama3.2";

/** Adapter for a local or remote Ollama server. */
export class OllamaAdapter {
  constructor(providerId, { apiKey = "", baseUrl = "", defaultModel = "", timeoutSeconds = 120 } = {}) {
    this.provider_id = providerId;
    this.provider_type = "ollama";
    this._apiKey = apiKey; // rarely needed; some hosted Ollamas use bearer
    this._baseUrl = rstrip(baseUrl || DEFAULT_BASE_URL, "/");
    this.default_model = defaultModel || DEFAULT_MODEL;
    // Local model loads can be slow; more headroom than the cloud-adapter default.
    // httpx.Client(timeout=t) semantics, built on first use (base.agentFor).
    this._timeoutSeconds = timeoutSeconds;
  }

  _headers() {
    const h = { "content-type": "application/json" };
    if (this._apiKey) h.authorization = `Bearer ${this._apiKey}`;
    return h;
  }

  /** Route per-call `extra` into Ollama's shape: sampling params under `options`,
   * structured output via the top-level `format`. (A top-level merge left the sampling
   * params where Ollama ignores them.) */
  static _applyExtra(body, extra) {
    if (!truthy(extra)) return;
    const opts = setdefault(body, "options", {});
    for (const [k, v] of Object.entries(extra)) {
      if (k === "response_format") {
        const fmt = isDict(v) ? v.type : v;
        // Ollama's structured outputs take a JSON Schema OBJECT in `format`; plain JSON
        // mode stays the "json" string.
        const schema = isDict(v) ? (v.json_schema || {}).schema : null;
        if (fmt === "json_schema" && isDict(schema)) body.format = schema;
        else if (fmt === "json_object" || fmt === "json" || fmt === "json_schema") body.format = "json";
      } else {
        opts[k] = v;
      }
    }
  }

  /**
   * Ollama's `think` takes a bool OR a level string (low/medium/high/max) — the effort
   * maps straight through. Think OFF sends an explicit `false` (changed 2026-07-27): an
   * omitted field inherits the model's own default, so a model that thinks BY DEFAULT
   * kept reasoning while the UI control said off. `think: false` is a documented
   * top-level field on /api/chat and /api/generate (the same omission bug was fixed in
   * other Ollama clients, openclaw #50741); the Anthropic adapter likewise sends an
   * explicit disabled state rather than omitting.
   */
  static _applyReasoning(body, think, effort) {
    if (think) body.think = ["low", "medium", "high", "max"].includes(effort) ? effort : true;
    else body.think = false;
  }

  _body(messages, { model, temperature, maxTokens, system, think, extra }, stream) {
    const body = {
      model: model || this.default_model,
      messages: buildChatMessages(messages, system),
      stream,
      options: temperature == null ? {} : { temperature },
    };
    if (maxTokens != null) body.options.num_predict = maxTokens;
    const [rest, effort] = popReasoning(extra);
    OllamaAdapter._applyExtra(body, rest);
    OllamaAdapter._applyReasoning(body, think, effort);
    return body;
  }

  async chat(messages, { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {}) {
    const body = this._body(messages, { model, temperature, maxTokens, system, think, extra }, false);
    const url = `${this._baseUrl}/api/chat`;
    let r;
    try {
      r = await httpxRequest("POST", url, { json: body, headers: this._headers(), timeout: this._timeoutSeconds });
    } catch (e) {
      if (e instanceof TransportError) {
        const err = new RuntimeError(`ollama request failed: ${e.message}`);
        err.cause = e;
        throw err;
      }
      throw e;
    }
    if (r.status >= 400) throw new RuntimeError(`ollama ${r.status}: ${head(r.text, 400)}`);

    const payload = r.json();
    const message = payload.message || {};
    // Thinking blocks stay out of the user-facing text — available in raw if wanted.
    const text = message.content || "";
    return LLMResponse({
      text,
      model: payload.model || body.model,
      finish_reason: payload.done ? "stop" : "length",
      prompt_tokens: pyInt(payload.prompt_eval_count || 0),
      completion_tokens: pyInt(payload.eval_count || 0),
      raw: payload,
    });
  }

  async *streamChat(
    messages,
    { model = null, temperature = 0.7, maxTokens = null, system = null, think = false, extra = null } = {},
  ) {
    const body = this._body(messages, { model, temperature, maxTokens, system, think, extra }, true);
    const url = `${this._baseUrl}/api/chat`;
    let pt = 0;
    let ct = 0;
    let finish = "";
    const r = await httpxStream("POST", url, { json: body, headers: this._headers(), timeout: this._timeoutSeconds });
    if (r.status >= 400) {
      const detail = await r.text();
      throw new RuntimeError(`ollama stream ${r.status}: ${head(detail, 400)}`);
    }
    // Ollama emits one JSON object per line (not SSE).
    for await (const line of iterLines(r.body)) {
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const message = evt.message || {};
      const chunk = message.content || "";
      if (chunk) yield StreamDelta({ text: chunk });
      if (evt.done) {
        pt = pyInt(evt.prompt_eval_count || 0);
        ct = pyInt(evt.eval_count || 0);
        finish = evt.done_reason === "length" ? "length" : "stop";
        break;
      }
    }
    yield StreamDelta({ done: true, prompt_tokens: pt, completion_tokens: ct, finish_reason: finish });
  }

  /** GET /api/tags lists installed models. */
  async models() {
    let payload;
    try {
      const r = await httpxRequest("GET", `${this._baseUrl}/api/tags`, {
        headers: this._headers(),
        timeout: this._timeoutSeconds,
      });
      if (r.status >= 400) return [];
      payload = r.json();
    } catch (e) {
      if (e instanceof TransportError || e instanceof SyntaxError) return [];
      throw e;
    }
    return (payload.models || []).filter((m) => m.name).map((m) => m.name);
  }

  /** Native /api/embed (batch); falls back to the legacy /api/embeddings (one text per
   * call) on older daemons. `taskType` is accepted and IGNORED — Ollama's embed API has no
   * task-side concept. */
  async embed(texts, { model = null, taskType = "" } = {}) {
    const arr = [...texts];
    const m = model || this.default_model;
    let r;
    try {
      r = await httpxRequest("POST", `${this._baseUrl}/api/embed`, {
        json: { model: m, input: arr },
        headers: this._headers(),
        timeout: this._timeoutSeconds,
      });
    } catch (e) {
      if (e instanceof TransportError) {
        const err = new RuntimeError(`ollama embeddings request failed: ${e.message}`);
        err.cause = e;
        throw err;
      }
      throw e;
    }
    if (r.status < 400) {
      const embs = r.json().embeddings;
      if (truthy(embs)) return embs.map((e) => [...e]);
    }
    const out = [];
    for (const t of arr) {
      // Python's fallback calls sit outside its try: a transport failure here propagates
      // as itself (a TransportError), not as "request failed".
      const rr = await httpxRequest("POST", `${this._baseUrl}/api/embeddings`, {
        json: { model: m, prompt: t },
        headers: this._headers(),
        timeout: this._timeoutSeconds,
      });
      if (rr.status >= 400) throw new RuntimeError(`ollama embeddings ${rr.status}: ${head(rr.text, 400)}`);
      out.push([...(rr.json().embedding || [])]);
    }
    return out;
  }

  async ping() {
    try {
      const r = await httpxRequest("GET", this._baseUrl, { timeout: 3.0 });
      return r.status < 500;
    } catch (e) {
      if (e instanceof TransportError) return false;
      throw e;
    }
  }
}
