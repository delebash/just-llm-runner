<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared textarea — adds the one feature we use (auto-resize). Visual rules
// share .lu-input + .lu-textarea in styles.css.
import { computed, nextTick, onMounted, ref, watch } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  autoResize: { type: Boolean, default: false },
  rows: { type: [Number, String], default: 3 },
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  placeholder: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue", "blur", "focus", "keydown"]);

const el = ref(null);
const classes = computed(() => ["lu-input", "lu-textarea", { "auto-resize": props.autoResize }]);

function resize() {
  if (!props.autoResize || !el.value) return;
  el.value.style.height = "auto";
  el.value.style.height = `${el.value.scrollHeight}px`;
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
    ref="el"
    :class="classes"
    :value="modelValue"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    @input="onInput"
    @blur="$emit('blur', $event)"
    @focus="$emit('focus', $event)"
    @keydown="$emit('keydown', $event)"
  />
</template>
