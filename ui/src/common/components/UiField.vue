<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared labelled form row. Two layouts:
//   inline (default) — 160px label / 1fr control
//   block            — uppercase eyebrow label above the control
// The `label` slot lets callers put a pill/button beside the label text;
// falls back to the `label` prop. Styles are global (.ui-field* in
// common/styles.css) so raw .ui-field markup works alongside this component.
// Supersedes JvField.
defineProps({
  label: { type: String, default: "" },
  hint: { type: String, default: "" },
  layout: { type: String, default: "inline" }, // inline | block
  for: { type: String, default: undefined },
});
</script>

<template>
  <div class="ui-field" :class="layout === 'block' ? 'ui-field--block' : ''">
    <label v-if="$slots.label || label" :for="$attrs.for ?? undefined">
      <slot name="label">{{ label }}</slot>
    </label>
    <div>
      <slot />
      <span v-if="hint" class="ui-field__hint">{{ hint }}</span>
    </div>
  </div>
</template>
