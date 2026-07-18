<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// FeatureLab — the shared "test + tune" pane for ONE action, extracted from
// FeatureWorkbench (2026-07-02); since 2026-07-15 the Workbench is its only mount. Given an action + its prompt it builds the {{variables}} test input and feeds
// <CompareStrip> N engine-config columns you Run and Save as presets.
//
// State boundary: FeatureLab OWNS draft(prompt, read to run) + vars + columnConfig + the
// CompareStrip. The column now seeds ENTIRELY from the PRODUCTION PRESET (2026-07-15,
// one-source rewrite: the flattening trap dies structurally — the prompt row carries NO
// tunables anymore; params live ONLY on the preset). save-as / update-preset /
// delete-preset / use-production are emitted; the parent (Workbench) writes the
// feature's ref on use-production. NO LAUNCH SWITCHES
// here (§7.1): those live on the model — the column's "Engine switches" link opens Tune.
import { computed, reactive, ref, watch } from "vue";

import CompareStrip from "./CompareStrip.vue";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import { request } from "../client.js";
import { mergeVariables, testDataAction, testDataSources } from "../common/services/testData.js";
import { pushToast } from "../common/services/toastBridge.js";
import { presetToThinkingControl, thinkingControlToWire } from "../thinkingControl.js";

const props = defineProps({
  action: { type: String, default: "" },
  prompt: { type: Object, default: null },      // the action's prompt row (read to run)
  providers: { type: Array, default: () => [] },
  presets: { type: Array, default: () => [] },
  samplerCatalogList: { type: Array, default: () => [] },
  productionPresetId: { type: String, default: "" },
});
const emit = defineEmits(["use-production", "presets-changed", "prompt-changed"]);

const draft = ref(null);       // editable copy of the prompt (ephemeral test edits)
const vars = reactive({});
const varHint = "{{variables}}";

function buildVars() {
  for (const k of Object.keys(vars)) delete vars[k];
  const tpl = `${draft.value?.userTemplate || ""}\n${draft.value?.system || ""}`;
  const found = new Set([...tpl.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]));
  for (const v of found) vars[v] = vars[v] || "";
  if (!found.size) vars.user_content = vars.user_content || "";
}

function humanizeVar(k) {
  const s = String(k).replace(/[_-]+/g, " ").replace(/([a-z\d])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : k;
}

// Save-as / delete / update a tested column as an ENGINE preset. FeatureLab owns the
// /v1/ai/engine-presets calls (one source for both hosts) and emits the refreshed list.
function cfgToEnginePreset(name, cfg) {
  const num = (v) => (v === "" || v == null ? null : Number(v));
  return {
    name,
    providerId: cfg.pin?.providerId || "", model: cfg.pin?.model || "",
    temperature: num(cfg.temperature), topP: num(cfg.topP),
    maxTokens: Number(cfg.maxTokens) || 0,
    // The STORED three-state pair — the ONE mapping (thinkingControl.js). NO jsonMode
    // (2026-07-15): JSON is the ACTION's contract on the prompt row, never a preset field.
    ...thinkingControlToWire(cfg.reasoningEffort),
    samplers: (cfg.samplers || []).filter((r) => (r.name || "").trim()).map((r) => ({ flagName: r.name.trim(), flagValue: r.value || "" })),
  };
}
async function saveAs(name, cfg) {
  if (!name || !cfg) return;
  const r = await request("/v1/ai/engine-presets", { method: "POST", body: cfgToEnginePreset(name, cfg) });
  emit("presets-changed", r.presets || []);
  pushToast({ message: "Preset saved.", kind: "success" }); // after the await → success-only
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
  pushToast({ message: "Preset saved.", kind: "success" }); // after the await → success-only
}

// Persist the action's JSON-output setting to its prompt row (user-restored 2026-07-16 —
// the savable "Output as JSON" checkbox). The server OVERWRITES system/userTemplate on PUT
// (only jsonMode/jsonSchema/nav are preserve-on-omit), so send the FULL SAVED prompt
// (props.prompt — never the ephemeral draft) with only jsonMode changed. Reuses the kit
// request() + pushToast; emits prompt-changed so the parent refreshes its cached row (an
// in-place update — a remount on the next action-switch must not show the stale value).
async function saveJson(v) {
  const p = props.prompt;
  if (!props.action || !p) return;
  try {
    const r = await request(`/v1/ai/prompts/${encodeURIComponent(props.action)}`, {
      method: "PUT",
      body: {
        feature: p.feature || "",
        system: p.system || "",
        userTemplate: p.userTemplate || "",
        jsonMode: !!v,
        jsonSchema: p.jsonSchema ?? "",
        label: p.label || "",
        description: p.description || "",
        group: p.group || "",
      },
    });
    const on = !!(r?.jsonMode ?? v);
    if (draft.value) draft.value = { ...draft.value, jsonMode: on };
    emit("prompt-changed", { key: props.action, jsonMode: on });
    pushToast({ message: on ? "JSON output on for this feature." : "JSON output off for this feature." });
  } catch (e) {
    pushToast({ message: e?.message || "Couldn't save the JSON-output setting." });
  }
}

// Reset the local test state whenever the parent selects a different action.
watch(() => props.prompt, (p) => { draft.value = p ? { ...p } : null; buildVars(); }, { immediate: true });

// ── Test data (§7.3, rebuilt per QC-35 2026-07-09): per-ACTION affordances ──
// The host declares, per action, which pickers apply, whether a "From this book" compose
// button exists, and which DB sample labels fit this action's prompt contract. An
// undeclared action gets no pickers/compose; its Sample button cycles the whole action's
// samples (the freeform default).
const samples = ref([]);       // this action's DB samples
const sampleIx = ref(0);       // the next sample the button fills
const composing = ref(false);
const sources = testDataSources();
const sourceById = Object.fromEntries(sources.map((s) => [s.id, s]));
const sourceOptions = reactive({}); // source.id -> [{value,label}] (loaded on first need)

const decl = computed(() => testDataAction(props.action));
const pickers = computed(() =>
  (decl.value?.pickers || []).filter((p) => sourceById[p.source]));
const actionSamples = computed(() => {
  const labels = decl.value?.samples;
  if (!Array.isArray(labels) || !labels.length) return samples.value;
  return samples.value.filter((s) => labels.includes(s.label));
});

// Samples are per-ACTION now (2026-07-15: the task tier is gone — GET ?action=<key>).
watch(() => props.action, async (key) => {
  samples.value = [];
  sampleIx.value = 0;
  if (!key) return;
  try {
    samples.value = (await request(`/v1/ai/test-samples?action=${encodeURIComponent(key)}`)).rows || [];
  } catch { /* the button simply doesn't render */ }
}, { immediate: true });

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

// The action's run-config SEED for <ConfigColumn>. The production preset is the LIVE
// owner of EVERY tunable (2026-07-15). Not found (a fresh / unassigned action) → null,
// and the column seeds blank (a run sends no tunables until the user sets them — provider
// defaults apply; honest, never invented).
const productionPreset = computed(
  () => props.presets.find((p) => p.id === props.productionPresetId) || null,
);

const columnConfig = computed(() => {
  const d = draft.value || {};   // the prompt row: text + the JSON contract only
  const p = productionPreset.value;
  return {
    pin: p?.providerId ? { providerId: p.providerId, model: p.model || "" } : null,
    system: d.system, userTemplate: d.userTemplate,
    temperature: p?.temperature ?? "",
    topP: p?.topP ?? "",
    maxTokens: p?.maxTokens ?? 0,
    reasoningEffort: presetToThinkingControl(p),
    jsonMode: !!d.jsonMode,   // the ACTION's JSON contract (the savable "Output as JSON" checkbox)
    samplers: (p?.samplers || []).map((s) => ({ name: s.flagName, value: s.flagValue })),
  };
});
</script>

<template>
  <div class="lu-fw-tune">
    <div class="lu-fw-tune-h"><b>Tune presets</b><span class="lu-muted">run this feature's prompt on a test input · Save a column as a preset (it appears in the dropdowns)</span></div>
    <div class="lu-fw-testin">
      <div class="lu-fw-testin-h"><b>Test input</b><span class="lu-muted">the {{ varHint }} the prompt fills — shared across columns</span></div>
      <div v-if="pickers.length || decl?.compose || actionSamples.length" class="lu-fw-testin-fill">
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
      @save-json="saveJson"
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
.lu-fw-testin-fill { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-field { display: flex; flex-direction: column; gap: 5px; }
.lu-field > label { font-size: 12px; color: var(--muted); }
</style>
