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

import { FAMILY_TASK_LINGER } from "../common/familyContract.js";

// 50, not the old 30 — aligned 2026-08-07 with what JustVoice's fork kept, so its
// conversion doesn't silently shorten the user's history (and costs the siblings
// nothing — history rows are summaries).
const HISTORY_LIMIT = 50;

// A failed task lingers until dismissed (FAMILY_TASK_LINGER), keeping its streamed
// preview readable for diagnosis. Cap what a SETTLED task may retain so an ignored
// error row can't pin an entire document's worth of stream in memory indefinitely.
const SETTLED_PREVIEW_CAP = 32_768;

let nextId = 1;
let tickHandle = null;
// Pending auto-dismiss timers, keyed by task id — so a ✕ (or a retry) can cancel a
// scheduled archive instead of racing it.
const lingerTimers = new Map();

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
    // RUNNING ONLY — the meaning this has always had, kept deliberately. With
    // `lingerMs` (below) `order` can also hold finished-but-still-shown tasks, so
    // this filters by status rather than trusting `order`. Badges and counts stay
    // exactly as they were for hosts that don't opt into lingering.
    runningTasks: (s) => s.order
      .map((id) => s.tasks[id])
      .filter((t) => t && (t.status === "connecting" || t.status === "streaming")),
    runningCount() { return this.runningTasks.length; },
    // Everything a STRIP or panel should show: running, plus anything inside its
    // linger window. Identical to runningTasks unless a task passed `lingerMs`.
    visibleTasks: (s) => s.order.map((id) => s.tasks[id]).filter(Boolean),
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
    // Gate on tasks that are actually RUNNING, not on `order.length` — JustVoice's
    // renderTasks fixed exactly this bug and the fix comes up with the store: a
    // failed task with `lingerMs.failed = null` never auto-dismisses, so a
    // length-gated ticker fired forever behind a lingering error strip. Finished
    // tasks have a fixed finishedAt and need no clock.
    //
    // The OPEN PANEL also keeps the clock alive: its "ago" strings (`fmtAgo(...,
    // tasks.now)`) otherwise freeze the moment the last run ends — a pre-existing
    // staleness that failed-until-dismissed rows made impossible to ignore.
    _maybeStopTicker() {
      if (!this.runningTasks.length && !this.panelOpen && tickHandle) {
        clearInterval(tickHandle);
        tickHandle = null;
      }
    },

    // Begin a new task. Returns a handle the caller threads into the
    // underlying chat stream: { id, signal, onDelta, markStreaming,
    // finish, fail, cancel }.
    //
    // `stats`   — plain strings the surfaces render beside the standard ones
    //   ("3.2 KB", "1.4s audio", "12 / 47 lines"). Deliberately DATA, not the
    //   callback JustVoice's renderTasks used: this store exists so a task
    //   survives the component that started it, and a stats callback closes over
    //   that component's scope — after unmount it reads dead refs. The caller
    //   computes the strings and pushes them with `setStats`.
    // `onRetry` — re-run the same operation; surfaces show Retry on a finished
    //   task. JustVoice's rule ("every long-running op gets progress + cancel +
    //   retry") applied family-wide; the store had no retry at all before.
    // `lingerMs`— per-outcome dwell before archiving. OMITTED → the FAMILY policy
    //   (FAMILY_TASK_LINGER: completed 5 s · cancelled 3 s · failed until dismissed;
    //   ruled 2026-08-07, same in every app — this supersedes the opt-in framing an
    //   earlier commit shipped). `{}` → no linger at all, the explicit opt-out
    //   (tests use it for archive-now assertions). A partial object overrides just
    //   those outcomes; `null` for an outcome means "stays until dismissed".
    // `inline`  — this task's progress is rendered by the surface that started it
    //   (a Lab column's own strip, a modal's). A GLOBAL task stack skips inline
    //   tasks so one run never shows twice; the panel ignores the flag — it is the
    //   registry of everything.
    start({ feature, label, meta, stats, onRetry, lingerMs, inline }) {
      const id = `aitask-${nextId++}`;
      const now = Date.now();
      const controller = new AbortController();
      this.tasks[id] = {
        id,
        feature: feature || "ai",
        label: label || feature || "AI call",
        meta: meta || {},
        stats: Array.isArray(stats) ? [...stats] : [],
        lingerMs: lingerMs === undefined ? FAMILY_TASK_LINGER : lingerMs,
        inline: !!inline,
        // Non-reactive: it is a callback, and reactivity on it buys nothing.
        _onRetry: onRetry ? markRaw(onRetry) : null,
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
        // Replace the per-task stat strings. Call it whenever the numbers change —
        // a render learning its byte count, a batch finishing another line.
        setStats: (list) => this._setStats(id, list),
        // Attach arbitrary result data (`{ meta: {...} }` merges into meta).
        // A finished task is still patchable: results usually land last.
        update: (patch) => this._update(id, patch),
      };
    },

    _setStats(id, list) {
      const t = this.tasks[id];
      if (!t) return;
      t.stats = Array.isArray(list) ? [...list] : [];
    },

    _update(id, patch) {
      const t = this.tasks[id];
      if (!t || !patch) return;
      const { meta, ...rest } = patch;
      if (meta) t.meta = { ...t.meta, ...meta };
      Object.assign(t, rest);
    },

    // Re-run a finished task's operation. The surfaces show this on completed,
    // cancelled and failed entries; dismissing the old one first keeps a retry
    // from stacking a duplicate row beside its own re-run. HISTORY rows retry
    // too (JustVoice's fork always could — its archive kept the whole task; here
    // the callback rides the summary): the history row stays as the record and
    // the re-run appears as a fresh task.
    retry(id) {
      const t = this.tasks[id];
      if (t) {
        const again = t._onRetry;
        if (!again) return;
        this.dismiss(id);
        again();
        return;
      }
      const h = this.history.find((x) => x.id === id);
      h?._onRetry?.();
    },

    // Remove a lingering task NOW (the ✕). Running tasks are untouched — cancel
    // those instead, so a click cannot silently orphan work still in flight.
    dismiss(id) {
      const t = this.tasks[id];
      if (!t) return;
      if (t.status === "connecting" || t.status === "streaming") return;
      this._clearLinger(id);
      this._archiveAndRemove(id);
    },

    _clearLinger(id) {
      const handle = lingerTimers.get(id);
      if (handle) {
        clearTimeout(handle);
        lingerTimers.delete(id);
      }
    },

    // Archive now, or after this outcome's dwell if the task asked for one.
    _archiveAfterLinger(id, outcome) {
      const t = this.tasks[id];
      if (!t) return;
      // The task has settled — cap the retained stream preview (see SETTLED_PREVIEW_CAP).
      if (t.preview && t.preview.length > SETTLED_PREVIEW_CAP) {
        t.preview = `${t.preview.slice(0, SETTLED_PREVIEW_CAP)}…`;
      }
      const ms = t.lingerMs ? t.lingerMs[outcome] : undefined;
      if (ms == null) {
        // No linger configured for this outcome → today's behaviour, archive now.
        // (An explicit `null`, e.g. failed, means "stay until dismissed" — which is
        // why the ticker gate counts RUNNING tasks, not `order.length`.)
        if (!t.lingerMs || !(outcome in t.lingerMs)) this._archiveAndRemove(id);
        else this._maybeStopTicker();
        return;
      }
      this._maybeStopTicker();
      lingerTimers.set(id, setTimeout(() => {
        lingerTimers.delete(id);
        this._archiveAndRemove(id);
      }, ms));
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
      if (!this.isRunning(id)) return; // first outcome wins — see _fail
      const now = Date.now();
      t.status = "done";
      t.finishedAt = now;
      if (result?.usage) {
        t.tokensIn = result.usage.promptTokens || t.tokensIn;
        t.tokensOut = result.usage.completionTokens || t.tokensOut;
      }
      if (result?.providerId) t.providerId = result.providerId;
      if (result?.model) t.model = result.model;
      this._archiveAfterLinger(id, "completed");
      // QC-30/QC-37 (the toast law, user 2026-07-09: "no ai task complete
      // toasts we have the ai progress bar, and the que"): NO completion
      // toast — the strip on the surface + the panel history ARE the outcome
      // surfaces. (This retired B5-7's meta.silentToast escape: with no toast
      // at all, there is nothing to silence.)
    },

    _fail(id, err) {
      const t = this.tasks[id];
      if (!t) return;
      // FIRST outcome wins. Callers overwhelmingly write
      //   catch (e) { if (signal.aborted) cancel(); else fail(e); }
      // and aborting also throws into that same catch, so cancel-then-fail is the
      // NORMAL path, not an edge case. Before lingering it was invisible: cancel()
      // archived immediately, so the task was gone by the time fail() arrived and
      // this method no-op'd on `!t`. With a row that lingers, a task the USER
      // cancelled would flip to "error", badge the titlebar red, and with
      // `failed: null` never leave the panel.
      if (!this.isRunning(id)) return;
      const now = Date.now();
      t.status = "error";
      t.error = err?.message || String(err || "Unknown error");
      t.finishedAt = now;
      this._archiveAfterLinger(id, "failed");
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
      this._archiveAfterLinger(id, "cancelled");
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
      // A pending linger timer would otherwise fire against a deleted task.
      this._clearLinger(id);
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
        // The app's own numbers ("3.2 KB", "1.4s audio") — they ride into history
        // so a finished run's detail survives the linger window.
        stats: Array.isArray(t.stats) ? [...t.stats] : [],
        // Retry survives archival (already markRaw'd) — a failed render is
        // re-runnable from its history row, not only during the linger.
        _onRetry: t._onRetry || null,
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
    openPanel()   { this.panelOpen = true; this.unseenErrors = 0; this._ensureTicker(); },
    closePanel()  { this.panelOpen = false; this._maybeStopTicker(); },
    togglePanel() { this.panelOpen ? this.closePanel() : this.openPanel(); },
  },
});
