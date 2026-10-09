// SPDX-License-Identifier: MIT
// The one-minute speed check — llama.cpp measures how fast THIS box streams MoE expert bytes,
// so predictions stop resting on a memcpy probe × a factor (the port of
// llm_runner/runner/calibrate.py).
//
// Design + evidence: docs/plans/2026-09-19-speed-truth-and-calibrated-pick.md §6 (the
// mechanism), §11.4 (the spike that proved it: 27.5 GB/s on the author's box predicted the
// flagship's measured un-sped speed within 5 % — 25.3 vs 26.6 tok/s — where probe × 0.40
// said 8.4).
//
// WHAT it does: downloads one small MoE GGUF from the kit's own GitHub release (sha-pinned;
// the runner_setting `calib_*` rows name it), then launches the installed llama-server on it
// twice — everything on the GPU (pass A), then the routed experts forced into system RAM
// (pass B). Per token, pass A costs overhead + GPU bytes; pass B costs the same plus the
// expert bytes read from RAM; so `t_B − t_A` isolates the expert stream and cancels the fixed
// overhead that dominates a model this small (plan §6 "why the delta"). host GB/s = the
// file's active-expert MB per token / that delta. A GPU-less box runs one pass and prices
// every byte from RAM. The result persists as the `__machine_moe_bw__` pseudo-row
// (build-stamped label) — the ladder rung between real-model derivation and the memcpy probe
// (`bandwidth.resolveEffectiveBw`).
//
// WHAT it does NOT do: run on its own (Quick setup offers it, the user clicks), run on
// one-pool machines (Metal / unified / integrated — there is no second pool to measure), or
// feed per-model history (a pseudo-model id never matches a catalog row).
//
// Timing comes from llama.cpp's own response `timings` (predicted_ms / predicted_n), never
// wall clock: an antivirus scan of a freshly downloaded file lands in wall time and nowhere
// else. Every child goes through the ONE spawn seam (`process.spawnChild` — the Windows
// kill-on-close Job Object).
//
// ── The JS shape ────────────────────────────────────────────────────────────────────────
// Python's background thread is an async task (`this._task`); `_run()` is the task body and
// is awaitable directly (the tests run it to the end). Every service call is awaited.
// Injection points as in Python: `serviceFn`, `hardwareFn`, `popen`, `httpPost(url, body)`,
// `health(url)`, `sleep(seconds)`, `now()` (seconds). The spawned child is Node's
// ChildProcess (`process.js` reads `exitCode` / `kill()`), so a test's fake is a plain
// object `{exitCode: null, kill() {}}`.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { background, sleep as sleepMs } from "../platform/asyncutil.js";
import * as http from "../platform/http.js";
import { getLogger } from "../platform/log.js";
import * as procs from "../platform/procs.js";
import { pyFloatParse, pyInt, pyRound, pySorted, RuntimeError } from "../platform/py.js";
import { pyFixed } from "../platform/pyjson.js";
import { errStr } from "./autotune.js";
import { MOE_PROBE_MODEL_ID, moeProbeLabel } from "./bandwidth.js";
import * as download from "./download.js";
import * as hardware from "./hardware.js";
import * as lifecycle from "#runner/lifecycle";
import * as processMod from "./process.js";
import * as self from "./calibrate.js";

const log = getLogger("llm_runner.runner.calibrate");

// Method constants (the autotune precedent — how the measurement is taken, not operator
// tunables). Validated on the author's box 2026-09-19: 3 × 160 tokens after one warm-up held
// a 3.5 % / 6.1 % spread (plan §11.4).
const RUNS = 3;
const TOKENS = 160;
const CTX = 2048;
const PROMPT = "Write a long, detailed story about a lighthouse keeper.";
const HEALTH_TIMEOUT = 120.0; // a 0.8 GB model loads in ~3 s; this is for a slow disk + AV scan
const REQUEST_TIMEOUT = 120.0;
const MIN_DELTA_FRAC = 0.2; // t_B − t_A must be ≥ 20 % of t_B, else the reading is noise
const MAX_SPREAD = 0.15; // any run > 15 % from its pass median → no stable reading

/** Module values a test replaces (Python's monkeypatch of `calibrate._ENGINE_WAIT`). */
export const settings = {
  ENGINE_WAIT: 900.0, // Quick setup may still be installing the engine in parallel
};

const monotonic = () => performance.now() / 1000;

/**
 * ["two-pass" | "one-pass" | "", reason]. The same one-pool condition as the speed model
 * (`api.js` `speed`): an integrated/unified box with a GPU — or any Mac — has ONE memory
 * pool, so there is no split to measure.
 */
export function checkMode(hw) {
  const arch = hardware.memArch(hw);
  const gpus = hw.gpus || [];
  const onePool = (arch === "integrated" || arch === "unified") && (gpus.length > 0 || hw.platform === "macos");
  if (onePool) {
    return ["", "this machine's graphics share system memory — there is no second memory pool to measure"];
  }
  if (!gpus.length) return ["one-pass", ""];
  return ["two-pass", ""];
}

/** The file's sha256 (hex), read as a stream — the test model is ~0.8 GB. */
export function sha256Of(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(String(path), { highWaterMark: 8 * 1024 * 1024 });
    s.on("data", (b) => h.update(b));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** statistics.median: the middle value, or the mean of the two middle ones. */
function median(xs) {
  const s = pySorted(xs);
  const n = s.length;
  if (!n) throw new Error("no median for empty data");
  const m = Math.floor(n / 2);
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class Cancelled extends Error {
  constructor() {
    super("");
    this.name = "Cancelled";
  }
}

/** `requests.post(url, json=body, timeout=120).json()`. */
async function defaultHttpPost(url, body) {
  const r = await http.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: REQUEST_TIMEOUT * 1000,
  });
  return r.json();
}

/**
 * One process-wide speed-check job (the AutoTuner shape: a background task + a state
 * object the GET endpoint returns verbatim). `serviceFn` / `hardwareFn` / `popen` /
 * `httpPost` / `health` / `sleep` / `now` are injection points so the job tests offline.
 */
export class Calibrator {
  constructor(
    serviceFn = () => lifecycle.getService(),
    {
      hardwareFn = () => hardware.detect(),
      popen = (argv, opts) => procs.popen(argv, opts),
      httpPost = null,
      health = (url) => processMod._defaultHealth(url),
      sleep = (s) => sleepMs(s * 1000),
      now = monotonic,
    } = {},
  ) {
    this._serviceFn = serviceFn;
    this._hardwareFn = hardwareFn;
    this._popen = popen;
    this._httpPost = httpPost || defaultHttpPost;
    this._health = health;
    this._sleep = sleep;
    this._now = now;
    this._cancel = false;
    this._task = null; // the running check (Python's thread)
    this._state = Calibrator._fresh("idle");
  }

  static _fresh(status) {
    return { status, phase: "", detail: "", error: "", done: 0, total: 0, gbps: null, passes: {} };
  }

  // ── public surface (endpoint-shaped) ─────────────────────────────────────

  status() {
    return { ...this._state, passes: { ...this._state.passes } };
  }

  cancel() {
    if (this._state.status === "running") {
      this._cancel = true;
      this._state.detail = "stopping…";
    }
    return this.status();
  }

  start() {
    if (this._state.status === "running") {
      return { ...this._state, ok: false, error: "a speed check is already running" };
    }
    this._cancel = false;
    this._state = { ...Calibrator._fresh("running"), detail: "starting…" };
    this._task = background("llm-runner-speed-check", () => this._run(), log);
    return this.status();
  }

  // ── the job ───────────────────────────────────────────────────────────────

  _set(kw) {
    Object.assign(this._state, kw);
  }

  _checkCancel() {
    if (this._cancel) throw new Cancelled();
  }

  async _run() {
    try {
      await this._runInner();
    } catch (exc) {
      if (exc instanceof Cancelled) {
        this._set({ status: "cancelled", phase: "", detail: "" });
      } else {
        // job boundary
        log.exception("speed check failed", exc);
        this._set({ status: "error", phase: "", detail: "", error: errStr(exc) });
      }
    }
  }

  async _runInner() {
    const svc = await this._serviceFn();
    const cfg = await svc.config();
    const hw = await this._hardwareFn();
    const [mode, reason] = checkMode(hw);
    if (!mode) throw new RuntimeError(`The speed check doesn't apply here: ${reason}.`);
    const url = (cfg.calibModelUrl || "").trim();
    const sha = (cfg.calibModelSha256 || "").trim().toLowerCase();
    if (!url || sha.length !== 64) {
      throw new RuntimeError("No speed-check model is configured (Engine binaries → Speed-check model).");
    }
    const activeMb = pyFloatParse(cfg.calibActiveExpertMb || 0);
    const nonexpertMb = pyFloatParse(cfg.calibNonexpertMb || 0);
    if (activeMb <= 0) {
      throw new RuntimeError("The speed-check model's expert size is not set (Engine binaries → Speed-check model).");
    }

    const modelPath = await this._ensureModel(svc, cfg, url, sha);
    const exe = await this._waitForEngine(svc);
    const build = (await svc.installedBuild()) || "";
    // A clean GPU — the autotune precedent (svc.stop() before each trial): a resident model
    // would share the card and the passes would measure it.
    await svc.stop();
    this._checkCancel();

    const passes = {};
    let gbps;
    if (mode === "two-pass") {
      this._set({ phase: "pass-a", detail: "Measuring with everything on the graphics card…" });
      passes.a = await this._pass(svc, exe, modelPath, ["-ngl", "99"], "a");
      this._set({ passes: { ...passes }, phase: "pass-b", detail: "Measuring with the model's experts in system memory…" });
      passes.b = await this._pass(svc, exe, modelPath, ["-ngl", "99", "--n-cpu-moe", "999"], "b");
      const tA = passes.a.medianMs;
      const tB = passes.b.medianMs;
      const delta = tB - tA;
      if (delta < MIN_DELTA_FRAC * tB) {
        throw new RuntimeError(
          `The two measurements were too close to tell apart (${pyFixed(tA, 2)} vs ${pyFixed(tB, 2)} ms ` +
            "per token) — estimates stay in use.",
        );
      }
      gbps = activeMb / delta; // MB per ms ≡ GB per s
    } else {
      this._set({ phase: "pass-a", detail: "Measuring on the processor…" });
      passes.a = await this._pass(svc, exe, modelPath, ["-ngl", "0"], "a");
      gbps = (activeMb + nonexpertMb) / passes.a.medianMs;
    }

    const mkey = hardware.machineKey(hw);
    if (!(await svc.recordMachineProbe(gbps, mkey, MOE_PROBE_MODEL_ID, moeProbeLabel(build)))) {
      throw new RuntimeError("The speed check measured this machine but has nowhere to save it.");
    }
    log.info(`speed check: ${pyFixed(gbps, 2)} GB/s host expert stream (${mode}, build ${build}) — passes ${JSON.stringify(passes)}`);
    this._set({ status: "done", phase: "", detail: "", gbps: pyRound(gbps, 2), passes: { ...passes } });
  }

  async _ensureModel(svc, cfg, url, sha) {
    const dest = join(String(svc.cacheRoot), "calib", `${sha}.gguf`);
    if (existsSync(dest) && (await self.sha256Of(dest)) === sha) return dest;
    mkdirSync(dirname(dest), { recursive: true });
    const size = pyInt(cfg.calibModelSizeBytes || 0);
    this._set({ phase: "download", detail: "Downloading the test model…", done: 0, total: size });

    const progress = (done, total) => {
      this._set({ done: pyInt(done), total: pyInt(total || size) });
    };

    try {
      await download.streamDownload(url, dest, {
        onProgress: progress,
        cancelCheck: () => this._cancel,
        ...download.downloadKwargs(cfg),
      });
    } catch (e) {
      if (e instanceof download.DownloadCancelled) throw new Cancelled();
      throw e;
    }
    this._set({ detail: "Checking the download…" });
    const got = await self.sha256Of(dest);
    if (got !== sha) {
      rmSync(dest, { force: true });
      throw new RuntimeError(
        `The test model didn't match its checksum (got ${got.slice(0, 12)}…) — it was deleted; run the check again.`,
      );
    }
    return dest;
  }

  async _waitForEngine(svc) {
    let exe = await svc.installedExe();
    if (exe != null) return exe;
    this._set({ phase: "engine", detail: "Waiting for the engine to finish installing…" });
    const deadline = this._now() + settings.ENGINE_WAIT;
    while (this._now() < deadline) {
      this._checkCancel();
      await this._sleep(1.0);
      exe = await svc.installedExe();
      if (exe != null) return exe;
    }
    throw new RuntimeError("The engine isn't installed — install it, then run the check again.");
  }

  async _pass(svc, exe, modelPath, flags, name) {
    const port = await processMod.findFreePort(processMod.DEFAULT_HOST);
    const base = `http://${processMod.DEFAULT_HOST}:${port}`;
    const argv = [
      String(exe),
      "-m",
      String(modelPath),
      "--host",
      processMod.DEFAULT_HOST,
      "--port",
      String(port),
      "-c",
      String(CTX),
      ...flags,
    ];
    const logPath = join(String(svc.runtimeRoot), "logs", `speed-check-pass-${name}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    // Python opened the log with "w": a fresh file per pass (the seam appends to it).
    writeFileSync(logPath, "");
    const [proc, job] = await processMod.spawnChild(this._popen, argv, logPath);
    const perTok = [];
    try {
      const deadline = this._now() + HEALTH_TIMEOUT;
      while (!(await this._health(base))) {
        this._checkCancel();
        if (processMod.pollProc(proc) !== null) {
          throw new RuntimeError(`The engine stopped while loading the test model — see ${logPath}.`);
        }
        if (this._now() > deadline) throw new RuntimeError("The engine took too long to load the test model.");
        await this._sleep(0.3);
      }
      const body = {
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: TOKENS,
        stream: false,
        temperature: 0.7,
        ignore_eos: true,
      };
      await this._httpPost(`${base}/v1/chat/completions`, body); // warm-up, discarded
      for (let i = 0; i < RUNS; i++) {
        this._checkCancel();
        const t = ((await this._httpPost(`${base}/v1/chat/completions`, body)) || {}).timings || {};
        const n = pyInt(t.predicted_n || 0);
        const ms = pyFloatParse(t.predicted_ms || 0.0);
        if (n <= 0 || ms <= 0) {
          throw new RuntimeError("The engine returned no timing data — this engine build can't run the speed check.");
        }
        perTok.push(ms / n);
      }
    } finally {
      try {
        proc.kill();
        await processMod.waitExit(proc, 15);
      } catch {
        /* closeJob below is the guarantee */
      }
      processMod.closeJob(job);
    }
    const med = median(perTok);
    const spread = Math.max(...perTok.map((x) => Math.abs(x - med) / med));
    if (spread > MAX_SPREAD) {
      throw new RuntimeError(
        `The readings varied too much (${pyFixed(spread * 100, 0)} %) to trust — ` +
          "close other heavy programs and run the check again.",
      );
    }
    return {
      medianMs: pyRound(med, 3),
      perTokenMs: perTok.map((x) => pyRound(x, 3)),
      spread: pyRound(spread, 3),
    };
  }
}

let calibrator = null;

export function getCalibrator() {
  calibrator ??= new Calibrator();
  return calibrator;
}

/**
 * The speed-check REST surface — start / status / cancel (the auto-tune shape). GET also
 * answers what Quick setup needs to decide whether to OFFER the check: does it apply to this
 * machine, is a test model configured, and has this machine already been measured on the
 * engine build on disk.
 */
export function makeCalibrateRouter({
  calibratorFn = getCalibrator,
  serviceFn = () => lifecycle.getService(),
  hardwareFn = () => hardware.detect(),
} = {}) {
  const app = new Hono();
  app.post("/v1/llm-runner/calibrate", async (c) => c.json(await calibratorFn().start()));

  app.get("/v1/llm-runner/calibrate", async (c) => {
    const st = calibratorFn().status();
    const svc = await serviceFn();
    const cfg = await svc.config();
    const hw = await hardwareFn();
    const [mode, reason] = checkMode(hw);
    const measured = await svc.hostMoeBwGbps(hardware.machineKey(hw));
    return c.json({
      ...st,
      mode,
      reason,
      configured: !!((cfg.calibModelUrl || "").trim() && cfg.calibModelSha256),
      sizeBytes: pyInt(cfg.calibModelSizeBytes || 0),
      measuredGbps: measured ?? null,
    });
  });

  app.post("/v1/llm-runner/calibrate/cancel", async (c) => c.json(await calibratorFn().cancel()));
  return app;
}
