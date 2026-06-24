// SPDX-License-Identifier: GPL-3.0-or-later
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

export function configureLlmUi({ baseUrl } = {}) {
  _base = (baseUrl || "").replace(/\/$/, "");
}

export function llmUiBase() {
  if (_base) return _base;
  if (typeof window !== "undefined" && window.location) return window.location.origin;
  return "";
}

export function llmUiUrl(path) {
  return `${llmUiBase()}${path}`;
}

export async function request(path, { method = "GET", body, headers } = {}) {
  const opts = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(llmUiUrl(path), opts);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
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
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return res.blob();
}

/** POST multipart/form-data (e.g. a backup ZIP upload); returns parsed JSON. */
export async function postForm(path, formData) {
  const res = await fetch(llmUiUrl(path), { method: "POST", body: formData });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/**
 * POST and consume a Server-Sent-Events stream (the /v1/ai/stream shape:
 * `data: {"delta": "..."}` per chunk, a final `data: {"done": true, ...}`,
 * then `data: [DONE]`; errors as `data: {"error": "..."}`).
 *
 * Calls onDelta(text) per chunk and resolves with the final
 * { promptTokens, completionTokens } when [DONE] arrives. Throws on an error
 * frame.
 */
export async function requestStream(path, body, onDelta) {
  const res = await fetch(llmUiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = { promptTokens: 0, completionTokens: 0 };
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
      if (frame.error) throw new Error(frame.error);
      if (frame.done) {
        usage = { promptTokens: frame.promptTokens || 0, completionTokens: frame.completionTokens || 0 };
      } else if (frame.delta) {
        onDelta?.(frame.delta);
      }
    }
  }
  return usage;
}
