<script setup>
// SPDX-License-Identifier: MIT
// Right-side slide-in panel showing all in-flight AI tasks + recent history.
//
// Per running task: feature/label, status phase (connecting / streaming /
// stalled), elapsed, first-token latency, tokens-per-second, tokens out,
// last-token delay (the "stuck vs. processing" signal), an expandable
// streaming preview, and a cancel button.
//
// Recent history shows the last 50 finished tasks (HISTORY_LIMIT) with
// duration, tokens, and outcome (done / cancelled / errored).
//
// The store ticks `now` every 500ms so every elapsed / freshness number
// stays live without each row registering its own setInterval.

import { ref, computed } from "vue";
import { usePanelDismiss } from "../common/composables/usePanelDismiss.js";
import { useAiTasksStore } from "../stores/aiTasks.js";
import Icon from "../common/components/Icon.vue";
import UiButton from "../common/components/UiButton.vue";
// Shared run-stat format (#304). Tokens + tok/s single-sourced with AiTaskStrip; the local
// fmtSeconds below stays (it adds a minutes form for long history durations the shared one doesn't).
import { fmtTokens, fmtTps } from "../common/services/runStats.js";
import { freshnessOf } from "../common/services/streamFreshness.js";

const tasks = useAiTasksStore();
const openPreviews = ref(new Set());

// QC-32: RUNNING work owns the panel; history is a short tail behind an
// expander instead of 30 rows dominating the window.
const HISTORY_TAIL = 5;
const showAllHistory = ref(false);
const visibleHistory = computed(() =>
  showAllHistory.value ? tasks.history : tasks.history.slice(0, HISTORY_TAIL));
const hiddenHistoryCount = computed(() =>
  Math.max(0, tasks.history.length - visibleHistory.value.length));

// Settled-but-still-visible tasks (inside their linger window — see
// FAMILY_TASK_LINGER). They render in RECENT, above history, never under Running:
// JustVoice's fork had this split from day one and an earlier pass here put
// lingering rows under the "Running" header, where the count read 0 above a
// visible row. Running means running.
const lingering = computed(() =>
  tasks.visibleTasks.filter((t) => !tasks.isRunning(t.id)));
const recentCount = computed(() => lingering.value.length + tasks.history.length);

const LINGER_ICON = { done: "Check", cancelled: "Close", error: "Alert" };
function settledDurationMs(t) {
  return Math.max(0, (t.finishedAt || 0) - t.startedAt);
}

// Esc + click-outside dismissal comes from the shared composable (2026-07-19 —
// this component used to carry its own near-identical copy; the toggle and
// portal exemptions now live in ONE place). The panel needs one extra
// exemption of its own: sonner toasts — the View action on a completion toast
// calls openPanel, and without this the same click would bubble here and close
// the panel it just opened.
const panelEl = ref(null);
usePanelDismiss(() => tasks.panelOpen, panelEl, () => tasks.closePanel(), {
  exempt: ["[data-sonner-toast]", "[data-sonner-toaster]"],
});

function togglePreview(id) {
  const next = new Set(openPreviews.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  openPreviews.value = next;
}

function fmtSeconds(ms) {
  if (!ms || ms < 0) return "0.0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtAgo(ts, now) {
  if (!ts) return "—";
  const m = Math.floor((now - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Live values driven by tasks.now (the 500ms ticker).
function elapsedMs(task) {
  return Math.max(0, tasks.now - task.startedAt);
}
function lastDeltaAgoMs(task) {
  if (!task.lastDeltaAt) return null;
  return Math.max(0, tasks.now - task.lastDeltaAt);
}
function firstTokenMs(task) {
  if (!task.firstDeltaAt) return null;
  return task.firstDeltaAt - task.startedAt;
}
// Tokens-per-second since first delta. Uses chars/4 as a proxy when
// the real token count hasn't landed yet (usage arrives on the final chunk).
function tokensPerSecond(task) {
  const first = task.firstDeltaAt;
  if (!first) return null;
  const liveSpanMs = Math.max(1, tasks.now - first);
  const tokens = task.tokensOut || Math.max(0, Math.round(task.chars / 4));
  if (!tokens) return null;
  return (tokens / (liveSpanMs / 1000)).toFixed(1);
}
// Freshness class for the last-token indicator (#5, 2026-07-17): the SHARED
// rate-relative classifier — calibrates to the stream's own pace instead of the
// old absolute 3s/10s that read a slow local model as "stalling" through healthy work.
function freshness(task) {
  return freshnessOf(task, tasks.now);
}

const phaseLabel = {
  connecting: "Connecting",
  streaming:  "Streaming",
};
</script>

<template>
  <!-- Teleport to body so the panel escapes the host shell's stacking context
       (e.g. an app-stage created by `position: fixed`). Without this, an
       AppModal — which Reka portals to body — paints above the entire shell
       subtree regardless of the panel's local z-index, leaving the panel
       blurred under the modal's backdrop-filter. With Teleport, both the
       panel and the modal-overlay live as siblings of body and stack by
       their own z-index values. -->
  <Teleport to="body">
    <transition name="aip-slide">
      <aside v-if="tasks.panelOpen" ref="panelEl" class="aip" role="dialog" aria-label="AI tasks">
      <header class="aip-head">
        <div>
          <div class="aip-eyebrow">Status</div>
          <h2>AI tasks</h2>
        </div>
        <UiButton intent="ghost" size="small" @click="tasks.closePanel()">
          <Icon name="Close" :size="12" /> Close
        </UiButton>
      </header>

      <!-- Running tasks ────────────────────────────────────────────── -->
      <section class="aip-section">
        <div class="aip-section-h">
          <span>Running</span>
          <span class="aip-section-count">{{ tasks.runningCount }}</span>
          <span class="aip-section-spacer" />
          <UiButton v-if="tasks.runningCount > 1" intent="ghost" size="small" @click="tasks.cancelAll()">
            <Icon name="Close" :size="11" /> Cancel all
          </UiButton>
        </div>

        <div v-if="!tasks.runningCount" class="aip-empty">
          Nothing running. Start any AI feature and you'll see it here with live status.
        </div>

        <!-- Running means RUNNING — a settled task inside its linger window renders
             under Recent below, exactly as JustVoice's fork always did. -->
        <div v-for="t in tasks.runningTasks" :key="t.id" class="aip-task">
          <div class="aip-task-h">
            <span class="aip-task-label">{{ t.label }}</span>
            <span class="aip-task-feature">{{ t.feature }}</span>
            <span class="aip-task-spacer" />
            <UiButton intent="danger" size="small" @click="tasks.cancel(t.id)">
              <template #icon><Icon name="Close" :size="11" /></template>
              Cancel
            </UiButton>
          </div>

          <div class="aip-task-stats">
            <span class="aip-stat" :data-phase="t.status">
              <span class="aip-stat-dot" />
              {{ phaseLabel[t.status] || t.status }}
            </span>
            <span v-if="t.progress" class="aip-stat"
              v-tooltip.bottom="'Batch progress — Cancel stops the whole run'">
              {{ t.progress.done }}/{{ t.progress.total }}
            </span>
            <!-- §7.4 B6-2: real prompt-eval progress (builtin engine) —
                 cleared when the first token arrives. -->
            <span v-if="t.prefill != null" class="aip-stat"
              v-tooltip.bottom="'The model is reading your prompt'">
              reading prompt {{ Math.round(t.prefill * 100) }}%
            </span>
            <span class="aip-stat">
              <Icon name="Clock" :size="10" />
              {{ fmtSeconds(elapsedMs(t)) }}
            </span>
            <span v-if="firstTokenMs(t) != null" class="aip-stat" v-tooltip.bottom="'Latency from request to first streamed token'">
              first {{ (firstTokenMs(t) / 1000).toFixed(1) }}s
            </span>
            <span v-if="t.tokensOut || t.chars" class="aip-stat" v-tooltip.bottom="t.tokensOut ? 'Exact output tokens (from the model)' : 'Approximate from streamed characters (~4 chars/token)'">
              <template v-if="t.tokensOut">{{ fmtTokens({ outputTokens: t.tokensOut }) }}</template>
              <template v-else>~{{ fmtTokens({ outputTokens: Math.round(t.chars / 4) }) }}</template>
            </span>
            <span v-if="tokensPerSecond(t)" class="aip-stat">
              {{ fmtTps(tokensPerSecond(t)) }}
            </span>
            <span v-if="freshness(t)" class="aip-stat" :data-fresh="freshness(t)" v-tooltip.bottom="freshness(t) === 'stuck' ? 'No new tokens for well past this model\'s usual pace — likely stuck' : freshness(t) === 'stalling' ? 'Slower than this model\'s usual pace right now' : 'Streaming live'">
              <span class="aip-stat-dot" />
              <template v-if="freshness(t) === 'fresh'">live</template>
              <template v-else-if="freshness(t) === 'stalling'">stalling · {{ fmtSeconds(lastDeltaAgoMs(t)) }}</template>
              <template v-else>stuck · {{ fmtSeconds(lastDeltaAgoMs(t)) }}</template>
            </span>
            <!-- The app's own numbers. The strip had a slot for these; this panel had
                 nothing at all, so a host's stats appeared on one surface and vanished
                 on the other — and this is the surface the sidebar row opens. -->
            <span v-for="(s, i) in (t.stats || [])" :key="`s${i}`" class="aip-stat">{{ s }}</span>
          </div>

          <div v-if="t.preview" class="aip-task-preview-row">
            <UiButton intent="ghost" size="small" @click="togglePreview(t.id)">
              <Icon :name="openPreviews.has(t.id) ? 'ChevDown' : 'ChevRight'" :size="11" />
              {{ openPreviews.has(t.id) ? "Hide preview" : "Show preview" }}
              <span class="aip-chars-note">· {{ t.chars }} chars</span>
            </UiButton>
            <div v-if="openPreviews.has(t.id)" class="aip-preview">
              <pre>{{ t.preview }}</pre>
            </div>
          </div>

          <div v-if="t.providerId || t.model" class="aip-task-foot">
            <code v-if="t.model">{{ t.model }}</code>
          </div>
        </div>
      </section>

      <!-- Recent: settled tasks still in their linger window, then history ── -->
      <section class="aip-section">
        <div class="aip-section-h">
          <span>Recent</span>
          <span class="aip-section-count">{{ recentCount }}</span>
          <span class="aip-section-spacer" />
          <UiButton v-if="tasks.history.length" intent="ghost" size="small" @click="tasks.clearHistory()">
            <Icon name="Trash" :size="11" /> Clear
          </UiButton>
        </div>

        <div v-if="!recentCount" class="aip-empty aip-empty-small">
          No completed tasks yet.
        </div>

        <!-- Lingering (just settled; a failure stays here until dismissed — the
             durable-error law as a row the user must acknowledge, error text and
             all, not just a badge count). -->
        <div v-for="t in lingering" :key="t.id" class="aip-hist-row" :data-status="t.status">
          <div class="aip-hist-icon">
            <Icon :name="LINGER_ICON[t.status] || 'Alert'" :size="11" />
          </div>
          <div class="aip-hist-body">
            <div class="aip-hist-line">
              <span class="aip-hist-label">{{ t.label }}</span>
              <span class="aip-hist-ago">{{ fmtAgo(t.finishedAt, tasks.now) }}</span>
            </div>
            <div class="aip-hist-meta">
              <span>{{ fmtSeconds(settledDurationMs(t)) }}</span>
              <span v-if="t.tokensOut">· {{ t.tokensOut }} tok out</span>
              <span v-for="(s, i) in (t.stats || [])" :key="`ls${i}`">· {{ s }}</span>
              <span v-if="t.model">· <code>{{ t.model }}</code></span>
            </div>
            <div v-if="t.error" class="aip-hist-error">{{ t.error }}</div>
          </div>
          <div class="aip-hist-actions">
            <UiButton v-if="t._onRetry" intent="ghost" size="icon" @click="tasks.retry(t.id)"
              v-tooltip.bottom="'Run it again'">
              <template #icon><Icon name="Refresh" :size="11" /></template>
            </UiButton>
            <UiButton intent="ghost" size="icon" @click="tasks.dismiss(t.id)"
              v-tooltip.bottom="'Dismiss'">
              <template #icon><Icon name="Close" :size="11" /></template>
            </UiButton>
          </div>
        </div>

        <div v-for="h in visibleHistory" :key="h.id" class="aip-hist-row" :data-status="h.status">
          <div class="aip-hist-icon">
            <Icon v-if="h.status === 'done'" name="Check" :size="11" />
            <Icon v-else-if="h.status === 'cancelled'" name="Close" :size="11" />
            <Icon v-else name="Alert" :size="11" />
          </div>
          <div class="aip-hist-body">
            <div class="aip-hist-line">
              <span class="aip-hist-label">{{ h.label }}</span>
              <span class="aip-hist-ago">{{ fmtAgo(h.finishedAt, tasks.now) }}</span>
            </div>
            <div class="aip-hist-meta">
              <span>{{ fmtSeconds(h.durationMs) }}</span>
              <span v-if="h.tokensOut">· {{ h.tokensOut }} tok out</span>
              <span v-for="(s, i) in (h.stats || [])" :key="`hs${i}`">· {{ s }}</span>
              <span v-if="h.model">· <code>{{ h.model }}</code></span>
            </div>
            <div v-if="h.error" class="aip-hist-error">{{ h.error }}</div>
          </div>
          <!-- Retry survives archival — a failed run is re-runnable from its
               history row (the callback rides the summary; JustVoice's fork
               kept the whole task for the same reason). -->
          <div v-if="h._onRetry" class="aip-hist-actions">
            <UiButton intent="ghost" size="icon" @click="tasks.retry(h.id)"
              v-tooltip.bottom="'Run it again'">
              <template #icon><Icon name="Refresh" :size="11" /></template>
            </UiButton>
          </div>
        </div>

        <UiButton v-if="hiddenHistoryCount || showAllHistory" intent="ghost" size="small"
          class="aip-hist-more" @click="showAllHistory = !showAllHistory">
          {{ showAllHistory ? "Show less" : `Show all (${tasks.history.length})` }}
        </UiButton>
      </section>
      </aside>
    </transition>
  </Teleport>
</template>

<style scoped>
.aip {
  /* z-index sits above .modal-overlay (100) so opening the panel from
     inside a modal (the Details button in any in-modal AiTaskStrip)
     floats it above the modal's backdrop blur, not behind it.

     `pointer-events: auto` is required: when an AppModal is open,
     Reka's DismissableLayer sets `body { pointer-events: none }` to
     enforce modality and only re-enables it on the dialog content.
     The Teleported panel is also in body and inherits `none` — without
     this override, clicks pass through to whatever's behind. */
  position: fixed; top: 56px; right: 16px; bottom: 32px; z-index: 120;
  pointer-events: auto;
  width: min(420px, calc(100vw - 32px));
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-window, 0 0 0 1px rgba(20, 22, 24, 0.08), 0 30px 80px -20px rgba(20, 22, 24, 0.35));
  display: flex; flex-direction: column;
  padding: 16px 18px 4px;
  gap: 12px;
  overflow: hidden;
}
.aip-slide-enter-active, .aip-slide-leave-active {
  transition: transform .22s cubic-bezier(.4, .0, .2, 1), opacity .22s;
}
.aip-slide-enter-from, .aip-slide-leave-to {
  transform: translateX(110%); opacity: 0;
}

.aip-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-shrink: 0; }
.aip-head h2 { font-family: var(--font-display, inherit); font-size: 18px; font-weight: 600; margin: 3px 0 0; }
.aip-eyebrow {
  font-size: 10.5px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted);
}

.aip-section { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.aip-section + .aip-section {
  border-top: 1px solid var(--border-soft);
  padding-top: 12px;
  margin-top: 4px;
}
.aip-section-h {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--font-mono, monospace);
  font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--muted);
  font-weight: 600;
}
.aip-section-count {
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
  font-weight: 500;
}
.aip-section-spacer { flex: 1; }
.aip-empty {
  font-size: 12.5px; color: var(--muted); font-style: italic;
  padding: 12px 14px;
  background: var(--surface-2);
  border-radius: 8px;
}
.aip-empty.aip-empty-small { padding: 8px 12px; font-size: 11.5px; }

/* Running task card */
.aip-task {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--accent-line);
  border-radius: 9px;
  background: var(--accent-soft);
}
.aip-task-h { display: flex; align-items: center; gap: 8px; }
.aip-task-label { font-weight: 600; font-size: 13px; color: var(--accent-ink); }
.aip-task-feature {
  font-family: var(--font-mono, monospace); font-size: 10px;
  color: var(--muted); letter-spacing: 0.05em;
}
.aip-task-spacer { flex: 1; }

.aip-task-stats {
  display: flex; flex-wrap: wrap; gap: 6px 10px;
  font-family: var(--font-mono, monospace); font-size: 10.5px;
  color: var(--accent-ink); opacity: 0.92;
  font-variant-numeric: tabular-nums;
}
.aip-stat { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.aip-stat-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--muted);
}
.aip-stat[data-phase="connecting"] .aip-stat-dot { background: var(--info-ink, #2563eb); animation: aip-blink 1.2s ease-in-out infinite; }
.aip-stat[data-phase="streaming"]  .aip-stat-dot { background: var(--success-ink, #15803d); }
.aip-stat[data-fresh="fresh"]      .aip-stat-dot { background: var(--success-ink, #15803d); }
.aip-stat[data-fresh="stalling"]   .aip-stat-dot { background: var(--gold, #d97706); animation: aip-blink 1.2s ease-in-out infinite; }
.aip-stat[data-fresh="stuck"]      .aip-stat-dot { background: var(--danger-ink, #b91c1c); animation: aip-blink 1.2s ease-in-out infinite; }
.aip-stat[data-fresh="stalling"]   { color: var(--gold, #d97706); }
.aip-stat[data-fresh="stuck"]      { color: var(--danger-ink, #b91c1c); }
@keyframes aip-blink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}

.aip-task-preview-row { display: flex; flex-direction: column; gap: 6px; }
.aip-chars-note { color: var(--muted); font-size: 10.5px; margin-left: 4px; }
.aip-preview {
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  max-height: 180px;
  overflow: auto;
  padding: 8px 10px;
}
.aip-preview pre {
  margin: 0;
  font-family: var(--font-serif, Georgia, serif);
  font-size: 12px; line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--ink-2);
}

.aip-task-foot {
  font-family: var(--font-mono, monospace); font-size: 9.5px;
  color: var(--muted); letter-spacing: 0.05em;
}
.aip-task-foot code {
  font-family: var(--font-mono, monospace); font-size: 9.5px;
  background: transparent;
  color: var(--muted);
}

/* History row (also the lingering-row shape — same grid, plus an actions column) */
.aip-hist-row {
  display: grid; grid-template-columns: 20px 1fr auto;
  gap: 8px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--border-soft);
}
.aip-hist-actions { display: flex; align-items: flex-start; gap: 2px; }
.aip-hist-row:last-child { border-bottom: 0; }
.aip-hist-icon {
  display: grid; place-items: center;
  width: 20px; height: 20px;
  border-radius: 50%;
  color: var(--surface);
  flex-shrink: 0;
  margin-top: 1px;
}
.aip-hist-row[data-status="done"]      .aip-hist-icon { background: var(--success-ink, #15803d); }
.aip-hist-row[data-status="cancelled"] .aip-hist-icon { background: var(--muted); }
.aip-hist-row[data-status="error"]     .aip-hist-icon { background: var(--danger-ink, #b91c1c); }
.aip-hist-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.aip-hist-line { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.aip-hist-label { font-size: 12.5px; font-weight: 500; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aip-hist-ago {
  font-family: var(--font-mono, monospace); font-size: 10px;
  color: var(--muted); white-space: nowrap;
}
.aip-hist-meta {
  font-family: var(--font-mono, monospace); font-size: 10px;
  color: var(--muted); font-variant-numeric: tabular-nums;
  display: flex; gap: 4px; flex-wrap: wrap;
}
.aip-hist-meta code { font-family: var(--font-mono, monospace); color: var(--muted); background: transparent; }
.aip-hist-error { font-size: 11px; color: var(--danger-ink, #b91c1c); margin-top: 2px; }
</style>
