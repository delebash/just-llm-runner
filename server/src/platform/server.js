// SPDX-License-Identifier: MIT
// The family's Hono server, set up to answer like the FastAPI servers it replaces
// wherever a client could tell the difference:
//   - JSON bodies: an empty body is no body (a DELETE with a JSON content type and
//     nothing in it is fine, as in FastAPI); a body with no content type is read as
//     JSON, as FastAPI does; on request (`pyFloats`), a route that opts in keeps Python's
//     whole-number floats (`1.0`) and every body as sent rides on `c.get("sentBody")`;
//   - no practical body limit (FastAPI has none; JustWrite's book import posts a base64
//     zip as JSON — study §3.3);
//   - validation: ajv with every error reported and defaults filled; unknown fields are
//     dropped after it (pydantic's extra="ignore") unless the model forbids them
//     (extra="forbid" → 422); the errors answer as pydantic's 422;
//   - problem+json errors and FastAPI's `{"detail": "Not Found"}` (errors.js).
//
// Hono, not Fastify (since 2026-10-09 — the kit's TASKS, "The family's servers move to Hono";
// docs/plans/2026-10-09-hono-standard.md): a route takes the web-standard Request and returns a
// Response, so the same app answers in Node (`@hono/node-server` — the desktop app and headless,
// serve.js) and in a web worker (`app.fetch` — the phone, worker/runtime.js).
//
// A route declares what it reads with `input({params, body, querystring, headers})` — the
// family's request pipeline as Fastify ran it (lax conversion, then ajv in Fastify's order:
// params, body, querystring, headers; then unknown fields dropped and defaults filled) — and
// reads the result the Hono way: `c.req.valid("param" | "json" | "query" | "header")`.
// A route with no schema reads `c.req.param()` / `c.req.query()` and its JSON body with
// `readJson(c)` (the same body rules).

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Hono } from "hono";
import { routePath } from "hono/route";

// ONE Hono for the family. An app makes its routers with THIS `Hono` (and streams with this
// `stream`), never its own copy: the kit is linked into each app (`file:`), so an app's own
// `hono` would be a second copy, and Hono's `app.route()` recognises a sub-app's default error
// handler by identity (hono-base.js `route()`) — a sub-app from another copy would answer its
// errors with Hono's plain 500s instead of the family's envelopes.
export { Hono };
export { stream } from "hono/streaming";
import {
  InvalidJsonBody,
  installErrorHandlers,
  installFastapiErrorHandlers,
  SchemaValidationError,
} from "./errors.js";
import { clean, laxConvert, shapeRequest, unwrapTyped } from "./models.js";
import { pyClone, pyJsonParse } from "./pyjson.js";

const BODY_LIMIT = 1024 * 1024 * 1024; // 1 GiB — "none" in practice, as FastAPI

// ajv as Fastify set it up for the family: @fastify/ajv-compiler 4.0.6's defaults
// (lib/default-ajv-options.js) under the family's own options, plus ajv-formats as the compiler
// added it.
const FASTIFY_DEFAULTS = { coerceTypes: "array", useDefaults: true, removeAdditional: true, addUsedSchema: false, allErrors: false };
const ajv = new Ajv(
  Object.assign({}, FASTIFY_DEFAULTS, {
    allErrors: true,
    verbose: true, // errors carry their schema (errors.js tells a dict from a model)
    // No coercion here: ajv's turned null into "" / 0 inside a nullable union. `input` converts
    // the way pydantic does first instead (models.laxConvert).
    coerceTypes: false,
    useDefaults: true,
    // Unknown fields are dropped after validation (`clean`), not by ajv: a model that forbids
    // them must still see them and answer 422.
    removeAdditional: false,
    // A default inside a union (`list[Row] | None` with defaulted Row fields) is legal pydantic;
    // ajv's strict mode refuses to compile it. `shapeRequest` fills those.
    strict: false,
  }),
);
addFormats(ajv);

const compiled = new WeakMap();
function validatorFor(schema) {
  let v = compiled.get(schema);
  if (!v) {
    v = ajv.compile(schema);
    compiled.set(schema, v);
  }
  return v;
}

/** A header schema with its field names lowercased, as Fastify compiled one (headers arrive
 * lowercased). */
function lowerHeaders(schema) {
  if (!schema?.properties) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k.toLowerCase(), v])),
    ...(Array.isArray(schema.required) ? { required: schema.required.map((k) => k.toLowerCase()) } : {}),
  };
}
const lowered = new WeakMap();
const headerSchema = (s) => {
  let l = lowered.get(s);
  if (!l) {
    l = lowerHeaders(s);
    lowered.set(s, l);
  }
  return l;
};

// What createServer set for its app — the body limit and the float opt-in — reached by every
// route through the app's first middleware. A bare Hono app (a test serving one router) gets the
// defaults.
const DEFAULTS = Object.freeze({ bodyLimit: BODY_LIMIT, pyFloats: false, pyFloatRoutes: new Set() });
const familyOf = (c) => c.get("family") ?? DEFAULTS;

function familyMiddleware(family) {
  return async function familySettings(c, next) {
    c.set("family", family);
    await next();
  };
}

/**
 * The request-body float opt-in, on `app` (`createServer({pyFloats})` calls it; a test that
 * serves routers on a bare app calls it to read bodies as the real app does). Call it before
 * the routes are added: a Hono middleware covers only the routes added after it.
 *
 * JSON.parse turns a whole-number float a client sends (`1.0`, `1e3`) into the integer 1, so a
 * free (`Any`) field stored with Python's json.dumps would write `1` where Python wrote `1.0`.
 * A route that OPTS IN — `input({…, pyFloats: true})`, or its "METHOD /url" in `routes`, for a
 * router the kit builds (JustVoice: "PATCH /v1/prefs") — reads its body with `pyJsonParse` (a
 * whole-number float literal → a PyFloat) and gets its typed fields' plain numbers back
 * (`unwrapTyped`) before validation; every other route reads plain JSON — a PyFloat reaching
 * code that never expected one (a template's `${x}`) would print "[object Object]". Every
 * route's body as SENT (before defaults fill it) rides on `c.get("sentBody")` — what pydantic's
 * `exclude_unset` reads. JSON errors and empty bodies answer as the default reading does.
 */
export function installPyFloatBodies(app, { routes = [], bodyLimit = BODY_LIMIT } = {}) {
  app.use("*", familyMiddleware({ bodyLimit, pyFloats: true, pyFloatRoutes: new Set(routes) }));
}

const JSON_TYPE = /^application\/(.+\+)?json/;
const NO_BODY = new Set(["GET", "HEAD"]);
const BODY_KEY = Symbol("family.body");

/** The body as Fastify's parsers read it for the family: undefined when there is none. */
async function readBody(c, { schema = null, pyFloats = false } = {}) {
  if (c[BODY_KEY]) return c[BODY_KEY];
  const run = async () => {
    if (NO_BODY.has(c.req.method)) return { value: undefined };
    const family = familyOf(c);
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > family.bodyLimit) {
      throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    }
    const text = await c.req.text();
    if (text.length > family.bodyLimit) {
      throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    }
    const type = c.req.header("content-type");
    // No content type: FastAPI tries JSON when there is a body. Another type nobody claims:
    // the text as it came.
    if (type && !JSON_TYPE.test(type)) return { value: text === "" ? undefined : text };
    if (text === "") return { value: undefined };
    const floats =
      family.pyFloats && (pyFloats || family.pyFloatRoutes.has(`${c.req.method} ${routePath(c)}`));
    let v;
    try {
      v = floats ? pyJsonParse(text) : JSON.parse(text);
    } catch (e) {
      throw new InvalidJsonBody(e);
    }
    const typed = floats && schema ? unwrapTyped(schema, v) : v;
    return { value: typed, sent: family.pyFloats ? pyClone(typed) : undefined };
  };
  c[BODY_KEY] = run();
  return c[BODY_KEY];
}

/**
 * The JSON body of a route with no body schema, read by the family's rules (no content type →
 * JSON, empty → undefined, a JSON error → pydantic's 422). Also sets `c.get("sentBody")`.
 */
export async function readJson(c, { pyFloats = false } = {}) {
  const { value, sent } = await readBody(c, { pyFloats });
  if (sent !== undefined) c.set("sentBody", sent);
  return value;
}

/** Fastify's query object: a repeated key gives an array. */
function queryObject(url) {
  const q = {};
  for (const [k, v] of new URL(url).searchParams) {
    if (!Object.hasOwn(q, k)) q[k] = v;
    else if (Array.isArray(q[k])) q[k].push(v);
    else q[k] = [q[k], v];
  }
  return q;
}

function check(schema, value, part, schemas) {
  if (!schema) return value;
  const validate = validatorFor(schema);
  const holder = { [part]: value === undefined ? null : value };
  const ok = validate(holder[part], { parentData: holder, parentDataProperty: part });
  if (!ok) throw new SchemaValidationError({ validation: validate.errors, validationContext: part, data: value, schemas });
  return value;
}

/**
 * The family's request pipeline for one route, as Fastify ran it: read, convert the way
 * pydantic does, validate with ajv in Fastify's order (params, body, querystring, headers — the
 * first part that fails answers), then drop unknown fields and fill defaults. The route reads the
 * results with `c.req.valid("param" | "json" | "query" | "header")`.
 */
export function input({ params = null, body = null, querystring = null, headers = null, pyFloats = false } = {}) {
  const schemas = { params, body, querystring, headers };
  return async function familyInput(c, next) {
    let p = params ? { ...c.req.param() } : undefined;
    let q = querystring ? queryObject(c.req.url) : undefined;
    const h = headers ? c.req.header() : undefined;
    let b;
    if (body) {
      const read = await readBody(c, { schema: body, pyFloats });
      b = read.value;
      if (read.sent !== undefined) c.set("sentBody", read.sent);
    }
    // A repeated query key: FastAPI takes the LAST value for a scalar parameter (a list
    // parameter collects them all).
    if (q) {
      const props = querystring.properties ?? {};
      for (const [k, v] of Object.entries(q)) {
        if (Array.isArray(v) && props[k] && props[k].type !== "array") q[k] = v[v.length - 1];
      }
      q = laxConvert(querystring, q, { query: true });
    }
    // pydantic's lax conversion — query strings and path params are text, bodies are JSON.
    if (p) p = laxConvert(params, p, { query: true });
    if (body && b !== undefined) b = laxConvert(body, b);
    check(params, p, "params", schemas);
    check(body, b, "body", schemas);
    check(querystring, q, "querystring", schemas);
    check(headers && headerSchema(headers), h, "headers", schemas);
    // pydantic's extra="ignore": a handler sees only the fields its model declares.
    if (body && b && typeof b === "object") b = shapeRequest(body, b);
    if (q) q = clean(querystring, q);
    if (params) c.req.addValidatedData("param", p);
    if (body) c.req.addValidatedData("json", b);
    if (querystring) c.req.addValidatedData("query", q);
    if (headers) c.req.addValidatedData("header", h);
    await next();
  };
}

// ── close hooks (Fastify's onClose: the app's engines stop when the server does) ──────────
const CLOSE_HOOKS = new WeakMap();

/** Run `fn` when the server stops (serve.js) — a router's engines, the database. */
export function onClose(app, fn) {
  if (!CLOSE_HOOKS.has(app)) CLOSE_HOOKS.set(app, []);
  CLOSE_HOOKS.get(app).push(fn);
}

/** Run the app's close hooks, the last added first (as Fastify ran them); every hook runs, and
 * the first failure is thrown after. */
export async function closeApp(app) {
  const hooks = CLOSE_HOOKS.get(app) ?? [];
  CLOSE_HOOKS.delete(app);
  let first = null;
  for (const fn of [...hooks].reverse()) {
    try {
      await fn();
    } catch (e) {
      first ??= e;
    }
  }
  if (first) throw first;
}

/**
 * A Hono app with the family's body rules, validation and error answers.
 * `errors`: "problem" (the kit's problem+json; `typeBase` is the app's problem-type URL
 * prefix) or "fastapi" (FastAPI's default answers).
 * `pyFloats`: off by default (plain JSON.parse bodies); `{routes}` turns on the request-body
 * float opt-in (`installPyFloatBodies` above), `routes` naming kit-built routes that opt in.
 * `onUnhandled(err, c)`: the app's own answer (a Response) to an unhandled exception; default
 * Starlette's plain-text 500.
 */
export function createServer({ typeBase, errors = "problem", onUnhandled = null, bodyLimit = BODY_LIMIT, pyFloats = null } = {}) {
  // FastAPI matches `/x` and `/x/` as different routes; Hono's strict default is the same.
  const app = new Hono();
  if (pyFloats) installPyFloatBodies(app, { ...(pyFloats === true ? {} : pyFloats), bodyLimit });
  else app.use("*", familyMiddleware({ ...DEFAULTS, bodyLimit }));
  // The app's error answers: the kit's problem+json (JustVoice and JustWrite call
  // install_error_handlers) or FastAPI's defaults (docgen never did — measured by the
  // route diff).
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
