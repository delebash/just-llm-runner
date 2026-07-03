<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Tune & measure (#20), extracted from LuModelCatalog (Phase 4) so BOTH the flat
// model catalog and the Recommendation grid open the SAME modal. Loads the model with
// ad-hoc Plane-1 engine flags + probes decode tok/s on this box. The grid pre-fills from
// the model's RESOLVED switch defaults (show the truth) and tweaks flow through
// POST /load { switches } → the same server-side converter stored switches use.
// Measure-only: to persist a config, tune it in the Lab and Save it as a preset for a
// Task — there is no per-model save here. Self-contained (loads its own knob catalog);
// mount behind v-if with a :model and listen for @close.
import { computed, onMounted, ref } from "vue";

import { request } from "../client.js";
import { resolveModelDefaults } from "../modelDefaults.js";
import { sendToTasksLab } from "../common/services/labHandoff.js";
import AppModal from "../common/components/AppModal.vue";
import KnobGrid from "./KnobGrid.vue";
import UiButton from "../common/components/UiButton.vue";

const props = defineProps({
  model: { type: Object, required: true }, // { id, name } — the model being tuned
});
const emit = defineEmits(["close"]);

const gb = (mb) => (mb >= 10240 ? `${Math.round(mb / 1024)}` : `${(mb / 1024).toFixed(1)}`);

// Knob-catalog metadata (C1) — labels/typed inputs for the Plane-1 switch grid.
const knobCatalog = ref([]);
const switchCatalog = computed(() =>
  Object.fromEntries(
    knobCatalog.value
      .filter((k) => k.plane === 1)
      .map((k) => [k.flagName, { label: k.label, help: k.help, options: k.options?.length ? k.options : undefined }]),
  ),
);
async function loadKnobCatalog() {
  try {
    knobCatalog.value = (await request("/v1/ai/knob-catalog")).knobs || [];
  } catch {
    knobCatalog.value = []; // enrichment only — raw rows still work
  }
}

const tuneRows = ref([]); // KnobGrid rows [{ name, value }]
const tunePhase = ref(""); // "" | loading | measuring | done | error
const tuneDetail = ref(""); // live load detail
const tuneResult = ref(null); // { tokensPerSec, completionTokens, ms, vramTotalMb, ramTotalMb }
const tuneErr = ref("");
const tuneMtpCapable = ref(false); // the tuned model's GGUF supports MTP → surface the spec_type hint
const tuneBusy = computed(() => tunePhase.value === "loading" || tunePhase.value === "measuring");

async function fetchResolved(id) {
  return resolveModelDefaults(id); // {switches, samplers, mtpCapable} — shared w/ ConfigColumn (one source)
}

// Hand this tuned model + switches (incl. custom rows) to the Tasks Lab as a new Compare
// column — the only way to KEEP a config (there is no per-model save here). providerId is
// left blank: the Lab (which holds the providers list) resolves the bundled-runner provider.
function sendToLab() {
  sendToTasksLab({ providerId: "", model: props.model.id, switches: tuneRows.value });
  emit("close");
}
async function startTune() {
  tuneRows.value = [];
  tuneMtpCapable.value = false;
  tuneResult.value = null;
  tuneErr.value = "";
  tunePhase.value = "";
  tuneDetail.value = "";
  try {
    const res = await fetchResolved(props.model.id);
    tuneRows.value = res.switches;
    tuneMtpCapable.value = res.mtpCapable;
  } catch {
    tuneRows.value = []; // pre-fill is an enrichment; tuning still works empty
  }
}
async function resetTuneSwitches() {
  try {
    const res = await fetchResolved(props.model.id);
    tuneRows.value = res.switches;
    tuneMtpCapable.value = res.mtpCapable;
  } catch (e) {
    tuneErr.value = e.message || "Couldn't reset to defaults.";
  }
}
function rowsToSwitches(rows) {
  const out = {};
  for (const r of rows || []) {
    const name = (r.name || "").trim();
    if (name) out[name] = r.value ?? "";
  }
  return out;
}
async function pollUntilSettled(maxMs = 180000) {
  const start = Date.now();
  for (;;) {
    const st = await request("/v1/llm-runner/status");
    if (st.status === "running") return st;
    if (st.status === "error") throw new Error(st.error || "Load failed.");
    tuneDetail.value = st.detail || st.status || "";
    if (Date.now() - start > maxMs) throw new Error("Timed out waiting for the model to load.");
    await new Promise((r) => setTimeout(r, 1200));
  }
}
async function runMeasure() {
  tuneErr.value = "";
  tuneResult.value = null;
  tunePhase.value = "loading";
  tuneDetail.value = "preparing";
  try {
    // Respawn cleanly with the requested flags (one model runs at a time).
    await request("/v1/llm-runner/stop", { method: "POST" }).catch(() => {});
    await request("/v1/llm-runner/load", {
      method: "POST",
      body: { modelId: props.model.id, switches: rowsToSwitches(tuneRows.value) },
    });
    await pollUntilSettled();
    tunePhase.value = "measuring";
    const res = await request("/v1/llm-runner/measure", { method: "POST" });
    if (!res.ok) throw new Error(res.error || "Measurement failed.");
    tuneResult.value = res;
    tunePhase.value = "done";
  } catch (e) {
    tuneErr.value = e.message || "Measurement failed.";
    tunePhase.value = "error";
  }
}

onMounted(() => {
  loadKnobCatalog();
  startTune();
});
</script>

<template>
  <AppModal :title="`Tune & measure — ${model.name || model.id}`" :max-width="'560px'" @close="emit('close')">
    <div class="lu-tune">
      <p class="lu-muted lu-tune-lede">
        Load this model with custom engine flags and measure decode speed on your hardware.
        Flags are pre-filled from the model's defaults — tweak, then measure.
      </p>
      <p v-if="tuneMtpCapable" class="lu-muted lu-tune-lede">This model supports <b>MTP</b> — set
        <b>Speculative decode</b> to “MTP draft” and measure; gains are machine-dependent.</p>

      <KnobGrid v-model="tuneRows" :catalog="switchCatalog" />
      <UiButton intent="ghost" size="small" @click="resetTuneSwitches">Reset to model default</UiButton>

      <div class="lu-tune-note lu-muted">
        <span>Measuring only. To <b>keep</b> this tuned config, send it to a <b>Task</b> — it opens as a new column in that Task's Lab, where you Save it as a preset.</span>
        <UiButton intent="secondary" size="small" class="lu-tune-send" @click="sendToLab">Send to Tasks Lab →</UiButton>
      </div>

      <div v-if="tunePhase === 'loading'" class="lu-tune-status">Loading… {{ tuneDetail }}</div>
      <div v-else-if="tunePhase === 'measuring'" class="lu-tune-status">Measuring decode speed…</div>

      <div v-if="tuneResult" class="lu-tune-result">
        <div class="lu-tune-tps"><b>{{ tuneResult.tokensPerSec }}</b> tok/s</div>
        <div class="lu-tune-meta">
          {{ tuneResult.completionTokens }} tokens · {{ tuneResult.ms }} ms<template
            v-if="tuneResult.vramTotalMb"> · VRAM {{ gb(tuneResult.vramTotalMb) }} GB</template><template
            v-if="tuneResult.ramTotalMb"> · RAM {{ gb(tuneResult.ramTotalMb) }} GB</template>
        </div>
        <div v-if="!tuneResult.vramTotalMb" class="lu-muted lu-tune-cpu">No GPU detected — measured on CPU.</div>
      </div>

      <div v-if="tuneErr" class="lu-error">{{ tuneErr }}</div>
    </div>
    <template #footer>
      <UiButton intent="ghost" @click="emit('close')">Close</UiButton>
      <span class="lu-tmm-spacer" />
      <UiButton intent="primary" :loading="tuneBusy" @click="runMeasure">
        {{ tuneResult ? "Measure again" : "Load & measure" }}
      </UiButton>
    </template>
  </AppModal>
</template>

<style scoped>
.lu-tune { display: flex; flex-direction: column; gap: 12px; }
.lu-tune-lede { font-size: 12px; margin: 0; }
.lu-tune-note { font-size: 11px; padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm, 8px); display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.lu-tune-status { font-size: 12.5px; color: var(--ink-2); }
.lu-tune-result { padding: 12px 14px; background: var(--accent-soft); border: 1px solid var(--accent-line, var(--accent)); border-radius: var(--r-sm, 8px); }
.lu-tune-tps { font-size: 13px; color: var(--ink-2); }
.lu-tune-tps b { font-size: 22px; color: var(--accent-ink, var(--accent)); font-weight: 800; }
.lu-tune-meta { font-size: 11.5px; color: var(--ink-2); margin-top: 3px; }
.lu-tune-cpu { font-size: 11px; margin-top: 3px; }
.lu-tmm-spacer { flex: 1; }
</style>
