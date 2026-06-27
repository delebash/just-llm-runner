<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// KnobGrid — ONE generic key/value editor for BOTH Plane-1 engine switches and
// Plane-2 samplers (design D15). Add a row, type a name + value, remove. So a NEW
// llama.cpp param needs no code — just a row (it flows through extra_flags / extra).
// v-model is an array of { name, value }. An optional `catalog`
// (name -> { label, help, options }) enriches KNOWN knobs with a label + typed
// input; unknown knobs stay raw rows (the future-proof escape).
import { computed } from "vue";

import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";

const props = defineProps({
  modelValue: { type: Array, default: () => [] }, // [{ name, value }]
  catalog: { type: Object, default: () => ({}) }, // name -> { label, help, options }
  namePlaceholder: { type: String, default: "flag (e.g. ctx_len)" },
  valuePlaceholder: { type: String, default: "value" },
  addLabel: { type: String, default: "＋ Add switch" },
});
const emit = defineEmits(["update:modelValue"]);

const rows = computed(() => props.modelValue || []);
function commit(next) {
  emit("update:modelValue", next);
}
function patch(i, key, v) {
  commit(rows.value.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
}
function add() {
  commit([...rows.value, { name: "", value: "" }]);
}
function remove(i) {
  commit(rows.value.filter((_, j) => j !== i));
}
function meta(name) {
  return props.catalog?.[name] || null;
}
</script>

<template>
  <div class="ui-kg">
    <div v-for="(r, i) in rows" :key="i" class="ui-kg-row">
      <UiInput
        :model-value="r.name"
        :placeholder="namePlaceholder"
        class="ui-kg-name"
        :title="meta(r.name)?.help || ''"
        @update:model-value="patch(i, 'name', $event)"
      />
      <UiSelect
        v-if="meta(r.name)?.options"
        :model-value="r.value"
        :options="meta(r.name).options"
        @update:model-value="patch(i, 'value', $event)"
      />
      <UiInput
        v-else
        :model-value="r.value"
        :placeholder="valuePlaceholder"
        @update:model-value="patch(i, 'value', $event)"
      />
      <UiButton intent="ghost" size="small" title="Remove" @click="remove(i)">✕</UiButton>
    </div>
    <UiButton intent="ghost" size="small" @click="add">{{ addLabel }}</UiButton>
  </div>
</template>

<style scoped>
.ui-kg { display: flex; flex-direction: column; gap: 7px; }
.ui-kg-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; }
.ui-kg-name :deep(input) { font-family: var(--font-mono, monospace); }
</style>
