// SPDX-License-Identifier: MIT
// CSRF hardening — reject cross-site browser requests to the mutating API (the port of
// llm_runner/platform/csrf.py; the Starlette middleware becomes a Hono middleware on the
// app).
//
// THE family implementation (P2 of the target tree, 2026-08-08; JustWrite's original is
// the donor, and its deciding factor was the user's "prefer not locking anyone out, do
// the vector directly"). The servers are localhost sidecars; the real CSRF threat is a
// page in the user's OTHER browser tab POSTing to 127.0.0.1:<port>. A MUTATING `/v1`
// request whose `Origin` marks it cross-site is rejected UNLESS the origin is the app's
// own. No token, so it can never lock a user out; the only failure mode is a missing app
// origin blocking the app itself — which each app's smoke catches immediately.
//
// Allowed: no `Origin` (non-browser clients) · SAME-ORIGIN, derived per request (the
// server-hosted UI — browsers DO send Origin on same-origin mutations; JW hit that
// 2026-07-15) · the shared Tauri and Capacitor (phone) origins + the app's own `appOrigins` (its dev server) ·
// `extraOrigins`/`originRegex` (an app's CORS allowlist, reused — ONE allowlist, never a
// second list) · any non-mutating method. Rejected: everything else, 403 problem+json.
//
// Wiring: `app.use("*", csrfOrigin({appOrigins, extraOrigins, originRegex, typeBase,
// prefixes}))` on the app, before its routes and BEFORE the auth middleware (it was the
// outermost middleware).
// `prefixes`: the paths guarded, `["/v1"]` by default — an app that guards more names them all
// (2026-10-08 — JustVoice: `["/v1", "/mcp"]`), as for the auth middleware.

import { requestPath, sendProblem } from "./auth.js";

// The packaged Tauri webview origins — identical for every app in the family. (A webview
// that routes through the Tauri HTTP plugin sends no Origin at all; one that fetches
// directly — docgen — sends these.)
export const TAURI_ORIGINS = Object.freeze(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

// The phone app's webview origins (Capacitor: Android serves the page from https://localhost, iOS
// from capacitor://localhost) — identical for every app in the family. A phone syncing with a
// laptop's server, or using it directly, sends these (2026-10-08, the sync product: the kit's
// docs/plans/2026-10-08-sync-product-design.md). Its requests also carry the bearer token.
export const CAPACITOR_ORIGINS = Object.freeze(["https://localhost", "capacitor://localhost"]);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A Python `re` pattern as a JS RegExp that, like `re.match`, anchors at the start only
 * (sticky). The few Python-only spellings an origin pattern could use are translated. */
function pyMatcher(pattern) {
  const src = pattern
    .replace(/\(\?P</g, "(?<")
    .replace(/\(\?P=(\w+)\)/g, "\\k<$1>")
    .replace(/\\A/g, "^")
    .replace(/\\Z/g, "$(?![\\s\\S])");
  const re = new RegExp(src, "y");
  return (s) => {
    re.lastIndex = 0;
    return re.test(s);
  };
}

/** The server's OWN origin for this request (scheme://host[:port]) — a page we served
 * ourselves. Read from the request so it follows whatever host/port the server runs on. */
function sameOrigin(c) {
  const url = new URL(c.req.url);
  return `${url.protocol.slice(0, -1)}://${c.req.header("host") || url.host}`;
}

/** `app.add_middleware(CsrfOriginMiddleware, …)` → `app.use("*", csrfOrigin({…}))`, added before
 * the routes so it covers every route. */
export function csrfOrigin({ appOrigins = [], extraOrigins = [], originRegex = "", typeBase = "", prefixes = ["/v1"] } = {}) {
  const guarded = (p) => (prefixes || []).some((pre) => p.startsWith(pre));
  const allow = new Set([
    ...TAURI_ORIGINS,
    ...CAPACITOR_ORIGINS,
    ...(appOrigins || []).filter(Boolean),
    ...(extraOrigins || []).filter(Boolean),
  ]);
  const matches = originRegex ? pyMatcher(originRegex) : null;
  const allowed = (c, origin) => allow.has(origin) || origin === sameOrigin(c) || Boolean(matches?.(origin));

  return async function csrfOriginMiddleware(c, next) {
    const p = requestPath(c);
    if (!MUTATING.has(c.req.method) || !guarded(p)) return next();
    const origin = c.req.header("origin");
    if (origin && !allowed(c, origin)) {
      return sendProblem(c, 403, {
        type: `${typeBase}cross-origin`,
        title: "Forbidden",
        status: 403,
        detail: "cross-origin request rejected",
        instance: p,
      });
    }
    return next();
  };
}
