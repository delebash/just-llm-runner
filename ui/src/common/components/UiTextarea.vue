<script setup>
// SPDX-License-Identifier: MIT
// Shared textarea — adds auto-resize. Supersedes JwTextarea/JvTextarea/UiTextarea.
//
// Quasar's QInput (type "textarea") underneath, as UiInput (docs/plans/2026-10-09-kit-controls-
// on-quasar.md): its root is the box (.ui-input .ui-textarea, the caller's classes and style),
// the native <textarea> inside keeps the padding — so its resize grip sits in the box's corner,
// as before — and takes the box's font. Listeners are the native textarea's own events
// (../composables/useNativeEvents.js); auto-resize sizes the native textarea; `el` is it.
import { QInput } from "quasar";
import { computed, nextTick, onMounted, ref, useAttrs, watch } from "vue";
import { useNativeEvents, withoutListeners } from "../composables/useNativeEvents.js";

defineOptions({ inheritAttrs: false });
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

const field = ref(null);
const textareaEl = computed(() => field.value?.getNativeElement?.() ?? null);
const classes = computed(() => [
  "ui-input",
  "ui-textarea",
  props.size === "small" && "ui-input--small",
  props.width && `ui-w-${props.width}`,
  { "is-invalid": props.invalid, "is-disabled": props.disabled, "auto-resize": props.autoResize },
]);

// The box's height comes out as before: the old <textarea> was the box, its border inside the
// height it was given; the native textarea now sits inside the box's border, so it gets that
// height less the border.
function resize() {
  if (!props.autoResize || !textareaEl.value) return;
  const el = textareaEl.value;
  const box = getComputedStyle(field.value?.$el ?? el);
  const border = (parseFloat(box.borderTopWidth) || 0) + (parseFloat(box.borderBottomWidth) || 0);
  el.style.height = "auto";
  const min = props.minHeightPx;
  const max = props.maxHeightPx;
  if (min != null || max != null) {
    let target = el.scrollHeight;
    if (max != null) target = Math.min(target, max);
    if (min != null) target = Math.max(target, min);
    el.style.height = `${target - border}px`;
    el.style.overflowY = max != null && el.scrollHeight > max ? "auto" : "hidden";
  } else {
    el.style.height = `${el.scrollHeight - border}px`;
  }
}
function onUpdate(value) {
  emit("update:modelValue", value);
  if (props.autoResize) nextTick(resize);
}
watch(() => props.modelValue, () => { if (props.autoResize) nextTick(resize); });
onMounted(() => { if (props.autoResize) nextTick(resize); });
useNativeEvents(textareaEl, attrs, {
  blur: (e) => emit("blur", e),
  focus: (e) => emit("focus", e),
  keydown: (e) => emit("keydown", e),
});

// Expose focus/select (+ the raw element) so callers can use a template ref
// the same way they would on a bare <textarea>.
defineExpose({
  focus: () => textareaEl.value?.focus(),
  select: () => textareaEl.value?.select(),
  el: textareaEl,
});
</script>

<template>
  <QInput
    ref="field"
    v-bind="passAttrs()"
    type="textarea"
    :class="classes"
    :model-value="current()"
    :rows="rows"
    :placeholder="placeholder"
    :disable="disabled"
    :readonly="readonly"
    :name="name"
    :for="id"
    :maxlength="maxlength"
    :aria-invalid="invalid ? 'true' : undefined"
    borderless
    dense
    hide-bottom-space
    @update:model-value="onUpdate"
  />
</template>
