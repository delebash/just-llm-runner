// SPDX-License-Identifier: MIT
// Origin-aware HTTP client for the shared LLM UI.
//
// The host calls configureLlmUi({ baseUrl }) ONCE at boot with its already-
// resolved server base (each app's services/serverApi.js computes it — JW
// :17495, JV :8741, or same-origin when the server hosts the UI). The shared
// views then call request()/requestStream() against the SAME endpoints both
// apps mount (/v1/ai/*, /v1/llm-providers*, /v1/ai-usage). This replaces the
// old per-app ProviderBackend adapter: one client, both apps, no forks — the
// only thing injected is the base URL, not a data layer.

let _base = "";
let _catalogCopy = {};

export function configureLlmUi({ baseUrl, catalogCopy } = {}) {
  _base = (baseUrl || "").replace(/\/$/, "");
  // Host-voiced catalog copy (2026-08-03): the model-slot sentences and section
  // labels were JW's writing words hardcoded — every other app inherited them
  // ("Writes prose, chats, extracts" in a translation tool). Hosts override the
  // tokens they need; defaults (JW's words) live in LuModelCatalog.
  if (catalogCopy !== undefined) _catalogCopy = catalogCopy || {};
}

export function catalogCopyConfig() {
  return _catalogCopy;
}

export function llmUiBase() {
  if (_base) return _base;
  if (typeof window !== "undefined" && window.location) return window.location.origin;
  return "";
}

export function llmUiUrl(path) {
  return `${llmUiBase()}${path}`;
}

// Post-write notification: caches over kit reads (useResolvedRoute's chip
// cache) subscribe here to hear about every SUCCESSFUL non-GET `request()`.
// The chip-staleness bug (user, 2026-07-10: Quick Setup ran, chips kept
// saying "Not set up") was a forgot-to-wire bug — invalidateRoutes existed
// with zero callers — so invalidation now rides the transport seam every
// writer already uses instead of per-writer calls that can drift. The client
// stays semantics-free: it reports (path, method); subscribers own which
// paths matter.
const writeListeners = new Set();
export function onRequestWrite(fn) {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

// A failed response → the Error surfaces the HUMAN reason, not the wire JSON.
// FastAPI bodies are {"detail": "..."} — panes were rendering that raw (seen live
// 2026-08-04 in the Workbench's fallback: `HTTP 400 — {"detail":"…—…"}`).
// The status prefix stays (a caller keys on "501"); non-string details (the 409
// needsSetup dict) and non-JSON bodies pass through raw. The console log keeps
// the full raw text — this only changes what users read.
function httpError(status, raw) {
  let human = raw;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.detail === "string") human = j.detail;
    // FastAPI 422s ship detail as an ARRAY of {loc, msg} — join the messages
    // (2026-08-05: those still rendered as raw JSON).
    else if (j && Array.isArray(j.detail)) {
      human = j.detail.map((d) => d?.msg || JSON.stringify(d)).join("; ");
    }
  } catch { /* not JSON — the raw text IS the message */ }
  return new Error(`HTTP ${status}${human ? ` — ${human}` : ""}`);
}

export async function request(path, { method = "GET", body, headers, signal } = {}) {
  const opts = { method, headers: { ...(headers || {}) } };
  if (signal) opts.signal = signal;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(llmUiUrl(path), opts);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Central client-side log: every failed request is recorded ONCE here, so a
    // caller's catch→toast can't be the only trace (2026-07-17 — a swallowed 422 on
    // a preset PUT was invisible until we added this + the server-side log). console
    // is the browser's own logger — no framework reinvented.
    console.error(`[llm-ui] ${method} ${path} -> HTTP ${res.status}`, detail?.slice?.(0, 500) || "");
    throw httpError(res.status, detail);
  }
  if (method !== "GET") {
    for (const fn of writeListeners) {
      try { fn(path, method); } catch {}
    }
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/** Fetch a binary response as a Blob (e.g. the backup ZIP download). */
export async function requestBlob(path, { method = "GET", body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(llmUiUrl(path), opts);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw httpError(res.status, detail);
  }
  return res.blob();
}

/** POST multipart/form-data (e.g. a backup ZIP upload); returns parsed JSON. */
export async function postForm(path, formData) {
  const res = await fetch(llmUiUrl(path), { method: "POST", body: formData });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw httpError(res.status, detail);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/**
 * POST and consume a Server-Sent-Events stream (the /v1/ai/stream shape:
 * `data: {"delta": "..."}` per chunk, optional `data: {"progress": 0..1}`
 * prompt-eval frames before the first token (builtin engine only — §7.4 B6-2),
 * a final `data: {"done": true, ...}`, then `data: [DONE]`; errors as
 * `data: {"error": "..."}`).
 *
 * Calls onDelta(text) per chunk, onProgress(p) per progress frame, and
 * resolves with the final { promptTokens, completionTokens, model, cost }
 * from the done frame — or null when the stream ended without one (callers
 * surface usage to the UI and must be able to tell "not reported" from a real
 * zero count). Throws on an error frame. Pass { signal } to make the stream
 * abortable (the AI task queue's cancel).
 */
export async function requestStream(path, body, onDelta, { signal, onProgress } = {}) {
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (signal) opts.signal = signal;
  const res = await fetch(llmUiUrl(path), opts);
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw httpError(res.status, detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return usage;
      let frame;
      try {
        frame = JSON.parse(payload);
      } catch {
        continue;
      }
      if (frame.error) {
        // In-stream provider error — NOT a transport failure. Tagged so the
        // §7.4 automatic fallback never retries it via /run (the provider
        // would return the identical error on both paths).
        const e = new Error(frame.error);
        e.streamErrorFrame = true;
        throw e;
      }
      if (frame.done) {
        usage = {
          promptTokens: frame.promptTokens || 0,
          completionTokens: frame.completionTokens || 0,
          model: frame.model || "",
          cost: frame.cost || 0,
        };
      } else if (frame.delta) {
        onDelta?.(frame.delta);
      } else if (typeof frame.progress === "number") {
        onProgress?.(frame.progress);
      }
    }
  }
  return usage;
}
