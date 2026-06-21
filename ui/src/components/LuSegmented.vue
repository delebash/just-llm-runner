<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared segmented control (a row of mutually-exclusive buttons) — used for
// "Where it runs" (Local/Online) and "API format" in the provider form. Visual
// rules in styles.css (.lu-seg). v-model holds the selected option's value.
import { computed } from "vue";

const props = defineProps({
  modelValue: { type: [String, Number, Boolean], default: "" },
  // [{ value, label }]
  options: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
});
defineEmits(["update:modelValue"]);
const classes = computed(() => ["lu-seg", { "is-locked": props.disabled }]);
</script>

<template>
  <span :class="classes" role="group">
    <button
      v-for="o in options" :key="String(o.value)"
      type="button"
      :class="{ on: o.value === modelValue }"
      :disabled="disabled"
      @click="!disabled && $emit('update:modelValue', o.value)"
    >{{ o.label }}</button>
  </span>
</template>
