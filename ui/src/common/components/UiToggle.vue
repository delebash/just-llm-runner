<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared switch-style boolean — visually distinct from a checkbox (use for
// standalone on/off settings; use UiCheckbox for row/multi-select booleans).
// Self-contained: scoped styles driven by the host's design tokens (safe
// fallbacks). Supersedes JvToggle.
//   v-model="on"  :disabled  :aria-label
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  id: { type: String, default: undefined },
  ariaLabel: { type: String, default: undefined },
});
const emit = defineEmits(["update:modelValue", "change"]);

function flip() {
  if (props.disabled) return;
  const next = !props.modelValue;
  emit("update:modelValue", next);
  emit("change", next);
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :id="id"
    :aria-checked="modelValue ? 'true' : 'false'"
    :aria-label="ariaLabel"
    :disabled="disabled"
    class="ui-toggle"
    :class="{ 'ui-toggle--on': modelValue, 'ui-toggle--disabled': disabled }"
    @click="flip"
  >
    <span class="ui-toggle__thumb" />
  </button>
</template>

<style scoped>
.ui-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 38px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  flex-shrink: 0;
}
.ui-toggle:hover:not(.ui-toggle--disabled) { border-color: var(--border-strong, var(--border)); }
.ui-toggle__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), background 0.15s ease;
}
.ui-toggle--on { background: var(--accent); border-color: var(--accent); }
.ui-toggle--on:hover:not(.ui-toggle--disabled) {
  background: color-mix(in oklab, var(--accent) 88%, black);
  border-color: color-mix(in oklab, var(--accent) 88%, black);
}
.ui-toggle--on .ui-toggle__thumb { transform: translateX(16px); background: #fff; }
.ui-toggle--disabled { opacity: 0.5; cursor: not-allowed; }
.ui-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
