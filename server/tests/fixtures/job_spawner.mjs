// SPDX-License-Identifier: MIT
// The spawner for the real job check (tests/process_job.test.js): starts `cmd.exe`, which
// starts `PING.EXE` (output to nul, so no broken pipe can end it) — the shape of llama-server's
// router starting per-model children — through the kit's spawn door, writes who is who to
// <stateFile>, and waits to be hard-killed.
//
//   node scripts/node24.mjs tests/fixtures/job_spawner.mjs <stateFile> [1|0]
//
// "0" switches the job off (the control: libuv's own job lets the grandchild break away).
import { writeFileSync } from "node:fs";
import * as processMod from "../../src/runner/process.js";

const [stateFile, useJob = "1"] = process.argv.slice(2);
if (useJob === "0") processMod.cfg.platform = "no-job";
const [proc, job] = await processMod.spawnChild(null, ["cmd.exe", "/c", "ping -n 30 127.0.0.1 > nul"], null);
writeFileSync(stateFile, JSON.stringify({ spawner: process.pid, child: proc.pid, job: job != null }));
setInterval(() => {}, 1 << 30);
