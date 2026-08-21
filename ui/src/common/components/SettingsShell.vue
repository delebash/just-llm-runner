<script setup>
// SPDX-License-Identifier: MIT
// Shared Settings chrome — the family shape (contract 2026-08-04): a horizontal tab
// strip on top + full-width content, LIFTED from JustWrite's SettingsView (its own
// comment: "matches JV's settings"). Born from the consistency sweep: one consumer
// had invented a left vertical rail for the same page. Sections are DATA
// ({ id, label }); each app brings its own set and renders the active panel in the
// default slot. v-model carries the active section id, so route-synced hosts keep
// their own navigation logic.
//
// The strip itself moved out to UiTabStrip 2026-08-21 — this component is now
// "that strip, plus a scrolling panel". A view that wants only the strip takes
// UiTabStrip directly instead of inheriting a second scroller; see that file
// for why two apps had hand-rolled the same strip rather than adopt this one.
// Renders identically: the CSS went with the component, value for value.
import UiTabStrip from "./UiTabStrip.vue";

defineProps({
  sections: { type: Array, default: () => [] }, // [{ id, label }]
  modelValue: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <div class="set-shell">
    <UiTabStrip
      :tabs="sections"
      :model-value="modelValue"
      @update:model-value="(v) => emit('update:modelValue', v)"
    />
    <div class="set-panel"><slot /></div>
  </div>
</template>

<style scoped>
.set-shell { display: flex; flex-direction: column; gap: 18px; height: 100%; min-height: 0; }
.set-panel { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }
</style>
