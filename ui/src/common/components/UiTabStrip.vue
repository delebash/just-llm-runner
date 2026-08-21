<!-- SPDX-License-Identifier: MIT -->
<script setup>
// THE horizontal tab strip — an underlined row of tabs that switches which
// panel a view is showing.
//
// Extracted from SettingsShell 2026-08-21, which is now its first consumer.
// SettingsShell is a strip PLUS a content panel with its own scroller, and a
// view that only wants the strip could not take it: JustVoice's Voices and Labs
// pages are `jv-fill` views that already own their scroll chain, and adopting
// the shell to get its top third would have given them a second scroller —
// against that app's one-scroller-per-area rule. So they each hand-rolled the
// same strip instead (`.jv-subnav`), which drifted: 12px vs 13px, weight 500 vs
// 600, gap 4 vs 2, padding 8/14 vs 10/16 — and the 12px broke JustVoice's own
// minimum type size. Same recipe underneath, down to the `margin-bottom: -1px`
// that sits a 2px tab underline on the strip's 1px rule.
//
// NOT UiSegmented. That is a segmented RADIO control — `role="radiogroup"`,
// pill buttons, roving tabindex, for picking a value in a form. This navigates
// between panels and looks like it: underlined, flush to a rule.
//
//   <UiTabStrip v-model="active" :tabs="[{ id, label }]" />
//
// Deliberately plain <button>s in a <nav> with `aria-current`, not the full
// WAI-ARIA tab pattern: that needs role="tab"/"tabpanel"/aria-controls wired to
// the panels, which live in the consumer. Half of it would be worse than none.
// Arrow-key navigation is a fair follow-up (the kit has useRovingTabindex).
defineProps({
  // [{ id, label }] — the same shape SettingsShell has always taken.
  tabs: { type: Array, default: () => [] },
  modelValue: { type: String, default: "" },
  ariaLabel: { type: String, default: undefined },
});
const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <nav class="ui-tabstrip" :aria-label="ariaLabel">
    <button
      v-for="t in tabs" :key="t.id" type="button"
      class="ui-tabstrip__tab" :class="{ on: t.id === modelValue }"
      :aria-current="t.id === modelValue ? 'page' : undefined"
      @click="emit('update:modelValue', t.id)"
    >{{ t.label }}</button>
  </nav>
</template>

<style scoped>
/* JustWrite's Settings values, verbatim — one look, every app, every strip. */
.ui-tabstrip {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.ui-tabstrip__tab {
  appearance: none;
  background: none;
  border: 0;
  /* The 2px underline sits ON the strip's 1px rule, not under it. */
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: 10px 16px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
  cursor: pointer;
}
.ui-tabstrip__tab:hover { color: var(--ink); }
.ui-tabstrip__tab.on { color: var(--ink); border-bottom-color: var(--accent); }
</style>
