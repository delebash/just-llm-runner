// SPDX-License-Identifier: MIT
// Shared server transport — the single fetch layer for the FastAPI server both
// apps run. App standard: serverUrl() + request/safeRequest/postForm
// + verbs (get/post/patch/put/del), in-flight GET dedupe, a reactive lastError,
// and a boot-time checkServer(). App-agnostic: the host calls
//   configureServerApi({ resolveBase, authToken })
// once at boot — resolveBase yields the origin-aware base (build one with
// makeOriginAwareResolver), authToken (optional) yields a Bearer token
// (JustVoice authenticates; JustWrite doesn't). Supersedes the per-app
// services/serverApi.js (JV's full transport; JW's resolver-only stub + its ~17
// scattered hand-rolled fetch helpers) and services/connection.js.

import { ref } from "vue";

// Reactive so views binding `api.lastError` update. Shared instance: the app's
// `api` store re-exposes this same ref.
export const lastError = ref("");

const _cfg = {
  // Safe default: same-origin. Hosts override via configureServerApi() at boot.
  resolveBase: () => (typeof window !== "undefined" && window.location ? window.location.origin : ""),
  authToken: () => "",
};

export function configureServerApi({ resolveBase, authToken } = {}) {
  if (resolveBase) _cfg.resolveBase = resolveBase;
  if (authToken) _cfg.authToken = authToken;
}

// Origin-aware base resolver factory — shared machinery; only the per-app dev
// ports + loopback fallback differ. Returns the page origin when the server
// hosts the UI (same-origin, no CORS); otherwise (Vite dev / Tauri webview) the
// fallback. The host reads its own VITE_SERVER_URL (statically) and passes the
// resolved value as `fallback`.
export function makeOriginAwareResolver({ devPorts = [], fallback = "" } = {}) {
  return function resolveBase() {
    if (typeof window === "undefined" || !window.location) return fallback;
    const { protocol, origin, port, hostname } = window.location;
    const isDev = devPorts.includes(port);
    const isTauri = protocol === "tauri:" || hostname === "tauri.localhost";
    if (!isDev && !isTauri && (protocol === "http:" || protocol === "https:")) return origin;
    return fallback;
  };
}

function authHeaders(extra) {
  const headers = { ...(extra || {}) };
  const tok = _cfg.authToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  return headers;
}

export function serverUrl(path) {
  return _cfg.resolveBase().replace(/\/$/, "") + path;
}
export const url = serverUrl; // JustVoice's name for the same fn

async function _doRequest(path, opts) {
  const headers = authHeaders(opts.headers);
  try {
    const res = await fetch(serverUrl(path), { ...opts, headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.startsWith("audio/")) return await res.blob();
    if (ct.includes("json")) return await res.json();
    return await res.text();
  } catch (e) {
    lastError.value = String(e.message || e);
    throw e;
  }
}

// In-flight GET dedupe. Boot fires several stores/components fetching the same
// endpoint in the same tick; collapse concurrent identical GETs onto one
// in-flight promise (GETs are idempotent), cleared when it settles. Non-GETs
// untouched.
const _inflight = new Map();

export function request(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET") return _doRequest(path, opts);
  const key = serverUrl(path);
  const hit = _inflight.get(key);
  if (hit) return hit;
  const p = _doRequest(path, opts);
  _inflight.set(key, p);
  const clear = () => _inflight.delete(key);
  p.then(clear, clear);
  return p;
}

// Convenience verbs. Path is always the FIRST arg.
export function get(path, opts = {}) {
  return request(path, { ...opts, method: "GET" });
}
export function post(path, body, opts = {}) {
  return request(path, {
    ...opts,
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
export function patch(path, body, opts = {}) {
  return request(path, {
    ...opts,
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
export function put(path, body, opts = {}) {
  return request(path, {
    ...opts,
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
export function del(path, opts = {}) {
  return request(path, { ...opts, method: "DELETE" });
}

// requestBlob lives in client.js (path-first — THE public `@delebash/llm-ui` export,
// index.js:14). Do NOT re-add a method-first requestBlob here: the old one was dead +
// shadowed by the client.js export and its wrong arg order caused real bugs (unified 2026-07-12).
// NOTE for the JV integration: the surviving client.js requestBlob/postForm are AUTH-FREE;
// serverApi's authHeaders() stays for that later work (JV authenticates on blob downloads).
export async function postForm(path, formData, opts = {}) {
  const headers = authHeaders(opts.headers);
  const res = await fetch(serverUrl(path), { ...opts, method: "POST", headers, body: formData });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return res.json();
  return res.text();
}

// Like request() but swallows errors and returns the fallback. Use in view
// refresh() functions so server-offline doesn't blank the view.
export async function safeRequest(path, fallback = null, opts = {}) {
  try {
    const result = await request(path, opts);
    return result ?? fallback;
  } catch {
    return fallback;
  }
}

// Boot-time reachability check — the renderer is a thin client; with no server
// we must NOT boot (empty stores that silently fail to save). Retries briefly so
// a still-starting server (e.g. the Tauri sidecar) isn't falsely reported down.
export async function checkServer({ tries = 8, delayMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(serverUrl("/v1/health"), { headers: authHeaders(), cache: "no-store" });
      if (res.ok) return true;
    } catch {
      /* server not up yet */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
