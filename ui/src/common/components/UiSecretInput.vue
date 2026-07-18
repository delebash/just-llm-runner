<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Secret text input — WRAPS <UiInput> (never re-forks it) and flips its type
// password ↔ text via an in-field eye toggle. For API keys / passwords that must be
// masked by default but revealable + editable in place (#12). Border, focus ring, and
// sizing all come from UiInput's .ui-input; this only adds the toggle affordance.
import { ref } from "vue";
import UiInput from "./UiInput.vue";
import Icon from "./Icon.vue";

defineProps({
  modelValue: { type: [String, Number], default: "" },
  size: { type: String, default: "regular" }, // small | regular
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  placeholder: { type: String, default: "" },
  autocomplete: { type: String, default: "off" },
  name: { type: String, default: undefined },
  id: { type: String, default: undefined },
  invalid: { type: Boolean, default: false },
  // a11y labels for the reveal toggle (host may localize).
  revealLabel: { type: String, default: "Show" },
  hideLabel: { type: String, default: "Hide" },
});
const emit = defineEmits(["update:modelValue", "blur", "focus", "keydown"]);

const revealed = ref(false);
const inputRef = ref(null);
// Expose focus/select so callers can drive it like a bare <input> (UiInput parity).
defineExpose({
  focus: () => inputRef.value?.focus(),
  select: () => inputRef.value?.select(),
});
</script>

<template>
  <div class="ui-secret">
    <UiInput
      ref="inputRef"
      :type="revealed ? 'text' : 'password'"
      :model-value="modelValue"
      :size="size"
      :disabled="disabled"
      :readonly="readonly"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :name="name"
      :id="id"
      :invalid="invalid"
      @update:model-value="emit('update:modelValue', $event)"
      @blur="emit('blur', $event)"
      @focus="emit('focus', $event)"
      @keydown="emit('keydown', $event)"
    />
    <button
      type="button"
      class="ui-secret__toggle"
      :disabled="disabled"
      :aria-pressed="revealed ? 'true' : 'false'"
      :aria-label="revealed ? hideLabel : revealLabel"
      @click="revealed = !revealed"
    >
      <Icon :name="revealed ? 'EyeOff' : 'Eye'" :size="16" />
    </button>
  </div>
</template>

<style scoped>
.ui-secret { position: relative; display: block; width: 100%; }
/* Room for the toggle so masked text never runs under it. */
.ui-secret :deep(.ui-input) { padding-right: 36px; }
.ui-secret__toggle {
  position: absolute; top: 0; right: 0; height: 100%;
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; padding: 0;
  background: transparent; border: 0; cursor: pointer;
  color: var(--muted);
  border-radius: 0 var(--r-sm, 6px) var(--r-sm, 6px) 0;
  transition: color .12s;
}
.ui-secret__toggle:hover:not(:disabled) { color: var(--ink); }
.ui-secret__toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ui-secret__toggle:disabled { cursor: not-allowed; opacity: .55; }
</style>
