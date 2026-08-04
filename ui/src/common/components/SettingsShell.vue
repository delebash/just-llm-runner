<script setup>
// SPDX-License-Identifier: MIT
// Shared Settings chrome — the family shape (contract 2026-08-04): a horizontal tab
// strip on top + full-width content, LIFTED from JustWrite's SettingsView (its own
// comment: "matches JV's settings"). Born from the consistency sweep: one consumer
// had invented a left vertical rail for the same page. Sections are DATA
// ({ id, label }); each app brings its own set and renders the active panel in the
// default slot. v-model carries the active section id, so route-synced hosts keep
// their own navigation logic.
defineProps({
  sections: { type: Array, default: () => [] }, // [{ id, label }]
  modelValue: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <div class="set-shell">
    <nav class="set-tabs">
      <button
        v-for="s in sections" :key="s.id" type="button"
        class="set-tab" :class="{ on: s.id === modelValue }"
        @click="emit('update:modelValue', s.id)"
      >{{ s.label }}</button>
    </nav>
    <div class="set-panel"><slot /></div>
  </div>
</template>

<style scoped>
/* JW's values, verbatim (SettingsView.vue scoped CSS) — one look, every app. */
.set-shell { display: flex; flex-direction: column; gap: 18px; height: 100%; min-height: 0; }
.set-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.set-tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 10px 16px; font: inherit; font-size: 13px; font-weight: 600; color: var(--ink-2); cursor: pointer; }
.set-tab:hover { color: var(--ink); }
.set-tab.on { color: var(--ink); border-bottom-color: var(--accent); }
.set-panel { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }
</style>
