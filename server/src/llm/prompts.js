// SPDX-License-Identifier: MIT
// The shared per-feature prompt subsystem — store contract, template renderer, and the
// editor + execution routers, behind a host-supplied storage boundary. The port of
// llm/prompts.py.
//
// Prompt TEXT is per-app data (each app seeds its own feature catalog into its own
// `feature_prompts` table); the STORE shape, the `{{var}}` renderer, the `/v1/ai/prompts`
// editor API and the `/v1/ai/run` + `/v1/ai/stream` execution API are shared here ONCE. A
// host passes a PromptStore (plus its seed-defaults object, and its LLMConfig builder for
// execution) to the router factories — the same host-store boundary as provider_api.
//
// Headless-first: prompt text lives in the host DB, seeded from the host's defaults, edited
// in the Lab; the server reads it at request time. A missing key is a 404 — no hardcoded
// prompt text, no runtime code fallback.

import { getLogger } from "../platform/log.js";
import { HttpError } from "../platform/errors.js";
import { model, nullable, opt, T } from "../platform/models.js";
import { pyFloat, pyJson } from "../platform/pyjson.js";
import { KeyError, pyFloatParse, pyInt, pySorted, pyStr, strip, truthy, ValueError } from "../platform/py.js";
import { errText, head, httpxRequest, isDict, LLMMessage, pyReprStr, TransportError } from "./base.js";
import * as dispatch from "./dispatch.js";
import * as presetResolve from "./preset_resolve.js";
import * as pricing from "./pricing.js";
import * as reasoning from "./reasoning.js";

const log = getLogger("llm_runner.llm.prompts");

// ── prompt row + store boundary ──────────────────────────────────────────────

/**
 * One action's editable prompt — the dispatch-time + Lab-edit view of a `feature_prompts`
 * row. Prompt TEXT + the JSON CONTRACT (`json_mode`/`json_schema`, kept on the action
 * because the app's parsers are per-action) + nav metadata (`label`/`description`/
 * `group`). EVERY tunable (temperature/top_p/think/reasoning/max_tokens) moved to the
 * engine preset 2026-07-15 — the one source. `label` empty → the UI derives a name.
 *
 * Python's dataclass, internal plumbing (never serialized as-is), so it keeps its snake
 * field names.
 */
export function FeaturePromptRow({
  key,
  feature,
  system,
  user_template,
  built_in,
  json_mode = false, // response_format=json_object (#18) — the action's JSON CONTRACT
  json_schema = "", // optional JSON Schema text — with json_mode on, upgrades to schema-enforced output
  label = "",
  description = "",
  group = "",
}) {
  return { key, feature, system, user_template, built_in, json_mode, json_schema, label, description, group };
}

// The host boundary (Python's PromptStore Protocol): get(key) → FeaturePromptRow | null,
// list() → FeaturePromptRow[], upsert(row). (`reset` is intentionally absent — the reset
// endpoint overwrites via `upsert` with the seeded defaults, so the store needs no delete.)

// ── Python's str() / \s / \w where the renderer needs them (candidates for platform/) ──

/**
 * `str(v)` of any JSON value, as Python prints it: None/True/False, an int, a float's repr,
 * and a list/dict as their repr. (A whole-number float reads as an int — JavaScript can't
 * tell 1.0 from 1.) Candidate for platform/py.js.
 */
export function pyStrAny(v) {
  if (typeof v === "string") return v;
  return pyReprAny(v);
}

function pyReprAny(v) {
  if (typeof v === "string") return pyReprStr(v);
  if (v === null || v === undefined || typeof v === "boolean") return pyStr(v);
  if (typeof v === "number") return Number.isInteger(v) ? (Number.isSafeInteger(v) ? String(v) : BigInt(v).toString()) : pyFloat(v);
  if (Array.isArray(v)) return `[${v.map(pyReprAny).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${pyReprStr(k)}: ${pyReprAny(x)}`).join(", ")}}`;
  return String(v);
}

// Python `re`'s `\s` on str (str.isspace: JS's \s minus U+FEFF, plus \x1c-\x1f and \x85).
// Candidate for platform/py.js.
const PY_S = "[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
// Python `re`'s `\w` on str: alphanumeric (every letter and number category) or "_". (py.js's
// W also matches \p{Mn} and every \p{Pc}; Python does not — measured: re.match(r"\w", ...) of
// U+0301 COMBINING ACUTE and of U+203F UNDERTIE is None. Reported; candidate for
// platform/py.js.)
const PY_W = "[\\p{L}\\p{N}_]";

// ── template renderer ────────────────────────────────────────────────────────
const VAR = () => new RegExp(`\\{\\{${PY_S}*(${PY_W}+)${PY_S}*\\}\\}`, "gu");

/** A template referenced {{names}} the variables object does not carry. */
export class MissingTemplateVariables extends ValueError {
  constructor(names) {
    const list = [...names];
    super(`missing template variable(s): ${list.join(", ")}`);
    this.name = "MissingTemplateVariables";
    this.names = list;
  }
}

const varNames = (template) => new Set(Array.from(template.matchAll(VAR()), (m) => m[1]));
const has = (o, k) => o != null && Object.hasOwn(o, k);

/**
 * Substitute {{name}} placeholders from `variables` — FAIL-LOUD on absence.
 *
 * A placeholder whose name is ABSENT from `variables` throws MissingTemplateVariables naming
 * every missing key (2026-08-05: the silent missing→empty behavior let a mis-wired caller
 * ship a prompt with holes). A key that IS present renders str(value), "" included —
 * present-but-empty is a caller's legitimate "nothing here"; absence is a wiring bug. The
 * run routes turn this into HTTP 400 naming the action + keys.
 */
export function render(template, variables) {
  const missing = pySorted([...varNames(template)].filter((n) => !has(variables, n)));
  if (missing.length) throw new MissingTemplateVariables(missing);
  return template.replace(VAR(), (_m, name) => pyStrAny(has(variables, name) ? variables[name] : ""));
}

/** Render an action's system + user templates together, reporting the UNION of missing
 * names in one error — one at a time would name only the first template's gap and the
 * author would fix variables twice. */
function renderPair(sysTpl, usrTpl, variables) {
  const names = new Set([...varNames(sysTpl), ...varNames(usrTpl)]);
  const missing = pySorted([...names].filter((n) => !has(variables, n)));
  if (missing.length) throw new MissingTemplateVariables(missing);
  return [render(sysTpl, variables), render(usrTpl, variables)];
}

/** Prior conversation turns as LLMMessages — user/assistant with content only. */
function historyMessages(history) {
  const out = [];
  for (const h of history || []) {
    const d = truthy(h) ? h : {};
    const role = pyStrAny(pyOrGet(d, "role"));
    const content = pyStrAny(pyOrGet(d, "content"));
    if ((role === "user" || role === "assistant") && content) out.push(LLMMessage(role, content));
  }
  return out;
}

/** `d.get(k) or ""` with Python truthiness. */
const pyOrGet = (d, k) => (has(d, k) && truthy(d[k]) ? d[k] : "");

// ── wire shapes (camelCase, like the provider router) ────────────────────────
export const PromptOut = T.Object({
  key: T.String(),
  feature: T.String(),
  system: T.String(),
  userTemplate: T.String(),
  builtIn: T.Boolean(),
  jsonMode: opt(T.Boolean(), false),
  jsonSchema: opt(T.String(), ""),
  label: opt(T.String(), ""),
  description: opt(T.String(), ""),
  group: opt(T.String(), ""),
});

export const PromptList = T.Object({ prompts: T.Array(PromptOut) });

// The editable fields: prompt TEXT + the JSON CONTRACT (jsonMode/jsonSchema) + nav metadata.
// Tunables are GONE from the wire (2026-07-15 — they live on the engine preset). `feature`
// defaults to the built-in's routing key when omitted; the contract fields are
// PRESERVE-ON-OMIT (null = keep the stored value) so a text-only edit never wipes the seeded
// json_mode/json_schema.
export const PromptUpdate = T.Object({
  feature: opt(T.String(), ""),
  system: opt(T.String(), ""),
  userTemplate: opt(T.String(), ""),
  jsonMode: opt(nullable(T.Boolean()), null),
  jsonSchema: opt(nullable(T.String()), null),
  label: opt(T.String(), ""),
  description: opt(T.String(), ""),
  group: opt(T.String(), ""),
});

function out(r) {
  return model(PromptOut, {
    key: r.key,
    feature: r.feature,
    system: r.system,
    userTemplate: r.user_template,
    builtIn: r.built_in,
    jsonMode: r.json_mode,
    jsonSchema: r.json_schema,
    label: r.label,
    description: r.description,
    group: r.group,
  });
}

/** `str(d.get(k) or "")` on a seed spec. */
const specStr = (d, k, dflt = "") => pyStrAny(has(d, k) && truthy(d[k]) ? d[k] : dflt);

const KEY_PARAMS = T.Object({ key: T.String() });

// ── editor router: /v1/ai/prompts ────────────────────────────────────────────
/**
 * Build the /v1/ai/prompts editor over a host PromptStore. `defaults` is the host's seed
 * catalog (its DEFAULT_FEATURE_PROMPTS, {key: spec}) — used to mark built-ins and to reset
 * a row back to its seeded text.
 */
export function makePromptRouter(getStore, defaults) {
  const defaultOf = (key) => (has(defaults, key) ? defaults[key] : null);
  return async function promptRouter(app) {
    app.get("/v1/ai/prompts", async () => model(PromptList, { prompts: getStore().list().map(out) }));

    app.get("/v1/ai/prompts/:key", { schema: { params: KEY_PARAMS } }, async (req) => {
      const row = getStore().get(req.params.key);
      if (row == null) throw new HttpError(404, `unknown prompt ${pyReprStr(req.params.key)}`);
      return out(row);
    });

    // Lab edit (or create). A key present in the seed catalog stays builtIn (so it can be
    // reset); anything else is a user-created prompt. Text + the JSON CONTRACT + nav only —
    // every tunable lives on the engine preset now.
    app.put("/v1/ai/prompts/:key", { schema: { params: KEY_PARAMS, body: PromptUpdate } }, async (req) => {
      const key = req.params.key;
      const body = req.body;
      const dflt = defaultOf(key);
      const builtIn = dflt !== null;
      const on = truthy(dflt);
      // Python: `body.feature or (str(default.get("feature")) if default else key) or key` —
      // a default with no "feature" key reads str(None) = "None", copied as-is.
      const feature = body.feature || (on ? pyStrAny(has(dflt, "feature") ? dflt.feature : null) : key) || key;
      // Nav metadata — the editor omits these, so keep the seeded values rather than wiping
      // them on a prompt-content edit.
      const label = body.label || (on ? specStr(dflt, "label") : "");
      const description = body.description || (on ? specStr(dflt, "description") : "");
      const group = body.group || (on ? specStr(dflt, "group") : "");
      // Preserve-on-omit for the JSON contract (null = the editor didn't send it): keep the
      // STORED value so a prompt-text edit never wipes the contract.
      const prev = getStore().get(key);
      getStore().upsert(
        FeaturePromptRow({
          key,
          feature,
          system: body.system,
          user_template: body.userTemplate,
          built_in: builtIn,
          json_mode: body.jsonMode !== null ? body.jsonMode : prev ? prev.json_mode : false,
          json_schema: body.jsonSchema !== null ? body.jsonSchema : prev ? prev.json_schema : "",
          label,
          description,
          group,
        }),
      );
      return out(getStore().get(key));
    });

    // Restore a built-in prompt to its seeded default (overwrites the row).
    app.post("/v1/ai/prompts/:key/reset", { schema: { params: KEY_PARAMS } }, async (req) => {
      const key = req.params.key;
      const dflt = defaultOf(key);
      if (dflt === null) throw new HttpError(400, `no seeded default for ${pyReprStr(key)} to reset to`);
      getStore().upsert(
        FeaturePromptRow({
          key,
          feature: specStr(dflt, "feature", key),
          system: specStr(dflt, "system"),
          user_template: specStr(dflt, "user_template"),
          built_in: true,
          json_mode: truthy(has(dflt, "json_mode") ? dflt.json_mode : false),
          json_schema: specStr(dflt, "json_schema"),
          label: specStr(dflt, "label"),
          description: specStr(dflt, "description"),
          group: specStr(dflt, "group"),
        }),
      );
      return out(getStore().get(key));
    });
  };
}

// ── execution router: /v1/ai/run + /v1/ai/stream ─────────────────────────────
export const RunRequest = T.Object({
  action: T.String(),
  variables: opt(T.Record(T.String(), T.Any()), {}),
  // Optional per-call routing override (a Lab runs one action against several
  // providers/models). Empty → the feature's resolved route.
  providerId: opt(T.String(), ""),
  model: opt(T.String(), ""),
  // Optional per-call temperature override (writerAI's 3-variation mode runs one action at
  // 0.55/0.7/0.95). null → the preset's temperature.
  temperature: opt(nullable(T.Number()), null),
  // Optional prompt overrides — the Feature Workbench Lab tests an in-editor CANDIDATE
  // without writing it live. null → the stored prompt; `think` null → the preset's think.
  system: opt(nullable(T.String()), null),
  userTemplate: opt(nullable(T.String()), null),
  think: opt(nullable(T.Boolean()), null),
  maxTokens: opt(nullable(T.Integer()), null),
  // Optional per-action Plane-2 params (null → the stored value): structured output (JSON)
  // + nucleus sampling. (#18 / #22)
  jsonMode: opt(nullable(T.Boolean()), null),
  topP: opt(nullable(T.Number()), null),
  // Reasoning-effort override (a1/E2): "" | low | medium | high; null → the preset's level.
  // Applied only when reasoning is effectively on.
  reasoningEffort: opt(nullable(T.String()), null),
  // Optional ad-hoc long-tail samplers for a Lab column (Compare / Workbench test):
  // [{flagName, flagValue}] applied to THIS call only — not saved — overriding the resolved
  // preset's samplers. (#21)
  samplers: opt(T.Array(T.Record(T.String(), T.Any())), []),
  // Optional prior conversation turns ({role, content}) for multi-turn features (RAG chat /
  // character chat). Inserted between the system + the rendered user message, so follow-ups
  // keep proper message roles.
  history: opt(T.Array(T.Record(T.String(), T.Any())), []),
});

export const RunResponse = T.Object({
  content: T.String(),
  model: T.String(),
  // Token usage so a one-shot run can report decode tok/s (a Lab ranks columns by it) — the
  // streaming path emits these in its done frame.
  promptTokens: opt(T.Integer(), 0),
  completionTokens: opt(T.Integer(), 0),
  // Estimated USD cost of this call — Compare ranks columns by cost too (Decision 23).
  // Server-priced from the RESOLVED model via pricing.costFor; local models have no price
  // entry → 0.
  cost: opt(T.Number(), 0.0),
  // Why generation ended ("stop" | "length" | …; "" = the provider did not say). "length" =
  // the answer was CUT OFF — by maxTokens or a full context; llama.cpp sends no error for
  // the latter (2026-09-28). The kit client fails the task on it.
  finishReason: opt(T.String(), ""),
});

/**
 * What a run of `feature` (or a specific `action`) routes to RIGHT NOW — the §7.2 read-only
 * "runs on" provenance chips display this. Computed from the SAME functions the run path
 * uses (resolveFeaturePreset + resolveRoute), so the chip can never drift from what a run
 * does. `configured` false (+ `detail`) is the honest factory/unregistered state.
 */
export const ResolvedRouteResponse = T.Object({
  feature: T.String(),
  action: opt(T.String(), ""),
  providerId: opt(T.String(), ""),
  model: opt(T.String(), ""),
  presetId: opt(T.String(), ""),
  presetName: opt(T.String(), ""),
  presetSource: opt(T.String(), ""), // which tier won: "assigned" | "default" | ""
  // Reasoning (U2-T6): what this run's thinking resolves to RIGHT NOW — think on/off, the
  // ask level, the resolved effort word, and the emitted budget value + the layer it came
  // from. The chip/picker read these (no client math — the mirror law); a cloud word route
  // carries value=null.
  think: opt(T.Boolean(), false),
  level: opt(T.String(), ""),
  reasoningWord: opt(T.String(), ""),
  value: opt(nullable(T.Integer()), null),
  valueSource: opt(T.String(), ""), // local: "tune"|"class"|"base"|"default"|"invalid" · cloud: "map" · "" = none
  configured: opt(T.Boolean(), true),
  detail: opt(T.String(), ""),
});

/** `x.strip()` of a str — a non-str raises as Python's AttributeError did (a 500). */
function strStrip(v) {
  if (typeof v !== "string") throw new TypeError(`'${typeof v}' object has no attribute 'strip'`);
  return strip(v);
}

/**
 * A stored text sampler value → the JSON type the chat API expects (bool / int / float /
 * str), plus whether Python held it as a float (`str()` of it then keeps the ".0").
 * Empty → null ('not set').
 */
function parseSamplerValueTyped(v) {
  const s = strStrip(truthy(v) ? v : "");
  if (!s) return [null, false];
  const low = s.toLowerCase();
  if (low === "true" || low === "false") return [low === "true", false];
  try {
    return [pyInt(s), false];
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
  }
  try {
    return [pyFloatParse(s), true];
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
  }
  return [s, false];
}

/**
 * The response_format for a JSON action (#18 → C1). A stored schema that parses as a
 * non-empty JSON OBJECT upgrades the weak json_object to schema-ENFORCED output, emitted in
 * the OpenAI-standard NESTED form — each adapter translates to its backend (llama.cpp reads
 * the same nested OpenAI form UNCHANGED — a flat {"type":"json_schema","schema":…} is what
 * its README documents but its parser silently ignores; Ollama format=<schema>; Gemini
 * responseSchema; Anthropic strips). The schema is NOT injected into the prompt (the prompt
 * still describes the shape). No/invalid schema → json_object; an invalid one logs a warning
 * and DEGRADES rather than failing the run.
 */
export function _responseFormat(spec, action) {
  const raw = strip((spec ? spec.json_schema : "") || "");
  if (raw) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
    if (isDict(obj) && Object.keys(obj).length) {
      // OpenAI constrains the name to ^[A-Za-z0-9_-]+$ — slugify the action id (dots etc.
      // → _) so a cloud pass-through never 400s on the name.
      const name = (action || "").replace(/[^A-Za-z0-9_-]/gu, "_") || "response";
      return { type: "json_schema", json_schema: { name, schema: obj, strict: true } };
    }
    log.warning(`action ${action} has an invalid json_schema — falling back to json_object`);
  }
  return { type: "json_object" };
}

/**
 * Per-request `extra` from the action's JSON CONTRACT (json_mode, on the spec) + the
 * resolved PRESET's tunables (top_p, reasoning, samplers — the one source, 2026-07-15), each
 * overridable by the request. Sampler precedence (highest→lowest): per-call `body.samplers`
 * → the resolved PRESET's samplers. The reserved `samplers` key is the sampler ORDER — a
 * comma-joined name list split into an array for the engine. Merges straight into the
 * OpenAI-compatible chat body (the adapter applies `extra`); no model reload. Safe across
 * adapters: openai-compat sends all (cloud ignores unknown fields), the others map
 * selectively. (#18 / #22 / §8). null when nothing applies.
 */
export function _plane2Extra(spec, body, preset = null) {
  const extra = {};
  const floatKeys = new Set(); // keys whose value Python held as a float (for str() below)
  const jsonMode = body.jsonMode == null ? (spec ? spec.json_mode : false) : body.jsonMode;
  if (jsonMode) extra.response_format = _responseFormat(spec, body.action);
  const topP = body.topP == null ? (preset ? preset.topP : null) : body.topP;
  if (topP != null) extra.top_p = topP;
  // Ad-hoc per-call samplers (a Lab column) win over the preset's — added first so the
  // preset loop's `not in extra` guard skips an overridden key.
  for (const row of body.samplers || []) {
    const name = strStrip(pyOrGet(row, "flagName"));
    if (!name) continue;
    const [val, isFloat] = parseSamplerValueTyped(pyOrGet(row, "flagValue"));
    if (val !== null) {
      extra[name] = val;
      if (isFloat) floatKeys.add(name);
      else floatKeys.delete(name);
    }
  }
  // Resolved preset's long-tail samplers (the lab+preset source of truth) — applied only
  // where a per-call value hasn't already set it.
  for (const row of (preset && preset.samplers) || []) {
    const name = strStrip(row.flagName || "");
    if (name && !Object.hasOwn(extra, name)) {
      const [val, isFloat] = parseSamplerValueTyped(row.flagValue || "");
      if (val !== null) {
        extra[name] = val;
        if (isFloat) floatKeys.add(name);
      }
    }
  }
  // Reasoning-effort LEVEL (a1/E2) — from the PRESET, carried under the reserved
  // `reasoning_effort` key each adapter pops + maps to its backend's native control. ONLY
  // when reasoning is effectively on (B3: think gated off under json_mode), so it never
  // corrupts JSON.
  if (_effectiveThink(spec, body, preset)) {
    // ALWAYS injected under effective think — the key's PRESENCE marks think-on for
    // dispatch's applyReasoning. "" is a real state (2026-07-16 preset tier): local ⇒
    // FOLLOW the model's layered budget; cloud ⇒ provider default (no word sent).
    extra.reasoning_effort = (body.reasoningEffort != null ? body.reasoningEffort : preset ? preset.reasoningEffort : "") || "";
  }
  // The sampler ORDER ("samplers") is an ARRAY of sampler names — accept a comma-joined
  // string from the knob value and split it for the engine.
  if (typeof extra.samplers === "string") {
    extra.samplers = extra.samplers
      .split(",")
      .map((s) => strip(s))
      .filter((s) => s);
  }
  // The reserved `stop` key is a per-feature STOP-sequence list — one per line in the UI →
  // an ARRAY of strings for the engine. Robust to the numeric coercion above (a
  // numeric-looking stop like "42" comes back as a number). Each adapter maps the array.
  if (Object.hasOwn(extra, "stop")) {
    const raw = extra.stop;
    const parts = typeof raw === "string" ? raw.split("\n") : [raw];
    const str = (s) => (floatKeys.has("stop") && typeof s === "number" ? pyFloat(s) : pyStrAny(s));
    const stops = parts.map((s) => strip(str(s))).filter((s) => s);
    if (stops.length) extra.stop = stops;
    else delete extra.stop;
  }
  return Object.keys(extra).length ? extra : null;
}

/**
 * The think flag for this call = the PRESET's think (the one source, 2026-07-15), with the
 * B3 guardrail: a reasoning block corrupts strict JSON, so think is FORCED off whenever
 * json_mode is on (the request's jsonMode override, else the action's CONTRACT json_mode).
 * A request `think` override still wins (a Lab column comparing think on vs off). No preset
 * → think off.
 */
export function _effectiveThink(spec, body, preset = null) {
  const think = body.think != null ? body.think : preset ? preset.think : false;
  const jsonMode = body.jsonMode == null ? (spec ? spec.json_mode : false) : body.jsonMode;
  return truthy(think) && !jsonMode;
}

/**
 * QC-43b: when a run resolves to the bundled LOCAL runner, make its model resident before
 * dispatch — otherwise the adapter talks to a router that may be down and the caller sees a
 * bare "Connection refused". Done SERVER-side so chat, features and the Lab are all covered
 * with no client change. No-op when no ensure hook is wired (a host without the bundled
 * runner), the route resolves to a non-local provider, or no model id resolved. The
 * resolved provider id is compared to `config.local_runner_provider_id` (never a hardcoded
 * string). Resolves once the model is loaded. Route-resolution errors
 * (LLMNotConfiguredError) and load failures propagate to the caller, which surfaces them
 * through its own error shape (run: an HTTP error; stream: the SSE error frame).
 */
async function ensureLocalReady(config, feature, action, providerOverride, modelOverride) {
  const ensure = dispatch.getEnsureLocalModel();
  if (ensure == null) return;
  const [adapter, mdl] = dispatch.resolveRoute(config, feature, { action, providerOverride, modelOverride });
  if (mdl && adapter.provider_id === config.local_runner_provider_id) await ensure(mdl);
}

/** `runAction` got an action with no prompt row AND no body-supplied templates — nothing
 * to run. The route maps it to 404. */
export class UnknownActionError extends KeyError {
  constructor(action) {
    super(String(action));
    this.name = "UnknownActionError";
  }
}

/**
 * Everything the dispatch call needs, resolved ONCE — the shared front half of runAction /
 * streamAction / the /stream route (so the three cannot drift): spec → render templates
 * (fail-loud on missing variables) → resolve the engine preset → overlay request-body
 * ephemerals. Throws UnknownActionError / MissingTemplateVariables — callers map to HTTP.
 */
function resolveAction(store, body) {
  const spec = store.get(body.action) ?? null;
  // PROMPTLESS actions (a pipeline-owned app registers feature_prompts={}) have no spec row
  // — but the Lab's columns always carry the app-built prompt as system+userTemplate, so the
  // run goes through against the action's resolved preset (found live 2026-08-04: docgen's
  // Lab ▶ Run 404'd "unknown AI action").
  if (spec === null && (body.system == null || body.userTemplate == null)) throw new UnknownActionError(body.action);
  const featureKey = spec ? spec.feature : body.action;
  const sysTpl = body.system == null ? (spec ? spec.system : "") : body.system;
  const usrTpl = body.userTemplate == null ? (spec ? spec.user_template : "") : body.userTemplate;
  const [systemText, userText] = renderPair(sysTpl, usrTpl, body.variables);
  const messages = [...historyMessages(body.history), LLMMessage("user", userText)];
  const preset = presetResolve.resolveFeaturePreset(body.action, featureKey);
  const providerOverride = body.providerId || (preset ? preset.providerId : "") || null;
  const modelOverride = body.model || (preset ? preset.model : "") || null;
  // Every tunable comes from the resolved PRESET (the one source, 2026-07-15); request-body
  // values override ephemerally. No preset → provider-default route, NO tunables sent
  // (temperature null omits it), think off — the no-preset rule.
  const temperature = body.temperature != null ? body.temperature : preset ? preset.temperature : null;
  const maxTokens = (body.maxTokens != null ? body.maxTokens : preset ? preset.maxTokens : 0) || null;
  return { spec, featureKey, messages, systemText, preset, providerOverride, modelOverride, temperature, maxTokens };
}

/** A RunRequest as the model would build it (defaults filled) — in-server callers may pass
 * a plain object. */
const asRunRequest = (body) => model(RunRequest, body, "RunRequest");

/** The dispatch keyword arguments both run paths send. */
function dispatchArgs(config, r, body) {
  return {
    config,
    feature: r.featureKey,
    // The action key routes to its own model when it has one, else the feature default.
    action: body.action,
    messages: r.messages,
    // System is templated too — most actions have no system placeholders so render()
    // returns it unchanged; e.g. plotHoles injects world rules.
    system: r.systemText,
    temperature: r.temperature,
    think: _effectiveThink(r.spec, body, r.preset),
    maxTokens: r.maxTokens,
    providerOverride: r.providerOverride,
    modelOverride: r.modelOverride,
    extra: _plane2Extra(r.spec, body, r.preset),
  };
}

/**
 * THE one non-stream run path (JV F1 Phase 2): resolve the action's prompt row — or the
 * body-supplied system/userTemplate, the explicit-system door a composed caller rides —
 * render both templates (fail-loud), resolve the action's ENGINE PRESET, overlay every
 * tunable (preset first, request-body ephemerally on top), make a bundled-runner model
 * resident, and dispatch. Shared by POST /v1/ai/run AND in-server feature callers
 * (JustVoice's features run in-process) — one source, no drift. → LLMResponse.
 * Throws UnknownActionError / MissingTemplateVariables / LLMNotConfiguredError; usage lands
 * in the ledger via dispatch, same as every run.
 */
export async function runAction(store, config, body) {
  body = asRunRequest(body);
  const r = resolveAction(store, body);
  // QC-43b: a run routed to the bundled local runner makes its model resident first.
  await ensureLocalReady(config, r.featureKey, body.action, r.providerOverride, r.modelOverride);
  return dispatch.chat(dispatchArgs(config, r, body));
}

/**
 * THE streaming sibling of runAction (lane 2A): same resolution, same ensure, but returns
 * `streamChat`'s StreamDelta async iterator — text chunks, optional prompt-eval `progress`
 * frames (builtin engine), and a final `done` delta carrying token usage. Resolution and the
 * local-model ensure run EAGERLY (awaited here, before the iterator exists), so callers get
 * clean UnknownActionError / MissingTemplateVariables / LLMNotConfiguredError before any
 * frame: `for await (const d of await streamAction(…))`.
 */
export async function streamAction(store, config, body) {
  body = asRunRequest(body);
  const r = resolveAction(store, body);
  await ensureLocalReady(config, r.featureKey, body.action, r.providerOverride, r.modelOverride);
  return dispatch.streamChat(dispatchArgs(config, r, body));
}

/** How a run's prompt sits in its model's context — measured, not estimated (Python's
 * ActionFit dataclass: snake field names). `prompt_tokens`: the rendered prompt, chat markup
 * included, by the model's own tokenizer; `context`: the model's context size (llama.cpp
 * --ctx-size / n_ctx). */
export function ActionFit({ prompt_tokens, context, model: mdl }) {
  return { prompt_tokens, context, model: mdl };
}

// Python's exception classes on the measure path: what `except (httpx.HTTPError, KeyError,
// ValueError, TypeError)` caught, and what it let through.
class AttributeError extends Error {
  constructor(m) {
    super(m);
    this.name = "AttributeError";
  }
}
class IndexError extends Error {
  constructor(m) {
    super(m);
    this.name = "IndexError";
  }
}
const pyTypeName = (v) =>
  v === null || v === undefined
    ? "NoneType"
    : Array.isArray(v)
      ? "list"
      : typeof v === "string"
        ? "str"
        : typeof v === "boolean"
          ? "bool"
          : typeof v === "number"
            ? Number.isInteger(v) ? "int" : "float"
            : "dict";
/** `d.get(k)` — a non-dict has no .get (AttributeError, not caught by measure). */
function pyGet(d, k) {
  if (!isDict(d)) throw new AttributeError(`'${pyTypeName(d)}' object has no attribute 'get'`);
  return Object.hasOwn(d, k) ? d[k] : null;
}
/** `d[k]` on parsed JSON — KeyError / TypeError, as Python raised. */
function pyItem(d, k) {
  if (isDict(d)) {
    if (!Object.hasOwn(d, k)) throw new KeyError(pyReprStr(k));
    return d[k];
  }
  throw new TypeError(`'${pyTypeName(d)}' object is not subscriptable by a str`);
}
/** `int(v)` of a parsed JSON value: a list/dict/None is a TypeError in Python. */
function pyIntJson(v) {
  if (v === null || typeof v === "object") throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
  return pyInt(v);
}
/** `for x in v` over parsed JSON: a list's items, a dict's keys, a str's characters. */
function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (isDict(v)) return Object.keys(v);
  throw new TypeError(`'${pyTypeName(v)}' object is not iterable`);
}
/** `len(v)` */
function pyLen(v) {
  if (typeof v === "string") return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (isDict(v)) return Object.keys(v).length;
  throw new TypeError(`object of type '${pyTypeName(v)}' has no len()`);
}
/** `x in seq` + `seq.index(x)` for a list or a str (the two shapes `args` can be). */
function ctxFromArgs(args) {
  if (typeof args === "string") {
    const i = args.indexOf("--ctx-size");
    if (i < 0) return 0;
    if (i + 1 >= args.length) throw new IndexError("string index out of range");
    return pyIntJson(args[i + 1]);
  }
  if (!Array.isArray(args)) {
    if (isDict(args)) {
      if (!Object.hasOwn(args, "--ctx-size")) return 0;
      throw new AttributeError("'dict' object has no attribute 'index'");
    }
    throw new TypeError(`argument of type '${pyTypeName(args)}' is not iterable`);
  }
  const i = args.indexOf("--ctx-size");
  if (i < 0) return 0;
  if (i + 1 >= args.length) throw new IndexError("list index out of range");
  return pyIntJson(args[i + 1]);
}
/** The exceptions measureAction's `except` caught (httpx.HTTPError, KeyError, ValueError,
 * TypeError — json.JSONDecodeError is a ValueError). */
const measureCaught = (e) =>
  e instanceof TransportError || e instanceof KeyError || e instanceof ValueError || e instanceof SyntaxError || e instanceof TypeError;
/** `%s` of a caught exception, as Python prints it. */
const excText = (e) => errText(e);

/**
 * The exact size of the prompt `runAction(body)` would send, and the context it must fit —
 * for the bundled LOCAL runner only (2026-09-28, chapter splitting: a caller sizes pieces of
 * a long input before running them). Same resolution as runAction, and the same ensure: the
 * model is made resident first, because llama.cpp counts with the model's own tokenizer.
 *
 * null when the route is not the local runner (a cloud provider publishes no count and has
 * a far larger context) or the router cannot say — the caller then runs unmeasured and
 * relies on the provider's own overflow error. Throws what runAction throws before dispatch.
 */
export async function measureAction(store, config, body) {
  body = asRunRequest(body);
  const r = resolveAction(store, body);
  const [adapter, mdl] = dispatch.resolveRoute(config, r.featureKey, {
    action: body.action,
    providerOverride: r.providerOverride,
    modelOverride: r.modelOverride,
  });
  if (!mdl || adapter.provider_id !== config.local_runner_provider_id) return null;
  await ensureLocalReady(config, r.featureKey, body.action, r.providerOverride, r.modelOverride);
  const urlFn = dispatch.getLocalRunnerBaseUrl();
  let base = ((urlFn ? urlFn() : "") || adapter._apiBase || "").replace(/\/+$/, "");
  if (base.endsWith("/v1")) base = base.slice(0, -3); // .rstrip("/").removesuffix("/v1")
  if (!base) return null;
  const messages = r.systemText ? [{ role: "system", content: r.systemText }] : [];
  for (const m of r.messages) messages.push({ role: m.role, content: m.content });
  let ctx;
  let tokens;
  try {
    const timeout = 60;
    const listedBody = (await httpxRequest("GET", `${base}/v1/models`, { timeout })).json();
    const listed = pyGet(listedBody, "data");
    let entry = null;
    for (const m of pyIter(truthy(listed) ? listed : [])) {
      if (pyGet(m, "id") === mdl) {
        entry = m;
        break;
      }
    }
    if (entry === null) return null;
    const status = pyGet(entry, "status");
    const args = pyGet(truthy(status) ? status : {}, "args");
    const meta = pyGet(entry, "meta");
    const nctx = pyGet(truthy(meta) ? meta : {}, "n_ctx");
    ctx = pyIntJson(truthy(nctx) ? nctx : 0);
    if (!ctx) ctx = ctxFromArgs(truthy(args) ? args : []);
    if (!ctx) return null;
    const applied = (
      await httpxRequest("POST", `${base}/apply-template`, { json: { model: mdl, messages }, timeout })
    ).json();
    const prompt = pyItem(applied, "prompt");
    const tok = (
      await httpxRequest("POST", `${base}/tokenize`, {
        json: { model: mdl, content: prompt, add_special: true, parse_special: true },
        timeout,
      })
    ).json();
    tokens = pyItem(tok, "tokens");
  } catch (e) {
    if (!measureCaught(e)) throw e;
    log.warning(`measure_action ${body.action}: the router could not measure (${excText(e)})`);
    return null;
  }
  return ActionFit({ prompt_tokens: pyLen(tokens), context: ctx, model: mdl });
}

/** One SSE frame, as Python wrote it: `data: {json.dumps(frame)}\n\n` (`cost` and
 * `progress` are Python floats). */
const sseFrame = (frame) => `data: ${pyJson(frame, { floats: ["cost", "progress"] })}\n\n`;

/** Map the run path's own errors to HTTP (the rest are 500s, as in Python). */
function runErrorToHttp(e, body) {
  if (e instanceof UnknownActionError) return new HttpError(404, `unknown AI action ${pyReprStr(body.action)}`);
  // 400, not 500: the caller's variables don't cover the template — a wiring/sample bug the
  // author must see named, never a blank prompt.
  if (e instanceof MissingTemplateVariables) return new HttpError(400, `${body.action}: ${e.message}`);
  return null;
}

/**
 * Build the /v1/ai/run + /v1/ai/stream feature-execution router (+ /v1/ai/resolved-route).
 * The host supplies its PromptStore and an LLMConfig builder (its settings → LLMConfig). The
 * action's prompt is read from the store, the user + system templates filled from
 * `variables`, its ENGINE PRESET resolved (ref → default), and the call routed through the
 * shared dispatch with the preset's model + params.
 */
export function makeFeatureRouter(getStore, getConfig) {
  return async function featureRouter(app) {
    app.post("/v1/ai/run", { schema: { body: RunRequest } }, async (req) => {
      const body = req.body;
      // The whole resolve→render→overlay→ensure→dispatch path IS runAction (the helper
      // in-server feature callers share — one source, no drift).
      let resp;
      try {
        resp = await runAction(getStore(), getConfig(), body);
      } catch (e) {
        const mapped = runErrorToHttp(e, body);
        if (mapped) throw mapped;
        // 501 → the UI shows the actionable "wire an LLM provider" message.
        if (e instanceof dispatch.LLMNotConfiguredError) throw new HttpError(501, errText(e));
        throw e;
      }
      return model(RunResponse, {
        content: resp.text,
        model: resp.model,
        promptTokens: resp.prompt_tokens,
        completionTokens: resp.completion_tokens,
        cost: pricing.costFor(resp.model, resp.prompt_tokens, resp.completion_tokens),
        finishReason: resp.finish_reason || "",
      });
    });

    // Streaming counterpart to /run for the interactive features (writerAI / chat / rag).
    // Emits SSE: `data: {"delta": "..."}` per chunk, optional `data: {"progress": 0..1}`
    // prompt-eval frames before the first token (builtin engine only — §7.4 B6-2),
    // `data: {"thinking": "..."}` per piece of a thinking model's reasoning before its answer
    // (2026-10-06), a final `data: {"done": true, "promptTokens", "completionTokens",
    // "model", "cost", "finishReason"}` carrying everything /run's response carries, then
    // `data: [DONE]`. Errors arrive as `data: {"error": "..."}` (the stream has started, so
    // there is no HTTP status to send).
    app.post("/v1/ai/stream", { schema: { body: RunRequest } }, async (req, reply) => {
      const body = req.body;
      // Resolution is the SAME front half runAction/streamAction use, rendered BEFORE the
      // stream starts, so a variables gap is a clean HTTP 400 naming the keys — not an
      // in-stream error frame.
      let r;
      try {
        r = resolveAction(getStore(), body);
      } catch (e) {
        throw runErrorToHttp(e, body) ?? e;
      }

      // QC-43b: ensure a bundled-runner model is resident BEFORE streaming. Any failure is
      // captured and re-emitted as the stream's OWN SSE error frame below (never a
      // pre-stream 500, matching how streamChat errors surface).
      let ensureError = null;
      try {
        await ensureLocalReady(getConfig(), r.featureKey, body.action, r.providerOverride, r.modelOverride);
      } catch (e) {
        ensureError = head(errText(e), 200);
      }

      // Starlette's StreamingResponse: status 200, `text/event-stream; charset=utf-8`, no
      // other header of its own. Headers a hook already set on the reply ride along.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { ...reply.getHeaders(), "content-type": "text/event-stream; charset=utf-8" });
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      const send = (text) => {
        if (!closed) res.write(text);
      };
      try {
        if (ensureError !== null) {
          send(sseFrame({ error: ensureError }));
          send("data: [DONE]\n\n");
          return;
        }
        try {
          for await (const delta of dispatch.streamChat(dispatchArgs(getConfig(), r, body))) {
            let frame;
            if (delta.done) {
              frame = {
                done: true,
                promptTokens: delta.prompt_tokens,
                completionTokens: delta.completion_tokens,
                model: delta.model,
                cost: pricing.costFor(delta.model, delta.prompt_tokens, delta.completion_tokens),
                // "length" = cut off (see RunResponse.finishReason).
                finishReason: delta.finish_reason,
              };
            } else if (delta.progress != null) {
              frame = { progress: delta.progress };
            } else if (delta.reasoning) {
              frame = { thinking: delta.reasoning };
            } else {
              frame = { delta: delta.text };
            }
            send(sseFrame(frame));
            // The client went away: stop pulling — leaving the loop closes the stream (the
            // dispatch's busy guard is released), as Starlette closing the generator did.
            if (closed) break;
          }
        } catch (e) {
          if (e instanceof dispatch.LLMNotConfiguredError) send(sseFrame({ error: errText(e) }));
          else send(sseFrame({ error: head(errText(e), 200) })); // an error frame, not a 500
        }
        send("data: [DONE]\n\n");
      } finally {
        res.end();
      }
    });

    // The provider+model a run of this feature/action would use right now (B5-1, §7.2): its
    // preset (ref → default) as the override, then the dispatch resolution — mirrored via the
    // run path's own functions, never re-derived. Optional `providerId`/`model` override
    // params (mirror RunRequest) let a Lab column ask for ITS pinned route's reasoning cap.
    app.get(
      "/v1/ai/resolved-route",
      {
        schema: {
          querystring: T.Object({
            feature: T.String(),
            action: opt(T.String(), ""),
            providerId: opt(T.String(), ""),
            model: opt(T.String(), ""),
          }),
        },
      },
      async (req) => {
        const { feature, action, providerId } = req.query;
        const key = action || feature;
        // The same ref → feature-ref → default resolution the run path uses, plus which tier
        // won.
        const [preset, presetSource] = presetResolve.resolveFeaturePresetWithSource(key, feature);
        const base = {
          feature,
          action,
          presetId: preset ? preset.id : "",
          presetName: preset ? preset.name : "",
          presetSource,
        };
        // A Lab column's route override wins over the preset's (cap-hint pick).
        const providerOverride = providerId || (preset ? preset.providerId : "") || null;
        const modelOverride = req.query.model || (preset ? preset.model : "") || null;
        let adapter;
        let mdl;
        try {
          [adapter, mdl] = dispatch.resolveRoute(getConfig(), feature, { action: key, providerOverride, modelOverride });
        } catch (e) {
          if (e instanceof dispatch.LLMNotConfiguredError) {
            return model(ResolvedRouteResponse, { ...base, configured: false, detail: errText(e) });
          }
          throw e;
        }
        // U2-T6: the SAME resolver the run path uses (the dispatch mirror), so the chip shows
        // exactly what a run emits — think/level/word + the layered budget value + its origin
        // layer, no client math. No capability veto here (the gate REMOVAL, ruled
        // 2026-08-06): thinking resolves exactly as the preset asks.
        const want = preset ? preset.think : false;
        const rp = reasoning.resolveReasoning({
          think: truthy(want),
          level: preset ? preset.reasoningEffort : "",
          providerId: adapter.provider_id,
          providerType: adapter.provider_type,
          modelId: mdl,
        });
        return model(ResolvedRouteResponse, {
          ...base,
          providerId: adapter.provider_id,
          model: mdl,
          think: rp.think,
          level: rp.level,
          reasoningWord: rp.word,
          value: rp.value,
          valueSource: rp.source,
        });
      },
    );
  };
}
