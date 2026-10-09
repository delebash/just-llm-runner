// SPDX-License-Identifier: MIT
// Port of tests/test_logs_api.py — makeLogsRouter: the ring feeds /tail + /download; the
// per-day files feed /days, /day, DELETE /day, DELETE /all; /clear empties the ring (the
// Logs phase). Records come from platform/log.js, as Python's came from `logging`.
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getLogger } from "../src/platform/log.js";
import * as logsApi from "../src/platform/logs_api.js";
import { installFileLog, installLogRing, makeLogsRouter } from "../src/platform/logs_api.js";
import { createServer } from "../src/platform/server.js";

const logger = getLogger("test.logs");
const newTmp = () => mkdtempSync(join(tmpdir(), "kit-logs-"));
const read = (p) => readFileSync(p, "utf8");

function client() {
  installLogRing();
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", makeLogsRouter("JustWrite"));
  // `query`: an object, sent as the URL's query string
  const call = (method) => async (url, query) => app.request(query ? `${url}?${new URLSearchParams(query)}` : url, { method });
  return { get: call("GET"), post: call("POST"), delete: call("DELETE") };
}

test("tail_and_download_capture_log_lines", async () => {
  const c = client();
  logger.warning("hello-from-the-ring-42");
  const tail = await (await c.get("/v1/logs/tail?lines=50")).json();
  expect(tail.text).toContain("hello-from-the-ring-42");
  expect(tail.lines).toBeGreaterThanOrEqual(1);
  const dl = await c.get("/v1/logs/download");
  expect(dl.status).toBe(200);
  expect(await dl.text()).toContain("hello-from-the-ring-42");
  expect(dl.headers.get("content-disposition") || "").toContain("justwrite-logs-");
});

const ISO_STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}) \[WARNING\] /;

test("stamps_are_strict_iso_local_with_millis", async () => {
  // The stamp is strict ISO-8601 (`T` + `.mmm`) on BOTH sinks — the ring the UI tails and
  // the day file on disk. Pinned because the UI localizes this stamp at render
  // (logLines.js formatLogStamp) and JS `Date.parse` cannot read logging's default
  // `2026-07-19 00:06:22,169` space+comma form: a silent revert to the default would
  // leave every log line rendering unformatted.
  const tmp = newTmp();
  const c = client();
  installFileLog(join(tmp, "logs", "app.log"));
  const before = new Date();
  logger.warning("iso-stamp-probe");
  const after = new Date();

  const line = (await (await c.get("/v1/logs/tail?lines=50")).json()).text
    .split("\n")
    .find((ln) => ln.includes("iso-stamp-probe"));
  const m = ISO_STAMP.exec(line);
  expect(m, `not a strict-ISO stamp: ${line}`).toBeTruthy();
  // LOCAL clock, not UTC: the parsed stamp (a bare date-time parses as local) sits inside
  // the window the call was made in.
  const stamped = new Date(m[1]);
  expect(stamped.getTime()).toBeGreaterThanOrEqual(Math.floor(before.getTime() / 1000) * 1000);
  expect(stamped.getTime()).toBeLessThanOrEqual(after.getTime());

  // the FILE carries the same grammar — the UI's day view parses it identically
  const fileLine = read(join(tmp, "logs", "app.log"))
    .split(/\r?\n/)
    .find((ln) => ln.includes("iso-stamp-probe"));
  expect(ISO_STAMP.test(fileLine)).toBe(true);
});

test("clear_empties_the_ring_only", async () => {
  const tmp = newTmp();
  const c = client();
  installFileLog(join(tmp, "logs", "app.log"));
  logger.warning("before-clear-77");
  expect((await (await c.get("/v1/logs/tail")).json()).text).toContain("before-clear-77");
  const r = await (await c.post("/v1/logs/clear")).json();
  expect(r.lines).toBe(0);
  expect((await (await c.get("/v1/logs/tail")).json()).text).toBe("");
  // the stored file is UNTOUCHED by clear (clear = the on-screen tail only)
  expect(read(join(tmp, "logs", "app.log"))).toContain("before-clear-77");
});

test("per_day_storage_and_days_listing", async () => {
  const tmp = newTmp();
  const c = client();
  const p = installFileLog(join(tmp, "logs", "app.log"));
  expect(p).not.toBeNull();
  // the handler IS the per-day rotator with the dated-suffix convention the listing
  // relies on — pinned so a change can't silently break /days
  expect(logsApi._fileHandler.when.toUpperCase()).toBe("MIDNIGHT");
  expect(logsApi._fileHandler.suffix).toBe("%Y-%m-%d");
  logger.warning("today-line-11");
  // two PAST days, exactly as the rotation names them
  writeFileSync(join(tmp, "logs", "app.log.2026-07-03"), "old3\n", "utf8");
  writeFileSync(join(tmp, "logs", "app.log.2026-07-04"), "old4\n", "utf8");
  const days = (await (await c.get("/v1/logs/days")).json()).days;
  expect(days.map((d) => d.day).slice(1)).toEqual(["2026-07-04", "2026-07-03"]); // newest first after live
  expect(days[0].live).toBe(true);
  expect(days[1].live).toBe(false);
  // a stored day's CONTENT comes from its file
  const d4 = await (await c.get("/v1/logs/day", { date: "2026-07-04" })).json();
  expect(d4.text).toBe("old4");
  // the live day reads the base FILE (fuller than the 500-line ring)
  const live = await (await c.get("/v1/logs/day", { date: days[0].day })).json();
  expect(live.text).toContain("today-line-11");
});

test("day_validation_and_missing_404", async () => {
  const tmp = newTmp();
  const c = client();
  installFileLog(join(tmp, "logs", "app.log"));
  expect((await c.get("/v1/logs/day", { date: "../etc/passwd" })).status).toBe(400);
  expect((await c.get("/v1/logs/day", { date: "1999-01-01" })).status).toBe(404);
});

test("delete_past_day_unlinks_and_today_truncates", async () => {
  const tmp = newTmp();
  const c = client();
  installFileLog(join(tmp, "logs", "app.log"));
  logger.warning("live-line-before-delete");
  const old = join(tmp, "logs", "app.log.2026-07-02");
  writeFileSync(old, "old2\n", "utf8");
  // past day → plain unlink
  const days = (await (await c.delete("/v1/logs/day", { date: "2026-07-02" })).json()).days;
  expect(existsSync(old)).toBe(false);
  expect(days.every((d) => d.day !== "2026-07-02")).toBe(true);
  // TODAY → truncate (the handler holds the file open — Windows-safe), and logging KEEPS
  // WORKING through the reopened file afterwards
  const today = days.find((d) => d.live).day;
  await c.delete("/v1/logs/day", { date: today });
  expect(read(join(tmp, "logs", "app.log"))).toBe("");
  logger.warning("live-line-after-truncate");
  expect(read(join(tmp, "logs", "app.log"))).toContain("live-line-after-truncate");
});

test("delete_all_removes_files_and_clears_ring", async () => {
  const tmp = newTmp();
  const c = client();
  installFileLog(join(tmp, "logs", "app.log"));
  logger.warning("doomed-line");
  writeFileSync(join(tmp, "logs", "app.log.2026-07-01"), "old1\n", "utf8");
  const days = (await (await c.delete("/v1/logs/all")).json()).days;
  expect(existsSync(join(tmp, "logs", "app.log.2026-07-01"))).toBe(false);
  expect(read(join(tmp, "logs", "app.log"))).toBe("");
  expect((await (await c.get("/v1/logs/tail")).json()).text).toBe(""); // ring cleared too
  expect(days.every((d) => d.live) || days.length === 0).toBe(true); // only the (empty) live day may remain
});

// Not in the Python file: the answers measured against the Python router (2026-10-07) —
// the 422s, `$` letting a final newline through to a 404, the clamps — and the rollover
// of a file left from an earlier day, named for the day it covered.
test("the_answers_match_the_python_router", async () => {
  const tmp = newTmp();
  const c = client();
  installFileLog(join(tmp, "logs", "app.log"));
  let r = await c.get("/v1/logs/tail?lines=abc");
  expect(r.status).toBe(422);
  expect((await r.json()).errors).toEqual([
    { loc: ["query", "lines"], msg: "Input should be a valid integer, unable to parse string as an integer", type: "int_parsing" },
  ]);
  logger.warning("one");
  logger.warning("two");
  expect((await (await c.get("/v1/logs/tail?lines=-5")).json()).lines).toBe(1); // max(1, …)
  expect((await c.get("/v1/logs/tail?lines=5.0")).status).toBe(200);
  r = await c.get("/v1/logs/day");
  expect((await r.json()).errors).toEqual([{ loc: ["query", "date"], msg: "Field required", type: "missing" }]);
  r = await c.get("/v1/logs/day", { date: "2026-07-04\n" });
  expect(r.status).toBe(404);
  expect((await r.json()).detail).toBe("no log stored for 2026-07-04\n");
  r = await c.delete("/v1/logs/day", { date: "x" });
  expect(r.status).toBe(400);
  expect(await r.json()).toMatchObject({ title: "Bad Request", detail: "date must be YYYY-MM-DD", instance: "/v1/logs/day" });
  r = await c.get("/v1/logs/download");
  expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(r.headers.get("content-disposition")).toBe(
    `attachment; filename="justwrite-logs-${new Date().toISOString().slice(0, 10)}.txt"`,
  );

  // a log file last written two days ago rolls over on the next record
  const tmp2 = newTmp();
  const base = join(tmp2, "app.log");
  writeFileSync(base, "from-before\n", "utf8");
  const then = new Date(Date.now() - 2 * 86400 * 1000);
  utimesSync(base, then, then);
  installFileLog(base);
  logger.warning("after-restart");
  const pad = (n) => String(n).padStart(2, "0");
  const dated = `${base}.${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`;
  expect(read(dated)).toBe("from-before\n");
  expect(read(base)).toContain("after-restart");
});
