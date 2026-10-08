// SPDX-License-Identifier: MIT
// ZIP archives, written and read the way CPython 3.12's `zipfile` writes and reads them — the
// family's one copy (Node has no zipfile).
//
//   ZipWriter   `zipfile.ZipFile(buf, "w", ZIP_DEFLATED)`: `writestr(arcname, data)` (sync, in
//               memory: the local time now, mode 0o600) and `await addFile(file, arcname)`
//               (`write`, streamed from disk: the file's mtime and mode); `finish()` → the
//               archive as chunks, `toBuffer()` → one Buffer.
//   ZipReader   `zipfile.ZipFile(f)`: `await ZipReader.open(file)` (on disk) or
//               `ZipReader.fromBuffer(buf)` (in memory) reads the central directory (a failure
//               there is BadZipFile, "not a zip"); then `names()`, `info(name)`, `read(name)`
//               → Buffer, `await extract(name, dir)` / `await extractAll(dir)`.
//   extractZip  `zipfile.ZipFile(archive).extractall(dest)`.
//
// What zipfile does, this does: deflate, the UTF-8 flag only for a non-ASCII name (else
// cp437), ZIP64 at zipfile's 2 GiB limits, the end-record search, the name and CRC checks on
// reading, and extractall's safe names (no drive, root, "." or ".."; on Windows the illegal
// characters become "_"). Python reads what this writes and the reverse; the bytes are not
// Python's byte for byte (the deflate stream comes from Node's zlib). Not done: bzip2/lzma
// members, encryption, the 0x7075 Unicode-path extra field, writing directory entries.
//
// Until 2026-10-08 there were four copies: the kit's backup/restore and the runner's binary
// unpack, JustWrite's book transfer and JustVoice's voice bundle.

import { once } from "node:events";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { IS_WIN, KeyError, NotImplementedError, RuntimeError, ValueError } from "./py.js";

export class BadZipFile extends Error {
  constructor(m) {
    super(m);
    this.name = "BadZipFile";
  }
}


const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_END64_LOC = 0x07064b50;
const LIMIT32 = 0xffffffff;
const ZIP64_LIMIT = 2 ** 31 - 1; // zipfile.ZIP64_LIMIT
const ZIP_FILECOUNT_LIMIT = 0xffff;
const ZIP_MAX_COMMENT = 0xffff;
const FLAG_UTF8 = 0x800;
const CREATE_SYSTEM = IS_WIN ? 0 : 3; // ZipInfo.create_system: 0 on Windows, 3 (Unix) elsewhere

// cp437's upper half — zipfile's decoding of a name without the UTF-8 flag.
const CP437_HIGH = `ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■${String.fromCharCode(0xa0)}`;
const cp437 = (buf) => [...buf].map((b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80])).join("");
// `bytes.decode("utf-8")`: a bad byte throws (a TypeError here, UnicodeDecodeError in Python).
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const decodeName = (buf, flags) => (flags & FLAG_UTF8 ? UTF8_STRICT.decode(buf) : cp437(buf));

/** DOS [time, date] of a local timestamp; before 1980 clamps to 1980-01-01. */
function dosDateTime(d) {
  if (d.getFullYear() < 1980) return [0, (1 << 5) | 1];
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  ];
}

/** ZipInfo's `_encodeFilenameFlags`: ASCII as is, anything else UTF-8 with the flag. */
function encodeName(name) {
  const ascii = Buffer.byteLength(name, "utf8") === name.length; // every character < 128
  return [Buffer.from(name, ascii ? "latin1" : "utf8"), ascii ? 0 : FLAG_UTF8];
}

/** ZIP64's extra field (id 1) holding `values` as 8-byte numbers. */
function zip64Extra(values) {
  const x = Buffer.alloc(4 + 8 * values.length);
  x.writeUInt16LE(1, 0);
  x.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => x.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return x;
}

// ── writing ──────────────────────────────────────────────────────────────────

/** A ZIP built in memory as a list of chunks — `zipfile.ZipFile(buf, "w", ZIP_DEFLATED)`. */
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

  /** `zf.writestr(arcname, data)`: a str is written as UTF-8; the local time now, mode 0o600. */
  writestr(arcname, data) {
    const raw = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const crc = zlib.crc32(raw) >>> 0;
    this.#add(arcname, new Date(), 0o600, raw.length, { crc, size: raw.length, comp: [zlib.deflateRawSync(raw)] });
  }

  /** `zf.write(file, arcname)`: the file's bytes, deflated as they stream, with its mtime and mode. */
  async addFile(file, arcname) {
    const st = await stat(file);
    const name = arcname.replace(/\\/g, "/").replace(/^\/+/, "");
    const comp = [];
    let crc = 0;
    let size = 0;
    const z = zlib.createDeflateRaw();
    z.on("data", (c) => comp.push(c));
    const ended = once(z, "end");
    for await (const chunk of createReadStream(file)) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      if (!z.write(chunk)) await once(z, "drain");
    }
    z.end();
    await ended;
    this.#add(name, new Date(st.mtimeMs), st.mode, st.size, { crc: crc >>> 0, size, comp });
  }

  /** One member: its local header, then its deflated bytes. ZIP64 is decided up front from the
   * size zipfile knows before writing (`file_size * 1.05 > ZIP64_LIMIT`), as zipfile does. */
  #add(name, when, mode, plannedSize, { crc, size, comp }) {
    const csize = comp.reduce((n, c) => n + c.length, 0);
    const zip64 = plannedSize * 1.05 > ZIP64_LIMIT;
    if (!zip64 && size > ZIP64_LIMIT) throw new RuntimeError("File size too large, try using force_zip64");
    if (!zip64 && csize > ZIP64_LIMIT) throw new RuntimeError("Compressed size too large, try using force_zip64");
    const [nameBuf, flags] = encodeName(name);
    const [time, date] = dosDateTime(when);
    const version = zip64 ? 45 : 20;
    const extra = zip64 ? zip64Extra([size, csize]) : Buffer.alloc(0);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(version, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(zip64 ? LIMIT32 : csize, 18);
    h.writeUInt32LE(zip64 ? LIMIT32 : size, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(extra.length, 28);
    const headerOffset = this.offset;
    this.push(h);
    this.push(nameBuf);
    if (extra.length) this.push(extra);
    for (const c of comp) this.push(c);
    this.entries.push({ nameBuf, flags, time, date, crc, size, csize, headerOffset, mode, version });
  }

  /** `close()`: the central directory and end record; the chunks are the whole archive. */
  finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const big = [];
      let size = e.size;
      let csize = e.csize;
      let offset = e.headerOffset;
      if (e.size > ZIP64_LIMIT || e.csize > ZIP64_LIMIT) {
        big.push(e.size, e.csize);
        size = LIMIT32;
        csize = LIMIT32;
      }
      if (e.headerOffset > ZIP64_LIMIT) {
        big.push(e.headerOffset);
        offset = LIMIT32;
      }
      const extra = big.length ? zip64Extra(big) : Buffer.alloc(0);
      const version = Math.max(big.length ? 45 : 0, e.version);
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
      c.writeUInt32LE(csize, 20);
      c.writeUInt32LE(size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt16LE(extra.length, 30);
      // 32: comment length, 34: disk start, 36: internal attrs — all 0
      c.writeUInt32LE(((e.mode & 0xffff) << 16) >>> 0, 38);
      c.writeUInt32LE(offset, 42);
      this.push(c);
      this.push(e.nameBuf);
      if (extra.length) this.push(extra);
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    if (count > ZIP_FILECOUNT_LIMIT || cdStart > ZIP64_LIMIT || cdSize > ZIP64_LIMIT) {
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

  /** `finish()` as one Buffer. */
  toBuffer() {
    return Buffer.concat(this.finish());
  }
}

// ── reading ──────────────────────────────────────────────────────────────────

/** zipfile's end-of-archive search (`_EndRecData` + `_EndRecData64`) over `readAt(pos, len)`
 * of a `size`-byte archive. Null when there is no end record. */
function endRecord(readAt, size) {
  if (size < 22) return null;
  let at;
  let rec = readAt(size - 22, 22);
  if (rec.readUInt32LE(0) === SIG_END && rec.readUInt16LE(20) === 0) {
    at = size - 22;
  } else {
    const from = Math.max(size - ZIP_MAX_COMMENT - 22, 0);
    const i = readAt(from, size - from).lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (i < 0 || size - from - i < 22) return null; // none, or a corrupt one
    at = from + i;
    rec = readAt(at, 22);
  }
  const end = { at, zip64: false, cdSize: rec.readUInt32LE(12), cdOffset: rec.readUInt32LE(16) };
  if (at >= 20) {
    const loc = readAt(at - 20, 20);
    if (loc.readUInt32LE(0) === SIG_END64_LOC) {
      if (loc.readUInt32LE(4) !== 0 || loc.readUInt32LE(16) > 1) {
        throw new BadZipFile("zipfiles that span multiple disks are not supported");
      }
      if (at >= 76) {
        const r = readAt(at - 76, 56);
        if (r.readUInt32LE(0) === SIG_END64) {
          end.zip64 = true;
          end.cdSize = Number(r.readBigUInt64LE(40));
          end.cdOffset = Number(r.readBigUInt64LE(48));
        }
      }
    }
  }
  return end;
}

/** Where the central directory starts, and `concat`: the bytes prepended to the archive. */
function centralStart(end) {
  let concat = end.at - end.cdSize - end.cdOffset;
  if (end.zip64) concat -= 56 + 20;
  const start = end.cdOffset + concat;
  if (start < 0) throw new BadZipFile("Bad offset for central directory");
  return [start, concat];
}

/** `_RealGetContents`' walk of the central directory's `cdSize` bytes. */
function centralEntries(cd, cdSize, concat) {
  const entries = [];
  let pos = 0;
  while (pos < cdSize) {
    if (cd.length - pos < 46) throw new BadZipFile("Truncated central directory");
    if (cd.readUInt32LE(pos) !== SIG_CENTRAL) throw new BadZipFile("Bad magic number for central directory");
    const flags = cd.readUInt16LE(pos + 8);
    const n = cd.readUInt16LE(pos + 28);
    const x = cd.readUInt16LE(pos + 30);
    const k = cd.readUInt16LE(pos + 32);
    const origName = decodeName(cd.subarray(pos + 46, pos + 46 + n), flags);
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
  return entries;
}

/** `ZipInfo._decodeExtra`'s ZIP64 field: the 0xFFFFFFFF fields, in order. */
function decodeZip64Extra(e, extra) {
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const len = extra.readUInt16LE(i + 2);
    if (i + 4 + len > extra.length) throw new BadZipFile(`Corrupt extra field ${id.toString(16).padStart(4, "0")} (size=${len})`);
    if (id === 1) {
      let j = i + 4;
      for (const [field, label] of [
        ["size", "File size"],
        ["csize", "Compress size"],
        ["offset", "Header offset"],
      ]) {
        if (e[field] !== LIMIT32) continue;
        if (j + 8 > i + 4 + len) throw new BadZipFile(`Corrupt zip64 extra field. ${label} not found.`);
        e[field] = Number(extra.readBigUInt64LE(j));
        j += 8;
      }
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

/** `ntpath.splitdrive(p)[1]` (Python 3.12) for a path already using "\\". */
function dropDrive(p) {
  if (p[1] === ":") return p.slice(2);
  if (!p.startsWith("\\\\")) return p;
  const start = p.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\" ? 8 : 2;
  const i = p.indexOf("\\", start);
  const j = i < 0 ? -1 : p.indexOf("\\", i + 1);
  return j < 0 ? "" : p.slice(j);
}

/** zipfile's `_extract_member` path: no drive, no root, no "."/".." parts; on Windows the
 * illegal characters become "_" and trailing dots/spaces go. */
function safeArcname(name) {
  let s = name.replace(/\//g, path.sep);
  if (IS_WIN) s = dropDrive(s);
  let parts = s.split(path.sep).filter((x) => x !== "" && x !== "." && x !== "..");
  if (IS_WIN) {
    parts = parts.map((x) => x.replace(/[:<>|"?*]/g, "_").replace(/[ .]+$/, "")).filter((x) => x);
  }
  return parts.join(path.sep);
}

/** `len` bytes at `pos` of an open file (fewer at its end). */
function readFdAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

async function readFhAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

const isDirectory = (p) => existsSync(p) && statSync(p).isDirectory();

/** A ZIP read the way zipfile reads one: the central directory up front (a failure there is
 * "not a zip"), each member when it is read or extracted (a failure there is an error). */
export class ZipReader {
  /** Use `ZipReader.open(file)` or `ZipReader.fromBuffer(buf)`. */
  constructor({ file = null, buf = null }, entries) {
    this.file = file;
    this.buf = buf;
    this.entries = entries;
    this.byName = new Map(entries.map((e) => [e.name, e])); // zipfile's NameToInfo: the last wins
  }

  /** `zipfile.ZipFile(file)` — an archive on disk. */
  static async open(file) {
    const fh = await open(file, "r");
    try {
      const size = (await fh.stat()).size;
      // Everything the end-record search can touch: the record, its comment, the ZIP64 pair.
      const from = Math.max(size - ZIP_MAX_COMMENT - 22 - 76, 0);
      const tail = await readFhAt(fh, from, size - from);
      const end = endRecord((pos, len) => tail.subarray(pos - from, pos - from + len), size);
      if (!end) throw new BadZipFile("File is not a zip file");
      const [start, concat] = centralStart(end);
      const cd = await readFhAt(fh, start, end.cdSize);
      return new ZipReader({ file }, centralEntries(cd, end.cdSize, concat));
    } finally {
      await fh.close();
    }
  }

  /** `zipfile.ZipFile(io.BytesIO(buf))` — an archive in memory. */
  static fromBuffer(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const end = endRecord((pos, len) => buf.subarray(pos, pos + len), buf.length);
    if (!end) throw new BadZipFile("File is not a zip file");
    const [start, concat] = centralStart(end);
    return new ZipReader({ buf }, centralEntries(buf.subarray(start, start + end.cdSize), end.cdSize, concat));
  }

  /** `namelist()`. */
  names() {
    return this.entries.map((e) => e.name);
  }

  /** `getinfo(name)` — the LAST member of that name, as zipfile keeps. */
  info(name) {
    const e = this.byName.get(name);
    if (e === undefined) throw new KeyError(`There is no item named '${name}' in the archive`);
    return e;
  }

  /** `len` bytes at `pos` of the archive (fewer past its end). */
  bytesAt(pos, len) {
    if (pos < 0) return Buffer.alloc(0);
    if (this.buf) return this.buf.subarray(pos, pos + len);
    const fd = openSync(this.file, "r");
    try {
      return readFdAt(fd, pos, len);
    } finally {
      closeSync(fd);
    }
  }

  /** `open(member)`'s checks of the local header → where the member's data starts. */
  dataStart(e) {
    const h = this.bytesAt(e.offset, 30);
    if (h.length !== 30) throw new BadZipFile("Truncated file header");
    if (h.readUInt32LE(0) !== SIG_LOCAL) throw new BadZipFile("Bad magic number for file header");
    const n = h.readUInt16LE(26);
    const fname = this.bytesAt(e.offset + 30, n);
    if (e.flags & 0x20) throw new NotImplementedError("compressed patched data (flag bit 5)");
    if (e.flags & 0x40) throw new NotImplementedError("strong encryption (flag bit 6)");
    if (decodeName(fname, h.readUInt16LE(6)) !== e.origName) {
      throw new BadZipFile(`File name in directory '${e.origName}' and header ${fname} differ.`);
    }
    if (e.flags & 0x1) throw new RuntimeError(`File '${e.name}' is encrypted, password required for extraction`);
    if (e.method !== 0 && e.method !== 8) throw new NotImplementedError("That compression method is not supported");
    return e.offset + 30 + n + h.readUInt16LE(28);
  }

  /** `read(name)` → the member's bytes (a name, or one of `entries`), CRC-checked. */
  read(member) {
    const e = typeof member === "string" ? this.info(member) : member;
    const comp = this.bytesAt(this.dataStart(e), e.csize);
    let raw;
    if (e.method === 0) raw = Buffer.from(comp);
    else raw = e.csize ? zlib.inflateRawSync(comp) : Buffer.alloc(0);
    if (zlib.crc32(raw) >>> 0 !== e.crc) throw new BadZipFile(`Bad CRC-32 for file '${e.name}'`);
    return raw;
  }

  /** `extract(member, dir)` → the path written; the member streams to disk, CRC-checked. */
  async extract(member, dir) {
    const e = typeof member === "string" ? this.info(member) : member;
    const isDir = e.name.endsWith("/");
    const rel = safeArcname(e.name);
    if (!rel && !isDir) throw new ValueError("Empty filename.");
    const target = path.normalize(path.join(dir, rel));
    const upper = path.dirname(target);
    if (upper && !existsSync(upper)) mkdirSync(upper, { recursive: true });
    if (isDir) {
      if (!isDirectory(target)) mkdirSync(target);
      return target;
    }
    const at = this.dataStart(e);
    let crc = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        crc = zlib.crc32(chunk, crc);
        cb(null, chunk);
      },
    });
    let src;
    if (!e.csize) src = Readable.from([]);
    else if (this.buf) src = Readable.from([this.buf.subarray(at, at + e.csize)]);
    else src = createReadStream(this.file, { start: at, end: at + e.csize - 1 });
    const stages = e.method === 8 && e.csize ? [src, zlib.createInflateRaw(), tap] : [src, tap];
    await pipeline(...stages, createWriteStream(target));
    if (crc >>> 0 !== e.crc) throw new BadZipFile(`Bad CRC-32 for file '${e.name}'`);
    return target;
  }

  /** `extractall(dir)`: every name of `namelist()`, its member made safe the way zipfile does. */
  async extractAll(dir) {
    for (const name of this.names()) await this.extract(this.info(name), dir);
  }
}

/** `zipfile.ZipFile(archive).extractall(dest)`. */
export async function extractZip(archive, dest) {
  await (await ZipReader.open(archive)).extractAll(dest);
}
