<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Editable llama.cpp engine config — the binary download URL per (platform, gpu),
// the pinned build, and the VRAM safety margin. Backed by the shared
// /v1/ai/engine-config CRUD (llm_runner/llm/runner_config_api.py), persisted in the
// host DB (runner_binary + runner_setting, seeded from the module defaults). The
// app auto-detects the system and downloads the matching build; this panel lets the
// user paste a corrected URL from the llama.cpp releases page if an asset ever moves
// or is renamed — config is data, nothing is hardcoded. Collapsed by default;
// lazy-loads on first open.
import { ref } from "vue";

import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { request } from "../client.js";

const rows = ref([]);
const pinnedBuild = ref("");
const safetyMarginMb = ref(0);
const loading = ref(false);
const loaded = ref(false);
const error = ref("");
const busy = ref(""); // the row key (or "__settings"/"__add"/"__reset") saving
const draft = ref({ platform: "", gpu: "", assetUrl: "", serverExe: "llama-server" });

function _apply(d) {
  rows.value = (d.binaries || []).map((r) => ({ ...r }));
  pinnedBuild.value = d.pinnedBuild || "";
  safetyMarginMb.value = d.safetyMarginMb || 0;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    _apply(await request("/v1/ai/engine-config"));
    loaded.value = true;
  } catch (e) {
    error.value = e.message || "Couldn't load engine config.";
  } finally {
    loading.value = false;
  }
}

function onToggle(e) {
  if (e.target.open && !loaded.value) load();
}

async function put(body, key) {
  busy.value = key;
  error.value = "";
  try {
    _apply(await request("/v1/ai/engine-config", { method: "PUT", body }));
    return true;
  } catch (e) {
    error.value = e.message || "Save failed.";
    return false;
  } finally {
    busy.value = "";
  }
}

const rowKey = (r) => `${r.platform}/${r.gpu}`;

function saveRow(r) {
  put({ binaries: [{
    platform: r.platform, gpu: r.gpu, source: r.source,
    assetUrl: r.assetUrl || null, runtimeUrl: r.runtimeUrl || null,
    image: r.image || null, serverExe: r.serverExe || "llama-server",
  }] }, rowKey(r));
}

function saveSettings() {
  put({ pinnedBuild: (pinnedBuild.value || "").trim(), safetyMarginMb: Number(safetyMarginMb.value) || 0 }, "__settings");
}

async function addRow() {
  const platform = (draft.value.platform || "").trim();
  const gpu = (draft.value.gpu || "").trim();
  if (!platform || !gpu) {
    error.value = "platform and gpu are required.";
    return;
  }
  const ok = await put({ binaries: [{
    platform, gpu, source: "github",
    assetUrl: draft.value.assetUrl || null, serverExe: draft.value.serverExe || "llama-server",
  }] }, "__add");
  if (ok) draft.value = { platform: "", gpu: "", assetUrl: "", serverExe: "llama-server" };
}

async function reset() {
  if (!(await confirmDialog("Reset the engine binaries, pinned build, and VRAM margin to their shipped defaults? Custom rows you added are kept."))) return;
  busy.value = "__reset";
  error.value = "";
  try {
    _apply(await request("/v1/ai/engine-config/reset", { method: "POST" }));
  } catch (e) {
    error.value = e.message || "Reset failed.";
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <details class="lu-engbin" @toggle="onToggle">
    <summary class="lu-engbin-summary">
      <span class="lu-engbin-title">Engine binaries</span>
      <span class="lu-muted">llama.cpp download URLs · pinned build · VRAM margin</span>
    </summary>

    <div class="lu-engbin-body">
      <p class="lu-muted lu-engbin-help">
        The app auto-detects your system and downloads the matching llama.cpp build. If a
        download fails because a release asset moved or was renamed, paste the correct URL
        from the
        <a class="lu-mlink" href="https://github.com/ggml-org/llama.cpp/releases" target="_blank" rel="noopener">llama.cpp releases page ↗</a>
        (choose the asset for your OS + GPU). Windows CUDA needs both the build
        <code>llama-…-cuda-….zip</code> and its matching <code>cudart-…</code> runtime URL.
      </p>

      <div v-if="error" class="lu-error">{{ error }}</div>
      <div v-if="loading" class="lu-muted">Loading…</div>

      <template v-else-if="loaded">
        <div class="lu-engbin-settings">
          <label class="lu-engbin-field">Pinned build
            <UiInput v-model="pinnedBuild" width="token" />
          </label>
          <label class="lu-engbin-field">VRAM safety margin (MB)
            <UiInput v-model="safetyMarginMb" type="number" width="token" />
          </label>
          <UiButton intent="primary" size="small" :loading="busy === '__settings'" @click="saveSettings">Save</UiButton>
        </div>

        <div class="lu-engbin-scroll">
          <table class="lu-engbin-tbl">
            <thead>
              <tr><th>Platform</th><th>GPU</th><th>Asset URL</th><th>Runtime URL (cudart)</th><th>Server exe</th><th /></tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="rowKey(r)">
                <td class="lu-engbin-k">{{ r.platform }}</td>
                <td class="lu-engbin-k">{{ r.gpu }}<span v-if="r.source === 'docker'" class="lu-muted"> · docker</span></td>
                <td><UiInput v-model="r.assetUrl" placeholder="https://…/llama-….zip" /></td>
                <td><UiInput v-model="r.runtimeUrl" placeholder="—" /></td>
                <td><UiInput v-model="r.serverExe" width="name" /></td>
                <td><UiButton intent="primary" size="small" :loading="busy === rowKey(r)" @click="saveRow(r)">Save</UiButton></td>
              </tr>
              <tr class="lu-engbin-addrow">
                <td><UiInput v-model="draft.platform" placeholder="linux" width="name" /></td>
                <td><UiInput v-model="draft.gpu" placeholder="vulkan" width="name" /></td>
                <td><UiInput v-model="draft.assetUrl" placeholder="https://…" /></td>
                <td class="lu-muted">—</td>
                <td><UiInput v-model="draft.serverExe" width="name" /></td>
                <td><UiButton intent="secondary" size="small" :loading="busy === '__add'" @click="addRow">＋ Add</UiButton></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="lu-engbin-foot">
          <UiButton intent="secondary" size="small" :loading="busy === '__reset'" @click="reset">Reset to defaults</UiButton>
        </div>
      </template>
    </div>
  </details>
</template>

<style scoped>
.lu-engbin { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 12px; }
.lu-engbin-summary { cursor: pointer; display: flex; flex-direction: column; gap: 2px; user-select: none; }
.lu-engbin-title { font-weight: 700; color: var(--ink); }
.lu-engbin-body { margin-top: 12px; display: flex; flex-direction: column; gap: 12px; }
.lu-engbin-help { font-size: 12px; line-height: 1.5; max-width: 720px; }
.lu-engbin-help code { font-family: var(--font-mono, monospace); font-size: 11px; background: var(--surface-2, var(--surface)); padding: 0 3px; border-radius: 3px; }
.lu-engbin-settings { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.lu-engbin-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
.lu-engbin-scroll { overflow-x: auto; }
.lu-engbin-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.lu-engbin-tbl th { text-align: left; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.lu-engbin-tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border-soft, var(--border)); vertical-align: middle; }
.lu-engbin-k { font-family: var(--font-mono, monospace); color: var(--ink); white-space: nowrap; }
.lu-engbin-addrow td { border-bottom: 0; padding-top: 10px; }
.lu-engbin-foot { display: flex; justify-content: flex-start; }
</style>
