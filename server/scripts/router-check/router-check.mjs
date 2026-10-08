// SPDX-License-Identifier: MIT
// The step-2 hands-on check (the Electron move's plan §4 "Checked", by hand): the JavaScript
// runner starts a llama-server router, loads a real model, stops it, loads it again and is
// HARD-KILLED — and after the stop and after the kill, no llama-server is left and VRAM is
// back to its baseline. Run with the family apps CLOSED (two llama-servers on one card is the
// trap JustVoice's CLAUDE.md warns about):
//
//   node scripts/node24.mjs scripts/router-check/router-check.mjs \
//     --db <an app's database to COPY> --cache-root <a model cache> --model <catalog id>
//
// The database is copied into a scratch folder; the cache is only read (models.ini and the
// spawn logs go under the scratch folder). Writes a report beside the copy.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: { db: { type: "string" }, "cache-root": { type: "string" }, model: { type: "string" }, build: { type: "string" } },
});
const scratch = mkdtempSync(path.join(os.tmpdir(), "router-check-"));
const dataDir = path.join(scratch, "data");
mkdirSync(dataDir, { recursive: true });
copyFileSync(o.db, path.join(dataDir, "app.db"));

// The copy runs the build the cache holds.
if (o.build) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path.join(dataDir, "app.db"));
  db.prepare("update runner_setting set value = ? where key = 'pinned_build'").run(o.build);
  db.close();
}

const vram = () => Number(execFileSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { windowsHide: true }).toString().trim().split(/\r?\n/)[0]);
const llamaServers = () =>
  execFileSync("tasklist", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq llama-server.exe"], { windowsHide: true })
    .toString()
    .split(/\r?\n/)
    .filter((l) => l.includes("llama-server"))
    .map((l) => Number(l.split('","')[1]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(target, label, ms = 20000) {
  // VRAM takes a moment to come back after a process exits.
  const t0 = Date.now();
  let v = vram();
  while (Date.now() - t0 < ms && v > target + 150) {
    await sleep(500);
    v = vram();
  }
  return { label, vramMb: v, baselineMb: target, back: v <= target + 150, llamaServers: llamaServers() };
}

function startChild() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", JUST_AI_HOME: path.join(scratch, "family") };
  const c = spawn(process.execPath, [path.join(import.meta.dirname, "runner-child.mjs"), "--data-dir", dataDir, "--cache-root", o["cache-root"]], {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const waiters = [];
  readline.createInterface({ input: c.stdout }).on("line", (l) => {
    try {
      const e = JSON.parse(l);
      events.push(e);
      for (const w of waiters.splice(0)) w();
    } catch {
      /* a stray line */
    }
  });
  const errs = [];
  c.stderr.on("data", (d) => errs.push(d));
  const next = async (ev, ms = 330000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = events.findIndex((e) => e.ev === ev || e.ev === "error");
      if (i >= 0) return events.splice(i, 1)[0];
      if (c.exitCode !== null) throw new Error(`child exited ${c.exitCode}: ${Buffer.concat(errs).toString().slice(-2000)}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 1000);
      });
    }
    throw new Error(`timed out waiting for ${ev}`);
  };
  const send = (line) => c.stdin.write(`${line}\n`);
  return { c, next, send };
}

const report = { scratch, model: o.model, steps: [] };
const step = (s) => {
  report.steps.push(s);
  console.log(JSON.stringify(s));
};
const baseline = vram();
step({ label: "baseline", vramMb: baseline, llamaServers: llamaServers() });
if (llamaServers().length) throw new Error("a llama-server is already running — close the family apps first");

try {
  // 1. start, load, stop
  let ch = startChild();
  const ready = await ch.next("ready", 120000);
  step({ label: "service ready", ...ready });
  ch.send(`load ${o.model}`);
  let loaded = await ch.next("loaded");
  step({ label: "loaded", ok: loaded.ok, vramMb: vram(), llamaServers: llamaServers(), routerUrl: loaded.routerUrl, routerPid: loaded.routerPid, jobHandle: loaded.jobHandle, status: loaded.status?.status, error: loaded.status?.error || loaded.error });
  ch.send("stop");
  await ch.next("stopped", 60000);
  step(await settle(baseline, "after stop"));
  // A process takes a moment to finish exiting after it is killed: watch for it.
  for (let i = 0; i < 30 && llamaServers().length; i++) await sleep(500);
  step({ label: "after stop, settled", vramMb: vram(), llamaServers: llamaServers() });
  ch.send("quit");
  await sleep(500);

  // 2. start, load, HARD-KILL the Node process that owns the router
  ch = startChild();
  await ch.next("ready", 120000);
  ch.send(`load ${o.model}`);
  loaded = await ch.next("loaded");
  const servers = llamaServers();
  step({ label: "loaded again", ok: loaded.ok, vramMb: vram(), llamaServers: servers, ownerPid: ch.c.pid });
  execFileSync("taskkill", ["/F", "/PID", String(ch.c.pid)], { windowsHide: true });
  step({ label: "hard-killed the owner", pid: ch.c.pid });
  await sleep(3000);
  step(await settle(baseline, "after hard kill"));
} catch (e) {
  step({ label: "FAILED", error: String(e?.stack || e) });
  process.exitCode = 1;
} finally {
  // Never leave a llama-server we started behind (only ones that weren't there at baseline).
  for (const pid of llamaServers()) {
    try {
      execFileSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
      step({ label: "cleanup killed a leftover llama-server", pid });
    } catch {
      /* gone */
    }
  }
  writeFileSync(path.join(scratch, "report.json"), JSON.stringify(report, null, 2));
  console.log(`report: ${path.join(scratch, "report.json")}`);
}
