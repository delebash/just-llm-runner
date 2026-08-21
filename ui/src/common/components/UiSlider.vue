<!-- SPDX-License-Identifier: MIT -->
<script setup>
// Shared range control — THE slider for every app in the family.
//
// Born 2026-08-21: there was no slider in the kit, so every surface that
// needed one hand-rolled `<input type="range">` with its own width and its own
// idea of where the number goes. JustVoice alone had 13 (Generate 6, Settings
// 3, Voices 4) and this kit's own AppearancePanel had a 14th. They disagreed
// on all of it.
//
// What a hand-rolled range kept getting wrong, and this solves once:
//   - the VALUE was invisible, or lived in a separate <UiInput> wired by hand
//   - a slider was never SIZED — it stretched to whatever box held it, against
//     the layout law (a control ends where its content ends)
//   - a range's ends mean something ("neutral", "original", "extreme") and
//     there was nowhere to say so, so the meaning went in prose above it
//   - the keyboard/ARIA story was whatever the browser gave you
//
// Usage:
//   <UiSlider v-model="k" :min="0" :max="3" :step="0.1" width="regular"
//             :marks="[{ value: 0, label: 'neutral' }, { value: 3, label: 'extreme' }]" />
//   <UiSlider v-model="w" :min="0" :max="1" :step="0.05" :format="pctOf" readout />
//
// The number box is EDITABLE by default (type an exact value; a slider alone
// can't hit 0.35 reliably). `readout` makes it display-only. `:format` styles
// what that box shows without changing the model value.

import { computed, ref, watch } from "vue";

import UiInput from "./UiInput.vue";

const props = defineProps({
  modelValue: { type: [Number, String, null], default: 0 },
  min:  { type: [Number, String], default: 0 },
  max:  { type: [Number, String], default: 1 },
  step: { type: [Number, String], default: 0.01 },
  disabled: { type: Boolean, default: false },
  // Track width, content-typed like UiInput's `width` — never "fill the box".
  // short 120px · regular 200px · long 320px · full = whatever contains it.
  width: { type: String, default: "regular" },
  // false = no number at all (the marks carry the meaning).
  showNumber: { type: Boolean, default: true },
  // true = show the value but don't let it be typed.
  readout: { type: Boolean, default: false },
  // (n) => string for the number box. Defaults to trimming float noise.
  format: { type: Function, default: null },
  // Ticks under the track: [{ value, label }]. Positioned by value, so they
  // stay put when min/max change.
  marks: { type: Array, default: () => [] },
  ariaLabel: { type: String, default: undefined },
  id: { type: String, default: undefined },
  name: { type: String, default: undefined },
});
const emit = defineEmits(["update:modelValue", "change"]);

const nMin = computed(() => Number(props.min));
const nMax = computed(() => Number(props.max));
const nStep = computed(() => Number(props.step) || 0.01);

const value = computed(() => {
  const v = Number(props.modelValue);
  return Number.isFinite(v) ? v : nMin.value;
});

/** 0.30000000000000004 is a real slider output; nobody wants to read it. */
function tidy(n) {
  if (!Number.isFinite(n)) return "";
  const decimals = String(nStep.value).split(".")[1]?.length ?? 0;
  return decimals ? String(Number(n.toFixed(decimals))) : String(Math.round(n));
}
const shown = computed(() =>
  props.format ? props.format(value.value) : tidy(value.value),
);

function clamp(n) {
  return Math.min(nMax.value, Math.max(nMin.value, n));
}

function setValue(n, evt) {
  const next = clamp(Number(n));
  if (!Number.isFinite(next)) return;
  emit("update:modelValue", next);
  if (evt === "change") emit("change", next);
}

// While the number box is being typed in, the raw string is preserved so the
// caret doesn't jump; it commits on blur/Enter. A half-typed "-" or "0." is
// not a value yet.
const typing = ref(null);
watch(value, () => { typing.value = null; });
const numberText = computed(() => (typing.value !== null ? typing.value : shown.value));

function onType(s) {
  typing.value = s;
  const n = Number(s);
  if (s !== "" && s !== "-" && Number.isFinite(n)) setValue(n);
}
function onCommit() {
  const n = Number(typing.value);
  typing.value = null;
  if (Number.isFinite(n)) setValue(n, "change");
}

const markPos = (m) => {
  const span = nMax.value - nMin.value;
  if (!span) return 0;
  return ((clamp(Number(m.value)) - nMin.value) / span) * 100;
};
</script>

<template>
  <div class="ui-slider" :class="[`ui-slider--${width}`, { 'is-disabled': disabled }]">
    <div class="ui-slider-row">
      <input
        :id="id"
        :name="name"
        type="range"
        class="ui-slider-range"
        :min="nMin"
        :max="nMax"
        :step="nStep"
        :value="value"
        :disabled="disabled"
        :aria-label="ariaLabel"
        :aria-valuetext="shown"
        @input="setValue($event.target.value)"
        @change="setValue($event.target.value, 'change')"
      />
      <span v-if="showNumber && readout" class="ui-slider-readout">{{ shown }}</span>
      <UiInput
        v-else-if="showNumber"
        class="ui-slider-number"
        width="num"
        size="small"
        :disabled="disabled"
        :modelValue="numberText"
        @update:modelValue="onType"
        @blur="onCommit"
        @keydown.enter="onCommit"
      />
    </div>
    <div v-if="marks.length" class="ui-slider-marks">
      <span
        v-for="m in marks"
        :key="`${m.value}`"
        class="ui-slider-mark"
        :style="{ left: `${markPos(m)}%` }"
      >{{ m.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.ui-slider {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
}
.ui-slider-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* Content-typed widths — a slider is a control, not a layout filler. */
.ui-slider--short  .ui-slider-range { width: 120px; }
.ui-slider--regular .ui-slider-range { width: 200px; }
.ui-slider--long   .ui-slider-range { width: 320px; }
.ui-slider--full   { display: flex; }
.ui-slider--full   .ui-slider-range { width: 100%; }

.ui-slider-range {
  accent-color: var(--accent);
  height: 18px;
  cursor: pointer;
}
.ui-slider-range:disabled { cursor: not-allowed; opacity: .55; }
.ui-slider-range:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring, 0 0 0 3px var(--accent-soft));
  border-radius: 999px;
}

.ui-slider-readout {
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
  color: var(--ink, inherit);
  min-width: 3ch;
}
/* The number box rides UiInput's own visual; only its rhythm is set here. */
.ui-slider-number { flex: 0 0 auto; }

/* Marks sit under the track, anchored at their VALUE. The first and last are
   pulled inside so an end label never overhangs the control. */
.ui-slider-marks {
  position: relative;
  height: 1.1em;
  /* Only as wide as the track, so a mark at 100% lands on the track's end
     rather than past the number box. */
  width: 100%;
  max-width: 320px;
  font-size: 12.5px;
  color: var(--muted);
}
.ui-slider--short .ui-slider-marks { max-width: 120px; }
.ui-slider--regular .ui-slider-marks { max-width: 200px; }
.ui-slider-mark {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}
.ui-slider-mark:first-child { transform: none; }
.ui-slider-mark:last-child { transform: translateX(-100%); }

.ui-slider.is-disabled { opacity: .7; }
</style>
