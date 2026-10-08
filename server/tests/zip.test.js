// SPDX-License-Identifier: MIT
// platform/zip.js — the family's one ZIP (CPython zipfile's layout and checks). Round trips in
// memory and on disk, the names zipfile flags as UTF-8, a ZIP made by Python's own zipfile
// (fixtures/python-zipfile.zip, CPython 3.12.9 — the snippet is below), extractall's safe
// names, and the refusals. The routes riding it keep their own tests (data_api, binary's
// _unpack, JustWrite's book transfer, JustVoice's voice bundle and voice-line export).
//
// The fixture, made with CPython 3.12.9:
//   when = (2026, 10, 8, 12, 34, 56)
//   with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
//       zf.writestr(info("hello.txt"), "hello from python\n" * 50)           # deflated
//       zf.writestr(info("stored.bin", ZIP_STORED), bytes(range(256)))       # stored
//       zf.writestr(info("dir/", ZIP_STORED), b"")                           # a directory (attrs 0o40775 | 0x10)
//       zf.writestr(info("dir/日本語.txt"), "日本語")                          # the UTF-8 flag
//       zf.writestr(info("../evil.txt"), "kept inside")
//       zf.writestr(info("empty.txt"), b"")
//       zf.comment = b"made by CPython zipfile"                             # the end-record search
// where info(name, method=ZIP_DEFLATED) is a ZipInfo(name, date_time=when) of that method.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { IS_WIN, KeyError, ValueError } from "../src/platform/py.js";
import { BadZipFile, extractZip, ZipReader, ZipWriter } from "../src/platform/zip.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/python-zipfile.zip", import.meta.url));
const PY_NAMES = ["hello.txt", "stored.bin", "dir/", "dir/日本語.txt", "../evil.txt", "empty.txt"];

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "kit-zip-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The central directory's raw fields per member (what a reader of the bytes sees). */
function central(buf) {
  const count = buf.readUInt16LE(buf.length - 22 + 10);
  let p = buf.readUInt32LE(buf.length - 22 + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = buf.readUInt16LE(p + 28);
    out.push({
      system: buf.readUInt8(p + 5),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      time: buf.readUInt16LE(p + 12),
      date: buf.readUInt16LE(p + 14),
      mode: buf.readUInt32LE(p + 38) >>> 16,
    });
    p += 46 + n + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

const dos = (d) => [
  (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
];

test("writestr builds in memory and fromBuffer reads it back", () => {
  const now = new Date(2026, 9, 8, 12, 34, 56);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const z = new ZipWriter();
  z.writestr("book/book.json", '{"title": "Plain"}');
  z.writestr("book/images/a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  z.writestr("empty.txt", "");
  const buf = z.toBuffer();
  expect(buf.subarray(0, 4).toString("latin1")).toBe("PK\x03\x04");

  const zf = ZipReader.fromBuffer(buf);
  expect(zf.names()).toEqual(["book/book.json", "book/images/a.png", "empty.txt"]);
  expect(zf.read("book/book.json").toString("utf8")).toBe('{"title": "Plain"}');
  expect([...zf.read(zf.info("book/images/a.png"))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  expect(zf.read("empty.txt").length).toBe(0);
  // writestr's member: deflated, the local time now, mode 0o600, the platform's create_system.
  const [time, date] = dos(now);
  for (const c of central(buf)) {
    expect(c).toEqual({ system: IS_WIN ? 0 : 3, flags: 0, method: 8, time, date, mode: 0o600 });
  }
});

test("a non-ASCII name is UTF-8 with the flag; an ASCII one is neither", () => {
  const z = new ZipWriter();
  z.writestr("Глава 1/日本語.txt", "текст");
  z.writestr("plain.txt", "x");
  const buf = z.toBuffer();
  expect(central(buf).map((c) => c.flags)).toEqual([0x800, 0]);
  expect(buf.includes(Buffer.from("Глава 1/日本語.txt", "utf8"))).toBe(true);
  const zf = ZipReader.fromBuffer(buf);
  expect(zf.names()).toEqual(["Глава 1/日本語.txt", "plain.txt"]);
  expect(zf.read("Глава 1/日本語.txt").toString("utf8")).toBe("текст");
});

test("addFile streams a file in with its mtime and mode; open reads it from disk", async () => {
  const dir = tmp();
  const src = join(dir, "big.bin");
  const body = Buffer.concat(Array.from({ length: 64 }, (_, i) => Buffer.alloc(16 * 1024, i))); // 1 MiB, several chunks
  writeFileSync(src, body);
  const mtime = new Date(2025, 0, 2, 3, 4, 6);
  utimesSync(src, mtime, mtime);
  const z = new ZipWriter();
  await z.addFile(src, "data/big.bin");
  z.writestr("note.txt", "and one from memory");
  const archive = join(dir, "out.zip");
  writeFileSync(archive, Buffer.concat(z.finish()));

  const [time, date] = dos(mtime);
  const [c] = central(readFileSync(archive));
  expect([c.time, c.date, c.mode]).toEqual([time, date, statSync(src).mode & 0xffff]);
  const zf = await ZipReader.open(archive);
  expect(zf.names()).toEqual(["data/big.bin", "note.txt"]);
  expect(zf.read("data/big.bin").equals(body)).toBe(true);
  expect(zf.read("note.txt").toString()).toBe("and one from memory");
  const out = join(dir, "x");
  await zf.extractAll(out);
  expect(readFileSync(join(out, "data", "big.bin")).equals(body)).toBe(true);
  expect(readFileSync(join(out, "note.txt"), "utf8")).toBe("and one from memory");
});

test("a ZIP made by Python's zipfile reads back, on disk and in memory", async () => {
  const fromDisk = await ZipReader.open(FIXTURE);
  const raw = readFileSync(FIXTURE);
  // A prefix before the archive (a self-extractor's stub): zipfile's `concat` finds the members.
  const prefixed = ZipReader.fromBuffer(Buffer.concat([Buffer.from("#!stub\n".repeat(10)), raw]));
  for (const zf of [fromDisk, ZipReader.fromBuffer(raw), prefixed]) {
    expect(zf.names()).toEqual(PY_NAMES);
    expect(zf.read("hello.txt").toString()).toBe("hello from python\n".repeat(50));
    expect([...zf.read("stored.bin")]).toEqual([...Array(256).keys()]);
    expect(zf.read("dir/日本語.txt").toString("utf8")).toBe("日本語");
    expect(zf.read("empty.txt").length).toBe(0);
    expect(zf.info("dir/日本語.txt").flags & 0x800).toBe(0x800);
  }
  const out = join(tmp(), "out");
  await extractZip(FIXTURE, out);
  expect(readFileSync(join(out, "hello.txt"), "utf8")).toBe("hello from python\n".repeat(50));
  expect(readFileSync(join(out, "stored.bin")).length).toBe(256);
  expect(statSync(join(out, "dir")).isDirectory()).toBe(true);
  expect(readFileSync(join(out, "dir", "日本語.txt"), "utf8")).toBe("日本語");
  expect(readFileSync(join(out, "evil.txt"), "utf8")).toBe("kept inside"); // ".." dropped
  expect(readFileSync(join(out, "empty.txt")).length).toBe(0);
});

test("extraction keeps '..', rooted and drive names inside the destination", async () => {
  const z = new ZipWriter();
  z.writestr("../../up.txt", "1");
  z.writestr("/rooted/abs.txt", "2");
  z.writestr("a/./b/../c.txt", "3");
  if (IS_WIN) {
    z.writestr("C:/drive.txt", "4");
    z.writestr("//server/share/unc.txt", "5");
    z.writestr('odd:<name>|"?*. ', "6");
  }
  const parent = tmp();
  const archive = join(parent, "evil.zip");
  writeFileSync(archive, z.toBuffer());
  const out = join(parent, "out");
  await extractZip(archive, out);
  expect(readdirSync(parent).sort()).toEqual(["evil.zip", "out"]); // nothing climbed out
  expect(readFileSync(join(out, "up.txt"), "utf8")).toBe("1");
  expect(readFileSync(join(out, "rooted", "abs.txt"), "utf8")).toBe("2");
  expect(readFileSync(join(out, "a", "b", "c.txt"), "utf8")).toBe("3"); // "." and ".." parts dropped
  if (IS_WIN) {
    expect(readFileSync(join(out, "drive.txt"), "utf8")).toBe("4");
    expect(readFileSync(join(out, "unc.txt"), "utf8")).toBe("5");
    expect(readFileSync(join(out, "odd__name_____"), "utf8")).toBe("6"); // illegal → "_", trailing ". " gone
  }
  // A name that is nothing once made safe: zipfile's ValueError.
  const nothing = new ZipWriter();
  nothing.writestr("..", "x");
  await expect(ZipReader.fromBuffer(nothing.toBuffer()).extractAll(join(parent, "none"))).rejects.toThrow(ValueError);
});

test("the refusals: not a zip, a bad CRC, an unknown name", async () => {
  expect(() => ZipReader.fromBuffer(Buffer.from("not a zip"))).toThrow(BadZipFile);
  expect(() => ZipReader.fromBuffer(Buffer.alloc(0))).toThrow("File is not a zip file");
  const notZip = join(tmp(), "nope.zip");
  writeFileSync(notZip, "PK but not really, and long enough to search".repeat(4));
  await expect(ZipReader.open(notZip)).rejects.toThrow(BadZipFile);

  const raw = Buffer.from(readFileSync(FIXTURE));
  const stored = ZipReader.fromBuffer(raw).info("stored.bin");
  raw[stored.offset + 30 + "stored.bin".length + 7] ^= 0xff; // one byte of its stored data
  const zf = ZipReader.fromBuffer(raw);
  expect(() => zf.read("stored.bin")).toThrow("Bad CRC-32 for file 'stored.bin'");
  const out = join(tmp(), "out");
  await expect(zf.extract("stored.bin", out)).rejects.toThrow(BadZipFile);
  expect(() => zf.info("missing.txt")).toThrow(KeyError);
});
