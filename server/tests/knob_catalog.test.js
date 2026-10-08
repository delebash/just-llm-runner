// SPDX-License-Identifier: MIT
// Port of tests/test_knob_catalog.py — knob_catalog, the friendly KnobGrid metadata (C1):
// seed, the options join, and the /v1/ai/knob-catalog endpoint.
import { beforeEach, expect, test } from "vitest";
import { makeKnobCatalogRouter } from "../src/llm/knob_catalog_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { pySorted } from "../src/platform/py.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

let h;
beforeEach(() => {
  h = freshDb();
  h.tx(() => seed.seedDefaultKnobs(h));
});

const byName = () => Object.fromEntries(stores.listKnobCatalog().map((k) => [k.flagName, k]));
const reseed = () => h.tx(() => seed.seedDefaultKnobs(h));

test("seed_populates_knob_catalog", () => {
  const knobs = stores.listKnobCatalog();
  expect(knobs).toHaveLength(seed.DEFAULT_KNOBS.length);
  const by = Object.fromEntries(knobs.map((k) => [k.flagName, k]));
  // A Plane-1 switch + a Plane-2 sampler both landed.
  expect(by.n_cpu_moe.plane).toBe(1);
  expect(by.n_cpu_moe.appliesTo).toBe("moe");
  expect(by.temperature.plane).toBe(2);
  expect(by.temperature.kind).toBe("float");
  // Plane order: every plane-1 knob sorts before every plane-2 knob.
  const planes = knobs.map((k) => k.plane);
  expect(planes).toEqual(pySorted(planes));
});

test("backend_applicability_seeded_and_healed", () => {
  // Pass 2 (2026-07-22): the four GPU-only knobs carry `backends`; universal knobs carry "";
  // `listKnobBackends()` returns exactly the exception rows; and the boot sync HEALS a row
  // whose backends drifted (existing DBs gain the values).
  const by = byName();
  const gpuSet = "cuda,rocm,vulkan,metal";
  for (const flag of ["n_gpu_layers", "n_cpu_moe", "no_mmap", "no_kv_offload"]) expect(by[flag].backends, flag).toBe(gpuSet);
  expect(by.ctx_len.backends).toBe(""); // universal
  expect(by.mlock.backends).toBe(""); // the pair issue is the strip rule
  expect(stores.listKnobBackends()).toEqual({ n_gpu_layers: gpuSet, n_cpu_moe: gpuSet, no_mmap: gpuSet, no_kv_offload: gpuSet });
  // Heal: wipe one row's backends (an existing pre-Pass-2 DB), reseed → restored.
  h.update("knob_catalog", { backends: "" }, { flag_name: "no_mmap" });
  reseed();
  expect(h.get("knob_catalog", "no_mmap").backends).toBe(gpuSet);
});

test("knob_tiers_and_expanded_set", () => {
  // The Common/Advanced tier split + the expanded knob set (with cited defaults).
  const by = byName();
  // Tier drives the UI checklist split — common shown, advanced behind an expander.
  expect(by.ctx_len.tier).toBe("common");
  expect(by.top_k.tier).toBe("common");
  expect(by.repeat_last_n.tier).toBe("common");
  expect(by.mlock.tier).toBe("advanced");
  expect(by.mirostat_tau.tier).toBe("advanced");
  // The expanded set landed, with the README-cited defaults.
  expect(by.repeat_last_n.default).toBe("64");
  expect(by.mirostat_tau.default).toBe("5.0");
  expect(by.top_n_sigma.default).toBe("-1.0");
  // The 4 already-plumbed switches are present (Plane-1); cont_batching is a bool.
  expect(by.ubatch_size.plane).toBe(1);
  expect(by.cont_batching.plane).toBe(1);
  expect(by.cont_batching.kind).toBe("bool");
  // reasoning_budget is the ONE per-request plane-1 switch (sent as JSON per request, not a
  // launch flag); every other plane-1 switch is a launch flag → perRequest false.
  expect(by.reasoning_budget.plane).toBe(1);
  expect(by.reasoning_budget.perRequest).toBe(true);
  expect(by.cont_batching.perRequest).toBe(false);
});

test("plane1_carries_no_engine_default_claims", () => {
  // QC-17 + QC-18 (user, 2026-07-09): plane-1 switches carry NO default_value and NO options
  // (values are plain text/number boxes; the HELP names the accepted values). Plane-2
  // sampler prefills are untouched. QC-18 AMENDED 2026-07-24: spec_type is the sanctioned
  // enum exception — the server REFUSES unknown spec types, so a dropdown is the honest
  // input; every other plane-1 knob stays free text.
  const knobs = stores.listKnobCatalog();
  for (const k of knobs) {
    if (k.plane === 1 && k.flagName !== "spec_type") {
      expect(k.default, `${k.flagName} still stores a default claim`).toBe("");
      expect(k.options, `${k.flagName} still carries options`).toEqual([]);
    }
  }
  const spec = knobs.find((k) => k.flagName === "spec_type");
  expect(spec.options.map((o) => o.value)).toEqual(["none", "draft-mtp", "draft-dflash", "draft-eagle3", "ngram-mod"]);
  const by = Object.fromEntries(knobs.map((k) => [k.flagName, k]));
  expect(by.cache_type_k.help).toContain("f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1");
  expect(by.flash_attn.help).toContain("on, off, auto");
  // QC-11: context_shift + cache_reuse are OUT of the catalog entirely.
  expect("context_shift" in by).toBe(false);
  expect("cache_reuse" in by).toBe(false);
  // Plane-2 keeps its prefill defaults (samplers untouched).
  expect(by.temperature.default).toBe("0.7");
});

test("option_sync_reaches_an_existing_db", () => {
  // The 2026-07-25 audit defect: the seeder's existing-row branch DELETED stale options but
  // never INSERTED newly-seeded ones, so an EXISTING DB never got spec_type's options back.
  // Simulate the pre-amendment DB (knob row present, zero option rows), re-run the boot
  // seeder, and the seeded options must appear; a user's own option row must survive and
  // not be duplicated.
  h.delete("knob_option", { flag_name: "spec_type" });
  // a user's own option row for a seeded value — never deleted, never duplicated
  h.insert("knob_option", { flag_name: "spec_type", value: "ngram-mod", label: "my ngram", position: 9, built_in: false });
  reseed();
  const spec = stores.listKnobCatalog().find((k) => k.flagName === "spec_type");
  expect(pySorted(spec.options.map((o) => o.value))).toEqual(pySorted(["none", "draft-mtp", "draft-dflash", "draft-eagle3", "ngram-mod"]));
  // the user's row is the one that survived for its value (label proves identity)
  expect(spec.options.find((o) => o.value === "ngram-mod").label).toBe("my ngram");
});

test("seed_curates_existing_dbs", () => {
  // Existing DBs converge on boot (the seeder SYNCS built-in rows — the catalog is
  // app-owned, GET-only): a QC-11 removed row is deleted, its options go with it, and a
  // stale plane-1 default_value/option set is cleared.
  // Recreate the pre-QC-17 era-1 state by hand.
  h.tx(() => {
    h.insert("knob_catalog", { flag_name: "context_shift", kind: "bool", default_value: "true", plane: 1, tier: "advanced", built_in: true });
    h.insert("knob_option", { flag_name: "cache_type_k", value: "q8_0", label: "q8_0", position: 0, built_in: true });
    h.update("knob_catalog", { default_value: "q8_0" }, { flag_name: "cache_type_k" });
  });
  reseed();
  const by = byName();
  expect("context_shift" in by).toBe(false);
  expect(by.cache_type_k.default).toBe("");
  expect(by.cache_type_k.options).toEqual([]);
});

test("knob_catalog_endpoint", async () => {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(makeKnobCatalogRouter(stores.listKnobCatalog));
  const r = await app.inject({ method: "GET", url: "/v1/ai/knob-catalog" });
  expect(r.statusCode).toBe(200);
  const knobs = r.json().knobs;
  const ctk = knobs.find((k) => k.flagName === "cache_type_k");
  expect(ctk.options).toEqual([]);
  expect(ctk.help).toContain("Accepts");
  // Not in the Python test: the response model declares no `backends`, so the wire drops it
  // as FastAPI's did.
  expect("backends" in ctk).toBe(false);
});
