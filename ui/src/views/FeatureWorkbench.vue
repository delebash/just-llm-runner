<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Feature Workbench — per the 2026-06-29 lab+preset model + the 2026-07-01 taskKind
// routing model. The unit is the ACTION; "feature" (writerAI, critique, …) is just
// the visual group its actions live under. The LEFT list groups actions by their
// nav `group` (display-only) and, per action, edits its PROMPT (system + instruction)
// + shows the engine preset it resolves to. The model + switches + params live IN the
// preset (built/tested in the Lab), so there is no model picker / switch grid here.
//   • Routing keys on the LLM-work taskKind, NOT the nav group: a preset is assigned
//     per taskKind (the assignment surface is a separate Phase-4 screen), with a
//     per-feature override on top (the cascade action-override → taskKind preset →
//     global default). This view still edits the per-feature override + shows the
//     resolved preset as provenance.
//   • Tuning (the Lab): a shared {{variables}} test input feeds <CompareStrip>, which
//     renders N engine-config columns you Run and then Save as engine presets.
//
// Endpoints: prompts in /v1/ai/prompts; the per-feature preset override in
// /v1/ai/preset-assignments; the engine-preset library in /v1/ai/engine-presets;
// the knob catalog in /v1/ai/knob-catalog. Shared across both apps — only the
// feature catalog differs.
import { computed, onMounted, reactive, ref } from "vue";

import CompareStrip from "../components/CompareStrip.vue";
import UiButton from "../common/components/UiButton.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import { request } from "../client.js";

// Optional host runner — streams an action through the host's task system (live
// progress, Cancel, the app's batch AI list). When given the column streams live;
// when absent it falls back to a one-shot /v1/ai/run. JustWrite passes a wrapper
// around runAiFeatureStream (→ aiTasks); JV will wire its own.
const props = defineProps({
  runStream: { type: Function, default: null },
});

const prompts = ref([]);     // all action prompts {key, feature, system, userTemplate, …}
const routing = ref(null);   // {default, features:[…], pins:{key→{providerId,model}}}
const providers = ref([]);
// The engine-preset library + the assignment maps. `presetAssign.taskKinds` is the
// taskKind→preset map (edited on the Phase-4 assignment surface); `.features` is the
// per-feature override this view edits; `.defaultPresetId` is the global default.
const enginePresets = ref([]);   // EnginePresetRow[]
const presetAssign = ref({ defaultPresetId: "", taskKinds: {}, features: {} });
const samplerRows = ref([]); // the selected action's long-tail samplers (Plane-2 KnobGrid v-model)
const switchRows = ref([]);  // the selected action's engine switches (Plane-1 KnobGrid v-model)
const knobCatalog = ref([]); // knob_catalog metadata (C1)
// Plane-2 samplers + Plane-1 switches as ORDERED raw catalog rows (the API returns
// them common-first by position) → the prefilled <KnobGrid> checklists in each
// ConfigColumn. The raw rows carry `kind` + `default`, which the checklist needs.
const samplerCatalogList = computed(() => knobCatalog.value.filter((k) => k.plane === 2));
const switchCatalogList = computed(() => knobCatalog.value.filter((k) => k.plane === 1));
const loading = ref(true);
const error = ref("");
const message = ref("");
const varHint = "{{variables}}"; // shown literally in the UI (avoids a nested {{ }} in the template)

const selAction = ref("");   // selected ACTION key
const draft = ref(null);     // editable copy of the selected action's prompt

const featMeta = computed(() => Object.fromEntries((routing.value?.features || []).map((f) => [f.key, f])));

// Nav model: GROUP → features → (sub-labels) → action cards, each level indented
// under its header (the `group` is display-only, not a routing key). A group whose
// actions ALL come from ONE multi-action feature is "merged" — no redundant feature
// sub-header; otherwise each multi-action feature inside the group gets its own
// sub-header. Single-action features are plain cards.
const GROUP_FALLBACK = "Other";
const navGroups = computed(() => {
  const order = [];
  const byGroup = {};
  for (const f of routing.value?.features || []) {
    const actions = prompts.value.filter((p) => p.feature === f.key);
    if (!actions.length) continue;
    const grp = f.group || GROUP_FALLBACK;
    if (!(grp in byGroup)) { byGroup[grp] = []; order.push(grp); }
    byGroup[grp].push({ key: f.key, label: f.label, actions });
  }
  // Any prompt whose feature isn't in the catalog still gets a home (one
  // pseudo-feature per orphan feature key under "Other").
  const known = new Set((routing.value?.features || []).map((f) => f.key));
  for (const p of prompts.value) {
    if (known.has(p.feature)) continue;
    if (!(GROUP_FALLBACK in byGroup)) { byGroup[GROUP_FALLBACK] = []; order.push(GROUP_FALLBACK); }
    let g = byGroup[GROUP_FALLBACK].find((x) => x.key === p.feature);
    if (!g) { g = { key: p.feature, label: p.feature, actions: [] }; byGroup[GROUP_FALLBACK].push(g); }
    g.actions.push(p);
  }
  return order.map((c) => {
    const features = byGroup[c];
    const merged = features.length === 1 && features[0].actions.length > 1 ? features[0] : null;
    return { label: c, features, merged };
  });
});

// Flat render list for the nav: one row per header / sub-label / card, each with
// an `indent` level so children sit visibly under their header.
const navRows = computed(() => {
  const rows = [];
  const pushActions = (f, base) => {
    for (const sg of subGroups(f.actions)) {
      if (sg.label) rows.push({ type: "sub", label: sg.label, indent: base });
      for (const a of sg.items) rows.push({ type: "card", action: a, indent: base });
    }
  };
  for (const grp of navGroups.value) {
    rows.push({ type: "group", label: grp.label });
    for (const f of grp.features) {
      if (grp.merged) pushActions(f, 1);
      else if (f.actions.length > 1) { rows.push({ type: "ghead", label: f.label, indent: 1 }); pushActions(f, 1); }
      else rows.push({ type: "card", action: f.actions[0], indent: 1 });
    }
  }
  return rows;
});
function ml(level) { return level ? { marginLeft: `${level * 18}px` } : {}; }

const action = computed(() => prompts.value.find((p) => p.key === selAction.value) || null);

// The action's display name: the seeded canonical label when set; else the
// feature's catalog label for a single-action feature; else a readable name
// derived from the key (feature prefix stripped).
function actionLabel(p) {
  if (p.label) return p.label;
  const f = p.feature;
  if (p.key === f) return featMeta.value[f]?.label || f;
  let s = p.key;
  if (s.startsWith(`${f}.`)) s = s.slice(f.length + 1);
  else if (s.startsWith(f)) s = s.slice(f.length);
  s = s.replace(/[._-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : p.key;
}
// Card blurb: the action's own description, else its feature's hint.
function actionDesc(a) {
  return a?.description || featMeta.value[a?.feature]?.hint || "";
}
// A user-facing label for a template variable key (voiceCanon → "Voice canon").
function humanizeVar(k) {
  const s = String(k).replace(/[_-]+/g, " ").replace(/([a-z\d])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : k;
}
function hasProd(key) {
  return !!presetAssign.value.features?.[key];  // the feature has its own preset override
}
// Split a feature's actions into Writer-Lab-style sub-sections by their `group`.
function subGroups(actions) {
  const order = [];
  const map = {};
  for (const a of actions) {
    const g = a.group || "";
    if (!(g in map)) { map[g] = []; order.push(g); }
    map[g].push(a);
  }
  return order.map((g) => ({ label: g, items: map[g] }));
}

// ── routing pins (keyed by feature OR action key) ────────────────────────────
function pin(key) { return routing.value?.pins?.[key] || null; }
function setPin(key, val) {
  const pins = routing.value.pins || (routing.value.pins = {});
  if (!val || !val.providerId) delete pins[key]; // no override → no pin row
  else pins[key] = { providerId: val.providerId, model: val.model || "" };
  saveRouting();
}
function featureOf(key) { return prompts.value.find((p) => p.key === key)?.feature || ""; }
async function load() {
  loading.value = true; error.value = "";
  try {
    const [p, r, pl] = await Promise.all([
      request("/v1/ai/prompts"), request("/v1/ai/routing"), request("/v1/llm-providers"),
    ]);
    prompts.value = p.prompts || [];
    routing.value = r;
    if (!routing.value.pins) routing.value.pins = {};
    providers.value = pl.providers || [];
    try { knobCatalog.value = (await request("/v1/ai/knob-catalog")).knobs || []; }
    catch { knobCatalog.value = []; }
    try { enginePresets.value = (await request("/v1/ai/engine-presets")).presets || []; }
    catch { enginePresets.value = []; }
    try { presetAssign.value = await request("/v1/ai/preset-assignments"); }
    catch { presetAssign.value = { defaultPresetId: "", taskKinds: {}, features: {} }; }
    const firstCard = navRows.value.find((rw) => rw.type === "card");
    if (!action.value && firstCard) selectAction(firstCard.action.key);
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

function selectAction(key) {
  selAction.value = key;
  const p = prompts.value.find((x) => x.key === key);
  draft.value = p ? { ...p } : null;
  message.value = "";
  buildVars();
  loadSamplers(key);
  switchRows.value = [];
}

// The action's long-tail samplers (Plane-2; feature_sampler_params).
async function loadSamplers(key) {
  try {
    const r = await request(`/v1/ai/feature-samplers?feature=${encodeURIComponent(key)}`);
    samplerRows.value = (r.samplers || []).map((s) => ({ name: s.flagName, value: s.flagValue }));
  } catch {
    samplerRows.value = [];
  }
}

// The selected action's run-config, as <ConfigColumn>'s v-model: the routing pin +
// the switches + the prompt draft + per-call params + the long-tail samplers.
// The getter reflects FW state (so Save-as / Use-as-production read the same
// draft/rows/pin); the setter writes them back, persists a PIN change immediately
// (params/prompt/switches don't touch routing until Promote), and refreshes the
// shared var set when the prompt changes.
const columnConfig = computed({
  get() {
    const d = draft.value || {};
    return {
      pin: pin(selAction.value),
      switches: switchRows.value,
      system: d.system, userTemplate: d.userTemplate,
      temperature: d.temperature, topP: d.topP, maxTokens: d.maxTokens,
      // think (bool) + reasoningEffort (level) collapse into ONE select: think on
      // with no stored level shows as "medium" (the default level).
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
      draft.value.think = !!v.reasoningEffort;   // reasoning on when an effort is picked
      draft.value.jsonMode = v.jsonMode;
    }
    samplerRows.value = v.samplers || [];
    switchRows.value = v.switches || [];
    if (JSON.stringify(pin(selAction.value) || null) !== JSON.stringify(v.pin || null)) {
      setPin(selAction.value, v.pin);
    }
    buildVars(); // the prompt may have changed → refresh the shared var inputs
  },
});

async function saveRouting() {
  const r = routing.value;
  routing.value = await request("/v1/ai/routing", {
    method: "PUT",
    body: { default: r.default, pins: r.pins || {} },
  });
  if (!routing.value.pins) routing.value.pins = {};
}

// ── engine presets (the Lab) — Save-as / Delete a tested column as an engine
// preset. FW owns the /v1/ai/engine-presets endpoints; CompareStrip emits. ──
// Save a tuning column's tested config as an ENGINE preset (model + switches +
// params + fit-knobs; the prompt is the feature's test input, NOT part of it).
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
  enginePresets.value = (await request("/v1/ai/engine-presets", { method: "POST", body: cfgToEnginePreset(name, cfg) })).presets || [];
  message.value = `Saved preset "${name}".`;
}
async function delPreset(id) {
  if (!id) return;
  enginePresets.value = (await request(`/v1/ai/engine-presets/${id}`, { method: "DELETE" })).presets || [];
}
async function resetPrompt() {
  if (!draft.value?.builtIn) return;
  const updated = await request(`/v1/ai/prompts/${encodeURIComponent(draft.value.key)}/reset`, { method: "POST" });
  const i = prompts.value.findIndex((p) => p.key === updated.key);
  if (i >= 0) prompts.value[i] = updated;
  draft.value = { ...updated }; buildVars(); message.value = "Reset to seeded default.";
}

// ── engine preset — this view edits the per-feature override; its model+switches+
// params live in the preset (built in the Lab). The taskKind→preset tier resolves
// server-side at dispatch (surfaced on the Phase-4 assignment surface). ──
function featurePreset(key) {
  return presetAssign.value.features?.[key] || "";
}
const presetName = (id) => enginePresets.value.find((p) => p.id === id)?.name || "preset";
// The preset shown muted on the nav card: the feature's own override if set, else
// the global default. The middle taskKind tier is resolved by the server at dispatch
// and isn't shown here yet — the Phase-4 assignment surface adds taskKind provenance.
function featurePresetLabel(key) {
  const fid = presetAssign.value.features?.[key];
  if (fid) return presetName(fid);
  const did = presetAssign.value.defaultPresetId;
  if (did) return `${presetName(did)} · default`;
  return "— none —";
}
async function setFeaturePreset(key, presetId) {
  presetAssign.value = await request("/v1/ai/preset-assignments/feature", {
    method: "PUT", body: { featureKey: key, presetId },
  });
}
// "Use in production" — make the column's selected preset the one this feature runs.
async function onUseProduction(presetId) {
  await setFeaturePreset(selAction.value, presetId);
  message.value = "In production — this feature runs that preset now.";
}

// The bulk preset assignment used to be a per-nav-group "set all" dropdown here.
// Routing now keys on the LLM-work taskKind, not the nav group, so bulk assignment
// moves to a dedicated taskKind→preset surface (Phase 4). This view keeps the
// per-feature override (setFeaturePreset above) + the resolved-preset provenance.

// Save just the feature's PROMPT text (params live in the preset now). Keeps the
// prompt row's existing param fields so nothing is wiped.
async function savePrompt() {
  const act = action.value;
  if (!act || !draft.value) return;
  try {
    const updated = await request(`/v1/ai/prompts/${encodeURIComponent(act.key)}`, {
      method: "PUT",
      body: {
        feature: act.feature,
        system: draft.value.system || "", userTemplate: draft.value.userTemplate || "",
        temperature: draft.value.temperature, think: draft.value.think,
        maxTokens: draft.value.maxTokens, jsonMode: draft.value.jsonMode,
        topP: draft.value.topP, reasoningEffort: draft.value.reasoningEffort || "",
      },
    });
    const i = prompts.value.findIndex((p) => p.key === updated.key);
    if (i >= 0) prompts.value[i] = updated;
    message.value = "Prompt saved.";
  } catch (e) {
    error.value = `Save failed: ${e.message}`;
  }
}

// ── shared test input (the action's {{variables}}) — passed to <ConfigColumn> ──
const vars = reactive({});
function buildVars() {
  for (const k of Object.keys(vars)) delete vars[k];
  const tpl = `${draft.value?.userTemplate || ""}\n${draft.value?.system || ""}`;
  const found = new Set([...tpl.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]));
  for (const v of found) vars[v] = vars[v] || "";
  if (!found.size) vars.user_content = vars.user_content || "";
}

// The left list can be collapsed to give the column workbench full width.
const navCollapsed = ref(false);

onMounted(load);
</script>

<template>
  <div class="lu-fw">
    <div v-if="error" class="lu-error" style="margin-bottom:10px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else-if="routing">
      <div class="lu-fw-body" :class="{ 'nav-collapsed': navCollapsed }">
        <!-- Nav: features grouped by their nav `group`, then the action cards.
             Collapsible to give the column workbench full width. -->
        <aside v-show="!navCollapsed" class="lu-fw-list">
          <template v-for="(row, i) in navRows" :key="i">
            <div v-if="row.type === 'group'" class="lu-fw-cat">
              <div class="lu-fw-cat-name">{{ row.label }}</div>
            </div>
            <div v-else-if="row.type === 'ghead'" class="lu-fw-ghead" :style="ml(row.indent)">
              <div class="lu-fw-gname">{{ row.label }}</div>
            </div>
            <div v-else-if="row.type === 'sub'" class="lu-fw-sublabel" :style="ml(row.indent)">{{ row.label }}</div>
            <button v-else type="button" class="lu-fw-card" :style="ml(row.indent)"
              :class="{ 'is-active': row.action.key === selAction }" @click="selectAction(row.action.key)">
              <div class="lu-fw-card-label">{{ actionLabel(row.action) }}<span v-if="hasProd(row.action.key)" class="lu-fw-dot" title="has a production preset" /></div>
              <div v-if="actionDesc(row.action)" class="lu-fw-card-desc">{{ actionDesc(row.action) }}</div>
              <div class="lu-fw-card-model" title="engine preset for this feature">→ {{ featurePresetLabel(row.action.key) }}</div>
            </button>
          </template>
        </aside>

        <!-- Editor for the selected action -->
        <section v-if="action && draft" class="lu-fw-edit">
          <div class="lu-fw-h">
            <b>{{ actionLabel(action) }}</b>
            <span class="lu-fw-spacer" />
            <span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
            <UiButton intent="ghost" size="small"
              :title="navCollapsed ? 'Show the feature list' : 'Hide the list for full column width'"
              @click="navCollapsed = !navCollapsed">{{ navCollapsed ? '☰ Show list' : '⟨ Collapse list' }}</UiButton>
          </div>

          <!-- The Lab, in-place: the feature's prompt (the testing prompt) + test input
               live in the column below; build/compare engine configs; Save a column as
               a preset (it appears in the dropdowns). -->
          <div class="lu-fw-tune">
            <div class="lu-fw-tune-h"><b>Tune presets</b><span class="lu-muted">run this feature's prompt on a test input · Save a column as a preset (it appears in the dropdowns)</span></div>
            <div class="lu-fw-testin">
              <div class="lu-fw-testin-h"><b>Test input</b><span class="lu-muted">the {{ varHint }} the prompt fills — shared across columns</span></div>
              <div v-for="(_, k) in vars" :key="k" class="lu-field">
                <label>{{ humanizeVar(k) }}</label><UiTextarea v-model="vars[k]" auto-resize :rows="2" />
              </div>
            </div>
            <CompareStrip :key="selAction"
              :action="selAction" :base-config="columnConfig" :providers="providers"
              :sampler-catalog-list="samplerCatalogList" :switch-catalog-list="switchCatalogList"
              :vars="vars" :presets="enginePresets" :production-preset-id="featurePreset(selAction)"
              @save-as="saveAs" @delete-preset="delPreset" @use-production="onUseProduction" />
          </div>
        </section>
        <div v-else class="lu-muted" style="padding:20px">Pick an action on the left.</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lu-fw { display: flex; flex-direction: column; min-height: 0; flex: 1; }
select.lu-input { cursor: pointer; appearance: auto; }

.lu-fw-body { display: grid; grid-template-columns: minmax(280px, 26%) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 16px; flex: 1; min-height: 0; }
/* Collapsed list → the editor + column workbench take the full width. */
.lu-fw-body.nav-collapsed { grid-template-columns: minmax(0, 1fr); }
.lu-fw-list { min-width: 0; min-height: 0; border: 1px solid var(--border); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; overflow-x: hidden; }
.lu-fw-card { text-align: left; font: inherit; cursor: pointer; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--border); border-left: 3px solid var(--border); background: var(--surface-2); transition: border-color .12s, background .12s; }
.lu-fw-card:hover { border-color: var(--accent); background: var(--accent-soft); }
.lu-fw-card.is-active { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.lu-fw-card-label { font-size: 12.5px; font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 6px; }
.lu-fw-card-desc { font-size: 11px; color: var(--muted); line-height: 1.4; margin-top: 3px; }
.lu-fw-card-model { font-size: 10.5px; font-weight: 600; color: var(--accent-ink, var(--accent)); margin-top: 4px; }
.lu-fw-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
.lu-fw-cat { display: flex; flex-direction: column; gap: 7px; padding: 10px 2px 2px; margin-top: 8px; border-top: 1px solid var(--border); }
.lu-fw-cat:first-child { border-top: 0; margin-top: 0; padding-top: 2px; }
.lu-fw-cat-name { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--ink); }
.lu-fw-ghead { display: flex; flex-direction: column; gap: 6px; padding: 4px 0 2px; }
.lu-fw-gname { font-size: 12px; font-weight: 700; color: var(--ink-2); }
.lu-fw-default { display: flex; flex-direction: column; gap: 6px; padding: 8px; margin-bottom: 4px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); }
.lu-fw-default-k { font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--ink); }
.lu-fw-default-k .lu-muted { font-weight: 600; letter-spacing: 0; text-transform: none; }
.lu-fw-sublabel { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 6px 0 1px; }

.lu-fw-edit { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
.lu-fw-h { display: flex; align-items: baseline; gap: 8px; }
.lu-fw-h b { font-size: 15px; color: var(--ink); }
.lu-fw-spacer { flex: 1; } .lu-fw-msg { font-size: 11.5px; }
.lu-field { display: flex; flex-direction: column; gap: 5px; }
.lu-field > label { font-size: 12px; color: var(--muted); }
.lu-fw-testin { border: 1px solid var(--border); border-radius: 10px; padding: 13px; background: var(--surface-2); display: flex; flex-direction: column; gap: 10px; }
.lu-fw-testin-h { display: flex; align-items: baseline; gap: 10px; } .lu-fw-testin-h b { font-size: 13px; } .lu-fw-testin-h .lu-muted { font-size: 11.5px; }
.lu-fw-resetrow { display: flex; gap: 8px; justify-content: flex-end; }
.lu-fw-tune { display: flex; flex-direction: column; gap: 12px; margin-top: 6px; padding-top: 14px; border-top: 1px solid var(--border); }
.lu-fw-tune-h { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.lu-fw-tune-h b { font-size: 13px; color: var(--ink); }
.lu-fw-tune-h .lu-muted { font-size: 11.5px; }
</style>
