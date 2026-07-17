<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// THE one download bar (2026-07-15, the ONE-DOWNLOADER consolidation). Renders a reactive
// download task (createDownloadTask) as a titled card: a header row (title · muted role ·
// spacer · Cancel-while-running / Retry-on-cancelled|error / "Ready ✓"-on-done) + the shared
// UiProgress + an error line. The single visual control the user asked to reuse across every
// download (engine · model · embed). QuickSetup mounts three of these; the styles moved here
// from QuickSetup's .lu-qs-bar* so there is ONE bar, not a copy per surface.
import UiButton from "./UiButton.vue";
import UiProgress from "./UiProgress.vue";

defineProps({
  title: { type: String, default: "" },
  role: { type: String, default: "" },
  // A createDownloadTask instance (or any object with the same shape:
  // { state, done, total, label, error, cancel(), retry() }).
  task: { type: Object, required: true },
});
</script>

<template>
  <div class="lu-dlbar">
    <div class="lu-dlbar-h">
      <b class="lu-dlbar-title">{{ title }}</b>
      <span v-if="role" class="lu-muted lu-dlbar-role">{{ role }}</span>
      <span class="lu-dlbar-spacer" />
      <!-- Cancel renders only when the task CAN cancel (T3: a "stopping" adapter task
           is running but supplies no cancel — an unload isn't cancellable; without the
           guard the button would render and crash on click). -->
      <UiButton v-if="task.state === 'running' && task.cancel" intent="secondary" size="small" @click="task.cancel()">Cancel</UiButton>
      <UiButton v-else-if="task.state === 'cancelled' || task.state === 'error'" intent="secondary" size="small" @click="task.retry()">Retry</UiButton>
      <span v-else-if="task.state === 'done'" class="lu-dlbar-ok">Ready ✓</span>
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
