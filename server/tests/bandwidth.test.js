// SPDX-License-Identifier: MIT
// Port of tests/test_bandwidth.py — the Phase 3 bandwidth ladder (runner/bandwidth): device
// arithmetic, the RAM probe, and the §13.8 derivation rule (config-known, un-sped,
// pool-matched; flagless rows NEVER qualify).
//
// Python patched `bandwidth._nvidia_query` (its own import of hardware's function); here
// bandwidth calls it through the hardware module, so the spy sits on `hardware._nvidiaQuery`.
//
// The last two (probe_persists_its_measurement, persisted_probe_row_is_reused_without_re_probing)
// drive `RunnerService.hostProbeBwGbps` on a service built without its constructor
// (Python's `__new__`): `Object.create(RunnerService.prototype)` + the fields it reads.
// Python's monkeypatch of `bw.probe_ram_copy_gbps` → `vi.spyOn(bandwidth, "probeRamCopyGbps")`
// (lifecycle calls it through the bandwidth namespace).
import { expect, test, vi } from "vitest";
import { sleep } from "../src/platform/asyncutil.js";
import * as bandwidth from "../src/runner/bandwidth.js";
import { DEFAULT_BW_EFF_HOST_PROBE } from "../src/runner/config.js";
import * as hardware from "../src/runner/hardware.js";
import { RunnerService } from "../src/runner/lifecycle.js";

test("nvidia_bw_arithmetic", async () => {
  // 2070 SUPER registers: 256-bit bus × 7001 MHz × 2 (DDR) ÷ 8 = 448.06 GB/s — matching the
  // vendor spec sheet; two cards → the larger wins.
  vi.spyOn(hardware, "_nvidiaQuery").mockResolvedValue("256, 7001\n128, 6001\n");
  expect(Math.abs((await bandwidth.nvidiaMemBwGbps()) - 448.064)).toBeLessThan(0.1);
  vi.spyOn(hardware, "_nvidiaQuery").mockResolvedValue(null);
  expect(await bandwidth.nvidiaMemBwGbps()).toBeNull();
  vi.spyOn(hardware, "_nvidiaQuery").mockResolvedValue("[N/A], [N/A]\n");
  expect(await bandwidth.nvidiaMemBwGbps()).toBeNull();
});

test("ram_probe_returns_a_plausible_number", async () => {
  // A tiny probe (16 MB) keeps the test fast; any real machine streams RAM at whole GB/s —
  // the point is "a positive, sane number", not a benchmark.
  const gbps = await bandwidth.probeRamCopyGbps(16, 2);
  expect(gbps).not.toBeNull();
  expect(gbps).toBeGreaterThan(0.5);
  expect(gbps).toBeLessThan(2000);
});

const MK = "gpu|8192|16c|32g";

function facts(modelId = "dense-a", { dense = true } = {}) {
  if (dense) {
    // KV scalars sized so KV(4096) ≈ 201 MB — the 12B's iSWA-windowed shape (the raw
    // uniform projection would be ~1.6 GB and is not this model).
    return {
      [modelId]: {
        n_layers: 48,
        mtp: false,
        size_mb: 6716.0,
        non_expert_mb: 6716.0,
        active_expert_mb: 0.0,
        kv_facts: { kv_global_bytes_per_token: 24576.0, kv_windowed_bytes_per_token: 0.0, block_count: 48 },
      },
    };
  }
  return {
    [modelId]: {
      n_layers: 30,
      mtp: false,
      size_mb: 14249.0,
      non_expert_mb: 871.0,
      active_expert_mb: 836.0,
      kv_facts: { kv_global_bytes_per_token: 8192.0, kv_windowed_bytes_per_token: 0.0, block_count: 30 },
    },
  };
}

function row(modelId = "dense-a", { tokS = 39.1, switches = null, machine = MK, backend = "cuda" } = {}) {
  return {
    model_id: modelId,
    machine_key: machine,
    backend,
    tokens_per_sec: tokS,
    switches: switches !== null ? switches : { "n-gpu-layers": "48", "ctx-size": "4096" },
  };
}

test("device_derivation_from_a_full_offload_dense_row", () => {
  // tok/s × bytes/pass: the whole file + KV(ctx from the recorded switches).
  const got = bandwidth.deriveDeviceBwGbps([row()], facts(), { machineKey: MK, backend: "cuda" });
  expect(got).not.toBeNull();
  expect(got).toBeGreaterThanOrEqual(250); // 39.1 × ~6.9 GB ≈ 270 — the §5.5 shape
  expect(got).toBeLessThanOrEqual(290);
});

test("derivation_rule_exclusions", () => {
  const f = facts();
  const kw = { machineKey: MK, backend: "cuda" };
  // Flagless rows NEVER qualify (§13.14 — placement unknown).
  expect(bandwidth.deriveDeviceBwGbps([row("dense-a", { switches: {} })], f, kw)).toBeNull();
  // No recorded ctx → the KV term is unknown → config-unknown → excluded.
  expect(bandwidth.deriveDeviceBwGbps([row("dense-a", { switches: { "n-gpu-layers": "48" } })], f, kw)).toBeNull();
  // Speculative rows are excluded outright (acceptance is not the multiplier).
  expect(
    bandwidth.deriveDeviceBwGbps(
      [row("dense-a", { switches: { "n-gpu-layers": "48", "ctx-size": "4096", "model-draft": "d.gguf" } })],
      f,
      kw,
    ),
  ).toBeNull();
  // An MTP model's rows are excluded (built-in heads may arm outside switches).
  const mtpFacts = facts();
  mtpFacts["dense-a"].mtp = true;
  expect(bandwidth.deriveDeviceBwGbps([row()], mtpFacts, kw)).toBeNull();
  // Another machine / another backend / a legacy ""-backend row: not this pool.
  expect(bandwidth.deriveDeviceBwGbps([row("dense-a", { machine: "other|1|2c|4g" })], f, kw)).toBeNull();
  expect(bandwidth.deriveDeviceBwGbps([row("dense-a", { backend: "vulkan" })], f, kw)).toBeNull();
  expect(bandwidth.deriveDeviceBwGbps([row("dense-a", { backend: "" })], f, kw)).toBeNull();
  // Partial offload (ngl < layers) is not the clean full-device shape.
  expect(
    bandwidth.deriveDeviceBwGbps([row("dense-a", { switches: { "n-gpu-layers": "20", "ctx-size": "4096" } })], f, kw),
  ).toBeNull();
});

test("host_derivation_prices_the_device_leg_and_solves_the_rest", () => {
  // 26B all-experts-in-RAM at 8.6 tok/s: device leg 871+KV(16k)≈1416 MB at 268.8 → the
  // remaining time is the 836 MB expert gather → ~7.5 GB/s.
  const f = facts("moe-a", { dense: false });
  const r = row("moe-a", { tokS: 8.6, switches: { "n-gpu-layers": "30", "n-cpu-moe": "30", "ctx-size": "16384" } });
  const got = bandwidth.deriveHostBwGbps([r], f, { machineKey: MK, backend: "cuda", deviceEffGbps: 268.8 });
  expect(got).not.toBeNull();
  expect(got).toBeGreaterThanOrEqual(5);
  expect(got).toBeLessThanOrEqual(11);
  // No device estimate → unsolvable → null (never a guess).
  expect(bandwidth.deriveHostBwGbps([r], f, { machineKey: MK, backend: "cuda", deviceEffGbps: null })).toBeNull();
});

test("resolve_ladder_order_and_families", async () => {
  // No measurements: device falls to nvidia-reported × the device family; host falls to the
  // probe × the probe's OWN factor (its copy underruns streaming — the generic host factor
  // under-banded every MoE, the 2026-08-13 checkpoint catch).
  vi.spyOn(bandwidth, "nvidiaMemBwGbps").mockResolvedValue(448.0);
  let [dev, host] = await bandwidth.resolveEffectiveBw({
    rows: [],
    factsById: {},
    machineKey: MK,
    backend: "cuda",
    isMacos: false,
    classVramBwGbps: 224.0,
    classRamBwGbps: 51.2,
    probeGbps: 40.0,
    effDevice: 0.6,
    effHost: 0.15,
    effHostProbe: 0.4,
  });
  expect(Math.abs(dev - 448.0 * 0.6)).toBeLessThan(0.01);
  expect(Math.abs(host - 40.0 * 0.4)).toBeLessThan(0.01);
  // Device unreported (AMD box): the class seed carries source 3; no probe → the class RAM
  // seed. A source-1 row outranks everything and is ALREADY effective (no factor).
  vi.spyOn(bandwidth, "nvidiaMemBwGbps").mockResolvedValue(null);
  [dev, host] = await bandwidth.resolveEffectiveBw({
    rows: [row()],
    factsById: facts(),
    machineKey: MK,
    backend: "cuda",
    isMacos: false,
    classVramBwGbps: 224.0,
    classRamBwGbps: 51.2,
    probeGbps: null,
    effDevice: 0.6,
    effHost: 0.15,
  });
  expect(dev).toBeGreaterThanOrEqual(250); // measured-derived, factor-free
  expect(dev).toBeLessThanOrEqual(290);
  expect(Math.abs(host - 51.2 * 0.15)).toBeLessThan(0.01);
  // Nothing anywhere → [null, null]: the badge shows no band, never a guess.
  [dev, host] = await bandwidth.resolveEffectiveBw({
    rows: [],
    factsById: {},
    machineKey: MK,
    backend: "vulkan",
    isMacos: false,
    classVramBwGbps: 0.0,
    classRamBwGbps: 0.0,
    probeGbps: null,
    effDevice: 0.6,
    effHost: 0.15,
  });
  expect(dev).toBeNull();
  expect(host).toBeNull();
});

test("speed_check_rung_sits_between_derivation_and_the_memcpy_probe", async () => {
  // Speed-truth plan 2026-09-19 §6/§11.4: the one-minute speed check's GB/s is llama.cpp's
  // own expert streaming — already effective (no factor) — and outranks the memcpy probe ×
  // 0.40; a real model measured here still wins.
  vi.spyOn(bandwidth, "nvidiaMemBwGbps").mockResolvedValue(null);
  const kw = {
    machineKey: MK,
    backend: "cuda",
    isMacos: false,
    classVramBwGbps: 224.0,
    classRamBwGbps: 51.2,
    effDevice: 0.6,
    effHost: 0.15,
    effHostProbe: 0.4,
  };
  // The author's box, 2026-09-19: check 27.5, probe 18.37 → the check wins.
  let [, host] = await bandwidth.resolveEffectiveBw({ rows: [], factsById: {}, probeGbps: 18.37, moeProbeGbps: 27.5, ...kw });
  expect(host).toBe(27.5);
  // No check run → the probe rung, exactly as before.
  [, host] = await bandwidth.resolveEffectiveBw({ rows: [], factsById: {}, probeGbps: 18.37, moeProbeGbps: null, ...kw });
  expect(Math.abs(host - 18.37 * 0.4)).toBeLessThan(0.01);
  // A qualifying real-model row (source 1) outranks the check: the flagship shape measured
  // with every expert in RAM (pass C's 26.6 tok/s, §11.4).
  const moeRow = row("moe-a", { tokS: 26.6, switches: { "n-gpu-layers": "30", "n-cpu-moe": "30", "ctx-size": "4096" } });
  const moeFacts = facts("moe-a", { dense: false });
  const [, derivedOnly] = await bandwidth.resolveEffectiveBw({ rows: [moeRow], factsById: moeFacts, probeGbps: null, ...kw });
  expect(derivedOnly).not.toBeNull();
  expect(derivedOnly).toBeGreaterThan(0);
  [, host] = await bandwidth.resolveEffectiveBw({
    rows: [moeRow],
    factsById: moeFacts,
    probeGbps: 18.37,
    moeProbeGbps: 27.5,
    ...kw,
  });
  expect(host).toBe(derivedOnly);
});

test("probe_factor_calibration_pin", () => {
  // The §5.5 probe calibration, done LIVE 2026-08-13 on the author's desktop: the probe there
  // reads 19.01 GB/s; the measured-model host-effective window on the same box is 6.9–10.6
  // GB/s. The seeded probe factor must place the probe-sourced effective INSIDE that window
  // (the generic 0.15 gave 2.85 — far below it). 2026-09-19: that window is STALE for engine
  // b10437 (the host leg measured ~29 GB/s); 0.40 is kept DELIBERATELY as the pessimistic
  // fallback rung under the one-minute speed check — this pin guards the value.
  const effective = 19.01 * DEFAULT_BW_EFF_HOST_PROBE;
  expect(effective >= 6.9 && effective <= 10.6, String(effective)).toBe(true);
  expect(19.01 * 0.15 >= 6.9 && 19.01 * 0.15 <= 10.6).toBe(false); // the bug this calibration fixed
});

test("apple_chip_table_matches_longest_name_first", () => {
  // Pure table check (no Mac needed): "M1 Ultra" must not read as "M1".
  const table = Object.fromEntries(bandwidth._APPLE_CHIP_BW_GBPS);
  expect(table["M1 Ultra"]).toBe(800.0);
  expect(table.M1).toBe(68.25);
  const names = bandwidth._APPLE_CHIP_BW_GBPS.map(([n]) => n);
  expect(names.indexOf("M1 Ultra")).toBeLessThan(names.indexOf("M1"));
  expect(names.indexOf("M4 Max")).toBeLessThan(names.indexOf("M4"));
});

test("probe_is_topology_aware", async () => {
  // The threaded pass helper works (parallel streams, sane number) and the public probe
  // reports at least the single-stream reading — on a wide memory system the threaded pass
  // wins, on a controller-bound box the single one does.
  const single = await bandwidth._copyPassGbps([bandwidth._probeBuf(16)], 2);
  const multi = await bandwidth._copyPassGbps([bandwidth._probeBuf(8), bandwidth._probeBuf(8)], 2);
  expect(single > 0.5 && single < 2000).toBe(true);
  expect(multi > 0.5 && multi < 2000).toBe(true);
  const best = await bandwidth.probeRamCopyGbps(16, 2);
  expect(best).not.toBeNull();
  expect(best).toBeGreaterThanOrEqual(Math.min(single, multi) * 0.5); // loose: noise-tolerant
});

// ── The RAM probe must actually LAND (2026-08-14) ────────────────────

/** A RunnerService with no persisted probe row and a recorder we can watch. */
function probeService(recorder) {
  const svc = Object.create(RunnerService.prototype);
  svc._probeStarted = false;
  svc._probeValue = null;
  svc._recordProbeFn = recorder;
  svc.measurementRows = () => []; // nothing persisted yet
  return svc;
}

test("probe_persists_its_measurement", async () => {
  // The self-heal has to complete: measure AND record. A probe that measures but never lands
  // leaves every speed band on the class-facts rung forever, and that used to fail at debug
  // level where nobody would see it.
  const recorded = [];
  vi.spyOn(bandwidth, "probeRamCopyGbps").mockResolvedValue(19.0);
  const svc = probeService((g, mk, mid) => recorded.push([g, mk, mid]));

  expect(RunnerService.prototype.hostProbeBwGbps.call(svc, "machine-1")).toBeNull(); // kicked, not landed
  for (let i = 0; i < 200 && !recorded.length; i++) await sleep(10); // the probe runs as its own task
  expect(recorded.length, "the probe measured but never recorded — the silent-failure case").toBeGreaterThan(0);
  expect(recorded[0][0]).toBe(19.0);
  expect(recorded[0][2]).toBe(bandwidth.RAM_PROBE_MODEL_ID);
});

test("persisted_probe_row_is_reused_without_re_probing", () => {
  // Once landed, it's read back — the probe is a one-time cost per box.
  vi.spyOn(bandwidth, "probeRamCopyGbps").mockImplementation(() => {
    throw new Error("re-probed despite a persisted row");
  });
  const svc = probeService(null);
  svc.measurementRows = () => [{ modelId: bandwidth.RAM_PROBE_MODEL_ID, machineKey: "machine-1", tokensPerSec: 21.5 }];
  expect(RunnerService.prototype.hostProbeBwGbps.call(svc, "machine-1")).toBe(21.5);
});
