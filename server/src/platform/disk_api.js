// SPDX-License-Identifier: MIT
// The shared disk-usage router — a READ-ONLY size breakdown of the app's on-disk footprint
// so a Settings "reclaim disk" panel can show WHERE the space went and offer the reclaim
// actions (the port of llm_runner/platform/disk_api.py). This router only MEASURES; the
// deletes are the runner's reclaim endpoints (models-cache / spawn-logs clear) + the
// /v1/logs sweep.
//
// Every same-stack app mounts the identical `GET /v1/disk/usage` over its own portable
// data root — the T3 "one source" law. The host calls `makeDiskRouter(dataDir)` at boot
// (the same `dataDir` it passes the runner, whose cache lives at `<dataDir>/ai-cache`).
//
// The measured buckets:
//   database     — the SQLite DB file(s) at the root + each one's -wal/-shm siblings.
//   appLogs      — `<dataDir>/logs` (the per-day server logs; swept via /v1/logs).
//   modelsCache  — `<cacheRoot>/hf` (downloaded model GGUFs).
//   engineBuilds — `<cacheRoot>/llamacpp` EXCLUDING its `logs/` subdir (the llama.cpp
//                  binaries; swept on engine uninstall/update).
//   spawnLogs    — `<runtimeRoot>/logs` (per-spawn llama-server logs, otherwise UNBOUNDED
//                  — the runner's spawn-logs/clear reclaims them).
//   total        — the sum of the five buckets (+ any host-declared extras).
//   diskFree / diskTotal — the volume's free/total bytes.
//   cacheShared  — true when the cache lives outside this app's data root.
//   extras       — host-declared app-specific buckets (`extraBuckets`), e.g. JV's
//                  speech-cache and render-cache roots; {} when none.
//
// The last three buckets are read from the RUNNING SERVICE, not assumed to be under
// `dataDir`: the cache may be shared with a sibling app (2026-08-03), and a panel that
// measured `<dataDir>/ai-cache` regardless would report a confident 0 B for 14 GB of
// models. When nothing is shared these resolve to exactly the in-data-dir paths.
//
// Robustness: a missing dir counts 0 (never an error); every stat is guarded (a file can
// vanish mid-walk); symlinks are NOT followed — the HF cache stores real blobs under
// `blobs/` and symlinks them from `snapshots/`, so following them would double-count (and
// could loop), while skipping them counts each blob exactly once.
//
// That only held where HF can MAKE symlinks. On Windows it cannot without Developer Mode
// or admin, so `snapshots/` gets full COPIES and every model occupies twice its size —
// real bytes, honestly counted. Replace those copies with hardlinks (same bytes, two
// names) and the walk counts them twice while the disk holds them once. `dedupLinks`
// closes that: it counts each inode once. Opt-in per bucket because it costs a stat per
// file (~3x the walk), which only the models cache is known to need.

import { opendir, readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { samePath } from "./data_paths.js";
import { getLogger } from "./log.js";
import { opt, T } from "./models.js";
import { IS_WIN } from "./py.js";

const log = getLogger("llm_runner.platform.disk_api");

// Path equality as pathlib has it: normalized, case-insensitive on Windows.
const pathKey = (p) => {
  const n = path.normalize(String(p)).replace(/[\\/]+$/, "");
  return IS_WIN ? n.toLowerCase() : n;
};

/**
 * Total bytes of the regular files under `p`, recursively. Async (the walk is I/O).
 *
 * Symlinks are skipped (never followed), every stat is guarded, and a missing `p` counts
 * 0 — so a vanishing file, a broken link, or an absent dir never throws. `exclude` is a
 * list of child paths to skip whole (holds the llamacpp `logs/` subdir out of the
 * engine-builds bucket). Shared by the sizes endpoint AND the runner's models-cache
 * reclaim (one walk, one source).
 *
 * `dedupLinks` counts each INODE once, so a file reachable under two names (a hardlink)
 * adds its bytes once — what the disk actually holds. Off by default: it costs a stat per
 * file, and only the HF models cache is known to contain hardlinks.
 */
export async function dirSize(p, exclude = null, dedupLinks = false) {
  const ex = exclude && [...exclude].length ? new Set([...exclude].map(pathKey)) : null;
  return walk(String(p), ex, dedupLinks ? new Set() : null);
}

/** `dirSize`'s recursion. `seen` is null when not deduping, else the (dev, ino) pairs
 * already counted — shared across the whole walk, since the two names for one inode are
 * usually in different directories (`blobs/`, `snapshots/`). */
async function walk(p, exclude, seen) {
  let total = 0;
  let dir;
  try {
    dir = await opendir(p);
  } catch {
    return total; // missing path / not a dir → 0
  }
  try {
    for await (const entry of dir) {
      try {
        if (entry.isSymbolicLink()) continue; // never follow (HF blobs are symlinked from snapshots/)
        const child = path.join(p, entry.name);
        if (exclude?.has(pathKey(child))) continue;
        if (entry.isDirectory()) {
          total += await walk(child, exclude, seen);
        } else if (entry.isFile()) {
          // stat with bigint: the real (dev, ino, nlink) — on Windows too, and an NTFS
          // file index can pass 2^53. (Python had to avoid DirEntry.stat() there: it
          // carries no link data, so st_ino and st_nlink both read 0.)
          const st = await stat(child, { bigint: true });
          if (seen === null) {
            total += Number(st.size);
            continue;
          }
          if (st.nlink > 1n && st.ino) {
            const key = `${st.dev}:${st.ino}`;
            if (seen.has(key)) continue; // same bytes under another name
            seen.add(key);
          }
          total += Number(st.size);
        }
      } catch {
        /* the file vanished mid-walk / perms → skip it */
      }
    }
  } catch {
    /* the listing failed part-way → what was counted */
  }
  return total;
}

/** The SQLite DB file(s) at the data root plus each one's `-wal`/`-shm` sidecars
 * (present while a connection is open / mid-checkpoint). */
async function databaseBytes(dataDir) {
  let names;
  try {
    names = await readdir(dataDir);
  } catch {
    return 0;
  }
  // pathlib's glob("*.db"): case-insensitive on Windows only.
  const dbs = names.filter((n) => (IS_WIN ? n.toLowerCase() : n).endsWith(".db")).map((n) => path.join(dataDir, n));
  let total = 0;
  for (const db of dbs) {
    for (const p of [db, `${db}-wal`, `${db}-shm`]) {
      try {
        const st = await stat(p);
        if (st.isFile()) total += st.size;
      } catch {
        /* absent / vanished */
      }
    }
  }
  return total;
}

export const DiskUsageResponse = T.Object({
  database: opt(T.Integer(), 0),
  appLogs: opt(T.Integer(), 0),
  modelsCache: opt(T.Integer(), 0),
  engineBuilds: opt(T.Integer(), 0),
  spawnLogs: opt(T.Integer(), 0),
  total: opt(T.Integer(), 0),
  diskFree: opt(T.Integer(), 0),
  diskTotal: opt(T.Integer(), 0),
  // True when the engine cache is somewhere other than `<dataDir>/ai-cache` — a panel
  // offering "clear the models cache" needs to say WHOSE models those are.
  cacheShared: opt(T.Boolean(), false),
  // Host-declared buckets — app stores the shared kit doesn't know about (JV's speech
  // cache / render cache). Counted into `total`; {} for hosts that declare none.
  extras: opt(T.Record(T.String(), T.Integer()), {}),
});

// The runner's `configured_service()`, reached lazily: the runner is optional for a
// platform-only host, and a missing one must not break this panel. A test replaces it
// (`vi.spyOn(deps, "configuredService")`) — Python's tests set `lifecycle._service = None`.
export const deps = {
  async configuredService() {
    const lifecycle = await import("#runner/lifecycle");
    return lifecycle.configuredService();
  },
};

/**
 * [cacheRoot, runtimeRoot] from the WIRED runner service, falling back to the in-data-dir
 * layout when no host configured one (a platform-only app, the disk tests). Asking the
 * service keeps this honest once a cache can be shared — the sizes must describe the
 * files the engine actually uses.
 *
 * `configuredService()`, never `getService()`: the latter invents a standalone service
 * rooted at `~/.cache/just-llm-runner` rather than admitting there is none, which would
 * have this panel confidently measure a directory the app never uses.
 */
async function engineRoots(dataDir) {
  try {
    const svc = await deps.configuredService();
    if (svc != null) return [String(svc.cacheRoot), String(svc.runtimeRoot)];
  } catch (e) {
    // a disk panel must never fail on a wiring gap
    log.warning("could not read the engine cache roots — measuring the data dir", e);
  }
  const cache = path.join(dataDir, "ai-cache");
  return [cache, path.join(cache, "llamacpp")];
}

/** shutil.disk_usage(p) → [free, total] (Python's free is the volume's free bytes). */
async function diskUsage(p) {
  const s = await statfs(p);
  return [s.bavail * s.bsize, s.blocks * s.bsize];
}

/**
 * Build the shared read-only `GET /v1/disk/usage` over the app's `dataDir` (the portable
 * root that also holds `ai-cache/`).
 *
 * `extraBuckets` lets a host declare app-specific stores ({name: directory |
 * [directories]}; JV passes its speech stores — the speech cache PLUS the legacy
 * per-engine model dirs — and its render-cache root). A bucket with several directories
 * is summed: one honest number per user-facing store, wherever its files ended up across
 * layout generations. Each lands in `extras` under its declared name and counts into
 * `total`. Hosts that declare none get `extras: {}`.
 */
export function makeDiskRouter(dataDir, extraBuckets = null) {
  const root = String(dataDir);
  const extraRoots = Object.entries(extraBuckets || {}).map(([name, v]) => [
    name,
    (Array.isArray(v) ? v : [v]).map(String),
  ]);

  const app = new Hono();
  app.get("/v1/disk/usage", async (c) => {
    const [aiCache, runtime] = await engineRoots(root);
    const llamacpp = path.join(aiCache, "llamacpp");
    const spawnLogsDir = path.join(runtime, "logs");

    const database = await databaseBytes(root);
    const appLogs = await dirSize(path.join(root, "logs"));
    // dedupLinks: HF gives one blob two names — a symlink where it can, a hardlink or
    // a full copy where it cannot. Only the copy is really two files; count the shared
    // inode once so the panel reports the disk.
    const modelsCache = await dirSize(path.join(aiCache, "hf"), null, true);
    // Everything under llamacpp/ (build dirs + the generated models.ini) EXCEPT the
    // per-spawn logs/, which is its own bucket below.
    const engineBuilds = await dirSize(llamacpp, [spawnLogsDir]);
    const spawnLogs = await dirSize(spawnLogsDir);
    const extras = {};
    for (const [name, paths] of extraRoots) {
      let sum = 0;
      for (const p of paths) sum += await dirSize(p);
      extras[name] = sum;
    }
    const total =
      database + appLogs + modelsCache + engineBuilds + spawnLogs + Object.values(extras).reduce((a, b) => a + b, 0);

    let diskFree = 0;
    let diskTotal = 0;
    try {
      [diskFree, diskTotal] = await diskUsage(root);
    } catch (e) {
      log.warning(`disk_usage(${root}) failed — free/total reported 0`, e);
    }

    return c.json({
      database,
      appLogs,
      modelsCache,
      engineBuilds,
      spawnLogs,
      total,
      diskFree,
      diskTotal,
      cacheShared: !samePath(aiCache, path.join(root, "ai-cache")),
      extras,
    });
  });
  return app;
}
