<script setup>
// SPDX-License-Identifier: MIT
// Shared selectable chip — a pill you press. Use one for an on/off toggle or a status
// indicator; use a v-for of them for a single-select filter group (caller owns the selected
// logic). For a *connected* segmented mode-switch use UiSegmented instead. Supersedes
// JustVoice's interactive .jv-pill.
//
// Quasar's QChip underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md); the look is the kit's theme
// (../../quasar/theme.css, "Chip"). `selected` stays the kit's class + aria-pressed: QChip's own
// `selected` draws a check icon the family's chip doesn't have. QChip answers a click, Enter and
// Space, and leaves the tab order when disabled. `as`: "button" (default) presses; "a" follows
// the chip's `href` (QChip has no anchor form); "span" is a plain, unpressable pill.
import { QChip } from "quasar";
import { computed, useAttrs } from "vue";

defineOptions({ inheritAttrs: false });
const props = defineProps({
  selected: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  as: { type: String, default: "button" }, // button | a | span
  label: { type: String, default: "" },
});
const attrs = useAttrs();

// The caller's attributes go to the chip, its click handler(s) merged into one (QChip declares
// onClick as a single-function prop) together with the link's navigation.
const chipAttrs = computed(() => {
  const { onClick, ...rest } = attrs;
  const extra = {};
  if (props.as === "a") extra.role = "link";
  if (props.as === "button") extra["aria-pressed"] = String(props.selected);
  return { ...rest, ...extra };
});
function onClick(e) {
  for (const fn of [attrs.onClick].flat()) if (typeof fn === "function") fn(e);
  if (props.as === "a" && attrs.href && !props.disabled) window.location.assign(attrs.href);
}
</script>

<template>
  <QChip
    v-bind="chipAttrs"
    class="ui-chip"
    :class="{ 'is-selected': selected, 'is-disabled': disabled }"
    :clickable="as !== 'span'"
    :disable="disabled"
    :ripple="false"
    @click="onClick"
  ><slot>{{ label }}</slot></QChip>
</template>
