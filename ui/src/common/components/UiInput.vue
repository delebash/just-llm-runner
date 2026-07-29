<script setup>
// SPDX-License-Identifier: MIT
// Shared text input — thin <input> wrapper (v-model + standard attrs). Visual
// rules in common/styles.css (.ui-input). Supersedes JwInput/JvInput/UiInput.
import { computed, ref } from "vue";

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

// Expose programmatic focus/select (+ the raw element) so callers can use a
// template ref the same way they would on a bare <input>.
const el = ref(null);
defineExpose({
  focus: () => el.value?.focus(),
  select: () => el.value?.select(),
  el,
});

const classes = computed(() => [
  "ui-input",
  props.size === "small" && "ui-input--small",
  props.type === "number" && "ui-input--number",
  props.width && `ui-w-${props.width}`,
  { "is-invalid": props.invalid },
]);
</script>

<template>
  <input
    ref="el"
    :class="classes"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :autocomplete="autocomplete"
    :name="name"
    :id="id"
    :autofocus="autofocus"
    :aria-invalid="invalid ? 'true' : undefined"
    @input="emit('update:modelValue', $event.target.value)"
    @blur="emit('blur', $event)"
    @focus="emit('focus', $event)"
    @keydown="emit('keydown', $event)"
  />
</template>
