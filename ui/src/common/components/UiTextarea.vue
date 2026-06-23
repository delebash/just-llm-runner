<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared textarea — adds auto-resize. Shares .ui-input + .ui-textarea in
// common/styles.css. Supersedes JwTextarea/JvTextarea/UiTextarea.
import { computed, nextTick, onMounted, ref, watch } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  autoResize: { type: Boolean, default: false },
  // Optional bounds for autoResize (px). When set, the textarea grows between
  // them and scrolls past the max instead of growing unbounded.
  minHeightPx: { type: Number, default: null },
  maxHeightPx: { type: Number, default: null },
  rows: { type: [Number, String], default: 3 },
  size: { type: String, default: "regular" }, // small | regular
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  placeholder: { type: String, default: "" },
  name: { type: String, default: undefined },
  id: { type: String, default: undefined },
  maxlength: { type: [Number, String], default: undefined },
  invalid: { type: Boolean, default: false },
  // Content-typed width cap (optional): token|id|name|url|path|prose|edit|full.
  width: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue", "blur", "focus", "keydown"]);

const textareaEl = ref(null);
const classes = computed(() => [
  "ui-input",
  "ui-textarea",
  props.size === "small" && "ui-input--small",
  props.width && `ui-w-${props.width}`,
  { "is-invalid": props.invalid, "auto-resize": props.autoResize },
]);

function resize() {
  if (!props.autoResize || !textareaEl.value) return;
  const el = textareaEl.value;
  el.style.height = "auto";
  const min = props.minHeightPx;
  const max = props.maxHeightPx;
  if (min != null || max != null) {
    let target = el.scrollHeight;
    if (max != null) target = Math.min(target, max);
    if (min != null) target = Math.max(target, min);
    el.style.height = `${target}px`;
    el.style.overflowY = max != null && el.scrollHeight > max ? "auto" : "hidden";
  } else {
    el.style.height = `${el.scrollHeight}px`;
  }
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
