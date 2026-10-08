// SPDX-License-Identifier: MIT
// Starlette's CORSMiddleware (starlette 1.3.1, `middleware/cors.py` — the version JustWrite and
// JustVoice ran) as a Fastify `onRequest` hook. Ported in JustWrite's step of the Electron move
// (2026-10-08) and moved here the same day: every family app configures CORS through it —
// JustWrite and JustVoice from their `cors` settings section, docgen allow-all.
//
// Same answers as Starlette:
//   - no `Origin` header → untouched;
//   - a preflight (OPTIONS + Access-Control-Request-Method) → answered here: 200 "OK" or 400
//     "Disallowed CORS origin, method, headers", text/plain, with the preflight headers;
//   - any other request with an Origin → the simple headers are stamped on whatever answer
//     follows (route, auth's 401/403, the error envelope's 500): `*` when every origin is
//     allowed, else the request's own origin + `Vary: Origin` when it is allowed, and
//     `Access-Control-Allow-Credentials: true` when credentials are on (on every answer, as
//     Starlette does, even to an origin it doesn't allow).
// Stamped in onRequest (the headers stay on the reply whatever answers it).
//
// Wiring: `app.register(CorsMiddleware, {allowOrigins, allowOriginRegex, …})` on the root
// instance, AFTER the CSRF hook and BEFORE the auth hook (Starlette ran the last-added
// middleware first: CSRF outermost, then CORS, then auth) — so a CSRF 403 carries no CORS
// headers, and CORS answers preflights before auth sees them.

const ALL_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
const SAFELISTED_HEADERS = ["Accept", "Accept-Language", "Content-Language", "Content-Type"];

/** A Python `re` pattern as a JS RegExp that, like `re.fullmatch`, must match the whole
 * string. The few Python-only spellings an origin pattern could use are translated. */
function pyFullMatcher(pattern) {
  const src = pattern
    .replace(/\(\?P</g, "(?<")
    .replace(/\(\?P=(\w+)\)/g, "\\k<$1>")
    .replace(/\\A/g, "^")
    .replace(/\\Z/g, "$(?![\\s\\S])");
  const re = new RegExp(`^(?:${src})$`);
  return (s) => re.test(s);
}

/** The hook for one configuration (Starlette's `CORSMiddleware.__init__` arguments). */
export function corsHook({
  allowOrigins = [],
  allowMethods = ["GET"],
  allowHeaders = [],
  allowCredentials = false,
  allowOriginRegex = null,
  allowPrivateNetwork = false,
  exposeHeaders = [],
  maxAge = 600,
} = {}) {
  const methods = allowMethods.includes("*") ? ALL_METHODS : [...allowMethods];
  const regex = allowOriginRegex !== null && allowOriginRegex !== undefined ? pyFullMatcher(allowOriginRegex) : null;
  const allowAllOrigins = allowOrigins.includes("*");
  const allowAllHeaders = allowHeaders.includes("*");
  const preflightExplicitAllowOrigin = !allowAllOrigins || allowCredentials;

  const simpleHeaders = {};
  if (allowAllOrigins) simpleHeaders["Access-Control-Allow-Origin"] = "*";
  if (allowCredentials) simpleHeaders["Access-Control-Allow-Credentials"] = "true";
  if (exposeHeaders.length) simpleHeaders["Access-Control-Expose-Headers"] = exposeHeaders.join(", ");

  const preflightHeaders = {};
  // The origin value is set in the preflight answer when it is allowed.
  if (preflightExplicitAllowOrigin) preflightHeaders.Vary = "Origin";
  else preflightHeaders["Access-Control-Allow-Origin"] = "*";
  preflightHeaders["Access-Control-Allow-Methods"] = methods.join(", ");
  preflightHeaders["Access-Control-Max-Age"] = String(maxAge);
  // sorted(SAFELISTED_HEADERS | set(allow_headers)) — Python's str order.
  const headerSet = [...new Set([...SAFELISTED_HEADERS, ...allowHeaders])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (headerSet.length && !allowAllHeaders) preflightHeaders["Access-Control-Allow-Headers"] = headerSet.join(", ");
  if (allowCredentials) preflightHeaders["Access-Control-Allow-Credentials"] = "true";
  const allowedHeaders = headerSet.map((h) => h.toLowerCase());

  const isAllowedOrigin = (origin) => {
    if (allowAllOrigins) return true;
    if (regex?.(origin)) return true;
    return allowOrigins.includes(origin);
  };

  const preflight = (request, reply) => {
    const requestedOrigin = request.headers.origin;
    const requestedMethod = request.headers["access-control-request-method"];
    const requestedHeaders = request.headers["access-control-request-headers"];
    const requestedPrivateNetwork = request.headers["access-control-request-private-network"];
    const headers = { ...preflightHeaders };
    const failures = [];

    if (isAllowedOrigin(requestedOrigin)) {
      if (preflightExplicitAllowOrigin) headers["Access-Control-Allow-Origin"] = requestedOrigin;
    } else failures.push("origin");

    if (!methods.includes(requestedMethod)) failures.push("method");

    // Allow-all headers mirror back whatever was requested.
    if (allowAllHeaders && requestedHeaders !== undefined) {
      headers["Access-Control-Allow-Headers"] = requestedHeaders;
    } else if (requestedHeaders !== undefined) {
      for (const h of requestedHeaders.toLowerCase().split(",")) {
        if (!allowedHeaders.includes(h.trim())) {
          failures.push("headers");
          break;
        }
      }
    }

    if (requestedPrivateNetwork !== undefined) {
      if (allowPrivateNetwork) headers["Access-Control-Allow-Private-Network"] = "true";
      else failures.push("private-network");
    }

    const ok = !failures.length;
    reply
      .code(ok ? 200 : 400)
      .headers(headers)
      .type("text/plain; charset=utf-8")
      .send(ok ? "OK" : `Disallowed CORS ${failures.join(", ")}`);
    return reply;
  };

  return async function cors(request, reply) {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (request.method === "OPTIONS" && request.headers["access-control-request-method"] !== undefined) {
      return preflight(request, reply);
    }
    reply.headers(simpleHeaders);
    // With credentials allowed, the answer names the origin instead of '*'; with specific
    // origins, an allowed Origin is mirrored back.
    if ((allowAllOrigins && allowCredentials) || (!allowAllOrigins && isAllowedOrigin(origin))) {
      reply.header("Access-Control-Allow-Origin", origin);
      const vary = reply.getHeader("vary");
      reply.header("Vary", vary ? `${vary}, Origin` : "Origin");
    }
  };
}

/** `app.add_middleware(CORSMiddleware, …)` → `app.register(CorsMiddleware, {…})`. Not
 * encapsulated (skip-override), so the hook covers every route and the 404 handler. */
export async function CorsMiddleware(app, opts) {
  app.addHook("onRequest", corsHook(opts));
}
CorsMiddleware[Symbol.for("skip-override")] = true;
