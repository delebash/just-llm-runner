// SPDX-License-Identifier: MIT
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
import { friendlyPhase } from "../common/services/loadPhases.js";
import { friendlyEnginePhase } from "./useEngine.js";

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
 *   start(), cancel(), retry(), dismiss(), waiting(phase), fail(message), arm(phase),
 *   apply(reading) }.
 * `state` ∈ "" | "running" | "done" | "error" | "cancelled". The poll loop exits the
 * moment `state` leaves "running", so cancel() (which flips state FIRST) stops it at once.
 *
 * TWO ways to drive it, ONE machine (2026-07-21): start() self-polls (QuickSetup, the engine
 * bar — the initiator owns the loop). OR an external poller arms it then feeds it readings:
 * arm(phase) → running, apply(reading) → advance/terminate — the catalog's useRunnerModels does
 * this from its ONE /models poll, because a model can be loading server-side (a feature run,
 * warm-boot) with no local start() to own a loop. apply() no-ops unless running, so a cancel or
 * terminal that already fired is never overwritten (that is what freezes the bar on cancel).
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
    // A cancel that's issued but not yet CONFIRMED by the server (the model is still tearing
    // down). While true, the bar keeps Retry DISABLED — clicking Retry mid-teardown re-races the
    // load (the user's out-of-state bug, 2026-07-21). The driver clears it once the op is truly
    // gone (the catalog does this by resetting the task when the model leaves loading/stopping).
    finalizing: false,
    // The caption. A cancel-in-flight reads "Cancelling…" while it's still finalizing (the
    // teardown isn't done — Retry is still disabled); "Cancelled" only once it's confirmed.
    // Otherwise the ONE shared formatter off the live fields.
    label: computed(() => {
      if (task.state === "cancelled") return task.finalizing ? "Cancelling…" : "Cancelled";
      // An errored task keeps whatever phase it died in, so the caption used to read e.g.
      // "Getting ready" directly above a failure message (2026-07-24, the user's screenshot).
      // The error line below carries the detail; the caption just states the outcome.
      if (task.state === "error") return "Failed";
      return progressCaption(task.phase || "Working", task.done, task.total, task.rateText);
    }),
  });

  function _arm(phase) {
    task.state = "running";
    task.phase = phase;
    task.done = 0;
    task.total = 0;
    task.rateText = "";
    task.error = "";
    task.finalizing = false;
    rate.reset();
  }

  // Apply ONE status reading (a channel read() result) to the task — the state machine's step,
  // EXTRACTED so both drivers share it: the self-poll loop below AND an external poller
  // (useRunnerModels feeds its per-model tasks from its ONE /models poll). No-ops unless
  // running, so a cancel/terminal that already fired is never overwritten — the freeze-on-cancel.
  function apply(reading) {
    if (task.state !== "running") return;
    const r = reading || {};
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
      apply(read(st));
      if (task.state !== "running") return; // apply reached a terminal
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

  // Clear a FINISHED-BADLY task and tell the server to forget it too (2026-07-24). Before
  // this there was no way out of a failed download: the bar offered only Retry, and the
  // server kept the errored row in its status map forever, so the catalog re-armed a task
  // for it on every poll and the row was stuck. dismiss() is deliberately terminal-only —
  // a RUNNING task must go through cancel(), which is a different promise (stop the work).
  async function dismiss() {
    if (task.state === "running" || task.state === "") return;
    try {
      await doCancel();   // best-effort: drops the dead row server-side so it stops coming back
    } catch {
      /* the local clear below still stands */
    }
    reset();
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
    task.finalizing = false;
    rate.reset();
  }

  task.start = start;
  task.cancel = cancel;
  task.retry = retry;
  task.dismiss = dismiss;
  task.waiting = waiting;
  task.fail = fail;
  task.reset = reset;
  // The external-feed pair (the catalog's fed-task path): arm() → a running bar with no poll of
  // its own, apply(reading) → advance it from the singleton's shared /models poll.
  task.arm = _arm;
  task.apply = apply;
  return task;
}

// ── THE three runner channels (promoted from QuickSetup's inline defs, 2026-07-18 —
// LuBookSearchSetup needed the engine + download channels and a copy is how drift
// starts). Each is a factory returning a channel for createDownloadTask; the model
// channels take a `getId` thunk so the start reads the LIVE pick at call time. The
// pure `read` mappers ride along for unit tests. ─────────────────────────────────

export function readEngineStatus(st) {
  if (st.status === "error") return { terminal: "error", error: st.error };
  if (st.installed || st.status === "installed") return { terminal: "done" };
  return { detail: st.detail, done: st.downloaded, total: st.total, status: st.status };
}
export function readLoadStatus(st) {
  if (st.status === "running") return { terminal: "done" };
  if (st.status === "error") {
    const err = st.error === "engine-not-installed"
      ? "The engine isn't installed — install it first (the engine bar above)."
      : st.error;
    return { terminal: "error", error: err };
  }
  return { detail: st.detail, done: st.downloaded, total: st.total, status: st.status };
}
export function readDownloadStatus(st) {
  if (st.status === "error") return { terminal: "error", error: st.error };
  // `idle` is the download channel's terminal for a FINISHED fetch; a cancel flips the
  // task's own state first, so reaching here still running means it genuinely completed.
  if (st.status === "idle") return { terminal: "done" };
  return { detail: st.detail, done: st.downloaded, total: st.total, status: st.status };
}

export function engineInstallChannel() {
  return {
    start: () => request("/v1/llm-runner/engine/install", { method: "POST" }),
    statusUrl: "/v1/llm-runner/engine/status",
    read: readEngineStatus,
    cancel: () => request("/v1/llm-runner/engine/install/cancel", { method: "POST" }),
    friendly: friendlyEnginePhase,
  };
}
export function modelLoadChannel(getId) {
  return {
    start: () => request("/v1/llm-runner/load", { method: "POST", body: { modelId: getId() } }),
    statusUrl: "/v1/llm-runner/status",
    read: readLoadStatus,
    cancel: () => request("/v1/llm-runner/stop", { method: "POST", body: { modelId: getId() } }),
    friendly: friendlyPhase,
  };
}
export function modelDownloadChannel(getId) {
  return {
    start: () => request("/v1/llm-runner/download", { method: "POST", body: { modelId: getId() } }),
    statusUrl: "/v1/llm-runner/download/status",
    // /download/status is a per-model map now ({modelId: {...}}, CONCURRENT). Extract THIS
    // model's entry; ABSENT == idle == readDownloadStatus's finished-terminal (the same
    // "done" it returned for the old single idle status), so a completed download still ends.
    read: (st) => readDownloadStatus((st.downloads || {})[getId()] || { status: "idle" }),
    cancel: () => request("/v1/llm-runner/download/cancel", { method: "POST", body: { modelId: getId() } }),
    friendly: friendlyPhase,
  };
}
