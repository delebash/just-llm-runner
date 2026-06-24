<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared model picker — a free-text input (type any model id) + a dropdown of
// fetched models + a Fetch button. The ONE consistent chat/embedding picker in
// the provider form (mirrors the mock's cb() / JustWrite's Combobox). Visual
// rules in styles.css (.lu-cb*).
import { computed, ref } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  // items: array of "id" strings OR { id, label } objects
  items: { type: Array, default: () => [] },
  placeholder: { type: String, default: "Fetch or type a model id" },
  loading: { type: Boolean, default: false },
  // Show the inline Fetch/Refresh button. Off when the host already fetches the
  // list itself (e.g. LuModelPicker auto-fetches on provider change).
  showFetch: { type: Boolean, default: true },
  // Greyed-out + non-interactive (e.g. no provider picked yet).
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "fetch"]);

const open = ref(false);
const norm = computed(() =>
  props.items.map((m) => (typeof m === "string" ? { id: m, label: m } : { id: m.id, label: m.label || m.id })),
);
// Filter the dropdown by what's typed (substring, case-insensitive).
const filtered = computed(() => {
  const q = (props.modelValue || "").toLowerCase();
  return q ? norm.value.filter((m) => m.id.toLowerCase().includes(q)) : norm.value;
});
function pick(id) {
  emit("update:modelValue", id);
  open.value = false;
}
</script>

<template>
  <div class="lu-cb-wrap">
    <div class="lu-cb">
      <input
        class="lu-cb-in"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        @input="$emit('update:modelValue', $event.target.value)"
        @focus="open = !disabled && norm.length > 0"
        @blur="open = false"
      />
      <span v-if="!disabled" class="lu-cb-chev" role="button" tabindex="-1" @mousedown.prevent="open = !open">▾</span>
      <div v-if="open" class="lu-cb-list">
        <div v-for="m in filtered" :key="m.id" @mousedown.prevent="pick(m.id)">{{ m.label }}</div>
        <div v-if="!filtered.length" class="lu-cb-empty">{{ items.length ? "No match" : (showFetch ? "No models yet — Fetch first" : "No models listed — type one") }}</div>
      </div>
    </div>
    <button v-if="showFetch" class="lu-btn lu-btn--secondary lu-btn--small" type="button" :disabled="loading" @click="$emit('fetch')">
      {{ loading ? "…" : (items.length ? "↻ Refresh" : "Fetch") }}
    </button>
  </div>
</template>
