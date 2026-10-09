<script setup>
// SPDX-License-Identifier: MIT
// Shared text input (v-model + standard attrs). Supersedes JwInput/JvInput/UiInput.
//
// Quasar's QInput underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md), its Material look off (borderless, dense,
// no bottom space). QInput's root is the field's box: it carries .ui-input, the width cap and
// the caller's classes, scoped styles and inline style, and the native <input> inside takes the
// box's font, colour and alignment (../../quasar/theme.css, "Text field"). The caller's other
// attributes (title, maxlength, aria-*, data-*) reach the native input, and its listeners and this
// field's blur/focus/keydown are the native input's own events (../composables/useNativeEvents.js
// — QInput would replace a caller's input/change/blur with its own); `el` is that native input.
import { QInput } from "quasar";
import { computed, ref, useAttrs } from "vue";
import { useNativeEvents, withoutListeners } from "../composables/useNativeEvents.js";

defineOptions({ inheritAttrs: false });
const props = defineProps({
  modelValue: { type: [String, Number], default: "" },
  size: { type: String, default: "regular" }, // small | regular
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  placeholder: { type: String, default: "" },
  type: { type: String, default: "text" }, // text | email | url | password | search | tel | number
  autocomplete: { type: String, default: undefined },
  name: { type: String, default: undefined },
  id: { type: String, default: undefined },
  autofocus: { type: Boolean, default: false },
  invalid: { type: Boolean, default: false },
  // Content-typed width cap (optional): token|id|name|url|path|prose|edit|full.
  // Empty = no cap (full width). Sizes the field to what it holds rather than
  // stretching to the container.
  width: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue", "blur", "focus", "keydown"]);
const attrs = useAttrs();
// A caller that passes `:value` with its own @input (no v-model) set the native element's value
// before — the attribute fell through and won over modelValue; it still does. (Read at render:
// $attrs isn't reactive, so a computed over it would keep the first value.)
const current = () => (attrs.value !== undefined ? attrs.value : props.modelValue);
const passAttrs = () => {
  const rest = withoutListeners(attrs);
  delete rest.value;
  return rest;
};

// Expose programmatic focus/select (+ the raw element) so callers can use a
// template ref the same way they would on a bare <input>.
const field = ref(null);
const el = computed(() => field.value?.getNativeElement?.() ?? null);
defineExpose({
  focus: () => el.value?.focus(),
  select: () => el.value?.select(),
  el,
});
useNativeEvents(el, attrs, {
  blur: (e) => emit("blur", e),
  focus: (e) => emit("focus", e),
  keydown: (e) => emit("keydown", e),
});

const classes = computed(() => [
  "ui-input",
  props.size === "small" && "ui-input--small",
  props.type === "number" && "ui-input--number",
  props.width && `ui-w-${props.width}`,
  { "is-invalid": props.invalid, "is-disabled": props.disabled },
]);
</script>

<template>
  <QInput
    ref="field"
    v-bind="passAttrs()"
    :class="classes"
    :model-value="current()"
    :type="type"
    :placeholder="placeholder"
    :disable="disabled"
    :readonly="readonly"
    :autocomplete="autocomplete"
    :name="name"
    :for="id"
    :autofocus="autofocus"
    :aria-invalid="invalid ? 'true' : undefined"
    borderless
    dense
    hide-bottom-space
    @update:model-value="(v) => emit('update:modelValue', v)"
  />
</template>
