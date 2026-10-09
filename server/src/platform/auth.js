// SPDX-License-Identifier: MIT
// Bearer-token authentication — THE family implementation (the port of
// llm_runner/platform/auth.py; Starlette's middleware becomes a Hono middleware on the app,
// added before the routes, so it runs before routing as the middleware did — an unknown `/v1`
// path answers 401 before it can answer 404).
//
// One policy for every same-stack app (P2 of the target tree, 2026-08-08; the three
// per-app copies died — the 2026-08-05 lockout fix had to be hand-applied three times).
// OFF by default: an empty token list means no auth (the normal local-loopback case).
//   - no tokens                                    → no auth required
//   - tokens + loopback + not requireForLoopback   → loopback bypasses auth
//   - otherwise                                    → every /v1* request needs
//                                                    `Authorization: Bearer <token>`
//
// The per-app seam is `readAuth` — returns `[tokens, requireForLoopback]` from wherever
// that app stores settings. It must never throw for config problems (return `[[], false]`
// instead) so a settings glitch can't lock the user out.
//
// The lockout escape (family shape, 2026-08-05): from the machine itself, `/v1/health`
// and the `/v1/server-auth` door always answer — physical access could edit the DB anyway.
// Remote stays gated. An app may name more such paths (`loopbackOpenPaths`, 2026-09-30):
// JustVoice names its `/v1/shutdown`, which its desktop shell calls with no token — with
// "Require a token even on localhost" on, every close fell back to a hard kill, while any
// program on the machine can end the server process anyway. Empty by default.
//
// Which paths are guarded: `prefixes`, `["/v1"]` (the API) by default. An app that guards more
// names them all (2026-10-08 — JustVoice: `["/v1", "/mcp"]`, its MCP endpoint guarded like its
// API). A prefix matches the start of the path, as `/v1` always did.
//
// Wiring: `app.use("*", bearerAuth({readAuth, typeBase, loopbackOpenPaths}))` on the app,
// before its routes. Starlette ran the LAST-added middleware first; Hono runs middleware in the
// order added — so add the outermost first (the apps: CSRF, then CORS, then auth).

import { BlockList, isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** Python's `_is_loopback`: the literal names, else `ipaddress.ip_address(host).is_loopback`
 * — 127.0.0.0/8, ::1, and (measured on Python 3.12.9) IPv4-mapped ::ffff:127.x.x.x. */
export function isLoopback(host) {
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return true;
  const kind = isIP(host);
  if (!kind) return false;
  try {
    return LOOPBACK.check(host, kind === 6 ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}

/** Starlette's `request.url.path`: the path, percent-decoded (uvicorn's `unquote`).
 * Candidate for platform/ (csrf.js uses it too). */
export function requestPath(c) {
  const raw = new URL(c.req.url).pathname;
  if (!raw.includes("%")) return raw;
  return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => Buffer.from(m.replace(/%/g, ""), "hex").toString("utf8"));
}

/** A problem+json answer sent from a middleware (the middleware's own JSONResponse). */
export function sendProblem(c, status, body) {
  return c.body(JSON.stringify(body), status, { "Content-Type": "application/problem+json" });
}

/** The client's address, as Starlette's `request.client.host` — empty where there is no socket
 * (a request answered inside the app, as on the phone). */
export function clientHost(c) {
  try {
    return getConnInfo(c).remote.address ?? "";
  } catch {
    return "";
  }
}

/** `app.add_middleware(BearerAuthMiddleware, …)` → `app.use("*", bearerAuth({…}))`, added before
 * the routes so it covers every route and the 404 answer. */
export function bearerAuth({ readAuth, typeBase, loopbackOpenPaths = [], prefixes = ["/v1"] }) {
  const loopbackOpen = new Set(loopbackOpenPaths || []);
  const guarded = (p) => (prefixes || []).some((pre) => p.startsWith(pre));
  const problem = (c, status, slug, title, detail, p) =>
    sendProblem(c, status, { type: `${typeBase}${slug}`, title, status, detail, instance: p });

  return async function bearerAuthMiddleware(c, next) {
    const p = requestPath(c);
    // Only gate the API (and an app's own `prefixes`). UI assets, docs, openapi, and the static
    // mount always pass (so the headless browser can load the app + log in).
    if (!guarded(p)) return next();

    const [tokens, requireForLoopback] = await readAuth();
    if (!tokens?.length) return next();

    const isLoop = isLoopback(clientHost(c));
    if (isLoop && (p === "/v1/health" || p.startsWith("/v1/server-auth") || loopbackOpen.has(p))) return next();
    if (isLoop && !requireForLoopback) return next();

    const header = c.req.header("authorization") || "";
    if (!header.startsWith("Bearer ")) {
      return problem(c, 401, "unauthorized", "Unauthorized", "Authorization header missing or malformed", p);
    }
    const token = header.slice("Bearer ".length).trim();
    if (!tokens.includes(token)) return problem(c, 403, "forbidden", "Forbidden", "Bearer token not accepted", p);
    return next();
  };
}
