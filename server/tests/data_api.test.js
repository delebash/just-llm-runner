// SPDX-License-Identifier: MIT
// Port of tests/test_data_api.py — makeDataRouter: backup → mutate → restore round-trips
// data + assets; reset wipes to the host's seed. Schema-agnostic over a tiny SQLite app.
// Python's SQLAlchemy `MetaData` + `Table("notes", …)` is a one-table TABLES list here;
// the zip is read back with the module's own reader (its Python interop was checked by
// hand, 2026-10-07: Python's zipfile reads these backups and these read Python's).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeDataRouter, sortedTables } from "../src/platform/data_api.js";
import { createServer } from "../src/platform/server.js";
import { openDatabase } from "../src/platform/sql.js";
import { ZipReader, ZipWriter } from "../src/platform/zip.js";

const NOTES = {
  name: "notes",
  ddl: "CREATE TABLE notes (\n\tid INTEGER NOT NULL, \n\tbody VARCHAR, \n\tPRIMARY KEY (id)\n)",
};

function makeApp() {
  const tmp = mkdtempSync(join(tmpdir(), "kit-data-"));
  const db = join(tmp, "app.db");
  const engine = openDatabase(db, { foreignKeys: false });
  engine.exec(NOTES.ddl);
  const runReset = () =>
    engine.tx(() => {
      engine.run("DELETE FROM notes");
      engine.run("INSERT INTO notes (id, body) VALUES (1, 'seed')");
    });
  const assets = join(tmp, "images");
  mkdirSync(assets);
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(makeDataRouter({ getDbPath: () => db, metadata: [NOTES], runReset, assetDirs: () => ({ images: assets }) }));
  return { app, engine, assets, tmp };
}

const rows = (engine) => Object.fromEntries(engine.all("SELECT id, body FROM notes").map((r) => [r.id, r.body]));

async function zipNames(buf, tmp) {
  const f = join(tmp, `read-${Math.random()}.zip`);
  writeFileSync(f, buf);
  return (await ZipReader.open(f)).names();
}

function upload(app, blob, field = "file") {
  const form = new FormData();
  form.append(field, new Blob([blob], { type: "application/zip" }), "backup.zip");
  return app.inject({ method: "POST", url: "/v1/data/restore", payload: form });
}

test("backup_restore_reset_roundtrip", async () => {
  const { app, engine, assets, tmp } = makeApp();
  engine.run("INSERT INTO notes (id, body) VALUES (1, 'original')");
  engine.run("INSERT INTO notes (id, body) VALUES (2, 'second')");
  writeFileSync(join(assets, "a.txt"), "hello");

  // Backup: a zip with the DB + the asset dir.
  const r = await app.inject({ method: "GET", url: "/v1/data/backup" });
  expect(r.statusCode).toBe(200);
  const blob = r.rawPayload;
  const names = await zipNames(blob, tmp);
  expect(names).toContain("db.sqlite");
  expect(names).toContain("images/a.txt");

  // Mutate after the backup.
  engine.run("DELETE FROM notes");
  engine.run("INSERT INTO notes (id, body) VALUES (99, 'changed')");
  writeFileSync(join(assets, "a.txt"), "CHANGED");

  // Restore brings rows AND assets back.
  const rr = await upload(app, blob);
  expect(rr.statusCode).toBe(200);
  expect(rows(engine)).toEqual({ 1: "original", 2: "second" });
  expect(readFileSync(join(assets, "a.txt"), "utf8")).toBe("hello");

  // Reset wipes to the host seed.
  expect((await app.inject({ method: "POST", url: "/v1/data/reset" })).statusCode).toBe(200);
  expect(rows(engine)).toEqual({ 1: "seed" });
});

test("restore_rejects_bad_zip", async () => {
  const { app } = makeApp();
  const r = await upload(app, Buffer.from("not a zip"));
  expect(r.statusCode).toBe(400);
});

test("backup_exclude_skips_named_asset_dirs_and_restore_leaves_live_copy", async () => {
  // ?exclude=<arcnames> (the DataManagement per-app options seam — decision ①, family
  // parity batch 2026-08-05: JV's include-audio toggle rides it). The named asset dirs
  // stay out of the zip; the DB always ships; restoring such a backup leaves the live copy
  // of the excluded content untouched.
  const { app, engine, assets, tmp } = makeApp();
  engine.run("INSERT INTO notes (id, body) VALUES (1, 'original')");
  writeFileSync(join(assets, "a.txt"), "keep me");

  const r = await app.inject({ method: "GET", url: "/v1/data/backup?exclude=images,unknown-name" });
  expect(r.statusCode).toBe(200);
  const names = await zipNames(r.rawPayload, tmp);
  expect(names).toContain("db.sqlite");
  expect(names.some((n) => n.startsWith("images/"))).toBe(false);

  // Mutate, then restore the audio-less backup: rows come back, the excluded dir's live
  // content stays exactly as it is (never deleted for being absent).
  engine.run("DELETE FROM notes");
  writeFileSync(join(assets, "a.txt"), "still here after restore");
  const rr = await upload(app, r.rawPayload);
  expect(rr.statusCode).toBe(200);
  expect(rows(engine)).toEqual({ 1: "original" });
  expect(readFileSync(join(assets, "a.txt"), "utf8")).toBe("still here after restore");
});

// Not in the Python file: the refusals as the Python router answered them (measured
// 2026-10-07), and sorted_tables' order.
test("the_answers_match_the_python_router", async () => {
  const { app, tmp } = makeApp();
  const errorsOf = async (r) => {
    expect(r.statusCode).toBe(422);
    return r.json().errors;
  };
  const missing = [{ loc: ["body", "file"], msg: "Field required", type: "missing" }];
  expect(await errorsOf(await upload(app, Buffer.from("x"), "other"))).toEqual(missing);
  expect(await errorsOf(await app.inject({ method: "POST", url: "/v1/data/restore", payload: { a: 1 } }))).toEqual(missing);
  expect(await errorsOf(await app.inject({ method: "POST", url: "/v1/data/restore" }))).toEqual(missing);
  const form = new FormData();
  form.append("file", "abc");
  expect(await errorsOf(await app.inject({ method: "POST", url: "/v1/data/restore", payload: form }))).toEqual([
    { loc: ["body", "file"], msg: "Value error, Expected UploadFile, received: <class 'str'>", type: "value_error" },
  ]);
  let r = await upload(app, Buffer.from("nope"));
  expect(r.json()).toMatchObject({ status: 400, detail: "not a valid backup zip", instance: "/v1/data/restore" });

  // a zip without the database
  const other = join(tmp, "other.txt");
  writeFileSync(other, "x");
  const z = new ZipWriter();
  await z.addFile(other, "other.txt");
  r = await upload(app, Buffer.concat(z.finish()));
  expect(r.statusCode).toBe(400);
  expect(r.json().detail).toBe("backup is missing db.sqlite");

  r = await app.inject({ method: "GET", url: "/v1/data/backup" });
  expect(r.headers["content-type"]).toBe("application/zip");
  expect(r.headers["content-disposition"]).toBe('attachment; filename="backup.zip"');

  const gone = createServer({ typeBase: "https://example.test/errors/" });
  gone.register(makeDataRouter({ getDbPath: () => join(tmp, "nope.db"), metadata: [], runReset: () => {} }));
  r = await gone.inject({ method: "GET", url: "/v1/data/backup" });
  expect(r.statusCode).toBe(404);
  expect(r.json().detail).toBe("no database to back up");

  // by name, then parents before children
  expect(
    sortedTables([
      { name: "b_child", ddl: "CREATE TABLE b_child (a_id INTEGER, FOREIGN KEY(a_id) REFERENCES z_parent (id))" },
      { name: "a", ddl: "CREATE TABLE a (id INTEGER)" },
      { name: "z_parent", ddl: "CREATE TABLE z_parent (id INTEGER, p INTEGER REFERENCES z_parent (id))" },
    ]),
  ).toEqual(["a", "z_parent", "b_child"]);
});
