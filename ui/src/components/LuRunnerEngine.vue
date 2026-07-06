<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// "Local engine" panel — INSTALL the llama.cpp engine as its OWN step, separate
// from downloading a model (a model load requires the engine present; see the
// runner's _run_load). Shows install status + the selected build/gpu, an
// Install / Update button with a progress bar, the last spawn-log tail, and any
// error. Backed by the shared runner /v1/llm-runner/engine/* endpoints. Its
// sibling precedent is LuModelCatalog (UiProgress + status surface); both share
// the common/composables/usePoll.js interval poller. Hosts the collapsed "Engine
// binaries" editor (LuRunnerBinaries) as its own drawer at the panel
// bottom — the binary download URLs belong to the engine you install, so they
// live UNDER this panel (user, 2026-07-02), not as a separate card by the catalog.
import { computed, onMounted, ref } from "vue";

import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiProgress from "../common/components/UiProgress.vue";
import LuRunnerBinaries from "./LuRunnerBinaries.vue";
import { request } from "../client.js";
import { usePoll } from "../common/composables/usePoll.js";

const st = ref(null); // engine_status() payload
const error = ref("");
const busy = ref(false); // an install POST is in flight
const showLog = ref(false);
const logText = ref("");
const { start: startPoll, stop: stopPoll } = usePoll(refresh, 800);

const installed = computed(() => !!st.value?.installed);
const installing = computed(() => st.value?.status === "installing");
const cudaRuntimeMissing = computed(
  () => installed.value && st.value?.gpu?.startsWith("cuda") && st.value?.hasRuntime === false,
);

// Resident set (4a) — the live loaded/sleeping/in-flight models, the VRAM budget, and
// the two operator knobs. GET /resident is read-only + safe to poll (never spawns the
// router), so a 2nd interval poller drives this independently of the install poll.
const resident = ref(null);
const modelsMax = ref(null); // editable knob drafts: seeded ONCE from /resident, then
const sleepIdleSeconds = ref(null); // owned by the user until Save (no poll clobber).
const savingKnobs = ref(false);
const knobErr = ref("");
const { start: startResPoll } = usePoll(refreshResident, 2500);

const residentModels = computed(() => resident.value?.models || []);
const vramBudget = computed(() => {
  const r = resident.value;
  if (!r?.vramTotalMb) return ""; // no detectable GPU VRAM → hide the budget line
  return `VRAM ${r.committedMb} / ${r.vramTotalMb} MB · ${r.remainingMb} MB free`;
});
// Every status the endpoint can emit gets a tone; unknown → treated as busy, never hidden.
function statusClass(s) {
  if (s === "loaded") return "is-on";
  if (s === "error" || s === "failed") return "is-err";
  if (s === "sleeping" || s === "unloaded") return "is-idle";
  return "is-busy"; // loading | starting | downloading | anything else
}

function fmtBytes(n) {
  if (!n) return "";
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

async function refresh() {
  try {
    st.value = await request("/v1/llm-runner/engine/status");
    error.value = st.value?.status === "error" ? st.value?.error || "" : "";
    if (st.value?.status === "installing") startPoll();
    else stopPoll();
  } catch (e) {
    error.value = e.message || "Couldn't read engine status.";
    stopPoll();
  }
}

async function install(force) {
  busy.value = true;
  error.value = "";
  try {
    await request("/v1/llm-runner/engine/install", { method: "POST", body: { force: !!force } });
    await refresh();
    startPoll();
  } catch (e) {
    error.value = e.message || "Install failed.";
  } finally {
    busy.value = false;
  }
}

async function toggleLog() {
  showLog.value = !showLog.value;
  if (showLog.value) {
    try {
      const r = await request("/v1/llm-runner/engine/log?tail=200");
      logText.value = r?.text || "(no engine log yet — it is written when a model spawns)";
    } catch {
      logText.value = "(couldn't read the log)";
    }
  }
}

async function refreshResident() {
  try {
    const r = await request("/v1/llm-runner/resident");
    resident.value = r;
    // Seed the editable knobs ONCE; later polls must not clobber an in-progress edit.
    if (modelsMax.value === null && r.modelsMax != null) modelsMax.value = r.modelsMax;
    if (sleepIdleSeconds.value === null && r.sleepIdleSeconds != null) sleepIdleSeconds.value = r.sleepIdleSeconds;
  } catch {
    // a transient read failure just leaves the last snapshot; the poll retries
  }
}

async function saveKnobs() {
  savingKnobs.value = true;
  knobErr.value = "";
  try {
    // Send ONLY the two knobs — a partial PUT. Never echo a full config, or it would
    // clobber the binaries / pinned build / VRAM margin the binaries editor owns.
    const r = await request("/v1/ai/engine-config", {
      method: "PUT",
      body: { modelsMax: Number(modelsMax.value), sleepIdleSeconds: Number(sleepIdleSeconds.value) },
    });
    modelsMax.value = r.modelsMax; // re-sync from the server (reflects the clamps)
    sleepIdleSeconds.value = r.sleepIdleSeconds;
    await refreshResident();
  } catch (e) {
    knobErr.value = e.message || "Couldn't save.";
  } finally {
    savingKnobs.value = false;
  }
}

onMounted(() => {
  refresh();
  refreshResident();
  startResPoll();
});
</script>

<template>
  <div class="lu-eng">
    <div class="lu-eng-row">
      <div class="lu-eng-info">
        <div class="lu-eng-title">Local engine</div>
        <div class="lu-eng-sub">
          <template v-if="installing">Installing the llama.cpp engine…</template>
          <template v-else-if="installed">
            Installed<span v-if="st.build"> · {{ st.build }}</span><span v-if="st.gpu"> · {{ st.gpu }}</span>
            <span v-if="cudaRuntimeMissing" class="lu-eng-warn"> · CUDA runtime DLLs missing</span>
          </template>
          <template v-else>Not installed — install it before you load a model.</template>
        </div>
      </div>
      <div class="lu-eng-actions">
        <UiButton v-if="!installed" intent="primary" size="small"
          :loading="busy || installing" @click="install(false)">Install engine</UiButton>
        <UiButton v-else intent="secondary" size="small"
          :loading="busy || installing" @click="install(true)">Update</UiButton>
        <UiButton intent="ghost" size="small" @click="toggleLog">{{ showLog ? "Hide log" : "View log" }}</UiButton>
      </div>
    </div>

    <UiProgress v-if="installing" class="lu-eng-prog"
      :value="st.total ? st.downloaded : undefined" :max="st.total || undefined"
      :label="st.total ? `${fmtBytes(st.downloaded)} / ${fmtBytes(st.total)}` : 'Downloading…'" />

    <p v-if="error" class="lu-eng-err">{{ error }}</p>
    <pre v-if="showLog" class="lu-eng-log">{{ logText }}</pre>

    <!-- Resident set + the two residency knobs (4a). The RUNTIME half (loaded list + VRAM
         budget) needs an installed engine; the two knobs are persisted config (engine-config)
         and stay visible/editable BEFORE install (ledger B1 — the user's "C" pick). -->
    <div class="lu-eng-res">
      <template v-if="installed">
        <div class="lu-eng-res-head">
          <span class="lu-eng-res-title">Loaded models</span>
          <span v-if="vramBudget" class="lu-eng-res-vram">{{ vramBudget }}</span>
        </div>

        <ul v-if="residentModels.length" class="lu-eng-res-list">
          <li v-for="m in residentModels" :key="m.id" class="lu-eng-res-item">
            <span class="lu-eng-res-id">{{ m.id }}</span>
            <span class="lu-eng-res-status" :class="statusClass(m.status)">{{ m.status }}</span>
            <span v-if="m.nCtx" class="lu-eng-res-meta">ctx {{ m.nCtx.toLocaleString() }}</span>
            <span v-if="m.vramMb" class="lu-eng-res-meta">{{ m.vramMb }} MB</span>
          </li>
        </ul>
        <p v-else class="lu-eng-res-empty">
          {{ resident?.router ? "No models loaded right now." : "The engine loads models on first use — nothing loaded yet." }}
        </p>
      </template>

      <div class="lu-eng-knobs">
        <label class="lu-eng-knob">
          <span class="lu-eng-knob-cap">Models kept loaded at once</span>
          <UiInput v-model="modelsMax" type="number" width="token" />
        </label>
        <label class="lu-eng-knob">
          <span class="lu-eng-knob-cap">Unload an idle model after (seconds · 0 = never)</span>
          <UiInput v-model="sleepIdleSeconds" type="number" width="token" />
        </label>
        <UiButton intent="primary" size="small" :loading="savingKnobs" @click="saveKnobs">Save</UiButton>
      </div>
      <p v-if="knobErr" class="lu-eng-err">{{ knobErr }}</p>
    </div>

    <LuRunnerBinaries />
  </div>
</template>

<style scoped>
.lu-eng {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--lu-border, var(--border, #e2e2e2));
  border-radius: 10px;
  background: var(--lu-surface, var(--surface, #fff));
}
.lu-eng-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.lu-eng-info { min-width: 0; }
.lu-eng-title { font-weight: 600; font-size: 14px; }
.lu-eng-sub {
  font-size: 12.5px;
  color: var(--lu-ink-2, var(--ink-2, #666));
  margin-top: 2px;
  line-height: 1.4;
}
.lu-eng-warn { color: var(--lu-warn, #b45309); }
.lu-eng-actions { display: flex; gap: 6px; flex-shrink: 0; }
.lu-eng-err { margin: 0; font-size: 12.5px; color: var(--lu-danger, var(--danger, #b91c1c)); }
.lu-eng-log {
  max-height: 220px;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--lu-border, var(--border, #e2e2e2));
  background: var(--lu-surface-2, var(--surface-2, #f6f6f6));
  font-size: 11.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Resident set + the two residency knobs (4a) */
.lu-eng-res {
  border-top: 1px solid var(--lu-border, var(--border, #e2e2e2));
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.lu-eng-res-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.lu-eng-res-title { font-weight: 600; font-size: 13px; }
.lu-eng-res-vram {
  font-size: 11.5px;
  color: var(--lu-ink-2, var(--ink-2, #666));
  font-variant-numeric: tabular-nums;
}
.lu-eng-res-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.lu-eng-res-item { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.lu-eng-res-id {
  font-family: var(--font-mono, monospace);
  color: var(--lu-ink, var(--ink, #222));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.lu-eng-res-status {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .03em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--lu-surface-2, var(--surface-2, #f0f0f0));
  color: var(--lu-ink-2, var(--ink-2, #666));
}
.lu-eng-res-status.is-on { background: rgba(21, 128, 61, .14); color: #15803d; }
.lu-eng-res-status.is-busy { background: rgba(180, 83, 9, .14); color: #b45309; }
.lu-eng-res-status.is-err { background: rgba(185, 28, 28, .14); color: #b91c1c; }
.lu-eng-res-meta {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--lu-ink-2, var(--ink-2, #666));
  font-variant-numeric: tabular-nums;
}
.lu-eng-res-empty { margin: 0; font-size: 12.5px; color: var(--lu-ink-2, var(--ink-2, #666)); }
.lu-eng-knobs { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.lu-eng-knob { display: flex; flex-direction: column; gap: 3px; }
.lu-eng-knob-cap { font-size: 11.5px; color: var(--lu-ink-2, var(--ink-2, #666)); }
</style>
