<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared button for ALL apps — one `intent` prop encodes role + visual style
// (no separate severity/outlined/text booleans). Visual rules live in
// common/styles.css (.ui-btn*), driven by the host's design tokens (with safe
// fallbacks), so it renders correctly in any app. Supersedes the per-app
// JwButton / JvButton / LuButton. `as` lets it render as <button|label|a>
// (file-picker labels, links); `loading` swaps the icon for a spinner.
import { computed, useSlots } from "vue";

const props = defineProps({
  // primary|secondary|ghost|danger|danger-outline|success|info|accent2
  intent: { type: String, default: "primary" },
  size: { type: String, default: "regular" },    // small|regular|lg|icon
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  as: { type: String, default: "button" },       // button|label|a
  label: { type: String, default: "" },
  type: { type: String, default: "button" },     // for a real <button>
});
const slots = useSlots();
const isButton = computed(() => props.as === "button");
const classes = computed(() => [
  "ui-btn",
  `ui-btn--${props.intent}`,
  // every non-default size gets a modifier (small | lg | icon)
  props.size !== "regular" && `ui-btn--${props.size}`,
  { "is-loading": props.loading, "is-disabled": props.disabled || props.loading },
]);
</script>

<template>
  <component
    :is="as"
    :class="classes"
    :type="isButton ? type : undefined"
    :disabled="isButton ? (disabled || loading) : undefined"
    :aria-disabled="!isButton && (disabled || loading) ? 'true' : undefined"
    :aria-busy="loading ? 'true' : undefined"
  >
    <span v-if="loading" class="ui-btn-spinner" aria-hidden="true" />
    <slot v-else name="icon" />
    <span v-if="label || slots.default" class="ui-btn-label"><slot>{{ label }}</slot></span>
  </component>
</template>
