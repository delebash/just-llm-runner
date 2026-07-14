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
import UiSelect from "../common/components/UiSelect.vue";
import UiToggle from "../common/components/UiToggle.vue";
import LuRunnerBinaries from "./LuRunnerBinaries.vue";
import { request } from "../client.js";
import { useEngine } from "../composables/useEngine.js";
import { usePoll } from "../common/composables/usePoll.js";

// Engine state comes from the ONE shared composable (useEngine). Since QC-39
// promoted the built-in provider out of the list (its old row — which carried
// the Install / Uninstall / Update-available / Reinstall cluster — is gone),
// THIS panel is the engine's one action surface: status line, the full button
// cluster, install progress/errors, and the Details drawer. Install POLLING
// lives in the composable, so progress keeps flowing whichever surface started
// it and whichever is mounted.
const { engineState: st, error, statusKnown, installed, installing, progressLabel, updatePolicy, setUpdatePolicy, updateInfo, checkForUpdate, updateToLatest, refreshEngine, install: engInstall, uninstall: engUninstall, setBackend, busy: engBusy } = useEngine();
const showLog = ref(false);
const logText = ref("");
// Collapsed by default (user, 2026-07-06: "collapse the engine panel … click to
// expand collapse for details"). Install progress + errors render OUTSIDE the
// collapse — an in-flight install or a failure must never hide. The B1 decision
// (knobs editable BEFORE install) survives: Details opens regardless of install state.
const showDetails = ref(false);
const cudaRuntimeMissing = computed(
  () => installed.value && st.value?.gpu?.startsWith("cuda") && st.value?.hasRuntime === false,
);

// Acceleration-backend selector (2026-07-14): the families this box can actually run
// (a detected runtime WITH a real binary) come from engine_status.offerBackends; the
// pin (preferredGpu) + what's installed/active drive the labels. Shown only when there's
// a genuine choice (>1 offerable), so a single-backend box stays uncluttered.
const FAM_LABEL = { cuda: "NVIDIA CUDA", vulkan: "Vulkan", rocm: "AMD ROCm", metal: "Apple Metal" };
const familyOf = (g) => (g && g.startsWith("cuda") ? "cuda" : g || "");
const backendOptions = computed(() => {
  const fams = st.value?.offerBackends || [];
  const inst = new Set((st.value?.installedGpus || []).map(familyOf));
  return [
    { value: "", label: "Auto (recommended)" },
    ...fams.map((f) => ({
      value: f,
      label: inst.has(f) ? (FAM_LABEL[f] || f) : `${FAM_LABEL[f] || f} — will download`,
    })),
  ];
});
const showBackendPicker = computed(() => (st.value?.offerBackends?.length || 0) > 1);
const activeBackendLabel = computed(() => {
  const a = st.value?.activeGpu;
  return a ? (FAM_LABEL[familyOf(a)] || a) : "";
});
function onPickBackend(v) {
  setBackend(v);
}

// Resident set (4a) — the live loaded/sleeping/in-flight models, the VRAM budget, and
// the two operator knobs. GET /resident is read-only + safe to poll (never spawns the
// router), so a 2nd interval poller drives this independently of the install poll.
const resident = ref(null);
const modelsMax = ref(null); // editable knob drafts: seeded ONCE from /resident, then
const sleepIdleSeconds = ref(null); // owned by the user until Save (no poll clobber).
const savingKnobs = ref(false);
const knobErr = ref("");

// Segmented downloads (DL-2) — the four DB-backed settings, drafts seeded ONCE
// from GET /engine-config at mount (same owned-until-Save rule as the knobs
// above). The min-bytes setting is presented in MB (stored in bytes).
const MB = 1024 * 1024;
const dlSegmentsEnabled = ref(null);
const dlSegmentCount = ref(null);
const dlSegmentMinMb = ref(null);
const dlSegmentRetries = ref(null);

async function loadDownloadKnobs() {
  try {
    const r = await request("/v1/ai/engine-config");
    if (dlSegmentsEnabled.value === null) dlSegmentsEnabled.value = !!r.downloadSegmentsEnabled;
    if (dlSegmentCount.value === null) dlSegmentCount.value = r.downloadSegmentCount;
    if (dlSegmentMinMb.value === null) dlSegmentMinMb.value = Math.round((r.downloadSegmentMinBytes || 0) / MB);
    if (dlSegmentRetries.value === null) dlSegmentRetries.value = r.downloadSegmentRetries;
  } catch {
    // transient — the drafts stay null and Save simply omits them (partial PUT)
  }
}

// The on/off choice applies on flip (the updatePolicy select precedent in this
// same form); the three numbers ride the form's Save.
async function setDlSegmentsEnabled(v) {
  dlSegmentsEnabled.value = v;
  try {
    await request("/v1/ai/engine-config", { method: "PUT", body: { downloadSegmentsEnabled: !!v } });
  } catch (e) {
    knobErr.value = e.message || "Couldn't save.";
  }
}
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
    // Send ONLY this form's knobs — a partial PUT. Never echo a full config, or it
    // would clobber the binaries / pinned build / VRAM margin the binaries editor
    // owns. Download drafts still null (a failed seed fetch) are simply omitted.
    const body = { modelsMax: Number(modelsMax.value), sleepIdleSeconds: Number(sleepIdleSeconds.value) };
    if (dlSegmentCount.value !== null) body.downloadSegmentCount = Number(dlSegmentCount.value);
    if (dlSegmentMinMb.value !== null) body.downloadSegmentMinBytes = Math.round(Number(dlSegmentMinMb.value) * MB);
    if (dlSegmentRetries.value !== null) body.downloadSegmentRetries = Number(dlSegmentRetries.value);
    const r = await request("/v1/ai/engine-config", { method: "PUT", body });
    modelsMax.value = r.modelsMax; // re-sync from the server (reflects the clamps)
    sleepIdleSeconds.value = r.sleepIdleSeconds;
    dlSegmentCount.value = r.downloadSegmentCount;
    dlSegmentMinMb.value = Math.round((r.downloadSegmentMinBytes || 0) / MB);
    dlSegmentRetries.value = r.downloadSegmentRetries;
    await refreshResident();
  } catch (e) {
    knobErr.value = e.message || "Couldn't save.";
  } finally {
    savingKnobs.value = false;
  }
}

onMounted(() => {
  refreshEngine();
  checkForUpdate(); // A5 — policy-gated; feeds the panel's own Update-available slot
  refreshResident();
  startResPoll();
  loadDownloadKnobs();
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
          <!-- QC-13: never claim "Not installed" before the status has actually been
               fetched — the false claim (with an Install button) rendered during the
               pre-fetch window, and stuck when the first fetch failed. -->
          <template v-else-if="!statusKnown">Checking the engine…</template>
          <template v-else>Not installed — install it before you load a model.</template>
        </div>
      </div>
      <div class="lu-eng-actions">
        <!-- The full engine cluster (QC-39 — the built-in's list row that used to
             carry it is gone): Install when NOT installed (#135), and when
             installed Uninstall + the update slot next to it (the row's own
             grammar, user 2026-07-07: "move update button next to uninstall") —
             "Update available" (info) when a newer build exists, else "Reinstall"
             (re-download the pinned build — a REPAIR, distinct from an update:
             the user's words). While an install RUNS the buttons yield to the
             progress bar below (#119 — the exe lands on disk early, so a
             mid-install `installed` flip must not swap the cluster). -->
        <UiButton v-if="statusKnown && !installed && !installing" intent="primary" size="small"
          :loading="engBusy" title="Download + install the llama.cpp engine for this machine"
          @click="engInstall()">Install engine</UiButton>
        <template v-if="installed && !installing">
          <UiButton intent="ghost" size="small"
            :loading="engBusy" title="Delete the engine binaries — models are kept"
            @click="engUninstall">Uninstall engine</UiButton>
          <UiButton v-if="updateInfo?.updateAvailable" intent="info" size="small"
            :loading="engBusy"
            :title="`Update the engine to ${updateInfo.latest} (you have ${updateInfo.current}) — the old build folder is removed after the new one installs`"
            @click="updateToLatest">Update available</UiButton>
          <UiButton v-else intent="secondary" size="small"
            :loading="engBusy" title="Re-download the pinned engine build"
            @click="engInstall(true)">Reinstall</UiButton>
        </template>
        <UiButton intent="ghost" size="small" @click="showDetails = !showDetails">
          {{ showDetails ? "Hide details ▴" : "Details ▾" }}
        </UiButton>
      </div>
    </div>

    <!-- Acceleration backend (2026-07-14): a REAL switch, replacing the old phantom
         "CUDA available" label — pick which GPU backend the engine runs on; the variant
         downloads on demand and a manual restart applies it. Shown only when the box has
         a genuine choice (e.g. an NVIDIA driver exposes both CUDA and Vulkan). -->
    <div v-if="showBackendPicker" class="lu-eng-backend">
      <span class="lu-eng-backend-cap">Acceleration backend</span>
      <UiSelect :model-value="st.preferredGpu || ''" width="name"
        :options="backendOptions" :disabled="engBusy || installing"
        @update:model-value="onPickBackend" />
      <span v-if="activeBackendLabel" class="lu-eng-backend-active">running on {{ activeBackendLabel }}</span>
    </div>

    <!-- Progress + errors live OUTSIDE the collapse: an in-flight install or a failure
         must stay visible while the panel is folded (user, 2026-07-06). -->
    <UiProgress v-if="installing" class="lu-eng-prog"
      :value="st.total ? st.downloaded : undefined" :max="st.total || undefined"
      :label="progressLabel" />

    <p v-if="error" class="lu-eng-err">{{ error }}</p>

    <template v-if="showDetails">
      <div class="lu-eng-logrow">
        <UiButton intent="ghost" size="small" @click="toggleLog">{{ showLog ? "Hide log" : "View log" }}</UiButton>
      </div>
      <pre v-if="showLog" class="lu-eng-log">{{ logText }}</pre>

      <!-- Resident set + the two residency knobs (4a). The RUNTIME half (loaded list + VRAM
           budget) needs an installed engine; the two knobs are persisted config (engine-config)
           and stay editable BEFORE install (ledger B1 — the user's "C" pick; the collapse gates
           on a click, never on install state). -->
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
          <label class="lu-eng-knob">
            <span class="lu-eng-knob-cap">Engine updates</span>
            <UiSelect :model-value="updatePolicy" width="token"
              :options="[{ value: 'notify', label: 'Notify' }, { value: 'off', label: 'Off' }]"
              @update:model-value="setUpdatePolicy" />
          </label>
          <!-- Segmented downloads (DL-2): the on/off applies on flip (the update-policy
               precedent above); the three numbers ride this form's Save. -->
          <label class="lu-eng-knob">
            <span class="lu-eng-knob-cap">Faster downloads (parallel connections)</span>
            <UiToggle :model-value="!!dlSegmentsEnabled" @update:model-value="setDlSegmentsEnabled" />
          </label>
          <template v-if="dlSegmentsEnabled">
            <label class="lu-eng-knob">
              <span class="lu-eng-knob-cap">Connections per download</span>
              <UiInput v-model="dlSegmentCount" type="number" width="token" />
            </label>
            <label class="lu-eng-knob">
              <span class="lu-eng-knob-cap">Split files larger than (MB)</span>
              <UiInput v-model="dlSegmentMinMb" type="number" width="token" />
            </label>
            <label class="lu-eng-knob">
              <span class="lu-eng-knob-cap">Retries per connection</span>
              <UiInput v-model="dlSegmentRetries" type="number" width="token" />
            </label>
          </template>
          <UiButton intent="primary" size="small" :loading="savingKnobs" @click="saveKnobs">Save</UiButton>
        </div>
        <p v-if="knobErr" class="lu-eng-err">{{ knobErr }}</p>
      </div>

      <LuRunnerBinaries />
    </template>
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
.lu-eng-backend { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lu-eng-backend-cap { font-size: 12.5px; font-weight: 600; color: var(--lu-ink-2, var(--ink-2, #666)); }
.lu-eng-backend-active { font-size: 11.5px; color: var(--lu-ink-2, var(--ink-2, #666)); font-variant-numeric: tabular-nums; }
/* Content-size the backend select so its box hugs the current label (Auto / CUDA /
   Vulkan) instead of filling the width="name" max-width cap — the shared trigger is
   width:100% by default, so the cap alone leaves a wide dead gap before the chevron. */
.lu-eng-backend :deep(.ui-select-trigger) { width: fit-content; }
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
