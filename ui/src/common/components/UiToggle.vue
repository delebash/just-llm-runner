<script setup>
// SPDX-License-Identifier: MIT
// Shared switch-style boolean — visually distinct from a checkbox (use for
// standalone on/off settings; use UiCheckbox for row/multi-select booleans).
// Supersedes JvToggle.
//   v-model="on"  :disabled  :aria-label
//
// Quasar's QToggle underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md); the look is the kit's theme
// (../../quasar/theme.css, "Switch"). role="switch" with aria-checked, Enter and Space flip it,
// and it leaves the tab order when disabled — as the native button it replaces. `ariaLabel` is
// the switch's aria-label (QToggle's own `label` would also print it). A caller's `label` attribute
// stays off the switch, as it stayed an unshown attribute on the native button (docgen's Server
// settings passes one — found 2026-10-09, its TASKS); every other attribute reaches the switch.
// It always has a name, so QToggle renders its hidden native checkbox: a <label> round the switch
// and its text (the kit's warm-on-startup and Sync rows, docgen's Server settings) clicks that
// input, the click reaches QToggle and flips it — as a label clicked the native button before.
import { QToggle } from "quasar";
import { computed, useAttrs } from "vue";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  id: { type: String, default: undefined },
  ariaLabel: { type: String, default: undefined },
});
const emit = defineEmits(["update:modelValue", "change"]);
const attrs = useAttrs();
const passAttrs = computed(() => {
  const rest = { ...attrs };
  delete rest.label;
  return rest;
});

function onUpdate(next) {
  if (props.disabled) return;
  emit("update:modelValue", next);
  emit("change", next);
}
</script>

<template>
  <QToggle
    name="ui-toggle"
    v-bind="passAttrs"
    :model-value="modelValue"
    :disable="disabled"
    :id="id"
    :aria-label="ariaLabel"
    class="ui-toggle"
    :class="{ 'ui-toggle--on': modelValue, 'ui-toggle--disabled': disabled }"
    @update:model-value="onUpdate"
  />
</template>
