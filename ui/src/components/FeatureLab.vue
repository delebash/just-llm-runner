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
// the pin arrives as a prop and a pin change is EMITTED (`pin-change`); the parent
// persists it via its own saveRouting, so there is ONE routing source of truth (no
// forked copy). save-as / delete-preset / use-production are likewise emitted; the
// parent decides the target (a feature override in the Workbench, a task assignment on
// the Tasks page).
import { computed, reactive, ref, watch } from "vue";

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
});
const emit = defineEmits(["save-as", "delete-preset", "use-production", "pin-change"]);

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

// Reset the local test state whenever the parent selects a different action.
watch(() => props.prompt, (p) => { draft.value = p ? { ...p } : null; buildVars(); }, { immediate: true });
watch(() => props.action, (k) => { switchRows.value = []; loadSamplers(k); }, { immediate: true });

// The action's run-config, as <ConfigColumn>'s v-model. The getter reads the pin PROP
// (parent-owned); the setter emits pin-change when it differs instead of persisting.
const columnConfig = computed({
  get() {
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
  },
  set(v) {
    if (draft.value) {
      draft.value.system = v.system;
      draft.value.userTemplate = v.userTemplate;
      draft.value.temperature = v.temperature;
      draft.value.topP = v.topP;
      draft.value.maxTokens = v.maxTokens;
      draft.value.reasoningEffort = v.reasoningEffort || "";
      draft.value.think = !!v.reasoningEffort;
      draft.value.jsonMode = v.jsonMode;
    }
    samplerRows.value = v.samplers || [];
    switchRows.value = v.switches || [];
    if (JSON.stringify(props.pin || null) !== JSON.stringify(v.pin || null)) {
      emit("pin-change", v.pin || null);
    }
    buildVars();
  },
});
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
    <CompareStrip :key="action"
      :action="action" :base-config="columnConfig" :providers="providers"
      :sampler-catalog-list="samplerCatalogList" :switch-catalog-list="switchCatalogList"
      :vars="vars" :presets="presets" :production-preset-id="productionPresetId"
      @save-as="(name, cfg) => emit('save-as', name, cfg)"
      @delete-preset="(id) => emit('delete-preset', id)"
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
