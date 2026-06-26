<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The bundled-runner model catalog (from the shared-ai-models mock's
// modelsSection) — shown inside the built-in "llama.cpp" provider's form. Lists
// the manifest models with a hardware Fit estimate + on-disk/loaded status, and
// loads/unloads them via the runner endpoints. Self-contained on the shared
// client; token-styled (lu-*) so it renders native in either app.
//
// Scope (vs the mock): this catalog backs the BUNDLED runner only — it's the one
// provider with a manifest + VRAM-fit + HF-GGUF download/spawn lifecycle
// (/v1/llm-runner/*). Ollama / LM Studio manage their own models, so they keep
// the Fetch-models combobox instead of this table (a documented divergence).
import { computed, onUnmounted, ref } from "vue";

import { request } from "../client.js";
import AppModal from "../common/components/AppModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import { confirmDialog } from "../common/services/dialog.js";

const data = ref(null);
const loading = ref(true);
const error = ref("");
const detail = ref(""); // live status detail while a model is loading
const busy = ref(""); // model id whose action is in flight (button feedback)
let timer = null;

const models = computed(() => data.value?.models || []);
const vramMb = computed(() => data.value?.vramMb || 0);
const anyLoading = computed(() => models.value.some((m) => m.status === "loading"));

const FIT_LABEL = { ok: "Fits", tight: "Tight", no: "Won't fit", cpu: "CPU", unknown: "—" };
const gb = (mb) => (mb >= 10240 ? `${Math.round(mb / 1024)}` : `${(mb / 1024).toFixed(1)}`);
function fitLabel(m) {
  return FIT_LABEL[m.fit] || "—";
}
function fitTitle(m) {
  if (m.fit === "cpu") return "No GPU detected — runs on CPU (slower).";
  if (m.fit === "unknown") return "VRAM requirement unknown for this model.";
  if (!m.minVramMb) return "";
  const have = vramMb.value ? ` · you have ${gb(vramMb.value)} GB` : "";
  return `needs ~${gb(m.minVramMb)} GB VRAM${have}`;
}
function sizeLabel(m) {
  if (!m.params) return "—";
  return m.activeParams ? `${m.params} · ${m.activeParams} active` : m.params;
}

async function refresh() {
  try {
    data.value = await request("/v1/llm-runner/models");
    error.value = "";
    if (anyLoading.value) {
      try {
        const st = await request("/v1/llm-runner/status");
        detail.value = st.detail || (st.status === "downloading" ? "downloading…" : "starting…");
      } catch {
        detail.value = "";
      }
      startPoll();
    } else {
      detail.value = "";
      stopPoll();
    }
  } catch (e) {
    error.value = e.message || "Couldn't load the model catalog.";
  } finally {
    loading.value = false;
  }
}

function startPoll() {
  if (timer) return;
  timer = setInterval(refresh, 1500);
}
function stopPoll() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function load(m) {
  busy.value = m.id;
  try {
    await request("/v1/llm-runner/load", { method: "POST", body: { modelId: m.id } });
    await refresh();
  } catch (e) {
    error.value = e.message || "Load failed.";
  } finally {
    busy.value = "";
  }
}
async function unload() {
  busy.value = "stop";
  try {
    await request("/v1/llm-runner/stop", { method: "POST" });
    await refresh();
  } catch (e) {
    error.value = e.message || "Unload failed.";
  } finally {
    busy.value = "";
  }
}

// ── manager: add / edit / delete a catalog model + its per-model switches (#30) ─
// Backed by the EXISTING tested routers: /v1/ai/model-catalog (CRUD+reset) and
// /v1/ai/model-switches (CRUD). The catalog row carries the editable fields
// (hfRepo/quant/type/params); the /models view above is fit-shaped, so edit
// fetches the catalog row. `type` drives which switch preset applies (§6.5).
const TYPES = [{ value: "dense", label: "Dense" }, { value: "moe", label: "MoE (mixture-of-experts)" }];
const editing = ref(null);     // null | a draft catalog row
const editingNew = ref(false);
const editSwitches = ref([]);  // [{flagName, flagValue}] for the model being edited
const saving = ref(false);
const saveErr = ref("");

function blankModel() {
  return { id: "", name: "", hfRepo: "", quant: "", type: "dense", totalParams: "",
    activeParams: "", mtp: false, minVramMb: null, minRamMb: null, tier: "mid", position: 0 };
}
function startAdd() { editing.value = blankModel(); editingNew.value = true; editSwitches.value = []; saveErr.value = ""; }
async function startEdit(m) {
  saveErr.value = "";
  try {
    const [cat, sw] = await Promise.all([request("/v1/ai/model-catalog"), request("/v1/ai/model-switches")]);
    const row = (cat.rows || []).find((r) => r.id === m.id) || { ...blankModel(), id: m.id, name: m.name };
    editing.value = { ...blankModel(), ...row };
    editingNew.value = false;
    editSwitches.value = (sw.rows || []).filter((r) => r.modelId === m.id).map((r) => ({ flagName: r.flagName, flagValue: r.flagValue }));
  } catch (e) {
    saveErr.value = e.message || "Couldn't load the model.";
    editing.value = { ...blankModel(), id: m.id, name: m.name }; editingNew.value = false; editSwitches.value = [];
  }
}
function cancelEdit() { editing.value = null; saveErr.value = ""; }
function addSwitchRow() { editSwitches.value.push({ flagName: "", flagValue: "" }); }
function removeSwitchRow(i) { editSwitches.value.splice(i, 1); }

function slugFromName(name) {
  return (name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
async function saveModel() {
  const e = editing.value;
  if (editingNew.value && !e.id?.trim()) e.id = slugFromName(e.name);
  if (!e.id?.trim()) { saveErr.value = "A name (for the id) is required."; return; }
  saving.value = true; saveErr.value = "";
  try {
    await request("/v1/ai/model-catalog", {
      method: "PUT",
      body: { ...e, id: e.id.trim(), minVramMb: e.minVramMb || null, minRamMb: e.minRamMb || null, position: e.position || 0 },
    });
    // Sync per-model switches: delete removed rows, upsert the rest.
    const sw = await request("/v1/ai/model-switches");
    const before = (sw.rows || []).filter((r) => r.modelId === e.id);
    const keep = new Set(editSwitches.value.map((r) => (r.flagName || "").trim()).filter(Boolean));
    for (const r of before) {
      if (!keep.has(r.flagName)) {
        await request(`/v1/ai/model-switches?modelId=${encodeURIComponent(e.id)}&flagName=${encodeURIComponent(r.flagName)}`, { method: "DELETE" });
      }
    }
    for (const r of editSwitches.value) {
      const fn = (r.flagName || "").trim();
      if (fn) await request("/v1/ai/model-switches", { method: "PUT", body: { modelId: e.id, flagName: fn, flagValue: r.flagValue || "" } });
    }
    editing.value = null;
    await refresh();
  } catch (err) {
    saveErr.value = err.message || "Save failed.";
  } finally {
    saving.value = false;
  }
}
async function deleteModel(m) {
  const ok = await confirmDialog({
    title: `Remove "${m.name || m.id}" from the catalog?`,
    message: "Removes the catalog entry (downloaded files on disk are not deleted). Reset restores built-ins.",
    danger: true,
  });
  if (!ok) return;
  busy.value = m.id;
  try {
    await request(`/v1/ai/model-catalog?modelId=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    await refresh();
  } catch (e) { error.value = e.message || "Delete failed."; } finally { busy.value = ""; }
}
async function resetCatalog() {
  const ok = await confirmDialog({ title: "Reset the model catalog to factory?", message: "Restores the built-in models. Your added models are kept." });
  if (!ok) return;
  try {
    await request("/v1/ai/model-catalog/reset", { method: "POST" });
    await refresh();
  } catch (e) { error.value = e.message || "Reset failed."; }
}

refresh();
onUnmounted(stopPoll);
</script>

<template>
  <div class="lu-mcat">
    <div class="lu-mcat-head lu-mcat-bar">
      <span>Models — <b>Fit</b> estimates how well each runs on your GPU · downloaded models load on first use</span>
      <span class="lu-mcat-spacer" />
      <UiButton intent="secondary" size="small" @click="resetCatalog">Reset catalog</UiButton>
      <UiButton intent="primary" size="small" @click="startAdd"><template #icon>＋</template>Add model</UiButton>
    </div>

    <div v-if="error" class="lu-error lu-mcat-err">{{ error }}</div>
    <div v-else-if="loading" class="lu-mcat-empty">Loading catalog…</div>
    <div v-else-if="!models.length" class="lu-mcat-empty">No models in the catalog.</div>

    <div v-else class="lu-mcat-wrap">
      <table class="lu-mgrid">
        <thead>
          <tr><th>Model</th><th>Params</th><th>Fit</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="m in models" :key="m.id">
            <td class="lu-mn">{{ m.name }}<div class="lu-mid">{{ m.id }}</div></td>
            <td class="lu-mm">{{ sizeLabel(m) }}</td>
            <td>
              <span class="lu-fit" :class="`lu-fit--${m.fit}`" :title="fitTitle(m)">{{ fitLabel(m) }}</span>
            </td>
            <td>
              <span v-if="m.status === 'loaded'" class="lu-pill lu-pill--run">● loaded</span>
              <span v-else-if="m.status === 'loading'" class="lu-pill lu-pill--load">{{ detail || "loading…" }}</span>
              <span v-else-if="m.status === 'error'" class="lu-mstat lu-mstat--err">failed</span>
              <span v-else-if="m.status === 'disk'" class="lu-pill lu-pill--disk">on disk</span>
              <span v-else class="lu-mstat">not downloaded</span>
            </td>
            <td class="lu-mact">
              <UiButton intent="ghost" size="small" title="Edit fields + per-model switches" @click="startEdit(m)">Edit</UiButton>
              <UiButton intent="ghost" size="small" title="Remove from catalog" :loading="busy === m.id" @click="deleteModel(m)">Delete</UiButton>
              <UiButton v-if="m.status === 'loaded'" intent="secondary" size="small"
                :loading="busy === 'stop'" @click="unload">Unload</UiButton>
              <span v-else-if="m.status === 'loading'" class="lu-muted lu-mwait">working…</span>
              <UiButton v-else-if="m.status === 'error'" intent="secondary" size="small"
                :loading="busy === m.id" @click="load(m)">Retry</UiButton>
              <UiButton v-else-if="m.status === 'disk'" intent="primary" size="small"
                :loading="busy === m.id" @click="load(m)">Load</UiButton>
              <UiButton v-else-if="m.fit === 'no'" intent="secondary" size="small" :disabled="true">Too large</UiButton>
              <UiButton v-else intent="primary" size="small"
                :loading="busy === m.id" @click="load(m)">Download &amp; load</UiButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="lu-muted lu-mcat-foot">
      Models download from
      <a class="lu-mlink" href="https://huggingface.co/models?library=gguf" target="_blank" rel="noopener">Hugging Face ↗</a>
      — the open model hub. One model loads at a time; loading a new one replaces the running one.
    </div>

    <!-- Add / edit a catalog model + its per-model switches (#30). -->
    <AppModal v-if="editing" :title="editingNew ? 'Add model' : `Edit ${editing.name || editing.id}`"
      :max-width="'560px'" @close="cancelEdit">
      <div class="lu-mm-form">
        <label class="lu-mm-l">Name<UiInput v-model="editing.name" placeholder="Qwen3 14B · Q4_K_M" /></label>
        <label v-if="editingNew" class="lu-mm-l">Id <span class="lu-muted">blank → derived from name</span><UiInput v-model="editing.id" placeholder="qwen3-14b-q4_k_m" /></label>
        <label class="lu-mm-l">Hugging Face repo<UiInput v-model="editing.hfRepo" placeholder="unsloth/Qwen3-14B-GGUF" /></label>
        <label class="lu-mm-l">Quant<UiInput v-model="editing.quant" placeholder="Q4_K_M" /></label>
        <label class="lu-mm-l">Type <span class="lu-muted">— drives which switch preset applies</span><UiSelect v-model="editing.type" :options="TYPES" /></label>
        <div class="lu-mm-row">
          <label class="lu-mm-l">Total params<UiInput v-model="editing.totalParams" placeholder="14B" /></label>
          <label class="lu-mm-l">Active params <span class="lu-muted">MoE only</span><UiInput v-model="editing.activeParams" placeholder="3.6B" /></label>
        </div>
        <div class="lu-mm-row">
          <label class="lu-mm-l">Min VRAM (MB)<UiInput v-model.number="editing.minVramMb" type="number" placeholder="11000" /></label>
          <label class="lu-mm-l">Min RAM (MB)<UiInput v-model.number="editing.minRamMb" type="number" placeholder="14000" /></label>
        </div>

        <div class="lu-mm-sw">
          <div class="lu-mm-sw-h"><b>Per-model switches</b><span class="lu-muted">flag (an Overrides field) → value; layers under the type presets, the rare per-model exception</span></div>
          <div v-for="(s, i) in editSwitches" :key="i" class="lu-mm-sw-row">
            <UiInput v-model="s.flagName" placeholder="spec_type / ctx_len / no_mmap" />
            <UiInput v-model="s.flagValue" placeholder="none / 8192 / true" />
            <UiButton intent="ghost" size="small" title="Remove" @click="removeSwitchRow(i)">✕</UiButton>
          </div>
          <UiButton intent="ghost" size="small" @click="addSwitchRow">＋ Add switch</UiButton>
        </div>
        <div v-if="saveErr" class="lu-error">{{ saveErr }}</div>
      </div>
      <template #footer>
        <UiButton intent="ghost" @click="cancelEdit">Cancel</UiButton>
        <span class="lu-mm-spacer" />
        <UiButton intent="primary" :loading="saving" @click="saveModel">{{ editingNew ? "Add model" : "Save" }}</UiButton>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.lu-mcat { margin-top: 14px; }
.lu-mcat-head { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.lu-mcat-head b { color: var(--ink-2); }
.lu-mcat-err { margin-bottom: 8px; }
.lu-mcat-empty { font-size: 12.5px; color: var(--muted); padding: 14px; text-align: center; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm, 8px); }
.lu-mcat-wrap { max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-sm, 8px); background: var(--surface); }
.lu-mgrid { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lu-mgrid th {
  position: sticky; top: 0; z-index: 1; background: var(--surface-2); text-align: left;
  font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
  font-weight: 700; padding: 7px 11px; border-bottom: 1px solid var(--border);
}
.lu-mgrid td { padding: 8px 11px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.lu-mgrid tr:last-child td { border-bottom: 0; }
.lu-mn { font-weight: 600; color: var(--ink); min-width: 150px; }
.lu-mid { font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--muted); font-weight: 400; margin-top: 1px; }
.lu-mm { color: var(--ink-2); white-space: nowrap; }
.lu-mact { text-align: right; white-space: nowrap; }
.lu-mwait { font-size: 11px; }

.lu-fit {
  display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 9px;
  font-size: 11px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); background: var(--surface);
}
.lu-fit--ok { background: var(--accent-soft); border-color: var(--accent-line, var(--accent)); color: var(--accent-ink, var(--accent)); }
.lu-fit--tight { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }
.lu-fit--no { background: var(--danger-bg, #f7e7e4); border-color: var(--danger-line, var(--danger)); color: var(--danger); }
.lu-fit--cpu, .lu-fit--unknown { background: var(--surface-3); }

.lu-pill { font-size: 10px; font-weight: 700; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
.lu-pill--run { background: var(--accent); color: var(--on-accent, #fff); }
.lu-pill--load { background: var(--gold-soft, #f5edda); color: var(--gold, #b08a3e); border: 1px solid var(--gold-line, #e2d2b0); }
.lu-pill--disk { background: var(--surface-3); color: var(--ink-2); border: 1px solid var(--border); }
.lu-mstat { font-size: 11px; color: var(--muted); }
.lu-mstat--err { color: var(--danger); }

.lu-mcat-foot { font-size: 11px; margin-top: 7px; }
.lu-mlink { color: var(--accent-ink, var(--accent)); }

/* Manager: header bar + the add/edit modal form (#30). */
.lu-mcat-bar { display: flex; align-items: center; gap: 8px; }
.lu-mcat-bar > span:first-child { flex: 0 1 auto; }
.lu-mcat-spacer { flex: 1; }
.lu-mm-form { display: flex; flex-direction: column; gap: 12px; }
.lu-mm-l { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-2); font-weight: 600; }
.lu-mm-l .lu-muted { font-weight: 400; }
.lu-mm-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.lu-mm-sw { border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 7px; align-items: flex-start; }
.lu-mm-sw-h { display: flex; flex-direction: column; gap: 2px; }
.lu-mm-sw-h b { font-size: 12.5px; color: var(--ink); }
.lu-mm-sw-h .lu-muted { font-size: 10.5px; line-height: 1.4; }
.lu-mm-sw-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; width: 100%; }
.lu-mm-spacer { flex: 1; }
</style>
