<script setup>
// SPDX-License-Identifier: MIT
// Shared segmented radio control — a row of mutually-exclusive buttons.
// Supersedes JwSegmented/JvSegmented/LuSegmented. Provides role="radiogroup" +
// roving tabindex + arrow/Home/End nav + type-ahead, a "connected" variant, and
// a `disabled` (locked) state. Self-contained: the shared useRovingTabindex
// composable, and its look in the kit's theme.
//
//   v-model="value"
//   :options="[{ value, label, sublabel?, disabled?, title? }, ...]"
//   :option-label / :option-value / :option-sublabel  (defaults label/value/sublabel)
//   :aria-label  :size  :variant ("default" | "connected")  :disabled
//   <template #option="{ option, selected }">…</template>
//   @blocked="(option) => …"   — a click on an option marked `disabled`
//
// An option marked `disabled: true` stays in the row, dimmed, with its `title`
// as the tooltip, and can't be picked; clicking it emits `blocked` so the host
// can say why (born 2026-10-03 for JustVoice's persona editor: a voice kind
// that needs a model not yet available is shown off with its reason, never
// hidden — the user can't tell "off" from "absent" otherwise).
//
// Quasar's QBtnToggle underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md): its group is the row (.ui-seg) and its QBtns
// the options — native <button>s as before, with the `active` / `is-off` classes — and the look
// is the kit's theme (../../quasar/theme.css, "Segmented"). The kit keeps what QBtnToggle doesn't
// do: the radio roles and the roving tabindex (one tab stop; arrows move; Enter/Space pick),
// type-ahead, and an off option that stays clickable (QBtnToggle's would be disabled). Its value
// is the option's index, so any option value works; a click on the chosen option reaches
// QBtnToggle's `clear` (it's clearable for that alone) and is picked again, as before.
import { QBtnToggle } from "quasar";
import { computed, nextTick, onMounted, onUpdated, ref } from "vue";
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
const emit = defineEmits(["update:modelValue", "blocked"]);

function getValue(opt) { return opt?.[props.optionValue]; }
function labelOf(opt) { return opt?.[props.optionLabel]; }
function sublabelOf(opt) { return opt?.[props.optionSublabel]; }
function isOff(opt) { return !!opt?.disabled; }
function pick(opt) {
  if (props.disabled) return;
  if (isOff(opt)) { emit("blocked", opt); return; }
  emit("update:modelValue", getValue(opt));
}

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

const isSelected = (opt) => props.modelValue === getValue(opt);
const selectedIndex = computed(() => props.options.findIndex(isSelected));
// QBtnToggle's options: the index as the value, the kit's attributes on each button (QBtnToggle
// spreads `attrs` into the QBtn), and a slot of its own per option
const btnOptions = computed(() => props.options.map((opt, i) => ({
  value: i,
  slot: `opt-${i}`,
  attrs: {
    role: "radio",
    "aria-pressed": undefined,
    "aria-checked": isSelected(opt) ? "true" : "false",
    "aria-disabled": isOff(opt) ? "true" : undefined,
    title: opt?.title || undefined,
    tabindex: isSelected(opt) ? 0 : -1,
    disabled: props.disabled ? "" : undefined,
    class: { active: isSelected(opt), "is-off": isOff(opt) },
    onKeydown: (e) => onKeydown(e, i),
  },
})));
function onToggle(i) {
  if (i !== null) pick(props.options[i]);
}
function onReclick() {
  pick(props.options[selectedIndex.value]);
}

// the roving focus needs the buttons themselves, which QBtnToggle renders
const group = ref(null);
function registerButtons() {
  const buttons = group.value?.$el?.querySelectorAll?.(":scope > .q-btn") ?? [];
  props.options.forEach((_, i) => registerItem(i, buttons[i] ?? null));
}
onMounted(registerButtons);
onUpdated(registerButtons);
</script>

<template>
  <QBtnToggle
    ref="group"
    :model-value="selectedIndex"
    :options="btnOptions"
    flat
    no-caps
    no-wrap
    clearable
    toggle-color=""
    :ripple="false"
    class="ui-seg"
    :class="{
      'ui-seg--small': size === 'small',
      'ui-seg--connected': variant === 'connected',
      'is-locked': disabled,
    }"
    role="radiogroup" :aria-label="ariaLabel"
    @update:model-value="onToggle"
    @clear="onReclick"
  >
    <template v-for="(opt, i) in options" :key="i" #[`opt-${i}`]>
      <slot name="option" :option="opt" :selected="isSelected(opt)">
        <b class="ui-seg__label">{{ labelOf(opt) }}</b>
        <span v-if="sublabelOf(opt)" class="ui-seg__sub">{{ sublabelOf(opt) }}</span>
      </slot>
    </template>
  </QBtnToggle>
</template>
