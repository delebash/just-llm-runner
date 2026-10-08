// SPDX-License-Identifier: MIT
// Port of the auto-tune half of tests/test_measurements.py — the record seam: every OK trial
// persists to the measurement history; a history-write failure never harms the sweep. (The
// store + /v1/ai/model-measurements tests of that file are tests/measurements.test.js.)
//
// Python imported `BASE, FakeService, _run_to_end` from test_autotune; a vitest file can't
// import another test file (its tests would register here), so the three are repeated below,
// trimmed to what these two tests drive.
import { expect, test } from "vitest";
import { AutoTuner } from "../src/runner/autotune.js";

/** test_autotune's FakeService: tok/s per n_cpu_moe; a value in `fail` never reaches running. */
class FakeService {
  constructor({ tpsByNcmoe = null, fail = [], block = 30, isMoe = true } = {}) {
    this.tpsByNcmoe = tpsByNcmoe || {};
    this.fail = new Set(fail.map(String));
    this.block = block;
    this.isMoe = isMoe;
    this.loads = [];
    this._current = null;
    this.stops = 0;
    this.embeds = 0;
  }

  previewFit() {
    return { ok: true, blockCount: this.block, isMoe: this.isMoe, nGpuLayers: 99, nCpuMoe: this.block, ctxLen: 8192 };
  }

  stop() {
    this.stops += 1;
    this._current = null;
  }

  ensureEmbedding() {
    this.embeds += 1;
    return { ok: true };
  }

  load(modelId, { switches = null } = {}) {
    this.loads.push({ ...(switches || {}) });
    this._current = [modelId, String((switches || {}).n_cpu_moe ?? "")];
    return { status: "starting" };
  }

  status() {
    if (this._current === null) return { status: "idle" };
    const [mid, ncmoe] = this._current;
    if (this.fail.has(ncmoe)) return { status: "error", error: `OOM at n_cpu_moe ${ncmoe}`, modelId: mid };
    return { status: "running", modelId: mid };
  }

  measure({ maxTokens = 0 } = {}) {
    const key = this._current[1] || "base";
    const tps = Object.hasOwn(this.tpsByNcmoe, key) ? this.tpsByNcmoe[key] : 10.0;
    return { ok: true, tokensPerSec: tps, completionTokens: maxTokens, ms: 1000.0, vramTotalMb: 7000 };
  }
}

const BASE = { n_cpu_moe: "21", batch_size: "512", ubatch_size: "512", threads: "8" };

async function runToEnd(tuner, modelId, base, opts) {
  const st = tuner.start(modelId, base, opts);
  expect(st.status).toBe("running");
  await tuner._task;
  return tuner.status();
}

// ── the auto-tune record seam (offline, the FakeService harness) ──────────────

test("autotune_records_every_ok_trial_with_its_switches", async () => {
  const recorded = [];
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 28.0, 19: 26.0 } });
  const st = await runToEnd(new AutoTuner(() => svc, { sleep: () => {} }), "m", BASE, {
    recordFn: (mid, t) => recorded.push([mid, t]),
  });
  expect(st.status).toBe("done");
  const okTrials = st.trials.filter((t) => t.ok);
  expect(recorded.map(([, t]) => t.label)).toEqual(okTrials.map((t) => t.label));
  expect(recorded.every(([mid]) => mid === "m")).toBe(true);
  // the recorded trial carries the exact switches that produced the number
  const baseRec = recorded.map(([, t]) => t).find((t) => t.label === "baseline");
  expect(baseRec.switches.n_cpu_moe).toBe("21");
});

test("autotune_skips_failed_trials_and_survives_a_broken_recorder", async () => {
  // A trial that never reaches running records nothing; a recorder that THROWS must neither
  // kill the sweep nor mark it errored (history is an enrichment).
  const calls = [];
  const boom = (_mid, trial) => {
    calls.push(trial.label);
    throw new Error("history db is on fire");
  };
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 28.0, 19: 26.0 }, fail: ["23"] });
  const st = await runToEnd(new AutoTuner(() => svc, { sleep: () => {} }), "m", BASE, { recordFn: boom });
  expect(st.status).toBe("done");
  expect(st.error).toBeFalsy();
  expect(calls).not.toContain("n-cpu-moe 23"); // the failed trial never recorded
  expect(calls.length).toBeGreaterThan(0); // the OK trials still hit the sink
});
