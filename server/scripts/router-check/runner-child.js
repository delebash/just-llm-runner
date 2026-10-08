// SPDX-License-Identifier: MIT
// The router check's child: the JavaScript runner service on a scratch copy of an app's
// database, its model cache pointed at a real one (read only — the generated state goes under
// the scratch data dir). Driven over stdin, one command per line: `load <id>`, `stop`, `quit`;
// it answers one JSON line per event on stdout. router-check.js runs it.

import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { installLlm } from "../../src/llm/install.js";
import { openDatabase } from "../../src/platform/sql.js";
import * as lifecycle from "../../src/runner/lifecycle.js";

const { values } = parseArgs({ options: { "data-dir": { type: "string" }, "cache-root": { type: "string" } } });
const dataDir = path.resolve(values["data-dir"]);
const say = (o) => process.stdout.write(`${JSON.stringify({ t: Date.now(), ...o })}\n`);

const db = openDatabase(path.join(dataDir, "app.db"), { foreignKeys: false });
await installLlm(null, { db, dataDir, cacheRoot: values["cache-root"], product: "router-check" });
const svc = lifecycle.getService();
say({ ev: "ready", pid: process.pid, cacheRoot: svc.cacheRoot, build: svc.installedBuild() });

async function waitLoaded(id, timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await svc.resident();
    const m = (r.models || []).find((x) => x.id === id);
    const st = svc.status();
    if (m?.status === "loaded") return { ok: true, resident: r, status: st };
    if (st.status === "error") return { ok: false, status: st };
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { ok: false, timeout: true, status: svc.status() };
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const [cmd, arg] = line.trim().split(/\s+/);
  try {
    if (cmd === "load") {
      const started = await svc.load(arg);
      say({ ev: "load-started", started });
      const r = await waitLoaded(arg);
      const rt = svc._router;
      say({ ev: "loaded", ...r, routerUrl: svc.routerUrl(), routerPid: rt?.process?.pid ?? null, jobHandle: rt?.jobHandle == null ? null : String(rt.jobHandle) });
    } else if (cmd === "stop") {
      const r = await svc.stop();
      say({ ev: "stopped", result: r, routerUrl: svc.routerUrl() });
    } else if (cmd === "quit") {
      say({ ev: "bye" });
      process.exit(0);
    }
  } catch (e) {
    say({ ev: "error", cmd, error: String(e?.stack || e) });
  }
}
