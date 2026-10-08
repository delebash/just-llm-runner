// SPDX-License-Identifier: MIT
// Port of tests/test_shared_storage.py — the shared LLM storage stack in isolation:
// configureStorage + createAll + seed + store round-trips, on an in-memory SQLite.
//
// NOT the drop-in test: this file wires the storage layer by hand and never calls
// `installLlm` (that is install_llm.test.js).
import { beforeEach, expect, test } from "vitest";
import * as db from "../src/llm/db.js";
import { FeatureCatalogEntry } from "../src/llm/routing_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { freshDb } from "./helpers.js";

let h;
beforeEach(() => {
  h = freshDb();
  seed.configureAppSeed({
    featureCatalog: [
      FeatureCatalogEntry({ key: "critique", label: "Critique", group: "Analysis" }),
      FeatureCatalogEntry({ key: "chat", label: "Ask the book", group: "Chat" }),
    ],
    featurePrompts: {
      critique: { feature: "critique", system: "S", user_template: "U", json_mode: true },
    },
    enginePresets: [],
    featurePresets: {},
    defaultPresetId: "",
  });
  seed.seedLlm();
});

test("seed_populates_shared_and_app_data", () => {
  const providers = new Set(stores.getProviderStore().list().map((p) => p.id));
  for (const id of ["local-llamacpp", "openai", "claude", "openrouter"]) expect(providers.has(id)).toBe(true); // shared seed
  // Catalog-full / selections-empty (user, 2026-07-06): the routing row exists but carries
  // NO choices — Quick Setup or a manual pick fills them.
  expect(stores.getRoutingStore().getRouting().default.llmId).toBe("");
  expect(stores.getPromptStore().get("critique")).not.toBeNull(); // per-app prompt seed
  // Decision ④ (2026-08-05): the shared seed carries NO models — a host that registers no
  // modelCatalogExtra gets an empty catalog, by design.
  expect(stores.getModelCatalogStore().list()).toHaveLength(0);
});

test("reseed_refreshes_old_seeded_provider_name_only", () => {
  // #3 (2026-07-08): reseed refreshes an old seeded provider name ONLY while the row still
  // carries the old seeded string; a user's own rename is never touched.
  expect(h.get("llm_providers", "local-llamacpp").name).toBe("Built-in provider — llama.cpp"); // fresh seed = new name

  h.update("llm_providers", { name: "Built-in server — llama.cpp" }, { id: "local-llamacpp" }); // a pre-rename DB
  h.tx(() => seed.seedDefaultProviders(h));
  expect(h.get("llm_providers", "local-llamacpp").name).toBe("Built-in provider — llama.cpp");

  h.update("llm_providers", { name: "My box's engine" }, { id: "local-llamacpp" }); // the user renamed it — a different fact
  h.tx(() => seed.seedDefaultProviders(h));
  expect(h.get("llm_providers", "local-llamacpp").name).toBe("My box's engine");
});

test("seed_routing_ships_no_selections", () => {
  const d = stores.getRoutingStore().getRouting().default;
  expect(d.embeddingId).toBe("");
  expect(d.embeddingModel).toBe("");
  expect(d.llmId).toBe("");
});

test("routing_roundtrip_default_only", () => {
  // Per-feature pins are gone (2026-07-15) — the routing config is the global default.
  const rs = stores.getRoutingStore();
  rs.setRouting({ default: { llmId: "openai", model: "gpt-4o" } });
  const got = rs.getRouting();
  expect(got.default.llmId).toBe("openai");
  expect(got.default.model).toBe("gpt-4o");
});

test("build_llm_config_has_providers_no_pins", async () => {
  const { buildLlmConfig } = await import("../src/llm/config_builder.js");
  stores.getRoutingStore().setRouting({ default: { llmId: "openai-compat-local" } });
  const cfg = buildLlmConfig();
  const ids = new Set(cfg.providers.map((p) => p.id));
  expect(ids.has("local-llamacpp") && ids.has("openai")).toBe(true);
  // The pin layer is GONE (retired 2026-08-08; decided 2026-07-15) — the preset is the one
  // source, and the config no longer even carries the slot.
  expect("feature_pins" in cfg).toBe(false);
});

test("model_catalog_quality_and_description_roundtrip", () => {
  const cat = stores.getModelCatalogStore();
  cat.upsert({ id: "probe-model", name: "Probe", qualityRank: 7, description: "a probe model", pooling: "last" });
  const row = cat.list().find((r) => r.id === "probe-model");
  expect(row.qualityRank).toBe(7);
  expect(row.description).toBe("a probe model");
  expect(row.pooling).toBe("last");
  cat.upsert({ id: "probe-default", name: "Probe2" });
  const row2 = cat.list().find((r) => r.id === "probe-default");
  expect(row2.qualityRank).toBe(100);
  expect(row2.description).toBe("");
  expect(row2.pooling).toBe("");
});

test("reset_all_to_factory", () => {
  seed.configureAppSeed({
    featurePresets: { critique: "p_fac" },
    enginePresets: [{ id: "p_fac", name: "Factory", provider_id: "local-llamacpp", model: "m-fac" }],
    defaultPresetId: "p_fac",
  });
  const s = db.session();
  s.tx(() => {
    seed.seedDefaultEnginePresets(s);
    seed.seedDefaultFeaturePresets(s);
  });
  const eps = stores.getEnginePresetStore();
  // user edits the built-in, re-points the action, sets a custom default + custom preset
  eps.save({ id: "p_fac", name: "EDITED", providerId: "local-llamacpp", model: "hacked" });
  const custom = eps.save({ name: "Mine", providerId: "local-llamacpp", model: "m-custom" });
  stores.getFeaturePresetRefStore().set("critique", custom.id);
  stores.setDefaultPresetId(custom.id);

  seed.resetRoutingToFactory();

  const fac = eps.list().find((p) => p.id === "p_fac");
  expect(fac.name).toBe("Factory"); // built-in restored
  expect(fac.model).toBe("m-fac");
  expect(eps.list().some((p) => p.id === custom.id)).toBe(true); // custom kept
  expect(stores.getFeaturePresetRefStore().list().critique).toBe("p_fac"); // factory ref restored
  expect(stores.getDefaultPresetId()).toBe("p_fac"); // default restored
});

test("engine_preset_name_refresh", () => {
  seed.configureAppSeed({
    featurePresets: {},
    enginePresets: [
      { id: "p_a", name: "New A", name_was: "Old A", provider_id: "local-llamacpp", model: "m" },
      { id: "p_b", name: "New B", name_was: "Old B", provider_id: "local-llamacpp", model: "m" },
    ],
    defaultPresetId: "",
  });
  const s = db.session();
  // an existing DB: p_a still under its old name; p_b renamed by the user
  s.insert("engine_presets", { id: "p_a", name: "Old A", provider_id: "local-llamacpp", model: "m", built_in: true });
  s.insert("engine_presets", { id: "p_b", name: "My Own B", provider_id: "local-llamacpp", model: "m", built_in: true });
  s.tx(() => seed.seedDefaultEnginePresets(s));
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
  const p = eps.save({
    name: "P",
    providerId: "local-llamacpp",
    model: "m",
    samplers: [{ flagName: "top_k", flagValue: "40" }],
  });
  const s = db.session();
  expect(s.count("engine_preset_samplers", { preset_id: p.id })).toBe(1);

  eps.delete(p.id);

  expect(s.count("engine_presets", { id: p.id })).toBe(0);
  expect(s.count("engine_preset_samplers", { preset_id: p.id })).toBe(0); // child gone
});
