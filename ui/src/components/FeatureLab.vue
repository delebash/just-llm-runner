<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// FeatureLab — the shared "test + tune" pane for ONE action, extracted from
// FeatureWorkbench (2026-07-02) so the Tasks page reuses it instead of copying the
// wiring. Given an action + its prompt it builds the {{variables}} test input, loads
// the action's long-tail samplers, and feeds <CompareStrip> N engine-config columns
// you Run and Save as presets.
//
// State boundary (panel-decided): FeatureLab OWNS draft(prompt, read to run) + vars +
// samplers + switches + columnConfig + the CompareStrip. ROUTING stays in the PARENT —
// the pin arrives as a prop and is a READ-ONLY seed for the column's model (the pin-edit
// path was removed as vestigial; models persist via presets, not the routing pin), so
// there is ONE routing source of truth. save-as / update-preset / delete-preset /
// use-production are emitted; the parent decides the target — under Plan A that is always
// a TASK preset (the feature's task in the Workbench, the selected task on the Tasks page).
import { computed, onMounted, reactive, ref, watch } from "vue";

import CompareStrip from "./CompareStrip.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import { request } from "../client.js";

const props = defineProps({
  action: { type: String, default: "" },
  prompt: { type: Object, default: null },      // the action's prompt row (read to run)
  providers: { type: Array, default: () => [] },
  presets: { type: Array, default: () => [] },
  samplerCatalogList: { type: Array, default: () => [] },
  switchCatalogList: { type: Array, default: () => [] },
  productionPresetId: { type: String, default: "" },
  pin: { type: Object, default: null },         // the action's routing pin (parent-owned)
  handoff: { type: Object, default: null },     // a pending Tune→Tasks Lab payload (Phase 5)
});
const emit = defineEmits(["use-production", "presets-changed"]);

const draft = ref(null);       // editable copy of the prompt (ephemeral test edits)
const samplerRows = ref([]);   // the action's long-tail samplers (Plane-2)
const switchRows = ref([]);    // the action's engine switches (Plane-1)
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
    nglOverride: num(cfg.nglOverride), nCpuMoeOverride: num(cfg.nCpuMoeOverride),
    switches: (cfg.switches || []).filter((r) => (r.name || "").trim()).map((r) => ({ flagName: r.name.trim(), flagValue: r.value || "" })),
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
watch(() => props.action, (k) => { switchRows.value = []; loadSamplers(k); }, { immediate: true });

// The action's run-config SEED for <ConfigColumn>. Read-only: CompareStrip deep-clones
// this into each column, so edits live on the column and reach us through the column's
// save-as (not a write-back setter). `pin` is the feature's current routing pin, used
// only to seed the column's model — persisting a chosen model is done via Save-as-preset
// + assign ("Use for this task"), NOT via the routing pin.
const columnConfig = computed(() => {
  const d = draft.value || {};
  return {
    pin: props.pin,
    switches: switchRows.value,
    system: d.system, userTemplate: d.userTemplate,
    temperature: d.temperature, topP: d.topP, maxTokens: d.maxTokens,
    reasoningEffort: d.think ? (d.reasoningEffort || "medium") : "",
    jsonMode: d.jsonMode, samplers: samplerRows.value,
    nglOverride: null, nCpuMoeOverride: null,
  };
});

// ── Tune→Tasks Lab handoff (Phase 5): seed the tuned {model + switches} as a NEW column
// ALONGSIDE the task's preset column (compare, not clobber). Idempotent per FeatureLab
// instance (`seededHandoff`) but re-seeds on a fresh mount — so the column survives the
// `:key="testAgainst"` remount when the user assigns the first member to a member-less task.
const stripRef = ref(null);
function bundledRunnerProviderId() {
  // the tuned switches came from the local llama.cpp runner (/v1/llm-runner/load), so pin
  // THAT provider — not "first local" (Ollama is also local:true but can't run this model).
  const p = props.providers.find((x) => x.providerType === "local-llamacpp" || x.id === "local-llamacpp");
  return p?.id || "";
}
let seededHandoff = null;
function seedHandoffColumn(h) {
  if (!h || h === seededHandoff || !stripRef.value) return;
  seededHandoff = h;
  const providerId = h.providerId || bundledRunnerProviderId();
  stripRef.value.addColumn({
    ...columnConfig.value,
    pin: providerId || h.model ? { providerId, model: h.model || "" } : columnConfig.value.pin,
    switches: (h.switches || []).map((r) => ({ name: r.name, value: r.value })),
    switchesSource: "user", // the tuned switches are user-authored → the model seed won't clobber them
  });
}
onMounted(() => seedHandoffColumn(props.handoff));
watch(() => props.handoff, seedHandoffColumn);
</script>

<template>
  <div class="lu-fw-tune">
    <div class="lu-fw-tune-h"><b>Tune presets</b><span class="lu-muted">run this feature's prompt on a test input · Save a column as a preset (it appears in the dropdowns)</span></div>
    <div class="lu-fw-testin">
      <div class="lu-fw-testin-h"><b>Test input</b><span class="lu-muted">the {{ varHint }} the prompt fills — shared across columns</span></div>
      <div v-for="(_, k) in vars" :key="k" class="lu-field">
        <label>{{ humanizeVar(k) }}</label><UiTextarea v-model="vars[k]" auto-resize :rows="2" />
      </div>
    </div>
    <CompareStrip ref="stripRef" :key="action"
      :action="action" :base-config="columnConfig" :providers="providers"
      :sampler-catalog-list="samplerCatalogList" :switch-catalog-list="switchCatalogList"
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
.lu-field { display: flex; flex-direction: column; gap: 5px; }
.lu-field > label { font-size: 12px; color: var(--muted); }
</style>
