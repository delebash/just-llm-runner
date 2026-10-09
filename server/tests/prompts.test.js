// SPDX-License-Identifier: MIT
// Port of tests/test_prompts.py — the shared prompt subsystem: render, the editor router, and
// the feature-execution router (all over an in-memory PromptStore), plus run/stream/measure
// as in-server calls.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LLMResponse, StreamDelta } from "../src/llm/base.js";
import { setEnsureLocalModel, setLocalRunnerBaseUrl } from "../src/llm/dispatch.js";
import { EnginePresetRow } from "../src/llm/presets_api.js";
import {
  _effectiveThink,
  FeaturePromptRow,
  MissingTemplateVariables,
  makeFeatureRouter,
  makePromptRouter,
  measureAction,
  RunRequest,
  render,
  runAction,
  streamAction,
  UnknownActionError,
} from "../src/llm/prompts.js";
import { getLlmRegistry } from "../src/llm/registry.js";
import { LLMConfig } from "../src/llm/schema.js";
import * as stores from "../src/llm/stores.js";
import * as http from "../src/platform/http.js";
import { model } from "../src/platform/models.js";
import { pyFloatValue } from "../src/platform/pyjson.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

beforeEach(() => {
  // The /run path resolves the preset via the shared database (resolveFeaturePreset):
  // a per-test in-memory DB.
  freshDb({ foreignKeys: false });
  // QC-43b: the dispatch ensure-local hook is process state — OFF by default, cleaned up
  // after a test sets it.
  setEnsureLocalModel(null);
});
afterEach(() => {
  setEnsureLocalModel(null);
  setLocalRunnerBaseUrl(null);
});

// ── a host store + seed defaults, in memory ──────────────────────────────────
const DEFAULTS = {
  greet: { feature: "greet", system: "You are {{role}}.", user_template: "Hi {{name}}" },
  farewell: {
    feature: "greet", // two actions can share one routing feature
    system: "You are {{role}}.",
    user_template: "Bye {{name}}",
  },
};

/** In-memory PromptStore for tests; seeded from DEFAULTS. */
class MemPromptStore {
  constructor() {
    this.rows = new Map();
    for (const [key, spec] of Object.entries(DEFAULTS)) {
      this.rows.set(key, FeaturePromptRow({ key, feature: spec.feature, system: spec.system, user_template: spec.user_template, built_in: true }));
    }
  }
  get(key) {
    return this.rows.get(key) ?? null;
  }
  list() {
    return [...this.rows.keys()].sort().map((k) => this.rows.get(k));
  }
  upsert(row) {
    // mirror the real store: built_in is preserved on update, set on insert
    const existing = this.rows.get(row.key);
    if (existing) row.built_in = existing.built_in;
    this.rows.set(row.key, row);
  }
}

/** Records the system + user content it's handed so tests can assert the rendered prompt
 * reached the model. */
class CaptureAdapter {
  constructor() {
    this.provider_id = "fake";
    this.provider_type = "openai-compat";
    this.default_model = "m";
    this.last = {};
  }
  async chat(messages, { model: mdl = null, temperature = 0.7, system = null, think = false, extra = null } = {}) {
    this.last = { system, user: messages.at(-1).content, think, extra, temperature, messages: messages.length };
    return LLMResponse({ text: "answer", model: mdl || this.default_model, prompt_tokens: 3, completion_tokens: 7 });
  }
  async *streamChat(messages, { system = null } = {}) {
    this.last = { system, user: messages.at(-1).content, stream: true, messages: messages.length };
    // Prompt-eval progress before the first token (§7.4 B6-2 — the builtin engine's
    // prompt_progress frames arrive as progress-only deltas).
    yield StreamDelta({ progress: 0.5 });
    yield StreamDelta({ text: "ans" });
    yield StreamDelta({ text: "wer" });
    yield StreamDelta({ done: true, prompt_tokens: 2, completion_tokens: 4 });
  }
  async models() {
    return [this.default_model];
  }
  async ping() {
    return true;
  }
}

function wrap(app) {
  // an object payload goes as JSON, with its content type
  const send = (method) => (url, payload) =>
    app.request(
      url,
      payload === undefined
        ? { method }
        : { method, body: JSON.stringify(payload), headers: { "content-type": "application/json" } },
    );
  return {
    get: (url) => app.request(url, { method: "GET" }),
    post: send("POST"),
    put: send("PUT"),
  };
}

function editorClient(store) {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", makePromptRouter(() => store, DEFAULTS));
  return wrap(app);
}

/** Mount the execution router; optionally register a CaptureAdapter into the global registry
 * the dispatch reads (the router calls dispatch without an explicit registry). */
function featureClient(store, { register = true, providerId = null } = {}) {
  getLlmRegistry()._adapters = new Map();
  const adapter = new CaptureAdapter();
  if (providerId) adapter.provider_id = providerId;
  if (register) getLlmRegistry().register(adapter);
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", makeFeatureRouter(() => store, () => LLMConfig()));
  return [wrap(app), adapter];
}

/** A feature-execution client whose sole registered adapter has `providerId` (so
 * resolveRoute's first-adapter fallback resolves to it) — routes to the local runner id
 * (== LLMConfig().local_runner_provider_id) or a cloud id at will. */
const localRouteClient = (providerId) => featureClient(new MemPromptStore(), { providerId });

const GREET_VARS = { name: "x", role: "y" };

// ── render ───────────────────────────────────────────────────────────────────
test("render_substitutes_and_raises_on_missing", () => {
  expect(render("Hi {{name}}, you are {{role}}", { name: "Sam", role: "bot" })).toBe("Hi Sam, you are bot");
  expect(render("{{ name }} spaced", { name: "X" })).toBe("X spaced");
  // Present-but-empty is a caller's legitimate "nothing here" — renders "".
  expect(render("Hi {{name}}", { name: "" })).toBe("Hi ");
  // ABSENT is a wiring bug — fail loud, EVERY missing name listed.
  let err = null;
  try {
    render("{{a}} and {{b}} and {{a}}", { a: 1 });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MissingTemplateVariables);
  expect(err.names).toEqual(["b"]);
  try {
    render("missing {{nope}} and {{gone}}", {});
  } catch (e) {
    err = e;
  }
  expect(err.names).toEqual(["gone", "nope"]);
  // str() of a present value, as Python prints it (not in the Python file).
  expect(render("{{a}}|{{b}}|{{c}}|{{d}}", { a: 1, b: true, c: null, d: [1, "x", { k: 1.5 }] })).toBe("1|True|None|[1, 'x', {'k': 1.5}]");
  // Python's \w is Unicode letters/numbers/underscore — a combining mark is not part of a name.
  expect(render("{{ñame_2}}", { ñame_2: "ok" })).toBe("ok");
  expect(render("{{a\u0301}}", {})).toBe("{{a\u0301}}");
});

// ── editor router ─────────────────────────────────────────────────────────────
test("list_get_and_404", async () => {
  const c = editorClient(new MemPromptStore());
  const lst = (await (await c.get("/v1/ai/prompts")).json()).prompts;
  expect(new Set(lst.map((p) => p.key))).toEqual(new Set(["greet", "farewell"]));
  const one = await (await c.get("/v1/ai/prompts/greet")).json();
  expect(one.userTemplate === "Hi {{name}}" && one.builtIn === true).toBe(true);
  expect((await c.get("/v1/ai/prompts/nope")).status).toBe(404);
});

test("edit_then_reset_roundtrip", async () => {
  const store = new MemPromptStore();
  const c = editorClient(store);
  // edit — a built-in key stays builtIn (so it can be reset)
  let r = await c.put("/v1/ai/prompts/greet", { system: "EDITED {{role}}", userTemplate: "Yo {{name}}" });
  expect(r.status === 200 && (await r.json()).builtIn === true).toBe(true);
  expect(store.get("greet").system).toBe("EDITED {{role}}");
  // reset — back to the seeded default text
  r = await (await c.post("/v1/ai/prompts/greet/reset")).json();
  expect(r.system === "You are {{role}}." && r.userTemplate === "Hi {{name}}").toBe(true);
  // reset of a non-seeded key → 400
  expect((await c.post("/v1/ai/prompts/custom/reset")).status).toBe(400);
});

test("create_user_prompt_not_builtin", async () => {
  const c = editorClient(new MemPromptStore());
  const r = await (await c.put("/v1/ai/prompts/custom", { feature: "custom", system: "s", userTemplate: "u" })).json();
  expect(r.builtIn === false && r.feature === "custom").toBe(true);
});

// ── feature-execution router ──────────────────────────────────────────────────
test("run_renders_prompt_and_returns_content", async () => {
  const [c, adapter] = featureClient(new MemPromptStore());
  const r = await c.post("/v1/ai/run", { action: "farewell", variables: { name: "Sam", role: "bot" } });
  expect(r.status).toBe(200);
  // content + model + token usage (so a Lab can rank columns by decode tok/s)
  expect(await r.json()).toEqual({ content: "answer", model: "m", promptTokens: 3, completionTokens: 7, cost: 0.0, finishReason: "stop" });
  // the DB template was rendered with the caller's variables before dispatch
  expect(adapter.last.user).toBe("Bye Sam");
  expect(adapter.last.system).toBe("You are bot.");
});

test("run_missing_template_variable_is_400_naming_action_and_keys", async () => {
  // The fail-loud gate (2026-08-05): a variables gap is a caller/sample bug the author must
  // see named — never a silently blank prompt reaching the model.
  const [c, adapter] = featureClient(new MemPromptStore());
  const r = await c.post("/v1/ai/run", { action: "greet", variables: { name: "Sam" } });
  expect(r.status).toBe(400);
  const { detail } = await r.json();
  expect(detail).toContain("greet");
  expect(detail).toContain("role");
  expect(adapter.last).toEqual({}); // nothing was dispatched
});

test("stream_missing_template_variable_is_400_pre_stream", async () => {
  // Rendered before the stream starts → a clean HTTP 400, not an error frame.
  const [c, adapter] = featureClient(new MemPromptStore());
  const r = await c.post("/v1/ai/stream", { action: "greet", variables: {} });
  expect(r.status).toBe(400);
  const { detail } = await r.json();
  expect(detail).toContain("name");
  expect(detail).toContain("role");
  expect(adapter.last).toEqual({});
});

test("run_action_is_directly_callable_in_server", async () => {
  // The extracted helper (JV F1 Phase 2): an in-server feature caller runs the SAME
  // resolve→render→overlay→dispatch path the route runs — no HTTP.
  getLlmRegistry()._adapters = new Map();
  const adapter = new CaptureAdapter();
  getLlmRegistry().register(adapter);
  let resp = await runAction(new MemPromptStore(), LLMConfig(), { action: "farewell", variables: { name: "Sam", role: "bot" } });
  expect(resp.text === "answer" && adapter.last.user === "Bye Sam").toBe(true);
  expect(adapter.last.system).toBe("You are bot.");
  // The explicit-system door (A922): body-supplied templates run without a row.
  resp = await runAction(new MemPromptStore(), LLMConfig(), { action: "composed", variables: { t: "raw" }, system: "SYS", userTemplate: "U {{t}}" });
  expect(adapter.last.system === "SYS" && adapter.last.user === "U raw").toBe(true);
  // No row + no templates → UnknownActionError (the route's 404).
  await expect(runAction(new MemPromptStore(), LLMConfig(), { action: "nope", variables: {} })).rejects.toBeInstanceOf(UnknownActionError);
});

test("run_applies_adhoc_samplers", async () => {
  // #21 Lab column: ad-hoc samplers in the request reach the dispatch `extra` (this call
  // only), text values coerced to JSON types.
  const [c, adapter] = featureClient(new MemPromptStore());
  const r = await c.post("/v1/ai/run", {
    action: "greet",
    variables: GREET_VARS,
    samplers: [
      { flagName: "top_k", flagValue: "40" },
      { flagName: "min_p", flagValue: "0.05" },
    ],
  });
  expect(r.status).toBe(200);
  expect(adapter.last.extra.top_k).toBe(40); // int-coerced
  expect(adapter.last.extra.min_p).toEqual(pyFloatValue(0.05)); // float-coerced (a PyFloat: the body writes it as a float)
});

test("run_threads_reasoning_effort_into_extra", async () => {
  // a1/E2: with reasoning on, the level rides in extra under the reserved key (each real
  // adapter pops + maps it); json_mode forces reasoning off (B3), so the level is NOT added.
  const [c, adapter] = featureClient(new MemPromptStore());
  await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS, think: true, reasoningEffort: "high" });
  expect(adapter.last.extra.reasoning_effort).toBe("high");
  // json_mode on → reasoning gated off → no level threaded.
  await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS, think: true, reasoningEffort: "high", jsonMode: true });
  expect("reasoning_effort" in (adapter.last.extra || {})).toBe(false);
});

test("run_unknown_action_404", async () => {
  const [c] = featureClient(new MemPromptStore());
  expect((await c.post("/v1/ai/run", { action: "nope" })).status).toBe(404);
});

test("run_promptless_action_uses_body_templates", async () => {
  // A pipeline-owned app (feature_prompts={}) has NO spec rows — the Lab's columns always
  // send the built prompt as system+userTemplate, and the run goes through against the
  // action's resolved preset (found live 2026-08-04: docgen's Lab ▶ Run answered 404).
  const [c, adapter] = featureClient(new MemPromptStore());
  const r = await c.post("/v1/ai/run", {
    action: "translate", // not in the store — promptless
    system: "You translate.",
    userTemplate: "Translate: {{text}}",
    variables: { text: "hello" },
  });
  expect(r.status).toBe(200);
  expect(adapter.last.user).toBe("Translate: hello");
  expect(adapter.last.system).toBe("You translate.");
});

test("run_promptless_without_templates_stays_404", async () => {
  // No spec AND no body templates = a genuinely unknown action — still loud.
  const [c] = featureClient(new MemPromptStore());
  expect((await c.post("/v1/ai/run", { action: "translate" })).status).toBe(404);
});

test("stream_promptless_parity_with_run", async () => {
  // The stream door takes the SAME body-template promptless shape as /run.
  const [c, adapter] = featureClient(new MemPromptStore());
  const body = await (
    await c.post("/v1/ai/stream", {
      action: "translate",
      system: "You translate.",
      userTemplate: "Translate: {{text}}",
      variables: { text: "hola" },
    })
  ).text();
  expect(body).toContain('"done": true');
  expect(adapter.last.user).toBe("Translate: hola");
  expect(adapter.last.system).toBe("You translate.");
});

test("stream_promptless_without_templates_stays_404", async () => {
  // No spec AND no body templates = unknown action — the stream door is as loud as /run.
  const [c] = featureClient(new MemPromptStore());
  expect((await c.post("/v1/ai/stream", { action: "translate" })).status).toBe(404);
});

test("effective_think_handles_a_promptless_spec_none", () => {
  // The promptless path passes spec=null — pinned so a refactor can't regress it.
  const presetOn = model(EnginePresetRow, { name: "p", think: true });
  expect(_effectiveThink(null, model(RunRequest, { action: "x" }), presetOn)).toBe(true);
  expect(_effectiveThink(null, model(RunRequest, { action: "x", jsonMode: true }), presetOn)).toBe(false);
});

test("run_promptless_jsonmode_is_body_governed", async () => {
  // No spec = no contract row: the request's jsonMode alone switches JSON — response_format
  // reaches the adapter and think gates off on the spec=null path too.
  const [c, adapter] = featureClient(new MemPromptStore());
  const r = await c.post("/v1/ai/run", { action: "translate", system: "s", userTemplate: "u", jsonMode: true, think: true });
  expect(r.status).toBe(200);
  expect((adapter.last.extra || {}).response_format).toEqual({ type: "json_object" });
  expect(adapter.last.think).toBe(false); // json gates think off on the promptless path too
});

test("run_promptless_carries_history_and_writes_no_store_row", async () => {
  // The promptless door honours the SAME history contract as spec'd actions (prior turns
  // precede the rendered user message), and running it leaves NO feature_prompts row.
  const store = new MemPromptStore();
  const [c, adapter] = featureClient(store);
  const r = await c.post("/v1/ai/run", {
    action: "translate",
    system: "s",
    userTemplate: "u {{x}}",
    variables: { x: "1" },
    history: [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
    ],
  });
  expect(r.status).toBe(200);
  expect(adapter.last.messages).toBe(3); // history precedes the rendered user turn
  expect(adapter.last.user).toBe("u 1");
  expect(store.list().every((p) => p.key !== "translate")).toBe(true); // a promptless run never creates a spec row
});

test("run_no_provider_501", async () => {
  const [c] = featureClient(new MemPromptStore(), { register: false });
  expect((await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS })).status).toBe(501);
});

test("edit_changes_what_run_sends", async () => {
  const store = new MemPromptStore();
  const editor = editorClient(store);
  await editor.put("/v1/ai/prompts/greet", { system: "NEW {{role}}", userTemplate: "CHANGED {{name}}" });
  const [c, adapter] = featureClient(store);
  await c.post("/v1/ai/run", { action: "greet", variables: { name: "Sam", role: "bot" } });
  expect(adapter.last.user).toBe("CHANGED Sam");
  expect(adapter.last.system).toBe("NEW bot");
});

test("stream_emits_sse_frames", async () => {
  const [c, adapter] = featureClient(new MemPromptStore());
  const r = await c.post("/v1/ai/stream", { action: "greet", variables: { name: "Sam", role: "bot" } });
  const body = await r.text();
  expect(body).toContain('"delta": "ans"');
  expect(body).toContain('"delta": "wer"');
  expect(body).toContain('"done": true');
  expect(body).toContain('"completionTokens": 4');
  // §7.4 B6-2: a progress delta becomes its own {"progress": p} frame, never a text delta.
  expect(body).toContain('"progress": 0.5');
  // §7.4 B6-1: the done frame carries everything /run's response carries — the dispatch
  // stamps the RESOLVED model; cost is server-priced from it (no price entry for "m" → 0.0).
  expect(body).toContain('"model": "m"');
  expect(body).toContain('"cost": 0.0');
  expect(body.trim().endsWith("data: [DONE]")).toBe(true);
  expect(adapter.last.user).toBe("Hi Sam");
  // The whole answer, byte for byte, as Starlette sent it (not in the Python file).
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(body).toBe(
    'data: {"progress": 0.5}\n\ndata: {"delta": "ans"}\n\ndata: {"delta": "wer"}\n\n' +
      'data: {"done": true, "promptTokens": 2, "completionTokens": 4, "model": "m", "cost": 0.0, "finishReason": ""}\n\n' +
      "data: [DONE]\n\n",
  );
});

test("effective_think_guardrail_off_under_json", () => {
  // B3: think comes from the PRESET; a reasoning block corrupts strict JSON, so it's forced
  // off whenever json_mode is on (the action's contract or a request override).
  const spec = (jsonMode) => FeaturePromptRow({ key: "f", feature: "f", system: "", user_template: "", built_in: true, json_mode: jsonMode });
  const preset = (think) => model(EnginePresetRow, { name: "p", think });
  const req = (think = null, jsonMode = null) => model(RunRequest, { action: "f", think, jsonMode });

  expect(_effectiveThink(spec(false), req(), preset(true))).toBe(true); // think on, no json
  expect(_effectiveThink(spec(true), req(), preset(true))).toBe(false); // contract json_mode → off
  expect(_effectiveThink(spec(false), req(null, true), preset(true))).toBe(false); // request json → off
  expect(_effectiveThink(spec(true), req(true), preset(false))).toBe(false); // guardrail beats override
  expect(_effectiveThink(spec(false), req(), preset(false))).toBe(false); // think off → off
});

test("run_uses_resolved_preset", async () => {
  // The one-source model: with a preset assigned to the action (its ref), /run dispatches the
  // PRESET's model + params (temperature/top_p/reasoning/think), not the prompt's.
  const p = stores.getEnginePresetStore().save({ name: "W", model: "preset-model", temperature: 0.2, topP: 0.9, reasoningEffort: "high", think: true });
  stores.getFeaturePresetRefStore().set("greet", p.id);
  const [c, adapter] = featureClient(new MemPromptStore());

  const r = await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS });
  expect(r.status).toBe(200);
  expect((await r.json()).model).toBe("preset-model"); // the preset's model overrode the route
  expect(adapter.last.temperature).toBe(0.2); // the preset's temperature
  expect(adapter.last.extra.top_p).toEqual(pyFloatValue(0.9)); // the preset's top_p flowed through
  expect(adapter.last.extra.reasoning_effort).toBe("high");
  expect(adapter.last.think).toBe(true); // reasoning on (no json) from the preset
});

test("run_no_preset_omits_temperature_and_reasoning", async () => {
  // The no-preset rule: an action with no ref AND no default dispatches on the
  // provider-default route — temperature is NOT sent (null, so the adapter omits it),
  // reasoning off, no tunables.
  const [c, adapter] = featureClient(new MemPromptStore()); // no preset ref, no default seeded
  const r = await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS });
  expect(r.status).toBe(200);
  expect(adapter.last.temperature).toBeNull(); // omitted (no preset → provider default)
  expect(adapter.last.think).toBe(false); // reasoning off
  expect(adapter.last.extra).toBeNull(); // no tunables sent
});

test("run_body_temperature_override_still_wins", async () => {
  // A request temperature (writerAI 3-variation) is an ephemeral override even with no
  // preset — it reaches the adapter.
  const [c, adapter] = featureClient(new MemPromptStore());
  await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS, temperature: 0.55 });
  expect(adapter.last.temperature).toBe(0.55);
});

test("resolved_route_reports_the_preset", async () => {
  // B5-1 (§7.2): the read-only "runs on" chip's endpoint reports the SAME resolution a run
  // uses — here the preset's model, with the provider falling to the dispatch default.
  const p = stores.getEnginePresetStore().save({ name: "Writer preset", model: "preset-model" });
  stores.getFeaturePresetRefStore().set("greet", p.id);
  const [c] = featureClient(new MemPromptStore());

  const r = await c.get("/v1/ai/resolved-route?feature=greet&action=greet");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.configured).toBe(true);
  expect(body.model).toBe("preset-model");
  expect(body.providerId).toBe("fake");
  expect(body.presetId).toBe(p.id);
  expect(body.presetName).toBe("Writer preset");
  expect(body.presetSource).toBe("assigned");
  expect("taskKind" in body).toBe(false);

  // Parity with the run path: /run dispatches the same model the chip shows.
  const run = await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS });
  expect(run.status).toBe(200);
  expect((await run.json()).model).toBe(body.model);
});

test("resolved_route_without_preset_falls_to_dispatch", async () => {
  // No preset → the dispatch resolution (pin → default), same as a run. presetId stays
  // empty so the chip can say the route comes from the default.
  const [c, adapter] = featureClient(new MemPromptStore());
  const r = await c.get("/v1/ai/resolved-route?feature=greet");
  expect(r.status).toBe(200);
  const text = await r.text();
  const body = JSON.parse(text);
  expect(body.configured).toBe(true);
  expect(body.providerId).toBe(adapter.provider_id);
  expect(body.model).toBe(adapter.default_model);
  expect(body.presetId).toBe("");
  // The whole answer, in the model's field order (checked against the Python router).
  expect(text).toBe(
    '{"feature":"greet","action":"","providerId":"fake","model":"m","presetId":"","presetName":"","presetSource":"",' +
      '"think":false,"level":"","reasoningWord":"","value":null,"valueSource":"","configured":true,"detail":""}',
  );
});

test("resolved_route_override_params_win", async () => {
  // The override query params (providerId/model) mirror RunRequest — a Lab column asks for
  // ITS pinned route, overriding the preset's.
  const [c, adapter] = featureClient(new MemPromptStore());
  const r = await c.get("/v1/ai/resolved-route?feature=greet&model=override-model");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.model).toBe("override-model"); // the override model, not the default
  expect(body.providerId).toBe(adapter.provider_id);
  expect(body.value).toBeNull(); // no preset / think off → no budget resolved
});

test("resolved_route_unconfigured_is_honest", async () => {
  // Nothing registered → configured false + the actionable detail, never a 500.
  const [c] = featureClient(new MemPromptStore(), { register: false });
  const r = await c.get("/v1/ai/resolved-route?feature=greet");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.configured).toBe(false);
  expect(body.detail).toBeTruthy();
  expect(body.providerId === "" && body.model === "").toBe(true);
});

/** A /run app whose feature resolves to a preset carrying `samplers`. */
function presetSamplerApp(samplers) {
  const p = stores.getEnginePresetStore().save({ name: "S", model: "m", samplers });
  stores.getFeaturePresetRefStore().set("greet", p.id);
  return featureClient(new MemPromptStore());
}

test("run_applies_preset_samplers_and_order", async () => {
  // The resolved preset's long-tail samplers reach the chat body (extra), and the reserved
  // `samplers` ORDER value is split from a comma list into an array.
  const [c, adapter] = presetSamplerApp([
    { flagName: "top_k", flagValue: "40" },
    { flagName: "min_p", flagValue: "0.05" },
    { flagName: "samplers", flagValue: "dry,top_k,min_p,temperature" },
  ]);
  const r = await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS });
  expect(r.status).toBe(200);
  const extra = adapter.last.extra;
  expect([extra.top_k, extra.min_p]).toEqual([40, pyFloatValue(0.05)]); // preset samplers dispatched
  expect(extra.samplers).toEqual(["dry", "top_k", "min_p", "temperature"]); // ORDER split to a list
});

test("run_body_samplers_override_preset", async () => {
  // Per-call body.samplers win over the preset's samplers (precedence).
  const [c, adapter] = presetSamplerApp([{ flagName: "top_k", flagValue: "40" }]);
  const r = await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS, samplers: [{ flagName: "top_k", flagValue: "5" }] });
  expect(r.status).toBe(200);
  expect(adapter.last.extra.top_k).toBe(5); // body overrode the preset's 40
});

// ── QC-43b: server-side ensure-local before a dispatch routed to the built-in runner ──
test("run_ensures_local_model_when_route_is_local", async () => {
  // A /run that resolves to the built-in runner provider ensures the RESOLVED model is
  // resident before dispatch — the stubbed hook is called with that model id.
  const ensured = [];
  setEnsureLocalModel((mid) => ensured.push(mid));
  const [c, adapter] = localRouteClient("local-llamacpp"); // == LLMConfig().local_runner_provider_id
  const r = await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS });
  expect(r.status).toBe(200);
  expect(ensured).toEqual([adapter.default_model]); // ensured the model the route resolved to
});

test("run_does_not_ensure_for_non_local_provider", async () => {
  // A cloud/remote route must NOT trigger the local ensure hook.
  const ensured = [];
  setEnsureLocalModel((mid) => ensured.push(mid));
  const [c] = localRouteClient("cloud"); // != the local runner id
  const r = await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS });
  expect(r.status).toBe(200);
  expect(ensured).toEqual([]); // skipped for a non-local provider
});

test("run_ensure_failure_surfaces_as_http_error", async () => {
  // An ensure that throws (the model failed to load) surfaces through the run path's existing
  // error handling as an HTTP error — not a crash.
  setEnsureLocalModel(async (mid) => {
    throw new Error(`The local model "${mid}" failed to load: boom`);
  });
  const [c] = localRouteClient("local-llamacpp");
  const r = await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS });
  expect(r.status).toBe(500); // handled as an HTTP error, not a crash
});

test("stream_ensure_failure_surfaces_as_error_frame", async () => {
  // An ensure failure on the STREAM path becomes the stream's own SSE error frame (there is
  // no HTTP status to fail with once streaming) — never a 500.
  setEnsureLocalModel(async () => {
    throw new Error("model load timed out");
  });
  const [c] = localRouteClient("local-llamacpp");
  const r = await c.post("/v1/ai/stream", { action: "greet", variables: { name: "Sam", role: "bot" } });
  expect(r.status).toBe(200); // the stream response itself is 200
  const body = await r.text();
  expect(body).toContain('"error": "model load timed out"'); // ensure error → SSE error frame
  expect(body.trim().endsWith("data: [DONE]")).toBe(true);
});

// ── measureAction (2026-09-28, chapter splitting): the exact prompt size + context ──
function fakeRouter({ models, calls }) {
  vi.spyOn(http, "fetch").mockImplementation(async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/v1/models") return Response.json({ data: models });
    if (path === "/apply-template") {
      const body = JSON.parse(init.body);
      return Response.json({ prompt: body.messages.map((m) => m.content).join("|") });
    }
    if (path === "/tokenize") {
      return Response.json({ tokens: [...JSON.parse(init.body).content].map((_, i) => i) });
    }
    return new Response(null, { status: 404 });
  });
  setLocalRunnerBaseUrl(() => "http://router.test");
}

test("measure_action_counts_the_rendered_prompt_against_the_launch_context", async () => {
  const ensured = [];
  const calls = [];
  setEnsureLocalModel((mid) => ensured.push(mid));
  const [, adapter] = localRouteClient("local-llamacpp");
  // Unloaded: no meta, the context comes from the launch args.
  fakeRouter({ calls, models: [{ id: adapter.default_model, status: { value: "unloaded", args: ["--ctx-size", "16384"] } }] });
  const fit = await measureAction(new MemPromptStore(), LLMConfig(), { action: "farewell", variables: { name: "Sam", role: "bot" } });
  expect(ensured).toEqual([adapter.default_model]); // the model is made resident before counting
  expect(fit.context === 16384 && fit.model === adapter.default_model).toBe(true);
  expect(fit.prompt_tokens).toBe("You are bot.|Bye Sam".length); // system + user, as the run sends them
  expect(calls).toEqual(["/v1/models", "/apply-template", "/tokenize"]);
});

test("measure_action_is_none_off_the_local_runner", async () => {
  setEnsureLocalModel(() => null);
  localRouteClient("cloud");
  expect(await measureAction(new MemPromptStore(), LLMConfig(), { action: "farewell", variables: { name: "Sam", role: "bot" } })).toBeNull();
});

test("measure_action_is_none_when_the_router_cannot_say", async () => {
  setEnsureLocalModel(() => null);
  localRouteClient("local-llamacpp");
  fakeRouter({ calls: [], models: [] }); // the model is not in the router's list
  expect(await measureAction(new MemPromptStore(), LLMConfig(), { action: "farewell", variables: { name: "Sam", role: "bot" } })).toBeNull();
});

// ── the routes tell the client why generation ended (2026-09-28) ──
test("run_and_stream_carry_finish_reason", async () => {
  const [c, adapter] = featureClient(new MemPromptStore());
  adapter.chat = async () => LLMResponse({ text: "[", model: "m", finish_reason: "length", prompt_tokens: 1, completion_tokens: 1 });
  const r = await c.post("/v1/ai/run", { action: "greet", variables: GREET_VARS });
  expect(r.status === 200 && (await r.json()).finishReason === "length").toBe(true);

  adapter.streamChat = async function* cut() {
    yield StreamDelta({ text: "[" });
    yield StreamDelta({ done: true, prompt_tokens: 1, completion_tokens: 1, finish_reason: "length" });
  };
  const body = await (await c.post("/v1/ai/stream", { action: "greet", variables: GREET_VARS })).text();
  const done = body
    .split("\n")
    .filter((line) => line.startsWith("data: {") && line.includes('"done"'))
    .map((line) => JSON.parse(line.slice(6)))[0];
  expect(done.finishReason).toBe("length");
});

// Not in the Python file: the answers' exact shapes, checked against the Python routers.
test("the prompt and feature routers answer as FastAPI did", async () => {
  const store = new MemPromptStore();
  const editor = editorClient(store);
  let r = await editor.get("/v1/ai/prompts/greet");
  expect(await r.text()).toBe(
    '{"key":"greet","feature":"greet","system":"You are {{role}}.","userTemplate":"Hi {{name}}","builtIn":true,' +
      '"jsonMode":false,"jsonSchema":"","label":"","description":"","group":""}',
  );
  r = await editor.get("/v1/ai/prompts/nope");
  expect((await r.json()).detail).toBe("unknown prompt 'nope'");
  r = await editor.post("/v1/ai/prompts/zz/reset");
  expect((await r.json()).detail).toBe("no seeded default for 'zz' to reset to");
  // a text-only edit keeps the stored JSON contract (preserve-on-omit) and the feature
  store.rows.get("farewell").json_mode = true;
  r = await editor.put("/v1/ai/prompts/farewell", { system: "x" });
  expect(await r.json()).toMatchObject({ feature: "greet", system: "x", userTemplate: "", jsonMode: true });

  const [c] = featureClient(store);
  r = await c.post("/v1/ai/run", { action: "nope" });
  expect((await r.json()).detail).toBe("unknown AI action 'nope'");
  r = await c.post("/v1/ai/run", { action: "greet", variables: { name: "x" } });
  expect((await r.json()).detail).toBe("greet: missing template variable(s): role");
  r = await c.post("/v1/ai/run", {});
  expect((await r.json()).errors).toEqual([{ loc: ["body", "action"], msg: "Field required", type: "missing" }]);
  r = await c.get("/v1/ai/resolved-route");
  expect((await r.json()).errors).toEqual([{ loc: ["query", "feature"], msg: "Field required", type: "missing" }]);

  const [c2] = featureClient(store, { register: false });
  r = await c2.post("/v1/ai/run", { action: "greet", variables: GREET_VARS });
  expect(r.status).toBe(501);
  expect(await r.json()).toMatchObject({ type: "https://example.test/errors/error", title: "Error", status: 501 });
  r = await c2.post("/v1/ai/stream", { action: "greet", variables: { name: "S", role: "b" } });
  expect(r.status).toBe(200);
  expect(await r.text()).toBe(
    `data: {"error": "No LLM provider registered. Add one in the AI engines tab, then route 'greet' in Routing by feature."}\n\ndata: [DONE]\n\n`,
  );
});

test("stream_action streams in-server, resolving eagerly", async () => {
  // Not in the Python file: the streaming sibling of runAction — resolution and the ensure
  // run before the iterator exists, so a bad action fails at the call, not mid-stream.
  getLlmRegistry()._adapters = new Map();
  const adapter = new CaptureAdapter();
  getLlmRegistry().register(adapter);
  const deltas = [];
  for await (const d of await streamAction(new MemPromptStore(), LLMConfig(), { action: "greet", variables: GREET_VARS })) deltas.push(d);
  expect(deltas.map((d) => (d.done ? `done:${d.model}` : d.progress ?? d.text))).toEqual([0.5, "ans", "wer", "done:m"]);
  expect(adapter.last.user).toBe("Hi x");
  await expect(streamAction(new MemPromptStore(), LLMConfig(), { action: "nope" })).rejects.toBeInstanceOf(UnknownActionError);
  await expect(streamAction(new MemPromptStore(), LLMConfig(), { action: "greet" })).rejects.toBeInstanceOf(MissingTemplateVariables);
});

test("stream frames are json.dumps text: thinking, floats and escapes", async () => {
  const [c, adapter] = featureClient(new MemPromptStore());
  adapter.streamChat = async function* frames() {
    yield StreamDelta({ progress: 1.0 });
    yield StreamDelta({ reasoning: "hmm é" });
    yield StreamDelta({ text: 'ans\u2028wer "q"' });
    yield StreamDelta({ done: true, prompt_tokens: 2, completion_tokens: 4 });
  };
  const r = await c.post("/v1/ai/stream", { action: "greet", variables: GREET_VARS });
  // The bytes the Python route wrote for the same deltas (probe, 2026-10-07).
  expect(await r.text()).toBe(
    'data: {"progress": 1.0}\n\ndata: {"thinking": "hmm \\u00e9"}\n\ndata: {"delta": "ans\\u2028wer \\"q\\""}\n\n' +
      'data: {"done": true, "promptTokens": 2, "completionTokens": 4, "model": "m", "cost": 0.0, "finishReason": ""}\n\n' +
      "data: [DONE]\n\n",
  );
});
