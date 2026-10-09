<!-- SPDX-License-Identifier: MIT -->
<script setup>
// Compact color picker — a small colored swatch trigger that opens a floating
// popover with preset squares + a "Custom color" affordance that fires the
// browser-native color input for anything off-palette. Supersedes JwColorPicker.
//
// The `presets` are passed in (app domain data, not baked into the kit); a
// neutral 12-swatch default lets it work out of the box.
//
// The popover is Quasar's QMenu (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md): it sits under the swatch, opens and closes on
// the swatch's click, closes on an outside click or Esc, and takes focus while open (Tab reaches
// the presets; the swatch gets it back on close). What's in it stays the kit's: the preset
// squares and the browser's own colour dialog behind "Custom color" (Quasar's QColor picker would
// replace both). The look: ../../quasar/theme.css, "Color picker".

import { computed, ref } from "vue";
import { QMenu } from "quasar";

const props = defineProps({
  modelValue: { type: String, default: "" },
  ariaLabel:  { type: String, default: "Color" },
  size:       { type: Number, default: 24 },
  // Neutral 12-swatch fallback; the host passes its own palette. Inlined (not a
  // const) because defineProps default factories are hoisted out of setup scope.
  presets:    { type: Array, default: () => [
    "oklch(0.62 0.16 25)",  "oklch(0.70 0.15 60)",  "oklch(0.80 0.14 90)",
    "oklch(0.72 0.15 130)", "oklch(0.62 0.12 165)", "oklch(0.62 0.11 200)",
    "oklch(0.55 0.16 250)", "oklch(0.55 0.18 290)", "oklch(0.62 0.18 330)",
    "oklch(0.50 0.02 250)", "oklch(0.65 0.02 250)", "oklch(0.80 0.01 250)",
  ] },
});
const emit = defineEmits(["update:modelValue"]);

const open = ref(false);
function close() { open.value = false; }

function pickPreset(color) {
  emit("update:modelValue", color);
  close();
}

// Native <input type="color"> only speaks #RRGGBB hex. Use canvas to translate
// the current oklch (or named) value to hex so the picker starts on the color
// the user already sees — the browser normalizes the color space via fillStyle.
const customHexValue = computed(() => {
  const v = String(props.modelValue || "");
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d");
    ctx.fillStyle = v || "#888";
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const hex = (n) => n.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return "#888888";
  }
});

function onCustomChange(e) {
  emit("update:modelValue", e.target.value);
  close();
}

</script>

<template>
  <div class="ui-color-picker">
    <button
      type="button"
      class="ui-color-swatch"
      :class="{ open }"
      :style="{ background: modelValue, width: `${size}px`, height: `${size}px` }"
      :aria-label="ariaLabel"
      :aria-expanded="open"
    >
      <QMenu
        v-model="open"
        class="ui-color-pop"
        anchor="bottom left"
        self="top left"
        :offset="[0, 6]"
        :transition-duration="0"
      >
        <div class="ui-color-presets">
          <button
            v-for="(c, i) in presets" :key="c"
            type="button"
            class="ui-color-preset"
            :class="{ active: c === modelValue }"
            :style="{ background: c }"
            :aria-label="`Preset ${i + 1}`"
            @click="pickPreset(c)" />
        </div>
        <label class="ui-color-custom">
          <span class="ui-color-custom-swatch"></span>
          <span class="ui-color-custom-label">Custom color</span>
          <input
            type="color"
            class="ui-color-custom-input"
            :value="customHexValue"
            :aria-label="`${ariaLabel} — custom`"
            @change="onCustomChange" />
        </label>
      </QMenu>
    </button>
  </div>
</template>

<style scoped>
.ui-color-picker { display: inline-block; line-height: 0; }

.ui-color-swatch {
  appearance: none; border: 1px solid var(--border);
  border-radius: var(--r-sm, 6px); cursor: pointer; padding: 0;
  box-shadow: inset 0 0 0 1px var(--shadow-soft, rgba(0,0,0,.06));
  transition: transform .08s ease, box-shadow .12s ease;
}
.ui-color-swatch:hover { transform: scale(1.08); }
.ui-color-swatch.open {
  box-shadow: inset 0 0 0 1px var(--shadow-soft, rgba(0,0,0,.06)), 0 0 0 2px var(--surface), 0 0 0 3px var(--accent);
}
.ui-color-swatch:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--shadow-soft, rgba(0,0,0,.06)), 0 0 0 3px var(--accent-soft);
}

/* the popover itself (.ui-color-pop) is QMenu's, teleported out of this scope: the kit's theme */
.ui-color-presets {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
  margin-bottom: 12px;
}
.ui-color-preset {
  appearance: none; border: 0;
  width: 100%; aspect-ratio: 1;
  border-radius: 5px; cursor: pointer;
  box-shadow: inset 0 0 0 1px var(--shadow-soft, rgba(0,0,0,.06));
  transition: transform .08s ease;
}
.ui-color-preset:hover { transform: scale(1.08); }
.ui-color-preset.active {
  box-shadow: inset 0 0 0 1px var(--shadow-soft, rgba(0,0,0,.06)), 0 0 0 2px var(--surface), 0 0 0 3px var(--accent);
}
.ui-color-preset:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.ui-color-custom {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 6px);
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease;
}
.ui-color-custom:hover { background: var(--surface-2); border-color: var(--border-strong, var(--border)); }
.ui-color-custom-swatch {
  width: 22px; height: 22px; border-radius: 5px;
  background: conic-gradient(from 0deg,
    oklch(0.65 0.18 25), oklch(0.75 0.16 60), oklch(0.85 0.15 90),
    oklch(0.80 0.16 130), oklch(0.65 0.14 165), oklch(0.65 0.12 200),
    oklch(0.55 0.18 250), oklch(0.55 0.20 290), oklch(0.65 0.20 330),
    oklch(0.65 0.18 25));
  box-shadow: inset 0 0 0 1px var(--shadow-soft, rgba(0,0,0,.06));
  flex-shrink: 0;
}
.ui-color-custom-label { font-size: 13px; color: var(--ink); font-family: inherit; }
.ui-color-custom-input {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  opacity: 0; cursor: pointer;
  border: 0; padding: 0; margin: 0;
}
</style>
