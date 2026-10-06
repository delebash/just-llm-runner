// SPDX-License-Identifier: MIT
// runStats — ONE source for how a run's numbers are printed, so every surface (the Lab
// result readout, the AI task strip, the Compare ranking) shows the SAME stat the SAME
// way (#304). Before this the Lab said "24823 ms" + total tokens while the task strip said
// "24.8s" + output tokens — same run, two formats. The conventions here are the task
// strip's (the live surface users watch): time in SECONDS, OUTPUT tokens (the decode count
// tok/s is based on) with the prompt shown as "in→out" only when it's known, tok/s to 1dp,
// and one money format. Each surface still chooses WHICH pieces to show; only the FORMAT is
// single-sourced. `fmtCost` matches the wrapper's usage/cost pass-through in aiFeature.js.

/** Wall time as seconds, 1dp: 24823 (ms) → "24.8s". Pass MILLISECONDS. */
export function fmtSeconds(ms) {
  return `${((Number(ms) || 0) / 1000).toFixed(1)}s`;
}

/** Token count. Output tokens are the yardstick (tok/s is output/second); the prompt is
 *  shown as "in→out" only when it's known — the task strip mid-stream has output only. */
export function fmtTokens({ promptTokens = 0, outputTokens = 0 } = {}) {
  const inp = Number(promptTokens) || 0;
  const out = Number(outputTokens) || 0;
  return inp ? `${inp}→${out} tok` : `${out} tok`;
}

/** Decode speed, 1dp. Accepts a number or a numeric string. */
export function fmtTps(tps) {
  return `${(Number(tps) || 0).toFixed(1)} tok/s`;
}

/**
 * A running task's output tokens so far, estimated: its streamed characters ÷ 4 —
 * the answer's and a thinking model's reasoning together (2026-10-06), which is what
 * the model's own count includes once it lands.
 */
export function taskTokensSoFar(task) {
  return Math.max(0, Math.round(((task?.chars || 0) + (task?.thinkingChars || 0)) / 4));
}

/**
 * A task's output tokens per second since its first token, up to `endMs` — or null
 * until a second of output has arrived (2026-10-06: 3 tokens a millisecond after the
 * first read "3000.0 tok/s"). Tokens are the real count once usage lands, else
 * `taskTokensSoFar`. The AI task strip and the status panel both read it.
 */
export function taskTps(task, endMs) {
  if (!task?.firstDeltaAt) return null;
  const span = endMs - task.firstDeltaAt;
  if (span < 1000) return null;
  const tokens = task.tokensOut || taskTokensSoFar(task);
  if (!tokens) return null;
  return (tokens / (span / 1000)).toFixed(1);
}

/** Output word count. */
export function fmtWords(n) {
  return `${Number(n) || 0} words`;
}

/** Money: "$0", sub-cent to 4dp, else 2dp. */
export function fmtCost(c) {
  const v = Number(c) || 0;
  if (!v) return "$0";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
