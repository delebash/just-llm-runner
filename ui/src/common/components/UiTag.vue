<script setup>
// SPDX-License-Identifier: MIT
// Shared tag chip — same single-intent API as UiButton. Renders as <span> so it
// composes inline. Visual rules in common/styles.css (.ui-tag*). Supersedes
// JwTag/JvTag. `removable` adds the ✕ affordance (born for the i18n app's
// glossary terms, 2026-08-03 — new capabilities land in the KIT, never an app).
import { computed } from "vue";

const props = defineProps({
  intent: { type: String, default: "primary" }, // primary | secondary | success | info | accent2 | danger
  value: { type: [String, Number], default: "" },
  removable: { type: Boolean, default: false },
});
const emit = defineEmits(["remove"]);
const classes = computed(() => ["ui-tag", `ui-tag--${props.intent}`]);
</script>

<template>
  <span :class="classes">
    <slot name="icon" />
    <slot>{{ value }}</slot>
    <button
      v-if="removable" type="button" class="ui-tag__x"
      :aria-label="`Remove ${value || 'tag'}`" @click.stop="emit('remove')"
    >✕</button>
  </span>
</template>
