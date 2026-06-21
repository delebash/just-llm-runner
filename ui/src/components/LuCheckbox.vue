<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared binary checkbox — custom box that tints with the accent. Visual rules
// in styles.css (.lu-checkbox*).
import { computed } from "vue";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue", "change"]);

const classes = computed(() => [
  "lu-checkbox",
  { "is-checked": props.modelValue, "is-disabled": props.disabled },
]);
function onChange(e) {
  emit("update:modelValue", e.target.checked);
  emit("change", e);
}
</script>

<template>
  <label :class="classes">
    <input type="checkbox" class="lu-checkbox-input" :checked="modelValue" :disabled="disabled" @change="onChange" />
    <span class="lu-checkbox-box" aria-hidden="true">
      <svg class="lu-checkbox-tick" viewBox="0 0 16 16" fill="none">
        <path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
    <span v-if="label || $slots.default" class="lu-checkbox-label"><slot>{{ label }}</slot></span>
  </label>
</template>
