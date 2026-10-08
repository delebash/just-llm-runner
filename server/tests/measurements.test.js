// SPDX-License-Identifier: MIT
// Port of tests/test_measurements.py — the persistent measurement history (#142 rows 5+6):
// the model_measurements store + the /v1/ai/model-measurements GET/POST/DELETE surface
// (server-stamped machineKey + at, per-model + clear-all semantics), Phase 5's footprint
// columns + keep-K retention, and the fit-relevant fingerprint set.
//
// NOT ported here — they wait for runner E (wave 3): the two auto-tune record-seam tests,
// `autotune_records_every_ok_trial_with_its_switches` and
// `autotune_skips_failed_trials_and_survives_a_broken_recorder`, drive `runner/autotune.js`'s
// AutoTuner through test_autotune.py's FakeService harness (`BASE`, `FakeService`,
// `_run_to_end`) — port them beside autotune.test.js once that file and its harness exist.
import { beforeEach, expect, test, vi } from "vitest";
import * as db from "../src/llm/db.js";
import { makeModelMeasurementsRouter } from "../src/llm/model_measurements_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

// stores.js imports switch_resolve.js (wave 2); a stand-in until it lands (fixtures/wave-stubs.js).
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));

let app;
beforeEach(() => {
  freshDb();
  app = createServer({ typeBase: "https://example.test/errors/" });
  // machineKeyFn injected — the SERVER stamps which box measured (one source).
  app.register(makeModelMeasurementsRouter(stores.getModelMeasurementStore, () => "gpu|8g|8c|32g"));
});

async function post(modelId, tps, switches = null, kw = {}) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/ai/model-measurements",
    payload: {
      modelId,
      tokensPerSec: tps,
      switches: Object.entries(switches || {}).map(([flagName, flagValue]) => ({ flagName, flagValue })),
      ...kw,
    },
  });
  return r.json();
}
const get = async (url) => (await app.inject({ method: "GET", url })).json();
const del = async (url) => (await app.inject({ method: "DELETE", url })).json();

test("post_records_with_server_stamped_identity_and_clock", async () => {
  const r = await post("m1", 31.5, { n_cpu_moe: "21", ctx_len: "32768" }, { label: "", vramTotalMb: 7200 });
  expect(r.machineKey).toBe("gpu|8g|8c|32g");
  expect(r.measurements).toHaveLength(1);
  const m = r.measurements[0];
  expect([m.modelId, m.source, m.tokensPerSec, m.vramTotalMb]).toEqual(["m1", "tune", 31.5, 7200]);
  expect(m.machineKey).toBe("gpu|8g|8c|32g"); // server-stamped, never client-supplied
  expect(m.at).toBeGreaterThan(0); // server clock, epoch ms
  expect(new Set(m.switches.map((s) => `${s.flagName}=${s.flagValue}`))).toEqual(new Set(["n_cpu_moe=21", "ctx_len=32768"]));
});

test("get_is_newest_first_and_model_filtered", async () => {
  // Python's three posts land in distinct milliseconds only by the clock's grace; the
  // newest-first order is (at desc, id desc), so equal stamps still read newest first.
  await post("m1", 10.0);
  await post("m2", 20.0);
  await post("m1", 30.0);
  const everything = (await get("/v1/ai/model-measurements")).measurements;
  expect(everything.map((m) => m.tokensPerSec)).toEqual([30.0, 20.0, 10.0]); // newest first
  const onlyM1 = await get("/v1/ai/model-measurements?modelId=m1");
  expect(onlyM1.measurements.map((m) => m.tokensPerSec)).toEqual([30.0, 10.0]);
});

test("clear_per_model_then_all", async () => {
  await post("m1", 10.0, { threads: "8" });
  await post("m2", 20.0);
  // Per-model clear (the Tune modal's Clear-history button) leaves other models.
  const r = await del("/v1/ai/model-measurements?modelId=m1");
  expect(r.measurements).toEqual([]);
  const rest = (await get("/v1/ai/model-measurements")).measurements;
  expect(rest.map((m) => m.modelId)).toEqual(["m2"]);
  // No modelId → the whole ledger; child switch rows die with their parents.
  await del("/v1/ai/model-measurements");
  expect((await get("/v1/ai/model-measurements")).measurements).toEqual([]);
  expect(db.session().count("measurement_switches")).toBe(0);
});

test("post_requires_model_id", async () => {
  const r = await app.inject({ method: "POST", url: "/v1/ai/model-measurements", payload: { modelId: " ", tokensPerSec: 1 } });
  expect(r.statusCode).toBe(400);
});

test("store_record_dedupes_and_skips_blank_flag_names", () => {
  const st = stores.getModelMeasurementStore();
  const mid = st.record("m1", {
    machineKey: "k",
    source: "tune",
    label: "",
    tokensPerSec: 1.0,
    vramTotalMb: 0,
    at: 5,
    rows: [
      { flagName: "a", flagValue: "1" },
      { flagName: "a", flagValue: "2" },
      { flagName: "  ", flagValue: "x" },
    ],
  });
  const rows = st.list("m1");
  expect(rows[0].id).toBe(mid);
  expect(rows[0].switches.map((f) => [f.flagName, f.flagValue])).toEqual([["a", "1"]]);
});

// ── Phase 5 (§6.3/§13.2): footprint columns + keep-K retention ───────────────

test("record_carries_footprint_and_kind_and_wire_declares_them", async () => {
  const st = stores.getModelMeasurementStore();
  st.record("m1", {
    machineKey: "box",
    source: "load",
    label: "load footprint (measured)",
    tokensPerSec: 0.0,
    vramTotalMb: 0,
    at: 1000,
    rows: [{ flagName: "ctx_len", flagValue: "32768" }],
    vramModelMb: 6500,
    kind: "llm",
  });
  const row = st.list("m1")[0];
  expect(row.vramModelMb).toBe(6500);
  expect(row.kind).toBe("llm");
  expect(row.source).toBe("load");
  // The HTTP wire must not strip the new fields (the documented response-model class).
  const wire = (await get("/v1/ai/model-measurements?modelId=m1")).measurements[0];
  expect(wire.vramModelMb).toBe(6500);
  expect(wire.kind).toBe("llm");
});

test("a_speech_speed_row_keeps_its_own_column_and_backend", async () => {
  // A speech model's real-time factor has its own column (never tokens_per_sec
  // reinterpreted) and names the backend that measured it, not the LLM's.
  const st = stores.getModelMeasurementStore();
  st.record("tts:kokoro:kokoro-82m-q8", {
    machineKey: "box",
    source: "speed",
    label: "CPU real-time factor",
    tokensPerSec: 0.0,
    vramTotalMb: 0,
    at: 1000,
    rows: [],
    kind: "tts",
    realtimeX: 3.15,
    backend: "cpu",
  });
  const row = st.list("tts:kokoro:kokoro-82m-q8")[0];
  expect(row.realtimeX).toBeCloseTo(3.15);
  expect(row.backend).toBe("cpu");
  expect(row.tokensPerSec).toBe(0.0);
  expect(row.kind).toBe("tts");
  const wire = await get("/v1/ai/model-measurements?modelId=tts:kokoro:kokoro-82m-q8");
  expect(wire.measurements[0].realtimeX).toBeCloseTo(3.15);
  // Every other row reads 0 there.
  st.record("m9", { machineKey: "box", source: "tune", label: "", tokensPerSec: 20.0, vramTotalMb: 8192, at: 1, rows: [] });
  expect(st.list("m9")[0].realtimeX).toBe(0.0);
});

test("prune_keeps_latest_k_per_fingerprint", () => {
  const st = stores.getModelMeasurementStore();
  const fset = new Set(["ctx_len", "n_gpu_layers"]);
  for (let i = 0; i < 5; i++) {
    // five loads at the SAME fingerprint
    st.record("m1", {
      machineKey: "box",
      source: "load",
      label: "",
      tokensPerSec: 0.0,
      vramTotalMb: 0,
      at: 1000 + i,
      rows: [
        { flagName: "ctx_len", flagValue: "32768" },
        { flagName: "threads", flagValue: String(i) }, // fit-IRRELEVANT
      ],
      vramModelMb: 6000 + i,
    });
  }
  // A DIFFERENT fingerprint (other ctx) must keep its own K, not be collateral.
  st.record("m1", {
    machineKey: "box",
    source: "load",
    label: "",
    tokensPerSec: 0.0,
    vramTotalMb: 0,
    at: 99,
    rows: [{ flagName: "ctx_len", flagValue: "4096" }],
    vramModelMb: 5000,
  });
  // A speed row is NEVER pruned by the load retention.
  st.record("m1", { machineKey: "box", source: "tune", label: "", tokensPerSec: 25.0, vramTotalMb: 8192, at: 50, rows: [] });
  const deleted = st.pruneLoadRows("m1", "box", fset, 3);
  expect(deleted).toBe(2); // 5 same-fingerprint rows → newest 3 survive
  const rows = st.list("m1");
  const loads = rows.filter((r) => r.source === "load");
  expect(loads).toHaveLength(4); // 3 kept + the other-fingerprint row
  expect(new Set(loads.map((r) => r.vramModelMb))).toEqual(new Set([6004, 6003, 6002, 5000]));
  expect(rows.some((r) => r.source === "tune")).toBe(true); // speed history untouched
});

test("fit_relevant_fingerprint_set_is_seeded", () => {
  // §13.3: the fingerprint IS knob_catalog's fit_relevant classification — exactly the ten
  // memory-shaping knobs, read from data, never a code list.
  const h = db.session();
  h.tx(() => seed.seedDefaultKnobs(h));
  expect(stores.listFitRelevantFlags()).toEqual(
    new Set([
      "ctx_len",
      "cache_type_k",
      "cache_type_v",
      "flash_attn",
      "n_cpu_moe",
      "n_gpu_layers",
      "no_kv_offload",
      "parallel",
      "batch_size",
      "ubatch_size",
    ]),
  );
});
