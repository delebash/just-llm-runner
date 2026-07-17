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
// What the user TYPED this session — NOT the selected value. null = "not typing" ⇒ the
// list shows everything. Filtering on `modelValue` (until 2026-07-16, user-found) made a
// picked value filter the list down to ITSELF: with gemma-4-26b-a4b-qat selected, every
// other downloaded model was invisible — on every provider, permanently, because the
// value can only ever match itself. A combobox filters by the QUERY; the selection is a
// result, never the filter.
const query = ref(null);
const filtered = computed(() => {
  const q = (query.value || "").toLowerCase();
  return q ? norm.value.filter((m) => m.id.toLowerCase().includes(q)) : norm.value;
});
function onInput(e) {
  query.value = e.target.value; // typing narrows; free text stays allowed
  emit("update:modelValue", e.target.value);
  open.value = !props.disabled;
}
function pick(id) {
  emit("update:modelValue", id);
  query.value = null; // a pick ends the query — reopening shows the full list
  open.value = false;
}
function openList(v) {
  if (v) query.value = null; // opening (focus / chevron) always offers everything
  open.value = v;
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
        @input="onInput"
        @focus="openList(!disabled && norm.length > 0)"
        @blur="openList(false)"
      />
      <span v-if="!disabled" class="lu-cb-chev" role="button" tabindex="-1" @mousedown.prevent="openList(!open)">▾</span>
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
