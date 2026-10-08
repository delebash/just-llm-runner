// SPDX-License-Identifier: MIT
// Port of tests/test_plane2_params.py — the per-request Plane-2 `extra` (2026-07-15
// one-source): json_mode is the action's CONTRACT (on the spec); top_p / reasoning /
// long-tail samplers come from the resolved PRESET; body values override ephemerally.
import { expect, test, vi } from "vitest";
import { AnthropicAdapter } from "../src/llm/anthropic.js";
import { LLMMessage } from "../src/llm/base.js";
import { getLocalRunnerBaseUrl, setLocalRunnerBaseUrl } from "../src/llm/dispatch.js";
import { OpenAICompatAdapter } from "../src/llm/openai_compat.js";
import { EnginePresetRow } from "../src/llm/presets_api.js";
import { _effectiveThink, _plane2Extra, FeaturePromptRow, RunRequest } from "../src/llm/prompts.js";
import * as stores from "../src/llm/stores.js";
import * as http from "../src/platform/http.js";
import { model } from "../src/platform/models.js";
import { freshDb } from "./helpers.js";

// stores.js imports identity.js (wave 2, another slice): its stand-in until the file lands.
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

const spec = (kw = {}) => FeaturePromptRow({ key: "k", feature: "f", system: "", user_template: "", built_in: false, ...kw });
const preset = (kw = {}) => model(EnginePresetRow, { name: "p", ...kw });
const req = (kw = {}) => model(RunRequest, { action: "k", ...kw });

test("extra_none_when_unset", () => {
  expect(_plane2Extra(spec(), req())).toBeNull();
  expect(_plane2Extra(spec(), req(), preset())).toBeNull();
});

test("json_mode_from_spec_top_p_from_preset", () => {
  // json_mode = the action's contract (spec); top_p = the preset.
  const e = _plane2Extra(spec({ json_mode: true }), req(), preset({ topP: 0.9 }));
  expect(e).toEqual({ response_format: { type: "json_object" }, top_p: 0.9 });
});

test("request_overrides_spec_and_preset", () => {
  // request jsonMode=false overrides the spec's contract; topP override beats the preset.
  const e = _plane2Extra(spec({ json_mode: true }), req({ jsonMode: false, topP: 0.5 }), preset({ topP: 0.9 }));
  expect(e).toEqual({ top_p: 0.5 });
});

test("preset_samplers_reach_extra", () => {
  const e = _plane2Extra(spec(), req(), preset({ samplers: [{ flagName: "min_p", flagValue: "0.05" }] }));
  expect(e).toEqual({ min_p: 0.05 });
});

test("body_samplers_override_preset", () => {
  const e = _plane2Extra(
    spec(),
    req({ samplers: [{ flagName: "min_p", flagValue: "0.2" }] }),
    preset({ samplers: [{ flagName: "min_p", flagValue: "0.05" }] }),
  );
  expect(e).toEqual({ min_p: 0.2 });
});

test("reasoning_effort_from_preset_when_thinking", () => {
  let e = _plane2Extra(spec(), req(), preset({ think: true, reasoningEffort: "high" }));
  expect(e).toEqual({ reasoning_effort: "high" });
  // json_mode forces reasoning off (B3), so the level is NOT threaded.
  e = _plane2Extra(spec({ json_mode: true }), req(), preset({ think: true, reasoningEffort: "high" }));
  expect(e).toEqual({ response_format: { type: "json_object" } });
});

test("effective_think_from_preset_with_json_guardrail", () => {
  // think comes from the PRESET; the B3 guardrail forces it off under json_mode.
  expect(_effectiveThink(spec(), req(), preset({ think: true }))).toBe(true);
  expect(_effectiveThink(spec(), req(), preset({ think: false }))).toBe(false);
  expect(_effectiveThink(spec({ json_mode: true }), req(), preset({ think: true }))).toBe(false);
  expect(_effectiveThink(spec(), req({ jsonMode: true }), preset({ think: true }))).toBe(false);
  // a request think override wins (a Lab column comparing think on vs off); no preset → off
  expect(_effectiveThink(spec(), req({ think: true }), null)).toBe(true);
  expect(_effectiveThink(spec(), req(), null)).toBe(false);
});

// ── Stop sequences (#73) — the reserved `stop` key rides body.samplers, normalized to a
// string ARRAY; anthropic renames it. ──
test("stop_sequences_split_to_array", () => {
  const e = _plane2Extra(spec(), req({ samplers: [{ flagName: "stop", flagValue: "END\nUSER:" }] }));
  expect(e).toEqual({ stop: ["END", "USER:"] });
});

test("stop_numeric_value_kept_as_string", () => {
  const e = _plane2Extra(spec(), req({ samplers: [{ flagName: "stop", flagValue: "42" }] }));
  expect(e).toEqual({ stop: ["42"] });
  // Python's str() of what the sampler parse made: a float keeps its ".0", a bool its case.
  expect(_plane2Extra(spec(), req({ samplers: [{ flagName: "stop", flagValue: "1.0" }] }))).toEqual({ stop: ["1.0"] });
  expect(_plane2Extra(spec(), req({ samplers: [{ flagName: "stop", flagValue: "true" }] }))).toEqual({ stop: ["True"] });
});

test("stop_blank_is_dropped", () => {
  const e = _plane2Extra(spec(), req({ samplers: [{ flagName: "stop", flagValue: "  \n  " }] }));
  expect(e).toBeNull();
});

test("anthropic_renames_stop_to_stop_sequences", () => {
  expect(AnthropicAdapter._mapExtra({ stop: ["END"], top_p: 0.9 })).toEqual({ stop_sequences: ["END"], top_p: 0.9 });
  expect(AnthropicAdapter._mapExtra(null)).toBeNull();
  expect(AnthropicAdapter._mapExtra({ top_p: 0.9 })).toEqual({ top_p: 0.9 });
});

// ── C1: json_schema (the action's CONTRACT) — schema-ENFORCED output ──────────────
test("json_schema_emits_nested_openai_form", () => {
  const schema = '{"type":"object","properties":{"names":{"type":"array"}}}';
  const e = _plane2Extra(spec({ json_mode: true, json_schema: schema }), req({ action: "entity.sweep" }));
  expect(e).toEqual({
    response_format: {
      type: "json_schema",
      json_schema: { name: "entity_sweep", schema: { type: "object", properties: { names: { type: "array" } } }, strict: true },
    },
  });
});

test("json_schema_invalid_degrades_to_json_object", () => {
  let e = _plane2Extra(spec({ json_mode: true, json_schema: "{not json" }), req());
  expect(e).toEqual({ response_format: { type: "json_object" } });
  e = _plane2Extra(spec({ json_mode: true, json_schema: "[1, 2]" }), req());
  expect(e).toEqual({ response_format: { type: "json_object" } });
});

test("json_schema_inert_when_json_mode_off", () => {
  const e = _plane2Extra(spec({ json_mode: false, json_schema: '{"type":"object"}' }), req());
  expect(e).toBeNull();
});

test("prompt_store_roundtrips_contract", () => {
  freshDb({ foreignKeys: false });
  const st = stores.getPromptStore();
  st.upsert(FeaturePromptRow({ key: "y", feature: "y", system: "", user_template: "", built_in: false, json_mode: true, json_schema: '{"type":"object"}' }));
  const r = st.get("y");
  expect(r.json_mode === true && r.json_schema === '{"type":"object"}').toBe(true);
});

test("anthropic_strips_response_format", () => {
  const out = AnthropicAdapter._mapExtra({ response_format: { type: "json_object" }, top_p: 0.9 });
  expect(out).toEqual({ top_p: 0.9 });
});

test("response_format_reaches_the_wire_unchanged_for_every_provider_type", async () => {
  // 2026-09-19: the adapter used to FLATTEN the nested json_schema form for the builtin
  // runner, citing llama-server's README. Its parser reads a schema ONLY from
  // `response_format.json_schema.schema` — the flat form is silently read as "any JSON". So
  // the body goes out UNCHANGED, and `local-llamacpp` must look exactly like every other type.
  const nested = { type: "json_schema", json_schema: { name: "k", schema: { type: "object" }, strict: true } };
  let sent = null;
  vi.spyOn(http, "fetch").mockImplementation(async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({
      model: "m",
      choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  // `local-llamacpp` resolves its base URL from the live router and THROWS when none is
  // running — pin it for this test only, so the result never depends on suite order.
  const saved = getLocalRunnerBaseUrl();
  setLocalRunnerBaseUrl(() => "http://127.0.0.1:1");
  try {
    for (const ptype of ["local-llamacpp", "openai-compat"]) {
      const a = new OpenAICompatAdapter("p", ptype, { apiKey: "" });
      await a.chat([LLMMessage("user", "hi")], { extra: { response_format: structuredClone(nested) } });
      expect([ptype, sent.response_format]).toEqual([ptype, nested]);
    }
  } finally {
    setLocalRunnerBaseUrl(saved);
  }
  // The flattening is GONE, not merely unused (removed-means-removed).
  expect("_adaptResponseFormat" in OpenAICompatAdapter.prototype).toBe(false);
});
