<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared text input — thin <input> wrapper (v-model + standard attrs). Visual
// rules in styles.css (.lu-input).
import { computed } from "vue";

const props = defineProps({
  modelValue: { type: [String, Number], default: "" },
  type: { type: String, default: "text" },
  size: { type: String, default: "regular" },
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  placeholder: { type: String, default: "" },
  invalid: { type: Boolean, default: false },
});
defineEmits(["update:modelValue", "blur", "focus", "keydown"]);

const classes = computed(() => [
  "lu-input",
  props.size === "small" && "lu-input--small",
  props.type === "number" && "lu-input--number",
  { "is-invalid": props.invalid },
]);
</script>

<template>
  <input
    :class="classes"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :aria-invalid="invalid ? 'true' : undefined"
    @input="$emit('update:modelValue', $event.target.value)"
    @blur="$emit('blur', $event)"
    @focus="$emit('focus', $event)"
    @keydown="$emit('keydown', $event)"
  />
</template>
