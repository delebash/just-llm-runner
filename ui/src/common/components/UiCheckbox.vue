<script setup>
// SPDX-License-Identifier: MIT
// Shared binary checkbox — a box that tints with the accent, its label beside it. Supersedes
// JwCheckbox/JvCheckbox/UiCheckbox.
//
// Quasar's QCheckbox underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md); the look is the kit's theme
// (../../quasar/theme.css, "Checkbox"), the tick the kit's own path. It answers a click and
// Space and leaves the tab order when disabled, as the native checkbox did; Enter is stopped
// before QCheckbox sees it (a native checkbox doesn't toggle on Enter). It always has a name, so
// QCheckbox renders its hidden native input: a <label> round the checkbox and other text
// (JustWrite's Relations legend) clicks that input, and the click reaches QCheckbox — as a label
// clicked the native checkbox before; a caller's `name` is the form field's. `change` still
// carries the event.
import { QCheckbox } from "quasar";
import { computed } from "vue";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: "" },
  name: { type: String, default: undefined },
  id: { type: String, default: undefined },
});
const emit = defineEmits(["update:modelValue", "change"]);

// The kit's tick (16 × 16, a 2px round stroke) and, unchecked, an SVG that draws nothing (the old
// box always held its tick SVG, transparent when unchecked — the SVG sets the box's baseline), in
// Quasar's SVG-icon form "path@@style|viewBox" — a name that doesn't start with a path command is
// read as a font ligature.
const TICK = "M3 8.5l3 3 7-7@@fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round|0 0 16 16";
const NONE = "M0 0@@fill:none;stroke:none|0 0 16 16";

const classes = computed(() => [
  "ui-checkbox",
  { "is-checked": props.modelValue, "is-disabled": props.disabled },
]);
function onUpdate(value, e) {
  emit("update:modelValue", value);
  emit("change", e);
}
function blockEnter(e) {
  if (e.key === "Enter") e.stopImmediatePropagation();
}
</script>

<template>
  <QCheckbox
    :model-value="modelValue"
    :disable="disabled"
    :name="name || 'ui-checkbox'"
    :id="id"
    :checked-icon="TICK"
    :unchecked-icon="NONE"
    :class="classes"
    @update:model-value="onUpdate"
    @keyup.capture="blockEnter"
  >
    <template v-if="label || $slots.default" #default><slot>{{ label }}</slot></template>
  </QCheckbox>
</template>
