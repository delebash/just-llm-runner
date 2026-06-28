<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// CompareStrip — Compare MODE for the Feature Workbench (Decision 23, 2026-06-24:
// "Compare is a MODE of the Features test panel, not a parallel surface"). Renders
// N shared <ConfigColumn>s for ONE action over a SHARED test input (a fair
// comparison), in a 2-up + horizontal-scroll strip (NOT capped at 2). "Run all"
// runs the action across every column, ranks them by decode tok/s (+ cost), and a
// column's "Use as production" promotes that winning config (the parent applies it).
//
// SCHEDULER (Decision 23, CORRECTED 2026-06-24): cloud columns run in PARALLEL;
// local-pinned columns run SERIALLY (the bundled runner holds one model at a time
// — true co-residency / router-swap is the GPU-gated residency planner #27/#29).
// Columns with no explicit pin (inherit) join the parallel group best-effort.
import { computed, onMounted, ref } from "vue";

import ConfigColumn from "./ConfigColumn.vue";
import UiButton from "../common/components/UiButton.vue";

const props = defineProps({
  action: { type: String, default: "" },
  baseConfig: { type: Object, default: () => ({}) }, // seed each new column from this
  providers: { type: Array, default: () => [] },
  samplerCatalog: { type: Object, default: () => ({}) },
  switchCatalog: { type: Object, default: () => ({}) },
  vars: { type: Object, default: () => ({}) },
  presets: { type: Array, default: () => [] },
});
const emit = defineEmits(["promote", "save-as", "delete-preset"]);

let nextId = 1;
const columns = ref([]);          // [{ id, config }]
const colRefs = new Map();        // id -> ConfigColumn instance (for run())
const results = ref({});          // id -> result | null
const runningAll = ref(false);

function clone(cfg) {
  return JSON.parse(JSON.stringify(cfg || {}));
}
function addColumn(seed) {
  columns.value.push({ id: nextId++, config: clone(seed || props.baseConfig) });
}
function removeColumn(id) {
  columns.value = columns.value.filter((c) => c.id !== id);
  colRefs.delete(id);
  const { [id]: _drop, ...rest } = results.value;
  results.value = rest;
}
function setColRef(id, el) {
  if (el) colRefs.set(id, el);
  else colRefs.delete(id);
}
function onResult(id, res) {
  results.value = { ...results.value, [id]: res };
}

// A column is "local" when its pinned provider is a local one (→ serial group).
function isLocal(config) {
  const p = props.providers.find((x) => x.id === config?.pin?.providerId);
  return !!p?.local;
}

async function runAll() {
  if (runningAll.value || !props.action) return;
  runningAll.value = true;
  results.value = {};
  try {
    const cloud = columns.value.filter((c) => !isLocal(c.config));
    const local = columns.value.filter((c) => isLocal(c.config));
    // Cloud (+ inherit) columns in parallel.
    await Promise.all(cloud.map((c) => colRefs.get(c.id)?.run?.()));
    // Local-pinned columns serially — one model loads at a time without router mode.
    for (const c of local) {
      await colRefs.get(c.id)?.run?.();
    }
  } finally {
    runningAll.value = false;
  }
}

// Ranking — columns that produced a result, fastest decode first.
const ranked = computed(() =>
  columns.value
    .map((c, i) => ({ col: c, n: i + 1, res: results.value[c.id] }))
    .filter((x) => x.res && x.res.tps)
    .sort((a, b) => b.res.tps - a.res.tps),
);
function colModelLabel(config) {
  const p = config?.pin;
  return p?.model || p?.providerId || "inherited";
}

// ── preset events from a column (the action's shared preset list) ────────────
function presetToConfig(p, base) {
  return {
    ...base,
    pin: p.providerId ? { providerId: p.providerId, model: p.model || "" } : null,
    system: p.system ?? base.system,
    userTemplate: p.userTemplate ?? base.userTemplate,
    temperature: p.temperature ?? base.temperature,
    maxTokens: p.maxTokens ?? base.maxTokens,
    jsonMode: p.jsonMode ?? base.jsonMode,
    topP: p.topP ?? base.topP,
    reasoningEffort: p.reasoningEffort || "",
  };
}
function applyPresetTo(col, id) {
  const p = props.presets.find((x) => x.id === id);
  if (p) col.config = presetToConfig(p, col.config);
}

onMounted(() => {
  // Start 2-up (Decision 23): the current config + a copy to vary.
  addColumn();
  addColumn();
});
</script>

<template>
  <section class="lu-cmp">
    <!-- Shared controls + ranking -->
    <div class="lu-cmp-bar">
      <UiButton intent="primary" size="small" :loading="runningAll" @click="runAll">▶ Run all</UiButton>
      <UiButton intent="secondary" size="small" @click="addColumn()">＋ Add column</UiButton>
      <span class="lu-cmp-hint lu-muted">one action across every column · same test input · cloud parallel, local serial</span>
      <span v-if="ranked.length" class="lu-cmp-rank">
        <span class="lu-cmp-rank-h">Fastest</span>
        <span v-for="(x, i) in ranked" :key="x.col.id" class="lu-cmp-rank-item" :class="{ win: i === 0 }">
          <b>{{ colModelLabel(x.col.config) }}</b> · {{ x.res.tps }} tok/s<template v-if="x.res.cost"> · ${{ x.res.cost < 0.01 ? x.res.cost.toFixed(4) : x.res.cost.toFixed(2) }}</template>
        </span>
      </span>
    </div>

    <!-- 2-up base + horizontal-scroll strip (NOT capped) — Studio-style cards -->
    <div class="lu-cmp-strip">
      <div v-for="(col, i) in columns" :key="col.id" class="lu-cmp-col">
        <ConfigColumn :ref="(el) => setColRef(col.id, el)"
          v-model="col.config" :action="action" :providers="providers"
          :sampler-catalog="samplerCatalog" :switch-catalog="switchCatalog"
          :vars="vars" :presets="presets" :prompt-editable="true"
          :run-stream="null" :busy="runningAll" :removable="columns.length > 1"
          :label="`Config ${i + 1}`" inherit-label="— pick a model —"
          @result="onResult(col.id, $event)"
          @remove="removeColumn(col.id)"
          @use-production="emit('promote', col.config)"
          @apply-preset="applyPresetTo(col, $event)"
          @save-as="emit('save-as', $event, col.config)"
          @delete-preset="emit('delete-preset', $event)" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.lu-cmp { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.lu-cmp-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); position: sticky; top: 0; z-index: 2; }
.lu-cmp-hint { font-size: 11px; }
.lu-cmp-rank { display: inline-flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; margin-left: auto; }
.lu-cmp-rank-h { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--accent-ink, var(--accent)); }
.lu-cmp-rank-item { font-size: 11px; color: var(--ink-2); }
.lu-cmp-rank-item.win b { color: var(--accent-ink, var(--accent)); }
/* The strip: a single row that scrolls horizontally; each column a fixed
   comfortable width so 2 fit at the base and more are reached by scrolling. */
.lu-cmp-strip { display: flex; gap: 14px; overflow-x: auto; align-items: flex-start; padding-bottom: 8px; }
.lu-cmp-col { flex: 0 0 clamp(320px, 42%, 460px); border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--surface); min-width: 0; }
</style>
