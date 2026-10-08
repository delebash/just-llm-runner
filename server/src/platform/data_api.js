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
// The ZIP is written and read here (node has no zipfile): the same layout Python's
// zipfile writes (deflate, ZIP64 past 4 GiB), and Python-made backups restore. Uploads
// are streamed to a temp file rather than held in memory.

import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { cp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import multipart from "@fastify/multipart";
import { HttpError, RequestValidationError } from "./errors.js";
import { IS_WIN } from "./py.js";
import { openDatabase } from "./sql.js";

const DB_ARCNAME = "db.sqlite";

// ── ZIP (candidate for platform/) ────────────────────────────────────────────

export class BadZipFile extends Error {
  constructor(m) {
    super(m);
    this.name = "BadZipFile";
  }
}

const LIMIT32 = 0xffffffff;
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_END64_LOC = 0x07064b50;
const CREATE_SYSTEM = IS_WIN ? 0 : 3; // zipfile: 0 on Windows, 3 (Unix) elsewhere

// cp437's upper half — zipfile's decoding of a name without the UTF-8 flag.
const CP437_HIGH = `ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■${String.fromCharCode(0xa0)}`;
const cp437 = (buf) => [...buf].map((b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80])).join("");

/** DOS [time, date] of a local timestamp; before 1980 clamps to 1980-01-01. */
function dosDateTime(ms) {
  const d = new Date(ms);
  if (d.getFullYear() < 1980) return [0, (1 << 5) | 1];
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  ];
}

/** A ZIP built in memory as a list of chunks — zipfile.ZipFile(buf, "w", ZIP_DEFLATED). */
export class ZipWriter {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.entries = [];
  }

  push(buf) {
    this.chunks.push(buf);
    this.offset += buf.length;
  }

  /** `zf.write(file, arcname)`: the file's bytes, deflated, with its mtime and mode. */
  async addFile(file, arcname) {
    const st = await stat(file);
    const name = arcname.replace(/\\/g, "/").replace(/^\/+/, "");
    const ascii = Buffer.byteLength(name, "utf8") === name.length; // every character < 128
    const nameBuf = Buffer.from(name, ascii ? "latin1" : "utf8");
    const flags = ascii ? 0 : 0x800;
    const [time, date] = dosDateTime(st.mtimeMs);

    const out = [];
    let crc = 0;
    let size = 0;
    let csize = 0;
    const z = zlib.createDeflateRaw();
    z.on("data", (c) => {
      out.push(c);
      csize += c.length;
    });
    const ended = once(z, "end");
    for await (const chunk of createReadStream(file)) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      if (!z.write(chunk)) await once(z, "drain");
    }
    z.end();
    await ended;

    const headerOffset = this.offset;
    const zip64 = size >= LIMIT32 || csize >= LIMIT32;
    const version = zip64 ? 45 : 20;
    let extra = Buffer.alloc(0);
    if (zip64) {
      extra = Buffer.alloc(20);
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(csize), 12);
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(version, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(zip64 ? LIMIT32 : csize, 18);
    h.writeUInt32LE(zip64 ? LIMIT32 : size, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(extra.length, 28);
    this.push(h);
    this.push(nameBuf);
    if (extra.length) this.push(extra);
    for (const c of out) this.push(c);
    this.entries.push({ nameBuf, flags, time, date, crc: crc >>> 0, size, csize, headerOffset, mode: st.mode });
  }

  /** Write the central directory; the chunks are the whole archive. */
  finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const big = [];
      if (e.size >= LIMIT32) big.push(e.size);
      if (e.csize >= LIMIT32) big.push(e.csize);
      if (e.headerOffset >= LIMIT32) big.push(e.headerOffset);
      let extra = Buffer.alloc(0);
      if (big.length) {
        extra = Buffer.alloc(4 + 8 * big.length);
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(8 * big.length, 2);
        for (let i = 0; i < big.length; i++) extra.writeBigUInt64LE(BigInt(big[i]), 4 + 8 * i);
      }
      const version = big.length ? 45 : 20;
      const c = Buffer.alloc(46);
      c.writeUInt32LE(SIG_CENTRAL, 0);
      c.writeUInt8(version, 4);
      c.writeUInt8(CREATE_SYSTEM, 5);
      c.writeUInt16LE(version, 6);
      c.writeUInt16LE(e.flags, 8);
      c.writeUInt16LE(8, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(Math.min(e.csize, LIMIT32), 20);
      c.writeUInt32LE(Math.min(e.size, LIMIT32), 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt16LE(extra.length, 30);
      // 32: comment length, 34: disk start, 36: internal attrs — all 0
      c.writeUInt32LE(((e.mode & 0xffff) << 16) >>> 0, 38);
      c.writeUInt32LE(Math.min(e.headerOffset, LIMIT32), 42);
      this.push(c);
      this.push(e.nameBuf);
      if (extra.length) this.push(extra);
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    if (count >= 0xffff || cdStart >= LIMIT32 || cdSize >= LIMIT32) {
      const end64At = this.offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(SIG_END64, 0);
      r.writeBigUInt64LE(44n, 4);
      r.writeUInt16LE(45, 12);
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(count), 24);
      r.writeBigUInt64LE(BigInt(count), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(cdStart), 48);
      this.push(r);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_END64_LOC, 0);
      loc.writeBigUInt64LE(BigInt(end64At), 8);
      loc.writeUInt32LE(1, 16);
      this.push(loc);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(Math.min(count, 0xffff), 8);
    end.writeUInt16LE(Math.min(count, 0xffff), 10);
    end.writeUInt32LE(Math.min(cdSize, LIMIT32), 12);
    end.writeUInt32LE(Math.min(cdStart, LIMIT32), 16);
    this.push(end);
    return this.chunks;
  }
}

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/** zipfile's end-of-archive search (`_EndRecData` + `_EndRecData64`). */
async function endRecord(fh, fileSize) {
  if (fileSize < 22) return null;
  let at = -1;
  let rec = await readAt(fh, fileSize - 22, 22);
  if (rec.length === 22 && rec.readUInt32LE(0) === SIG_END && rec.readUInt16LE(20) === 0) {
    at = fileSize - 22;
  } else {
    const from = Math.max(fileSize - (1 << 16) - 22, 0);
    const data = await readAt(fh, from, fileSize - from);
    const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const i = data.lastIndexOf(sig);
    if (i < 0 || data.length - i < 22) return null;
    at = from + i;
    rec = data.subarray(i, i + 22);
  }
  const end = { at, zip64: false, cdSize: rec.readUInt32LE(12), cdOffset: rec.readUInt32LE(16) };
  if (at >= 20) {
    const loc = await readAt(fh, at - 20, 20);
    if (loc.length === 20 && loc.readUInt32LE(0) === SIG_END64_LOC) {
      if (loc.readUInt32LE(4) !== 0 || loc.readUInt32LE(16) > 1) {
        throw new BadZipFile("zipfiles that span multiple disks are not supported");
      }
      if (at >= 76) {
        const r = await readAt(fh, at - 76, 56);
        if (r.length === 56 && r.readUInt32LE(0) === SIG_END64) {
          end.zip64 = true;
          end.cdSize = Number(r.readBigUInt64LE(40));
          end.cdOffset = Number(r.readBigUInt64LE(48));
        }
      }
    }
  }
  return end;
}

/** A ZIP on disk, read the way zipfile reads one: central directory first (a failure
 * there is "not a zip"), members on extraction (a failure there is an error). */
export class ZipReader {
  constructor(file, entries) {
    this.file = file;
    this.entries = entries;
  }

  static async open(file) {
    const fh = await open(file, "r");
    try {
      const fileSize = (await fh.stat()).size;
      const end = await endRecord(fh, fileSize);
      if (!end) throw new BadZipFile("File is not a zip file");
      let concat = end.at - end.cdSize - end.cdOffset;
      if (end.zip64) concat -= 56 + 20;
      const start = end.cdOffset + concat;
      if (start < 0) throw new BadZipFile("Bad offset for central directory");
      const cd = await readAt(fh, start, end.cdSize);
      const entries = [];
      let pos = 0;
      while (pos < end.cdSize) {
        if (cd.length - pos < 46) throw new BadZipFile("Truncated central directory");
        if (cd.readUInt32LE(pos) !== SIG_CENTRAL) throw new BadZipFile("Bad magic number for central directory");
        const flags = cd.readUInt16LE(pos + 8);
        const n = cd.readUInt16LE(pos + 28);
        const x = cd.readUInt16LE(pos + 30);
        const k = cd.readUInt16LE(pos + 32);
        const rawName = cd.subarray(pos + 46, pos + 46 + n);
        const origName = flags & 0x800 ? rawName.toString("utf8") : cp437(rawName);
        const e = {
          origName,
          name: sanitizeFilename(origName),
          flags,
          method: cd.readUInt16LE(pos + 10),
          crc: cd.readUInt32LE(pos + 16),
          csize: cd.readUInt32LE(pos + 20),
          size: cd.readUInt32LE(pos + 24),
          offset: cd.readUInt32LE(pos + 42),
        };
        decodeZip64Extra(e, cd.subarray(pos + 46 + n, pos + 46 + n + x));
        e.offset += concat;
        entries.push(e);
        pos += 46 + n + x + k;
      }
      return new ZipReader(file, entries);
    } finally {
      await fh.close();
    }
  }

  /** `namelist()`. */
  names() {
    return this.entries.map((e) => e.name);
  }

  /** `extractall(dir)`: every member, its name made safe the way zipfile makes it. */
  async extractAll(dir) {
    for (const e of this.entries) await this.extract(e, dir);
  }

  async extract(e, dir) {
    const isDir = e.name.endsWith("/");
    const rel = safeArcname(e.name);
    if (!rel && !isDir) throw new Error("Empty filename.");
    const target = path.normalize(path.join(dir, rel));
    const upper = path.dirname(target);
    if (upper && !existsSync(upper)) mkdirSync(upper, { recursive: true });
    if (isDir) {
      if (!existsSync(target) || !statSync(target).isDirectory()) mkdirSync(target);
      return;
    }
    const fh = await open(this.file, "r");
    let dataAt;
    try {
      const h = await readAt(fh, e.offset, 30);
      if (h.length !== 30) throw new BadZipFile("Truncated file header");
      if (h.readUInt32LE(0) !== SIG_LOCAL) throw new BadZipFile("Bad magic number for file header");
      const n = h.readUInt16LE(26);
      const fname = await readAt(fh, e.offset + 30, n);
      const fnameStr = h.readUInt16LE(6) & 0x800 ? fname.toString("utf8") : cp437(fname);
      if (fnameStr !== e.origName) {
        throw new BadZipFile(`File name in directory '${e.origName}' and header ${fname} differ.`);
      }
      dataAt = e.offset + 30 + n + h.readUInt16LE(28);
    } finally {
      await fh.close();
    }
    if (e.flags & 0x1) throw new Error(`File '${e.name}' is encrypted, password required for extraction`);
    if (e.method !== 0 && e.method !== 8) throw new Error("That compression method is not supported");
    let crc = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        crc = zlib.crc32(chunk, crc);
        cb(null, chunk);
      },
    });
    const src = e.csize
      ? createReadStream(this.file, { start: dataAt, end: dataAt + e.csize - 1 })
      : Readable.from([]);
    const stages = e.method === 8 && e.csize ? [src, zlib.createInflateRaw(), tap] : [src, tap];
    await pipeline(...stages, createWriteStream(target));
    if (crc >>> 0 !== e.crc) throw new BadZipFile(`Bad CRC-32 for file '${e.name}'`);
  }
}

function decodeZip64Extra(e, extra) {
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const len = extra.readUInt16LE(i + 2);
    if (i + 4 + len > extra.length) throw new BadZipFile(`Corrupt extra field ${id.toString(16).padStart(4, "0")} (size=${len})`);
    if (id === 1) {
      let j = i + 4;
      const take = (field) => {
        if (e[field] !== LIMIT32) return;
        if (j + 8 > i + 4 + len) throw new BadZipFile("Corrupt zip64 extra field");
        e[field] = Number(extra.readBigUInt64LE(j));
        j += 8;
      };
      take("size");
      take("csize");
      take("offset");
    }
    i += 4 + len;
  }
}

/** ZipInfo's own clean-up of a stored name: cut at a NUL, the OS separator → "/". */
function sanitizeFilename(name) {
  let s = name;
  const nul = s.indexOf("\0");
  if (nul >= 0) s = s.slice(0, nul);
  if (IS_WIN) s = s.replace(/\\/g, "/");
  return s;
}

/** zipfile's `_extract_member` path: no drive, no root, no ".."/"." parts; on Windows the
 * illegal characters become "_" and trailing dots/spaces go. */
function safeArcname(name) {
  let s = name.replace(/\//g, path.sep);
  if (IS_WIN) s = s.replace(/^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)/, ""); // splitdrive
  let parts = s.split(path.sep).filter((x) => x !== "" && x !== "." && x !== "..");
  if (IS_WIN) {
    parts = parts
      .map((x) => x.replace(/[:<>|"?*]/g, "_").replace(/[ .]+$/, ""))
      .filter((x) => x);
  }
  return parts.join(path.sep);
}

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

/** FastAPI's `file: UploadFile`: the form's last `file` part, streamed to `dest`; a
 * missing one, or a plain field in its place, is pydantic's 422 (measured answers). */
async function receiveUpload(req, dest) {
  let kind = null; // "file" | "field"
  if (req.isMultipart()) {
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname === "file") {
          await pipeline(part.file, createWriteStream(dest));
          kind = "file";
        } else {
          part.file.resume();
          await once(part.file, "end");
        }
      } else if (part.fieldname === "file") {
        kind = "field";
      }
    }
  } else if (typeof req.body === "string" && /^application\/x-www-form-urlencoded/i.test(req.headers["content-type"] || "")) {
    if (new URLSearchParams(req.body).has("file")) kind = "field";
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

  return async function dataRouter(app) {
    if (!app.hasRequestDecorator("isMultipart")) {
      // FastAPI has no upload limit; a backup with audio is easily over the 1 GiB default.
      await app.register(multipart, { limits: { fileSize: Number.POSITIVE_INFINITY } });
    }

    app.get(`${prefix}/backup`, async (req, reply) => {
      // `exclude` = comma-separated asset-dir ARCNAMES to leave out of this backup (the
      // kit DataManagement's per-app options seam — decision ①, family parity batch
      // 2026-08-05: JV skips its generated audio). Unknown names are ignored; the DB is
      // never excludable. A restore of a backup missing a declared dir leaves the live
      // copy of that dir untouched (the `isDirectory` guard in restore).
      let exclude = req.query?.exclude ?? "";
      if (Array.isArray(exclude)) exclude = exclude[exclude.length - 1]; // the last, as Starlette
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
      return reply
        .type("application/zip")
        .header("content-disposition", 'attachment; filename="backup.zip"')
        .send(Readable.from(chunks));
    });

    app.post(`${prefix}/restore`, async (req) => {
      const upDir = mkdtempSync(path.join(tmpdir(), "llm-runner-upload-"));
      const tmp = mkdtempSync(path.join(tmpdir(), "llm-runner-restore-"));
      try {
        const upload = path.join(upDir, "backup.zip");
        await receiveUpload(req, upload);
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
              const cols = mainCols.filter((c) => srcCols.has(c));
              if (!cols.length) continue;
              const colSql = cols.map((c) => `"${c}"`).join(", ");
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
      return { ok: true };
    });

    app.post(`${prefix}/reset`, async () => {
      await runReset();
      return { ok: true };
    });
  };
}
