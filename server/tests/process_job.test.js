// SPDX-License-Identifier: MIT
// JS-only, gated: the kill-on-close Job Object, checked for real (process.py's `_win_job_for_child`
// said "real kill-on-parent-death behavior is a box check"). Windows only, and only with
// KIT_REAL_SPAWN=1 — it starts real processes:
//
//   KIT_REAL_SPAWN=1 node scripts/node24.js node_modules/vitest/vitest.mjs run tests/process_job.test.js
//
// A spawner (this runtime as plain Node, tests/fixtures/job_spawner.js) starts cmd.exe →
// PING.EXE through `spawnChild`; the spawner — the process that owns the job — is hard-killed
// with `taskkill /F /PID`, and `tasklist` must then show the child AND the grandchild gone.
// The control runs the same tree with the job off: the grandchild must SURVIVE (libuv's own
// job sets SILENT_BREAKAWAY_OK — kit register §2), which proves the check can fail. Only PIDs
// this test started are ever killed, and only after `tasklist` names the expected image.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { sleep } from "../src/platform/asyncutil.js";
import * as procs from "../src/platform/procs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPAWNER = join(HERE, "fixtures", "job_spawner.js");
const real = process.platform === "win32" && process.env.KIT_REAL_SPAWN === "1";

/** tasklist's image name for `pid`, or null when no such process runs. */
async function imageOf(pid) {
  const r = await procs.run(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
  const row = r.stdout.split(/\r?\n/).find((l) => l.includes(`"${pid}"`));
  return row ? row.split('","')[0].replace(/^"/, "") : null;
}

/** [pid, name] of `pid`'s live children. */
async function childrenOf(pid) {
  const r = await procs.run([
    "powershell",
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`,
  ]);
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [p, ...name] = l.split(" ");
      return [Number(p), name.join(" ")];
    });
}

async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

/** Start the tree, hard-kill the spawner, and report what tasklist shows 3 s later. */
async function killTheOwner(useJob) {
  const stateFile = join(mkdtempSync(join(tmpdir(), "kit-job-")), "state.json");
  const spawner = procs.popen([process.execPath, SPAWNER, stateFile, useJob ? "1" : "0"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const started = [];
  try {
    const state = await until(() => existsSync(stateFile) && JSON.parse(readFileSync(stateFile, "utf8")), 20000);
    expect(state).not.toBeNull();
    started.push(state.spawner, state.child);
    const grand = await until(async () => {
      const kids = await childrenOf(state.child);
      return kids.some(([, n]) => n.toUpperCase() === "PING.EXE") ? kids : null;
    }, 10000);
    expect(grand).not.toBeNull();
    started.push(...grand.map(([p]) => p));
    const before = {
      spawner: await imageOf(state.spawner),
      child: await imageOf(state.child),
      grandchildren: await Promise.all(grand.map(async ([p]) => [p, await imageOf(p)])),
    };
    await procs.run(["taskkill", "/F", "/PID", String(state.spawner)]);
    await sleep(3000);
    const after = {
      spawner: await imageOf(state.spawner),
      child: await imageOf(state.child),
      grandchildren: await Promise.all(grand.map(async ([p, n]) => [p, n, await imageOf(p)])),
    };
    return { state, before, after };
  } finally {
    // Leave nothing behind: kill only the PIDs this test started, and only while tasklist
    // still names the image they had (a reused PID is somebody else's).
    for (const pid of started) {
      const name = await imageOf(pid);
      if (name && /^(PING\.EXE|cmd\.exe|conhost\.exe|electron\.exe|node\.exe)$/i.test(name)) {
        await procs.run(["taskkill", "/F", "/PID", String(pid)]).catch(() => {});
      }
    }
    try {
      spawner.kill();
    } catch {
      /* gone */
    }
  }
}

test.skipIf(!real)("real_spawn: a hard-killed owner takes the child AND the grandchild with its job", async () => {
  const { state, before, after } = await killTheOwner(true);
  console.log("with the job:", JSON.stringify({ state, before, after }));
  expect(state.job).toBe(true);
  expect(before.child?.toLowerCase()).toBe("cmd.exe");
  expect(before.grandchildren.some(([, n]) => n === "PING.EXE")).toBe(true);
  expect(after.spawner).toBeNull();
  expect(after.child).toBeNull();
  expect(after.grandchildren.every(([, , alive]) => alive === null)).toBe(true);
}, 60000);

test.skipIf(!real)("real_spawn control: without our job the grandchild survives the owner", async () => {
  const { state, after } = await killTheOwner(false);
  console.log("without the job:", JSON.stringify({ state, after }));
  expect(state.job).toBe(false);
  expect(after.spawner).toBeNull();
  expect(after.grandchildren.some(([, n, alive]) => n.toUpperCase() === "PING.EXE" && alive === "PING.EXE")).toBe(true);
}, 60000);
