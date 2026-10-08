// SPDX-License-Identifier: MIT
// Port of tests/test_reasoning.py — the ONE reasoning resolver: the ask (think + optional
// level) → what each provider/model emits. LOCAL, level SET → the preset's own ask (the
// local map's tokens, source "preset" — "feature is the end of the line"); level EMPTY →
// FOLLOW the model's layered `reasoning_budget` switch value (base bundle → class tune →
// applied model tune, most-specific wins) via the SAME switch_resolve every switch uses —
// NO clamp, honest sentinels (-1 unlimited, 0 suppress, non-numeric → invalid), nothing
// copied. CLOUD levels come from the per-provider reasoning_map.
//
// The nine LOCAL "follow" tests read the layered value through switch_resolve.js, which
// the llm-routers-A slice ports in wave 2: they are ported in full and SKIPPED until that
// file exists (they run, unchanged, the moment it lands):
//   class_row_wins_over_base, model_tune_beats_class, base_bundle_supplies_the_global_tier,
//   nothing_anywhere_defaults, sentinel_minus_one_passes_through, sentinel_zero_suppresses,
//   non_numeric_row_is_invalid, empty_level_follows_the_model,
//   preset_level_with_blank_map_tokens_falls_to_follow
//
// map_seeds_on_an_autoflush_off_session pinned a SQLAlchemy trap (an autoflush-off session
// hid the providers just added); plain SQL has no such state, so the JS test keeps the
// observable — both seeders in ONE transaction, as the host runs them, and the map gets
// its rows.
import { existsSync } from "node:fs";
import { beforeEach, expect, test, vi } from "vitest";
import { resolveReasoning } from "../src/llm/reasoning.js";
import { seedRowsForType } from "../src/llm/reasoning_map_api.js";
import * as seed from "../src/llm/seed.js";
import { ReasoningMapStore } from "../src/llm/stores.js";
import { freshDb } from "./helpers.js";

// Stand-ins while switch_resolve.js / identity.js are still being ported (the importers'
// RAW specifier — vitest keys an unresolvable module by it, so the stand-in steps aside the
// moment the real file lands).
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

const NEEDS_SWITCH_RESOLVE = !existsSync(new URL("../src/llm/switch_resolve.js", import.meta.url));

const CK = "vram8|ram32"; // the fixture's hardware class
const HK = "test-machine"; // the fixture's per-machine hw_key

let h;
beforeEach(() => {
  h = freshDb({ foreignKeys: false }); // Python's sqlite connection never turns them on
  h.tx(() => {
    seed.seedDefaultProviders(h);
    seed.seedDefaultReasoningMap(h);
    seed.seedDefaultRunnerSettings(h);
    seed.seedDefaultSwitchPresets(h); // the base bundle carries reasoning_budget=1024 (the GLOBAL tier)
  });
});

function R(kw) {
  return resolveReasoning({
    classKey: CK,
    hwKey: "", // no per-machine tune unless a test asks for one
    level: "", // local: display vocabulary only; cloud tests pass a level
    ...kw,
  });
}

const local = (modelId, kw = {}) => R({ think: true, providerId: "local-llamacpp", providerType: "local-llamacpp", modelId, ...kw });

const classTune = (modelId, value) =>
  h.insert("class_tunes", { model_id: modelId, class_key: CK, flag_name: "reasoning_budget", flag_value: value });
const modelTune = (modelId, value) =>
  h.insert("model_tunes", { model_id: modelId, hw_key: HK, flag_name: "reasoning_budget", flag_value: value });

const vs = (p) => [p.value, p.source];

// ── LOCAL: the layered switch value IS the emitted budget (no clamp) ──
test.skipIf(NEEDS_SWITCH_RESOLVE)("class_row_wins_over_base", () => {
  classTune("gemma", "1024");
  expect(vs(local("gemma"))).toEqual([1024, "class"]);
});

test.skipIf(NEEDS_SWITCH_RESOLVE)("model_tune_beats_class", () => {
  classTune("gemma", "1024");
  modelTune("gemma", "2048");
  expect(vs(local("gemma", { hwKey: HK }))).toEqual([2048, "tune"]); // the per-machine tune is more specific → wins
});

test.skipIf(NEEDS_SWITCH_RESOLVE)("base_bundle_supplies_the_global_tier", () => {
  expect(vs(local("no-tune-model"))).toEqual([1024, "base"]); // no class/tune rows → the seeded base bundle's 1024
});

test.skipIf(NEEDS_SWITCH_RESOLVE)("nothing_anywhere_defaults", () => {
  // An old DB before a reseed: the base bundle carries no reasoning_budget row → last-ditch.
  h.run("delete from preset_switches where preset_id = ? and flag_name = ?", ["base", "reasoning_budget"]);
  expect(vs(local("no-tune-model"))).toEqual([1024, "default"]);
});

test.skipIf(NEEDS_SWITCH_RESOLVE)("sentinel_minus_one_passes_through", () => {
  classTune("gemma", "-1"); // sanctioned unlimited — no reinterpretation
  expect(vs(local("gemma"))).toEqual([-1, "class"]);
});

test.skipIf(NEEDS_SWITCH_RESOLVE)("sentinel_zero_suppresses", () => {
  classTune("gemma", "0");
  expect(vs(local("gemma"))).toEqual([0, "class"]);
});

test.skipIf(NEEDS_SWITCH_RESOLVE)("non_numeric_row_is_invalid", () => {
  classTune("gemma", "garbage");
  expect(vs(local("gemma"))).toEqual([null, "invalid"]); // the adapter emits 0 → thinking visibly off
});

test("think_off_is_empty", () => {
  const p = local("gemma", { think: false });
  expect(p.think).toBe(false);
  expect(p.word).toBe("");
  expect(p.value).toBeNull();
  expect(p.source).toBe("");
});

// ── LOCAL, the PRESET tier: a set level is the feature's own ask ──
test("preset_level_beats_every_layer", () => {
  classTune("gemma", "1024");
  modelTune("gemma", "2048");
  const p = local("gemma", { level: "high", hwKey: HK }); // feature is the end of the line
  expect(vs(p)).toEqual([8192, "preset"]); // the local map's high, not any layer
});

test("preset_level_is_model_independent", () => {
  // No layers set for this model at all — the preset's own ask still stands.
  expect(vs(local("brand-new-model", { level: "low" }))).toEqual([1024, "preset"]);
});

test.skipIf(NEEDS_SWITCH_RESOLVE)("empty_level_follows_the_model", () => {
  classTune("gemma", "1024");
  expect(vs(local("gemma", { level: "" }))).toEqual([1024, "class"]); // nothing copied — resolved live
});

test.skipIf(NEEDS_SWITCH_RESOLVE)("preset_level_with_blank_map_tokens_falls_to_follow", () => {
  // A user blanks the local map row's tokens: the level speaks no local number → follow
  // the layers, honestly labeled by source (never a silent guess).
  new ReasoningMapStore().upsert("local-llamacpp", { level: "medium", word: "", tokens: null });
  classTune("gemma", "1024");
  expect(vs(local("gemma", { level: "medium" }))).toEqual([1024, "class"]);
});

// ── CLOUD: word vs number by generation, straight from the map ──
test("cloud_word_path", () => {
  const p = R({ think: true, level: "high", providerId: "openai", providerType: "openai", modelId: "gpt" });
  expect(p.word).toBe("high");
  expect(p.value).toBeNull();
  expect(p.source).toBe("");
});

test("cloud_number_path", () => {
  new ReasoningMapStore().seedMissing("gem", seedRowsForType("gemini"));
  const p = R({ think: true, level: "high", providerId: "gem", providerType: "gemini", modelId: "g" });
  expect(p.word).toBe("");
  expect(p.value).toBe(24576);
  expect(p.source).toBe("map");
});

test("edited_map_row_wins_over_seed", () => {
  new ReasoningMapStore().upsert("openai", { level: "high", word: "max-effort" });
  const p = R({ think: true, level: "high", providerId: "openai", providerType: "openai", modelId: "gpt" });
  expect(p.word).toBe("max-effort");
});

// ── the seeding order trap (found on the user's box 2026-07-16) ──
test("map_seeds_on_an_autoflush_off_session", () => {
  // The map seeder queries the providers the PREVIOUS seeder just inserted in the same
  // transaction; an empty answer there seeded NOTHING, silently (fresh boots shipped an
  // empty reasoning map). Run both the way the host does — FAILS if the map comes up empty.
  const db = freshDb({ foreignKeys: false });
  let added = 0;
  db.tx(() => {
    seed.seedDefaultProviders(db);
    added = seed.seedDefaultReasoningMap(db);
  });
  expect(added).toBeGreaterThan(0); // 0 = the shipped bug
  const rows = db.all("select level from reasoning_map where provider_id = ?", ["local-llamacpp"]);
  expect(new Set(rows.map((r) => r.level))).toEqual(new Set(["low", "medium", "high", "xhigh", "max"]));
});

// ── the seed policy: local max finite (32768), gemini max dynamic (-1) ──
test("seed_max_tokens_local_finite_gemini_dynamic", () => {
  const localMax = seedRowsForType("local-llamacpp").find((r) => r.level === "max");
  const geminiMax = seedRowsForType("gemini").find((r) => r.level === "max");
  expect(localMax.tokens).toBe(32768); // finite by policy (Gemma loop verified on-box)
  expect(geminiMax.tokens).toBe(-1); // documented dynamic/unlimited
});
