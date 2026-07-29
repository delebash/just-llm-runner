<script setup>
// SPDX-License-Identifier: MIT
// Shared segmented radio control — a row of mutually-exclusive buttons.
// Supersedes JwSegmented/JvSegmented/LuSegmented. Provides role="radiogroup" +
// roving tabindex + arrow/Home/End nav + type-ahead, a "connected" variant, and
// a `disabled` (locked) state. Self-contained: scoped styles + the shared
// useRovingTabindex composable.
//
//   v-model="value"
//   :options="[{ value, label, sublabel? }, ...]"
//   :option-label / :option-value / :option-sublabel  (defaults label/value/sublabel)
//   :aria-label  :size  :variant ("default" | "connected")  :disabled
//   <template #option="{ option, selected }">…</template>
import { computed, nextTick } from "vue";
import { useRovingTabindex } from "../composables/useRovingTabindex.js";

const props = defineProps({
  modelValue: {},
  options: { type: Array, required: true },
  optionLabel: { type: String, default: "label" },
  optionValue: { type: String, default: "value" },
  optionSublabel: { type: String, default: "sublabel" },
  ariaLabel: { type: String, default: "" },
  size: { type: String, default: "regular" }, // small | regular
  variant: { type: String, default: "default" }, // default | connected
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue"]);

function getValue(opt) { return opt?.[props.optionValue]; }
function labelOf(opt) { return opt?.[props.optionLabel]; }
function sublabelOf(opt) { return opt?.[props.optionSublabel]; }
function pick(opt) { if (!props.disabled) emit("update:modelValue", getValue(opt)); }

const length = computed(() => props.options.length);
const { onKeydown: rovingKeydown, registerItem, focusAt } = useRovingTabindex({
  length,
  orientation: "both",
  loop: true,
  onActivate: (i) => pick(props.options[i]),
});

let typeBuffer = "";
let typeTimer = null;
function onKeydown(e, idx) {
  if (props.disabled) return;
  rovingKeydown(e, idx);
  if (e.defaultPrevented) return;
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    clearTimeout(typeTimer);
    typeBuffer += e.key.toLowerCase();
    const match = props.options.findIndex((o) =>
      String(labelOf(o) ?? "").toLowerCase().startsWith(typeBuffer),
    );
    if (match >= 0) {
      e.preventDefault();
      pick(props.options[match]);
      nextTick(() => focusAt(match));
    }
    typeTimer = setTimeout(() => { typeBuffer = ""; }, 600);
  }
}
</script>

<template>
  <div class="ui-seg"
    :class="{
      'ui-seg--small': size === 'small',
      'ui-seg--connected': variant === 'connected',
      'is-locked': disabled,
    }"
    role="radiogroup" :aria-label="ariaLabel">
    <button v-for="(opt, i) in options" :key="getValue(opt)"
      :ref="(el) => registerItem(i, el)"
      type="button"
      role="radio"
      :disabled="disabled"
      :aria-checked="modelValue === getValue(opt)"
      :tabindex="modelValue === getValue(opt) ? 0 : -1"
      :class="{ active: modelValue === getValue(opt) }"
      @click="pick(opt)"
      @keydown="onKeydown($event, i)">
      <slot name="option" :option="opt" :selected="modelValue === getValue(opt)">
        <b>{{ labelOf(opt) }}</b>
        <span v-if="sublabelOf(opt)">{{ sublabelOf(opt) }}</span>
      </slot>
    </button>
  </div>
</template>

<style scoped>
.ui-seg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 2px; gap: 1px; }
.ui-seg.is-locked { opacity: .55; pointer-events: none; }
.ui-seg button {
  appearance: none; background: transparent; border: 0; padding: 6px 12px; border-radius: 6px;
  cursor: pointer; color: var(--ink-2, var(--ink)); font: inherit;
  display: inline-flex; align-items: center; gap: 6px;
  transition: background .12s ease, color .12s ease; white-space: nowrap;
}
.ui-seg button:hover { background: var(--surface-3, var(--surface)); color: var(--ink); }
.ui-seg button.active { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, .06); }
.ui-seg button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }
.ui-seg button b { font-weight: 600; }
.ui-seg button span { font-size: 11px; color: var(--muted); }
.ui-seg--small button { padding: 4px 8px; font-size: 12px; }

/* connected — buttons flex to fill + stack label/sublabel; the 1px gap reads as
   a hairline divider. Caller owns row sizing (flex: 1; min-width). */
.ui-seg--connected { border-radius: 9px; }
.ui-seg--connected button { flex: 1; flex-direction: column; align-items: center; gap: 1px; padding: 6px 4px; }
.ui-seg--connected button.active { color: var(--accent-ink, var(--accent)); box-shadow: 0 0 0 1px var(--border), 0 1px 2px var(--shadow-soft, rgba(0,0,0,.08)); }
.ui-seg--connected button b { font-size: 12px; }
.ui-seg--connected button span { font-size: 10px; color: var(--muted); }
.ui-seg--connected button.active span { color: var(--accent-ink, var(--accent)); opacity: .8; }
</style>
