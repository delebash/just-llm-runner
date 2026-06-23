<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared labelled form row. Two layouts:
//   inline (default) — 160px label / 1fr control
//   block            — uppercase eyebrow label above the control
// The `label` slot lets callers put a pill/button beside the label text;
// falls back to the `label` prop. Self-contained scoped styles (token-driven).
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

<style scoped>
.ui-field {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 14px;
  align-items: center;
  margin: 10px 0;
  font-size: 13px;
}
.ui-field > label { color: var(--ink-2, var(--ink)); font-size: 13px; }
/* block layout — uppercase eyebrow label above the control */
.ui-field--block { display: block; }
.ui-field--block > label {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted, var(--ink-2));
  font-weight: 600;
  margin-bottom: 6px;
}
.ui-field__hint {
  display: block;
  font-size: 11px;
  color: var(--muted, var(--ink-2));
  margin-top: 4px;
}
</style>
