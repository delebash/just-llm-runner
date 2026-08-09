<script setup>
// SPDX-License-Identifier: MIT
// Slim inline progress strip for a single in-flight AI task. Reads from
// the global aiTasks store and renders elapsed, first-token latency,
// tokens, tokens/s, stall freshness, plus Cancel and Details (opens the
// header panel).
//
// Every AI surface in a host app (critique modal, brainstorm, plot-hole
// scan, RAG chat, …) uses this same component for in-modal/in-view
// progress so bug fixes apply everywhere at once.
// Pass `task` = the task object from `aiTasks.runningTasks`. The strip
// renders nothing when `task` is null (the typical "not running" case).
//
// Slots:
//   #extra-stats — optional. Lets a caller append feature-specific
//     metrics next to the standard ones (e.g. a word count or a
//     prompt-vs-completion usage breakdown). The slot receives
//     `{ task }` so child elements can render against the current task
//     without re-querying the store. Slot content should render
//     `<span class="sts-stat">…</span>` chips to match the standard
//     stats' look.

import { computed } from "vue";
import { useAiTasksStore } from "../stores/aiTasks.js";
import Icon from "../common/components/Icon.vue";
import UiButton from "../common/components/UiButton.vue";
import { fmtTokens, fmtTps } from "../common/services/runStats.js";
import { freshnessOf } from "../common/services/streamFreshness.js";

const props = defineProps({
  // The task to display, or null to hide the strip. Read it from
  // `aiTasks.runningTasks` for the classic behaviour (vanishes on finish), or from
  // `aiTasks.visibleTasks` if the host started the task with `lingerMs` and wants the
  // result to stay readable for its dwell.
  task: { type: Object, default: null },
});

const tasks = useAiTasksStore();

// A FINISHED task measures to its own finishedAt, never the live clock. The ticker
// stops when nothing is RUNNING, so a task lingering after completion would otherwise
// freeze its elapsed up to 500 ms short of the truth.
const endedAt = computed(() => props.task?.finishedAt || tasks.now);
const isDone = computed(() => {
  const s = props.task?.status;
  return !!s && s !== "connecting" && s !== "streaming";
});
const canRetry = computed(() => isDone.value && !!props.task?._onRetry);

// The finished-state layer (lifted from JustVoice's fork, 2026-08-07): a lingering
// task must LOOK finished — before this, a completed task kept the spinning sparkle
// and a failed one showed no error and no colour, which defeated the entire point of
// letting failures stay on screen until read.
const STATUS = {
  done:      { badge: "✓", label: "done",      cls: "sts--ok" },
  error:     { badge: "⚠", label: "failed",    cls: "sts--fail" },
  cancelled: { badge: "⊘", label: "cancelled", cls: "sts--cancel" },
};
const status = computed(() => (props.task ? STATUS[props.task.status] || null : null));

// Determinate progress bar from the batch counter — `{done, total}` carries its own
// unit, which is WHY it's the contract here: JustVoice's `percent` field had one
// writer storing a 0–1 fraction and three readers rendering `percent + '%'`, so its
// bar topped out at 1% and nobody noticed. No unit, no unit bug.
const progressPct = computed(() => {
  const p = props.task?.progress;
  if (!p || !p.total) return null;
  return Math.min(100, Math.max(0, (p.done / p.total) * 100));
});

const elapsedSeconds = computed(() => {
  if (!props.task) return "0.0";
  return Math.max(0, (endedAt.value - props.task.startedAt) / 1000).toFixed(1);
});
const firstTokenSeconds = computed(() => {
  if (!props.task?.firstDeltaAt) return null;
  return ((props.task.firstDeltaAt - props.task.startedAt) / 1000).toFixed(1);
});
const tokensLabel = computed(() => {
  if (!props.task) return null;
  if (props.task.tokensOut) return fmtTokens({ outputTokens: props.task.tokensOut });
  if (props.task.chars)     return `~${fmtTokens({ outputTokens: Math.round(props.task.chars / 4) })}`;
  return null;
});
const tokensPerSecond = computed(() => {
  if (!props.task?.firstDeltaAt) return null;
  const tokens = props.task.tokensOut || Math.max(0, Math.round(props.task.chars / 4));
  if (!tokens) return null;
  const span = Math.max(1, endedAt.value - props.task.firstDeltaAt);
  return (tokens / (span / 1000)).toFixed(1);
});
// #5 (2026-07-17): rate-relative — the shared classifier, not the old absolute 3s/10s
// that mislabelled a slow local model as "stalling" through healthy work.
const freshness = computed(() => freshnessOf(props.task, tasks.now));

function onCancel() {
  if (props.task) tasks.cancel(props.task.id);
}
function onRetry() {
  if (props.task) tasks.retry(props.task.id);
}
function onDismiss() {
  if (props.task) tasks.dismiss(props.task.id);
}
function openPanel() { tasks.openPanel(); }
</script>

<template>
  <div v-if="task" class="sts" :class="status?.cls" :data-status="task.status">
    <!-- Spinner only while it RUNS — a lingering finished task showing an
         in-progress animation is a lie. -->
    <Icon v-if="!isDone" name="Sparkle" :size="13" class="sts-spin" />
    <span v-else class="sts-badge">{{ status?.badge }}</span>
    <span class="sts-label">{{ task.label }}</span>

    <!-- QC-31: a batch task (one entry per USER ACTION) reports n/m here. -->
    <span v-if="task.progress" class="sts-stat sts-progress"
      v-tooltip.bottom="'Batch progress — Cancel stops the whole run'">
      {{ task.progress.text || `${task.progress.done}/${task.progress.total}` }}
    </span>
    <!-- …and as a real bar while running. -->
    <span v-if="progressPct != null && !isDone" class="sts-track">
      <span class="sts-fill" :style="{ width: progressPct + '%' }" />
    </span>
    <!-- §7.4 B6-2: real prompt-eval progress (builtin engine) — fills the
         dead time before the first token; cleared when generation starts. -->
    <span v-if="task.prefill != null" class="sts-stat"
      v-tooltip.bottom="'The model is reading your prompt'">
      reading prompt {{ Math.round(task.prefill * 100) }}%
    </span>
    <span class="sts-stat">{{ elapsedSeconds }}s</span>
    <span v-if="firstTokenSeconds" class="sts-stat">first token in {{ firstTokenSeconds }}s</span>
    <span v-if="tokensLabel" class="sts-stat">{{ tokensLabel }}</span>
    <span v-if="tokensPerSecond" class="sts-stat">{{ fmtTps(tokensPerSecond) }}</span>
    <span v-if="freshness" class="sts-stat" :data-fresh="freshness">
      <span class="sts-dot" />
      <template v-if="freshness === 'fresh'">live</template>
      <template v-else-if="freshness === 'stalling'">stalling</template>
      <template v-else>stuck</template>
    </span>

    <!-- The app's OWN numbers, as plain strings it pushed with setStats — a render's
         "3.2 KB · 1.4s audio", a batch's "12 / 47 lines". Data rather than a callback
         so it survives the component that started the task, and unlike the slot below
         it reaches the panel too. -->
    <span v-for="(s, i) in (task.stats || [])" :key="i" class="sts-stat">{{ s }}</span>

    <!-- Outcome, once there is one: the word + (for failures) the reason. The error
         must be READABLE here — a failure lingers until dismissed precisely so the
         user can read it. -->
    <span v-if="isDone" class="sts-finish-tag">{{ status?.label }}</span>
    <span v-if="task.error" class="sts-error" :title="task.error">— {{ task.error }}</span>

    <!-- Feature-specific extras (e.g. a words count + usage breakdown). -->
    <slot name="extra-stats" :task="task" />

    <span class="sts-spacer" />
    <UiButton intent="ghost" size="small" data-panel-toggle @click="openPanel" v-tooltip.bottom="'Open full status panel'">
      Details
    </UiButton>
    <!-- Cancel while it runs; Retry / dismiss once it has stopped. A strip only shows
         a finished task when the host asked for a linger (`lingerMs`), and offering
         "Cancel" on something already done would be a lie. Retry appears only when the
         caller supplied one — "every long-running op gets progress + cancel + retry",
         JustVoice's rule, which this store had no answer for until now. -->
    <UiButton v-if="!isDone" intent="danger" size="small" @click="onCancel">
      <template #icon><Icon name="Close" :size="11" /></template>
      Cancel
    </UiButton>
    <template v-else>
      <UiButton v-if="canRetry" intent="ghost" size="small" @click="onRetry"
        v-tooltip.bottom="'Run it again'">
        <template #icon><Icon name="Refresh" :size="11" /></template>
        Retry
      </UiButton>
      <UiButton intent="ghost" size="icon" @click="onDismiss" v-tooltip.bottom="'Dismiss'">
        <template #icon><Icon name="Close" :size="11" /></template>
      </UiButton>
    </template>
  </div>
</template>

<!-- Not `scoped` — the #extra-stats slot lets call sites render
     `<span class="sts-stat">…</span>` chips that need to inherit the
     same chip look as the standard stats. Scoped styles wouldn't
     reach slot content from the parent component. The `sts-*` class
     names are unique to this file so global leakage isn't an issue. -->
<style>
.sts {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 7px 12px;
  border: 1px solid var(--accent-line);
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
  margin: 4px 0 12px;
}
.sts-label { font-weight: 600; }
.sts-stat {
  font-family: var(--font-mono, monospace); font-size: 10.5px;
  color: var(--accent-ink);
  opacity: 0.85;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  display: inline-flex; align-items: center; gap: 4px;
}
.sts-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--success-ink, #15803d);
}
.sts-stat[data-fresh="stalling"] .sts-dot { background: var(--gold, #d97706); animation: sts-blink 1.2s ease-in-out infinite; }
.sts-stat[data-fresh="stuck"]    .sts-dot { background: var(--danger-ink, #b91c1c); animation: sts-blink 1.2s ease-in-out infinite; }
.sts-stat[data-fresh="stalling"] { color: var(--gold, #d97706); opacity: 1; }
.sts-stat[data-fresh="stuck"]    { color: var(--danger-ink, #b91c1c); opacity: 1; }
@keyframes sts-blink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}
.sts-spacer { flex: 1; min-width: 4px; }
.sts-spin { animation: sts-spin 1.2s linear infinite; }
@keyframes sts-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* Finished states (JustVoice's layer): the container recolours by outcome, the
   spinner yields to a badge, the outcome is named, a failure shows its reason. */
.sts--fail {
  border-color: var(--danger-line, var(--danger, #b91c1c));
  background: var(--danger-bg, #fef2f2);
  color: var(--danger-ink, #b91c1c);
}
.sts--cancel {
  border-color: var(--line-strong, var(--border, #d4d4d8));
  background: var(--surface-2, #f4f4f5);
  color: var(--ink-2, #52525b);
}
.sts--fail .sts-stat, .sts--cancel .sts-stat { color: inherit; }
.sts-badge {
  display: inline-grid; place-items: center;
  width: 17px; height: 17px; border-radius: 50%;
  font-size: 10.5px; font-weight: 700; color: #fff; flex-shrink: 0;
  background: var(--accent);
}
.sts--fail   .sts-badge { background: var(--danger-ink, #b91c1c); }
.sts--cancel .sts-badge { background: var(--ink-3, #71717a); }
.sts-finish-tag {
  font-family: var(--font-mono, monospace);
  font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.sts-error {
  font-size: 11px; font-style: italic;
  max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Determinate batch progress ({done,total} — the counter carries its own unit). */
.sts-track {
  width: 140px; height: 4px; border-radius: 99px; overflow: hidden;
  background: var(--surface, #fff);
  border: 1px solid var(--accent-line);
  display: inline-block;
}
.sts-fill {
  display: block; height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}

/* Tint the inline ghost "Details" button so it sits in the accent strip.
   (Targets the kit .ui-btn family — the pre-convergence .jw-btn selector
   this rule once used had gone dead, silently dropping the tint.) */
.sts .ui-btn--ghost { color: var(--accent-ink); }
.sts .ui-btn--ghost:not(:disabled):not(.is-disabled):hover {
  background: color-mix(in oklab, var(--accent) 18%, transparent);
}
</style>
