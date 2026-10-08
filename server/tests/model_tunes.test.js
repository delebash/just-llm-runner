// SPDX-License-Identifier: MIT
// Port of tests/test_model_tunes.py — the per-(model, machine) tune surface (Plan B): the
// /v1/ai/model-tunes CRUD (server-derived hw_key; PUT replaces the whole set —
// verbatim-snapshot D5), the §7.6 drift/provenance/state additions, and the whole-machine
// `machineKey` (gpu|vram|cores|ramGB — D2).
import { expect, test, vi } from "vitest";
import { makeModelTunesRouter } from "../src/llm/model_tunes_api.js";
import * as stores from "../src/llm/stores.js";
import { model } from "../src/platform/models.js";
import { createServer } from "../src/platform/server.js";
import { machineKey } from "../src/runner/hardware.js";
import { GpuInfo, HardwareInfo } from "../src/runner/schema.js";
import { freshDb } from "./helpers.js";

// stores.js imports two wave-2 modules; stand-ins until they land (fixtures/wave-stubs.js).
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

function makeClient(options) {
  freshDb();
  const app = createServer({ typeBase: "https://example.test/errors/" });
  // hwKeyFn injected — the SERVER derives the machine key (one source).
  app.register(makeModelTunesRouter(stores.getModelTuneStore, () => "test-key", options));
  return {
    get: async (url) => (await app.inject({ method: "GET", url })).json(),
    put: (payload) => app.inject({ method: "PUT", url: "/v1/ai/model-tunes", payload }),
    del: async (url) => (await app.inject({ method: "DELETE", url })).json(),
    raw: app,
  };
}
const client = () => makeClient();

const pairs = (rows) => new Set(rows.map((x) => `${x.flagName}=${x.flagValue}`));

test("put_get_delete_round_trip", async () => {
  const c = client();
  const body = {
    modelId: "m1",
    switches: [
      { flagName: "n_cpu_moe", flagValue: "37" },
      { flagName: "spec_type", flagValue: "draft-mtp" },
      { flagName: "", flagValue: "dropped" }, // empty name → dropped
    ],
  };
  const r = (await c.put(body)).json();
  expect(r.modelId === "m1" && r.hwKey === "test-key").toBe(true);
  expect(pairs(r.rows)).toEqual(new Set(["n_cpu_moe=37", "spec_type=draft-mtp"]));
  // GET returns the same set
  const g = await c.get("/v1/ai/model-tunes?modelId=m1");
  expect(g.rows).toHaveLength(2);
  expect(g.hwKey).toBe("test-key");
  // DELETE → empty ("Remove saved tune")
  const d = await c.del("/v1/ai/model-tunes?modelId=m1");
  expect(d.rows).toEqual([]);
});

test("put_replaces_the_whole_set", async () => {
  const c = client();
  await c.put({
    modelId: "m1",
    switches: [
      { flagName: "threads", flagValue: "8" },
      { flagName: "batch_size", flagValue: "64" },
    ],
  });
  const r = (await c.put({ modelId: "m1", switches: [{ flagName: "threads", flagValue: "6" }] })).json();
  // verbatim snapshot: the old batch_size row is GONE, not merged (D5)
  expect(r.rows.map((x) => [x.flagName, x.flagValue])).toEqual([["threads", "6"]]);
});

test("tunes_are_isolated_per_model", async () => {
  const c = client();
  await c.put({ modelId: "m1", switches: [{ flagName: "threads", flagValue: "8" }] });
  expect((await c.get("/v1/ai/model-tunes?modelId=m2")).rows).toEqual([]);
});

test("missing_model_id_400", async () => {
  const c = client();
  expect((await c.raw.inject({ method: "GET", url: "/v1/ai/model-tunes?modelId=%20" })).statusCode).toBe(400);
  expect((await c.put({ modelId: "", switches: [] })).statusCode).toBe(400);
});

// ── §7.6 (2026-07-08): baseline drift + provenance source + the /state summary ─

/** A router with every §7.6 dep injected. `holder` is a mutable one-key object {now: {...}}
 * so a test can move today's defaults AFTER an apply — exactly the drift scenario. */
function clientWithDeps(holder, measurements, classConfigs) {
  return makeClient({
    resolveBaseline: () => ({ ...holder.now }),
    measurementsFn: () => measurements,
    classKeyFn: () => "vram8|ram32",
    classConfigsFn: () => classConfigs,
  });
}

test("apply_stores_baseline_and_reports_drift", async () => {
  const holder = { now: { ctx_len: "8192", mlock: "true" } };
  const c = clientWithDeps(holder, [], []);
  const r = (await c.put({ modelId: "m1", switches: [{ flagName: "ctx_len", flagValue: "32768" }] })).json();
  expect(r.driftCount).toBe(0); // today's defaults == the baseline stored at apply
  // The defaults MOVE after the apply (a global/class edit): drift is per-key — one changed
  // value + one new key = 2.
  holder.now = { ctx_len: "16384", mlock: "true", no_mmap: "true" };
  const g = await c.get("/v1/ai/model-tunes?modelId=m1");
  expect(g.driftCount).toBe(2);
  // Remove → back to no tune, no drift claim.
  const d = await c.del("/v1/ai/model-tunes?modelId=m1");
  expect(d.rows).toEqual([]);
  expect(d.driftCount).toBeNull();
});

test("pre_baseline_tune_reports_unknowable_drift", async () => {
  const holder = { now: { ctx_len: "8192" } };
  const c = clientWithDeps(holder, [], []);
  // A tune written WITHOUT a baseline (the pre-§7.6 path / a legacy row).
  stores.getModelTuneStore().replace("old", "test-key", [{ flagName: "threads", flagValue: "8" }], null);
  const g = await c.get("/v1/ai/model-tunes?modelId=old");
  expect(g.rows.length).toBeGreaterThan(0);
  expect(g.driftCount).toBeNull();
});

test("source_auto_when_rows_equal_an_autotune_trial_else_hand", async () => {
  const trial = { source: "autotune", switches: [{ flagName: "n_cpu_moe", flagValue: "21" }] };
  const c = clientWithDeps({ now: {} }, [trial], []);
  // Applied == the trial verbatim → auto.
  const r = (await c.put({ modelId: "m1", switches: [{ flagName: "n_cpu_moe", flagValue: "21" }] })).json();
  expect(r.source).toBe("auto");
  // A hand tweak after the sweep → hand.
  const r2 = (await c.put({ modelId: "m1", switches: [{ flagName: "n_cpu_moe", flagValue: "20" }] })).json();
  expect(r2.source).toBe("hand");
});

test("state_summarizes_tuned_and_class_configured_models", async () => {
  const trial = { source: "autotune", switches: [{ flagName: "threads", flagValue: "8" }] };
  const classConfigs = [
    { modelId: "gemma", classKey: "vram8|ram32", rows: [{ flagName: "ctx_len", flagValue: "32768" }] },
    { modelId: "qwen", classKey: "vram24|ram64", rows: [{ flagName: "ctx_len", flagValue: "65536" }] },
  ];
  const c = clientWithDeps({ now: {} }, [trial], classConfigs);
  await c.put({ modelId: "m1", switches: [{ flagName: "threads", flagValue: "8" }] });
  await c.put({ modelId: "m2", switches: [{ flagName: "threads", flagValue: "4" }] });
  const st = await c.get("/v1/ai/model-tunes/state");
  expect(st.hwKey).toBe("test-key");
  expect(st.classKey).toBe("vram8|ram32");
  expect(st.tuned).toEqual({ m1: "auto", m2: "hand" });
  // Only the config matching THIS box's class counts; the vram24 row does not.
  expect(st.classConfigured).toEqual(["gemma"]);
});

// ── machineKey (D2 — whole machine, not GPU-only) ────────────────────────────

const hw = (o) => model(HardwareInfo, o);
const gpu = (o) => model(GpuInfo, o);

test("machine_key_gpu_shape", () => {
  const h = hw({
    os: "Windows",
    platform: "windows",
    cpuCores: 8,
    ramMb: 32768,
    gpus: [gpu({ vendor: "NVIDIA", name: "NVIDIA GeForce RTX 2070 SUPER", vramMb: 8192, driver: "551.61" })],
  });
  expect(machineKey(h)).toBe("NVIDIA GeForce RTX 2070 SUPER|8192|8c|32g");
});

test("machine_key_cpu_only_and_ram_rounding", () => {
  const h = hw({ os: "Linux", platform: "linux", cpuCores: 6, ramMb: 32700, gpus: [] });
  expect(machineKey(h)).toBe("cpu|6c|31g"); // whole-GB floor absorbs MB jitter
});

test("machine_key_differs_on_cpu_ram_not_just_gpu", () => {
  // Two boxes with the SAME GPU but different CPU/RAM must not collide — threads/batch are
  // CPU/RAM-bound (the D2 point).
  const g = gpu({ vendor: "NVIDIA", name: "RTX 4090", vramMb: 24576 });
  const a = hw({ os: "l", platform: "linux", cpuCores: 8, ramMb: 32768, gpus: [g] });
  const b = hw({ os: "l", platform: "linux", cpuCores: 16, ramMb: 65536, gpus: [g] });
  expect(machineKey(a)).not.toBe(machineKey(b));
});

test("machine_key_picks_largest_gpu", () => {
  const h = hw({
    os: "l",
    platform: "linux",
    cpuCores: 8,
    ramMb: 65536,
    gpus: [gpu({ vendor: "NVIDIA", name: "RTX 3060", vramMb: 12288 }), gpu({ vendor: "NVIDIA", name: "RTX 4090", vramMb: 24576 })],
  });
  expect(machineKey(h).startsWith("RTX 4090|24576|")).toBe(true);
});
