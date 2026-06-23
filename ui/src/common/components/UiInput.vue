<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared text input — thin <input> wrapper (v-model + standard attrs). Visual
// rules in common/styles.css (.ui-input). Supersedes JwInput/JvInput/UiInput.
import { computed } from "vue";

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
});
const emit = defineEmits(["update:modelValue", "blur", "focus", "keydown"]);

const classes = computed(() => [
  "ui-input",
  props.size === "small" && "ui-input--small",
  props.type === "number" && "ui-input--number",
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
