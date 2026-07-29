// SPDX-License-Identifier: MIT
// THE one freshness classifier for a streaming AI task's last-token gap (#5, 2026-07-17).
//
// Was duplicated as absolute 3s/10s thresholds in AiTaskStrip.vue AND AiStatusPanel.vue
// (R3), and those absolutes MISLABELLED a legitimately-slow LOCAL model: on the user's
// box an entity sweep on Qwen3.6 35B ran at ~2.6 tok/s (first token 47.9 s), so healthy
// generation leaves multi-second gaps between tokens and the chip sat on "stalling" the
// whole run. The fix: calibrate to the STREAM'S OWN measured pace instead of a wall clock.
//
// After the first token — whose latency is prompt-eval, NOT a stall, and legitimately long
// — track the mean inter-token gap and flag only when the current silence runs well past it.
// A fast cloud stream keeps the tight floor; a slow local model self-scales. Until a second
// token gives us a gap to measure, fall back to the generous floors (never the old 3 s).
//
// Consumed by AiTaskStrip.vue + AiStatusPanel.vue; both pass the store's ticking `now` so the
// value recomputes as time passes. `task.deltaCount` is maintained by the aiTasks store.

const STALL_FLOOR_MS = 8000; // never "stalling" before this, however slow the model
const STUCK_FLOOR_MS = 25000; // never "stuck" before this
const STALL_K = 4; // stalling once the gap exceeds K× the running-mean inter-token gap
const STUCK_K = 8;

/**
 * Classify a streaming task's last-token freshness: "fresh" | "stalling" | "stuck" | null.
 * `null` when the task isn't streaming or no token has landed yet.
 * @param {object} task  an aiTasks task ({ status, firstDeltaAt, lastDeltaAt, deltaCount })
 * @param {number} now   the store's ticking clock (ms epoch)
 */
export function freshnessOf(task, now) {
  if (!task || task.status !== "streaming") return null;
  if (!task.lastDeltaAt) return null;
  const ago = Math.max(0, now - task.lastDeltaAt);
  // Running mean inter-token gap, first-token latency EXCLUDED (it's prompt-eval). Needs
  // >= 2 deltas to have a gap; until then the floors alone apply.
  const n = task.deltaCount || 0;
  const meanGap = n >= 2 && task.firstDeltaAt ? (task.lastDeltaAt - task.firstDeltaAt) / (n - 1) : null;
  const stallAt = meanGap ? Math.max(STALL_FLOOR_MS, STALL_K * meanGap) : STALL_FLOOR_MS;
  const stuckAt = meanGap ? Math.max(STUCK_FLOOR_MS, STUCK_K * meanGap) : STUCK_FLOOR_MS;
  if (ago >= stuckAt) return "stuck";
  if (ago >= stallAt) return "stalling";
  return "fresh";
}
