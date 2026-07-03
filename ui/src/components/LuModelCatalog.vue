<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The bundled-runner model catalog — mounted under Providers → Built-in (next to the
// Local engine panel). INSTALLED-FIRST: "Your models" lists what's downloaded (empty on
// a fresh install); "Browse catalog" reveals the rest of the seeded set to download +
// Add-your-own-GGUF. Each row shows a hardware Fit estimate + on-disk/loaded status,
// loads/unloads, and manages catalog rows (Add · Edit · Delete · Reset). The live model
// state + load/download + the Tune modal are SHARED (useRunnerModels / TuneMeasureModal).
//
// Scope: this catalog backs the BUNDLED runner only — the one provider with a manifest +
// VRAM-fit + HF-GGUF download/spawn lifecycle (/v1/llm-runner/*). Ollama / LM Studio
// manage their own models, so they keep the Fetch-models combobox instead of this table.
import { computed, ref } from "vue";

import { request } from "../client.js";
import { useRunnerModels } from "../common/composables/useRunnerModels.js";
import AppModal from "../common/components/AppModal.vue";
import TuneMeasureModal from "./TuneMeasureModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiProgress from "../common/components/UiProgress.vue";
import { confirmDialog } from "../common/services/dialog.js";

// Shared runner-models state (models / status / load / progress) — one source for the
// grid + this list. Everything comes from the ONE singleton so the two surfaces never drift.
const {
  models, vramMb, loading, error, downloaded, total, loadErr, loadingId,
  needsEngine, progressLabel, fmtBytes, FIT_LABEL, refresh, load, unload,
} = useRunnerModels();

// Installed-first framing: "Your models" = anything downloaded / loaded / in-flight /
// errored; the rest of the seeded catalog is available to download behind "Browse catalog".
// A fresh install has zero installed → the Your-models list is empty (browse to add one).
const browseOpen = ref(false);
const yourModels = computed(() => models.value.filter((m) => m.status !== "available"));
const availableModels = computed(() => models.value.filter((m) => m.status === "available"));
const shownModels = computed(() => (browseOpen.value ? [...yourModels.value, ...availableModels.value] : yourModels.value));

const busy = ref(""); // CATALOG-op id in flight (delete) — distinct from the shared loadingId

// ── Fit + size display ─
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

// Model licenses (from the catalog CRUD endpoint — the fit-shaped /models view doesn't
// carry it). Drives the per-model license badge + the use-limited warning.
const catalogRows = ref([]);
const licenseById = computed(() =>
  Object.fromEntries(catalogRows.value.map((r) => [r.id, r.license || ""])),
);
const useLimitedById = computed(() =>
  Object.fromEntries(catalogRows.value.map((r) => [r.id, !!r.useLimited])),
);
function licenseOf(m) { return licenseById.value[m.id] || ""; }
function useLimitedOf(m) { return !!useLimitedById.value[m.id]; }
function licenseTitle(m) {
  const lic = licenseOf(m);
  return useLimitedOf(m)
    ? `${lic || "license"} — use-limited: not free for unrestricted/commercial use, never a default. The catalog only lists it; the weights download on your machine.`
    : (lic ? `${lic} — permissive (free to use).` : "license unknown");
}
async function loadCatalogMeta() {
  try { catalogRows.value = (await request("/v1/ai/model-catalog")).rows || []; }
  catch { catalogRows.value = []; } // badge is enrichment — the table still works
}

async function unloadModel() {
  await unload();
}

// ── Tune & measure (#20) — the modal is shared (TuneMeasureModal), opened per model ─
const tuning = ref(null); // null | the model being tuned

// ── manager: add / edit / delete a catalog model (#30) ─
// Backed by the EXISTING tested router /v1/ai/model-catalog (CRUD+reset). The catalog row
// carries the editable fields (hfRepo/quant/type/params); the /models view above is
// fit-shaped, so edit fetches the catalog row. `type` drives which switch preset applies.
const editing = ref(null); // null | a draft catalog row
const editingNew = ref(false);
const saving = ref(false);
const saveErr = ref("");
// Pre-download GGUF inspect (POST /model-catalog/inspect): fills the file-derived fields on
// the draft (type/mtp/trainedCtx, persisted on Save) + a read-only preview (samplers/size/
// est VRAM). `inspected` is the last preview; null before Read-from-link.
const inspecting = ref(false);
const inspectErr = ref("");
const inspected = ref(null);

const samplersLabel = computed(() => {
  const s = inspected.value?.samplers || editing.value?.samplers || {};
  const entries = Object.entries(s);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(" · ") : "—";
});

async function inspectLink() {
  const e = editing.value;
  if (!e?.hfRepo?.trim()) { inspectErr.value = "Enter the Hugging Face repo first."; return; }
  inspecting.value = true; inspectErr.value = ""; inspected.value = null;
  try {
    const params = new URLSearchParams({ repo: e.hfRepo.trim(), quant: e.quant || "" });
    const r = await request(`/v1/ai/model-catalog/inspect?${params}`, { method: "POST" });
    // File-derived scalar facts flow into the draft (persisted by the Save PUT);
    // the sampler set persists from the local file at download (identify → set_derived).
    e.type = r.type || "dense";
    e.mtp = !!r.mtp;
    e.trainedCtx = r.trainedCtx ?? null;
    if (r.totalParams) e.totalParams = r.totalParams; // file-derived (dense); MoE stays curated
    if (!e.minVramMb && r.estVramMb) e.minVramMb = r.estVramMb;
    inspected.value = {
      architecture: r.architecture || "", experts: r.experts || 0, sizeLabel: r.sizeLabel || "",
      samplers: r.samplers || {}, sizeBytes: r.sizeBytes || 0, estVramMb: r.estVramMb ?? null,
    };
  } catch (err) {
    inspectErr.value = err.message || "Couldn't read the model from the link.";
  } finally {
    inspecting.value = false;
  }
}

function blankModel() {
  return { id: "", name: "", hfRepo: "", quant: "", type: "dense", totalParams: "",
    activeParams: "", mtp: false, trainedCtx: null, samplers: {}, minVramMb: null, minRamMb: null,
    tier: "mid", license: "", useLimited: false, position: 0 };
}
function startAdd() { editing.value = blankModel(); editingNew.value = true; saveErr.value = ""; inspected.value = null; inspectErr.value = ""; }
async function startEdit(m) {
  saveErr.value = ""; inspected.value = null; inspectErr.value = "";
  try {
    const cat = await request("/v1/ai/model-catalog");
    const row = (cat.rows || []).find((r) => r.id === m.id) || { ...blankModel(), id: m.id, name: m.name };
    editing.value = { ...blankModel(), ...row };
    editingNew.value = false;
  } catch (e) {
    saveErr.value = e.message || "Couldn't load the model.";
    editing.value = { ...blankModel(), id: m.id, name: m.name }; editingNew.value = false;
  }
}
function cancelEdit() { editing.value = null; saveErr.value = ""; inspected.value = null; inspectErr.value = ""; }

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
    editing.value = null;
    await refresh();
    loadCatalogMeta();
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
  busy.value = `del:${m.id}`; // namespaced so Delete's spinner ≠ the row's load/download spinner
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
    loadCatalogMeta();
  } catch (e) { error.value = e.message || "Reset failed."; }
}

loadCatalogMeta();
</script>

<template>
  <div class="lu-mcat">
    <div class="lu-mcat-head lu-mcat-bar">
      <span><b>Your models</b> — downloaded &amp; ready · <b>Fit</b> shows how each runs on your GPU</span>
      <span class="lu-mcat-spacer" />
      <UiButton intent="ghost" size="small" @click="browseOpen = !browseOpen">{{ browseOpen ? "Hide catalog" : `Browse catalog (${availableModels.length})` }}</UiButton>
      <UiButton intent="secondary" size="small" @click="resetCatalog">Reset catalog</UiButton>
      <UiButton intent="primary" size="small" @click="startAdd"><template #icon>＋</template>Add model</UiButton>
    </div>

    <div v-if="error" class="lu-error lu-mcat-err">{{ error }}</div>
    <div v-else-if="loading" class="lu-mcat-empty">Loading catalog…</div>
    <div v-else-if="!shownModels.length" class="lu-mcat-empty">
      No models downloaded yet — <b>Browse catalog</b> above to download one, or run <b>Quick Setup</b> to pick the best fit for your hardware.
    </div>

    <div v-else class="lu-mcat-wrap">
      <table class="lu-mgrid">
        <thead>
          <tr><th>Model</th><th>Params</th><th>License</th><th>Fit</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="m in shownModels" :key="m.id">
            <td class="lu-mn">{{ m.name }}<div class="lu-mid">{{ m.id }}</div></td>
            <td class="lu-mm">{{ sizeLabel(m) }}</td>
            <td>
              <span v-if="licenseOf(m)" class="lu-lic" :class="{ 'lu-lic--warn': useLimitedOf(m) }" :title="licenseTitle(m)">
                <template v-if="useLimitedOf(m)">⚠ </template>{{ licenseOf(m) }}
              </span>
              <span v-else class="lu-muted">—</span>
            </td>
            <td>
              <span class="lu-fit" :class="`lu-fit--${m.fit}`" :title="fitTitle(m)">{{ fitLabel(m) }}</span>
            </td>
            <td>
              <span v-if="m.status === 'loaded'" class="lu-pill lu-pill--run">● loaded</span>
              <UiProgress v-else-if="m.status === 'loading'" class="lu-mprog"
                :value="downloaded" :max="total" :label="progressLabel" />
              <span v-else-if="m.status === 'error'" class="lu-mstat lu-mstat--err"
                :title="needsEngine ? 'Install the engine first — see Local engine above' : (loadErr || 'Load failed')">
                {{ needsEngine ? "install engine ↑" : (loadErr || "failed") }}
              </span>
              <span v-else-if="m.status === 'disk'" class="lu-pill lu-pill--disk">on disk</span>
              <span v-else class="lu-mstat">not downloaded</span>
            </td>
            <td class="lu-mact">
              <UiButton intent="ghost" size="small" title="Edit catalog fields" @click="startEdit(m)">Edit</UiButton>
              <UiButton intent="ghost" size="small" title="Remove from catalog" :loading="busy === 'del:' + m.id" @click="deleteModel(m)">Delete</UiButton>
              <UiButton v-if="m.status === 'loaded' || m.status === 'disk'" intent="ghost" size="small"
                title="Tune engine flags &amp; measure decode speed" @click="tuning = m">Tune</UiButton>
              <UiButton v-if="m.status === 'loaded'" intent="secondary" size="small"
                :loading="loadingId === 'stop'" @click="unloadModel">Unload</UiButton>
              <span v-else-if="m.status === 'loading'" class="lu-muted lu-mwait">working…</span>
              <UiButton v-else-if="m.status === 'error'" intent="secondary" size="small"
                :loading="loadingId === m.id" @click="load(m.id)">Retry</UiButton>
              <UiButton v-else-if="m.status === 'disk'" intent="primary" size="small"
                :loading="loadingId === m.id" @click="load(m.id)">Load</UiButton>
              <UiButton v-else-if="m.fit === 'no'" intent="secondary" size="small" :disabled="true">Too large</UiButton>
              <UiButton v-else intent="primary" size="small"
                :loading="loadingId === m.id" @click="load(m.id)">Download &amp; load</UiButton>
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

    <!-- Add / edit a catalog model. Switch editing lives in the Lab (per-Task presets),
         not here — this form is catalog metadata only. -->
    <AppModal v-if="editing" :title="editingNew ? 'Add model' : `Edit ${editing.name || editing.id}`"
      :max-width="'560px'" @close="cancelEdit">
      <div class="lu-mm-form">
        <label class="lu-mm-l">Name<UiInput v-model="editing.name" placeholder="Qwen3 14B · Q4_K_M" /></label>
        <label v-if="editingNew" class="lu-mm-l">Id <span class="lu-muted">blank → derived from name</span><UiInput v-model="editing.id" placeholder="qwen3-14b-q4_k_m" /></label>

        <div class="lu-mm-note"><b>Download source</b> — where the GGUF is pulled from. The one thing you must set; the rest is read from the model itself.</div>
        <label class="lu-mm-l">Hugging Face repo<UiInput v-model="editing.hfRepo" placeholder="unsloth/Qwen3-14B-GGUF" /></label>
        <label class="lu-mm-l">Quant<UiInput v-model="editing.quant" placeholder="Q4_K_M" /></label>
        <div class="lu-mm-inspect">
          <UiButton intent="secondary" size="small" :loading="inspecting" @click="inspectLink">Read from link</UiButton>
          <span class="lu-muted">reads the GGUF header over the link — no download</span>
        </div>
        <div v-if="inspectErr" class="lu-error">{{ inspectErr }}</div>

        <div class="lu-mm-note"><b>Auto-detected from the file</b> <span class="lu-muted">— read from the GGUF header (Read from link, or confirmed at download); not hand-edited</span></div>
        <div class="lu-mm-auto">
          <div class="lu-mm-auto-row"><span class="lu-muted">Type</span><span>{{ editing.type || "dense" }}<template v-if="inspected"> · {{ inspected.architecture }}<template v-if="inspected.experts"> · {{ inspected.experts }} experts</template></template></span></div>
          <div v-if="inspected?.sizeLabel" class="lu-mm-auto-row"><span class="lu-muted">Size (file)</span><span>{{ inspected.sizeLabel }}</span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">Speculative decode (MTP)</span><span>{{ editing.mtp ? "supported" : "no" }} <span class="lu-muted">— from the header (nextn_predict_layers)</span></span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">Trained context</span><span>{{ editing.trainedCtx ? `${editing.trainedCtx.toLocaleString()} tokens` : "—" }}</span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">Recommended samplers</span><span>{{ samplersLabel }}</span></div>
          <div v-if="inspected?.sizeBytes" class="lu-mm-auto-row"><span class="lu-muted">Download size</span><span>{{ fmtBytes(inspected.sizeBytes) }}<template v-if="inspected.estVramMb"> · ≈ {{ inspected.estVramMb.toLocaleString() }} MB VRAM (full GPU · 8K ctx)</template></span></div>
        </div>

        <div class="lu-mm-note"><b>Fit estimate</b> — a pre-download guess so the list can show “will it fit?”; once downloaded the GGUF sets the real fit.</div>
        <div class="lu-mm-row">
          <label class="lu-mm-l">Total params<UiInput v-model="editing.totalParams" placeholder="14B" /></label>
          <label class="lu-mm-l">Active params <span class="lu-muted">MoE only</span><UiInput v-model="editing.activeParams" placeholder="3.6B" /></label>
        </div>
        <div class="lu-mm-row">
          <label class="lu-mm-l">Min VRAM (MB)<UiInput v-model.number="editing.minVramMb" type="number" placeholder="11000" /></label>
          <label class="lu-mm-l">Min RAM (MB)<UiInput v-model.number="editing.minRamMb" type="number" placeholder="14000" /></label>
        </div>

        <label class="lu-mm-l">License <span class="lu-muted">— SPDX id (Apache-2.0 · MIT · Llama-Community · …)</span><UiInput v-model="editing.license" placeholder="Apache-2.0" /></label>
        <div class="lu-mm-l"><UiCheckbox v-model="editing.useLimited"><span>Use-limited license <span class="lu-muted">— not free for unrestricted/commercial use; shows the ⚠ badge</span></span></UiCheckbox></div>

        <div v-if="saveErr" class="lu-error">{{ saveErr }}</div>
      </div>
      <template #footer>
        <UiButton intent="ghost" @click="cancelEdit">Cancel</UiButton>
        <span class="lu-mm-spacer" />
        <UiButton intent="primary" :loading="saving" @click="saveModel">{{ editingNew ? "Add model" : "Save" }}</UiButton>
      </template>
    </AppModal>

    <!-- Tune & measure (#20) — shared modal, opened per model. -->
    <TuneMeasureModal v-if="tuning" :model="tuning" @close="tuning = null" />
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

/* License badge — neutral for permissive (Apache/MIT), a gold warning chip for
   use-limited licenses (Llama-Community, *-Research, Gemma terms). */
.lu-lic { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); background: var(--surface); white-space: nowrap; }
.lu-lic--warn { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }

/* .lu-pill* moved to shared common/styles.css (used by the grid too). */
.lu-mstat { font-size: 11px; color: var(--muted); }
.lu-mstat--err { color: var(--danger); font-size: 11px; display: inline-block; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.lu-mprog { min-width: 150px; }

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
.lu-mm-note { font-size: 11px; color: var(--muted); line-height: 1.4; }
.lu-mm-note b { color: var(--ink-2); font-weight: 700; }
.lu-mm-inspect { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-mm-auto { display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.lu-mm-auto-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; align-items: baseline; }
.lu-mm-auto-row > .lu-muted:first-child { flex: 0 0 auto; }
.lu-mm-spacer { flex: 1; }
</style>
