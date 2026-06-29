<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// EnginePresets — the Lab's preset library (2026-06-29 lab+preset model). A preset
// is the SOURCE OF TRUTH for what runs: a model + frozen Plane-1 switches +
// per-request params + optional hardware-fit-knob overrides (ngl / n_cpu_moe; blank
// = auto-computed at load). Build one here, then ASSIGN it — as the global default,
// or per CATEGORY (all features in "Writing" inherit it; new ones auto-join), or
// (later) per feature. The dispatch already resolves feature → override → category
// → default, so an assignment is live immediately. The prompt is NOT here — it
// lives on the feature (Routing by feature).
import { computed, onMounted, ref } from "vue";

import { request } from "../client.js";
import KnobGrid from "./KnobGrid.vue";
import LuModelPicker from "./LuModelPicker.vue";
import AppModal from "../common/components/AppModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import { confirmDialog } from "../common/services/dialog.js";

const REASONING_OPTIONS = [
  { value: "", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const presets = ref([]);                 // EnginePresetRow[]
const assignments = ref({ defaultPresetId: "", categories: {}, features: {} });
const categories = ref([]);              // unique feature categories (from the catalog)
const providers = ref([]);
const knobCatalog = ref([]);
const loading = ref(true);
const error = ref("");

const switchCatalog = computed(() =>
  Object.fromEntries(
    knobCatalog.value
      .filter((k) => k.plane === 1)
      .map((k) => [k.flagName, { label: k.label, help: k.help, options: k.options?.length ? k.options : undefined }]),
  ),
);
const presetName = (id) => presets.value.find((p) => p.id === id)?.name || "";
const presetOptions = computed(() => [
  { value: "", label: "— none (inherit) —" },
  ...presets.value.map((p) => ({ value: p.id, label: p.name })),
]);
function presetSummary(p) {
  const bits = [p.model || "— no model —"];
  if (p.temperature != null) bits.push(`temp ${p.temperature}`);
  if (p.reasoningEffort) bits.push(`reason ${p.reasoningEffort}`);
  if (p.jsonMode) bits.push("json");
  if (p.nCpuMoeOverride != null) bits.push(`n_cpu_moe ${p.nCpuMoeOverride}`);
  if (p.nglOverride != null) bits.push(`ngl ${p.nglOverride}`);
  const sw = (p.switches || []).length;
  if (sw) bits.push(`${sw} switch${sw > 1 ? "es" : ""}`);
  return bits.join(" · ");
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [pr, asg, routing, provs] = await Promise.all([
      request("/v1/ai/engine-presets"),
      request("/v1/ai/preset-assignments"),
      request("/v1/ai/routing"),
      request("/v1/llm-providers"),
    ]);
    presets.value = pr.presets || [];
    assignments.value = { defaultPresetId: "", categories: {}, features: {}, ...asg };
    providers.value = provs.providers || [];
    const cats = new Set();
    for (const f of routing.features || []) if (f.category) cats.add(f.category);
    categories.value = [...cats].sort();
    try { knobCatalog.value = (await request("/v1/ai/knob-catalog")).knobs || []; }
    catch { knobCatalog.value = []; }
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ── assignments ──────────────────────────────────────────────────────────────
async function setDefault(presetId) {
  assignments.value = await request("/v1/ai/preset-assignments/default", { method: "PUT", body: { presetId } });
}
async function setCategory(category, presetId) {
  assignments.value = await request("/v1/ai/preset-assignments/category", { method: "PUT", body: { category, presetId } });
}

// ── create / edit (modal) ────────────────────────────────────────────────────
const editing = ref(null);    // null | EnginePresetRow draft
const saving = ref(false);
const saveErr = ref("");

function blank() {
  return {
    id: "", name: "", providerId: "", model: "",
    temperature: null, topP: null, maxTokens: 0, jsonMode: false, reasoningEffort: "",
    nglOverride: null, nCpuMoeOverride: null, switches: [], samplers: [],
  };
}
function startAdd() { editing.value = blank(); saveErr.value = ""; }
function startEdit(p) { editing.value = JSON.parse(JSON.stringify(p)); saveErr.value = ""; }
function cancelEdit() { editing.value = null; }

// The model picker speaks {providerId, model}; the preset stores them flat.
const editPin = computed({
  get: () => (editing.value?.providerId ? { providerId: editing.value.providerId, model: editing.value.model || "" } : null),
  set: (v) => { if (editing.value) { editing.value.providerId = v?.providerId || ""; editing.value.model = v?.model || ""; } },
});
// KnobGrid speaks [{name,value}]; the wire is [{flagName,flagValue}].
const editSwitches = computed({
  get: () => (editing.value?.switches || []).map((s) => ({ name: s.flagName, value: s.flagValue })),
  set: (rows) => { if (editing.value) editing.value.switches = rows.map((r) => ({ flagName: r.name, flagValue: r.value })); },
});
function numOrNull(v) { return v === "" || v == null ? null : Number(v); }

async function saveEdit() {
  const e = editing.value;
  if (!e.name?.trim()) { saveErr.value = "A name is required."; return; }
  saving.value = true;
  saveErr.value = "";
  const body = {
    ...e,
    temperature: numOrNull(e.temperature),
    topP: numOrNull(e.topP),
    maxTokens: Number(e.maxTokens) || 0,
    nglOverride: numOrNull(e.nglOverride),
    nCpuMoeOverride: numOrNull(e.nCpuMoeOverride),
    switches: (e.switches || []).filter((s) => (s.flagName || "").trim()),
  };
  try {
    const r = e.id
      ? await request(`/v1/ai/engine-presets/${e.id}`, { method: "PUT", body })
      : await request("/v1/ai/engine-presets", { method: "POST", body });
    presets.value = r.presets || [];
    editing.value = null;
  } catch (err) {
    saveErr.value = err.message || "Save failed.";
  } finally {
    saving.value = false;
  }
}
async function removePreset(p) {
  const ok = await confirmDialog({
    title: `Delete the "${p.name}" preset?`,
    message: "Any category or feature using it falls back to the default.",
    danger: true,
  });
  if (!ok) return;
  try {
    presets.value = (await request(`/v1/ai/engine-presets/${p.id}`, { method: "DELETE" })).presets || [];
    assignments.value = await request("/v1/ai/preset-assignments");
  } catch (e) {
    error.value = e.message || "Delete failed.";
  }
}
</script>

<template>
  <section class="ep">
    <div class="ep-h">
      <div>
        <b class="ep-title">Presets</b>
        <span class="lu-muted ep-sub">A preset = model + switches + params. Build one, then assign it to your default or a category.</span>
      </div>
      <span class="ep-spacer" />
      <UiButton intent="primary" size="small" @click="startAdd">＋ New preset</UiButton>
    </div>

    <div v-if="error" class="lu-error">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else>
      <!-- The preset library -->
      <div v-if="!presets.length" class="ep-empty lu-muted">No presets yet — click “New preset” to build your first.</div>
      <div v-for="p in presets" :key="p.id" class="ep-row">
        <div class="ep-row-main">
          <b class="ep-row-name">{{ p.name }}</b>
          <span class="lu-muted ep-row-sum">{{ presetSummary(p) }}</span>
        </div>
        <UiButton intent="ghost" size="small" @click="startEdit(p)">Edit</UiButton>
        <UiButton intent="ghost" size="small" @click="removePreset(p)">Delete</UiButton>
      </div>

      <!-- Assignments: default + per-category -->
      <div class="ep-assign">
        <div class="ep-assign-h"><b>Assign</b><span class="lu-muted">which preset each kind of feature uses</span></div>
        <div class="ep-assign-row">
          <span class="ep-assign-k">Default <span class="lu-muted">(everything, unless overridden)</span></span>
          <UiSelect :model-value="assignments.defaultPresetId || ''" :options="presetOptions"
            @update:model-value="setDefault" />
        </div>
        <div v-for="cat in categories" :key="cat" class="ep-assign-row">
          <span class="ep-assign-k">{{ cat }}</span>
          <UiSelect :model-value="assignments.categories[cat] || ''" :options="presetOptions"
            @update:model-value="(v) => setCategory(cat, v)" />
        </div>
        <div v-if="!categories.length" class="lu-muted ep-assign-empty">No feature categories found.</div>
      </div>
    </template>

    <!-- Create / edit modal -->
    <AppModal v-if="editing" :title="editing.id ? 'Edit preset' : 'New preset'" :max-width="'560px'" @close="cancelEdit">
      <div class="ep-form">
        <label class="ep-flabel">Name <UiInput v-model="editing.name" placeholder="e.g. Prose · Qwen-27B" /></label>
        <label class="ep-flabel">Model
          <LuModelPicker editable :model-value="editPin" :providers="providers" :labels="true"
            inherit-label="— pick a provider + model —" @update:model-value="editPin = $event" />
        </label>
        <div class="ep-params">
          <label class="ep-num">Temp<UiInput :model-value="editing.temperature" type="number" @update:model-value="editing.temperature = $event" /></label>
          <label class="ep-num">Top-p<UiInput :model-value="editing.topP" type="number" @update:model-value="editing.topP = $event" /></label>
          <label class="ep-num">Max tok<UiInput :model-value="editing.maxTokens" type="number" @update:model-value="editing.maxTokens = $event" /></label>
          <label class="ep-reason">Reasoning<UiSelect :model-value="editing.reasoningEffort || ''" :options="REASONING_OPTIONS" @update:model-value="editing.reasoningEffort = $event" /></label>
          <label class="ep-chk"><UiCheckbox :model-value="editing.jsonMode" @update:model-value="editing.jsonMode = $event" /><span>JSON</span></label>
        </div>
        <div class="ep-fit">
          <span class="ep-eyebrow">Hardware fit <span class="lu-muted">— blank = auto-computed for your machine at load; set to override</span></span>
          <div class="ep-params">
            <label class="ep-num">-ngl<UiInput :model-value="editing.nglOverride" type="number" placeholder="auto" @update:model-value="editing.nglOverride = $event" /></label>
            <label class="ep-num">n_cpu_moe<UiInput :model-value="editing.nCpuMoeOverride" type="number" placeholder="auto" @update:model-value="editing.nCpuMoeOverride = $event" /></label>
          </div>
        </div>
        <div class="ep-sw">
          <span class="ep-eyebrow">Engine switches <span class="lu-muted">— frozen Plane-1 flags (flash-attn, cache type, …)</span></span>
          <KnobGrid v-model="editSwitches" :catalog="switchCatalog" add-label="＋ Add switch" name-placeholder="switch (e.g. flash_attn)" />
        </div>
        <div v-if="saveErr" class="lu-error">{{ saveErr }}</div>
      </div>
      <template #footer>
        <UiButton intent="ghost" @click="cancelEdit">Cancel</UiButton>
        <span class="ep-spacer" />
        <UiButton intent="primary" :loading="saving" @click="saveEdit">{{ editing.id ? "Save changes" : "Create preset" }}</UiButton>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.ep { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); }
.ep-h { display: flex; align-items: baseline; gap: 10px; }
.ep-title { font-size: 13px; color: var(--ink); }
.ep-sub { font-size: 11.5px; margin-left: 8px; }
.ep-spacer { flex: 1; }
.ep-empty { font-size: 12px; padding: 10px; text-align: center; background: var(--surface-2); border-radius: 8px; }
.ep-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.ep-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ep-row-name { font-size: 12.5px; color: var(--ink); }
.ep-row-sum { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ep-assign { margin-top: 6px; border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 7px; }
.ep-assign-h { display: flex; align-items: baseline; gap: 8px; } .ep-assign-h b { font-size: 12px; } .ep-assign-h .lu-muted { font-size: 11px; }
.ep-assign-row { display: grid; grid-template-columns: minmax(160px, 240px) minmax(0, 1fr); gap: 12px; align-items: center; }
.ep-assign-k { font-size: 12px; color: var(--ink-2); }
.ep-assign-empty { font-size: 11.5px; }
.ep-form { display: flex; flex-direction: column; gap: 13px; }
.ep-flabel { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-2); font-weight: 600; }
.ep-params { display: flex; gap: 12px 16px; align-items: flex-end; flex-wrap: wrap; }
.ep-num { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--muted); max-width: 92px; }
.ep-reason { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--muted); max-width: 120px; }
.ep-chk { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); }
.ep-eyebrow { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 6px; }
.ep-fit, .ep-sw { border-top: 1px solid var(--border); padding-top: 10px; }
</style>
