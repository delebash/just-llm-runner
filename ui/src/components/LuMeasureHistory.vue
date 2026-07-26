<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The measurement HISTORY drawer (#142 rows 5+6, 2026-07-07) — a collapsed
// `<details>` inside a model's Tune modal (the LuClassTunes drawer precedent,
// per-model only). Every real decode-speed result persists in the DB — the Tune
// modal's "Load & measure" numbers and every successful auto-tune trial — so
// "what did this config measure?" survives closing the dialog and restarting
// the app. The user owns the ledger: **Clear history** (the user's ask) deletes
// this model's recorded measurements after a confirm. Lazy-loads on first open;
// the modal calls the exposed reload() after recording a new measurement so an
// open drawer stays live.
import { computed, ref } from "vue";

import Icon from "../common/components/Icon.vue";
import UiButton from "../common/components/UiButton.vue";
import UiTable from "../common/components/UiTable.vue";
import UiTag from "../common/components/UiTag.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { clearMeasurements, listMeasurements } from "../measurements.js";

// The shared UiTable's column config (2026-07-24 migration off a hand-rolled <table>).
// Deliberately NOT sortable: this table never had sorting and the migration is meant to be
// behaviour-preserving — sorting can be switched on per column later by adding `sortable`.
const HISTORY_COLUMNS = [
  { id: "when", accessorKey: "startedAt", header: "When" },
  { id: "run", accessorKey: "label", header: "Run" },
  { id: "settings", accessorKey: "id", header: "Settings" },
  { id: "tps", accessorKey: "tokensPerSec", header: "tok/s",
    headerStyle: { textAlign: "right" }, cellStyle: { textAlign: "right", whiteSpace: "nowrap" } },
  { id: "vram", accessorKey: "vramTotalMb", header: "VRAM",
    headerStyle: { textAlign: "right" }, cellStyle: { textAlign: "right", whiteSpace: "nowrap" } },
];

const props = defineProps({
  modelId: { type: String, required: true },
});

const loaded = ref(false);
const loading = ref(false);
const error = ref("");
const clearing = ref(false);
const rows = ref([]); // newest first (the server's order)

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = (await listMeasurements(props.modelId)).measurements || [];
    loaded.value = true;
  } catch (e) {
    error.value = e.message || "Couldn't load the measurement history.";
  } finally {
    loading.value = false;
  }
}
function onToggle(e) {
  if (e.target.open && !loaded.value) reload();
}
// The modal refreshes an already-open drawer after recording a new result;
// a never-opened drawer stays lazy (it loads fresh on first open anyway).
defineExpose({ reload: () => (loaded.value ? reload() : undefined) });

const hasRows = computed(() => rows.value.length > 0);
const whenOf = (m) => (m.at ? new Date(m.at).toLocaleString() : "");
const settingsOf = (m) =>
  (m.switches || []).map((s) => `${s.flagName}=${s.flagValue}`).join(" · ") ||
  "engine automatic settings";
const gb = (mb) => (mb / 1024).toFixed(1);

async function clearHistory() {
  const ok = await confirmDialog({
    title: "Clear measurement history?",
    message: "Delete every recorded measurement for this model? Saved tunes and PC class configs are not touched — this only clears the history of measured speeds.",
    confirmLabel: "Clear history",
  });
  if (!ok) return;
  error.value = "";
  clearing.value = true;
  try {
    rows.value = (await clearMeasurements(props.modelId)).measurements || [];
  } catch (e) {
    error.value = e.message || "Couldn't clear the history.";
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <details class="lu-mh" @toggle="onToggle">
    <summary class="lu-mh-summary">
      <Icon name="ChevRight" :size="15" class="lu-mh-caret" />
      <span class="lu-mh-text">
        <span class="lu-mh-title">
          Measurement history
          <span v-if="loaded && hasRows" class="lu-mh-count">{{ rows.length }}</span>
        </span>
        <span class="lu-muted">every measured speed for this model, saved across restarts</span>
      </span>
    </summary>

    <div class="lu-mh-body">
      <div v-if="error" class="lu-error">{{ error }}</div>
      <div v-if="loading" class="lu-muted">Loading…</div>

      <template v-else-if="loaded">
        <UiTable v-if="hasRows" class="lu-mh-tbl" :data="rows" :columns="HISTORY_COLUMNS" data-key="id">
          <template #when="{ row }"><span class="lu-mh-when">{{ whenOf(row) }}</span></template>
          <template #run="{ row }">
            <span class="lu-mh-run">
              <UiTag v-if="row.source === 'autotune'" intent="info">auto-tune</UiTag>
              <span v-if="row.label">{{ row.label }}</span>
              <span v-else-if="row.source !== 'autotune'">measured</span>
            </span>
          </template>
          <template #settings="{ row }"><span class="lu-mh-sum">{{ settingsOf(row) }}</span></template>
          <template #tps="{ row }"><b class="lu-mh-tps">{{ row.tokensPerSec }}</b></template>
          <template #vram="{ row }">{{ row.vramTotalMb ? `${gb(row.vramTotalMb)} GB` : "—" }}</template>
        </UiTable>
        <p v-else class="lu-muted lu-mh-empty">
          Nothing measured yet — every “Load &amp; measure” result and auto-tune trial is
          recorded here automatically.
        </p>

        <div v-if="hasRows" class="lu-mh-bar">
          <UiButton intent="ghost" size="small" :loading="clearing"
            title="Delete this model's recorded measurements — saved tunes and PC class configs are kept"
            @click="clearHistory">Clear history</UiButton>
        </div>
      </template>
    </div>
  </details>
</template>

<style scoped>
.lu-mh { border-top: 1px solid var(--border); padding-top: 10px; }
/* A real disclosure affordance (the user: "you can't tell you have to click it to
   open"): a rotating caret + a hover row so it reads as an expandable control, not a
   heading. `display:flex` already hides the native marker in Chromium/WebView2; the
   list-style/webkit rules keep it hidden on other engines too. */
.lu-mh-summary {
  cursor: pointer; display: flex; align-items: flex-start; gap: 8px; user-select: none;
  list-style: none; padding: 6px 8px; margin: 0 -8px;
  border-radius: var(--r-sm, 8px); transition: background .12s ease;
}
.lu-mh-summary::-webkit-details-marker { display: none; }
.lu-mh-summary::marker { content: ""; }
.lu-mh-summary:hover { background: var(--surface-2); }
.lu-mh-summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.lu-mh-caret { flex: none; margin-top: 1px; color: var(--muted); transition: transform .15s ease; }
.lu-mh[open] .lu-mh-caret { transform: rotate(90deg); }
.lu-mh-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lu-mh-title { font-weight: 700; font-size: 12.5px; color: var(--ink); display: flex; align-items: center; gap: 6px; }
.lu-mh-count {
  font-size: 10.5px; font-weight: 700; color: var(--muted);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 999px; padding: 0 6px; line-height: 16px;
}
.lu-mh-body { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
/* The grid itself is the shared UiTable now (2026-07-24) — no table CSS here. What remains
   styles CELL CONTENT, which is this component's business, not the table's. */
.lu-mh-tbl { font-size: 12px; }
.lu-mh-when { white-space: nowrap; color: var(--ink-2); }
.lu-mh-run { white-space: nowrap; color: var(--ink); display: inline-flex; align-items: center; gap: 6px; }
.lu-mh-sum { font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--ink-2); word-break: break-word; }
.lu-mh-tps { color: var(--accent-ink, var(--accent)); }
.lu-mh-empty { margin: 0; font-size: 12px; }
.lu-mh-bar { display: flex; justify-content: flex-end; }
</style>
