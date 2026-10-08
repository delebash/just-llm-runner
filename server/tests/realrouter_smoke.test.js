// SPDX-License-Identifier: MIT
// Port of tests/test_realrouter_smoke.py — the REAL-ROUTER integration smoke (2026-07-22
// pass-1 plan T8).
//
// WHY: the runner tests fake the router (`serviceFor` injects routerLoad/routerModels), so five
// integration defects sat green while the real server↔router↔child stack broke. This file runs
// the REAL installed engine + REAL router + ONE small real model and asserts OBSERVED truth
// (the child's reported n_ctx, the router's /models, the emitted models.ini) against what was
// REQUESTED.
//
// GATED, as in Python (build sheet rule 20) — runs ONLY when BOTH are set:
//     JW_REALROUTER=1                  (explicit opt-in; never part of default runs)
//     JUSTWRITE_DATA_DIR=<data root>   (the app data root holding ai-cache/{hf,llamacpp})
// plus an installed engine exe, the smoke model's weights on disk, and :8080 free (the
// router's port — NEVER run while the app is up). Without them every test is skipped and
// nothing is probed: the port check runs only once the env gates pass.
//
// Run: JW_REALROUTER=1 JUSTWRITE_DATA_DIR=... node scripts/node24.mjs
//      node_modules/vitest/vitest.mjs run tests/realrouter_smoke.test.js
// (one file, one router — vitest runs a file's tests in order.)
//
// Model: qwen3-embedding-4b — small (2.5 GB), loads in seconds on any engine variant.
// Lifecycle verbs are model-agnostic.
//
// NOT RUN with the gate on while porting (the user's app was running) — the bodies follow the
// Python line for line against the JS RunnerService API (`load(id, {switches})`, async
// `resident()`/`stop()`/`ensureModelReady(id, timeoutS)`, the `_routerLock` ReentrantMutex).
// The standalone leg of the mlock case starts llama-server through `platform/procs.js` popen.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";
import { sleep } from "../src/platform/asyncutil.js";
import { model } from "../src/platform/models.js";
import { popen } from "../src/platform/procs.js";
import { buildNum } from "../src/runner/binary.js";
import * as hardware from "../src/runner/hardware.js";
import { RunnerService } from "../src/runner/lifecycle.js";
import { LOAD_MODE_MIN_BUILD } from "../src/runner/process.js";
import { ModelEntry } from "../src/runner/schema.js";

const DATA_DIR = process.env.JUSTWRITE_DATA_DIR || "";
const ENABLED = process.env.JW_REALROUTER === "1";

const EMBED_ID = "qwen3-embedding-4b";
const EMBED_REPO = "Qwen/Qwen3-Embedding-4B-GGUF";
const EMBED_QUANT = "Q4_K_M";

// Emit-only rows for the MTP-rule case (never loaded; sections emit for on-disk models).
const BONSAI = { id: "ternary-bonsai-27b-q2-g64", hfRepo: "prism-ml/Ternary-Bonsai-27B-gguf", quant: "Q2_g64" };
const GEMMA = {
  id: "gemma-4-26b-a4b-qat",
  hfRepo: "unsloth/gemma-4-26B-A4B-it-qat-GGUF",
  quant: "UD-Q4_K_XL",
  mtpDraftFile: "MTP/mtp-gemma-4-26B-A4B-it-Q4_0.gguf",
};

const monotonic = () => performance.now() / 1000;
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const subdirs = (p) =>
  isDir(p)
    ? readdirSync(p)
        .filter((n) => isDir(join(p, n)))
        .sort()
    : [];

function cacheRoot() {
  return join(DATA_DIR, "ai-cache");
}

/** The installed llama-server exe — any build/variant dir (the smoke tests the ROUTER
 * lifecycle, not binary selection, so resolution is explicit + simple). */
function findEngineExe() {
  const base = join(cacheRoot(), "llamacpp");
  if (!isDir(base)) return null;
  const exe = "llama-server.exe";
  const deep = subdirs(base).flatMap((b) => subdirs(join(base, b)).map((v) => join(base, b, v, exe)));
  const shallow = subdirs(base).map((b) => join(base, b, exe));
  return [...deep.filter(existsSync).sort(), ...shallow.filter(existsSync).sort()][0] ?? null;
}

/** Is nothing listening on 127.0.0.1:`port`? */
function portFree(port) {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

/** The first `*.gguf` under the repo's snapshots whose name holds `nameFragment` (not an MTP
 * draft). */
function snapshotGguf(repo, nameFragment) {
  const d = join(cacheRoot(), "hf", `models--${repo.replaceAll("/", "--")}`, "snapshots");
  if (!isDir(d)) return null;
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (
        ent.name.toLowerCase().endsWith(".gguf") &&
        ent.name.toLowerCase().includes(nameFragment.toLowerCase()) &&
        !ent.name.toLowerCase().includes("mtp")
      ) {
        return p;
      }
    }
    return null;
  };
  return walk(d);
}

const entry = (fields) => model(ModelEntry, { name: fields.id ?? "m", tier: "mid", ...fields });

// The gate, in Python's order: nothing past the env checks runs on a default test run.
let SKIP = null;
if (!ENABLED) SKIP = "JW_REALROUTER != 1 (explicit opt-in required)";
else if (!DATA_DIR || !isDir(cacheRoot())) SKIP = "JUSTWRITE_DATA_DIR unset or has no ai-cache/";
else if (findEngineExe() == null) SKIP = "no installed llama-server engine under ai-cache/llamacpp";
else if (snapshotGguf(EMBED_REPO, EMBED_QUANT) == null) SKIP = `smoke model ${EMBED_ID} not on disk`;
else if (!(await portFree(8080))) SKIP = "port 8080 busy — never run the smoke beside a live router/app";

const smoke = test.skipIf(SKIP != null);

/** Python's `svc` fixture: a real RunnerService over the data root's cache, torn down fully
 * (router + children) after the body. */
async function withSvc(body) {
  await hardware.ensureDetected(); // the service's default hardwareFn reads the memo
  const exe = findEngineExe();
  const catalog = [
    entry({ id: EMBED_ID, hfRepo: EMBED_REPO, quant: EMBED_QUANT, embedding: true, pooling: "last" }),
    entry(BONSAI),
    entry(GEMMA),
  ];
  const noDownload = () => {
    throw new Error("the smoke must never download — every case uses on-disk weights");
  };
  const service = new RunnerService(cacheRoot(), {
    catalogFn: () => catalog,
    acquireBinary: () => exe,
    acquiredExe: () => exe,
    acquireModel: noDownload,
    switchesFn: () => ({}),
    embeddingIdsFn: () => new Set([EMBED_ID]),
  });
  try {
    await body(service);
  } finally {
    await service.stop(); // full teardown — kill the router + children
    await sleep(1000);
  }
}

async function waitFor(pred, timeoutS, interval = 0.5) {
  const deadline = monotonic() + timeoutS;
  while (monotonic() < deadline) {
    if (await pred()) return true;
    await sleep(interval * 1000);
  }
  return !!(await pred());
}

async function residentRow(service, mid) {
  return ((await service.resident()).models || []).find((m) => m.id === mid) ?? null;
}

async function loaded(service, mid) {
  const row = (await residentRow(service, mid)) || {};
  return row.status === "loaded" || row.status === "sleeping";
}

function iniText(_service) {
  return readFileSync(join(cacheRoot(), "llamacpp", "models.ini"), "utf8").replace(/\r\n?/g, "\n");
}

function section(ini, modelId) {
  expect(ini.includes(`[${modelId}]`), `no [${modelId}] section:\n${ini}`).toBe(true);
  return ini.split(`[${modelId}]`)[1].split("\n[")[0];
}

const statusText = (svc) => JSON.stringify(svc.status());

smoke("load_applies_ephemeral_ctx_and_coload_emit_preserves_it", async () => {
  // Case 1 (ephemeral ctx observed on the REAL child) + case 2 (defect C: a later no-override
  // emit — the exact mechanism that reverted qwen 8192→131072 — must keep the loaded-with
  // section, and the unchanged text must NOT bounce the child).
  await withSvc(async (svc) => {
    await svc.load(EMBED_ID, { switches: { ctx_len: "4096" } });
    expect(await waitFor(() => loaded(svc, EMBED_ID), 120), statusText(svc)).toBe(true);
    let row = await residentRow(svc, EMBED_ID);
    expect(row.n_ctx, JSON.stringify(row)).toBe(4096); // the CHILD's own truth
    expect(section(iniText(svc), EMBED_ID)).toContain("ctx-size = 4096");

    await svc._routerLock.run(async () => svc._emitIni(null)); // the documented second emit
    expect(section(iniText(svc), EMBED_ID)).toContain("ctx-size = 4096");
    row = await residentRow(svc, EMBED_ID);
    expect(row != null && row.n_ctx === 4096).toBe(true); // no bounce, child untouched
  });
});

smoke("switch_change_reflected_on_reload", async () => {
  // Case 6: a Lab-style re-load with a DIFFERENT ephemeral ctx is a real re-load and the
  // child reports the new value.
  await withSvc(async (svc) => {
    await svc.load(EMBED_ID, { switches: { ctx_len: "4096" } });
    expect(await waitFor(() => loaded(svc, EMBED_ID), 120), statusText(svc)).toBe(true);
    await svc.load(EMBED_ID, { switches: { ctx_len: "2048" } });
    const ok = await waitFor(async () => ((await residentRow(svc, EMBED_ID)) || {}).n_ctx === 2048, 120);
    expect(ok, JSON.stringify(await residentRow(svc, EMBED_ID))).toBe(true);
  });
});

smoke("double_load_is_idempotent", async () => {
  // Case 5 (defect E): a second plain load of a resident model neither errors nor spawns a
  // second child.
  await withSvc(async (svc) => {
    await svc.load(EMBED_ID);
    expect(await waitFor(() => loaded(svc, EMBED_ID), 120), statusText(svc)).toBe(true);
    await svc.load(EMBED_ID);
    await sleep(2000);
    const rows = ((await svc.resident()).models || []).filter((m) => m.id === EMBED_ID);
    expect(rows.length === 1 && ["loaded", "sleeping"].includes(rows[0].status)).toBe(true);
    expect((svc._resident.get(EMBED_ID) || {}).error).toBeFalsy();
  });
});

smoke("stop_stays_stopped", async () => {
  // Case 3 (defect D): an explicit stop sticks — 45 s with no reappearance, and a zombie-style
  // ensure inside the tombstone window REFUSES.
  await withSvc(async (svc) => {
    await svc.load(EMBED_ID);
    expect(await waitFor(() => loaded(svc, EMBED_ID), 120), statusText(svc)).toBe(true);
    await svc.stop(EMBED_ID);
    await expect(svc.ensureModelReady(EMBED_ID, 5.0)).rejects.toThrow(/just stopped/);
    // the model came BACK after stop?
    expect(await waitFor(() => loaded(svc, EMBED_ID), 45)).toBe(false);
  });
});

smoke("unknown_model_fails_fast_and_visibly", async () => {
  // Case 4 (defects A/B): the bonsai incident — an unknown id must surface as a visible error
  // within seconds, never a silent 30-minute wait.
  await withSvc(async (svc) => {
    const t0 = monotonic();
    await svc.load("no-such-model");
    const ok = await waitFor(
      () => svc.status().status === "error" && (svc.status().error || "").includes("unknown model"),
      10,
    );
    expect(ok, statusText(svc)).toBe(true);
    expect(monotonic() - t0).toBeLessThan(10);
  });
});

smoke("mtp_emit_rule", async (ctx) => {
  // Case 7 (the user's MTP rule): bonsai (mtp off, no draft fields) emits NO spec lines; gemma
  // (own downloaded draft) emits a model-draft path that EXISTS.
  await withSvc(async (svc) => {
    await svc.load(EMBED_ID); // any load emits the full ini (sections for on-disk models)
    expect(await waitFor(() => loaded(svc, EMBED_ID), 120), statusText(svc)).toBe(true);
    const ini = iniText(svc);
    if (ini.includes(`[${BONSAI.id}]`)) {
      const b = section(ini, BONSAI.id);
      expect(!b.includes("model-draft") && !b.includes("spec-type"), b).toBe(true);
    } else {
      ctx.skip("bonsai weights not on disk — no section to assert on");
      return;
    }
    if (ini.includes(`[${GEMMA.id}]`)) {
      const g = section(ini, GEMMA.id);
      const m = /model-draft = (.+)/.exec(g);
      if (m) expect(existsSync(m[1].trim()), "emitted a model-draft that is not on disk").toBe(true);
    }
  });
});

/** The installed build as a number — the emitted flag spelling depends on it
 * (`process.LOAD_MODE_MIN_BUILD`). */
function engineBuildNum() {
  const exe = findEngineExe();
  return exe ? buildNum(basename(dirname(dirname(exe)))) : -1;
}

smoke("mlock_parity_router_vs_standalone", async () => {
  // Case 8 (defect G — RESOLVED by the T7 bisection, 2026-07-22): --mlock through the ROUTER
  // locks exactly as it does standalone. The incident's 998s were the --mlock + --no-mmap
  // COMBINATION (an upstream allocation-shape bug; see the strip case below).
  // 2026-09-19: the STANDALONE leg asks for the mode by name on a new engine — `--mlock` was
  // deleted at b10875 and, from b10105, means "lock WITHOUT mmap" (measured). `mmap+mlock` is
  // what `mlock: true` renders to there, so the two legs stay the same request. NOTE what this
  // asserts: the ABSENCE of a VirtualLock warning, not that a lock happened.
  await withSvc(async (svc) => {
    const exe = findEngineExe();
    const gguf = snapshotGguf(EMBED_REPO, EMBED_QUANT);
    const lockFlags = engineBuildNum() >= LOAD_MODE_MIN_BUILD ? ["--load-mode", "mmap+mlock"] : ["--mlock"];
    // stdout + stderr read together (Python merged stderr into stdout).
    const proc = popen([exe, "-m", gguf, ...lockFlags, "-c", "512", "--port", "8091", "--host", "127.0.0.1"]);
    let standaloneOk;
    try {
      const out = [];
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        const timer = setTimeout(finish, 60_000);
        for (const stream of [proc.stdout, proc.stderr]) {
          createInterface({ input: stream }).on("line", (line) => {
            out.push(line);
            if (line.includes("model loaded") || line.includes("listening on")) {
              clearTimeout(timer);
              finish();
            }
          });
        }
        proc.once("exit", () => {
          clearTimeout(timer);
          finish();
        });
      });
      standaloneOk = !out.some((line) => line.includes("VirtualLock"));
    } finally {
      proc.kill();
    }
    expect(standaloneOk, "standalone --mlock failed to lock — box regression").toBe(true);

    await svc.load(EMBED_ID, { switches: { mlock: "true" } });
    expect(await waitFor(() => loaded(svc, EMBED_ID), 120), statusText(svc)).toBe(true);
    const logPath = svc._lastLogPath;
    expect(logPath && existsSync(logPath), "no router log to check").toBeTruthy();
    const routerLog = readFileSync(logPath, "utf8");
    expect(routerLog.includes("failed to VirtualLock"), "router child failed VirtualLock while standalone locked fine (defect G)").toBe(
      false,
    );
  });
});

smoke("mlock_no_mmap_pair_is_stripped_on_windows", async (ctx) => {
  // Defect G's ACTUAL breakage, isolated (T7 bisection) + THE (b) FIX (user decision
  // 2026-07-22): --mlock beside --no-mmap can never lock on Windows (llama.cpp's no-mmap
  // buffer isn't lockable). The strip rule (`_stripInertMlock`) removes mlock from the pair at
  // the merge, so the child neither attempts nor warns, and the emitted section is truthful.
  if (process.platform !== "win32") {
    ctx.skip("the strip rule is Windows-only");
    return;
  }
  await withSvc(async (svc) => {
    await svc.load(EMBED_ID, { switches: { mlock: "true", no_mmap: "true" } });
    expect(await waitFor(() => loaded(svc, EMBED_ID), 120), statusText(svc)).toBe(true);
    const sec = section(iniText(svc), EMBED_ID);
    if (engineBuildNum() >= LOAD_MODE_MIN_BUILD) {
      // Same truth, the new engine's spelling: mlock stripped → no_mmap alone → `none`
      // (measured on b10437: `load_mode = none`). The removed flags never appear.
      expect(sec, sec).toContain("load-mode = none");
      expect(!sec.includes("mlock") && !sec.includes("no-mmap"), sec).toBe(true);
    } else {
      expect(sec).toContain("no-mmap = true");
      expect(sec.includes("mlock = "), sec).toBe(false); // stripped from the pair
    }
    const logPath = svc._lastLogPath;
    expect(logPath && existsSync(logPath), "no router log to check").toBeTruthy();
    expect(readFileSync(logPath, "utf8").includes("failed to VirtualLock")).toBe(false);
  });
});
