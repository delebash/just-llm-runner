<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared textarea — adds auto-resize. Shares .ui-input + .ui-textarea in
// common/styles.css. Supersedes JwTextarea/JvTextarea/UiTextarea.
import { computed, nextTick, onMounted, ref, watch } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  autoResize: { type: Boolean, default: false },
  rows: { type: [Number, String], default: 3 },
  size: { type: String, default: "regular" }, // small | regular
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  placeholder: { type: String, default: "" },
  name: { type: String, default: undefined },
  id: { type: String, default: undefined },
  maxlength: { type: [Number, String], default: undefined },
  invalid: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "blur", "focus", "keydown"]);

const textareaEl = ref(null);
const classes = computed(() => [
  "ui-input",
  "ui-textarea",
  props.size === "small" && "ui-input--small",
  { "is-invalid": props.invalid, "auto-resize": props.autoResize },
]);

function resize() {
  if (!props.autoResize || !textareaEl.value) return;
  const el = textareaEl.value;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
function onInput(e) {
  emit("update:modelValue", e.target.value);
  if (props.autoResize) nextTick(resize);
}
watch(() => props.modelValue, () => { if (props.autoResize) nextTick(resize); });
onMounted(() => { if (props.autoResize) resize(); });
</script>

<template>
  <textarea
    ref="textareaEl"
    :class="classes"
    :value="modelValue"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :name="name"
    :id="id"
    :maxlength="maxlength"
    :aria-invalid="invalid ? 'true' : undefined"
    @input="onInput"
    @blur="emit('blur', $event)"
    @focus="emit('focus', $event)"
    @keydown="emit('keydown', $event)"
  />
</template>
