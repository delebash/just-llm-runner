// SPDX-License-Identifier: MIT
// Port of tests/test_calibrate.py — the one-minute speed check (speed-truth plan
// docs/plans/2026-09-19-speed-truth-and-calibrated-pick.md §6 / §11.4). The fakes replay the
// spike's REAL numbers from the author's box, so the expected result is the live measurement:
// pass A 2.668 ms/token, pass B 9.320 → 182.8 MB / 6.652 ms = 27.48 GB/s.
//
// Python's fake Popen object (poll/terminate/wait) is a plain object here — the spawn seam
// reads `exitCode` (null = running) and calls `kill()`. Python's monkeypatch of
// `calibrate.stream_download` is `vi.spyOn(download, "streamDownload")`; of
// `calibrate._ENGINE_WAIT`, `calibrate.settings.ENGINE_WAIT`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { model } from "../src/platform/models.js";
import { createServer } from "../src/platform/server.js";
import { MOE_PROBE_MODEL_ID, moeProbeLabel } from "../src/runner/bandwidth.js";
import * as calibrate from "../src/runner/calibrate.js";
import * as download from "../src/runner/download.js";
import { HardwareInfo, RunnerConfig } from "../src/runner/schema.js";

const BLOB = Buffer.from("not really a gguf - the job only hashes it");
const SHA = createHash("sha256").update(BLOB).digest("hex");

const tmpPath = () => mkdtempSync(join(tmpdir(), "kit-calib-"));

const dgpuBox = () =>
  model(HardwareInfo, {
    os: "Windows",
    platform: "windows",
    cpuCores: 16,
    ramMb: 32768,
    gpus: [{ vendor: "NVIDIA", name: "RTX 2070 SUPER", vramMb: 8192 }],
    runtimes: { cuda: true },
  });

const cpuBox = () => model(HardwareInfo, { os: "Linux", platform: "linux", cpuCores: 8, ramMb: 16000, gpus: [] });

const macBox = () => model(HardwareInfo, { os: "Darwin", platform: "macos", cpuCores: 10, ramMb: 32768, gpus: [] });

class Svc {
  constructor(tmp, { exe = true } = {}) {
    this.cacheRoot = join(tmp, "cache");
    this.runtimeRoot = join(tmp, "runtime");
    mkdirSync(join(this.cacheRoot, "calib"), { recursive: true });
    writeFileSync(join(this.cacheRoot, "calib", `${SHA}.gguf`), BLOB); // already downloaded
    this._exe = exe ? join(tmp, "llama-server.exe") : null;
    this.recorded = [];
    this.stopped = 0;
  }

  config() {
    return model(RunnerConfig, {
      llamacpp: { pinnedBuild: "b10437" },
      calibModelUrl: "https://example.invalid/calib.gguf",
      calibModelSha256: SHA,
      calibModelSizeBytes: BLOB.length,
      calibActiveExpertMb: 182.8,
      calibNonexpertMb: 88.7,
    });
  }

  installedExe() {
    return this._exe;
  }

  installedBuild() {
    return "b10437";
  }

  stop(_modelId = null) {
    this.stopped += 1;
    return {};
  }

  recordMachineProbe(gbps, mkey, modelId, label) {
    this.recorded.push([gbps, mkey, modelId, label]);
    return true;
  }

  hostMoeBwGbps(_mkey) {
    return null;
  }
}

/** A running child that never exits on its own (Python's `_Proc`). */
const fakeProc = () => ({ exitCode: null, signalCode: null, kill() {} });

function makeCalibrator(svc, hardware, { perTokA = 2.668, perTokB = 9.32, runsB = null } = {}) {
  const argvs = [];
  const popen = (argv, _opts) => {
    argvs.push([...argv]);
    return fakeProc();
  };
  const calls = { b: 0 };
  const post = (_url, body) => {
    const isB = argvs.at(-1).includes("--n-cpu-moe");
    let msTok = isB ? perTokB : perTokA;
    if (isB && runsB) {
      calls.b += 1;
      msTok = runsB[Math.min(calls.b - 1, runsB.length - 1)];
    }
    const n = body.max_tokens;
    return { timings: { predicted_n: n, predicted_ms: msTok * n } };
  };
  const cal = new calibrate.Calibrator(() => svc, {
    hardwareFn: () => hardware,
    popen,
    httpPost: post,
    health: () => true,
    sleep: () => {},
  });
  return [cal, argvs];
}

async function run(cal) {
  cal._state = { ...calibrate.Calibrator._fresh("running") };
  await cal._run(); // to the end — the task body
  return cal.status();
}

afterEach(() => {
  calibrate.settings.ENGINE_WAIT = 900.0;
});

test("check_mode_by_memory_topology", () => {
  expect(calibrate.checkMode(dgpuBox())[0]).toBe("two-pass");
  expect(calibrate.checkMode(cpuBox())[0]).toBe("one-pass");
  const [mode, reason] = calibrate.checkMode(macBox());
  expect(mode).toBe("");
  expect(reason).toContain("memory"); // one pool — nothing to split
});

test("two_pass_replays_the_spike_and_records_a_build_stamped_row", async () => {
  const svc = new Svc(tmpPath());
  const [cal, argvs] = makeCalibrator(svc, dgpuBox());
  const st = await run(cal);
  expect(st.status, JSON.stringify(st)).toBe("done");
  expect(Math.abs(st.gbps - 27.48)).toBeLessThan(0.05); // 182.8 / (9.320 − 2.668)
  expect(svc.stopped).toBe(1); // a clean GPU before measuring
  // Pass A all-GPU, pass B experts forced to RAM — the exact spike flags.
  expect(argvs[0].slice(-2)).toEqual(["-ngl", "99"]);
  expect(argvs[1].slice(-4)).toEqual(["-ngl", "99", "--n-cpu-moe", "999"]);
  const [gbps, _mkey, modelId, label] = svc.recorded[0];
  expect(modelId).toBe(MOE_PROBE_MODEL_ID);
  expect(label).toBe(moeProbeLabel("b10437"));
  expect(Math.abs(gbps - 27.48)).toBeLessThan(0.05);
});

test("one_pass_on_a_gpu_less_box_prices_every_byte_from_ram", async () => {
  const svc = new Svc(tmpPath());
  const [cal, argvs] = makeCalibrator(svc, cpuBox(), { perTokA: 13.5 });
  const st = await run(cal);
  expect(st.status, JSON.stringify(st)).toBe("done");
  expect(argvs.length).toBe(1);
  expect(argvs[0].slice(-2)).toEqual(["-ngl", "0"]);
  expect(Math.abs(st.gbps - (182.8 + 88.7) / 13.5)).toBeLessThan(0.05);
});

test("passes_too_close_to_tell_apart_record_nothing", async () => {
  const svc = new Svc(tmpPath());
  const [cal] = makeCalibrator(svc, dgpuBox(), { perTokA: 9.0, perTokB: 9.5 }); // delta 5 % of t_B
  const st = await run(cal);
  expect(st.status).toBe("error");
  expect(st.error).toContain("too close");
  expect(svc.recorded).toEqual([]);
});

test("unstable_readings_record_nothing", async () => {
  const svc = new Svc(tmpPath());
  const [cal] = makeCalibrator(svc, dgpuBox(), { runsB: [9.3, 9.3, 9.3, 14.0] }); // warm-up + 3 runs
  const st = await run(cal);
  expect(st.status).toBe("error");
  expect(st.error).toContain("varied");
  expect(svc.recorded).toEqual([]);
});

test("one_pool_machine_is_refused", async () => {
  const svc = new Svc(tmpPath());
  const [cal, argvs] = makeCalibrator(svc, macBox());
  const st = await run(cal);
  expect(st.status).toBe("error");
  expect(argvs).toEqual([]);
});

test("a_checksum_mismatch_deletes_the_file", async () => {
  const svc = new Svc(tmpPath());
  const target = join(svc.cacheRoot, "calib", `${SHA}.gguf`);
  writeFileSync(target, "corrupted"); // present but wrong → re-download
  vi.spyOn(download, "streamDownload").mockImplementation(async (_url, dest) => {
    writeFileSync(dest, "still wrong");
  });
  const [cal] = makeCalibrator(svc, dgpuBox());
  const st = await run(cal);
  expect(st.status).toBe("error");
  expect(st.error).toContain("checksum");
  expect(existsSync(target)).toBe(false);
  expect(svc.recorded).toEqual([]);
});

// Not in the Python file: the speed-check router, each answer as FastAPI gave it through
// TestClient on 2026-10-07 (make_calibrate_router over the same fakes).
test("the speed-check router answers as FastAPI did", async () => {
  const svc = new Svc(tmpPath());
  const cal = new calibrate.Calibrator(() => svc, { hardwareFn: dgpuBox });
  const mount = (hardwareFn) => {
    const app = createServer({ typeBase: "https://example.test/errors/" });
    app.route("/", calibrate.makeCalibrateRouter({ calibratorFn: () => cal, serviceFn: () => svc, hardwareFn }));
    return app;
  };
  const app = mount(dgpuBox);
  const call = async (method, url, a = app) => (await a.request(url, { method })).text();
  expect(await call("GET", "/v1/llm-runner/calibrate")).toBe(
    '{"status":"idle","phase":"","detail":"","error":"","done":0,"total":0,"gbps":null,"passes":{},"mode":"two-pass","reason":"","configured":true,"sizeBytes":42,"measuredGbps":null}',
  );
  svc.hostMoeBwGbps = () => 27.5;
  expect(await call("POST", "/v1/llm-runner/calibrate/cancel")).toBe(
    '{"status":"idle","phase":"","detail":"","error":"","done":0,"total":0,"gbps":null,"passes":{}}',
  );
  cal._state = { ...calibrate.Calibrator._fresh("running") };
  expect(await call("POST", "/v1/llm-runner/calibrate")).toBe(
    '{"status":"running","phase":"","detail":"","error":"a speed check is already running","done":0,"total":0,"gbps":null,"passes":{},"ok":false}',
  );
  expect(await call("POST", "/v1/llm-runner/calibrate/cancel")).toBe(
    '{"status":"running","phase":"","detail":"stopping…","error":"","done":0,"total":0,"gbps":null,"passes":{}}',
  );
  expect(await call("GET", "/v1/llm-runner/calibrate", mount(macBox))).toBe(
    '{"status":"running","phase":"","detail":"stopping…","error":"","done":0,"total":0,"gbps":null,"passes":{},"mode":"","reason":"this machine\'s graphics share system memory — there is no second memory pool to measure","configured":true,"sizeBytes":42,"measuredGbps":27.5}',
  );
});

test("no_engine_waits_then_fails_cleanly", async () => {
  const svc = new Svc(tmpPath(), { exe: false });
  calibrate.settings.ENGINE_WAIT = 0.0;
  const [cal, argvs] = makeCalibrator(svc, dgpuBox());
  const st = await run(cal);
  expect(st.status).toBe("error");
  expect(st.error.toLowerCase()).toContain("engine");
  expect(argvs).toEqual([]);
});
