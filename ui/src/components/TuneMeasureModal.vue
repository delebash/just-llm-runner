<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Quick tune (#20 → Plan B 2026-07-05), extracted from LuModelCatalog so the model
// catalog opens the SAME modal from its per-row Tune action. Loads the model with
// ad-hoc Plane-1 engine flags + probes decode tok/s on this box. Pre-fills from the
// model's RESOLVED defaults (base → type → auto-mtp → hardware → saved tune — show
// the truth); tweaks flow through POST /load { switches } → the same server-side
// converter stored switches use. **Save tune** persists the grid VERBATIM as this
// model's tune FOR THIS MACHINE (PUT /v1/ai/model-tunes; the server derives the
// machine key) — every later load of this model here uses it automatically. "Remove
// saved tune" (DELETE) returns the model to the layered defaults. Send-to-Tasks-Lab
// stays the separate per-TASK depth. Self-contained (loads its own knob catalog);
// mount behind v-if with a :model and listen for @close.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { request } from "../client.js";
import { resolveModelDefaults } from "../modelDefaults.js";
import { sendToTasksLab } from "../common/services/labHandoff.js";
import AppModal from "../common/components/AppModal.vue";
import KnobGrid from "./KnobGrid.vue";
import UiButton from "../common/components/UiButton.vue";
import UiTag from "../common/components/UiTag.vue";

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

// ── the saved per-(model, machine) tune (Plan B) ─────────────────────────────
const savedTune = ref(null); // { hwKey, rows } | null — this machine's saved tune
const saveState = ref(""); // "" | saving | removing
const saveErr = ref("");

// Rows whose BARE name matches no plane-1 knob — likely a mistyped or since-
// DROPPED typed field that would render mis-spelled and fail the spawn (the D5
// degradation fold: visible badge, not a mystery load failure). A deliberate raw
// passthrough flag starts with "--" and is NOT badged.
const knownFlagNames = computed(
  () => new Set(knobCatalog.value.filter((k) => k.plane === 1).map((k) => k.flagName)),
);
const unknownNames = computed(() => {
  if (!knobCatalog.value.length) return new Set(); // catalog unavailable → don't badge
  const out = new Set();
  for (const r of tuneRows.value) {
    const n = (r.name || "").trim();
    if (n && !n.startsWith("--") && !knownFlagNames.value.has(n)) out.add(n);
  }
  return out;
});

async function loadSavedTune() {
  try {
    const res = await request(`/v1/ai/model-tunes?modelId=${encodeURIComponent(props.model.id)}`);
    savedTune.value = res.rows?.length ? res : null;
  } catch {
    savedTune.value = null; // saved-state is an enrichment; tuning still works
  }
}
async function saveTune() {
  saveErr.value = "";
  saveState.value = "saving";
  try {
    const switches = tuneRows.value
      .filter((r) => (r.name || "").trim())
      .map((r) => ({ flagName: r.name.trim(), flagValue: r.value ?? "" }));
    const res = await request("/v1/ai/model-tunes", {
      method: "PUT",
      body: { modelId: props.model.id, switches },
    });
    savedTune.value = res.rows?.length ? res : null;
  } catch (e) {
    saveErr.value = e.message || "Couldn't save the tune.";
  } finally {
    saveState.value = "";
  }
}
async function removeTune() {
  saveErr.value = "";
  saveState.value = "removing";
  try {
    await request(`/v1/ai/model-tunes?modelId=${encodeURIComponent(props.model.id)}`, { method: "DELETE" });
    savedTune.value = null;
    await startTune(); // the grid returns to the layered defaults
  } catch (e) {
    saveErr.value = e.message || "Couldn't remove the saved tune.";
  } finally {
    saveState.value = "";
  }
}

async function fetchResolved(id) {
  return resolveModelDefaults(id); // {switches, samplers, mtpCapable} — shared w/ ConfigColumn (one source)
}

// Hand this tuned model + switches (incl. custom rows) to the Tasks Lab as a new Compare
// column — the per-TASK depth (a task's exact preset). The per-MODEL keep-path is Save
// tune above. providerId is left blank: the Lab resolves the bundled-runner provider.
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

// ── Auto-tune (2026-07-06): the server-side measured sweep — a short sequence of
// real load→measure trials (batch 512/512 vs baseline, then n-cpu-moe around the
// anchor) run as ONE job (POST /v1/llm-runner/auto-tune; embed co-resident so the
// floor is production-true). The modal POLLS the job, narrates each trial, and on
// completion FILLS THE GRID with the winner — nothing auto-saves here: review,
// tweak if you like, then Save tune (the human stays in the loop; QuickSetup's
// save-on-done variant passes save:true instead).
const autoState = ref(null); // the GET payload: {status, detail, trials, best, error}
let autoTimer = null;
const autoRunning = computed(() => autoState.value?.status === "running");
const autoTrials = computed(() => autoState.value?.trials || []);

function stopAutoPoll() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}
function switchesToRows(switches) {
  return Object.entries(switches || {}).map(([name, value]) => ({ name, value: String(value ?? "") }));
}
async function pollAutoTune() {
  try {
    const st = await request("/v1/llm-runner/auto-tune");
    autoState.value = st;
    if (st.status === "running") return;
    stopAutoPoll();
    if (st.status === "done" && st.best) {
      tuneRows.value = switchesToRows(st.best.switches);
      tuneResult.value = {
        tokensPerSec: st.best.tokensPerSec, completionTokens: null, ms: null,
        vramTotalMb: st.best.vramTotalMb, ramTotalMb: null,
      };
      tunePhase.value = "done";
    } else if (st.status === "error") {
      tuneErr.value = st.error || "Auto-tune failed.";
      tunePhase.value = "error";
    }
  } catch (e) {
    stopAutoPoll();
    autoState.value = null;
    tuneErr.value = e.message || "Auto-tune polling failed.";
  }
}
async function runAutoTune() {
  tuneErr.value = "";
  tuneResult.value = null;
  try {
    const st = await request("/v1/llm-runner/auto-tune", {
      method: "POST",
      body: { modelId: props.model.id },
    });
    if (st.ok === false) throw new Error(st.error || "Auto-tune is busy.");
    autoState.value = st;
    stopAutoPoll();
    autoTimer = setInterval(pollAutoTune, 2000);
  } catch (e) {
    tuneErr.value = e.message || "Couldn't start auto-tune.";
  }
}
async function cancelAutoTune() {
  try {
    await request("/v1/llm-runner/auto-tune/cancel", { method: "POST" });
  } catch { /* the poll surfaces the final state either way */ }
}

onMounted(() => {
  loadKnobCatalog();
  startTune();
  loadSavedTune();
});
onBeforeUnmount(stopAutoPoll);
</script>

<template>
  <AppModal :title="`Tune & measure — ${model.name || model.id}`" :max-width="'560px'" @close="emit('close')">
    <div class="lu-tune">
      <p class="lu-muted lu-tune-lede">
        Load this model with custom engine flags and measure decode speed on your hardware.
        Flags are pre-filled from the model's defaults<template v-if="savedTune"> — including
        your saved tune</template> — tweak, measure, then <b>Save tune</b> to keep the
        config for this model on this machine.
      </p>
      <p v-if="tuneMtpCapable" class="lu-muted lu-tune-lede">This model supports <b>MTP</b> —
        <b>Speculative decode</b> is on by default (“MTP draft”); gains are machine-dependent, so
        measure. To turn it off here, set it to “Off” and Save.</p>

      <div v-if="savedTune" class="lu-tune-saved">
        <UiTag intent="success">Tuned for this machine ✓</UiTag>
        <UiButton intent="ghost" size="small" :loading="saveState === 'removing'"
          title="Delete this machine's saved tune — the model returns to its defaults"
          @click="removeTune">Remove saved tune</UiButton>
      </div>

      <KnobGrid v-model="tuneRows" :catalog="switchCatalog" />
      <div v-if="unknownNames.size" class="lu-tune-unk lu-muted">
        <UiTag intent="danger">unrecognized</UiTag>
        <span>{{ [...unknownNames].join(", ") }} — not a known engine flag (mistyped, or dropped
          by an engine update). Remove or fix it, or prefix with “--” for a raw flag.</span>
      </div>
      <UiButton intent="ghost" size="small" @click="resetTuneSwitches">Reset to model default</UiButton>

      <div class="lu-tune-note lu-muted">
        <span>Want a per-<b>Task</b> setup instead? Send this config to a Task — it opens as a new
          column in that Task's Lab, where you save it as the Task's preset.</span>
        <UiButton intent="secondary" size="small" class="lu-tune-send" @click="sendToLab">Send to Tasks Lab →</UiButton>
      </div>
      <div v-if="saveErr" class="lu-error">{{ saveErr }}</div>

      <div v-if="tunePhase === 'loading'" class="lu-tune-status">Loading… {{ tuneDetail }}</div>
      <div v-else-if="tunePhase === 'measuring'" class="lu-tune-status">Measuring decode speed…</div>

      <div v-if="autoRunning || (autoTrials.length && autoState?.status !== 'done')" class="lu-tune-status">
        Auto-tuning — {{ autoState?.detail || "working…" }}
      </div>
      <div v-if="autoTrials.length" class="lu-tune-trials lu-muted">
        <span v-for="t in autoTrials" :key="t.label" class="lu-tune-trial"
          :class="{ 'lu-tune-trial-bad': !t.ok }"
          :title="t.ok ? `${t.tokensPerSec} tok/s` : t.error">
          {{ t.label }}: {{ t.ok ? `${t.tokensPerSec} tok/s` : "✗" }}
        </span>
        <span v-if="autoState?.status === 'done' && autoState?.best" class="lu-tune-trial lu-tune-trial-win">
          winner → grid (review, then Save tune)
        </span>
      </div>

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
      <UiButton v-if="!autoRunning" intent="secondary" :disabled="tuneBusy"
        title="Run a short measured sweep (batch + expert-offload candidates, ~3–5 min) and fill the grid with the fastest config — review, then Save tune"
        @click="runAutoTune">Auto-tune</UiButton>
      <UiButton v-else intent="danger"
        title="Stop after the current trial finishes"
        @click="cancelAutoTune">Cancel auto-tune</UiButton>
      <UiButton intent="success" :loading="saveState === 'saving'" :disabled="autoRunning"
        title="Keep this config for this model on this machine — every load here uses it"
        @click="saveTune">Save tune</UiButton>
      <UiButton intent="primary" :loading="tuneBusy" :disabled="autoRunning" @click="runMeasure">
        {{ tuneResult ? "Measure again" : "Load & measure" }}
      </UiButton>
    </template>
  </AppModal>
</template>

<style scoped>
.lu-tune { display: flex; flex-direction: column; gap: 12px; }
.lu-tune-lede { font-size: 12px; margin: 0; }
.lu-tune-saved { display: flex; align-items: center; gap: 10px; }
.lu-tune-unk { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; }
.lu-tune-note { font-size: 11px; padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm, 8px); display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.lu-tune-status { font-size: 12.5px; color: var(--ink-2); }
.lu-tune-result { padding: 12px 14px; background: var(--accent-soft); border: 1px solid var(--accent-line, var(--accent)); border-radius: var(--r-sm, 8px); }
.lu-tune-tps { font-size: 13px; color: var(--ink-2); }
.lu-tune-tps b { font-size: 22px; color: var(--accent-ink, var(--accent)); font-weight: 800; }
.lu-tune-meta { font-size: 11.5px; color: var(--ink-2); margin-top: 3px; }
.lu-tune-cpu { font-size: 11px; margin-top: 3px; }
.lu-tune-trials { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; }
.lu-tune-trial { padding: 2px 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; }
.lu-tune-trial-bad { opacity: 0.6; text-decoration: line-through; }
.lu-tune-trial-win { border-color: var(--accent-line, var(--accent)); background: var(--accent-soft); color: var(--accent-ink, var(--accent)); }
.lu-tmm-spacer { flex: 1; }
</style>
