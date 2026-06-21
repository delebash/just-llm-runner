<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared button — one `intent` prop encodes role + visual style (like JwButton/
// JvButton). Visual rules live in the package's styles.css (.lu-btn*), driven by
// the host's design tokens, so it renders native in every app.
import { computed, useSlots } from "vue";

const props = defineProps({
  intent: { type: String, default: "primary" }, // primary | secondary | ghost | danger | success
  size: { type: String, default: "regular" },   // small | regular
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: "button" },
  label: { type: String, default: "" },
});
const slots = useSlots();
const classes = computed(() => [
  "lu-btn",
  `lu-btn--${props.intent}`,
  props.size === "small" && "lu-btn--small",
  { "is-disabled": props.disabled || props.loading },
]);
</script>

<template>
  <button :class="classes" :type="type" :disabled="disabled || loading" :aria-busy="loading ? 'true' : undefined">
    <slot name="icon" />
    <span v-if="label || slots.default" class="lu-btn-label"><slot>{{ label }}</slot></span>
  </button>
</template>
