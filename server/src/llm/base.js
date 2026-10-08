// SPDX-License-Identifier: MIT
// The LLM adapter contract — every provider implements this (the port of llm/base.py),
// plus the helpers every adapter shares.
//
// The contract (Python's `LLMAdapter` Protocol — structural, never a base class):
//
//   adapter.provider_id: string        adapter.provider_type: string
//   adapter.default_model: string
//   async chat(messages, {model, temperature = 0.7, maxTokens, system, think = false, extra})
//       → LLMResponse.  `temperature: null` OMITS the param (the provider's own default
//       applies) — the no-preset rule; a number is sent as given. `system` prepends a
//       system message. `think` enables reasoning where the provider supports it.
//   async *streamChat(messages, {…same…}) → StreamDelta events: text deltas, then ONE
//       `done` event carrying token usage.
//   async models() → string[]   (may hit the network — callers cache)
//   async embed(texts, {model, taskType = ""}) → number[][]   — OPTIONAL. `taskType` is
//       "document" | "query" | "" for providers that distinguish embedding sides
//       (Gemini); others accept and ignore it. An adapter with no embeddings endpoint
//       (Anthropic) omits the method and the embeddings route reports a clear 400.
//   async ping() → boolean   (reachable + credentials accepted)
//
// The data shapes (LLMMessage / LLMResponse / StreamDelta) are Python dataclasses —
// internal plumbing, never serialized as-is — so they keep their snake field names (the
// convention of schema.js's LLMConfig). The adapters' three public contract fields keep
// theirs too (`provider_id`, `provider_type`, `default_model`).

import { EnvHttpProxyAgent } from "undici";
import * as http from "../platform/http.js";
import { cpSlice, errText, pyStr, RuntimeError, splitlines, truthy } from "../platform/py.js";
import { pyJson } from "../platform/pyjson.js";

/** One conversation turn. `role` follows OpenAI's words (system / user / assistant / tool),
 * which every modern provider accepts; adapters map to their own shapes internally. */
export function LLMMessage(role, content) {
  return { role, content };
}

/** A non-streaming chat completion's result. finish_reason: "stop" | "length" | "tool_use" | "error". */
export function LLMResponse({ text, model, finish_reason = "stop", prompt_tokens = 0, completion_tokens = 0, raw = {} } = {}) {
  return { text, model, finish_reason, prompt_tokens, completion_tokens, raw };
}

/**
 * One streamed event. Text chunks carry `text`; the final event carries `done: true` plus
 * token usage (0 when the provider didn't report it). Adapters yield text deltas as they
 * arrive, then one `done` event so dispatch can record usage and the client can finalize.
 *
 * `progress`: prompt-eval progress 0..1 from the builtin engine's `prompt_progress` frames
 * (llama-server `return_progress`, PR 15827 — overall = processed/total); null on text/done
 * events and on adapters whose backend doesn't report it (cloud). `model` is set by the
 * DISPATCH layer on the done event (the resolved model — adapters leave it empty).
 * `finish_reason` (done event): why generation ended, in LLMResponse's words; "" when the
 * provider did not say. "length" means the reply was cut off — by max_tokens or a full
 * context (llama.cpp sends no error when the context fills mid-answer, only this).
 * `reasoning`: a piece of the model's THINKING, streamed before its answer (llama.cpp's
 * `delta.reasoning_content`); "" on every other event, never part of the answer's text.
 */
export function StreamDelta({
  text = "",
  done = false,
  prompt_tokens = 0,
  completion_tokens = 0,
  progress = null,
  model = "",
  finish_reason = "",
  reasoning = "",
} = {}) {
  return { text, done, prompt_tokens, completion_tokens, progress, model, finish_reason, reasoning };
}

/** Python's `isinstance(x, LLMAdapter)` on the runtime-checkable Protocol: every member present. */
export function isLLMAdapter(x) {
  if (!x || typeof x !== "object") return false;
  for (const f of ["provider_id", "provider_type", "default_model"]) if (!(f in x)) return false;
  for (const m of ["chat", "streamChat", "models", "embed", "ping"]) if (typeof x[m] !== "function") return false;
  return true;
}

/**
 * Split the reserved reasoning keys out of a per-call `extra`: the resolved effort
 * `reasoning_effort` (word) AND the resolved `reasoning_budget_tokens` (number), both
 * injected by dispatch's applyReasoning from the ONE resolver (reasoning.js). Returns
 * `[extraWithoutThem, effortWord, budgetTokens]` — a COPY, so NEITHER reserved key leaks
 * into a backend body verbatim; each adapter emits only the form its backend speaks.
 * `effort` is "" and `budget` null when absent.
 */
export function popReasoning(extra) {
  if (!truthy(extra)) return [extra, "", null];
  const e = { ...extra };
  const effort = e.reasoning_effort || "";
  const budget = Object.hasOwn(e, "reasoning_budget_tokens") ? e.reasoning_budget_tokens : null;
  delete e.reasoning_effort;
  delete e.reasoning_budget_tokens;
  return [e, effort, budget ?? null];
}

/** The OpenAI-shape message list: an optional leading system turn, then each turn as
 * `{role, content}`. The ONE builder shared by the openai-compat + ollama + openai-SDK
 * chat-completions paths. */
export function buildChatMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) out.push({ role: m.role, content: m.content });
  return out;
}

/**
 * Sweep the system text out of a turn list: the `system` argument plus any role="system"
 * turns, joined with a blank line → `[joinedOrNull, nonSystemTurns]` — the remainder for
 * each adapter to map to its own wire shape (anthropic dicts, gemini Content/Part, the
 * openai Responses input array).
 */
export function splitSystem(messages, system) {
  const parts = [];
  if (system) parts.push(system);
  const rest = [];
  for (const m of messages) {
    if (m.role === "system") {
      parts.push(m.content);
      continue;
    }
    rest.push(m);
  }
  return [parts.length ? parts.join("\n\n") : null, rest];
}

/**
 * The sampler allowlist filter: keep only keys in `allowed` (a Set) from a per-call
 * `extra`, applying `renames` (source key → wire key). Everything a typed cloud API
 * doesn't speak (min_p, mirostat*, the samplers order array, …) is DROPPED here — the
 * min_p-400 fix at the boundary.
 */
export function selectAllowed(extra, allowed, renames = null) {
  if (!truthy(extra)) return {};
  const rn = renames || {};
  const out = {};
  for (const [k, v] of Object.entries(extra)) {
    if (allowed.has(k)) out[Object.hasOwn(rn, k) ? rn[k] : k] = v;
  }
  return out;
}

/**
 * The D10 adapter-error contract in ONE place, so the JW error envelope + friendly-error
 * mapping keep parsing (they regex a 3-digit status). Non-stream →
 * `"{ptype} {status}: {detail[:400]}"`; stream → `"{ptype} stream {status}: …"`;
 * `status` null (transport/connection) → `"{ptype} request failed: {detail}"`.
 */
export function adapterHttpError(providerType, status, detail, { stream = false } = {}) {
  if (status == null) return new RuntimeError(`${providerType} request failed: ${detail}`);
  const kind = stream ? "stream " : "";
  return new RuntimeError(`${providerType} ${kind}${status}: ${cpSlice(pyStr(detail), 0, 400)}`);
}

// ── shared helpers (candidates for platform/) ────────────────────────────────

/** `s.removeprefix(p)`. Candidate for platform/py.js. */
export const removePrefix = (s, p) => (p && s.startsWith(p) ? s.slice(p.length) : s);

// ── the local adapters' HTTP (httpx.Client, on platform/http.js) ─────────────
// Candidates for platform/http.js: a per-request read timeout and httpx's error class.

/** httpx.HTTPError for transport failures (connect, read, timeout) — what `except
 * httpx.HTTPError` caught. Its message is the underlying cause (undici's own "fetch
 * failed" says nothing). */
export class TransportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TransportError";
  }
}

/** The useful text of a fetch failure: undici wraps the real cause in "fetch failed". */
export function transportText(e) {
  let x = e;
  if (x instanceof Error && x.cause && (x.message === "fetch failed" || x.message === "terminated")) x = x.cause;
  if (x instanceof AggregateError && !x.message && x.errors?.length) return x.errors.map((y) => errText(y)).join("; ");
  return errText(x);
}

const agents = new Map();
/**
 * The dispatcher for an httpx-style timeout of `seconds`: httpx's `timeout=t` bounds
 * connect, each read and each write separately — so a long stream that keeps sending
 * never times out, but a silent server does. undici's connect / headers / body (idle)
 * timeouts are exactly that; http.fetch's own `timeoutMs` bounds the WHOLE request,
 * which would cut a long stream. One agent per timeout value, built on first use.
 */
export function agentFor(seconds) {
  const ms = Math.max(1, Math.round(Number(seconds) * 1000));
  let a = agents.get(ms);
  if (!a) {
    a = new EnvHttpProxyAgent({ connectTimeout: ms, headersTimeout: ms, bodyTimeout: ms });
    agents.set(ms, a);
  }
  return a;
}

/**
 * The body httpx writes for `json=`: json.dumps(ensure_ascii=False, separators=(",", ":"),
 * allow_nan=False). A float the caller holds as a float must be a PyFloat (or it goes out
 * as an integer); a NaN or infinity throws ValueError before anything is sent, as httpx
 * does — not a TransportError.
 */
export function httpxBody(json) {
  return json === undefined ? undefined : pyJson(json, { separators: [",", ":"], ensureAscii: false, allowNan: false });
}

/**
 * httpx `client.request(...)` on a non-streamed response: the request AND the whole body
 * read, so a transport failure anywhere is a TransportError. → `{status, text, json()}`
 * (`json()` throws SyntaxError — json.JSONDecodeError — on a bad body).
 */
export async function httpxRequest(method, url, { json, headers, timeout }) {
  const body = httpxBody(json);
  let r;
  let text;
  try {
    r = await http.fetch(url, {
      method,
      headers,
      body,
      dispatcher: agentFor(timeout),
    });
    text = await r.text();
  } catch (e) {
    throw new TransportError(transportText(e), { cause: e });
  }
  return { status: r.status, text, json: () => JSON.parse(text) };
}

/** httpx `client.stream(...)`: the response with its body unread (`.status`, `.body`).
 * A transport failure is a TransportError. */
export async function httpxStream(method, url, { json, headers, timeout }) {
  const body = httpxBody(json);
  try {
    return await http.fetch(url, {
      method,
      headers,
      body,
      dispatcher: agentFor(timeout),
    });
  } catch (e) {
    throw new TransportError(transportText(e), { cause: e });
  }
}

// httpx's Response.iter_lines() is str.splitlines() applied incrementally — it breaks on
// \n \r \r\n AND \v \f \x1c \x1d \x1e \x85 U+2028 U+2029. A JSON string carries U+2028 /
// U+2029 / U+0085 unescaped, so an SSE `data:` line holding one is CUT in two there: the
// first half fails json.loads and the second doesn't start with "data:" — Python silently
// drops that chunk. Copied as-is (same answers); reported as a Python bug: an SSE reader
// should break on \n / \r / \r\n only.
const NEWLINE_CHARS = "\n\r\x0b\x0c\x1c\x1d\x1e\x85  ";

/** httpx._decoders.LineDecoder, line for line. */
class LineDecoder {
  buffer = [];
  trailingCr = false;

  decode(input) {
    let text = input;
    if (this.trailingCr) {
      text = `\r${text}`;
      this.trailingCr = false;
    }
    if (text.endsWith("\r")) {
      this.trailingCr = true;
      text = text.slice(0, -1);
    }
    if (!text) return [];
    const trailingNewline = NEWLINE_CHARS.includes(text[text.length - 1]);
    let lines = splitlines(text);
    if (lines.length === 1 && !trailingNewline) {
      this.buffer.push(lines[0]);
      return [];
    }
    if (this.buffer.length) {
      lines = [this.buffer.join("") + lines[0], ...lines.slice(1)];
      this.buffer = [];
    }
    if (!trailingNewline) this.buffer = [lines.pop()];
    return lines;
  }

  flush() {
    if (!this.buffer.length && !this.trailingCr) return [];
    const lines = [this.buffer.join("")];
    this.buffer = [];
    this.trailingCr = false;
    return lines;
  }
}

/**
 * httpx `response.iter_lines()` over a fetch body: UTF-8 with replacement (httpx's default
 * for a response with no charset), lines split as above. Leaving early (a `break`, an
 * error) cancels the body — the `with client.stream(...)` exit.
 */
export async function* iterLines(body) {
  if (!body) return;
  const decoder = new TextDecoder("utf-8");
  const ld = new LineDecoder();
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw new TransportError(transportText(e), { cause: e });
      }
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      if (text) yield* ld.decode(text);
    }
    const tail = decoder.decode();
    if (tail) yield* ld.decode(tail);
    yield* ld.flush();
    finished = true;
  } finally {
    if (!finished) reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}
