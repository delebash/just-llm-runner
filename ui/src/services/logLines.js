// SPDX-License-Identifier: GPL-3.0-or-later
// Shared log-line grammar for the kit's log surfaces — LogsPanel's live/day tail
// AND ConsolePanel's server/engine follow. ONE source for the level regex, the
// group-aware row parse, and the level→CSS-class map, so a second component
// renders lines identically instead of forking LogsPanel's markup. Promoted out
// of LogsPanel's scoped block 2026-07-10 (QC-43c). The matching styles live in
// common/styles.css (.lu-logbox + .lu-logline / --err / --warn / --dim).

export const LEVEL_RE = /\[(CRITICAL|ERROR|WARNING|INFO|DEBUG)\]/;

// The server stamps every line with a strict ISO-8601 LOCAL timestamp
// (logs_api.py `_FMT`) — sortable and unambiguous on disk. The UI shows that same
// instant in the READER's own regional format instead (2026-07-19, the user's
// ruling: "local in ui and iso in file"). `Intl.DateTimeFormat` with no explicit
// locale follows the OS/browser locale, so one build reads correctly on any
// machine — no server-side locale code, no dependency. Note it renders CLDR's
// pattern for that locale (en-US → `07/19/2026`); it does NOT read Windows'
// per-user date customisations, which no browser API exposes.
// Milliseconds are dropped in the local form (the user's call — they matter when
// diffing a file, not when reading a tail). Date AND time are kept on every line:
// the ring can span midnight or a restart gap, so a bare time would be ambiguous.
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?/;

const LOCAL_STAMP_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * Re-render a line's leading ISO stamp in the reader's locale, leaving the rest
 * of the line byte-identical. A line with no stamp (a traceback line, a wrapped
 * message, engine output) is returned UNTOUCHED — so continuation lines survive
 * the pass unharmed. `fmt` is injectable so tests can pin a locale.
 */
export function formatLogStamp(line, fmt = LOCAL_STAMP_FMT) {
  const m = STAMP_RE.exec(line || "");
  if (!m) return line;
  // A bare date-time (no offset) is parsed as LOCAL time — matching how the
  // server wrote it. An unparseable stamp falls through as-is rather than
  // rendering "Invalid Date" over the reader's log.
  const d = new Date(`${m[1]}T${m[2]}`);
  if (Number.isNaN(d.getTime())) return line;
  return fmt.format(d) + line.slice(m[0].length);
}

const LOCAL_DAY_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Render a stored-log DAY id (`YYYY-MM-DD`, the `/v1/logs/day?date=` key) in the
 * reader's locale — for LABELS only. The id itself must keep travelling in ISO:
 * it is the wire value and the server validates it against `^\d{4}-\d{2}-\d{2}$`.
 *
 * Builds the Date from PARTS on purpose. `new Date("2026-07-19")` — a date-ONLY
 * ISO string — is parsed as UTC per spec, so west-of-UTC readers would see the
 * PREVIOUS day in the picker. (A date-TIME string like formatLogStamp's is parsed
 * as local; the two forms genuinely differ, which is the trap here.)
 */
export function formatLogDay(day, fmt = LOCAL_DAY_FMT) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (!m) return day;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return day;
  return fmt.format(d);
}

// llama.cpp's own log grammar: an optional `[port]` prefix, a `sec.min.ms.us`
// timestamp, then a ONE-letter level (I/W/E/D) before the component. Lets the
// ENGINE source filter by level too (its stdout carries no `[LEVEL]` token).
const ENGINE_LEVEL_RE = /^(?:\[\d+\]\s+)?\d+\.\d+\.\d+\.\d+\s+([IWED])\s/;
const ENGINE_LETTER = { I: "INFO", W: "WARNING", E: "ERROR", D: "DEBUG" };

// Severity rank for the min-level filter (higher = more severe). "" (no level)
// ranks with INFO so plain/continuation lines survive an INFO-or-higher filter.
export const LEVEL_RANK = { DEBUG: 10, INFO: 20, "": 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };

/** The level token embedded in a line (e.g. "ERROR"), or "" when it carries none. */
export function levelOf(line) {
  const m = LEVEL_RE.exec(line);
  return m ? m[1] : "";
}

/** The level of a llama.cpp ENGINE line (I/W/E/D → INFO/…), or "" when none. */
export function engineLevelOf(line) {
  const m = ENGINE_LEVEL_RE.exec(line);
  return m ? ENGINE_LETTER[m[1]] : "";
}

/**
 * Group-aware parse of the ENGINE blob → [{ line, level }], mirroring
 * parseEngineRows' server twin: a line WITH an I/W/E/D level starts a group;
 * continuation lines inherit it (so an error's wrapped tail stays with the error
 * under a min-level filter). Seeds at INFO.
 *
 * Emits the same `{line, raw, level}` shape as parseLogRows so the two are
 * interchangeable downstream (ConsolePanel picks one at runtime). Engine stdout
 * is llama.cpp's own grammar and is never re-stamped, so `raw` equals `line`
 * here — the field exists to keep ONE row contract, not because it differs.
 */
export function parseEngineRows(text) {
  const out = [];
  let current = "INFO";
  for (const line of (text || "").split("\n")) {
    const lv = engineLevelOf(line);
    if (lv) current = lv;
    out.push({ line, raw: line, level: current });
  }
  return out;
}

/** Keep rows at or above `minLevel` severity (`""`/"ALL" → keep everything). */
export function filterRowsByMinLevel(rows, minLevel) {
  if (!minLevel || minLevel === "ALL") return rows;
  const floor = LEVEL_RANK[minLevel] ?? 0;
  return rows.filter((r) => (LEVEL_RANK[r.level] ?? 20) >= floor);
}

/**
 * Group-aware parse of a log blob → [{ line, level }] in original order. A line
 * WITH a level token starts a group; continuation lines (tracebacks, wrapped
 * messages) inherit that group's level — so a downstream level filter keeps a
 * whole traceback, not just its first line. Seeds at INFO so a leading
 * continuation line isn't mislabelled.
 *
 * Each row carries BOTH forms of the same line:
 * - `line` — the LOCALE-formatted stamp (formatLogStamp), for DISPLAY. The one
 *   place both log surfaces (LogsPanel's live/day tail + ConsolePanel's server
 *   follow) pick it up, so neither renderer needs to know about timestamps.
 * - `raw`  — the line exactly as the server wrote it (ISO, milliseconds intact),
 *   for anything that EXPORTS rather than displays. LogsPanel's Copy uses it so a
 *   pasted log matches a downloaded one; the split exists because Copy is filtered
 *   by level and so cannot just re-use the unparsed blob.
 *
 * Level detection runs on the RAW line: the level token sits after the stamp, so
 * the two never interfere.
 */
export function parseLogRows(text) {
  const out = [];
  let current = "INFO";
  for (const line of (text || "").split("\n")) {
    const lv = levelOf(line);
    if (lv) current = lv;
    out.push({ line: formatLogStamp(line), raw: line, level: current });
  }
  return out;
}

/** Map a row's level → the shared .lu-logline modifier class ("" for INFO/plain). */
export function logLineClass(level) {
  if (level === "ERROR" || level === "CRITICAL") return "lu-logline--err";
  if (level === "WARNING") return "lu-logline--warn";
  if (level === "DEBUG") return "lu-logline--dim";
  return "";
}
