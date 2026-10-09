// SPDX-License-Identifier: MIT
// The shared data-management router — backup / restore / reset over a host's SQLite
// database + asset directories (the port of llm_runner/platform/data_api.py).
//
// Same machinery for every same-stack app; only the host hooks differ — the DB path, the
// table list, a reset callback, and any extra asset dirs to bundle. The mechanism is
// schema-agnostic, so a new app gets backup/restore/reset for free.
//
// Endpoints (mounted under `prefix`, default `/v1/data`):
//   GET  /backup  → a ZIP: a clean DB copy (SQLite `VACUUM INTO`, WAL-safe) plus each
//                   declared asset dir.
//   POST /restore → replace data from an uploaded backup ZIP by **table-copy** (no
//                   live-file swap → no cross-platform file-lock issue): for every known
//                   table, the live rows are deleted and re-inserted from the backup DB
//                   (column-aware, so an older/newer backup with a drifted column still
//                   loads). Declared asset dirs are replaced too.
//   POST /reset   → first-run state via the host's reset callback (delete all rows +
//                   reseed).
//
// Python's `metadata` (SQLAlchemy MetaData) is the captured TABLES list here
// (scripts/capture-schema.py — `[{name, ddl, …}]`), or a list of them when the app has
// more than one base on the same DB (the domain base + the shared LLM tables). Tables run
// in `metadata.sorted_tables` order: by name, then parents before children (the FKs read
// from each table's DDL).
//
// The ZIP is platform/zip.js — what Python's zipfile writes and reads, so Python-made
// backups restore. Uploads are streamed to a temp file rather than held in memory.

import { createWriteStream, existsSync, mkdtempSync, statSync } from "node:fs";
import { cp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "@fastify/busboy";
import { Hono } from "hono";
import { HttpError, RequestValidationError } from "./errors.js";
import { openDatabase } from "./sql.js";
import { BadZipFile, ZipReader, ZipWriter } from "./zip.js";

const DB_ARCNAME = "db.sqlite";

// ── table order (SQLAlchemy's MetaData.sorted_tables) ────────────────────────

const tablesOf = (metadata) => {
  const list = Array.isArray(metadata) ? metadata : [metadata];
  return list.length && list.every(Array.isArray) ? list : [list];
};

/** One metadata's tables: by name, then layered so every parent precedes its children
 * (sqlalchemy.util.topological.sort with deterministic order; self-references ignored). */
export function sortedTables(tables) {
  const byName = new Map();
  for (const t of tables) {
    const name = typeof t === "string" ? t : t.name;
    const ddl = typeof t === "string" ? "" : t.ddl || "";
    byName.set(name, ddl);
  }
  const names = [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parents = new Map();
  for (const n of names) {
    const deps = new Set();
    for (const m of byName.get(n).matchAll(/REFERENCES\s+(?:"([^"]+)"|([^\s(]+))/gi)) {
      const ref = m[1] ?? m[2];
      if (ref !== n && byName.has(ref)) deps.add(ref);
    }
    parents.set(n, deps);
  }
  const out = [];
  let todo = names;
  const todoSet = new Set(names);
  while (todoSet.size) {
    const layer = todo.filter((n) => [...parents.get(n)].every((p) => !todoSet.has(p)));
    if (!layer.length) {
      // A cycle: SQLAlchemy drops the cycle's edges and sorts again; name order here.
      out.push(...todo);
      break;
    }
    for (const n of layer) todoSet.delete(n);
    out.push(...layer);
    todo = todo.filter((n) => todoSet.has(n));
  }
  return out;
}

// ── the router ───────────────────────────────────────────────────────────────

const entriesOf = (x) => (x instanceof Map ? [...x.entries()] : Object.entries(x || {}));

/** `_add_dir`: every file under `d` (rglob order: a folder's entries, then its subfolders
 * depth-first), stored as `<arcname>/<relative posix path>`. Symlinked files are read;
 * symlinked folders are not entered. */
async function addDir(zip, arcname, d, rel = "") {
  let entries;
  try {
    if (!statSync(d).isDirectory()) return;
    entries = await readdir(path.join(d, rel), { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs = [];
  for (const e of entries) {
    const full = path.join(d, rel, e.name);
    const relPosix = rel ? `${rel.split(path.sep).join("/")}/${e.name}` : e.name;
    if (e.isDirectory()) subdirs.push(e.name);
    else if (e.isFile() || (e.isSymbolicLink() && statSync(full, { throwIfNoEntry: false })?.isFile())) {
      await zip.addFile(full, `${arcname}/${relPosix}`);
    }
  }
  for (const s of subdirs) await addDir(zip, arcname, d, rel ? path.join(rel, s) : s);
}

const MISSING_FILE = () =>
  new RequestValidationError([{ loc: ["body", "file"], msg: "Field required", type: "missing" }]);
const FILE_NOT_UPLOAD = () =>
  new RequestValidationError([
    { loc: ["body", "file"], msg: "Value error, Expected UploadFile, received: <class 'str'>", type: "value_error" },
  ]);

/** FastAPI's `file: UploadFile`: the form's last `file` part, streamed to `dest` (busboy over the
 * request's own body stream — never held in memory); a missing one, or a plain field in its
 * place, is pydantic's 422 (measured answers). */
async function receiveUpload(c, dest) {
  let kind = null; // "file" | "field"
  const type = c.req.header("content-type") || "";
  if (/^multipart\//i.test(type) && c.req.raw.body) {
    const bb = new Busboy({ headers: { "content-type": type } });
    // Parts arrive in order; each `file` part is written after the one before, so the last wins.
    let writes = Promise.resolve();
    bb.on("file", (fieldname, file) => {
      if (fieldname === "file") {
        kind = "file";
        writes = writes.then(() => pipeline(file, createWriteStream(dest)));
      } else {
        file.resume();
      }
    });
    bb.on("field", (fieldname) => {
      if (fieldname === "file") kind = "field";
    });
    await pipeline(Readable.fromWeb(c.req.raw.body), bb);
    await writes;
  } else if (/^application\/x-www-form-urlencoded/i.test(type)) {
    if (new URLSearchParams(await c.req.text()).has("file")) kind = "field";
  }
  if (kind === null) throw MISSING_FILE();
  if (kind === "field") throw FILE_NOT_UPLOAD();
}

/**
 * Build the shared data backup/restore/reset router over host hooks (sync or async).
 *   - `getDbPath()`  → the live SQLite file path.
 *   - `metadata`     → the app's captured TABLES list, OR a list of them when the app has
 *                      more than one base on the same DB (the domain base + the shared LLM
 *                      tables). Tables across all of them are covered (no cross-base FKs).
 *   - `runReset()`   → wipe to first-run state (delete all rows + reseed). The host owns
 *                      it (it knows its storage + seed); a callback so reset and the app's
 *                      own seeding stay one implementation.
 *   - `assetDirs()`  → `{arcname: dir}` extra directories to include in a backup and
 *                      replace on restore (e.g. JustVoice `audio/`).
 *   - `onReplaced()` → called after a successful RESTORE replaced the data under a live
 *                      app (2026-07-11): the host tears down anything derived from the old
 *                      data (e.g. the LLM runner's resident models + VRAM ledger). Reset
 *                      covers itself inside `runReset`.
 */
export function makeDataRouter({ getDbPath, metadata, runReset, assetDirs = null, prefix = "/v1/data", onReplaced = null }) {
  const assets = async () => entriesOf(assetDirs ? await assetDirs() : {});
  /** Every table across all metadatas, FK-ordered within each (parents first). */
  const orderedTables = () => tablesOf(metadata).flatMap(sortedTables);

  // FastAPI has no upload limit; a backup with audio is easily over 1 GiB — the restore streams
  // its upload to disk (receiveUpload), with no limit.
  const app = new Hono();

  app.get(`${prefix}/backup`, async (c) => {
    // `exclude` = comma-separated asset-dir ARCNAMES to leave out of this backup (the
    // kit DataManagement's per-app options seam — decision ①, family parity batch
    // 2026-08-05: JV skips its generated audio). Unknown names are ignored; the DB is
    // never excludable. A restore of a backup missing a declared dir leaves the live
    // copy of that dir untouched (the `isDirectory` guard in restore).
    const excludes = c.req.queries("exclude") ?? [];
    const exclude = excludes.length ? excludes[excludes.length - 1] : ""; // the last, as Starlette
    const skip = new Set(
      String(exclude)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    );
    const dbPath = String(await getDbPath());
    if (!existsSync(dbPath)) throw new HttpError(404, "no database to back up");
    const tmp = mkdtempSync(path.join(tmpdir(), "llm-runner-backup-"));
    let chunks;
    try {
      const clean = path.join(tmp, DB_ARCNAME);
      const h = openDatabase(dbPath, { foreignKeys: false, timeoutMs: 5000 });
      try {
        // WAL-safe consistent copy without locking the live DB out.
        h.run("VACUUM INTO ?", [clean]);
      } finally {
        h.close();
      }
      const zip = new ZipWriter();
      await zip.addFile(clean, DB_ARCNAME);
      for (const [arcname, d] of await assets()) {
        if (skip.has(arcname)) continue;
        await addDir(zip, arcname, String(d));
      }
      chunks = zip.finish();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    return c.body(Readable.toWeb(Readable.from(chunks)), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="backup.zip"',
    });
  });

  app.post(`${prefix}/restore`, async (c) => {
    const upDir = mkdtempSync(path.join(tmpdir(), "llm-runner-upload-"));
    const tmp = mkdtempSync(path.join(tmpdir(), "llm-runner-restore-"));
    try {
      const upload = path.join(upDir, "backup.zip");
      await receiveUpload(c, upload);
      let zf;
      try {
        zf = await ZipReader.open(upload);
      } catch (e) {
        if (e instanceof BadZipFile || e.code === "ERR_OUT_OF_RANGE") throw new HttpError(400, "not a valid backup zip");
        throw e;
      }
      if (!zf.names().includes(DB_ARCNAME)) throw new HttpError(400, `backup is missing ${DB_ARCNAME}`);
      await zf.extractAll(tmp);
      const srcDb = path.join(tmp, DB_ARCNAME);
      const h = openDatabase(String(await getDbPath()), { foreignKeys: false, timeoutMs: 5000 });
      try {
        h.run("ATTACH ? AS src", [srcDb]);
        const tables = orderedTables();
        const srcTables = new Set(h.all("SELECT name FROM src.sqlite_master WHERE type='table'").map((r) => r.name));
        h.tx(() => {
          // Clear children → parents, refill parents → children.
          for (const t of [...tables].reverse()) h.exec(`DELETE FROM main."${t}"`);
          for (const t of tables) {
            if (!srcTables.has(t)) continue;
            const mainCols = h.all(`PRAGMA table_info("${t}")`).map((r) => r.name);
            const srcCols = new Set(h.all(`PRAGMA src.table_info("${t}")`).map((r) => r.name));
            const cols = mainCols.filter((col) => srcCols.has(col));
            if (!cols.length) continue;
            const colSql = cols.map((col) => `"${col}"`).join(", ");
            h.exec(`INSERT INTO main."${t}" (${colSql}) SELECT ${colSql} FROM src."${t}"`);
          }
        });
        h.exec("DETACH src");
      } catch (e) {
        // surface restore failures as data (the transaction rolled back)
        throw new HttpError(400, `restore failed: ${String(e?.message ?? e).slice(0, 300)}`);
      } finally {
        h.close();
      }
      // Replace each declared asset dir with the backup's copy.
      for (const [arcname, d] of await assets()) {
        const bdir = path.join(tmp, arcname);
        if (existsSync(bdir) && statSync(bdir).isDirectory()) {
          if (existsSync(String(d))) await rm(String(d), { recursive: true });
          await cp(bdir, String(d), { recursive: true, preserveTimestamps: true });
        }
      }
    } finally {
      await rm(upDir, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
    if (onReplaced) await onReplaced();
    return c.json({ ok: true });
  });

  app.post(`${prefix}/reset`, async (c) => {
    await runReset();
    return c.json({ ok: true });
  });
  return app;
}
