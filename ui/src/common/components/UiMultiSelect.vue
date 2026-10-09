<script setup>
// SPDX-License-Identifier: MIT
// Shared multi-select. Born for just-ai-i18n-docgen's target-languages picker (2026-08-02
// ruling: a new capability lands in the KIT so every app gets it), generic on purpose:
// options are plain strings or {label,value} objects, exactly like UiSelect.
//
//   v-model="values"  :options="[{label,value}…] | ['a','b']"
//   :option-label :option-value :placeholder :disabled :filterable :id :width
//
// The trigger renders the selection as chips with per-chip remove; the list holds a filter
// box (a hundred language codes is the normal case, so filtering is default-on) and a
// checkbox-style list.
//
// Quasar's QSelect (multiple) underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md), as UiSelect: its root is the trigger
// (.ui-mselect-trigger), the list opens in Quasar's menu (.ui-mselect-content) and the look is
// the kit's theme (../../quasar/theme.css, "Multi-select"). The filter box is the kit's own, at
// the top of the menu (QSelect's own filter types into the trigger instead): it takes focus when
// the list opens, arrows move through the list and Enter ticks, as before. QSelect drops its
// before-options slot when the list is empty, so "No matches" is a disabled row of the list —
// the filter box stays, and keeps its focus.
import { QSelect } from "quasar";
import { computed, nextTick, ref } from "vue";

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
const field = ref(null);
const filterEl = ref(null);
const NO_MATCH = { label: "No matches", value: Symbol("no-match"), disable: true, empty: true };

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
  const list = !q ? normalized.value : normalized.value.filter(
    (o) => o.label.toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q)
  );
  return list.length ? list : [NO_MATCH];
});
const chips = computed(() =>
  (props.modelValue ?? []).map((v) => byValue.value.get(v) ?? { label: String(v), value: v })
);

function set(values) {
  emit("update:modelValue", values);
}
// QSelect's root is a <label>: a click on the ✕ (a span) would also activate its focus input and
// open the list — preventDefault cancels that, as the old button trigger never needed.
function remove(value, e) {
  e?.stopPropagation();
  e?.preventDefault();
  set((props.modelValue ?? []).filter((v) => v !== value));
}
function clearAll(e) {
  e?.stopPropagation();
  set([]);
}
function focusFilter() {
  // preventScroll: focusing the input in its sticky bar made Chrome scroll the list by the bar's
  // padding
  if (props.filterable) nextTick(() => filterEl.value?.focus({ preventScroll: true }));
}
// QSelect opens a multiple select scrolled to, and highlighting, the first chosen option; the
// kit's list opened at the top with nothing highlighted, and still does (after QSelect's own
// scroll, which runs once the menu has rendered).
// QSelect's virtual scroll re-anchors once after the first scroll (measured: ~65ms later, by 8px),
// so the list is held at the top for the first moments the menu is open, then left to the user.
const HOLD_TOP_MS = 400;
function onShow() {
  open.value = true;
  focusFilter();
  setTimeout(() => {
    field.value?.setOptionIndex(-1);
    const list = filterEl.value?.closest(".ui-mselect-content");
    if (!list) return;
    const until = performance.now() + HOLD_TOP_MS;
    const holdTop = () => {
      if (performance.now() > until) list.removeEventListener("scroll", holdTop);
      else if (list.scrollTop !== 0) list.scrollTop = 0;
    };
    list.addEventListener("scroll", holdTop);
    setTimeout(() => list.removeEventListener("scroll", holdTop), HOLD_TOP_MS);
    list.scrollTop = 0;
  }, 0);
}
function onHide() {
  open.value = false;
  query.value = "";
}
// The filter box drives the list the way Reka's listbox filter did.
function onFilterKeydown(e) {
  const sel = field.value;
  if (!sel) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    sel.moveOptionSelection(e.key === "ArrowUp" ? -1 : 1, true);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const opt = filtered.value[sel.getOptionIndex()];
    if (opt && !opt.disable) toggle(opt, true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    sel.hidePopup();
  }
}
// QSelect moves focus to the trigger after a tick in a multiple select; ticking from the filter
// (Enter) keeps it there, as the old filter did; a click leaves it where QSelect puts it (the old
// list moved it to the clicked item).
function toggle(opt, fromFilter = false) {
  field.value?.toggleOption(opt, true);
  if (fromFilter) focusFilter();
}
function itemAttrs(p, opt) {
  return {
    id: p.id, role: p.role, tabindex: p.tabindex,
    "aria-selected": p["aria-selected"], "aria-disabled": p.disable ? "true" : undefined,
    onClick: () => { if (!opt.disable) toggle(opt); },
    onPointermove: p.onPointermove,
  };
}
</script>

<template>
  <QSelect
    ref="field"
    :model-value="modelValue"
    :options="filtered"
    option-label="label"
    option-value="value"
    emit-value
    map-options
    multiple
    :disable="disabled"
    :for="id"
    borderless
    dense
    hide-bottom-space
    hide-dropdown-icon
    options-dense
    behavior="menu"
    popup-content-class="ui-mselect-content"
    :menu-offset="[0, 4]"
    :transition-duration="0"
    class="ui-mselect-trigger"
    :class="[width && `ui-w-${width}`, { 'is-empty': !chips.length, 'is-open': open, 'is-disabled': disabled }]"
    @update:model-value="set"
    @popup-show="onShow"
    @popup-hide="onHide"
  >
    <template #selected>
      <span v-if="!chips.length" class="ui-mselect-placeholder">{{ placeholder }}</span>
      <span v-else class="ui-mselect-chips">
        <span v-for="c in chips" :key="String(c.value)" class="ui-mselect-chip">
          {{ c.label }}
          <span
            class="ui-mselect-chip-x" role="button" tabindex="-1"
            :aria-label="`Remove ${c.label}`"
            @click="remove(c.value, $event)" @pointerdown.stop @mousedown.stop
          >
            <svg viewBox="0 0 16 16" width="10" height="10" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </span>
        </span>
      </span>
    </template>
    <template #append>
      <span class="ui-select-icons">
        <button
          v-if="chips.length" type="button" class="ui-select-clear" tabindex="-1"
          aria-label="Clear all" @click.stop="clearAll" @pointerdown.stop @mousedown.stop
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <span class="ui-select-chev" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </span>
    </template>
    <template v-if="filterable" #before-options>
      <!-- the bar stays at the top of the scrolling list, as the filter did above the old list -->
      <div class="ui-mselect-filterbar">
        <input
          ref="filterEl" v-model="query" class="ui-mselect-filter" placeholder="Filter…"
          autocomplete="off" @keydown="onFilterKeydown" @click.stop @mousedown.stop
        />
      </div>
    </template>
    <template #option="{ itemProps, opt, selected, focused }">
      <div v-if="opt.empty" class="ui-mselect-empty" role="presentation">{{ opt.label }}</div>
      <div v-else v-bind="itemAttrs(itemProps, opt)" class="ui-mselect-item" :class="{ 'is-highlighted': focused, 'is-checked': selected }">
        <span class="ui-mselect-box" aria-hidden="true">
          <span v-if="selected" class="ui-mselect-tick">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </span>
        {{ opt.label }}
      </div>
    </template>
  </QSelect>
</template>
