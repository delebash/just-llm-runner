// SPDX-License-Identifier: MIT
// Port of tests/test_runner_config_store.py — the editable engine config (runner_binary +
// runner_setting via /v1/ai/engine-config): get / upsert / set-setting / reset round-trip
// over an in-memory DB.
//
// Waits for wave 2 (skipped until `makeRunnerConfigRouter` exists, then they run by
// themselves): the four tests that mount the engine-config router —
// `engine_config_put_persists_router_knobs`,
// `engine_config_put_clamps_models_max_and_allows_zero_ttl`,
// `engine_config_put_knobs_only_does_not_clobber_binaries_or_build`,
// `engine_config_put_round_trips_class_key_override` — need `makeRunnerConfigRouter`
// (llm/runner_config_api.js holds only the models so far). `get_config_exposes_router_knobs`
// reads the store only and runs now.
import { expect, test, vi } from "vitest";
import * as rcApi from "../src/llm/runner_config_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { createServer } from "../src/platform/server.js";
import * as rconfig from "../src/runner/config.js";
import { freshDb } from "./helpers.js";

// Interim: wave-2 modules, stood in only while their file is missing
// (fixtures/wave-stubs.js explains the raw-specifier keys).
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

const NO_ROUTER = typeof rcApi.makeRunnerConfigRouter !== "function";

function freshSeeded() {
  const h = freshDb();
  h.tx(() => {
    seed.seedDefaultRunnerBinaries(h);
    seed.seedDefaultRunnerSettings(h);
  });
}

const cuda12 = (cfg) => cfg.binaries.find((b) => b.platform === "windows" && b.gpu === "cuda12");

test("get_config_reads_seeded_defaults", () => {
  freshSeeded();
  const cfg = stores.getRunnerConfigStore().getConfig();
  expect(cfg.pinnedBuild).toBe(rconfig.DEFAULT_PINNED_BUILD);
  expect(cfg.safetyMarginMb).toBe(rconfig.DEFAULT_SAFETY_MARGIN_MB);
  expect(cfg.binaries).toHaveLength(rconfig.DEFAULT_BINARIES.length);
  const cuda = cuda12(cfg);
  expect(cuda.assetUrl).toContain("cuda-12.4");
  expect(cuda.runtimeUrl).toContain("cudart"); // the companion is served
});

test("upsert_binary_and_settings", () => {
  freshSeeded();
  const store = stores.getRunnerConfigStore();
  store.upsertBinary({
    platform: "windows",
    gpu: "cuda12",
    assetUrl: "https://example.com/fixed.zip",
    runtimeUrl: null,
    serverExe: "llama-server.exe",
  });
  store.setSetting("pinned_build", "b9999");
  store.setSetting("safety_margin_mb", "2048");

  const cfg = store.getConfig();
  expect(cuda12(cfg).assetUrl).toBe("https://example.com/fixed.zip");
  expect(cfg.pinnedBuild).toBe("b9999");
  expect(cfg.safetyMarginMb).toBe(2048);
});

test("reset_restores_shipped_and_keeps_custom", () => {
  freshSeeded();
  const store = stores.getRunnerConfigStore();
  // break a shipped row + add a user custom row + change a setting
  store.upsertBinary({ platform: "windows", gpu: "cuda12", assetUrl: "https://bad/x.zip" });
  store.upsertBinary({
    platform: "linux",
    gpu: "custom",
    assetUrl: "https://example.com/custom.tar.gz",
    serverExe: "llama-server",
  });
  store.setSetting("pinned_build", "bXXXX");

  store.resetToDefaults();

  const cfg = store.getConfig();
  expect(cuda12(cfg).assetUrl).toContain("cuda-12.4"); // shipped URL restored
  expect(cfg.pinnedBuild).toBe(rconfig.DEFAULT_PINNED_BUILD); // setting restored
  expect(cfg.binaries.some((b) => b.gpu === "custom")).toBe(true); // custom row preserved
});

// ── P1e: the router knobs (models_max + sleep_idle_seconds) the service reads ──

test("build_runner_config_reads_seeded_router_knobs", () => {
  // buildRunnerConfig is the runner service's configFn; it must surface the two router
  // knobs from the seeded runner_setting rows (with the shipped defaults).
  freshSeeded();
  const cfg = stores.buildRunnerConfig();
  expect(cfg.modelsMax).toBe(rconfig.DEFAULT_MODELS_MAX);
  expect(cfg.sleepIdleSeconds).toBe(rconfig.DEFAULT_SLEEP_IDLE_SECONDS);
});

test("build_runner_config_reads_edited_router_knobs", () => {
  // DB is the source of truth: an edited models_max / sleep_idle_seconds flows through.
  // sleep_idle_seconds = 0 (disable the TTL) must be PRESERVED, not coerced to a default.
  freshSeeded();
  const store = stores.getRunnerConfigStore();
  store.setSetting("models_max", "4");
  store.setSetting("sleep_idle_seconds", "0");
  const cfg = stores.buildRunnerConfig();
  expect(cfg.modelsMax).toBe(4);
  expect(cfg.sleepIdleSeconds).toBe(0);
});

// ── 4a: the two router knobs are readable + editable via /v1/ai/engine-config ──

async function engineConfigClient() {
  // Mount the shared engine-config editor over the (already-seeded) in-memory DB.
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(rcApi.makeRunnerConfigRouter(stores.getRunnerConfigStore));
  return {
    get: async (url) => (await app.inject({ method: "GET", url })).json(),
    put: (url, payload) => app.inject({ method: "PUT", url, payload }),
  };
}

test("get_config_exposes_router_knobs", () => {
  // The EngineConfig wire model (what the 4a resident-view UI reads) surfaces the two knobs
  // from the seeded runner_setting rows.
  freshSeeded();
  const cfg = stores.getRunnerConfigStore().getConfig();
  expect(cfg.modelsMax).toBe(rconfig.DEFAULT_MODELS_MAX);
  expect(cfg.sleepIdleSeconds).toBe(rconfig.DEFAULT_SLEEP_IDLE_SECONDS);
});

test.skipIf(NO_ROUTER)("engine_config_put_persists_router_knobs", async () => {
  freshSeeded();
  const r = await (await engineConfigClient()).put("/v1/ai/engine-config", { modelsMax: 3, sleepIdleSeconds: 120 });
  expect(r.statusCode).toBe(200);
  const body = r.json();
  expect(body.modelsMax).toBe(3);
  expect(body.sleepIdleSeconds).toBe(120);
  // …and it reaches the runner's live config (the service reads the same rows).
  const cfg = stores.buildRunnerConfig();
  expect(cfg.modelsMax).toBe(3);
  expect(cfg.sleepIdleSeconds).toBe(120);
});

test.skipIf(NO_ROUTER)("engine_config_put_clamps_models_max_and_allows_zero_ttl", async () => {
  // models_max < 1 is nonsensical (at least one model must stay resident) → clamp to 1;
  // sleep_idle_seconds = 0 is VALID (disables the idle-unload TTL) → preserved, not coerced.
  freshSeeded();
  const body = (await (await engineConfigClient()).put("/v1/ai/engine-config", { modelsMax: 0, sleepIdleSeconds: 0 })).json();
  expect(body.modelsMax).toBe(1); // clamped up
  expect(body.sleepIdleSeconds).toBe(0); // zero preserved
});

test.skipIf(NO_ROUTER)("engine_config_put_knobs_only_does_not_clobber_binaries_or_build", async () => {
  // T3 build-guard: a partial PUT of just the two knobs must leave pinnedBuild + binaries +
  // safetyMarginMb untouched (EngineConfigUpdate is all-optional).
  freshSeeded();
  const client = await engineConfigClient();
  const before = await client.get("/v1/ai/engine-config");
  await client.put("/v1/ai/engine-config", { modelsMax: 4 });
  const after = await client.get("/v1/ai/engine-config");
  expect(after.pinnedBuild).toBe(before.pinnedBuild);
  expect(after.binaries).toHaveLength(before.binaries.length);
  expect(after.safetyMarginMb).toBe(before.safetyMarginMb);
  expect(after.modelsMax).toBe(4);
});

test.skipIf(NO_ROUTER)("engine_config_put_round_trips_class_key_override", async () => {
  // §9 (2026-07-22): the hardware-class override — free text ("" = auto-detect), trimmed
  // at the PUT boundary, served back on GET, cleared by reset.
  freshSeeded();
  const client = await engineConfigClient();
  expect((await client.get("/v1/ai/engine-config")).classKeyOverride).toBe("");
  const body = (await client.put("/v1/ai/engine-config", { classKeyOverride: "  vram20|ram100  " })).json();
  expect(body.classKeyOverride).toBe("vram20|ram100");
  expect(stores.getClassKeyOverride()).toBe("vram20|ram100");
  stores.getRunnerConfigStore().resetToDefaults();
  expect(stores.getClassKeyOverride()).toBe("");
});

test("reset_restores_router_knobs", () => {
  freshSeeded();
  const store = stores.getRunnerConfigStore();
  store.setSetting("models_max", "7");
  store.setSetting("sleep_idle_seconds", "30");
  store.resetToDefaults();
  const cfg = store.getConfig();
  expect(cfg.modelsMax).toBe(rconfig.DEFAULT_MODELS_MAX);
  expect(cfg.sleepIdleSeconds).toBe(rconfig.DEFAULT_SLEEP_IDLE_SECONDS);
});
