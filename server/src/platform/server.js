// SPDX-License-Identifier: MIT
// The family's Fastify server, set up to answer like the FastAPI servers it replaces
// wherever a client could tell the difference:
//   - JSON bodies: an empty body is no body (a DELETE with a JSON content type and
//     nothing in it is fine, as in FastAPI); a body with no content type is read as
//     JSON, as FastAPI does;
//   - no practical body limit (FastAPI has none; JustWrite's book import posts a base64
//     zip as JSON — study §3.3);
//   - validation: ajv with every error reported and defaults filled; unknown fields are
//     dropped after it (pydantic's extra="ignore") unless the model forbids them
//     (extra="forbid" → 422); the errors answer as pydantic's 422;
//   - problem+json errors and FastAPI's `{"detail": "Not Found"}` (errors.js).

import Fastify from "fastify";
import { installErrorHandlers } from "./errors.js";
import { clean, laxConvert, shapeRequest } from "./models.js";

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
 * A Fastify instance with the family's parsing, validation and error answers.
 * `typeBase` is the app's problem-type URL prefix; `logger` is passed to Fastify.
 */
export function createServer({ typeBase, logger = false, bodyLimit = BODY_LIMIT, ...rest } = {}) {
  const app = Fastify({
    logger,
    bodyLimit,
    ajv: {
      customOptions: {
        allErrors: true,
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
  installErrorHandlers(app, { typeBase: typeBase ?? "" });
  return app;
}
