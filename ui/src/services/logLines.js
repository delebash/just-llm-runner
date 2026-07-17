// SPDX-License-Identifier: GPL-3.0-or-later
// Shared log-line grammar for the kit's log surfaces — LogsPanel's live/day tail
// AND ConsolePanel's server/engine follow. ONE source for the level regex, the
// group-aware row parse, and the level→CSS-class map, so a second component
// renders lines identically instead of forking LogsPanel's markup. Promoted out
// of LogsPanel's scoped block 2026-07-10 (QC-43c). The matching styles live in
// common/styles.css (.lu-logbox + .lu-logline / --err / --warn / --dim).

export const LEVEL_RE = /\[(CRITICAL|ERROR|WARNING|INFO|DEBUG)\]/;

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
 */
export function parseEngineRows(text) {
  const out = [];
  let current = "INFO";
  for (const line of (text || "").split("\n")) {
    const lv = engineLevelOf(line);
    if (lv) current = lv;
    out.push({ line, level: current });
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
 */
export function parseLogRows(text) {
  const out = [];
  let current = "INFO";
  for (const line of (text || "").split("\n")) {
    const lv = levelOf(line);
    if (lv) current = lv;
    out.push({ line, level: current });
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
