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
import KnobGrid from "./KnobGrid.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiProgress from "../common/components/UiProgress.vue";
import { confirmDialog } from "../common/services/dialog.js";

const data = ref(null);
const loading = ref(true);
const error = ref("");
const detail = ref(""); // live status phase while a model is loading
const downloaded = ref(0); // live bytes of the in-flight load (for the progress bar)
const total = ref(0); // total bytes of the current phase (0 = unknown → indeterminate)
const loadErr = ref(""); // the actual server error message when a load fails
const busy = ref(""); // model id whose action is in flight (button feedback)
let timer = null;

const models = computed(() => data.value?.models || []);
const vramMb = computed(() => data.value?.vramMb || 0);
const anyLoading = computed(() => models.value.some((m) => m.status === "loading"));
const anyError = computed(() => models.value.some((m) => m.status === "error"));

function fmtBytes(n) {
  if (!n) return "";
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
// Phase + bytes caption shown above the download progress bar.
const progressLabel = computed(() => {
  const phase = detail.value || "loading…";
  const cur = fmtBytes(downloaded.value);
  const tot = fmtBytes(total.value);
  if (cur && tot) return `${phase} · ${cur} / ${tot}`;
  if (cur) return `${phase} · ${cur}`;
  return phase;
});

// Knob-catalog metadata (C1) — labels/typed inputs for the Tune & measure grid.
// Plane-1 (engine switches) only; mirrors RoutingByJob's switchCatalog.
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

// Model licenses (from the catalog CRUD endpoint — the fit-shaped /models view
// doesn't carry it). Drives the per-model license badge + the use-limited warning.
const catalogRows = ref([]);
const licenseById = computed(() =>
  Object.fromEntries(catalogRows.value.map((r) => [r.id, r.license || ""])),
);
// Use-limited is now a DB column (`use_limited`, seeded from the license + editable
// per-model in the form) — the old client-side license regex is gone. Non-free
// licenses (Llama Community, *-Research, non-commercial, Gemma terms) get the ⚠ chip;
// they can't be a default and need care for a commercial ship (the catalog only
// LISTS them — llama.cpp downloads the weights on the box).
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
    // Pull live status while a load is in flight (progress) OR after one failed
    // (so we can surface the real error, not a bare "failed").
    if (anyLoading.value || anyError.value) {
      try {
        const st = await request("/v1/llm-runner/status");
        detail.value = st.detail || (st.status === "downloading" ? "downloading…" : "starting…");
        downloaded.value = Number(st.downloaded) || 0;
        total.value = Number(st.total) || 0;
        loadErr.value = st.error || "";
      } catch {
        detail.value = "";
      }
      if (anyLoading.value) startPoll();
      else stopPoll();
    } else {
      detail.value = "";
      downloaded.value = 0;
      total.value = 0;
      loadErr.value = "";
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

// ── Tune & measure (#20) ─
// Load the model with ad-hoc Plane-1 engine flags + probe decode tok/s on this
// box. The grid pre-fills from the model's RESOLVED switch defaults (show the
// truth) and tweaks flow through POST /load { switches } → the same server-side
// converter stored switches use. Measure-only: per D9 engine switches live on a
// Profile (Routing by job), so there's no per-model save here.
const tuning = ref(null);        // null | the model being tuned
const tuneRows = ref([]);        // KnobGrid rows [{ name, value }]
const tunePhase = ref("");       // "" | loading | measuring | done | error
const tuneDetail = ref("");      // live load detail
const tuneResult = ref(null);    // { tokensPerSec, completionTokens, ms, vramTotalMb, ramTotalMb }
const tuneErr = ref("");
const tuneBusy = computed(() => tunePhase.value === "loading" || tunePhase.value === "measuring");

async function fetchResolved(id) {
  const r = await request(`/v1/ai/model-catalog/switches?modelId=${encodeURIComponent(id)}`);
  return (r.switches || []).map((sw) => ({ name: sw.flagName, value: sw.flagValue }));
}
async function startTune(m) {
  tuning.value = m;
  tuneRows.value = [];
  tuneResult.value = null;
  tuneErr.value = "";
  tunePhase.value = "";
  tuneDetail.value = "";
  try {
    tuneRows.value = await fetchResolved(m.id);
  } catch {
    tuneRows.value = []; // pre-fill is an enrichment; tuning still works empty
  }
}
function cancelTune() {
  tuning.value = null;
}
async function resetTuneSwitches() {
  if (!tuning.value) return;
  try {
    tuneRows.value = await fetchResolved(tuning.value.id);
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
      body: { modelId: tuning.value.id, switches: rowsToSwitches(tuneRows.value) },
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
  } finally {
    refresh(); // sync the table's load status
  }
}

// ── manager: add / edit / delete a catalog model (#30) ─
// Backed by the EXISTING tested router /v1/ai/model-catalog (CRUD+reset). The
// catalog row carries the editable fields (hfRepo/quant/type/params); the
// /models view above is fit-shaped, so edit fetches the catalog row. `type`
// drives which switch preset applies (§6.5). Switch editing was moved OUT of
// this tab to the lab (§6.6) — no per-model switch sub-editor here anymore.
const TYPES = [{ value: "dense", label: "Dense" }, { value: "moe", label: "MoE (mixture-of-experts)" }];
const editing = ref(null);     // null | a draft catalog row
const editingNew = ref(false);
const saving = ref(false);
const saveErr = ref("");

function blankModel() {
  return { id: "", name: "", hfRepo: "", quant: "", type: "dense", totalParams: "",
    activeParams: "", mtp: false, minVramMb: null, minRamMb: null, tier: "mid",
    license: "", useLimited: false, position: 0 };
}
function startAdd() { editing.value = blankModel(); editingNew.value = true; saveErr.value = ""; }
async function startEdit(m) {
  saveErr.value = "";
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
function cancelEdit() { editing.value = null; saveErr.value = ""; }

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

refresh();
loadKnobCatalog();
loadCatalogMeta();
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
          <tr><th>Model</th><th>Params</th><th>License</th><th>Fit</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="m in models" :key="m.id">
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
              <span v-else-if="m.status === 'error'" class="lu-mstat lu-mstat--err" :title="loadErr || 'Load failed'">
                {{ loadErr || "failed" }}
              </span>
              <span v-else-if="m.status === 'disk'" class="lu-pill lu-pill--disk">on disk</span>
              <span v-else class="lu-mstat">not downloaded</span>
            </td>
            <td class="lu-mact">
              <UiButton intent="ghost" size="small" title="Edit catalog fields" @click="startEdit(m)">Edit</UiButton>
              <UiButton intent="ghost" size="small" title="Remove from catalog" :loading="busy === 'del:' + m.id" @click="deleteModel(m)">Delete</UiButton>
              <UiButton v-if="m.status === 'loaded' || m.status === 'disk'" intent="ghost" size="small"
                title="Tune engine flags &amp; measure decode speed" @click="startTune(m)">Tune</UiButton>
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

    <!-- The base/moe/mtp engine type-presets editor moved to Routing-by-job
         (§6.6: no switch editing in Providers) — it lives with the per-Profile
         switches it pre-fills. -->

    <!-- Add / edit a catalog model. Per-model switch editing moved to the Profile
         (Routing-by-job) — switches are per-Profile now (§6.6). -->
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

    <!-- Tune & measure (#20): load with ad-hoc Plane-1 flags + probe tok/s.
         Measure-only — engine switches persist on a Profile (Routing by job). -->
    <AppModal v-if="tuning" :title="`Tune & measure — ${tuning.name || tuning.id}`"
      :max-width="'560px'" @close="cancelTune">
      <div class="lu-tune">
        <p class="lu-muted lu-tune-lede">
          Load this model with custom engine flags and measure decode speed on your hardware.
          Flags are pre-filled from the model's defaults — tweak, then measure.
        </p>

        <KnobGrid v-model="tuneRows" :catalog="switchCatalog" />
        <UiButton intent="ghost" size="small" @click="resetTuneSwitches">Reset to model default</UiButton>

        <div class="lu-tune-note lu-muted">
          These flags are for measuring. To keep a fast config, set it on a job in
          <b>Routing by job</b> — engine switches live on a Profile, not per model.
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
        <UiButton intent="ghost" @click="cancelTune">Close</UiButton>
        <span class="lu-mm-spacer" />
        <UiButton intent="primary" :loading="tuneBusy" @click="runMeasure">
          {{ tuneResult ? "Measure again" : "Load & measure" }}
        </UiButton>
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

/* License badge — neutral for permissive (Apache/MIT), a gold warning chip for
   use-limited licenses (Llama-Community, *-Research, Gemma terms). */
.lu-lic { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); background: var(--surface); white-space: nowrap; }
.lu-lic--warn { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }

.lu-pill { font-size: 10px; font-weight: 700; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
.lu-pill--run { background: var(--accent); color: var(--on-accent, #fff); }
.lu-pill--load { background: var(--gold-soft, #f5edda); color: var(--gold, #b08a3e); border: 1px solid var(--gold-line, #e2d2b0); }
.lu-pill--disk { background: var(--surface-3); color: var(--ink-2); border: 1px solid var(--border); }
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
.lu-mm-spacer { flex: 1; }

/* Tune & measure modal (#20). */
.lu-tune { display: flex; flex-direction: column; gap: 12px; }
.lu-tune-lede { font-size: 12px; margin: 0; }
.lu-tune-note { font-size: 11px; padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm, 8px); }
.lu-tune-status { font-size: 12.5px; color: var(--ink-2); }
.lu-tune-result { padding: 12px 14px; background: var(--accent-soft); border: 1px solid var(--accent-line, var(--accent)); border-radius: var(--r-sm, 8px); }
.lu-tune-tps { font-size: 13px; color: var(--ink-2); }
.lu-tune-tps b { font-size: 22px; color: var(--accent-ink, var(--accent)); font-weight: 800; }
.lu-tune-meta { font-size: 11.5px; color: var(--ink-2); margin-top: 3px; }
.lu-tune-cpu { font-size: 11px; margin-top: 3px; }
</style>
