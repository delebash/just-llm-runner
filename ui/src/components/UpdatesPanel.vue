<script setup>
// SPDX-License-Identifier: MIT
// Shared Updates / Changelog panel — current version + rendered release notes.
// The host passes its version and pre-rendered changelog HTML (the changelog
// source + markdown renderer stay app-side; the presentation is shared). The
// Tauri auto-updater (check/download), where an app has one, can be slotted in
// via #actions later.
defineProps({
  appVersion: { type: String, default: "" },
  changelogHtml: { type: String, default: "" },
});
</script>

<template>
  <div class="lu-updates">
    <div class="lu-updates-head">
      <span class="lu-pcard-title">Updates</span>
      <span class="lu-updates-ver">Current version <b>v{{ appVersion || "—" }}</b></span>
      <span class="lu-updates-spacer" />
      <slot name="actions" />
    </div>
    <div v-if="changelogHtml" class="lu-updates-log" v-html="changelogHtml" />
    <div v-else class="lu-muted lu-updates-empty">No release notes available.</div>
  </div>
</template>

<style scoped>
.lu-updates { display: flex; flex-direction: column; gap: 12px; }
.lu-updates-head { display: flex; align-items: baseline; gap: 12px; }
.lu-updates-ver { font-size: 12.5px; color: var(--ink-2); }
.lu-updates-spacer { flex: 1; }
.lu-updates-empty { font-size: 12.5px; }
.lu-updates-log {
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
  padding: 14px 18px; max-height: 520px; overflow: auto; font-size: 13px; line-height: 1.6; color: var(--ink-2);
}
.lu-updates-log :deep(h1), .lu-updates-log :deep(h2), .lu-updates-log :deep(h3) {
  color: var(--ink); margin: 14px 0 6px; font-size: 14px;
}
.lu-updates-log :deep(h1:first-child), .lu-updates-log :deep(h2:first-child) { margin-top: 0; }
.lu-updates-log :deep(ul) { margin: 6px 0; padding-left: 20px; }
.lu-updates-log :deep(li) { margin: 3px 0; }
.lu-updates-log :deep(p) { margin: 6px 0; }
.lu-updates-log :deep(code) { font-family: var(--font-mono, monospace); font-size: 12px; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
</style>
