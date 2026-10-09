// SPDX-License-Identifier: MIT
// Port of tests/test_runner_reclaim.py — the two reclaim endpoints on the runner router:
// - POST /v1/llm-runner/spawn-logs/clear removes the per-spawn *.log files (dir kept).
// - POST /v1/llm-runner/models-cache/clear wipes the HF cache, but REFUSES while a model is
//   resident (safe-by-design: the catalog rows persist, models re-download).
//
// Follows runner_models.test.js: build the real router, point `lifecycle.getService` at a REAL
// RunnerService on a temp cacheRoot so the filesystem ops run.
//
// Waits for runner/lifecycle.js (wave 3): every test here needs the REAL RunnerService, so all
// five skip until the port replaces the skeleton (then they run with no edit — the
// constructor form `new RunnerService(cacheRoot)` is Python's positional one).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createServer } from "../src/platform/server.js";
import { runnerRouter } from "../src/runner/api.js";
import * as lifecycle from "../src/runner/lifecycle.js";

/** The skeleton's RunnerService throws "not ported yet"; the real port doesn't. */
const LIFECYCLE_READY = !String(lifecycle.RunnerService).includes("not ported yet");

function client() {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", runnerRouter());
  return { post: async (url) => app.request(url, { method: "POST" }) };
}

const tmpPath = () => mkdtempSync(join(tmpdir(), "kit-reclaim-"));

const svcAt = (tmp) => new lifecycle.RunnerService(String(tmp)); // cacheRoot = tmp; nothing spawned

test.skipIf(!LIFECYCLE_READY)("spawn_logs_clear_removes_log_files", async () => {
  const tmp = tmpPath();
  const logs = join(tmp, "llamacpp", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "runner-a.log"), Buffer.alloc(100, "x"));
  writeFileSync(join(logs, "router-b.log"), Buffer.alloc(40, "y"));
  writeFileSync(join(logs, "keep.txt"), "not a log"); // a non-.log file is left alone
  vi.spyOn(lifecycle, "getService").mockReturnValue(svcAt(tmp));

  const body = await (await client().post("/v1/llm-runner/spawn-logs/clear")).json();
  expect(body.removed).toBe(2);
  expect(body.bytes).toBe(140);
  expect(existsSync(join(logs, "runner-a.log"))).toBe(false);
  expect(existsSync(join(logs, "router-b.log"))).toBe(false);
  expect(statSync(logs).isDirectory()).toBe(true); // the dir itself is kept
  expect(existsSync(join(logs, "keep.txt"))).toBe(true); // only *.log removed
});

test.skipIf(!LIFECYCLE_READY)("spawn_logs_clear_no_dir_is_zero", async () => {
  const tmp = tmpPath();
  vi.spyOn(lifecycle, "getService").mockReturnValue(svcAt(tmp)); // no llamacpp/logs
  const body = await (await client().post("/v1/llm-runner/spawn-logs/clear")).json();
  expect(body).toEqual({ removed: 0, bytes: 0 });
});

test.skipIf(!LIFECYCLE_READY)("models_cache_clear_refuses_when_resident", async () => {
  const tmp = tmpPath();
  const blob = join(tmp, "hf", "models--org--m", "blobs", "abc");
  mkdirSync(join(blob, ".."), { recursive: true });
  writeFileSync(blob, Buffer.alloc(4096, "z"));
  const svc = svcAt(tmp);
  // A resident (loaded) model → refuse WITHOUT deleting.
  vi.spyOn(svc, "resident").mockReturnValue({ models: [{ id: "m", status: "loaded" }] });
  vi.spyOn(lifecycle, "getService").mockReturnValue(svc);

  const body = await (await client().post("/v1/llm-runner/models-cache/clear")).json();
  expect(body.ok).toBe(false);
  expect(body.detail).toBe("unload models first");
  expect(body.models).toEqual(["m"]);
  expect(existsSync(blob)).toBe(true); // nothing deleted while resident
});

test.skipIf(!LIFECYCLE_READY)("models_cache_clear_wipes_when_idle", async () => {
  const tmp = tmpPath();
  const hf = join(tmp, "hf");
  const blob = join(hf, "models--org--m", "blobs", "abc");
  mkdirSync(join(blob, ".."), { recursive: true });
  writeFileSync(blob, Buffer.alloc(4096, "z"));
  const svc = svcAt(tmp);
  // No resident models → wipe and recreate empty.
  vi.spyOn(svc, "resident").mockReturnValue({ models: [] });
  vi.spyOn(lifecycle, "getService").mockReturnValue(svc);

  const body = await (await client().post("/v1/llm-runner/models-cache/clear")).json();
  expect(body.ok).toBe(true);
  expect(body.bytes).toBe(4096);
  expect(existsSync(blob)).toBe(false); // weights gone
  expect(statSync(hf).isDirectory()).toBe(true);
  expect(readdirSync(hf)).toEqual([]); // recreated empty
});

test.skipIf(!LIFECYCLE_READY)("models_cache_clear_refuses_when_loading", async () => {
  // A model still LOADING (mid-download/spawn) is also in-use → refuse.
  const svc = svcAt(tmpPath());
  vi.spyOn(svc, "resident").mockReturnValue({ models: [{ id: "x", status: "loading" }] });
  vi.spyOn(lifecycle, "getService").mockReturnValue(svc);
  const body = await (await client().post("/v1/llm-runner/models-cache/clear")).json();
  expect(body.ok).toBe(false);
  expect(body.detail).toBe("unload models first");
});
