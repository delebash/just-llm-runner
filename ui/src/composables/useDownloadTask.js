// SPDX-License-Identifier: GPL-3.0-or-later
// THE one download-task orchestrator (2026-07-15, the ONE-DOWNLOADER consolidation —
// user: "reuse the control … stop repeating code … if component exists to do this
// already use it instead of writing your own").
//
// createDownloadTask(channel) turns any "POST to start → poll a status URL → cancel"
// server channel — the engine install, a model LOAD, a model DOWNLOAD — into ONE reactive
// task that the shared DownloadBar renders. It replaces QuickSetup's hand-rolled
// chatBar/embedBar + runChat/runEmbed/cancel/retry copy (the third, freshest copy of this
// poll loop). Pure JS + Vue reactivity; ONE rate tracker per task (downloadRate.js — no
// fork). The caption comes from the ONE shared formatter `progressCaption` (downloadRate.js),
// the same one the two domain singletons (useEngine, useRunnerModels) use — no re-derive.
import { computed, reactive } from "vue";

import { request } from "../client.js";
import { createRateTracker, progressCaption, rateSuffix } from "../common/services/downloadRate.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a reactive download task from a server channel.
 *
 * channel = {
 *   start:   async () => void,          // POSTs to begin the op
 *   statusUrl: string,                  // the GET status endpoint to poll
 *   read:    (st) => ({ detail, done, total, error, status,
 *                       terminal: "" | "done" | "error" | "cancelled" }),  // pure mapper
 *   cancel:  async () => void,          // POSTs the cancel/stop
 *   friendly?: (detail, status) => string,   // detail → user phrase (default: detail)
 *   fetch?:  (url) => Promise<any>,     // status fetcher (default: the kit `request`) — injectable for tests
 *   pollMs?: number,                    // poll interval (default 1200)
 *   maxPolls?: number,                  // safety cap (default 1000)
 * }
 *
 * Returns a reactive task: { state, phase, done, total, rateText, error, label,
 *   start(), cancel(), retry(), waiting(phase), fail(message) }.
 * `state` ∈ "" | "running" | "done" | "error" | "cancelled". The poll loop exits the
 * moment `state` leaves "running", so cancel() (which flips state FIRST) stops it at once.
 */
export function createDownloadTask(channel) {
  const {
    start: doStart,
    statusUrl,
    read,
    cancel: doCancel,
    friendly = (detail) => detail || "Working",
    fetch = request,
    pollMs = 1200,
    maxPolls = 1000,
  } = channel;

  const rate = createRateTracker();
  const task = reactive({
    state: "",
    phase: "",
    done: 0,
    total: 0,
    rateText: "",
    error: "",
    // The caption computed off the live fields via the ONE shared formatter.
    label: computed(() => progressCaption(task.phase || "Working", task.done, task.total, task.rateText)),
  });

  function _arm(phase) {
    task.state = "running";
    task.phase = phase;
    task.done = 0;
    task.total = 0;
    task.rateText = "";
    task.error = "";
    rate.reset();
  }

  async function _poll() {
    for (let i = 0; i < maxPolls; i++) {
      if (task.state !== "running") return; // a cancel flipped the state — stop silently
      let st;
      try {
        st = await fetch(statusUrl);
      } catch {
        return; // transient — stop quietly; a retry re-arms the loop
      }
      if (task.state !== "running") return;
      const r = read(st) || {};
      if (r.terminal === "error") {
        task.state = "error";
        task.error = r.error || "It failed.";
        return;
      }
      if (r.terminal === "cancelled") {
        // The channel itself reports the cancel terminal (idle-after-cancel). cancel()
        // usually flips our state first, so this is the belt-and-braces path.
        task.state = "cancelled";
        task.phase = "Cancelled";
        task.rateText = "";
        return;
      }
      if (r.terminal === "done") {
        task.state = "done";
        task.phase = "Ready";
        task.rateText = "";
        return;
      }
      task.phase = friendly(r.detail, r.status);
      task.done = Number(r.done) || 0;
      task.total = Number(r.total) || 0;
      task.rateText = rateSuffix(rate.update(task.done), task.done, task.total);
      await sleep(pollMs);
    }
  }

  async function start() {
    _arm("Getting ready");
    try {
      await doStart();
    } catch (e) {
      task.state = "error";
      task.error = e?.message || "Couldn't start.";
      return;
    }
    await _poll();
  }

  async function cancel() {
    // Flip state FIRST so the poll loop exits immediately; THEN the server call. A
    // cancel is truthful about the SETUP even if the in-flight fetch runs on server-side.
    if (task.state !== "running") return;
    task.state = "cancelled";
    task.phase = "Cancelled";
    task.rateText = "";
    try {
      await doCancel();
    } catch {
      /* best-effort — the terminal state already reads cancelled */
    }
  }

  function retry() {
    return start();
  }

  // Held display: running-but-not-polling, an indeterminate bar, for a task blocked on a
  // prerequisite (QuickSetup's chat waiting on the engine). No server call is made.
  function waiting(phase) {
    _arm(phase || "Waiting…");
  }

  // Force an error display without a start attempt (QuickSetup: the engine failed, so the
  // chat load must not even try). `retry()` still re-runs start() if the user clicks Retry.
  function fail(message) {
    task.state = "error";
    task.error = message || "It failed.";
    task.rateText = "";
  }

  // Back to idle (state "") with every field cleared — a fresh run (QuickSetup re-applies).
  function reset() {
    task.state = "";
    task.phase = "";
    task.done = 0;
    task.total = 0;
    task.rateText = "";
    task.error = "";
    rate.reset();
  }

  task.start = start;
  task.cancel = cancel;
  task.retry = retry;
  task.waiting = waiting;
  task.fail = fail;
  task.reset = reset;
  return task;
}
