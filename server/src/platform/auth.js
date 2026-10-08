// SPDX-License-Identifier: MIT
// Bearer-token authentication — THE family implementation (the port of
// llm_runner/platform/auth.py; Starlette's middleware becomes a Fastify `onRequest` hook
// on the root instance, so it runs before routing as the middleware did — an unknown
// `/v1` path answers 401 before it can answer 404).
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
// Wiring: `app.register(BearerAuthMiddleware, {readAuth, typeBase, loopbackOpenPaths})`
// on the root instance. Starlette ran the LAST-added middleware first; Fastify runs
// onRequest hooks in registration order — so register the outermost first (the apps:
// CSRF, then CORS, then auth).

import { BlockList, isIP } from "node:net";

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
export function requestPath(request) {
  const raw = String(request.raw?.url ?? request.url ?? "").split("?")[0];
  if (!raw.includes("%")) return raw;
  return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => Buffer.from(m.replace(/%/g, ""), "hex").toString("utf8"));
}

/** A problem+json answer sent from a hook (the middleware's own JSONResponse). */
export function sendProblem(reply, status, body) {
  reply.code(status).type("application/problem+json").send(body);
  return reply;
}

/** The onRequest hook itself (for a host that adds hooks by hand). */
export function bearerAuthHook({ readAuth, typeBase, loopbackOpenPaths = [] }) {
  const loopbackOpen = new Set(loopbackOpenPaths || []);
  const problem = (reply, status, slug, title, detail, p) =>
    sendProblem(reply, status, { type: `${typeBase}${slug}`, title, status, detail, instance: p });

  return async function bearerAuth(request, reply) {
    const p = requestPath(request);
    // Only gate the API. UI assets, docs, openapi, and the static mount always pass (so
    // the headless browser can load the app + log in).
    if (!p.startsWith("/v1")) return;

    const [tokens, requireForLoopback] = await readAuth();
    if (!tokens?.length) return;

    const isLoop = isLoopback(request.ip || request.socket?.remoteAddress || "");
    if (isLoop && (p === "/v1/health" || p.startsWith("/v1/server-auth") || loopbackOpen.has(p))) return;
    if (isLoop && !requireForLoopback) return;

    const header = request.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return problem(reply, 401, "unauthorized", "Unauthorized", "Authorization header missing or malformed", p);
    }
    const token = header.slice("Bearer ".length).trim();
    if (!tokens.includes(token)) return problem(reply, 403, "forbidden", "Forbidden", "Bearer token not accepted", p);
  };
}

/** `app.add_middleware(BearerAuthMiddleware, …)` → `app.register(BearerAuthMiddleware, {…})`.
 * Not encapsulated (skip-override), so the hook covers every route and the 404 handler. */
export async function BearerAuthMiddleware(app, opts) {
  app.addHook("onRequest", bearerAuthHook(opts));
}
BearerAuthMiddleware[Symbol.for("skip-override")] = true;
