<script setup>
// SPDX-License-Identifier: MIT
// Shared multi-select — Reka UI Popover + Listbox (multiple) primitives, so keyboard
// nav, focus management and dismissal come from the same headless layer as UiSelect.
// Born for just-ai-i18n-docgen's target-languages picker (2026-08-02 ruling: a new
// capability lands in the KIT so every app gets it), generic on purpose: options are
// plain strings or {label,value} objects, exactly like UiSelect.
//
//   v-model="values"  :options="[{label,value}…] | ['a','b']"
//   :option-label :option-value :placeholder :disabled :filterable :id :width
//
// The trigger renders the selection as chips with per-chip remove; the popover holds a
// filter box (a hundred language codes is the normal case, so filtering is default-on)
// and a checkbox-style list. Visuals are global .ui-mselect-* in common/styles.css,
// tuned via host tokens — the kit owns the design contract.
import { computed, ref } from "vue";
import {
  ListboxContent, ListboxFilter, ListboxItem, ListboxItemIndicator, ListboxRoot,
  PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger,
} from "reka-ui";

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  options:    { type: Array, default: () => [] },
  optionLabel:{ type: String, default: "label" },
  optionValue:{ type: String, default: "value" },
  placeholder:{ type: String, default: "Select…" },
  disabled:   { type: Boolean, default: false },
  filterable: { type: Boolean, default: true },
  id:         { type: String, default: undefined },
  width:      { type: String, default: "" }, // content cap: token/id/name/url/path/prose/edit/full
});
const emit = defineEmits(["update:modelValue"]);

const open = ref(false);
const query = ref("");

// Accept plain strings/numbers OR { [optionLabel]: …, [optionValue]: … }.
const normalized = computed(() =>
  props.options.map((o) => {
    if (o == null) return { label: "", value: null };
    if (typeof o === "string" || typeof o === "number") return { label: String(o), value: o };
    return { label: String(o[props.optionLabel]), value: o[props.optionValue] };
  })
);
const byValue = computed(() => new Map(normalized.value.map((o) => [o.value, o])));
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return normalized.value;
  return normalized.value.filter(
    (o) => o.label.toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q)
  );
});
const chips = computed(() =>
  (props.modelValue ?? []).map((v) => byValue.value.get(v) ?? { label: String(v), value: v })
);

function set(values) {
  emit("update:modelValue", values);
}
function remove(value, e) {
  e?.stopPropagation();
  set((props.modelValue ?? []).filter((v) => v !== value));
}
function clearAll(e) {
  e?.stopPropagation();
  set([]);
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      :id="id"
      class="ui-mselect-trigger"
      :class="[width && `ui-w-${width}`, { 'is-empty': !chips.length }]"
      :disabled="disabled"
      type="button"
    >
      <span v-if="!chips.length" class="ui-mselect-placeholder">{{ placeholder }}</span>
      <span v-else class="ui-mselect-chips">
        <span v-for="c in chips" :key="String(c.value)" class="ui-mselect-chip">
          {{ c.label }}
          <span
            class="ui-mselect-chip-x" role="button" tabindex="-1"
            :aria-label="`Remove ${c.label}`"
            @click="remove(c.value, $event)" @pointerdown.stop
          >
            <svg viewBox="0 0 16 16" width="10" height="10" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </span>
        </span>
      </span>
      <span class="ui-select-icons">
        <button
          v-if="chips.length" type="button" class="ui-select-clear" tabindex="-1"
          aria-label="Clear all" @click.stop="clearAll" @pointerdown.stop
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <span class="ui-select-chev" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </span>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent class="ui-mselect-content" :side-offset="4" :collision-padding="8" align="start">
        <ListboxRoot
          :model-value="modelValue" multiple highlight-on-hover
          @update:model-value="set"
        >
          <ListboxFilter
            v-if="filterable" v-model="query" as="input"
            class="ui-mselect-filter" placeholder="Filter…" auto-focus
          />
          <ListboxContent class="ui-mselect-list">
            <ListboxItem
              v-for="opt in filtered" :key="String(opt.value)" :value="opt.value"
              class="ui-mselect-item"
            >
              <span class="ui-mselect-box" aria-hidden="true">
                <ListboxItemIndicator class="ui-mselect-tick">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </ListboxItemIndicator>
              </span>
              {{ opt.label }}
            </ListboxItem>
            <div v-if="!filtered.length" class="ui-mselect-empty">No matches</div>
          </ListboxContent>
        </ListboxRoot>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
