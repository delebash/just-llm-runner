<script setup>
// SPDX-License-Identifier: MIT
// Shared eyebrow + H1 pane header — LIFTED from JustWrite's components/PaneHeader.vue
// (2026-08-04, the consistency sweep: both apps had invented their own page-header
// shape because the kit had none). When `helpKey` is set, the "?" affordance
// (HelpTrigger) pins to the far right — always rightmost, regardless of action
// buttons in the default slot. Styles ride along scoped, token-driven, so a consumer
// needs no global CSS (JW's original global .pane-* rules carry identical values).
import HelpTrigger from "./HelpTrigger.vue";

defineProps({
  eyebrow: { type: String, default: "" },
  title: { type: String, default: "" },
  helpKey: { type: String, default: "" },
});
</script>

<template>
  <header class="pane-header">
    <div class="pane-title">
      <span v-if="eyebrow" class="pane-eyebrow">{{ eyebrow }}</span>
      <h1 class="pane-h1">{{ title }}</h1>
    </div>
    <div class="pane-actions" v-if="$slots.default">
      <slot />
    </div>
    <HelpTrigger v-if="helpKey" :slug="helpKey" :label="title" class="pane-help" />
  </header>
</template>

<style scoped>
.pane-header {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 22px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.pane-title {
  display: flex; flex-direction: column;
  flex: 1; min-width: 0;
}
.pane-eyebrow {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--muted);
}
.pane-h1 {
  font-size: 20px; font-weight: 600; letter-spacing: -0.015em;
  margin: 0;
}
.pane-actions { display: flex; gap: 6px; align-items: center; }
</style>
