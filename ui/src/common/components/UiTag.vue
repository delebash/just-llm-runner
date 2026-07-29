<script setup>
// SPDX-License-Identifier: MIT
// Shared tag chip — same single-intent API as UiButton. Renders as <span> so it
// composes inline. Visual rules in common/styles.css (.ui-tag*). Supersedes
// JwTag/JvTag.
import { computed } from "vue";

const props = defineProps({
  intent: { type: String, default: "primary" }, // primary | secondary | success | info | accent2 | danger
  value: { type: [String, Number], default: "" },
});
const classes = computed(() => ["ui-tag", `ui-tag--${props.intent}`]);
</script>

<template>
  <span :class="classes">
    <slot name="icon" />
    <slot>{{ value }}</slot>
  </span>
</template>
