// SPDX-License-Identifier: MIT
// pydantic models, in TypeBox (decided 2026-10-07, plan §10 Q5): a model is a TypeBox
// schema — Fastify validates requests against it natively — and `model(Schema, value)`
// is the constructor, `Foo(**value)`: it fills defaults, converts what pydantic's lax
// mode converts, drops unknown fields (pydantic's extra="ignore") and throws a
// ModelValidationError in pydantic's words when a value can't fit.
//
// Writing a model (the port's convention):
//   class Row(BaseModel):                 export const Row = T.Object({
//       modelId: str                          modelId: T.String(),
//       inputPerM: float = 0.0                inputPerM: opt(T.Number(), 0.0),
//       note: str | None = None               note: opt(nullable(T.String()), null),
//       tags: list[str] = []                  tags: opt(T.Array(T.String()), []),
//       extra: dict[str, str] = {}            extra: opt(T.Record(T.String(), T.String()), {}),
//                                         });
// A field with a default is optional (pydantic doesn't require it) and carries the
// default; `opt(schema)` with no default is a field that may be absent and stays absent.
// A free-form `dict` is `T.Record(T.String(), T.Any())`, never an empty `T.Object({})` —
// unknown keys are dropped from objects, not from records.

import Type from "typebox";
import Value from "typebox/value";
import { ajvToPydantic } from "./errors.js";
import { pyClone } from "./pyjson.js";

export const T = Type;

/** A field with a default (pydantic `x: X = default`); no default → may be absent. */
export function opt(schema, dflt) {
  if (dflt === undefined) return Type.Optional(schema);
  // A copy that keeps TypeBox's hidden (non-enumerable) markers, so none of them leaks
  // into the JSON Schema ajv compiles.
  const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(schema));
  copy.default = dflt;
  return Type.Optional(copy);
}

/** `X | None`. */
export const nullable = (schema) => Type.Union([schema, Type.Null()]);

/** `Literal["a", "b"]`. */
export const literal = (...values) => Type.Union(values.map((v) => Type.Literal(v)));

export class ModelValidationError extends Error {
  constructor(errors, title = "model") {
    super(`${errors.length} validation error${errors.length === 1 ? "" : "s"} for ${title}`);
    this.name = "ModelValidationError";
    this.errors = errors;
  }
}

/**
 * pydantic's lax conversions — the ONLY coercion a request gets (ajv runs with coerceTypes
 * off: its coercion turned null into "" / 0 inside a nullable union, where pydantic keeps
 * None). A union keeps a value any branch already accepts before converting anything, so
 * null stays null. `query: true` (query strings and path params) also wraps a single value
 * for a list field, as FastAPI collects repeated keys. Unknown fields are kept here; `clean`
 * drops them after validation, so a model that forbids them still sees them.
 */
export function laxConvert(schema, v, { query = false } = {}) {
  if (v === undefined || v === null || !schema) return v;
  const t = schema.type;
  const opts = { query };
  if (t === "number" && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (t === "integer") {
    // pydantic reads "5" and "5.0" as 5 (a fraction of zero); "5.5" stays a string and fails.
    if (typeof v === "string" && /^\s*[-+]?\d+(?:_\d+)*(?:\.0*)?\s*$/.test(v)) return Math.trunc(Number(v.replace(/_/g, "")));
    if (typeof v === "number" && Number.isInteger(v)) return v;
    if (typeof v === "boolean") return v ? 1 : 0;
  }
  if (t === "number" && typeof v === "boolean") return v ? 1 : 0;
  if (t === "boolean") {
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on", "t"].includes(s)) return true;
      if (["false", "0", "no", "n", "off", "f"].includes(s)) return false;
    }
    if (v === 1 || v === 0) return !!v;
  }
  if (t === "object" && schema.properties && typeof v === "object" && !Array.isArray(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = schema.properties[k] ? laxConvert(schema.properties[k], x, opts) : x;
    return out;
  }
  if (t === "object" && schema.patternProperties && typeof v === "object" && !Array.isArray(v)) {
    const s = Object.values(schema.patternProperties)[0];
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, laxConvert(s, x, opts)]));
  }
  if (t === "array" && Array.isArray(v)) return v.map((x) => laxConvert(schema.items, x, opts));
  if (t === "array" && query) return [laxConvert(schema.items, v, opts)];
  if (schema.anyOf) {
    for (const s of schema.anyOf) if (Value.Check(s, v)) return v;
    for (const s of schema.anyOf) {
      if (s.type === "null") continue;
      const c = laxConvert(s, v, opts);
      if (Value.Check(s, c)) return c;
    }
  }
  return v;
}

function fillDefaults(schema, v) {
  if (!schema || v === null || typeof v !== "object") return v;
  if (schema.type === "object" && schema.properties && !Array.isArray(v)) {
    // pydantic dumps a model's fields in DECLARATION order, whatever order they came in, so
    // the result is rebuilt in the schema's order (extras, kept only by a free dict, last).
    const out = {};
    for (const [k, s] of Object.entries(schema.properties)) {
      if (v[k] === undefined && "default" in s) out[k] = pyClone(s.default);
      else if (v[k] !== undefined) out[k] = v[k];
      if (out[k] !== undefined) out[k] = fillDefaults(s, out[k]);
    }
    for (const k of Object.keys(v)) if (!(k in out) && v[k] !== undefined) out[k] = v[k];
    return out;
  }
  if (schema.type === "array" && Array.isArray(v)) return v.map((x) => fillDefaults(schema.items, x));
  if (schema.patternProperties && !Array.isArray(v)) {
    const s = Object.values(schema.patternProperties)[0];
    for (const k of Object.keys(v)) v[k] = fillDefaults(s, v[k]);
    return v;
  }
  if (schema.anyOf) {
    for (const s of schema.anyOf) if (s.type === (Array.isArray(v) ? "array" : "object")) return fillDefaults(s, v);
  }
  return v;
}

/**
 * Drop the fields a schema doesn't declare (pydantic's extra="ignore"), recursively.
 * An object with `additionalProperties` set (false = forbid, which validation already
 * enforced; a schema or true = a free dict) and a record (`patternProperties`) keep theirs.
 */
export function clean(schema, v) {
  if (!schema || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return schema.type === "array" && schema.items ? v.map((x) => clean(schema.items, x)) : v;
  if (schema.type === "object" && schema.properties) {
    const keepAll = schema.additionalProperties !== undefined && schema.additionalProperties !== false;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const s = schema.properties[k];
      if (s) out[k] = clean(s, x);
      else if (keepAll || schema.additionalProperties === false) out[k] = x;
    }
    return out;
  }
  if (schema.patternProperties) {
    const s = Object.values(schema.patternProperties)[0];
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(s, x)]));
  }
  if (schema.anyOf) {
    const branch = schema.anyOf.find((b) => b.type === "object" && b.properties);
    return branch ? clean(branch, v) : v;
  }
  return v;
}

/**
 * A request body as pydantic hands it to the handler: unknown fields dropped and every
 * default filled — including defaults inside a union (`list[Row] | None`), which ajv's
 * `useDefaults` skips.
 */
export const shapeRequest = (schema, v) => fillDefaults(schema, clean(schema, v));

/** A model that forbids unknown fields (pydantic extra="forbid" — the runner's CamelModel). */
export const strictObject = (props, options = {}) => Type.Object(props, { additionalProperties: false, ...options });

/** `Schema(**value)`: defaults, lax conversion, unknown fields dropped, then checked. */
export function model(schema, value, title) {
  const v = fillDefaults(schema, clean(schema, laxConvert(schema, pyClone(value ?? {}))));
  if (!Value.Check(schema, v)) {
    const errors = [...Value.Errors(schema, v)]
      .filter((e) => e.keyword !== "anyOf")
      .map((e) => {
        const p = ajvToPydantic(
          { ...e, params: e.params?.requiredProperties ? { missingProperty: e.params.requiredProperties[0] } : e.params },
          "_",
          v,
        );
        return { ...p, loc: p.loc.slice(1) };
      });
    throw new ModelValidationError(errors, title || schema.title || "model");
  }
  return v;
}

/** `model_dump()` of a value already shaped by its model: defaults filled, extras gone. */
export const dump = (schema, value) => model(schema, value);

/** Is `value` valid for `schema` as it stands (no conversion)? */
export const check = (schema, value) => Value.Check(schema, value);
