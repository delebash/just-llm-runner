<script setup>
// SPDX-License-Identifier: MIT
// Shared select. Supersedes JwSelect/JvSelect.
//
//   v-model="value"  :options="[{label,value,hint?}…] | ['a','b']"
//   :option-label :option-value :placeholder :disabled :show-clear :id :width
//   :title :aria-label (on the trigger)
//
// An option's `hint` is a second, quieter line under its label in the OPEN
// list only — the closed trigger shows the label alone, so a choice can carry
// its example ("Tags" · "pick from the model's list: [fear] [sigh]") without
// widening the control (JustVoice's persona filters, 2026-10-03).
//
// Quasar's QSelect underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md): its root is the trigger box (.ui-select-trigger),
// the list opens in Quasar's menu (.ui-select-content), the items are the kit's own markup in
// QSelect's option slot, and the look is the kit's theme (../../quasar/theme.css, "Select").
// QSelect gives the keyboard (arrows open and move, Enter/Space choose, Esc closes, typing jumps)
// and keeps each option's value as it is — strings, numbers, booleans, objects, "" — so no
// string round-trip is needed any more. Its focus target is a hidden read-only <input> with the
// combobox role and this select's id (a <label for> still reaches it); `aria-label` lands there,
// `title` on the box.
import { QSelect } from "quasar";
import { computed, ref, watch } from "vue";

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
  title:      { type: String, default: undefined },
  ariaLabel:  { type: String, default: undefined },
});
const emit = defineEmits(["update:modelValue"]);

// Accept plain strings/numbers OR { [optionLabel]: …, [optionValue]: … }.
const normalized = computed(() =>
  props.options.map((o) => {
    if (o == null) return { label: "", value: null };
    if (typeof o === "string" || typeof o === "number") return { label: String(o), value: o };
    return { label: o[props.optionLabel], value: o[props.optionValue], hint: o.hint || "" };
  })
);
const selectedLabel = computed(() => {
  if (props.modelValue == null) return "";
  const found = normalized.value.find((o) => o.value === props.modelValue);
  return found ? found.label : "";
});

const open = ref(false);
const field = ref(null);
// `title` goes on the box (QSelect hands other attributes to its hidden focus input)
watch([field, () => props.title], ([f, title]) => {
  const el = f?.$el;
  if (!el) return;
  if (title) el.setAttribute("title", title);
  else el.removeAttribute("title");
}, { flush: "post", immediate: true });

function clear() { emit("update:modelValue", null); }
// the option slot gets QItem's props; the kit's item is a plain element, so only these reach it
function itemAttrs(p) {
  return {
    id: p.id, role: p.role, tabindex: p.tabindex,
    "aria-selected": p["aria-selected"], "aria-setsize": p["aria-setsize"], "aria-posinset": p["aria-posinset"],
    "aria-disabled": p.disable ? "true" : undefined,
    onClick: p.onClick, onPointermove: p.onPointermove,
  };
}
</script>

<template>
  <QSelect
    ref="field"
    :model-value="modelValue"
    :options="normalized"
    option-label="label"
    option-value="value"
    emit-value
    map-options
    :disable="disabled"
    :for="id || inputId"
    :aria-label="ariaLabel"
    borderless
    dense
    hide-bottom-space
    hide-dropdown-icon
    options-dense
    behavior="menu"
    popup-content-class="ui-select-content"
    :menu-offset="[0, 4]"
    :transition-duration="0"
    class="ui-select-trigger"
    :class="[width && `ui-w-${width}`, { 'is-empty': !selectedLabel, 'is-open': open, 'is-disabled': disabled }]"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @popup-show="open = true"
    @popup-hide="open = false"
  >
    <template #selected><span class="ui-select-value">{{ selectedLabel || placeholder }}</span></template>
    <template #append>
      <span class="ui-select-icons">
        <button
          v-if="showClear && modelValue != null && modelValue !== ''"
          type="button" class="ui-select-clear" tabindex="-1"
          @click.stop="clear" @pointerdown.stop @mousedown.stop
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <span class="ui-select-chev" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </span>
    </template>
    <template #option="{ itemProps, opt, selected, focused }">
      <div v-bind="itemAttrs(itemProps)" class="ui-select-item" :class="{ 'is-highlighted': focused, 'is-checked': selected, 'is-disabled': itemProps.disable }">
        <span v-if="opt.hint" class="ui-select-item-main">
          <span class="ui-select-item-text">{{ opt.label }}</span>
          <span class="ui-select-hint">{{ opt.hint }}</span>
        </span>
        <span v-else class="ui-select-item-text">{{ opt.label }}</span>
        <span v-if="selected" class="ui-select-indicator">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </div>
    </template>
  </QSelect>
</template>
