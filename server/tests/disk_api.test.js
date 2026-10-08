// SPDX-License-Identifier: MIT
// Port of tests/test_disk_api.py — makeDiskRouter: GET /v1/disk/usage sums the DB (+ its
// WAL/SHM sidecars), app logs, and the ai-cache buckets under the data dir, holds the
// spawn-logs subdir OUT of engineBuilds, reports free/total space, and treats missing dirs
// as 0.
//
// No runner service, so these measure the in-data-dir layout. Since 2026-08-03 the engine
// buckets are read off the WIRED service, because the cache may be shared with a sibling
// app. Python's autouse fixture set `lifecycle._service = None`; here the lazy seam
// `deps.configuredService` answers null (runner/lifecycle.js is another slice's port).
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import * as diskApi from "../src/platform/disk_api.js";
import { makeDiskRouter } from "../src/platform/disk_api.js";
import { createServer } from "../src/platform/server.js";

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kit-disk-"));
  vi.spyOn(diskApi.deps, "configuredService").mockResolvedValue(null);
});

async function usage(dataDir, extraBuckets) {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(extraBuckets === undefined ? makeDiskRouter(String(dataDir)) : makeDiskRouter(String(dataDir), extraBuckets));
  const r = await app.inject({ method: "GET", url: "/v1/disk/usage" });
  expect(r.statusCode).toBe(200);
  return r.json();
}

function write(p, n) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(n, "x"));
}

test("usage_sums_each_bucket", async () => {
  // DB + its WAL/SHM sidecars at the root.
  write(join(tmp, "justwrite.db"), 1000);
  write(join(tmp, "justwrite.db-wal"), 200);
  write(join(tmp, "justwrite.db-shm"), 50);
  // app logs (per-day server logs).
  write(join(tmp, "logs", "justwrite.log"), 300);
  write(join(tmp, "logs", "justwrite.log.2026-07-01"), 150);
  // models cache (hf) — nested like the real HF layout.
  write(join(tmp, "ai-cache", "hf", "models--org--m", "blobs", "abc"), 5000);
  // engine builds (llamacpp): a build dir + the generated models.ini sibling.
  write(join(tmp, "ai-cache", "llamacpp", "b9999", "llama-server"), 4000);
  write(join(tmp, "ai-cache", "llamacpp", "models.ini"), 100);
  // spawn logs — a SEPARATE bucket, excluded from engineBuilds.
  write(join(tmp, "ai-cache", "llamacpp", "logs", "runner-x.log"), 700);

  const body = await usage(tmp);
  expect(body.database).toBe(1250); // 1000 + 200 + 50
  expect(body.appLogs).toBe(450); // 300 + 150
  expect(body.modelsCache).toBe(5000);
  expect(body.engineBuilds).toBe(4100); // 4000 + 100, NOT the 700 spawn log
  expect(body.spawnLogs).toBe(700);
  expect(body.total).toBe(1250 + 450 + 5000 + 4100 + 700);
  expect(body.diskTotal).toBeGreaterThan(0);
  expect(body.diskFree).toBeGreaterThan(0);
});

test("missing_dirs_are_zero_not_error", async () => {
  // A bare data dir (nothing created) → every bucket 0, still 200 + real free/total.
  const body = await usage(tmp);
  expect(body.database).toBe(0);
  expect(body.appLogs).toBe(0);
  expect(body.modelsCache).toBe(0);
  expect(body.engineBuilds).toBe(0);
  expect(body.spawnLogs).toBe(0);
  expect(body.total).toBe(0);
  expect(body.diskTotal).toBeGreaterThan(0);
});

test("symlinks_are_not_followed", async (ctx) => {
  // HF stores real blobs and symlinks them from snapshots/ — the walk must count the blob
  // ONCE and skip the link (no double count, no walk loop).
  const blob = join(tmp, "ai-cache", "hf", "blobs", "sha");
  write(blob, 2048);
  const snap = join(tmp, "ai-cache", "hf", "snapshots", "rev");
  mkdirSync(snap, { recursive: true });
  try {
    symlinkSync(blob, join(snap, "model.gguf"), "file");
  } catch {
    ctx.skip("symlinks unsupported on this platform");
  }
  expect((await usage(tmp)).modelsCache).toBe(2048); // blob counted once; the symlink skipped
});

test("extra_buckets_measured_named_and_counted", async () => {
  // Host-declared buckets (JV's speech/render caches): measured with the same guarded
  // walk, served under their declared names in `extras`, counted into total. A missing
  // extra dir is 0, and a host that declares none gets `extras: {}`.
  write(join(tmp, "speech-cache", "kokoro", "v1", "model.onnx"), 900);
  write(join(tmp, "cache", "ab", "render.wav"), 600);
  write(join(tmp, "logs", "app.log"), 100);

  const body = await usage(tmp, {
    speechCache: join(tmp, "speech-cache"),
    renderCache: join(tmp, "cache"),
    neverCreated: join(tmp, "nope"),
  });
  expect(body.extras).toEqual({ speechCache: 900, renderCache: 600, neverCreated: 0 });
  expect(body.total).toBe(100 + 900 + 600);

  const plain = await usage(tmp);
  expect(plain.extras).toEqual({});
  expect(plain.total).toBe(100);
});

test("extra_bucket_with_several_roots_sums_them", async () => {
  // A user-facing store whose files span layout generations (JV's speech models: the
  // speech cache + legacy per-engine dirs) declares a LIST of roots and gets one number.
  write(join(tmp, "speech-cache", "eng", "v1", "m.bin"), 500);
  write(join(tmp, "legacy", "eng", "models", "old.onnx"), 300);

  const body = await usage(tmp, { speechCache: [join(tmp, "speech-cache"), join(tmp, "legacy", "eng", "models")] });
  expect(body.extras).toEqual({ speechCache: 800 });
  expect(body.total).toBe(800);
});

test("hardlinked_blob_counted_once", async (ctx) => {
  // Where HF cannot symlink it hardlinks or copies, so one blob answers to two names. The
  // disk holds those bytes once and the panel must say so — otherwise a 22 GB cache
  // reports 45 GB, and `models-cache/clear` claims to free twice what it frees.
  const blob = join(tmp, "ai-cache", "hf", "blobs", "sha");
  write(blob, 4096);
  const snap = join(tmp, "ai-cache", "hf", "snapshots", "rev");
  mkdirSync(snap, { recursive: true });
  try {
    linkSync(blob, join(snap, "model.gguf"));
  } catch {
    ctx.skip("hardlinks unsupported on this platform");
  }
  expect((await usage(tmp)).modelsCache).toBe(4096); // one inode, two names, counted once
});

test("dedup_does_not_merge_distinct_files_of_equal_size", async () => {
  // The guard on the dedup itself: keying on missing link data would fold every file into
  // a single entry and under-report a full cache as one file. Two unrelated same-sized
  // blobs must still sum.
  write(join(tmp, "ai-cache", "hf", "blobs", "sha-a"), 4096);
  write(join(tmp, "ai-cache", "hf", "blobs", "sha-b"), 4096);
  expect((await usage(tmp)).modelsCache).toBe(8192);
});

// Not in the Python file (Python covers it in test_shared_cache.py): a WIRED service's
// roots are measured, and a cache outside the data root says so.
test("a_wired_service_supplies_the_engine_roots", async () => {
  const shared = mkdtempSync(join(tmpdir(), "kit-disk-shared-"));
  write(join(shared, "hf", "blobs", "x"), 1234);
  write(join(shared, "llamacpp", "b1", "llama-server"), 10);
  write(join(shared, "llamacpp", "logs", "spawn.log"), 7);
  vi.spyOn(diskApi.deps, "configuredService").mockResolvedValue({
    cacheRoot: shared,
    runtimeRoot: join(shared, "llamacpp"),
  });
  const body = await usage(tmp);
  expect(body).toMatchObject({ modelsCache: 1234, engineBuilds: 10, spawnLogs: 7, cacheShared: true });
  // and a wiring gap is never an error: the data dir is measured instead
  vi.spyOn(diskApi.deps, "configuredService").mockRejectedValue(new Error("no runner"));
  expect((await usage(tmp)).cacheShared).toBe(false);
});
