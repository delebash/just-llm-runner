// SPDX-License-Identifier: MIT
// Port of tests/test_runner_models.py — GET /v1/llm-runner/models, the catalog view with
// hardware Fit + status.
//
// Hardware / runner-service are injected, so the Fit bands and status mapping are exercised
// with no GPU and no download. Python patched `api.detect` / `api.get_service`; the JS router
// reaches them through their namespaces, so the tests spy `hardware.detect` and
// `lifecycle.getService`. The VRAM safety margin comes from the service's RunnerConfig.
//
// Waits for runner/lifecycle.js (wave 3) — they need the REAL RunnerService and run (skipIf)
// once the port replaces the skeleton:
//   models_endpoint_real_camelcase, real_service_knows_whether_a_catalog_was_wired.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { model } from "../src/platform/models.js";
import { createServer } from "../src/platform/server.js";
import { runnerRouter } from "../src/runner/api.js";
import * as bandwidth from "../src/runner/bandwidth.js";
import { defaultConfig } from "../src/runner/config.js";
import * as hardware from "../src/runner/hardware.js";
import * as lifecycle from "../src/runner/lifecycle.js";
import { Overrides } from "../src/runner/process.js";
import { HardwareInfo, ModelEntry, RunnerConfig } from "../src/runner/schema.js";

/** The skeleton's RunnerService throws "not ported yet"; the real port doesn't. */
const LIFECYCLE_READY = !String(lifecycle.RunnerService).includes("not ported yet");

const TEST_CONFIG = model(RunnerConfig, { llamacpp: { pinnedBuild: "bTEST" }, safetyMarginMb: 1024 });

function client() {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(runnerRouter);
  return {
    get: async (url) => app.inject({ method: "GET", url }),
    post: async (url, payload) => app.inject({ method: "POST", url, ...(payload !== undefined ? { payload } : {}) }),
  };
}

function mkModel(mid, minVramMb, { minRamMb = null, totalParams = "14B" } = {}) {
  return model(ModelEntry, {
    id: mid,
    name: mid.toUpperCase(),
    tier: "mid",
    hfRepo: `org/${mid}-GGUF`,
    quant: "Q4_K_M",
    totalParams,
    minRamMb,
    recommendedFor: { minVramMb },
  });
}

const hwOf = (fields) => model(HardwareInfo, fields);

class FakeService {
  constructor(models, { resident = null, status = null, catalogWired = true } = {}) {
    this._models = [...(models || [])];
    // modelsView reads the resident set (P1f) for per-model status; router-down/empty by
    // default → every model falls through to disk/available. (Fit no longer reads anything
    // off the service — it scores the DETECTED card, user decree 2026-07-06.)
    this._resident = resident || { router: false, modelsMax: 2, sleepIdleSeconds: 900, models: [] };
    this._status = status || { status: "idle", modelId: "", url: "", detail: "", error: "" };
    this.cacheRoot = "/nonexistent-cache-root";
    // Did a host wire a catalog source? These tests all supply one, so true by default; the
    // unwired case has its own test at the bottom of this file (2026-08-01).
    this.catalogWired = catalogWired;
  }

  status() {
    return this._status;
  }

  resident(_hw = null) {
    return this._resident;
  }

  catalog() {
    return this._models;
  }

  config() {
    return this._cfg ?? TEST_CONFIG; // safetyMarginMb=1024
  }

  downloadStatus() {
    return { downloads: {} }; // per-model map; empty == nothing downloading
  }

  opProgress() {
    // The live operation behind `status` (2026-08-14). Empty by default — tests that
    // exercise a bar set `_ops`.
    return this._ops ?? {};
  }

  modelDownloaded(_m, _hfCache) {
    // Nothing is on disk in these endpoint tests → no model reads "downloaded".
    return false;
  }

  ensureEmbedding() {
    // Tests set `_ensure` to the configured shape; default is the no-local-embed case.
    return this._ensure ?? { ok: false, detail: "no local embedding model configured" };
  }

  // ── Phase 3 speed-badge reads (bandwidth ladder) — the unwired defaults: no measurements,
  // no class bandwidths, no probe → every row keeps band "" (the honest-unknown shape).
  measurementRows() {
    return this._measurements ?? [];
  }

  classBw(_classKey) {
    return this._classBw ?? [0.0, 0.0];
  }

  hostProbeBwGbps(_machineKey) {
    return this._probeGbps ?? null;
  }

  hostMoeBwGbps(_machineKey) {
    return this._moeProbeGbps ?? null;
  }
}

/** A resident-set object (router up) from [id, status] pairs — what service.resident()
 * returns and the models view's statusFor reads. */
function residentOf(...idsAndStatuses) {
  return {
    router: true,
    modelsMax: 2,
    sleepIdleSeconds: 900,
    models: idsAndStatuses.map(([id, status]) => ({ id, status })),
  };
}

function patch({ hw, svc }) {
  if (hw !== undefined) vi.spyOn(hardware, "detect").mockResolvedValue(hw);
  vi.spyOn(lifecycle, "getService").mockReturnValue(svc);
}

function patchModels({ hw, models, resident = null, catalogWired = true }) {
  patch({ hw, svc: new FakeService(models, { resident, catalogWired }) });
}

const GPU_4070 = { vendor: "nvidia", name: "RTX 4070", vramMb: 12288 };

test("fit_bands_on_a_12gb_gpu", async () => {
  // usable = 12288 - 1024 = 11264; ratio = need / usable
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [GPU_4070] });
  const models = [
    mkModel("small", 6000), // override 6000 -> ratio 0.53 -> ok
    mkModel("mid", 14000), // override 14000 -> ratio 1.24 -> tight
    mkModel("huge", 40000), // override 40000 -> ratio 3.55 -> no
    mkModel("nohint", null), // no override -> 14B×0.6=8400 -> ok
    mkModel("noparams", null, { totalParams: null }), // no override, no params -> unknown
  ];
  patchModels({ hw, models }); // no resident → all available
  const body = (await client().get("/v1/llm-runner/models")).json();
  expect(body.vramMb).toBe(12288);
  expect(body.safetyMarginMb).toBe(1024);
  const fit = Object.fromEntries(body.models.map((m) => [m.id, m.fit]));
  expect(fit).toEqual({ small: "ok", mid: "tight", huge: "no", nohint: "ok", noparams: "unknown" });
  // All available (none cached, none loaded).
  expect(body.models.every((m) => m.status === "available")).toBe(true);
});

test("cpu_only_machine", async () => {
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 16000, gpus: [] });
  const models = [
    mkModel("fits-ram", 8000, { minRamMb: 8000 }), // CPU + enough RAM -> cpu
    mkModel("too-big-ram", 8000, { minRamMb: 64000 }), // CPU but RAM too small -> no
  ];
  patchModels({ hw, models }); // no resident → fit bands only
  const body = (await client().get("/v1/llm-runner/models")).json();
  expect(Object.fromEntries(body.models.map((m) => [m.id, m.fit]))).toEqual({ "fits-ram": "cpu", "too-big-ram": "no" });
});

test("fit_scores_total_card_even_with_models_resident", async () => {
  // User decree 2026-07-06 ("fix it"): Fit answers "how does this model run on this CARD",
  // never "what fits this instant". A resident model must not change Fit; the load-moment
  // budget is the arbiter's job.
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [GPU_4070] });
  const models = [mkModel("mid", 14000)]; // whole card: 14000/(12288-1024)=1.24 → tight
  // A resident model is committed (would have shrunk the old budget to 4288 → 'no'):
  patch({ hw, svc: new FakeService(models, { resident: residentOf(["mid", "sleeping"]) }) });
  const c = client();
  const body = (await c.get("/v1/llm-runner/models")).json();
  expect(body.models[0].fit).toBe("tight"); // the card's answer, resident or not
  expect(body.vramMb).toBe(12288); // the response reports the card, matching the labels
  // The card-chooser override (the vram_mb query param) stays: score the given VRAM as-is (a
  // hypothetical card; 0 = CPU-only).
  expect((await c.get("/v1/llm-runner/models?vram_mb=12288")).json().models[0].fit).toBe("tight");
});

test("status_reflects_loaded_model", async () => {
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [GPU_4070] });
  const models = [mkModel("running-one", 6000), mkModel("other", 6000)];
  patchModels({ hw, models, resident: residentOf(["running-one", "loaded"]) });
  const body = (await client().get("/v1/llm-runner/models")).json();
  expect(Object.fromEntries(body.models.map((m) => [m.id, m.status]))).toEqual({ "running-one": "loaded", other: "available" });
});

test("status_reflects_co_resident_set", async () => {
  // Router mode: MULTIPLE models resident at once — each shows its own status. A sleeping
  // model still reads 'loaded' in the catalog (it is resident, reloadable instantly; the
  // precise word is on /resident); an 'unloaded' section that isn't on disk → available.
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [GPU_4070] });
  const models = [mkModel("chat", 6000), mkModel("embed", 2000), mkModel("cold", 6000)];
  patchModels({ hw, models, resident: residentOf(["chat", "loaded"], ["embed", "sleeping"], ["cold", "unloaded"]) });
  const body = (await client().get("/v1/llm-runner/models")).json();
  expect(Object.fromEntries(body.models.map((m) => [m.id, m.status]))).toEqual({
    chat: "loaded",
    embed: "loaded",
    cold: "available",
  });
});

test("status_reflects_load_error", async () => {
  // A load that errored (e.g. engine-not-installed → the router never spawned) is carried by
  // resident()'s in-flight overlay as 'error', so the catalog shows 'error' (→ the UI's
  // install-engine CTA) rather than silently 'available'.
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [] });
  patchModels({
    hw,
    models: [mkModel("boom", 6000)],
    resident: { router: false, modelsMax: 2, sleepIdleSeconds: 900, models: [{ id: "boom", status: "error" }] },
  });
  const body = (await client().get("/v1/llm-runner/models")).json();
  expect(Object.fromEntries(body.models.map((m) => [m.id, m.status]))).toEqual({ boom: "error" });
});

test("status_reflects_download_channel", async () => {
  // A download-only op runs on its OWN channel — the downloading model shows "loading" via
  // statusFor even though the run-state (status()) is idle.
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [GPU_4070] });
  const svc = new FakeService([mkModel("dl-one", 6000), mkModel("other", 6000)]); // router-down; the download channel drives status
  // Per-model download map: {modelId: entry}. Only "dl-one" is downloading.
  svc.downloadStatus = () => ({
    downloads: { "dl-one": { status: "downloading", modelId: "dl-one", detail: "", error: "", downloaded: 0, total: 0 } },
  });
  patch({ hw, svc });
  const body = (await client().get("/v1/llm-runner/models")).json();
  expect(Object.fromEntries(body.models.map((m) => [m.id, m.status]))).toEqual({ "dl-one": "loading", other: "available" });
});

test.skipIf(!LIFECYCLE_READY)("models_endpoint_real_camelcase", async () => {
  // No per-call patching — exercise the real endpoint with a clean default-backed service
  // (empty standalone catalog), confirming the camelCase contract. (Waits for lifecycle.)
  await hardware.ensureDetected();
  await lifecycle.configureService({ configFn: defaultConfig, cacheRoot: mkdtempSync(join(tmpdir(), "kit-rm-")) });
  const r = await client().get("/v1/llm-runner/models");
  expect(r.statusCode).toBe(200);
  const body = r.json();
  expect("vramMb" in body && "safetyMarginMb" in body && "models" in body).toBe(true);
  for (const m of body.models) {
    expect(["ok", "tight", "no", "cpu", "unknown"]).toContain(m.fit);
    expect(["loaded", "loading", "error", "disk", "available"]).toContain(m.status);
    expect("minVramMb" in m).toBe(true); // camelCase alias present
  }
});

test("resident_endpoint_camelcase", async () => {
  // GET /v1/llm-runner/resident: the live set serialized camelCase (modelsMax /
  // sleepIdleSeconds / nParams / sizeBytes / nCtx) via RunnerResidentResponse. The service's
  // dict may carry the snake_case field names (populate_by_name) — as Python's does.
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [] });
  const svc = new FakeService([], {
    resident: {
      router: true,
      models_max: 3,
      sleep_idle_seconds: 600,
      vram_total_mb: 8000,
      committed_mb: 5000,
      remaining_mb: 3000,
      models: [{ id: "chat", status: "loaded", n_params: 7, size_bytes: 9, n_ctx: 4096, vram_mb: 5000 }],
    },
  });
  patch({ hw, svc });
  const body = (await client().get("/v1/llm-runner/resident")).json();
  expect(body.router).toBe(true);
  expect(body.modelsMax).toBe(3);
  expect(body.sleepIdleSeconds).toBe(600);
  expect(body.vramTotalMb).toBe(8000);
  expect(body.committedMb).toBe(5000);
  expect(body.remainingMb).toBe(3000);
  const row = body.models[0];
  expect(row.id).toBe("chat");
  expect(row.status).toBe("loaded");
  expect(row.nParams).toBe(7);
  expect(row.sizeBytes).toBe(9);
  expect(row.nCtx).toBe(4096);
  expect(row.vramMb).toBe(5000);
});

test("resident_endpoint_router_down", async () => {
  // Router not up (lazy-spawn, nothing loaded) → router:false, empty set, the knob defaults.
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [] });
  patch({ hw, svc: new FakeService([]) });
  const body = (await client().get("/v1/llm-runner/resident")).json();
  expect(body.router).toBe(false);
  expect(body.models).toEqual([]);
  expect(body.modelsMax).toBe(2);
  expect(body.sleepIdleSeconds).toBe(900);
});

test("load_carries_new_flags_into_overrides", async () => {
  // POST /load: the EXPLICIT field-by-field LoadRequest → Overrides constructor must carry
  // modelDraft + reasoningBudget(+Message) — LoadRequest fields without this wiring would be
  // silently dead (Plan B D6, wiring point 3).
  const captured = {};
  patch({
    svc: {
      load(_modelId, { overrides = null } = {}) {
        captured.ov = overrides;
        return { status: "loading" };
      },
    },
  });
  const r = await client().post("/v1/llm-runner/load", {
    modelId: "m1",
    modelDraft: "/d/MTP/g-Q4_0-MTP.gguf",
    reasoningBudget: 1024,
    reasoningBudgetMessage: "wrap up now",
  });
  expect(r.statusCode).toBe(200);
  const ov = captured.ov;
  expect(ov).toBeInstanceOf(Overrides);
  expect(ov.modelDraft).toBe("/d/MTP/g-Q4_0-MTP.gguf");
  expect(ov.reasoningBudget).toBe(1024);
  expect(ov.reasoningBudgetMessage).toBe("wrap up now");
});

test("ensure_embedding_endpoint_configured", async () => {
  // P3 lazy prep: a configured local embed → ok:true + the modelId the client polls /resident for.
  const svc = new FakeService([]);
  svc._ensure = { ok: true, modelId: "nomic-embed-text", status: "starting" };
  patch({ svc });
  const body = (await client().post("/v1/llm-runner/ensure-embedding")).json();
  expect(body.ok).toBe(true);
  expect(body.modelId).toBe("nomic-embed-text");
});

test("ensure_embedding_endpoint_not_configured", async () => {
  // No local embed configured (routing points at Ollama/cloud) → ok:false; the caller falls back.
  patch({ svc: new FakeService([]) });
  const body = (await client().post("/v1/llm-runner/ensure-embedding")).json();
  expect(body.ok).toBe(false);
});

// ── catalogWired: telling "nothing downloaded yet" from "no catalog wired" ──────
// Both states return `models: []`, and until 2026-08-01 the endpoint could not tell them
// apart — a new consumer mounting the router saw an empty list and no reason for it.

test("models_reports_catalog_wired_when_a_host_supplied_one", async () => {
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 16000, gpus: [] });
  patchModels({ hw, models: [mkModel("a", 4000)], catalogWired: true });
  expect((await client().get("/v1/llm-runner/models")).json().catalogWired).toBe(true);
});

test("models_says_catalog_unwired_and_an_EMPTY_wired_catalog_does_not", async () => {
  // The bite: an empty list alone must not be read as 'unwired'. A host that wired a catalog
  // which happens to hold nothing reports wired=true — the two states are distinguishable in
  // BOTH directions, which is the entire point of the field.
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 16000, gpus: [] });

  patchModels({ hw, models: [], catalogWired: false });
  const unwired = (await client().get("/v1/llm-runner/models")).json();
  expect(unwired.models).toEqual([]);
  expect(unwired.catalogWired).toBe(false);

  patchModels({ hw, models: [], catalogWired: true });
  const wiredButEmpty = (await client().get("/v1/llm-runner/models")).json();
  expect(wiredButEmpty.models).toEqual([]);
  expect(wiredButEmpty.catalogWired).toBe(true);
});

test.skipIf(!LIFECYCLE_READY)("real_service_knows_whether_a_catalog_was_wired", async () => {
  // Against the REAL RunnerService, not the double: the standalone default reports unwired,
  // and configureService({catalogFn}) flips it. This is what the endpoint's answer is derived
  // from, so it is the claim that actually has to hold. (Waits for lifecycle — Python reset
  // `lifecycle._service` with monkeypatch; the JS name of that module variable is the
  // lifecycle port's to choose: `lifecycle.state.service` is a guess.)
  const prev = lifecycle.state.service;
  try {
    vi.stubEnv("LLM_RUNNER_CACHE", mkdtempSync(join(tmpdir(), "kit-rm-")));
    lifecycle.state.service = null;
    expect((await lifecycle.getService()).catalogWired, "standalone default must read unwired").toBe(false);

    lifecycle.state.service = null;
    const svc = await lifecycle.configureService({ catalogFn: () => [] });
    expect(svc.catalogWired, "a host-supplied catalogFn must read wired").toBe(true);
  } finally {
    lifecycle.state.service = prev;
  }
});

// ── Phase 3: feasibility × speed band, shipped together (§5.4/§8.3) ───────────

const flag = (flagName, flagValue) => ({ flagName, flagValue });

const meas = (modelId, tokensPerSec, machineKey, backend = "cuda", switches = []) => ({
  modelId,
  tokensPerSec,
  machineKey,
  backend,
  switches: [...switches],
});

function moeWithFacts(mid = "flagship") {
  const m = mkModel(mid, null, { totalParams: "26B" });
  m.sizeBytes = 14_249_000_000;
  m.trainedCtx = 131072;
  m.experts = 128;
  // The 26B shape: iSWA scalars sized so KV(32k) ≈ 881 MB (Appendix B).
  m.physicsFacts = {
    block_count: 30,
    n_kv_heads: 16,
    expert_used_count: 8,
    expert_byte_share: 0.9389,
    kv_windowed_bytes_per_token: 102636.0,
    kv_global_bytes_per_token: 10236.0,
    sliding_window: 1024,
  };
  return m;
}

const authorBox = () =>
  hwOf({
    os: "Windows",
    platform: "windows",
    cpuCores: 16,
    ramMb: 32768,
    gpus: [{ vendor: "NVIDIA", name: "RTX 2070 SUPER", vramMb: 8192 }],
    runtimes: { cuda: true },
  });

// The band MAPPING pins below predate the dead zone (speed-truth plan 2026-09-19 §5) and their
// ~8.7 prediction sits inside its default ±10 % of the 8.0 line — so they run with the dead
// zone OFF; the dead zone has its own pins further down.
const NO_DEADZONE = { ...TEST_CONFIG, bandDeadzoneFrac: 0.0 };

test("band_rides_the_fit_and_factless_rows_stay_bandless", async () => {
  const hw = authorBox();
  const svc = new FakeService([moeWithFacts(), mkModel("bare", 6000)]);
  svc._cfg = NO_DEADZONE;
  svc._classBw = [448.0, 51.2]; // ladder source 3 (no measurements, no probe)
  patch({ hw, svc });
  const body = (await client().get("/v1/llm-runner/models")).json();
  const rows = Object.fromEntries(body.models.map((m) => [m.id, m]));
  // The MoE at the seeded constants: device leg ~1.75 GB @ 268.8 effective + expert leg
  // 836 MB @ 7.68 effective → ~8.7 tok/s → "fine" (the ≥8 line).
  const bandRow = rows.flagship;
  expect(bandRow.speedBand).toBe("fine");
  expect(bandRow.predTokS >= 6 && bandRow.predTokS <= 12).toBe(true);
  expect(bandRow.measuredTokS).toBeNull();
  // No header facts → NO band, never a guess — the chip shows plain fit.
  expect(rows.bare.speedBand).toBe("");
  expect(rows.bare.predTokS).toBeNull();
});

test("measured_outranks_predicted_for_value_and_band", async () => {
  const hw = authorBox();
  const svc = new FakeService([moeWithFacts()]);
  svc._cfg = NO_DEADZONE;
  svc._classBw = [448.0, 51.2];
  // A real measured run on THIS box + backend (the July campaign's 28.6): the row shows it,
  // and the band is computed FROM it (fast ≥ 20), not from the ~8.7 prediction. Newest-first
  // order is the store's contract.
  svc._measurements = [meas("flagship", 28.6, hardware.machineKey(hw), "cuda", [flag("n-cpu-moe", "21"), flag("ctx-size", "16384")])];
  patch({ hw, svc });
  const c = client();
  let row = (await c.get("/v1/llm-runner/models")).json().models[0];
  expect(row.measuredTokS).toBe(28.6);
  expect(row.speedBand).toBe("fast");
  // A different box's measurement must NOT be claimed for this one.
  svc._measurements = [meas("flagship", 28.6, "other|1|2c|4g", "cuda")];
  row = (await c.get("/v1/llm-runner/models")).json().models[0];
  expect(row.measuredTokS).toBeNull();
  expect(row.speedBand).toBe("fine");
});

test("prediction_in_the_dead_zone_ships_no_word", async () => {
  // Speed-truth plan 2026-09-19 §5: the same ~8.7 prediction at the DEFAULT dead zone (±10 %)
  // sits 8.75 % above the 8.0 fine-line — the chip must get the number, not a word the next
  // probe reading could flip. predTokS still ships.
  const hw = authorBox();
  const svc = new FakeService([moeWithFacts()]);
  svc._classBw = [448.0, 51.2];
  patch({ hw, svc });
  const row = (await client().get("/v1/llm-runner/models")).json().models[0];
  expect(row.speedBand).toBe("");
  expect(row.predTokS > 8.0 && row.predTokS <= 8.8, String(row.predTokS)).toBe(true);
  expect(row.measuredTokS).toBeNull();
});

test("payload_root_carries_the_pick_floor_inputs", async () => {
  // Speed-truth plan 2026-09-19 §7: the pure picker computes its floor from the SAME
  // thresholds the bands used — bandFineToks × (1 − speedFloorGrace).
  const hw = authorBox();
  const svc = new FakeService([moeWithFacts()]);
  svc._classBw = [448.0, 51.2];
  patch({ hw, svc });
  const body = (await client().get("/v1/llm-runner/models")).json();
  expect(body.bandFineToks).toBe(8.0);
  expect(body.speedFloorGrace).toBe(0.2);
});

test("the_speed_check_rung_moves_the_prediction", async () => {
  // With the one-minute check's GB/s on record the host leg is priced at it (no factor) — the
  // ~8.7 class-seeded prediction jumps, and the flagship leaves the dead zone for a real word.
  const hw = authorBox();
  const svc = new FakeService([moeWithFacts()]);
  svc._classBw = [448.0, 51.2];
  svc._moeProbeGbps = 29.18; // the real run on the author's box, 2026-09-19
  patch({ hw, svc });
  const row = (await client().get("/v1/llm-runner/models")).json().models[0];
  expect(row.predTokS >= 20, String(row.predTokS)).toBe(true);
  expect(row.speedBand).toBe("fast");
});

test("a_measured_speed_near_a_line_keeps_its_word", async () => {
  // The dead zone is for PREDICTIONS only: a real measurement of 7.9 on this box is honestly
  // "slow" — it keeps the word even inside ±10 % of 8.0.
  const hw = authorBox();
  const svc = new FakeService([moeWithFacts()]);
  svc._classBw = [448.0, 51.2];
  svc._measurements = [meas("flagship", 7.9, hardware.machineKey(hw), "cuda")];
  patch({ hw, svc });
  const row = (await client().get("/v1/llm-runner/models")).json().models[0];
  expect(row.measuredTokS).toBe(7.9);
  expect(row.speedBand).toBe("slow");
});

test("ran_here_flags_this_box_evidence", async () => {
  // §7.4-as-ranking: ANY persisted row for this machine — here a Phase 5 load FOOTPRINT
  // (tok/s 0, so measuredTokS stays null) — flags ranHere, the evidence bit the
  // recommendation ranking reads so the estimate can never veto a model this box has
  // demonstrably run. Another box's row proves nothing here.
  const hw = authorBox();
  const svc = new FakeService([moeWithFacts()]);
  svc._measurements = [meas("flagship", 0, hardware.machineKey(hw), "cuda", [flag("n_gpu_layers", "30")])];
  patch({ hw, svc });
  const c = client();
  let row = (await c.get("/v1/llm-runner/models")).json().models[0];
  expect(row.ranHere).toBe(true);
  expect(row.measuredTokS).toBeNull();
  svc._measurements = [meas("flagship", 0, "other|1|2c|4g", "cuda")];
  row = (await c.get("/v1/llm-runner/models")).json().models[0];
  expect(row.ranHere).toBe(false);
});

test("no_bandwidth_source_means_no_band", async () => {
  // An AMD/Intel box with no class row: nvidia-smi absent, class (0,0), no probe yet → the
  // host pool is unpriced → band "" (§8.17: an unknown never becomes a number). Feasibility
  // still renders.
  const hw = hwOf({
    os: "Windows",
    platform: "windows",
    cpuCores: 8,
    ramMb: 32768,
    gpus: [{ vendor: "AMD", name: "RX 7600", vramMb: 8192 }],
    runtimes: { vulkan: true },
  });
  const svc = new FakeService([moeWithFacts()]);
  vi.spyOn(bandwidth, "nvidiaMemBwGbps").mockResolvedValue(null); // hermetic — the dev box HAS nvidia-smi
  patch({ hw, svc });
  const row = (await client().get("/v1/llm-runner/models")).json().models[0];
  expect(row.speedBand).toBe("");
  expect(row.predTokS).toBeNull();
  expect(row.fit).toBeTruthy(); // feasibility unaffected
});

// ── The operation behind `status` rides the row (2026-08-14) ─────────

test("row_carries_the_live_operation_so_a_bar_needs_no_browser_task", async () => {
  // One control, one source (user ruling): the row itself carries the caption, byte counters
  // and error text, so a reloaded page — or any second surface — renders the SAME bar the
  // page that started the operation sees.
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [GPU_4070] });
  const svc = new FakeService([mkModel("m1", 4096), mkModel("m2", 4096)]);
  svc._resident = residentOf(["m1", "downloading"], ["m2", "error"]);
  svc._ops = {
    m1: { detail: "model weights", done: 512, total: 2048, error: "" },
    m2: { detail: "", done: 0, total: 0, error: "engine-not-installed" },
  };
  patch({ hw, svc });

  const body = (await client().get("/v1/llm-runner/models")).json();
  const rows = Object.fromEntries(body.models.map((r) => [r.id, r]));
  expect(rows.m1.status).toBe("loading");
  expect(rows.m1.detail).toBe("model weights");
  expect([rows.m1.opDone, rows.m1.opTotal]).toEqual([512, 2048]);
  expect(rows.m1.error).toBe("");
  // The failure travels too — this is what the empty husk could never show.
  expect(rows.m2.status).toBe("error");
  expect(rows.m2.error).toBe("engine-not-installed");
});

// Not in the Python file: the router's edge answers, each as FastAPI gave it through
// TestClient on 2026-10-07 (api.router over a recording service) — 422 shapes, the
// populate_by_name body names, optional and dict bodies, query parsing.
test("the runner router answers as FastAPI did", async () => {
  const calls = [];
  const svc = new Proxy(
    {},
    {
      get: (_t, name) =>
        name === "then"
          ? undefined
          : (...args) => {
              calls.push([name, args]);
              return { called: name };
            },
    },
  );
  vi.spyOn(lifecycle, "getService").mockReturnValue(svc);
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(runnerRouter);
  const send = async (method, url, { json, raw } = {}) => {
    calls.length = 0;
    const opts = { method, url };
    if (json !== undefined) Object.assign(opts, { payload: JSON.stringify(json), headers: { "content-type": "application/json" } });
    if (raw !== undefined) Object.assign(opts, { payload: raw, headers: { "content-type": "application/json" } });
    const r = await app.inject(opts);
    return { status: r.statusCode, body: r.body ? r.json() : null, calls: calls.map(([n, a]) => [n, ...a]) };
  };
  const v422 = (instance, errors) => ({
    status: 422,
    body: {
      type: "https://example.test/errors/validation-error",
      title: "Validation Error",
      status: 422,
      detail: "Request body failed validation.",
      errors,
      instance,
    },
    calls: [],
  });
  const missingBody = [{ loc: ["body"], msg: "Field required", type: "missing" }];
  const notDict = [{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }];
  const notModel = [{ loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", type: "model_attributes_type" }];
  const extra = (k) => [{ loc: ["body", k], msg: "Extra inputs are not permitted", type: "extra_forbidden" }];
  const intParse = (k) => [{ loc: ["query", k], msg: "Input should be a valid integer, unable to parse string as an integer", type: "int_parsing" }];
  const L = "/v1/llm-runner/load";
  const C = "/v1/llm-runner/download/cancel";

  // POST /load — LoadRequest (strict, populate_by_name).
  expect(await send("POST", L)).toEqual(v422(L, missingBody));
  let r = await send("POST", L, { json: { model_id: "x" } });
  expect([r.status, r.calls[0][0], r.calls[0][1]]).toEqual([200, "load", "x"]);
  expect(r.calls[0][2].jobId).toBeNull();
  expect(r.calls[0][2].trigger).toBe("api");
  expect(await send("POST", L, { json: { modelId: "x", model_id: "y" } })).toEqual(v422(L, extra("model_id")));
  expect(await send("POST", L, { json: { modelId: "", junk: 1 } })).toEqual(v422(L, extra("junk")));
  r = await send("POST", L, { json: { modelId: "" } });
  expect(r.status).toBe(400);
  expect(r.body).toEqual({
    type: "https://example.test/errors/bad-request",
    title: "Bad Request",
    status: 400,
    detail: "modelId required",
    instance: L,
  });
  r = await send("POST", L, { json: { modelId: "a", nGpuLayers: "12" } });
  expect(r.status).toBe(200);
  expect(r.calls[0][2].overrides.nGpuLayers).toBe(12);
  expect(await send("POST", L, { json: { modelId: "a", nGpuLayers: 1.5 } })).toEqual(
    v422(L, [{ loc: ["body", "nGpuLayers"], msg: "Input should be a valid integer, got a number with a fractional part", type: "int_from_float" }]),
  );
  expect(await send("POST", L, { json: [1] })).toEqual(v422(L, notModel));
  expect(await send("POST", L, { raw: "{bad" })).toEqual(v422(L, [{ loc: ["body", "1"], msg: "JSON decode error", type: "json_invalid" }]));
  expect(await send("POST", L, { raw: "" })).toEqual(v422(L, missingBody));

  // POST /download/cancel — `DownloadCancelRequest | None = None`.
  for (const opt of [{}, { raw: "" }, { raw: "null" }, { json: {} }, { raw: '{"modelId": null}' }]) {
    expect((await send("POST", C, opt)).calls).toEqual([["cancelDownload", null]]);
  }
  expect((await send("POST", C, { json: { modelId: "m" } })).calls).toEqual([["cancelDownload", "m"]]);
  expect((await send("POST", C, { json: { model_id: "m" } })).calls).toEqual([["cancelDownload", "m"]]);
  expect(await send("POST", C, { json: { modelId: "m", x: 1 } })).toEqual(v422(C, extra("x")));
  expect(await send("POST", C, { json: [1] })).toEqual(v422(C, notModel));
  expect(await send("POST", C, { json: "str" })).toEqual(v422(C, notModel));

  // POST /stop and /engine/install — `dict | None = None`; /tokenize — `dict` (required).
  expect((await send("POST", "/v1/llm-runner/stop")).calls).toEqual([["stop", null]]);
  expect((await send("POST", "/v1/llm-runner/stop", { raw: "" })).calls).toEqual([["stop", null]]);
  expect((await send("POST", "/v1/llm-runner/stop", { json: { modelId: 5 } })).calls).toEqual([["stop", "5"]]);
  expect(await send("POST", "/v1/llm-runner/stop", { json: [1] })).toEqual(v422("/v1/llm-runner/stop", notDict));
  expect(await send("POST", "/v1/llm-runner/stop", { json: "s" })).toEqual(v422("/v1/llm-runner/stop", notDict));
  expect(await send("POST", "/v1/llm-runner/tokenize")).toEqual(v422("/v1/llm-runner/tokenize", missingBody));
  expect((await send("POST", "/v1/llm-runner/tokenize", { json: { text: 5 } })).calls).toEqual([["tokenize", { text: "5" }]]);
  expect(await send("POST", "/v1/llm-runner/tokenize", { json: [1] })).toEqual(v422("/v1/llm-runner/tokenize", notDict));
  expect(
    (await send("POST", "/v1/llm-runner/engine/install", { json: { force: "false", replaceBuild: 5, gpu: null } })).calls,
  ).toEqual([["installEngine", { force: true, replaceBuild: "5", gpu: "" }]]);

  // Query parameters.
  expect(await send("GET", "/v1/llm-runner/engine/log?tail=abc")).toEqual(v422("/v1/llm-runner/engine/log", intParse("tail")));
  expect(await send("GET", "/v1/llm-runner/engine/log?tail=")).toEqual(v422("/v1/llm-runner/engine/log", intParse("tail")));
  expect((await send("GET", "/v1/llm-runner/engine/log?tail=12.0")).calls).toEqual([["engineLog", { tail: 12 }]]);
  expect((await send("GET", "/v1/llm-runner/engine/log")).calls).toEqual([["engineLog", { tail: 200 }]]);
  expect(await send("GET", "/v1/llm-runner/engine/resolve-assets")).toEqual(
    v422("/v1/llm-runner/engine/resolve-assets", [{ loc: ["query", "build"], msg: "Field required", type: "missing" }]),
  );
  expect((await send("GET", "/v1/llm-runner/engine/resolve-assets?build=")).calls).toEqual([["resolveBuildAssets", ""]]);
  expect(await send("POST", "/v1/llm-runner/measure?max_tokens=x")).toEqual(v422("/v1/llm-runner/measure", intParse("max_tokens")));
  expect((await send("POST", "/v1/llm-runner/measure?model_id=m&max_tokens=7&prompt=hi")).calls).toEqual([
    ["measure", { prompt: "hi", maxTokens: 7, modelId: "m" }],
  ]);
  expect((await send("POST", "/v1/llm-runner/measure")).calls).toEqual([
    ["measure", { prompt: "Write one vivid paragraph about the sea.", maxTokens: 128, modelId: null }],
  ]);
  expect(await send("GET", "/v1/llm-runner/gpu-processes?fresh=maybe")).toEqual(
    v422("/v1/llm-runner/gpu-processes", [
      { loc: ["query", "fresh"], msg: "Input should be a valid boolean, unable to interpret input", type: "bool_parsing" },
    ]),
  );
  expect(await send("GET", "/v1/llm-runner/models?vram_mb=abc")).toEqual(v422("/v1/llm-runner/models", intParse("vram_mb")));
  expect(await send("GET", "/v1/llm-runner/models?vram_mb=")).toEqual(v422("/v1/llm-runner/models", intParse("vram_mb")));
});

test("idle_rows_carry_an_empty_operation", async () => {
  // No operation → empty fields, never stale text from a previous one.
  const hw = hwOf({ os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [GPU_4070] });
  patch({ hw, svc: new FakeService([mkModel("m1", 4096)]) });
  const row = (await client().get("/v1/llm-runner/models")).json().models[0];
  expect([row.detail, row.error, row.opDone, row.opTotal]).toEqual(["", "", 0, 0]);
});
