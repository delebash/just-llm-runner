<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// FeatureLab — the shared "test + tune" pane for ONE action, extracted from
// FeatureWorkbench (2026-07-02) so the Tasks page reuses it instead of copying the
// wiring. Given an action + its prompt it builds the {{variables}} test input, loads
// the action's long-tail samplers, and feeds <CompareStrip> N engine-config columns
// you Run and Save as presets.
//
// State boundary (panel-decided): FeatureLab OWNS draft(prompt, read to run) + vars +
// samplers + columnConfig + the CompareStrip. ROUTING stays in the PARENT — the pin
// arrives as a prop and is a READ-ONLY seed for the column's model (the pin-edit
// path was removed as vestigial; models persist via presets, not the routing pin), so
// there is ONE routing source of truth. save-as / update-preset / delete-preset /
// use-production are emitted; the parent decides the target — under Plan A that is always
// a TASK preset (the feature's task in the Workbench, the selected task on the Tasks page).
// NO LAUNCH SWITCHES here (§7.1, 2026-07-08): those live on the model — the column's
// "Engine switches ↗" link opens Tune & measure.
import { computed, reactive, ref, watch } from "vue";

import CompareStrip from "./CompareStrip.vue";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import { request } from "../client.js";
import { mergeVariables, testDataAction, testDataSources } from "../common/services/testData.js";
import { pushToast } from "../common/services/toastBridge.js";

const props = defineProps({
  action: { type: String, default: "" },
  prompt: { type: Object, default: null },      // the action's prompt row (read to run)
  providers: { type: Array, default: () => [] },
  presets: { type: Array, default: () => [] },
  samplerCatalogList: { type: Array, default: () => [] },
  productionPresetId: { type: String, default: "" },
  pin: { type: Object, default: null },         // the action's routing pin (parent-owned)
  taskKind: { type: String, default: "" },      // the action's task — keys the DB samples (§7.3)
});
const emit = defineEmits(["use-production", "presets-changed"]);

const draft = ref(null);       // editable copy of the prompt (ephemeral test edits)
const samplerRows = ref([]);   // the action's long-tail samplers (Plane-2)
const vars = reactive({});
const varHint = "{{variables}}";

function buildVars() {
  for (const k of Object.keys(vars)) delete vars[k];
  const tpl = `${draft.value?.userTemplate || ""}\n${draft.value?.system || ""}`;
  const found = new Set([...tpl.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]));
  for (const v of found) vars[v] = vars[v] || "";
  if (!found.size) vars.user_content = vars.user_content || "";
}

async function loadSamplers(key) {
  if (!key) { samplerRows.value = []; return; }
  try {
    const r = await request(`/v1/ai/feature-samplers?feature=${encodeURIComponent(key)}`);
    samplerRows.value = (r.samplers || []).map((s) => ({ name: s.flagName, value: s.flagValue }));
  } catch {
    samplerRows.value = [];
  }
}

function humanizeVar(k) {
  const s = String(k).replace(/[_-]+/g, " ").replace(/([a-z\d])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : k;
}

// Save-as / delete / update a tested column as an ENGINE preset. FeatureLab owns the
// /v1/ai/engine-presets calls (one source for both hosts) and emits the refreshed
// list; the parent updates its `presets` ref. Where the tested preset is then USED
// (the feature's task preset vs the selected task's preset — both task-grained under
// Plan A) is the parent's call → `use-production`.
function cfgToEnginePreset(name, cfg) {
  const num = (v) => (v === "" || v == null ? null : Number(v));
  return {
    name,
    providerId: cfg.pin?.providerId || "", model: cfg.pin?.model || "",
    temperature: num(cfg.temperature), topP: num(cfg.topP),
    maxTokens: Number(cfg.maxTokens) || 0, jsonMode: !!cfg.jsonMode,
    reasoningEffort: cfg.reasoningEffort || "",
    samplers: (cfg.samplers || []).filter((r) => (r.name || "").trim()).map((r) => ({ flagName: r.name.trim(), flagValue: r.value || "" })),
  };
}
async function saveAs(name, cfg) {
  if (!name || !cfg) return;
  const r = await request("/v1/ai/engine-presets", { method: "POST", body: cfgToEnginePreset(name, cfg) });
  emit("presets-changed", r.presets || []);
}
async function delPreset(id) {
  if (!id) return;
  const r = await request(`/v1/ai/engine-presets/${id}`, { method: "DELETE" });
  emit("presets-changed", r.presets || []);
}
// Edit-in-place: update the loaded preset (keeps its id + name) instead of a new copy.
async function updatePreset(id, cfg) {
  if (!id || !cfg) return;
  const p = props.presets.find((x) => x.id === id);
  if (!p) return;  // preset not in the list (e.g. just deleted) → no-op, never silently rename
  const r = await request(`/v1/ai/engine-presets/${id}`, { method: "PUT", body: cfgToEnginePreset(p.name, cfg) });
  emit("presets-changed", r.presets || []);
}

// Reset the local test state whenever the parent selects a different action.
watch(() => props.prompt, (p) => { draft.value = p ? { ...p } : null; buildVars(); }, { immediate: true });
watch(() => props.action, (k) => { loadSamplers(k); }, { immediate: true });

// ── Test data (§7.3, rebuilt per QC-35 2026-07-09): per-ACTION affordances ──
// The host declares, per action, which pickers apply (each with its own
// fill(id) built on the feature's OWN composer), whether a "From this book"
// compose button exists (the book is the argument — the button runs the
// feature's composer over the live project), and which DB sample labels fit
// this action's prompt contract. An undeclared action gets no pickers/compose;
// its Sample button cycles the whole taskKind (the freeform default).
const samples = ref([]);       // this taskKind's DB samples
const sampleIx = ref(0);       // the next sample the button fills
const composing = ref(false);
const sources = testDataSources();
const sourceById = Object.fromEntries(sources.map((s) => [s.id, s]));
const sourceOptions = reactive({}); // source.id -> [{value,label}] (loaded on first need)

const decl = computed(() => testDataAction(props.action));
// Pickers the open action declares AND whose source exists in the registry.
const pickers = computed(() =>
  (decl.value?.pickers || []).filter((p) => sourceById[p.source]));
// Sample rows the declaration admits for THIS action (per the QC-35 sample
// law each label maps to one prompt contract); undeclared → the whole kind.
const actionSamples = computed(() => {
  const labels = decl.value?.samples;
  if (!Array.isArray(labels) || !labels.length) return samples.value;
  return samples.value.filter((s) => labels.includes(s.label));
});

watch(() => props.taskKind, async (kind) => {
  samples.value = [];
  sampleIx.value = 0;
  if (!kind) return;
  try {
    samples.value = (await request(`/v1/ai/test-samples?taskKind=${encodeURIComponent(kind)}`)).rows || [];
  } catch { /* the button simply doesn't render */ }
}, { immediate: true });

// Load the option list for each source the open action's pickers reference
// (lazily, once per source per mount — lists are cheap store reads).
watch(pickers, (list) => {
  for (const p of list) {
    if (sourceOptions[p.source]) continue;
    const src = sourceById[p.source];
    Promise.resolve()
      .then(() => src.list())
      .then((items) => {
        sourceOptions[p.source] = [
          { value: "", label: `Insert from ${src.label}…` },
          ...(items || []).map((it) => ({ value: String(it.id), label: it.label })),
        ];
      })
      .catch(() => { sourceOptions[p.source] = []; });
  }
}, { immediate: true });

function fillSample() {
  const rows = actionSamples.value;
  if (!rows.length) return;
  const s = rows[sampleIx.value % rows.length];
  sampleIx.value += 1;
  const set = mergeVariables(vars, s.variables);
  if (!set) pushToast({ message: "That sample's fields don't match this prompt's variables." });
}
async function insertFrom(picker, id) {
  if (!id) return;
  try {
    const payload = await picker.fill(id);
    const set = mergeVariables(vars, payload || {});
    if (!set) pushToast({ message: `That ${sourceById[picker.source]?.kind || "item"}'s fields don't match this prompt's variables.` });
  } catch (e) {
    pushToast({ message: e?.message || "Couldn't load that item." });
  }
}
// "From this book" — run the feature's own composer over the live project.
// A composer's honest refusal (e.g. "Need at least three chapters with
// prose…") surfaces as the toast; the Sample button remains the thin-book path.
async function composeFromBook() {
  const c = decl.value?.compose;
  if (!c || composing.value) return;
  composing.value = true;
  try {
    const payload = await c.run();
    const set = mergeVariables(vars, payload || {});
    if (!set) pushToast({ message: "The composed input doesn't match this prompt's variables." });
  } catch (e) {
    pushToast({ message: e?.message || "Couldn't compose from this book." });
  } finally {
    composing.value = false;
  }
}

// The action's run-config SEED for <ConfigColumn>. Read-only: CompareStrip deep-clones
// this into each column, so edits live on the column and reach us through the column's
// save-as (not a write-back setter). `pin` is the feature's current routing pin, used
// only to seed the column's model — persisting a chosen model is done via Save-as-preset
// + assign ("Use for this task"), NOT via the routing pin.
const columnConfig = computed(() => {
  const d = draft.value || {};
  return {
    pin: props.pin,
    system: d.system, userTemplate: d.userTemplate,
    temperature: d.temperature, topP: d.topP, maxTokens: d.maxTokens,
    reasoningEffort: d.think ? (d.reasoningEffort || "medium") : "",
    jsonMode: d.jsonMode, samplers: samplerRows.value,
  };
});
</script>

<template>
  <div class="lu-fw-tune">
    <div class="lu-fw-tune-h"><b>Tune presets</b><span class="lu-muted">run this feature's prompt on a test input · Save a column as a preset (it appears in the dropdowns)</span></div>
    <div class="lu-fw-testin">
      <div class="lu-fw-testin-h"><b>Test input</b><span class="lu-muted">the {{ varHint }} the prompt fills — shared across columns</span></div>
      <!-- Fill affordances — ONE row, all together (QC-24 layout stands). Only
           what the open ACTION declares renders here (QC-35): its pickers, its
           "From this book" compose button, and Sample over the declared rows;
           the row simply doesn't render when nothing applies. -->
      <div v-if="pickers.length || decl?.compose || actionSamples.length" class="lu-fw-testin-fill">
        <!-- v-if, not v-show: UiSelect's root is a Reka fragment, so v-show never
             actually hid an empty source (a pre-existing console warn, fixed here). -->
        <!-- (no class on UiSelect: its Reka fragment root drops attrs — a class
             here never reaches the DOM; probes select .ui-select-trigger.) -->
        <template v-for="p in pickers" :key="p.source">
          <UiSelect v-if="(sourceOptions[p.source] || []).length > 1"
            :model-value="''" :options="sourceOptions[p.source] || []" width="name"
            @update:model-value="(v) => insertFrom(p, v)" />
        </template>
        <UiButton v-if="decl?.compose" intent="secondary" size="small"
          :disabled="composing"
          title="Build this feature's real input from your book — the same composition a live run uses"
          @click="composeFromBook">{{ decl.compose.label || "From this book" }}</UiButton>
        <UiButton v-if="actionSamples.length" intent="secondary" size="small"
          :title="actionSamples.length > 1 ? 'Fill with a sample from the app — click again for the next one' : 'Fill with the app\'s sample data'"
          @click="fillSample">Sample</UiButton>
      </div>
      <div v-for="(_, k) in vars" :key="k" class="lu-field">
        <label>{{ humanizeVar(k) }}</label><UiTextarea v-model="vars[k]" auto-resize :rows="2" />
      </div>
    </div>
    <CompareStrip :key="action"
      :action="action" :base-config="columnConfig" :providers="providers"
      :sampler-catalog-list="samplerCatalogList"
      :vars="vars" :presets="presets" :production-preset-id="productionPresetId"
      @save-as="saveAs"
      @update-preset="updatePreset"
      @delete-preset="delPreset"
      @use-production="(id) => emit('use-production', id)" />
  </div>
</template>

<style scoped>
.lu-fw-tune { display: flex; flex-direction: column; gap: 12px; }
.lu-fw-tune-h { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.lu-fw-tune-h b { font-size: 13px; color: var(--ink); }
.lu-fw-tune-h .lu-muted { font-size: 11.5px; }
.lu-fw-testin { border: 1px solid var(--border); border-radius: 10px; padding: 13px; background: var(--surface-2); display: flex; flex-direction: column; gap: 10px; }
.lu-fw-testin-h { display: flex; align-items: baseline; gap: 10px; } .lu-fw-testin-h b { font-size: 13px; } .lu-fw-testin-h .lu-muted { font-size: 11.5px; }
/* QC-24: the fill affordances' own row — pickers + Sample together, never
   wrapped into the header. */
.lu-fw-testin-fill { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-field { display: flex; flex-direction: column; gap: 5px; }
.lu-field > label { font-size: 12px; color: var(--muted); }
</style>
