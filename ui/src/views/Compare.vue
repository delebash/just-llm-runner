<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Compare lab — run ONE AI action across N model/param/sampler configs and rank
// them by decode tok/s (and time / tokens). Each column is a shared
// <ConfigColumn> (the SAME unit the Feature Workbench uses for its single editor,
// so the run + tok/s logic isn't copied — T3). The action + the test input (vars)
// are shared across every column so the comparison is apples-to-apples; columns
// differ only by model + params + samplers.
//
// Runs are SEQUENTIAL: the bundled local runner holds one model at a time, so
// firing N local models at once would thrash it (true co-residency is the
// GPU-gated residency planner, #27/#29). Cloud columns still work fine here.
import { computed, onMounted, ref } from "vue";

import { request } from "../client.js";
import ConfigColumn from "../components/ConfigColumn.vue";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTextarea from "../common/components/UiTextarea.vue";

const prompts = ref([]);
const features = ref([]);
const providers = ref([]);
const knobCatalog = ref([]);
const loading = ref(true);
const error = ref("");
const runningAll = ref(false);

const samplerCatalog = computed(() =>
  Object.fromEntries(
    knobCatalog.value
      .filter((k) => k.plane === 2)
      .map((k) => [k.flagName, { label: k.label, help: k.help, options: k.options?.length ? k.options : undefined }]),
  ),
);

const featLabel = computed(() => Object.fromEntries(features.value.map((f) => [f.key, f.label])));
function actionLabel(p) {
  if (p.label) return p.label;
  return p.key;
}
const actionOptions = computed(() =>
  prompts.value
    .map((p) => ({ value: p.key, label: `${featLabel.value[p.feature] || p.feature} · ${actionLabel(p)}` }))
    .sort((a, b) => a.label.localeCompare(b.label)),
);

const selAction = ref("");
const actionSpec = computed(() => prompts.value.find((p) => p.key === selAction.value) || null);

// Shared test input — the {{variables}} the selected action's prompt references.
const vars = ref({});
function buildVars() {
  const s = actionSpec.value;
  const next = {};
  const tpl = `${s?.userTemplate || ""}\n${s?.system || ""}`;
  const found = new Set([...tpl.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]));
  for (const v of found) next[v] = vars.value[v] || "";
  if (!found.size) next.user_content = vars.value.user_content || "";
  vars.value = next;
}
function humanizeVar(k) {
  const s = String(k).replace(/[_-]+/g, " ").replace(/([a-z\d])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : k;
}
function pickAction(key) {
  selAction.value = key;
  buildVars();
}

// Columns — each its own ConfigColumn config + last result, addressed by id.
let nextId = 1;
function blankConfig() {
  return { pin: null, temperature: "", topP: "", maxTokens: 0, think: false, jsonMode: false, samplers: [] };
}
const columns = ref([]);
const colRefs = new Map(); // id -> ConfigColumn instance (for run())
const results = ref({});   // id -> result | null
function setColRef(id, el) {
  if (el) colRefs.set(id, el);
  else colRefs.delete(id);
}
function addColumn() {
  columns.value.push({ id: nextId++, config: blankConfig() });
}
function removeColumn(id) {
  columns.value = columns.value.filter((c) => c.id !== id);
  colRefs.delete(id);
  const { [id]: _drop, ...rest } = results.value;
  results.value = rest;
}
function onResult(id, res) {
  results.value = { ...results.value, [id]: res };
}

async function runAll() {
  if (!selAction.value || runningAll.value) return;
  runningAll.value = true;
  error.value = "";
  results.value = {};
  try {
    // Sequential: one local model loads at a time (see header note).
    for (const col of columns.value) {
      const inst = colRefs.get(col.id);
      if (inst?.run) await inst.run();
    }
  } finally {
    runningAll.value = false;
  }
}

// Ranking — columns that produced a result, fastest decode first.
const ranked = computed(() =>
  columns.value
    .map((c, i) => ({ col: c, i, res: results.value[c.id] }))
    .filter((x) => x.res && x.res.tps)
    .sort((a, b) => b.res.tps - a.res.tps),
);
function colModelLabel(col) {
  const p = col.config?.pin;
  return p?.model || p?.providerId || "inherited";
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [p, r, pl] = await Promise.all([
      request("/v1/ai/prompts"),
      request("/v1/ai/routing"),
      request("/v1/llm-providers"),
    ]);
    prompts.value = p.prompts || [];
    features.value = r.features || [];
    providers.value = pl.providers || [];
    try { knobCatalog.value = (await request("/v1/ai/knob-catalog")).knobs || []; }
    catch { knobCatalog.value = []; }
    if (!selAction.value && prompts.value.length) pickAction(actionOptions.value[0]?.value || prompts.value[0].key);
    if (!columns.value.length) { addColumn(); addColumn(); }
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="lu-cmp">
    <p class="lu-muted lu-cmp-lede">
      Run one action across several model + sampler configs and compare decode speed + output.
      The action and the test input are shared; each column varies the model and how it runs.
    </p>

    <div v-if="error" class="lu-error">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else>
      <!-- Shared action + input -->
      <div class="lu-cmp-shared">
        <div class="lu-cmp-field">
          <label>Action</label>
          <UiSelect :model-value="selAction" :options="actionOptions" @update:model-value="pickAction" />
        </div>
        <div v-for="(_, k) in vars" :key="k" class="lu-cmp-field">
          <label>{{ humanizeVar(k) }}</label>
          <UiTextarea :model-value="vars[k]" auto-resize :rows="2" @update:model-value="vars[k] = $event" />
        </div>
        <div class="lu-cmp-actions">
          <UiButton intent="primary" size="small" :loading="runningAll" @click="runAll">▶ Run all</UiButton>
          <UiButton intent="secondary" size="small" @click="addColumn">＋ Add column</UiButton>
        </div>
      </div>

      <!-- Ranking summary (after a run) -->
      <div v-if="ranked.length" class="lu-cmp-rank">
        <span class="lu-cmp-rank-h">Ranked by speed</span>
        <span v-for="(x, n) in ranked" :key="x.col.id" class="lu-cmp-rank-item" :class="{ win: n === 0 }">
          <b>{{ colModelLabel(x.col) }}</b> · {{ x.res.tps }} tok/s · {{ x.res.ms }} ms
        </span>
      </div>

      <!-- Columns -->
      <div class="lu-cmp-cols">
        <div v-for="(col, i) in columns" :key="col.id" class="lu-cmp-col">
          <div class="lu-cmp-col-h">
            <span class="lu-cmp-col-n">Config {{ i + 1 }}</span>
            <span class="lu-cmp-spacer" />
            <UiButton v-if="columns.length > 1" intent="ghost" size="small" title="Remove column" @click="removeColumn(col.id)">✕</UiButton>
          </div>
          <ConfigColumn :ref="(el) => setColRef(col.id, el)"
            v-model="col.config" :action="selAction" :providers="providers"
            :sampler-catalog="samplerCatalog" :vars="vars"
            inherit-label="— pick a model —"
            @result="onResult(col.id, $event)" />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.lu-cmp { display: flex; flex-direction: column; gap: 14px; }
.lu-cmp-lede { font-size: 12.5px; margin: 0; max-width: 75ch; }
.lu-cmp-shared { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface-2); }
.lu-cmp-field { display: flex; flex-direction: column; gap: 5px; }
.lu-cmp-field > label { font-size: 12px; color: var(--muted); }
.lu-cmp-actions { display: flex; gap: 10px; margin-top: 2px; }
.lu-cmp-rank { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 9px 12px; border: 1px solid var(--accent-line, var(--accent)); background: var(--accent-soft); border-radius: 9px; }
.lu-cmp-rank-h { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--accent-ink, var(--accent)); }
.lu-cmp-rank-item { font-size: 11.5px; color: var(--ink-2); }
.lu-cmp-rank-item.win b { color: var(--accent-ink, var(--accent)); }
.lu-cmp-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; align-items: start; }
.lu-cmp-col { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--surface); min-width: 0; }
.lu-cmp-col-h { display: flex; align-items: center; margin-bottom: 8px; }
.lu-cmp-col-n { font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.lu-cmp-spacer { flex: 1; }
</style>
