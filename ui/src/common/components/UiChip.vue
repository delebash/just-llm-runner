<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared selectable chip — a pill-shaped button (or link/span via `as`). Use one
// for an on/off toggle or a status indicator; use a v-for of them for a
// single-select filter group (caller owns the selected logic). For a *connected*
// segmented mode-switch use UiSegmented instead. Visual rules in
// common/styles.css (.ui-chip). Supersedes JustVoice's interactive .jv-pill.
import { computed } from "vue";

const props = defineProps({
  selected: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  as: { type: String, default: "button" }, // button | a | span
  label: { type: String, default: "" },
});
const isButton = computed(() => props.as === "button");
</script>

<template>
  <component
    :is="as"
    class="ui-chip"
    :class="{ 'is-selected': selected, 'is-disabled': disabled }"
    :type="isButton ? 'button' : undefined"
    :disabled="isButton ? disabled : undefined"
    :aria-pressed="isButton ? String(selected) : undefined"
  ><slot>{{ label }}</slot></component>
</template>
