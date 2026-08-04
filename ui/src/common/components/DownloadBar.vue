<script setup>
// SPDX-License-Identifier: MIT
// THE one download bar (2026-07-15, the ONE-DOWNLOADER consolidation; single control confirmed
// 2026-07-21 — user: "use same control, same, no matter size in grid — same same same"). Renders
// a reactive download task (createDownloadTask, or any object with the same shape) as ONE control
// — the header carries the state action (Cancel-while-running / Retry+Dismiss-on-cancelled|error /
// "Ready ✓") and the shared UiProgress carries % · size · speed · ETA (from the task's `label`).
// This is THE control the user asked to reuse across EVERY download/load surface (engine · model ·
// embed · QuickSetup · boot · the catalog rows) — ONE component, ONE look, sized by its container;
// there is deliberately NO compact/variant fork (that was the "why does every download look
// different" complaint).
import UiButton from "./UiButton.vue";
import UiProgress from "./UiProgress.vue";
import { familyLabels } from "../services/familyLabels.js";

// Canon words via the ONE reactive store — capturing the group ref is safe: the
// door deep-assigns in place (the invariant in familyLabels.js), so a host's
// locale re-feed reaches this mounted bar live.
const L = familyLabels.downloadBar;

defineProps({
  title: { type: String, default: "" },
  role: { type: String, default: "" },
  // A createDownloadTask instance (or any object with the same shape:
  // { state, done, total, label, error, cancel(), retry(), dismiss() }).
  task: { type: Object, required: true },
});
</script>

<template>
  <div class="lu-dlbar">
    <!-- A titled header row whose right side is the state action. -->
    <div class="lu-dlbar-h">
      <b class="lu-dlbar-title">{{ title }}</b>
      <span v-if="role" class="lu-muted lu-dlbar-role">{{ role }}</span>
      <span class="lu-dlbar-spacer" />
      <UiButton v-if="task.state === 'running' && task.cancel" intent="secondary" size="small" @click="task.cancel()">{{ L.cancel }}</UiButton>
      <!-- Retry stays DISABLED while the cancel is still finalizing (the model is tearing down) —
           clicking it mid-teardown re-races the load. It enables once the teardown completes. -->
      <UiButton v-else-if="task.state === 'cancelled' || task.state === 'error'" intent="secondary" size="small" :disabled="task.finalizing" @click="task.retry()">{{ L.retry }}</UiButton>
      <!-- …and a way OUT of a terminal state. Without this a failed download was permanent:
           Retry was the only action, and the server kept the errored row so the bar came
           back on every poll (user, 2026-07-24: "no way to cancel"). -->
      <UiButton v-if="(task.state === 'cancelled' || task.state === 'error') && task.dismiss" intent="ghost" size="small" :disabled="task.finalizing" @click="task.dismiss()">{{ L.dismiss }}</UiButton>
      <span v-else-if="task.state === 'done'" class="lu-dlbar-ok">{{ L.ready }}</span>
    </div>

    <UiProgress :value="task.done" :max="task.total" :label="task.label" />

    <p v-if="task.error" class="lu-error lu-dlbar-err">{{ task.error }}</p>
  </div>
</template>

<style scoped>
.lu-dlbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-2);
}
.lu-dlbar-h { display: flex; align-items: center; gap: 9px; }
.lu-dlbar-title { font-size: 12.5px; }
.lu-dlbar-role { font-size: 11px; }
.lu-dlbar-spacer { flex: 1; }
.lu-dlbar-ok {
  font-size: 11px; font-weight: 800; letter-spacing: .04em;
  text-transform: uppercase; color: var(--success, #3a7d63);
}
.lu-dlbar-err { font-size: 11.5px; }
</style>
