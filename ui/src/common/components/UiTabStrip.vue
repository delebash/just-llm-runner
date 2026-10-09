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
// Quasar's QTabs + QTab underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md): QTabs is the strip (.ui-tabstrip), each QTab
// a tab (.ui-tabstrip__tab, `.on` when chosen), and the look is the kit's theme
// (../../quasar/theme.css, "Tab strip"). Quasar's tab pattern comes with it: role="tablist" and
// "tab" with aria-selected, and one tab stop with arrow keys / Home / End between the tabs (a tab
// is a focusable <div> now, with the kit buttons' focus ring). A strip
// too narrow for its tabs still wraps them onto more rows (the theme keeps Quasar's sideways
// scrolling off). The panels live in the consumer, so there is no tabpanel wiring.
import { QTab, QTabs } from "quasar";

defineProps({
  // [{ id, label }] — the same shape SettingsShell has always taken.
  tabs: { type: Array, default: () => [] },
  modelValue: { type: String, default: "" },
  ariaLabel: { type: String, default: undefined },
});
const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <QTabs
    class="ui-tabstrip"
    :model-value="modelValue"
    align="left"
    breakpoint="0"
    no-caps
    :aria-label="ariaLabel"
    @update:model-value="(id) => emit('update:modelValue', id)"
  >
    <QTab
      v-for="t in tabs" :key="t.id" :name="t.id" :label="t.label" :ripple="false"
      class="ui-tabstrip__tab" :class="{ on: t.id === modelValue }"
    />
  </QTabs>
</template>
