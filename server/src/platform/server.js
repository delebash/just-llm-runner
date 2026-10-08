// SPDX-License-Identifier: MIT
// The family's Fastify server, set up to answer like the FastAPI servers it replaces
// wherever a client could tell the difference:
//   - JSON bodies: an empty body is no body (a DELETE with a JSON content type and
//     nothing in it is fine, as in FastAPI); a body with no content type is read as
//     JSON, as FastAPI does; on request (`pyFloats`), a route that opts in keeps Python's
//     whole-number floats (`1.0`) and every body as sent rides on `req.sentBody`;
//   - no practical body limit (FastAPI has none; JustWrite's book import posts a base64
//     zip as JSON — study §3.3);
//   - validation: ajv with every error reported and defaults filled; unknown fields are
//     dropped after it (pydantic's extra="ignore") unless the model forbids them
//     (extra="forbid" → 422); the errors answer as pydantic's 422;
//   - problem+json errors and FastAPI's `{"detail": "Not Found"}` (errors.js).

import Fastify from "fastify";
import { installErrorHandlers, installFastapiErrorHandlers } from "./errors.js";
import { clean, laxConvert, shapeRequest, unwrapTyped } from "./models.js";
import { pyClone, pyJsonParse } from "./pyjson.js";

const BODY_LIMIT = 1024 * 1024 * 1024; // 1 GiB — "none" in practice, as FastAPI

function parseJsonText(body, done) {
  if (body === "" || body == null) return done(null, undefined);
  try {
    done(null, JSON.parse(body));
  } catch (e) {
    e.statusCode = 400;
    e.code = "FST_ERR_CTP_INVALID_JSON_BODY";
    const m = /at position (\d+)/.exec(e.message);
    if (m) e.jsonPos = Number(m[1]);
    done(e, undefined);
  }
}

/**
 * The request-body float opt-in, on `app` (`createServer({pyFloats})` calls it; a test that
 * serves routers on a bare app calls it to read bodies as the real app does).
 *
 * JSON.parse turns a whole-number float a client sends (`1.0`, `1e3`) into the integer 1, so a
 * free (`Any`) field stored with Python's json.dumps would write `1` where Python wrote `1.0`.
 * A route that OPTS IN — `config: {pyFloats: true}`, or its "METHOD /url" in `routes`, for a
 * router the kit builds (JustVoice: "PATCH /v1/prefs") — reads its body with `pyJsonParse` (a
 * whole-number float literal → a PyFloat) and gets its typed fields' plain numbers back
 * (`unwrapTyped`) before validation; every other route reads plain JSON — a PyFloat reaching
 * code that never expected one (a template's `${x}`) would print "[object Object]". Every
 * route's body as SENT (before defaults fill it) rides on `req.sentBody` — what pydantic's
 * `exclude_unset` reads. JSON errors and empty bodies answer as the default parser's do.
 */
export function installPyFloatBodies(app, { routes = [] } = {}) {
  const named = new Set(routes);
  const optsIn = (req) => req.routeOptions?.config?.pyFloats === true || named.has(`${req.method} ${req.routeOptions?.url ?? ""}`);
  const parseJsonBody = (req, body, done) => {
    if (body === "" || body == null) return done(null, undefined);
    const floats = optsIn(req);
    let v;
    try {
      v = floats ? pyJsonParse(body) : JSON.parse(body);
    } catch (e) {
      e.statusCode = 400;
      e.code = "FST_ERR_CTP_INVALID_JSON_BODY";
      const m = /at position (\d+)/.exec(e.message);
      if (m) e.jsonPos = Number(m[1]);
      return done(e, undefined);
    }
    const schema = req.routeOptions?.schema?.body;
    const typed = floats && schema ? unwrapTyped(schema, v) : v;
    req.sentBody = pyClone(typed);
    done(null, typed);
  };
  app.removeContentTypeParser(/^application\/(.+\+)?json/);
  app.addContentTypeParser(/^application\/(.+\+)?json/, { parseAs: "string" }, parseJsonBody);
  // No content type (or one nobody else claims): FastAPI tries JSON when there is a body.
  app.removeContentTypeParser("*");
  app.addContentTypeParser("*", { parseAs: "string" }, (req, body, done) => {
    if (!req.headers["content-type"]) return parseJsonBody(req, body, done);
    done(null, body === "" ? undefined : body);
  });
}

/**
 * A Fastify instance with the family's parsing, validation and error answers.
 * `errors`: "problem" (the kit's problem+json; `typeBase` is the app's problem-type URL
 * prefix) or "fastapi" (FastAPI's default answers). `logger` is passed to Fastify.
 * `pyFloats`: off by default (plain JSON.parse bodies); `{routes}` turns on the request-body
 * float opt-in (`installPyFloatBodies` above), `routes` naming kit-built routes that opt in.
 */
export function createServer({
  typeBase,
  errors = "problem",
  onUnhandled = null,
  logger = false,
  bodyLimit = BODY_LIMIT,
  pyFloats = null,
  ...rest
} = {}) {
  const app = Fastify({
    logger,
    bodyLimit,
    ajv: {
      customOptions: {
        allErrors: true,
        verbose: true, // errors carry their schema (errors.js tells a dict from a model)
        // No coercion here: ajv's turned null into "" / 0 inside a nullable union. The
        // preValidation hook converts the way pydantic does instead (models.laxConvert).
        coerceTypes: false,
        useDefaults: true,
        // Unknown fields are dropped after validation (the preHandler below), not by
        // ajv: a model that forbids them must still see them and answer 422.
        removeAdditional: false,
        // A default inside a union (`list[Row] | None` with defaulted Row fields) is legal
        // pydantic; ajv's strict mode refuses to compile it. The preHandler fills those.
        strict: false,
      },
    },
    // FastAPI matches `/x` and `/x/` as different routes and redirects; Fastify's
    // default (no redirect, exact match) is the closer of the two.
    ...rest,
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(/^application\/(.+\+)?json/, { parseAs: "string" }, (_req, body, done) =>
    parseJsonText(body, done),
  );
  // No content type (or one nobody else claims): FastAPI tries JSON when there is a body.
  app.addContentTypeParser("*", { parseAs: "string" }, (req, body, done) => {
    if (!req.headers["content-type"]) return parseJsonText(body, done);
    done(null, body === "" ? undefined : body);
  });
  if (pyFloats) installPyFloatBodies(app, pyFloats === true ? {} : pyFloats);
  // A repeated query key: FastAPI takes the LAST value for a scalar parameter (a list
  // parameter collects them all); Fastify's parser hands an array to every key.
  app.addHook("preValidation", async (req) => {
    const props = req.routeOptions?.schema?.querystring?.properties;
    if (!props || !req.query) return;
    for (const [k, v] of Object.entries(req.query)) {
      if (Array.isArray(v) && props[k] && props[k].type !== "array") req.query[k] = v[v.length - 1];
    }
  });
  // pydantic's lax conversion — query strings and path params are text, bodies are JSON.
  app.addHook("preValidation", async (req) => {
    const schema = req.routeOptions?.schema;
    if (!schema) return;
    if (schema.querystring && req.query) req.query = laxConvert(schema.querystring, req.query, { query: true });
    if (schema.params && req.params) req.params = laxConvert(schema.params, req.params, { query: true });
    if (schema.body && req.body !== undefined) req.body = laxConvert(schema.body, req.body);
  });
  // pydantic's extra="ignore": a handler sees only the fields its model declares.
  app.addHook("preHandler", async (req) => {
    const schema = req.routeOptions?.schema;
    if (schema?.body && req.body && typeof req.body === "object") req.body = shapeRequest(schema.body, req.body);
    if (schema?.querystring && req.query) req.query = clean(schema.querystring, req.query);
  });
  // The app's error answers: the kit's problem+json (JustVoice and JustWrite call
  // install_error_handlers) or FastAPI's defaults (docgen never did — measured by the
  // route diff).
  // `onUnhandled(err, request, reply)`: the app's own answer to an unhandled exception (an
  // app's catch-all envelope); default Starlette's plain-text 500.
  if (errors === "fastapi") installFastapiErrorHandlers(app, { onUnhandled });
  else installErrorHandlers(app, { typeBase: typeBase ?? "", onUnhandled });
  return app;
}

/**
 * The `Content-Disposition` value for a download named `filename`. A header carries latin-1
 * only, and a name outside printable ASCII travels as RFC 5987's `filename*=UTF-8''…` beside an
 * ASCII fallback (RFC 6266 §4.3) — a book titled in Japanese failed JustWrite's export with a
 * 500 until 2026-10-08. A plain ASCII name gives `attachment; filename="<name>"`, byte for byte
 * what the routes wrote before.
 */
export function attachment(filename) {
  const name = String(filename);
  const plain = (c) => c >= " " && c <= "~" && c !== '"' && c !== "\\";
  if ([...name].every(plain)) return `attachment; filename="${name}"`;
  const fallback = [...name].map((c) => (plain(c) ? c : "_")).join("");
  // encodeURIComponent leaves ' ( ) * as they are; RFC 5987's attr-char doesn't allow them.
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
