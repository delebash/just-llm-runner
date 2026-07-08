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

import UiButton from "../common/components/UiButton.vue";
import UiTag from "../common/components/UiTag.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { clearMeasurements, listMeasurements } from "../measurements.js";

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
    message: "Delete every recorded measurement for this model? Saved tunes and class configs are not touched — this only clears the history of measured speeds.",
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
      <span class="lu-mh-title">Measurement history</span>
      <span class="lu-muted">every measured speed for this model, saved across restarts</span>
    </summary>

    <div class="lu-mh-body">
      <div v-if="error" class="lu-error">{{ error }}</div>
      <div v-if="loading" class="lu-muted">Loading…</div>

      <template v-else-if="loaded">
        <table v-if="hasRows" class="lu-mh-tbl">
          <thead>
            <tr><th>When</th><th>Run</th><th>Settings</th><th class="lu-mh-num">tok/s</th><th class="lu-mh-num">VRAM</th></tr>
          </thead>
          <tbody>
            <tr v-for="m in rows" :key="m.id">
              <td class="lu-mh-when">{{ whenOf(m) }}</td>
              <td class="lu-mh-run">
                <UiTag v-if="m.source === 'autotune'" intent="info">auto-tune</UiTag>
                <span v-if="m.label">{{ m.label }}</span>
                <span v-else-if="m.source !== 'autotune'">measured</span>
              </td>
              <td class="lu-mh-sum">{{ settingsOf(m) }}</td>
              <td class="lu-mh-num"><b>{{ m.tokensPerSec }}</b></td>
              <td class="lu-mh-num">{{ m.vramTotalMb ? `${gb(m.vramTotalMb)} GB` : "—" }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="lu-muted lu-mh-empty">
          Nothing measured yet — every “Load &amp; measure” result and auto-tune trial is
          recorded here automatically.
        </p>

        <div v-if="hasRows" class="lu-mh-bar">
          <UiButton intent="ghost" size="small" :loading="clearing"
            title="Delete this model's recorded measurements — saved tunes and class configs are kept"
            @click="clearHistory">Clear history</UiButton>
        </div>
      </template>
    </div>
  </details>
</template>

<style scoped>
.lu-mh { border-top: 1px solid var(--border); padding-top: 10px; }
.lu-mh-summary { cursor: pointer; display: flex; flex-direction: column; gap: 2px; user-select: none; }
.lu-mh-title { font-weight: 700; font-size: 12.5px; color: var(--ink); }
.lu-mh-body { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.lu-mh-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.lu-mh-tbl th { text-align: left; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); padding: 3px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.lu-mh-tbl td { padding: 5px 6px; border-bottom: 1px solid var(--border-soft, var(--border)); vertical-align: top; }
.lu-mh-when { white-space: nowrap; color: var(--ink-2); }
.lu-mh-run { white-space: nowrap; color: var(--ink); display: flex; align-items: center; gap: 6px; }
.lu-mh-sum { font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--ink-2); word-break: break-word; }
.lu-mh-num { text-align: right; white-space: nowrap; }
.lu-mh-num b { color: var(--accent-ink, var(--accent)); }
.lu-mh-empty { margin: 0; font-size: 12px; }
.lu-mh-bar { display: flex; justify-content: flex-end; }
</style>
