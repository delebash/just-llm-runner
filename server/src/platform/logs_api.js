// SPDX-License-Identifier: MIT
// The shared server-logs router — an in-memory ring (the UI tail) plus PER-DAY log files
// (they survive a crash/boot-hang, when on-disk logs matter most). The port of
// llm_runner/platform/logs_api.py; the ring and the day file are sinks of platform/log.js
// (Python's handlers on the root logger).
//
// The host calls `installLogRing()` + `installFileLog(path)` at boot and mounts
// `makeLogsRouter(appName)`.
//
// Storage (the Logs phase, 2026-07-05 — the user's "should store day"): ONE file per
// local day, as stdlib `TimedRotatingFileHandler(when="midnight")` keeps them — the live
// day is the base file (e.g. `justwrite.log`), past days are dated siblings
// (`justwrite.log.2026-07-04`), `backupDays` retained (default 30). The handler is ported
// below so both servers leave the same files.
//
// Endpoints (mounted at the app root):
//   GET    /v1/logs/tail?lines=N        → the last N ring lines (`{text, lines}`).
//   GET    /v1/logs/download            → the whole ring as a text attachment.
//   GET    /v1/logs/days                → the stored days (`[{day, sizeKb, live}]`, newest first).
//   GET    /v1/logs/day?date=&lines=N   → one day's FILE content (tail-capped).
//   POST   /v1/logs/clear               → empty the RING (the on-screen tail).
//   DELETE /v1/logs/day?date=           → delete a stored day (TODAY = truncate, see below).
//   DELETE /v1/logs/all                 → delete every stored day + truncate live + clear the ring.
//
// Windows-safety: the LIVE file is held open by the handler, and Windows refuses to unlink
// an open file (Python's did; Node opens with FILE_SHARE_DELETE, but the answer stays the
// same) — so "delete today" and "delete all" TRUNCATE the live file (close → truncate →
// reopen, `truncateLive`), and only PAST days are plain unlinks.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { purePath } from "./data_paths.js";
import { HttpError } from "./errors.js";
import { addSink, getLevel, getLogger, LEVELS, setLevel } from "./log.js";
import { opt, T } from "./models.js";
import { IS_WIN, pySorted } from "./py.js";

const log = getLogger("llm_runner.platform.logs_api");

// Timestamps are strict ISO-8601 on the RING and in the FILES (2026-07-19, the user's
// ruling: "local in ui and iso in file"). Not logging's default `2026-07-19 00:06:22,169`
// — that space+comma form is not reliably parseable by JS `Date.parse`, and the UI
// re-renders each stamp in the READER's regional format at display time (`logLines.js`
// formatLogStamp). ISO stays on disk because it sorts, greps, and is unambiguous between
// machines — and because `/v1/logs/download` turns RING lines into a file, so the ring
// cannot carry a locale format either. No timezone suffix: this is the server box's LOCAL
// clock, and JS parses a bare date-time form as local — that pairing is what makes the
// round-trip land on the right wall-clock time.
// Python: "%(asctime)s.%(msecs)03d [%(levelname)s] %(name)s: %(message)s", "%Y-%m-%dT%H:%M:%S".
const pad = (n, w = 2) => String(n).padStart(w, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function formatRecord(record) {
  const d = new Date(record.created * 1000);
  const stamp = `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  let s = `${stamp} [${record.levelname}] ${record.name}: ${record.msg}`;
  if (record.exc) {
    if (!s.endsWith("\n")) s += "\n";
    s += record.exc;
  }
  return s;
}

// Python's `_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")` on str: `\d` is any Unicode
// digit and `$` also matches before a final newline — kept, so the same inputs pass.
const DAY_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}\n?$/u;

/** Bounded in-memory ring — the UI's log tail. */
class RingHandler {
  constructor(capacity = 500) {
    this.capacity = capacity;
    this.lines = [];
  }

  emit(record) {
    try {
      this.lines.push(formatRecord(record));
      if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    } catch {
      /* logging must never throw */
    }
  }
}

/**
 * The port of stdlib `TimedRotatingFileHandler(path, when="midnight", backupCount=n,
 * encoding="utf-8")`: appends to the base file; the first record after local midnight
 * renames it to `<base>.YYYY-MM-DD` (the day it covered) and keeps `backupCount` past
 * days. Its first rollover time comes from the file's mtime, so a file left from an
 * earlier day rolls on the first record after a restart. Records are written as Python's
 * text mode writes them (`\n` → `\r\n` on Windows).
 */
export class TimedRotatingFileHandler {
  constructor(filename, { backupCount = 0 } = {}) {
    this.baseFilename = path.resolve(String(filename)); // os.path.abspath
    this.when = "MIDNIGHT";
    this.interval = 60 * 60 * 24;
    this.suffix = "%Y-%m-%d";
    this.extMatch = /^\d{4}-\d{2}-\d{2}$/; // re.ASCII, fullmatch
    this.backupCount = backupCount;
    this.fd = this.open();
    const t = existsSync(this.baseFilename)
      ? Math.floor(statSync(this.baseFilename).mtimeMs / 1000)
      : Math.floor(Date.now() / 1000);
    this.rolloverAt = this.computeRollover(t);
  }

  open() {
    return openSync(this.baseFilename, "a");
  }

  /** The next local midnight after `t` (seconds). */
  computeRollover(t) {
    const d = new Date(t * 1000);
    return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000);
  }

  shouldRollover() {
    const t = Math.floor(Date.now() / 1000);
    if (t < this.rolloverAt) return false;
    // Never roll over anything other than a regular file (CPython #89564).
    if (existsSync(this.baseFilename) && !statSync(this.baseFilename).isFile()) {
      this.rolloverAt = this.computeRollover(t);
      return false;
    }
    return true;
  }

  getFilesToDelete() {
    const dir = path.dirname(this.baseFilename);
    const prefix = `${path.basename(this.baseFilename)}.`;
    const result = readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && this.extMatch.test(n.slice(prefix.length)))
      .map((n) => path.join(dir, n));
    if (result.length < this.backupCount) return [];
    result.sort();
    return result.slice(0, result.length - this.backupCount);
  }

  doRollover() {
    const currentTime = Math.floor(Date.now() / 1000);
    // Named for the day the file covered (the period that ends at rolloverAt).
    const dfn = `${this.baseFilename}.${ymd(new Date((this.rolloverAt - 1) * 1000))}`;
    if (existsSync(dfn)) return; // "Already rolled over" — Python leaves rolloverAt as it is
    if (this.fd != null) {
      closeSync(this.fd);
      this.fd = null;
    }
    if (existsSync(this.baseFilename)) renameSync(this.baseFilename, dfn);
    if (this.backupCount > 0) for (const s of this.getFilesToDelete()) unlinkSync(s);
    this.fd = this.open();
    this.rolloverAt = this.computeRollover(currentTime);
  }

  emit(record) {
    try {
      if (this.shouldRollover()) this.doRollover();
      if (this.fd == null) this.fd = this.open();
      const text = `${formatRecord(record)}\n`;
      writeSync(this.fd, IS_WIN ? text.replace(/\n/g, "\r\n") : text);
    } catch {
      /* logging must never throw (Python's handleError drops the record) */
    }
  }

  close() {
    if (this.fd != null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

export const _ring = new RingHandler();
const ringSink = (record) => _ring.emit(record);
export let _fileHandler = null;
let removeFileSink = null;

/** Attach the ring to the log (idempotent). Call at boot. */
export function installLogRing() {
  addSink(ringSink); // a Set — adding it twice is a no-op
}

/**
 * PER-DAY file logging at `logPath` (idempotent per path; re-points if a different path
 * is given, e.g. tests with several apps per process). The live day writes the base file;
 * at local midnight it rotates to `<name>.YYYY-MM-DD` and `backupDays` days are retained.
 * Returns the path, or null when the dir isn't writable (never fatal — the ring still
 * works).
 */
export function installFileLog(logPath, backupDays = 30) {
  const p = purePath(logPath);
  // The runner's operational telemetry (load/stop asks + their trigger, spawns, evictions,
  // install events) logs at INFO — and an on-disk log with no INFO lines made an
  // unload-respawn hunt undiagnosable (2026-07-17). Python raised the llm_runner package
  // to INFO; log.js has one level for every logger (and no third-party loggers to keep
  // quiet), so the equivalent is: never above INFO.
  if (getLevel() > LEVELS.INFO) setLevel(LEVELS.INFO);
  if (_fileHandler !== null) {
    if (_fileHandler.baseFilename === p) return p;
    removeFileSink?.();
    _fileHandler.close();
    _fileHandler = null;
  }
  let handler;
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    handler = new TimedRotatingFileHandler(p, { backupCount: backupDays });
  } catch {
    log.warning(`file log unavailable at ${p} — ring only`);
    return null;
  }
  removeFileSink = addSink((record) => handler.emit(record));
  _fileHandler = handler;
  return p;
}

/** Size in KB as the listing shows it: 0 for an empty file, else at least 1. */
const sizeKb = (size) => (size ? Math.max(1, Math.floor(size / 1024)) : 0);

/**
 * PURE listing of a log dir's per-day files → [{day, sizeKb, live, path}], newest first.
 * The base file IS the live day (today); past days are the `<base>.YYYY-MM-DD` siblings
 * the rotation leaves behind.
 */
export function _dayFiles(dirPath, baseName) {
  const out = [];
  const live = path.join(dirPath, baseName);
  if (existsSync(live)) {
    out.push({ day: ymd(new Date()), sizeKb: sizeKb(statSync(live).size), live: true, path: live });
  }
  const prefix = `${baseName}.`;
  const isDir = existsSync(dirPath) && statSync(dirPath).isDirectory();
  for (const name of isDir ? readdirSync(dirPath) : []) {
    if (!name.startsWith(prefix)) continue;
    const day = name.slice(prefix.length);
    if (DAY_RE.test(day)) {
      const p = path.join(dirPath, name);
      out.push({ day, sizeKb: sizeKb(statSync(p).size), live: false, path: p });
    }
  }
  return pySorted(out, (r) => [r.day, r.live], true);
}

/** [dir, baseName] of the installed file log, or null when ring-only. */
function livePaths() {
  if (_fileHandler === null) return null;
  return [path.dirname(_fileHandler.baseFilename), path.basename(_fileHandler.baseFilename)];
}

/** Empty the LIVE day's file WITHOUT unlinking it: close → truncate → reopen. */
function truncateLive() {
  const h = _fileHandler;
  if (h === null) return;
  h.close();
  writeFileSync(h.baseFilename, "", "utf8");
  h.fd = h.open();
}

/** Python's str.splitlines() of a file read in text mode (universal newlines). */
function splitlines(text) {
  if (text === "") return [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: str.splitlines()'s own boundaries
  const parts = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export const LogTailResponse = T.Object({ text: T.String(), lines: T.Integer() });
export const LogDayRow = T.Object({
  day: T.String(), // YYYY-MM-DD
  sizeKb: opt(T.Integer(), 0),
  live: opt(T.Boolean(), false), // the base file (today) — deletable only by truncation
});
export const LogDaysResponse = T.Object({ days: T.Array(LogDayRow) });

const BadDate = () => new HttpError(400, "date must be YYYY-MM-DD");

/** Build the shared /v1/logs router over the ring + the per-day files. */
export function makeLogsRouter(appName = "app") {
  const slug = appName.toLowerCase().replaceAll(" ", "-") || "app";

  const rows = () => {
    const lp = livePaths();
    return lp ? _dayFiles(lp[0], lp[1]) : [];
  };
  const daysResponse = () => ({ days: rows().map((r) => ({ day: r.day, sizeKb: r.sizeKb, live: r.live })) });
  const tail = (lines) => ({ text: lines.join("\n"), lines: lines.length });

  return async function logsRouter(app) {
    app.get(
      "/v1/logs/tail",
      { schema: { querystring: T.Object({ lines: opt(T.Integer(), 80) }) } },
      async (req) => tail(_ring.lines.slice(-Math.max(1, Math.min(req.query.lines, _ring.capacity)))),
    );

    app.get("/v1/logs/download", async (_req, reply) => {
      const stamp = new Date().toISOString().slice(0, 10); // the UTC date, as Python's
      return reply
        .type("text/plain; charset=utf-8")
        .header("content-disposition", `attachment; filename="${slug}-logs-${stamp}.txt"`)
        .send(_ring.lines.join("\n"));
    });

    app.get("/v1/logs/days", async () => daysResponse());

    app.get(
      "/v1/logs/day",
      { schema: { querystring: T.Object({ date: T.String(), lines: opt(T.Integer(), 2000) }) } },
      async (req) => {
        const { date } = req.query;
        if (!DAY_RE.test(date || "")) throw BadDate();
        const row = rows().find((r) => r.day === date);
        if (!row) throw new HttpError(404, `no log stored for ${date}`);
        // Tail-capped read: a day file can be large; the reader wants the recent end.
        const content = splitlines(readFileSync(row.path).toString("utf8"));
        return tail(content.slice(-Math.max(1, Math.min(req.query.lines, 20_000))));
      },
    );

    // Empty the on-screen tail (the RING). Stored day files are untouched — deleting
    // those is the /day and /all DELETEs.
    app.post("/v1/logs/clear", async () => {
      _ring.lines.length = 0;
      return { text: "", lines: 0 };
    });

    app.delete("/v1/logs/day", { schema: { querystring: T.Object({ date: T.String() }) } }, async (req) => {
      const { date } = req.query;
      if (!DAY_RE.test(date || "")) throw BadDate();
      const row = rows().find((r) => r.day === date);
      if (row) {
        if (row.live) truncateLive(); // today is held open — truncate, never unlink
        else unlinkQuiet(row.path);
      }
      return daysResponse();
    });

    app.delete("/v1/logs/all", async () => {
      for (const r of rows()) {
        if (r.live) truncateLive();
        else unlinkQuiet(r.path);
      }
      _ring.lines.length = 0;
      return daysResponse();
    });
  };
}

/** `Path.unlink(missing_ok=True)`. */
function unlinkQuiet(p) {
  try {
    unlinkSync(p);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
