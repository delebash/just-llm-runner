<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The per-hardware recommendation grid (Phase 4) — the primary discovery surface of the
// unified "Models" tab. ROWS = hardware tiers (the detected box highlighted), COLUMNS =
// functions (chat/prose/extract/analysis + other + embed). Each cell = the model(s) that
// FIT that tier for that function: a `quality` pick (best-that-fits) + a `faster` pick (a
// lighter one that also fits), with the cited "why", the Fit badge, and per-pick
// Download/Load + Tune. The grid data is a read-time VIEW (GET /v1/ai/recommendation-grid);
// LIVE download/load status + the load action + the Tune modal are SHARED with the flat
// catalog via useRunnerModels / TuneMeasureModal (one status truth, one poller).
import { computed, onMounted, ref } from "vue";

import { request } from "../client.js";
import { useRunnerModels } from "../common/composables/useRunnerModels.js";
import TuneMeasureModal from "../components/TuneMeasureModal.vue";
import UiButton from "../common/components/UiButton.vue";

// Shared live model state (status) + the load/download action — the SAME singleton the
// flat catalog uses, so the grid's per-pick status matches the catalog's (one truth).
const { models, loadingId, needsEngine, load } = useRunnerModels();

const grid = ref(null);
const loading = ref(true);
const error = ref("");
const hardware = ref(null);
const tuning = ref(null); // null | the model being tuned (opens the shared modal)

async function loadGrid() {
  loading.value = true;
  error.value = "";
  try {
    const [g, hw] = await Promise.all([
      request("/v1/ai/recommendation-grid"),
      request("/v1/llm-runner/hardware").catch(() => null),
    ]);
    grid.value = g;
    hardware.value = hw;
  } catch (e) {
    error.value = e?.message || "Couldn't load the model grid.";
  } finally {
    loading.value = false;
  }
}
onMounted(loadGrid);

const functions = computed(() => grid.value?.functions || []);
const functionLabels = computed(() => grid.value?.functionLabels || {});
const tiers = computed(() => grid.value?.tiers || []);

// Cell lookup (tier key × function key).
const cellIndex = computed(() => {
  const idx = {};
  for (const c of grid.value?.cells || []) idx[`${c.tier}|${c.function}`] = c;
  return idx;
});
function cell(tierKey, fn) {
  return cellIndex.value[`${tierKey}|${fn}`] || null;
}

// "You are here" — the best tier the detected box satisfies (largest vram+ram it can hold).
const detectedTierKey = computed(() => {
  const hw = hardware.value;
  if (!hw) return "";
  const vram = Math.max(0, ...(hw.gpus || []).map((g) => g.vramMb || 0));
  const ram = hw.ramMb || 0;
  let best = "";
  let bestScore = -1;
  for (const t of tiers.value) {
    if (t.vramMb <= vram && t.ramMb <= ram) {
      const score = t.vramMb * 1_000_000 + t.ramMb; // prefer higher VRAM, then RAM
      if (score > bestScore) { bestScore = score; best = t.key; }
    }
  }
  return best;
});

// Live per-model status (from the shared /v1/llm-runner/models), by modelId.
function statusOf(modelId) {
  return models.value.find((m) => m.id === modelId)?.status || "available";
}
</script>

<template>
  <section class="lu-grid-wrap">
    <div class="lu-grid-head">
      <b class="lu-grid-title">Models by hardware &amp; job</b>
      <span class="lu-muted lu-grid-sub">Each cell = the model that fits your tier for that job — <b>quality</b> (best that fits) with a lighter <b>faster</b> option. Download &amp; load right here; the row matching your machine is highlighted.</span>
    </div>

    <div v-if="error" class="lu-error lu-grid-err">{{ error }}</div>
    <div v-else-if="loading" class="lu-grid-empty">Loading the model grid…</div>

    <div v-else class="lu-grid-scroll">
      <table class="lu-grid">
        <thead>
          <tr>
            <th class="lu-grid-corner">Hardware</th>
            <th v-for="f in functions" :key="f">{{ functionLabels[f] || f }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tiers" :key="t.key" :class="{ 'is-you': t.key === detectedTierKey }">
            <th class="lu-grid-tier">
              <span>{{ t.label }}</span>
              <span v-if="t.key === detectedTierKey" class="lu-grid-you">you</span>
            </th>
            <td v-for="f in functions" :key="f" class="lu-grid-td">
              <template v-if="cell(t.key, f) && cell(t.key, f).quality">
                <!-- quality pick -->
                <div class="lu-pk" :title="cell(t.key, f).quality.why">
                  <div class="lu-pk-top">
                    <span class="lu-pk-name">{{ cell(t.key, f).quality.name }}</span>
                    <span class="lu-fit" :class="`lu-fit--${cell(t.key, f).quality.fit}`">{{ cell(t.key, f).quality.fit === "cpu" ? "CPU" : (cell(t.key, f).quality.fit === "tight" ? "Tight" : "Fits") }}</span>
                  </div>
                  <div class="lu-pk-act">
                    <span v-if="statusOf(cell(t.key, f).quality.modelId) === 'loaded'" class="lu-pill lu-pill--run">● loaded</span>
                    <span v-else-if="statusOf(cell(t.key, f).quality.modelId) === 'loading'" class="lu-muted lu-pk-wait">working…</span>
                    <span v-else-if="statusOf(cell(t.key, f).quality.modelId) === 'error'" class="lu-pk-err">{{ needsEngine ? "install engine" : "failed" }}</span>
                    <UiButton v-else-if="statusOf(cell(t.key, f).quality.modelId) === 'disk'" intent="primary" size="small"
                      :loading="loadingId === cell(t.key, f).quality.modelId" @click="load(cell(t.key, f).quality.modelId)">Load</UiButton>
                    <UiButton v-else intent="secondary" size="small"
                      :loading="loadingId === cell(t.key, f).quality.modelId" @click="load(cell(t.key, f).quality.modelId)">Download</UiButton>
                    <UiButton v-if="['loaded', 'disk'].includes(statusOf(cell(t.key, f).quality.modelId))" intent="ghost" size="small"
                      title="Tune &amp; measure" @click="tuning = { id: cell(t.key, f).quality.modelId, name: cell(t.key, f).quality.name }">Tune</UiButton>
                  </div>
                </div>
                <!-- faster pick (a lighter model that also fits) -->
                <div v-if="cell(t.key, f).faster" class="lu-pk lu-pk--faster" :title="cell(t.key, f).faster.why">
                  <span class="lu-pk-fasterlbl">faster</span>
                  <span class="lu-pk-name">{{ cell(t.key, f).faster.name }}</span>
                  <UiButton v-if="statusOf(cell(t.key, f).faster.modelId) === 'available'" intent="ghost" size="small"
                    :loading="loadingId === cell(t.key, f).faster.modelId" @click="load(cell(t.key, f).faster.modelId)">get</UiButton>
                  <span v-else-if="statusOf(cell(t.key, f).faster.modelId) === 'loaded'" class="lu-pill lu-pill--run">●</span>
                  <UiButton v-else-if="statusOf(cell(t.key, f).faster.modelId) === 'disk'" intent="ghost" size="small"
                    :loading="loadingId === cell(t.key, f).faster.modelId" @click="load(cell(t.key, f).faster.modelId)">load</UiButton>
                </div>
              </template>
              <span v-else class="lu-muted lu-grid-none">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <TuneMeasureModal v-if="tuning" :model="tuning" @close="tuning = null" />
  </section>
</template>

<style scoped>
.lu-grid-wrap { display: flex; flex-direction: column; gap: 10px; }
.lu-grid-head { display: flex; flex-direction: column; gap: 2px; }
.lu-grid-title { font-size: 14px; color: var(--ink); }
.lu-grid-sub { font-size: 11.5px; }
.lu-grid-err { margin: 4px 0; }
.lu-grid-empty { font-size: 12.5px; color: var(--muted); padding: 18px; text-align: center; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm, 8px); }
.lu-grid-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.lu-grid { border-collapse: collapse; font-size: 12px; width: 100%; }
.lu-grid th, .lu-grid td { border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); padding: 8px 10px; vertical-align: top; text-align: left; }
.lu-grid thead th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; white-space: nowrap; }
.lu-grid-corner { left: 0; z-index: 2; }
.lu-grid tbody tr:last-child th, .lu-grid tbody tr:last-child td { border-bottom: 0; }
.lu-grid th:last-child, .lu-grid td:last-child { border-right: 0; }
.lu-grid-tier { position: sticky; left: 0; background: var(--surface-2); white-space: nowrap; font-weight: 700; color: var(--ink-2); display: flex; align-items: center; gap: 7px; }
.lu-grid tr.is-you .lu-grid-tier { background: var(--accent-soft); color: var(--accent-ink, var(--accent)); }
.lu-grid tr.is-you td { background: color-mix(in srgb, var(--accent-soft) 40%, transparent); }
.lu-grid-you { font-size: 9px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: var(--on-accent, #fff); }
.lu-grid-td { min-width: 168px; }
.lu-grid-none { font-size: 13px; }

.lu-pk { display: flex; flex-direction: column; gap: 4px; }
.lu-pk-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lu-pk-name { font-weight: 600; color: var(--ink); font-size: 11.5px; }
.lu-pk-act { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lu-pk-wait { font-size: 10.5px; }
.lu-pk-err { font-size: 10.5px; color: var(--danger); }
.lu-pk--faster { flex-direction: row; align-items: center; gap: 6px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); flex-wrap: wrap; }
.lu-pk--faster .lu-pk-name { font-weight: 500; color: var(--ink-2); font-size: 10.5px; }
.lu-pk-fasterlbl { font-size: 9px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
/* .lu-pill* comes from shared common/styles.css (same badge as the model catalog). */
</style>
