<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// "Local engine" panel — INSTALL the llama.cpp engine as its OWN step, separate
// from downloading a model (a model load requires the engine present; see the
// runner's _run_load). Shows install status + the selected build/gpu, an
// Install / Update button with a progress bar, the last spawn-log tail, and any
// error. Backed by the shared runner /v1/llm-runner/engine/* endpoints. Its
// sibling precedent is LuModelCatalog (UiProgress + status surface); both share
// the common/composables/usePoll.js interval poller. Hosts the collapsed "Engine
// binaries (advanced)" editor (LuRunnerBinaries) as its own drawer at the panel
// bottom — the binary download URLs belong to the engine you install, so they
// live UNDER this panel (user, 2026-07-02), not as a separate card by the catalog.
import { computed, onMounted, ref } from "vue";

import UiButton from "../common/components/UiButton.vue";
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

onMounted(refresh);
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
</style>
