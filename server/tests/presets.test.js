// SPDX-License-Identifier: MIT
// Port of tests/test_presets.py — the engine-preset router + resolver: CRUD, the
// default/per-action-ref assignment layers, the ref → default resolve (2026-07-15 one-source;
// the task tier is gone), the dangling fall-through, and the factory resets, over an
// in-memory DB.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveFeaturePreset, resolveFeaturePresetWithSource } from "../src/llm/preset_resolve.js";
import { makePresetsRouter } from "../src/llm/presets_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

// stores.js imports identity.js (wave 2, another slice): its stand-in until the file lands.
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

let h;
let client;
const savedApp = structuredClone(seed.cfg._APP);
beforeEach(() => {
  h = freshDb({ foreignKeys: false }); // Python's sqlite connection never turns them on
  client = createServer({ typeBase: "https://example.test/errors/" });
  client.register(
    makePresetsRouter(
      stores.getEnginePresetStore,
      stores.getDefaultPresetId,
      stores.setDefaultPresetId,
      stores.getFeaturePresetRefStore,
      seed.resetRoutingToFactory,
      seed.resetPresetToFactory,
    ),
  );
});
afterEach(() => {
  seed.cfg._APP = structuredClone(savedApp); // configureAppSeed is process state
});

const req = async (method, url, payload) => client.inject({ method, url, payload });
const pid = (resp, name) => resp.json().presets.find((p) => p.name === name).id;

test("preset_crud_roundtrip", async () => {
  let r = await req("POST", "/v1/ai/engine-presets", {
    name: "Prose",
    providerId: "llamacpp",
    model: "qwen3-14b-q4_k_m",
    temperature: 0.9,
    maxTokens: 2048,
    samplers: [{ flagName: "top_k", flagValue: "40" }],
  });
  expect(r.statusCode).toBe(200);
  const presets = r.json().presets;
  expect(presets.length).toBe(1);
  let p = presets[0];
  expect(p.id && p.model === "qwen3-14b-q4_k_m" && p.temperature === 0.9).toBe(true);
  expect(p.samplers[0].flagName).toBe("top_k");
  // 2026-07-15: presets carry NO json field (the JSON CONTRACT is on the action) and NO
  // launch switches (§7.1) — a stale client key is dropped.
  expect("jsonMode" in p || "switches" in p).toBe(false);
  const id = p.id;

  r = await req("PUT", `/v1/ai/engine-presets/${id}`, {
    name: "Prose",
    providerId: "llamacpp",
    model: "qwen3-14b-q4_k_m",
    temperature: 0.8,
    jsonMode: true, // a stale jsonMode is ignored
    samplers: [{ flagName: "min_p", flagValue: "0.05" }],
  });
  p = r.json().presets[0];
  expect(p.temperature === 0.8 && p.samplers[0].flagName === "min_p").toBe(true);
  expect("jsonMode" in p).toBe(false);

  expect((await req("DELETE", `/v1/ai/engine-presets/${id}`)).json().presets).toEqual([]);
  expect((await req("PUT", "/v1/ai/engine-presets/nope", { name: "x" })).statusCode).toBe(404);
});

test("assignment_layers", async () => {
  const a = pid(await req("POST", "/v1/ai/engine-presets", { name: "A", model: "m-a" }), "A");
  const b = pid(await req("POST", "/v1/ai/engine-presets", { name: "B", model: "m-b" }), "B");
  await req("PUT", "/v1/ai/preset-assignments/default", { presetId: a });
  let asg = (await req("GET", "/v1/ai/preset-assignments")).json();
  expect(asg.defaultPresetId).toBe(a);
  expect(asg.features).toEqual({});
  expect("taskKinds" in asg).toBe(false); // the task tier is gone (2026-07-15)
  // a per-action ref PUT lands in `features`, keyed by action id
  asg = (await req("PUT", "/v1/ai/preset-assignments/feature", { featureKey: "writerAI.continue", presetId: b })).json();
  expect(asg.features["writerAI.continue"]).toBe(b);
  // clear-features drops the ref(s) → the action falls to the default
  asg = (await req("POST", "/v1/ai/preset-assignments/clear-features", { featureKeys: ["writerAI.continue"] })).json();
  expect("writerAI.continue" in asg.features).toBe(false);
});

test("resolve_ref_then_default", async () => {
  const a = pid(await req("POST", "/v1/ai/engine-presets", { name: "A", model: "m-a" }), "A");
  const b = pid(await req("POST", "/v1/ai/engine-presets", { name: "B", model: "m-b" }), "B");
  await req("PUT", "/v1/ai/preset-assignments/default", { presetId: a });
  await req("PUT", "/v1/ai/preset-assignments/feature", { featureKey: "writerAI.continue", presetId: b });

  // the action's OWN ref wins over the default
  let [p, src] = resolveFeaturePresetWithSource("writerAI.continue");
  expect(p.model === "m-b" && src === "assigned").toBe(true);
  // no ref → the global default
  [p, src] = resolveFeaturePresetWithSource("writerAI.expand");
  expect(p.model === "m-a" && src === "default").toBe(true);

  // clearing the ref → the action falls to the default
  await req("PUT", "/v1/ai/preset-assignments/feature", { featureKey: "writerAI.continue", presetId: "" });
  expect(resolveFeaturePreset("writerAI.continue").model).toBe("m-a");

  // a DANGLING ref (its preset deleted, the ref row survives on the FK-off path) falls
  // THROUGH to the default rather than stranding at null
  stores.getFeaturePresetRefStore().set("writerAI.tighten", "ghost-preset-id");
  expect(resolveFeaturePreset("writerAI.tighten").model).toBe("m-a");

  // nothing configured → null (the no-preset route)
  await req("PUT", "/v1/ai/preset-assignments/default", { presetId: "" });
  expect(resolveFeaturePreset("brainstorm")).toBeNull();
});

test("reset_all_restores_built_ins", async () => {
  seed.configureAppSeed({
    enginePresets: [
      { id: "p_fac", name: "Factory", provider_id: "local-llamacpp", model: "m-fac", temperature: 0.4, samplers: { min_p: "0.05" } },
    ],
    featurePresets: { critique: "p_fac" },
    defaultPresetId: "p_fac",
  });
  h.tx(() => {
    seed.seedDefaultEnginePresets(h);
    seed.seedDefaultFeaturePresets(h);
  });
  const eps = stores.getEnginePresetStore();
  // user edits the built-in + re-points the action + sets a custom default + custom preset
  eps.save({ id: "p_fac", name: "EDITED", providerId: "local-llamacpp", model: "hacked" });
  const custom = eps.save({ name: "Mine", providerId: "local-llamacpp", model: "m-mine" });
  stores.getFeaturePresetRefStore().set("critique", custom.id);
  stores.setDefaultPresetId(custom.id);

  expect((await req("POST", "/v1/ai/engine-presets/reset")).statusCode).toBe(200);

  const fac = eps.list().find((p) => p.id === "p_fac");
  expect(fac.name === "Factory" && fac.model === "m-fac").toBe(true); // built-in restored
  expect(eps.list().some((p) => p.id === custom.id)).toBe(true); // custom kept
  expect(stores.getFeaturePresetRefStore().list().critique).toBe("p_fac"); // factory ref restored
  expect(stores.getDefaultPresetId()).toBe("p_fac"); // default restored
});

test("reset_one_preset", async () => {
  seed.configureAppSeed({
    enginePresets: [{ id: "p_one", name: "One", provider_id: "local-llamacpp", model: "m1", temperature: 0.2, samplers: { seed: "7" } }],
    featurePresets: {},
    defaultPresetId: "",
  });
  h.tx(() => seed.seedDefaultEnginePresets(h));
  const eps = stores.getEnginePresetStore();
  eps.save({
    id: "p_one",
    name: "WRONG",
    providerId: "local-llamacpp",
    model: "bad",
    temperature: 0.99,
    samplers: [{ flagName: "top_k", flagValue: "1" }],
  });

  expect((await req("POST", "/v1/ai/engine-presets/p_one/reset")).statusCode).toBe(200);

  const one = eps.list().find((p) => p.id === "p_one");
  expect(one.name === "One" && one.model === "m1" && one.temperature === 0.2).toBe(true);
  expect(new Set(one.samplers.map((x) => x.flagName))).toEqual(new Set(["seed"])); // factory samplers restored
  // a custom preset has no factory → 400
  const custom = eps.save({ name: "Custom", providerId: "local-llamacpp", model: "c" });
  expect((await req("POST", `/v1/ai/engine-presets/${custom.id}/reset`)).statusCode).toBe(400);
});

test("engine_preset_name_refresh", () => {
  // a factory rename (name_was → name) reaches existing DBs for a still-old-named built-in,
  // but a user who renamed the built-in keeps their name (1:1 alignment).
  seed.configureAppSeed({
    enginePresets: [
      { id: "p_a", name: "New A", name_was: "Old A", provider_id: "local-llamacpp", model: "m" },
      { id: "p_b", name: "New B", name_was: "Old B", provider_id: "local-llamacpp", model: "m" },
    ],
    featurePresets: {},
    defaultPresetId: "",
  });
  h.tx(() => {
    h.insert("engine_presets", { id: "p_a", name: "Old A", provider_id: "local-llamacpp", model: "m", built_in: true });
    h.insert("engine_presets", { id: "p_b", name: "My Own B", provider_id: "local-llamacpp", model: "m", built_in: true });
  });
  h.tx(() => seed.seedDefaultEnginePresets(h));
  const names = Object.fromEntries(
    stores
      .getEnginePresetStore()
      .list()
      .map((p) => [p.id, p.name]),
  );
  expect(names.p_a).toBe("New A"); // refreshed (still carried the old default name)
  expect(names.p_b).toBe("My Own B"); // user rename survives
});

test("engine_preset_delete_removes_children", () => {
  const eps = stores.getEnginePresetStore();
  const p = eps.save({ name: "P", providerId: "local-llamacpp", model: "m", samplers: [{ flagName: "top_k", flagValue: "40" }] });
  expect(h.count("engine_preset_samplers", { preset_id: p.id })).toBe(1);

  eps.delete(p.id);

  expect(h.count("engine_presets", { id: p.id })).toBe(0);
  expect(h.count("engine_preset_samplers", { preset_id: p.id })).toBe(0);
});

// Not in the Python file: the router's remaining answers (checked against the Python router).
test("the presets router answers as FastAPI did", async () => {
  let r = await req("POST", "/v1/ai/engine-presets", { name: "  " });
  expect(r.statusCode).toBe(400);
  expect(r.json().detail).toBe("name is required");
  r = await req("PUT", "/v1/ai/engine-presets/nope", { name: "x" });
  expect(r.json().detail).toBe("preset 'nope' not found");
  r = await req("PUT", "/v1/ai/preset-assignments/feature", { featureKey: " " });
  expect(r.statusCode).toBe(400);
  expect(r.json().detail).toBe("featureKey is required");
  r = await req("POST", "/v1/ai/preset-assignments/feature/%20/reset");
  expect(r.statusCode).toBe(400);
  expect(r.json().detail).toBe("feature key is required");
  r = await req("POST", "/v1/ai/engine-presets", { name: "N", model: "m" });
  expect(r.json().presets[0]).toEqual({
    id: r.json().presets[0].id,
    name: "N",
    providerId: "",
    model: "m",
    temperature: null,
    topP: null,
    maxTokens: 0,
    reasoningEffort: "",
    think: false,
    samplers: [],
    builtIn: false,
    position: 0,
    factoryModel: "",
  });
  expect(r.json().presets[0].id).toMatch(/^[0-9a-f]{12}$/);
  // pydantic's lax conversion of a JSON body: "0.5" → 0.5, "7" → 7, "yes" → true
  r = await req("POST", "/v1/ai/engine-presets", { name: "T", temperature: "0.5", maxTokens: "7", think: "yes" });
  const t = r.json().presets.find((x) => x.name === "T");
  expect([t.temperature, t.maxTokens, t.think, t.position]).toEqual([0.5, 7, true, 1]);
});

test("reset_feature_ref restores the seeded ref and points it at the routing default", async () => {
  seed.configureAppSeed({
    enginePresets: [{ id: "p_s", name: "Seed", provider_id: "", model: "", temperature: 0.3 }],
    featurePresets: { critique: "p_s" },
    defaultPresetId: "",
  });
  h.tx(() => {
    seed.seedDefaultEnginePresets(h);
    seed.seedDefaultFeaturePresets(h);
  });
  stores.getRoutingStore().setRouting({ default: { llmId: "openai", model: "gpt-x" } });
  stores.getEnginePresetStore().save({ id: "p_s", name: "Seed", temperature: 0.9 });
  stores.getFeaturePresetRefStore().set("critique", "");
  const r = await req("POST", "/v1/ai/preset-assignments/feature/critique/reset");
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ defaultPresetId: "", features: { critique: "p_s" } });
  const p = stores
    .getEnginePresetStore()
    .list()
    .find((x) => x.id === "p_s");
  expect([p.providerId, p.model, p.temperature]).toEqual(["openai", "gpt-x", 0.3]);
  // a feature with no seeded ref → the ref clears (falls to the global default)
  stores.getFeaturePresetRefStore().set("other", "p_s");
  const r2 = await req("POST", "/v1/ai/preset-assignments/feature/other/reset");
  expect(r2.json().features).toEqual({ critique: "p_s" });
});
