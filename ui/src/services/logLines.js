// SPDX-License-Identifier: GPL-3.0-or-later
// Shared log-line grammar for the kit's log surfaces — LogsPanel's live/day tail
// AND ConsolePanel's server/engine follow. ONE source for the level regex, the
// group-aware row parse, and the level→CSS-class map, so a second component
// renders lines identically instead of forking LogsPanel's markup. Promoted out
// of LogsPanel's scoped block 2026-07-10 (QC-43c). The matching styles live in
// common/styles.css (.lu-logbox + .lu-logline / --err / --warn / --dim).

export const LEVEL_RE = /\[(CRITICAL|ERROR|WARNING|INFO|DEBUG)\]/;

/** The level token embedded in a line (e.g. "ERROR"), or "" when it carries none. */
export function levelOf(line) {
  const m = LEVEL_RE.exec(line);
  return m ? m[1] : "";
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
