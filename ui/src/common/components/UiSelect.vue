<script setup>
// SPDX-License-Identifier: MIT
// Shared select — Reka UI headless Select primitives (focus management,
// arrow-key nav, type-ahead, Esc-to-close, screen-reader support, Floating-UI
// positioning). Supersedes JwSelect/JvSelect. Visuals are global .ui-select-*
// in common/styles.css, tuned via host tokens.
//
//   v-model="value"  :options="[{label,value}…] | ['a','b']"
//   :option-label :option-value :placeholder :disabled :show-clear :id :width
//
// options may be plain strings/numbers OR objects. Reka deals in strings, so we
// round-trip non-string values, and swap an empty-string value for an internal
// sentinel (Reka reserves "" as the no-selection value on SelectRoot).
import { computed } from "vue";
import {
  SelectRoot, SelectTrigger, SelectValue, SelectIcon, SelectPortal,
  SelectContent, SelectViewport, SelectItem, SelectItemText, SelectItemIndicator,
} from "reka-ui";

const EMPTY_SENTINEL = "__ui_empty__";
const props = defineProps({
  modelValue: { type: [String, Number, Boolean, Object, null], default: null },
  options:    { type: Array, default: () => [] },
  optionLabel:{ type: String, default: "label" },
  optionValue:{ type: String, default: "value" },
  placeholder:{ type: String, default: "" },
  disabled:   { type: Boolean, default: false },
  showClear:  { type: Boolean, default: false },
  id:         { type: String, default: undefined },
  inputId:    { type: String, default: undefined },
  width:      { type: String, default: "" }, // content cap: token/id/name/url/path/prose/edit/full
});
const emit = defineEmits(["update:modelValue"]);

// Accept plain strings/numbers OR { [optionLabel]: …, [optionValue]: … }.
const normalized = computed(() =>
  props.options.map((o) => {
    if (o == null) return { label: "", value: null };
    if (typeof o === "string" || typeof o === "number") return { label: String(o), value: o };
    return { label: o[props.optionLabel], value: o[props.optionValue] };
  })
);

const stringValue = computed({
  get() {
    if (props.modelValue == null) return "";
    if (props.modelValue === "") return EMPTY_SENTINEL;
    return String(props.modelValue);
  },
  set(s) {
    if (s == null || s === "") { emit("update:modelValue", null); return; }
    if (s === EMPTY_SENTINEL) { emit("update:modelValue", ""); return; }
    const match = normalized.value.find((o) => String(o.value) === s);
    emit("update:modelValue", match ? match.value : s);
  },
});
function itemValue(o) {
  const v = String(o.value);
  return v === "" ? EMPTY_SENTINEL : v;
}
const selectedLabel = computed(() => {
  if (props.modelValue == null) return "";
  const found = normalized.value.find((o) => o.value === props.modelValue);
  return found ? found.label : "";
});
function clear(e) { e.stopPropagation(); emit("update:modelValue", null); }
</script>

<template>
  <SelectRoot v-model="stringValue" :disabled="disabled">
    <SelectTrigger
      :id="id || inputId"
      class="ui-select-trigger"
      :class="[width && `ui-w-${width}`, { 'is-empty': !selectedLabel }]"
    >
      <!-- Reka's SelectValue falls back to `placeholder` ONLY when it has no slot
           content — and a slot rendering an empty string still counts as content, so
           passing `{{ selectedLabel }}` unconditionally made the placeholder prop dead
           family-wide: an unset select was a blank box with a chevron and no hint of
           what it was for (seen 2026-08-03 as the i18n review page's mystery second
           dropdown). Bind the slot only when there IS a label. -->
      <SelectValue v-if="selectedLabel" :placeholder="placeholder">{{ selectedLabel }}</SelectValue>
      <SelectValue v-else :placeholder="placeholder" />
      <span class="ui-select-icons">
        <button
          v-if="showClear && modelValue != null && modelValue !== ''"
          type="button" class="ui-select-clear" tabindex="-1"
          @click.stop="clear" @pointerdown.stop
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <SelectIcon class="ui-select-chev">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </SelectIcon>
      </span>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent class="ui-select-content" position="popper" :side-offset="4" :collision-padding="8">
        <SelectViewport class="ui-select-viewport">
          <SelectItem
            v-for="opt in normalized"
            :key="String(opt.value)"
            :value="itemValue(opt)"
            class="ui-select-item"
          >
            <SelectItemText>{{ opt.label }}</SelectItemText>
            <SelectItemIndicator class="ui-select-indicator">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
