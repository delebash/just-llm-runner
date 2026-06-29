<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// AssignPresets — the preset-assignment surface (2026-06-29 lab+preset model).
// Assign which engine PRESET each kind of feature runs: a global Default + one
// per CATEGORY. Presets are built + tested in the Lab (Tuning); this is the
// "assign 1-many features to a preset" page — the old jobs shape, now
// preset-by-category. A single feature can still override in Routing-by-feature.
import { computed, onMounted, ref } from "vue";

import { request } from "../client.js";
import UiSelect from "../common/components/UiSelect.vue";

const enginePresets = ref([]);
const assign = ref({ defaultPresetId: "", categories: {}, features: {} });
const categories = ref([]);
const loading = ref(true);
const error = ref("");

const presetOptions = computed(() => [
  { value: "", label: "— none —" },
  ...enginePresets.value.map((p) => ({ value: p.id, label: p.name })),
]);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [pr, asg, routing] = await Promise.all([
      request("/v1/ai/engine-presets"),
      request("/v1/ai/preset-assignments"),
      request("/v1/ai/routing"),
    ]);
    enginePresets.value = pr.presets || [];
    assign.value = { defaultPresetId: "", categories: {}, features: {}, ...asg };
    const s = new Set();
    for (const f of routing.features || []) if (f.category) s.add(f.category);
    categories.value = [...s].sort();
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function setDefault(id) {
  assign.value = await request("/v1/ai/preset-assignments/default", { method: "PUT", body: { presetId: id } });
}
async function setCategory(cat, id) {
  assign.value = await request("/v1/ai/preset-assignments/category", { method: "PUT", body: { category: cat, presetId: id } });
}
</script>

<template>
  <section class="ap">
    <p class="ap-lede lu-muted">
      Assign which preset each kind of feature runs. Build + test presets in <b>Tuning</b>;
      a single feature can override in <b>Routing by feature</b>.
    </p>

    <div v-if="error" class="lu-error">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else>
      <div v-if="!enginePresets.length" class="ap-empty lu-muted">
        No presets yet — build one in the <b>Tuning</b> tab first.
      </div>

      <div class="ap-row ap-default">
        <span class="ap-k">Default <span class="lu-muted">— everything, unless overridden</span></span>
        <UiSelect :model-value="assign.defaultPresetId || ''" :options="presetOptions" @update:model-value="setDefault" />
      </div>

      <div class="ap-cats">
        <div class="ap-cats-h">By category</div>
        <div v-for="cat in categories" :key="cat" class="ap-row">
          <span class="ap-k">{{ cat }}</span>
          <UiSelect :model-value="assign.categories[cat] || ''" :options="presetOptions" @update:model-value="(v) => setCategory(cat, v)" />
        </div>
        <div v-if="!categories.length" class="ap-empty lu-muted">No feature categories found.</div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ap { display: flex; flex-direction: column; gap: 12px; }
.ap-lede { font-size: 12.5px; margin: 0; max-width: 72ch; }
.ap-empty { font-size: 12px; padding: 10px; text-align: center; background: var(--surface-2); border-radius: 8px; }
.ap-row { display: grid; grid-template-columns: minmax(200px, 300px) minmax(0, 1fr); gap: 12px; align-items: center; padding: 4px 0; }
.ap-default { border-bottom: 1px solid var(--border); padding-bottom: 12px; }
.ap-k { font-size: 12.5px; color: var(--ink-2); }
.ap-cats { display: flex; flex-direction: column; gap: 6px; }
.ap-cats-h { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin: 6px 0 2px; }
</style>
