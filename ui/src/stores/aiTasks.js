// SPDX-License-Identifier: MIT
// Global registry for in-flight AI chat-stream calls (the shared AI task
// queue — Decision 22; moved verbatim from JustWrite, transport-agnostic).
//
// Hoisting task state into a store (rather than each call site owning
// its own AbortController + refs) is what lets a call survive the
// component that started it. A view can unmount mid-stream and the
// task keeps running; results land in whatever Pinia store the caller
// writes to (project, studio, etc.) regardless of mounted state.
//
// The header AI status button + slide-in panel observe this store to
// show every in-flight call from anywhere in the app, with cancel.
//
// Status phases:
//   "connecting" — task started, no token yet (network in flight, model loading)
//   "streaming"  — first delta has arrived; tokens flowing
//   "done"       — completed successfully; archived to history
//   "cancelled"  — aborted by user; archived to history
//   "error"      — threw; archived to history with .error
//
// Stalled detection (UI concern, not stored): classified by the shared
// streamFreshness.js against `now` (live-ticked, so a computed in any view
// derives the signal without its own setInterval) — RATE-RELATIVE (#5), the
// gap since lastDeltaAt vs this stream's own mean inter-token gap, not a fixed
// wall clock (a slow local model's healthy multi-second gaps aren't "stalling").
// deltaCount (below) feeds that mean.

import { defineStore } from "pinia";
import { markRaw } from "vue";

const HISTORY_LIMIT = 30;

let nextId = 1;
let tickHandle = null;

export const useAiTasksStore = defineStore("aiTasks", {
  state: () => ({
    // tasks: { [id]: AiTask }. AiTask shape:
    //   { id, feature, label, meta, status, startedAt, firstDeltaAt,
    //     lastDeltaAt, finishedAt, tokensIn, tokensOut, chars, preview,
    //     providerId, model, error, _controller }
    tasks: {},
    // Insertion order of currently-running task ids. Drives the panel list.
    order: [],
    // Finished task summaries (most recent first). Capped at HISTORY_LIMIT.
    history: [],
    // Live-ticked clock for elapsed / stall computed properties.
    now: Date.now(),
    // Status panel open state.
    panelOpen: false,
    // QC-30/QC-37 (the toast law): failures signal DURABLY, not ephemerally —
    // this count badges the titlebar chip red until the user opens the panel
    // (viewing acknowledges; the history entry keeps the detail).
    unseenErrors: 0,
  }),

  getters: {
    runningTasks: (s) => s.order.map((id) => s.tasks[id]).filter(Boolean),
    runningCount() { return this.runningTasks.length; },
    taskById: (s) => (id) => s.tasks[id] || null,
    // True while the named task id is still running. Lets a view show
    // "task is in flight" UI without holding a local ref.
    isRunning: (s) => (id) => {
      const t = s.tasks[id];
      return !!t && (t.status === "connecting" || t.status === "streaming");
    },
  },

  actions: {
    _ensureTicker() {
      if (tickHandle) return;
      tickHandle = setInterval(() => { this.now = Date.now(); }, 500);
    },
    _maybeStopTicker() {
      if (!this.order.length && tickHandle) {
        clearInterval(tickHandle);
        tickHandle = null;
      }
    },

    // Begin a new task. Returns a handle the caller threads into the
    // underlying chat stream: { id, signal, onDelta, markStreaming,
    // finish, fail, cancel }.
    start({ feature, label, meta }) {
      const id = `aitask-${nextId++}`;
      const now = Date.now();
      const controller = new AbortController();
      this.tasks[id] = {
        id,
        feature: feature || "ai",
        label: label || feature || "AI call",
        meta: meta || {},
        status: "connecting",
        startedAt: now,
        firstDeltaAt: 0,
        lastDeltaAt: 0,
        // #5 (2026-07-17): count of streamed deltas — feeds streamFreshness's
        // rate-relative stall test (mean inter-token gap = span / (deltaCount - 1)).
        deltaCount: 0,
        finishedAt: 0,
        tokensIn: 0,
        tokensOut: 0,
        chars: 0,
        preview: "",
        // Prompt-eval progress 0..1 (§7.4 B6-2, builtin engine only) — set by
        // {progress} stream frames while the model reads the prompt, cleared
        // on the first token so the strip's "reading prompt N%" yields to the
        // normal streaming stats. null = not reported (cloud providers).
        prefill: null,
        providerId: null,
        model: null,
        error: null,
        // The controller is non-reactive — Vue tracking on it is wasted
        // work and complicates devtools introspection.
        _controller: markRaw(controller),
      };
      this.order.push(id);
      this.now = now;
      this._ensureTicker();
      return {
        id,
        signal: controller.signal,
        onDelta: (delta, content) => this._recordDelta(id, delta, content),
        markStreaming: () => this._markStreaming(id),
        finish: (result) => this._finish(id, result),
        fail: (err) => this._fail(id, err),
        cancel: () => this.cancel(id),
        // QC-31 (one task entry per USER ACTION): a batch owner (Reader
        // knowledge's 13 chapters, multi-reader's 4 personas) starts ONE
        // handle, threads `signal` through every sub-call, and reports
        // progress here — the strip/panel render "n/m" and the one Cancel
        // aborts the whole loop through the shared controller.
        setProgress: (done, total) => this._setProgress(id, done, total),
        // §7.4 B6-2: prompt-eval percent from the stream's {progress} frames.
        setPrefill: (p) => this._setPrefill(id, p),
      };
    },

    _setProgress(id, done, total) {
      const t = this.tasks[id];
      if (!t) return;
      t.progress = { done, total };
    },

    _setPrefill(id, p) {
      const t = this.tasks[id];
      if (!t) return;
      // Prompt eval only happens before the first token — ignore stragglers.
      if (t.firstDeltaAt) return;
      t.prefill = typeof p === "number" ? Math.min(1, Math.max(0, p)) : null;
    },

    _markStreaming(id) {
      const t = this.tasks[id];
      if (t && t.status === "connecting") t.status = "streaming";
    },

    _recordDelta(id, delta, content) {
      const t = this.tasks[id];
      if (!t) return;
      const now = Date.now();
      if (!t.firstDeltaAt) t.firstDeltaAt = now;
      t.lastDeltaAt = now;
      t.deltaCount = (t.deltaCount || 0) + 1; // #5: rate-relative freshness calibration

      // Generation started — the prefill phase is over (§7.4 B6-2).
      t.prefill = null;
      if (t.status === "connecting") t.status = "streaming";
      if (typeof content === "string") {
        t.preview = content;
        t.chars = content.length;
      } else if (typeof delta === "string") {
        t.preview = (t.preview || "") + delta;
        t.chars = t.preview.length;
      }
    },

    _finish(id, result) {
      const t = this.tasks[id];
      if (!t) return;
      const now = Date.now();
      t.status = "done";
      t.finishedAt = now;
      if (result?.usage) {
        t.tokensIn = result.usage.promptTokens || t.tokensIn;
        t.tokensOut = result.usage.completionTokens || t.tokensOut;
      }
      if (result?.providerId) t.providerId = result.providerId;
      if (result?.model) t.model = result.model;
      this._archiveAndRemove(id);
      // QC-30/QC-37 (the toast law, user 2026-07-09: "no ai task complete
      // toasts we have the ai progress bar, and the que"): NO completion
      // toast — the strip on the surface + the panel history ARE the outcome
      // surfaces. (This retired B5-7's meta.silentToast escape: with no toast
      // at all, there is nothing to silence.)
    },

    _fail(id, err) {
      const t = this.tasks[id];
      if (!t) return;
      const now = Date.now();
      t.status = "error";
      t.error = err?.message || String(err || "Unknown error");
      t.finishedAt = now;
      this._archiveAndRemove(id);
      // QC-37 (the toast law): failures signal DURABLY, not with a toast
      // that disappears — the titlebar chip badges red until the panel is
      // opened, and the history entry carries the error detail.
      this.unseenErrors += 1;
    },

    cancel(id) {
      const t = this.tasks[id];
      if (!t) return;
      if (t.status !== "connecting" && t.status !== "streaming") return;
      try { t._controller?.abort?.(); } catch {}
      t.status = "cancelled";
      t.finishedAt = Date.now();
      this._archiveAndRemove(id);
      // No toast — the user just clicked Cancel, telling them so again
      // is noise. The history entry in the panel records it.
    },

    cancelAll() {
      // Snapshot ids — cancel mutates this.order.
      const ids = [...this.order];
      for (const id of ids) this.cancel(id);
    },

    _archiveAndRemove(id) {
      const t = this.tasks[id];
      if (!t) return;
      this.history.unshift({
        id: t.id,
        feature: t.feature,
        label: t.label,
        status: t.status,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        durationMs: Math.max(0, t.finishedAt - t.startedAt),
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut,
        providerId: t.providerId,
        model: t.model,
        error: t.error,
      });
      if (this.history.length > HISTORY_LIMIT) {
        this.history.length = HISTORY_LIMIT;
      }
      delete this.tasks[id];
      this.order = this.order.filter((x) => x !== id);
      this._maybeStopTicker();
    },

    dismissHistory(historyId) {
      this.history = this.history.filter((h) => h.id !== historyId);
    },
    clearHistory() { this.history = []; },

    // QC-37: opening the panel acknowledges failures → clear the durable
    // error badge. togglePanel routes through openPanel so the clear lives in
    // ONE place — the titlebar chip AND the sidebar item both toggle, and a
    // per-place `panelOpen = true` would have left the badge stuck red.
    openPanel()   { this.panelOpen = true; this.unseenErrors = 0; },
    closePanel()  { this.panelOpen = false; },
    togglePanel() { this.panelOpen ? this.closePanel() : this.openPanel(); },
  },
});
