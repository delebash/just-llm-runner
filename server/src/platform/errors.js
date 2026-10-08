// SPDX-License-Identifier: MIT
// RFC 7807 problem-details errors — THE family implementation (the port of
// llm_runner/platform/errors.py; every answer keeps the Python server's shape, so the
// renderer and the route diff see no difference).
//
// Three kinds of error reach a client, as in Python:
//   - ApiError (slug + title + optional extension members) → problem+json;
//   - a plain HttpError (FastAPI's HTTPException) → problem+json with a slug taken from
//     the status;
//   - a request that fails validation → 422 problem+json carrying `errors: [{loc, msg,
//     type}]` in pydantic's words.
// Every handled error is logged, its level scaled to the status (4xx warn, 5xx error).
// A route nobody serves answers FastAPI's own `{"detail": "Not Found"}` (that one never
// reached Python's handlers either), and an unhandled exception answers 500
// `Internal Server Error` as plain text, as Starlette does.

import { getLogger } from "./log.js";

/** FastAPI's HTTPException: a status and a detail (any JSON value). */
export class HttpError extends Error {
  constructor(statusCode, detail = null, headers = null) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.statusCode = statusCode;
    this.detail = detail;
    this.headers = headers;
  }
}

/** An HttpError carrying the slug + title for the problem `type`, plus `extra` members. */
export class ApiError extends HttpError {
  constructor(statusCode, slug, title, detail, extra = null) {
    super(statusCode, detail);
    this.slug = slug;
    this.title = title;
    this.extra = { ...(extra || {}) };
  }
}

/** A request that failed validation — pydantic-shaped `errors` ([{loc, msg, type}]). */
export class RequestValidationError extends Error {
  constructor(errors) {
    super("Request validation failed");
    this.errors = errors;
  }
}

export const badRequest = (detail) => new ApiError(400, "bad-request", "Bad Request", detail);
export const unauthorized = (detail = "Authentication required") =>
  new ApiError(401, "unauthorized", "Unauthorized", detail);
export const forbidden = (detail = "Token not accepted") => new ApiError(403, "forbidden", "Forbidden", detail);
export const notFound = (detail) => new ApiError(404, "not-found", "Not Found", detail);
export const conflict = (detail) => new ApiError(409, "conflict", "Conflict", detail);
export const notImplemented = (detail) => new ApiError(501, "not-implemented", "Not Implemented", detail);
export const serviceUnavailable = (detail) =>
  new ApiError(503, "service-unavailable", "Service Unavailable", detail);
export const internal = (detail = "An internal error occurred. See server logs for details.") =>
  new ApiError(500, "internal", "Internal Server Error", detail);

const HTTP_SLUGS = {
  404: ["not-found", "Not Found"],
  400: ["bad-request", "Bad Request"],
  401: ["unauthorized", "Unauthorized"],
  403: ["forbidden", "Forbidden"],
  422: ["validation-error", "Validation Error"],
};

/** Python's str() of a detail, for the plain-HTTPException body and the log. */
function pyStr(detail) {
  if (typeof detail === "string") return detail;
  if (detail == null) return "None";
  return JSON.stringify(detail);
}

// The kit's own log (the ring and the day file are its sinks), as Python's
// `logging.getLogger(__name__)` — Fastify's request logger is off by default.
const log = getLogger("llm_runner.platform.errors");

/** The request's path as Starlette's `request.url.path` gives it: decoded, no query. */
function requestPath(request) {
  const raw = request.url.split("?")[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function logError(request, status, detail) {
  const line = `${request.method} ${requestPath(request)} -> ${status}: ${pyStr(detail).slice(0, 500)}`;
  if (status >= 500) log.error(line);
  else log.warn(line);
}

function jsonableErrors(errors) {
  return (errors || []).map((e) => ({
    loc: (e.loc || []).map((p) => String(p)),
    msg: String(e.msg || ""),
    type: String(e.type || ""),
  }));
}

// ── ajv (Fastify's validator) errors in pydantic's words ─────────────────────
const LOC_ROOT = { body: "body", querystring: "query", params: "path", headers: "header" };

function typeMessage(want, data) {
  const t = Array.isArray(want) ? want.filter((x) => x !== "null")[0] : want;
  const isStr = typeof data === "string";
  switch (t) {
    case "integer":
      if (isStr) return ["Input should be a valid integer, unable to parse string as an integer", "int_parsing"];
      if (typeof data === "number") return ["Input should be a valid integer, got a number with a fractional part", "int_from_float"];
      return ["Input should be a valid integer", "int_type"];
    case "number":
      if (isStr) return ["Input should be a valid number, unable to parse string as a number", "float_parsing"];
      return ["Input should be a valid number", "float_type"];
    case "string":
      return ["Input should be a valid string", "string_type"];
    case "boolean":
      if (isStr) return ["Input should be a valid boolean, unable to interpret input", "bool_parsing"];
      return ["Input should be a valid boolean", "bool_type"];
    case "array":
      return ["Input should be a valid list", "list_type"];
    case "object":
      return ["Input should be a valid dictionary or object to extract fields from", "model_attributes_type"];
    case "null":
      return ["Input should be None", "none_required"];
    default:
      return [`Input should be a valid ${t}`, `${t}_type`];
  }
}

/** One ajv error → pydantic's {loc, msg, type}. `root` is the request part. */
export function ajvToPydantic(err, root, data) {
  const path = (err.instancePath || "")
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const loc = [root, ...path];
  let value = data;
  for (const p of path) value = value == null ? undefined : value[p];
  switch (err.keyword) {
    case "required":
      return { loc: [...loc, err.params.missingProperty], msg: "Field required", type: "missing" };
    case "additionalProperties":
      return { loc: [...loc, err.params.additionalProperty], msg: "Extra inputs are not permitted", type: "extra_forbidden" };
    case "type": {
      // A free-form dict (a record) isn't a model: pydantic words that one "dictionary".
      const ps = err.parentSchema;
      if (err.params.type === "object" && ps?.patternProperties && !ps.properties) {
        return { loc, msg: "Input should be a valid dictionary", type: "dict_type" };
      }
      const [msg, type] = typeMessage(err.params.type, value);
      return { loc, msg, type };
    }
    case "enum": {
      const opts = (err.params.allowedValues || []).map((v) => (typeof v === "string" ? `'${v}'` : String(v)));
      const said = opts.length > 1 ? `${opts.slice(0, -1).join(", ")} or ${opts[opts.length - 1]}` : opts[0];
      return { loc, msg: `Input should be ${said}`, type: "literal_error" };
    }
    case "const":
      return { loc, msg: `Input should be ${JSON.stringify(err.params.allowedValue)}`, type: "literal_error" };
    case "minimum":
    case "exclusiveMinimum": {
      const word = err.keyword === "minimum" ? "greater than or equal to" : "greater than";
      return { loc, msg: `Input should be ${word} ${err.params.limit}`, type: err.keyword === "minimum" ? "greater_than_equal" : "greater_than" };
    }
    case "maximum":
    case "exclusiveMaximum": {
      const word = err.keyword === "maximum" ? "less than or equal to" : "less than";
      return { loc, msg: `Input should be ${word} ${err.params.limit}`, type: err.keyword === "maximum" ? "less_than_equal" : "less_than" };
    }
    case "minLength":
      return { loc, msg: `String should have at least ${err.params.limit} character${err.params.limit === 1 ? "" : "s"}`, type: "string_too_short" };
    case "maxLength":
      return { loc, msg: `String should have at most ${err.params.limit} character${err.params.limit === 1 ? "" : "s"}`, type: "string_too_long" };
    case "minItems":
      return { loc, msg: `List should have at least ${err.params.limit} item${err.params.limit === 1 ? "" : "s"} after validation`, type: "too_short" };
    case "maxItems":
      return { loc, msg: `List should have at most ${err.params.limit} item${err.params.limit === 1 ? "" : "s"} after validation`, type: "too_long" };
    case "pattern":
      return { loc, msg: `String should match pattern '${err.params.pattern}'`, type: "string_pattern_mismatch" };
    default:
      return { loc, msg: err.message || "Invalid input", type: err.keyword || "value_error" };
  }
}

function validationErrors(err, request) {
  const root = LOC_ROOT[err.validationContext] || err.validationContext || "body";
  const data =
    root === "body" ? request.body : root === "query" ? request.query : root === "path" ? request.params : request.headers;
  // A missing body FastAPI reports as one error at ["body"].
  if (root === "body" && (request.body === undefined || request.body === null)) {
    return [{ loc: ["body"], msg: "Field required", type: "missing" }];
  }
  const out = [];
  const seen = new Set();
  for (const e of err.validation || []) {
    // A union reports each branch's failure; pydantic reports the first.
    if (e.keyword === "anyOf" || e.keyword === "oneOf") continue;
    // A nullable field (`X | None`) whose value isn't null and fails X: ajv also reports the
    // null branch's "must be null"; pydantic reports only X's error.
    if (e.keyword === "type" && e.params?.type === "null") {
      let value = data;
      for (const p of (e.instancePath || "").split("/").slice(1)) value = value == null ? undefined : value[p];
      if (value !== null) continue;
    }
    const p = ajvToPydantic(e, root, data);
    const key = JSON.stringify(p.loc);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return byDeclarationOrder(out, request, root);
}

// pydantic validates a model's fields in declaration order and reports each failure as it goes;
// ajv reports every `required` miss before the per-field errors. So `{"name": 5}` against
// (name: str, data: str) came out [data missing, name type] where Python says [name, data]
// (found by JustWrite's port, 2026-10-08). Each error is sorted by its field's position in the
// route's schema — `model()` keeps properties in declaration order — and the sort is stable.
const SCHEMA_KEY = { body: ["body"], query: ["querystring", "query"], path: ["params"], header: ["headers"] };

function byDeclarationOrder(errors, request, root) {
  const schemas = request.routeOptions?.schema || {};
  const schema = (SCHEMA_KEY[root] || [root]).map((k) => schemas[k]).find(Boolean);
  if (!schema || errors.length < 2) return errors;
  const rank = (loc) => {
    const key = [];
    let s = schema;
    for (const part of loc.slice(1)) {
      if (typeof part === "number") {
        key.push(part);
        s = s?.items;
      } else if (s?.properties) {
        const names = Object.keys(s.properties);
        const i = names.indexOf(part);
        key.push(i < 0 ? names.length : i);
        s = s.properties[part];
      } else {
        key.push(Number.MAX_SAFE_INTEGER);
        s = null;
      }
    }
    return key;
  };
  const ranked = errors.map((e, i) => ({ e, i, key: rank(e.loc) }));
  ranked.sort((x, y) => {
    for (let k = 0; k < Math.min(x.key.length, y.key.length); k++) if (x.key[k] !== y.key[k]) return x.key[k] - y.key[k];
    return x.key.length - y.key.length || x.i - y.i;
  });
  return ranked.map((r) => r.e);
}

function problem(reply, status, body) {
  return reply.code(status).type("application/problem+json").send(body);
}

/**
 * Register the problem+json handlers on `app` (the port of `install_error_handlers`).
 * `typeBase` is the app's problem-type URL prefix — the ONLY per-app datum.
 */
export function installErrorHandlers(app, { typeBase, onUnhandled = null }) {
  app.setErrorHandler((err, request, reply) => {
    const instance = requestPath(request);
    if (err instanceof ApiError) {
      logError(request, err.statusCode, err.detail);
      const body = {
        type: `${typeBase}${err.slug}`,
        title: err.title,
        status: err.statusCode,
        detail: err.detail,
        instance,
      };
      for (const [k, v] of Object.entries(err.extra || {})) if (!(k in body)) body[k] = v;
      return problem(reply, err.statusCode, body);
    }
    if (err instanceof HttpError) {
      const [slug, title] = HTTP_SLUGS[err.statusCode] || ["error", "Error"];
      logError(request, err.statusCode, err.detail);
      if (err.headers) reply.headers(err.headers);
      return problem(reply, err.statusCode, {
        type: `${typeBase}${slug}`,
        title,
        status: err.statusCode,
        detail: pyStr(err.detail),
        instance,
      });
    }
    let errors = null;
    if (err instanceof RequestValidationError) errors = err.errors;
    else if (err.validation) errors = validationErrors(err, request);
    else if (err.code === "FST_ERR_CTP_INVALID_JSON_BODY" || err.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      // FastAPI's location is the decoder's character position; V8 names it when it can.
      errors = [{ loc: ["body", err.jsonPos ?? 0], msg: "JSON decode error", type: "json_invalid" }];
    }
    if (errors) {
      logError(request, 422, JSON.stringify(errors));
      return problem(reply, 422, {
        type: `${typeBase}validation-error`,
        title: "Validation Error",
        status: 422,
        detail: "Request body failed validation.",
        errors: jsonableErrors(errors),
        instance,
      });
    }
    if (err.statusCode && err.statusCode < 500) {
      // Fastify's own refusals (413 body too large, 415 media type, …): FastAPI would
      // answer these as {"detail": …} too.
      logError(request, err.statusCode, err.message);
      return reply.code(err.statusCode).send({ detail: err.message });
    }
    log.error(`${request.method} ${instance} -> 500: unhandled`, err);
    if (onUnhandled) return onUnhandled(err, request, reply);
    return reply.code(500).type("text/plain; charset=utf-8").send("Internal Server Error");
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ detail: "Not Found" }));
}

// ── FastAPI's DEFAULT error answers (an app that never called install_error_handlers) ──
// docgen's server answers these (measured by the route diff, 2026-10-07): an HTTPException
// (the kit's ApiError included — it subclasses it) as {"detail": …}, a validation failure as
// 422 {"detail": [{type, loc, msg, input, ctx?}]} — pydantic's own error dicts — and nothing
// logged.

/** pydantic's `ctx` for an ajv constraint error. */
function pydanticCtx(err) {
  const lim = err.params?.limit;
  switch (err.keyword) {
    case "minimum":
      return { ge: lim };
    case "exclusiveMinimum":
      return { gt: lim };
    case "maximum":
      return { le: lim };
    case "exclusiveMaximum":
      return { lt: lim };
    case "minLength":
      return { min_length: lim };
    case "maxLength":
      return { max_length: lim };
    case "pattern":
      return { pattern: err.params.pattern };
    default:
      return null;
  }
}

/** pydantic's error dict: {type, loc, msg, input, ctx?}. */
function fastapiError(err, root, data) {
  const p = ajvToPydantic(err, root, data);
  const path = (err.instancePath || "")
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let value = data;
  for (const s of path) value = value == null ? undefined : value[s];
  // A missing body field's input is the object it was missing from; a missing query or
  // path parameter's is None.
  const input = err.keyword === "required" ? (root === "body" ? (value ?? null) : null) : (value ?? null);
  const out = { type: p.type, loc: p.loc, msg: p.msg, input };
  const ctx = pydanticCtx(err);
  if (ctx) out.ctx = ctx;
  return out;
}

/** Python's json module's words for a decode error, from V8's. */
function pyJsonErrorText(message) {
  const m = String(message || "");
  if (/Expected property name/.test(m)) return "Expecting property name enclosed in double quotes";
  if (/Expected ',' or '}'/.test(m)) return "Expecting ',' delimiter";
  if (/Expected ',' or ']'/.test(m)) return "Expecting ',' delimiter";
  if (/Expected ':'/.test(m)) return "Expecting ':' delimiter";
  if (/Unterminated string/.test(m)) return "Unterminated string starting at";
  if (/non-whitespace character after JSON/.test(m)) return "Extra data";
  return "Expecting value";
}

/** Register FastAPI's default handlers (no problem+json) on `app`. */
export function installFastapiErrorHandlers(app, { onUnhandled = null } = {}) {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof HttpError) {
      if (err.headers) reply.headers(err.headers);
      return reply.code(err.statusCode).send({ detail: err.detail });
    }
    let errors = null;
    if (err instanceof RequestValidationError) {
      errors = err.errors.map((e) => ({ type: e.type, loc: e.loc, msg: e.msg, input: e.input ?? null, ...(e.ctx ? { ctx: e.ctx } : {}) }));
    } else if (err.validation) {
      const root = LOC_ROOT[err.validationContext] || err.validationContext || "body";
      const data =
        root === "body" ? request.body : root === "query" ? request.query : root === "path" ? request.params : request.headers;
      if (root === "body" && (request.body === undefined || request.body === null)) {
        errors = [{ type: "missing", loc: ["body"], msg: "Field required", input: null }];
      } else {
        const seen = new Set();
        errors = [];
        for (const e of err.validation) {
          if (e.keyword === "anyOf" || e.keyword === "oneOf") continue;
          if (e.keyword === "type" && e.params?.type === "null") {
            let v = data;
            for (const p of (e.instancePath || "").split("/").slice(1)) v = v == null ? undefined : v[p];
            if (v !== null) continue;
          }
          const fe = fastapiError(e, root, data);
          const key = JSON.stringify(fe.loc);
          if (seen.has(key)) continue;
          seen.add(key);
          errors.push(fe);
        }
      }
    } else if (err.code === "FST_ERR_CTP_INVALID_JSON_BODY" || err.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      errors = [
        {
          type: "json_invalid",
          loc: ["body", err.jsonPos ?? 0],
          msg: "JSON decode error",
          input: {},
          ctx: { error: pyJsonErrorText(err.message) },
        },
      ];
    }
    if (errors) return reply.code(422).send({ detail: errors });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ detail: err.message });
    log.error(`${request.method} ${requestPath(request)} -> 500: unhandled`, err);
    if (onUnhandled) return onUnhandled(err, request, reply);
    return reply.code(500).type("text/plain; charset=utf-8").send("Internal Server Error");
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ detail: "Not Found" }));
}
