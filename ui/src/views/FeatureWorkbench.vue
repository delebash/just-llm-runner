<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Feature Workbench — the single AI config + test surface (AI ▸ Routing by feature).
// The unit is the ACTION (37 of them); "feature" (writerAI, critique, …) is just
// the visual GROUP its actions live under. Per action: classify it into a job, then
// edit + test its FULL run config in the shared <ConfigColumn> (model + Plane-1
// engine switches + prompt + Plane-2 params/samplers + presets + Promote + a test
// with tok/s + cost). This is the ×1 rendering of <ConfigColumn>; Compare renders
// the SAME component ×N (Decision 23 — "the Feature view's editor pane already IS
// one Compare column"). RULE #7: one component, two call sites.
//
// Model assignment is stored as routing pins keyed by action key (/v1/ai/routing);
// prompts in /v1/ai/prompts; per-action samplers in /v1/ai/feature-samplers; the
// action's JOB switches in /v1/ai/job-switches; presets in /v1/ai/feature-presets.
// Shared across both apps — only the feature catalog differs.
import { computed, onMounted, reactive, ref } from "vue";

import CompareStrip from "../components/CompareStrip.vue";
import ConfigColumn from "../components/ConfigColumn.vue";
import LuJobSelect from "../components/LuJobSelect.vue";
import LuModelPicker from "../components/LuModelPicker.vue";
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
const routing = ref(null);   // {default, jobs:{jobId→{providerId,model}}, features:[…], pins:{key→{providerId,model}}}
const jobs = ref([]);        // the editable job list [{id,label,description,…}]
const featureJobs = ref({}); // feature key → job id
const providers = ref([]);
const presets = ref([]);     // feature presets (per action)
const samplerRows = ref([]); // the selected action's long-tail samplers (Plane-2 KnobGrid v-model)
const switchRows = ref([]);  // the selected action's JOB engine switches (Plane-1 KnobGrid v-model)
const knobCatalog = ref([]); // knob_catalog metadata (C1)
const samplerCatalog = computed(() =>
  Object.fromEntries(
    knobCatalog.value
      .filter((k) => k.plane === 2)
      .map((k) => [k.flagName, { label: k.label, help: k.help, options: k.options?.length ? k.options : undefined }]),
  ),
);
const switchCatalog = computed(() =>
  Object.fromEntries(
    knobCatalog.value
      .filter((k) => k.plane === 1)
      .map((k) => [k.flagName, { label: k.label, help: k.help, options: k.options?.length ? k.options : undefined }]),
  ),
);
const loading = ref(true);
const error = ref("");
const message = ref("");
const varHint = "{{variables}}"; // shown literally in the UI (avoids a nested {{ }} in the template)

const selAction = ref("");   // selected ACTION key
const draft = ref(null);     // editable copy of the selected action's prompt
const saving = ref(false);

const byId = computed(() => Object.fromEntries(providers.value.map((p) => [p.id, p])));
const providerName = (id) => byId.value[id]?.name || id || "—";
const featMeta = computed(() => Object.fromEntries((routing.value?.features || []).map((f) => [f.key, f])));

// jobLabel — display label for a job id (used by the nav's activeModel note).
const jobLabel = (id) => jobs.value.find((j) => j.id === id)?.label || id;

// Nav model: CATEGORY → features → (sub-labels) → action cards, each level
// indented under its header. A category whose actions ALL come from ONE
// multi-action feature is "merged" — the Set-all picker sits on the CATEGORY
// header — so there's no redundant feature sub-header. Otherwise each multi-action
// feature inside the category gets its own sub-header + Set-all; single-action
// features are plain cards.
const CATEGORY_FALLBACK = "Other";
const categories = computed(() => {
  const order = [];
  const byCat = {};
  for (const f of routing.value?.features || []) {
    const actions = prompts.value.filter((p) => p.feature === f.key);
    if (!actions.length) continue;
    const cat = f.category || CATEGORY_FALLBACK;
    if (!(cat in byCat)) { byCat[cat] = []; order.push(cat); }
    byCat[cat].push({ key: f.key, label: f.label, actions });
  }
  // Any prompt whose feature isn't in the catalog still gets a home (one
  // pseudo-feature per orphan feature key under "Other").
  const known = new Set((routing.value?.features || []).map((f) => f.key));
  for (const p of prompts.value) {
    if (known.has(p.feature)) continue;
    if (!(CATEGORY_FALLBACK in byCat)) { byCat[CATEGORY_FALLBACK] = []; order.push(CATEGORY_FALLBACK); }
    let g = byCat[CATEGORY_FALLBACK].find((x) => x.key === p.feature);
    if (!g) { g = { key: p.feature, label: p.feature, actions: [] }; byCat[CATEGORY_FALLBACK].push(g); }
    g.actions.push(p);
  }
  return order.map((c) => {
    const features = byCat[c];
    const merged = features.length === 1 && features[0].actions.length > 1 ? features[0] : null;
    return { label: c, features, merged };
  });
});

// Flat render list for the nav: one row per header / sub-label / card, each with
// an `indent` level so children sit visibly under their header. Set-all groups
// (a feature with >1 action) carry `setAll` so the header renders the picker.
const navRows = computed(() => {
  const rows = [];
  const pushActions = (f, base) => {
    for (const sg of subGroups(f.actions)) {
      if (sg.label) rows.push({ type: "sub", label: sg.label, indent: base });
      for (const a of sg.items) rows.push({ type: "card", action: a, indent: base });
    }
  };
  for (const cat of categories.value) {
    rows.push({ type: "cat", label: cat.label, setAll: cat.merged || null });
    for (const f of cat.features) {
      if (cat.merged) pushActions(f, 1);
      else if (f.actions.length > 1) { rows.push({ type: "ghead", label: f.label, setAll: f, indent: 1 }); pushActions(f, 1); }
      else rows.push({ type: "card", action: f.actions[0], indent: 1 });
    }
  }
  return rows;
});
function ml(level) { return level ? { marginLeft: `${level * 18}px` } : {}; }

const action = computed(() => prompts.value.find((p) => p.key === selAction.value) || null);
const actionPresets = computed(() => presets.value.filter((p) => p.action === selAction.value));

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
  return presets.value.some((p) => p.action === key && p.active);
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
  if (!val || !val.providerId) delete pins[key]; // inherit the job → no pin row
  else pins[key] = { providerId: val.providerId, model: val.model || "" };
  saveRouting();
}
// A feature's job classification (feature → job map), persisted immediately.
async function setFeatureJob(feature, jobId) {
  if (!jobId) await request(`/v1/ai/feature-jobs/${encodeURIComponent(feature)}`, { method: "DELETE" });
  else await request("/v1/ai/feature-jobs", { method: "PUT", body: { featureKey: feature, jobId } });
  const fj = await request("/v1/ai/feature-jobs");
  featureJobs.value = Object.fromEntries((fj.rows || []).map((x) => [x.featureKey, x.jobId]));
  // The action's switches live on its (new) job — reload them.
  if (selAction.value) loadSwitches(selAction.value);
}
// Set-all: write the same pin to every action in a feature group at once.
function setGroupAll(group, val) {
  const pins = routing.value.pins || (routing.value.pins = {});
  for (const a of group.actions) {
    if (!val || !val.providerId) delete pins[a.key];
    else pins[a.key] = { providerId: val.providerId, model: val.model || "" };
  }
  saveRouting();
}
// The shared pin if every action in the group has the same one, else null.
function groupCommonPin(group) {
  const sig = (k) => JSON.stringify(pin(k) || null);
  const first = sig(group.actions[0].key);
  return group.actions.every((a) => sig(a.key) === first) ? (pin(group.actions[0].key) || null) : null;
}
function groupMixed(group) {
  const sig = (k) => JSON.stringify(pin(k) || null);
  const first = sig(group.actions[0].key);
  return !group.actions.every((a) => sig(a.key) === first);
}
function setAllLabel(group) { return groupMixed(group) ? "Set all · (mixed)" : "Set all · inherit"; }
function featureOf(key) { return prompts.value.find((p) => p.key === key)?.feature || ""; }
// What an action currently resolves to, in plain terms (the nav "→ …"). Cascade:
// the action's own explicit pin → its feature's job model → the global Default LLM.
function activeModel(key) {
  const p = pin(key);
  if (p?.providerId) return providerName(p.providerId) + (p.model ? ` · ${p.model}` : "");
  const jobId = featureJobs.value[featureOf(key)] || "";
  const jt = routing.value?.jobs?.[jobId];
  if (jt?.providerId) return `${jobLabel(jobId)} · ${providerName(jt.providerId)}`;
  const d = routing.value?.default?.llmId;
  return d ? `Default · ${providerName(d)}` : "Default LLM (unset)";
}
async function load() {
  loading.value = true; error.value = "";
  try {
    const [p, r, pl, jb, fj] = await Promise.all([
      request("/v1/ai/prompts"), request("/v1/ai/routing"), request("/v1/llm-providers"),
      request("/v1/ai/jobs"), request("/v1/ai/feature-jobs"),
    ]);
    prompts.value = p.prompts || [];
    routing.value = r;
    if (!routing.value.pins) routing.value.pins = {};
    if (!routing.value.jobs) routing.value.jobs = {};
    providers.value = pl.providers || [];
    jobs.value = jb.rows || [];
    featureJobs.value = Object.fromEntries((fj.rows || []).map((x) => [x.featureKey, x.jobId]));
    try { presets.value = (await request("/v1/ai/feature-presets")).presets || []; }
    catch { presets.value = []; }
    try { knobCatalog.value = (await request("/v1/ai/knob-catalog")).knobs || []; }
    catch { knobCatalog.value = []; }
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
  loadSwitches(key);
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

// The action's JOB engine switches (Plane-1; job_route_switches). Switches are a
// per-Profile(job)+hardware axis (D17) — a feature column shows its job's switches,
// pre-filled, and Promote writes them back to the job (C3). No job → none.
async function loadSwitches(key) {
  const jobId = featureJobs.value[featureOf(key)] || "";
  if (!jobId) { switchRows.value = []; return; }
  try {
    const r = await request(`/v1/ai/job-switches?jobId=${encodeURIComponent(jobId)}&configId=active`);
    switchRows.value = (r.switches || []).map((sw) => ({ name: sw.flagName, value: sw.flagValue }));
  } catch {
    switchRows.value = [];
  }
}

// The selected action's run-config, as <ConfigColumn>'s v-model: the routing pin +
// the JOB switches + the prompt draft + per-call params + the long-tail samplers.
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
    body: { default: r.default, jobs: r.jobs || {}, pins: r.pins || {} },
  });
  if (!routing.value.pins) routing.value.pins = {};
  if (!routing.value.jobs) routing.value.jobs = {};
}

// ── presets (per action) — the <ConfigColumn> bar emits; FW owns the endpoints ──
// snapshot/applyToLive/useAsProduction operate on a CONFIG (default = the ×1
// editor's columnConfig); the Compare strip passes a specific column's config, so
// the promote path is shared by both surfaces (RULE #7) — not duplicated per view.
function snapshot(name, cfg) {
  const c = cfg || columnConfig.value;
  return {
    action: selAction.value, name,
    providerId: c.pin?.providerId || "",
    model: c.pin?.model || "",
    system: c.system || "", userTemplate: c.userTemplate || "",
    temperature: c.temperature === "" || c.temperature == null ? null : Number(c.temperature),
    think: !!c.reasoningEffort,
    topP: c.topP === "" || c.topP == null ? null : Number(c.topP),
    reasoningEffort: c.reasoningEffort || "",
  };
}
async function saveAs(name, cfg) {
  if (!name) return;
  presets.value = (await request("/v1/ai/feature-presets", { method: "POST", body: snapshot(name, cfg) })).presets || [];
  message.value = `Saved "${name}".`;
}
function applyPreset(id) {
  if (!id || !draft.value) return;
  const p = presets.value.find((x) => x.id === id);
  if (!p) return;
  draft.value.system = p.system; draft.value.userTemplate = p.userTemplate;
  draft.value.temperature = p.temperature; draft.value.think = p.think;
  draft.value.topP = p.topP; draft.value.reasoningEffort = p.reasoningEffort || "";
  const pins = routing.value.pins || (routing.value.pins = {});
  if (p.providerId) pins[selAction.value] = { providerId: p.providerId, model: p.model || "" };
  else delete pins[selAction.value];
  buildVars();
}
async function delPreset(id) {
  if (!id) return;
  presets.value = (await request(`/v1/ai/feature-presets/${id}`, { method: "DELETE" })).presets || [];
}
// Apply a CONFIG to the LIVE pipeline: the action's prompt + params + samplers +
// routing pin + (C3) its JOB switches. Default cfg = the ×1 editor; the Compare
// strip passes the winning column's config.
async function applyToLive(cfg) {
  const c = cfg || columnConfig.value;
  const act = action.value;
  if (act) {
    await request(`/v1/ai/prompts/${encodeURIComponent(act.key)}`, {
      method: "PUT",
      body: {
        feature: act.feature, system: c.system || "", userTemplate: c.userTemplate || "",
        temperature: Number(c.temperature) || 0, think: !!c.reasoningEffort,
        maxTokens: Number(c.maxTokens) || 0,
        jsonMode: !!c.jsonMode,
        topP: c.topP === "" || c.topP == null ? null : Number(c.topP),
        reasoningEffort: c.reasoningEffort || "",
      },
    });
    await request("/v1/ai/feature-samplers", {
      method: "PUT",
      body: {
        feature: act.key,
        samplers: (c.samplers || [])
          .filter((r) => (r.name || "").trim())
          .map((r) => ({ flagName: r.name.trim(), flagValue: r.value || "" })),
      },
    });
    // Plane-1 switches → the action's JOB (per C3 / D17). No job → nowhere to store.
    const jobId = featureJobs.value[act.feature] || "";
    if (jobId) {
      await request("/v1/ai/job-switches", {
        method: "PUT",
        body: {
          jobId, configId: "active",
          switches: (c.switches || [])
            .filter((r) => (r.name || "").trim())
            .map((r) => ({ flagName: r.name.trim(), flagValue: r.value || "" })),
        },
      });
    }
    // ×1 already wrote the pin live on edit; for a Compare promote, write the
    // winning column's pin to the action now.
    if (cfg) {
      const pins = routing.value.pins || (routing.value.pins = {});
      if (c.pin?.providerId) pins[act.key] = { providerId: c.pin.providerId, model: c.pin.model || "" };
      else delete pins[act.key];
    }
  }
  await saveRouting();
}
async function useAsProduction(presetId, cfg) {
  if (!action.value) return;
  saving.value = true; error.value = ""; message.value = "";
  try {
    let id = presetId || "";
    if (id) {
      const name = presets.value.find((p) => p.id === id)?.name || selAction.value;
      presets.value = (await request(`/v1/ai/feature-presets/${id}`, { method: "PUT", body: snapshot(name, cfg) })).presets || [];
    } else {
      const name = `${activeModel(selAction.value)} · ${new Date().toLocaleDateString()}`;
      presets.value = (await request("/v1/ai/feature-presets", { method: "POST", body: snapshot(name, cfg) })).presets || [];
      id = actionPresets.value.find((p) => p.name === name)?.id || "";
    }
    await applyToLive(cfg);
    if (id) presets.value = (await request(`/v1/ai/feature-presets/${id}/use`, { method: "POST" })).presets || [];
    message.value = "In production — the live pipeline runs this now.";
  } catch (e) {
    error.value = `Failed: ${e.message}`;
  } finally {
    saving.value = false;
  }
}
async function resetPrompt() {
  if (!draft.value?.builtIn) return;
  const updated = await request(`/v1/ai/prompts/${encodeURIComponent(draft.value.key)}/reset`, { method: "POST" });
  const i = prompts.value.findIndex((p) => p.key === updated.key);
  if (i >= 0) prompts.value[i] = updated;
  draft.value = { ...updated }; buildVars(); message.value = "Reset to seeded default.";
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

// ── Compare mode (Decision 23: a MODE inside this surface, not a separate tab) ──
const compareMode = ref(false);
const navCollapsed = ref(false);

// Promote a winning Compare column: run the SAME promote path the ×1 editor uses
// on that column's config (model + prompt + params → the action; Plane-1 switches →
// the action's job).
function onComparePromote(cfg) {
  useAsProduction("", cfg);
}

onMounted(load);
</script>

<template>
  <div class="lu-fw" :class="{ 'is-compare': compareMode }">
    <div v-if="error" class="lu-error" style="margin-bottom:10px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else-if="routing">
      <div class="lu-fw-body">
        <!-- Nav: category → (feature sub-header) → action cards. Hidden in Compare
             mode when the user collapses it for full column width. -->
        <aside v-show="!compareMode || !navCollapsed" class="lu-fw-list">
          <template v-for="(row, i) in navRows" :key="i">
            <div v-if="row.type === 'cat'" class="lu-fw-cat">
              <div class="lu-fw-cat-name">{{ row.label }}</div>
              <LuModelPicker v-if="row.setAll" class="lu-fw-setall" compact stacked
                :model-value="groupCommonPin(row.setAll)" :providers="providers"
                :inherit-label="setAllLabel(row.setAll)"
                :title="`Set the provider + model for all ${row.setAll.actions.length} actions under ${row.label}`"
                @update:model-value="setGroupAll(row.setAll, $event)" />
            </div>
            <div v-else-if="row.type === 'ghead'" class="lu-fw-ghead" :style="ml(row.indent)">
              <div class="lu-fw-gname">{{ row.label }}</div>
              <LuModelPicker class="lu-fw-setall" compact stacked
                :model-value="groupCommonPin(row.setAll)" :providers="providers"
                :inherit-label="setAllLabel(row.setAll)"
                :title="`Set the provider + model for all ${row.setAll.actions.length} ${row.label} actions`"
                @update:model-value="setGroupAll(row.setAll, $event)" />
            </div>
            <div v-else-if="row.type === 'sub'" class="lu-fw-sublabel" :style="ml(row.indent)">{{ row.label }}</div>
            <button v-else type="button" class="lu-fw-card" :style="ml(row.indent)"
              :class="{ 'is-active': row.action.key === selAction }" @click="selectAction(row.action.key)">
              <div class="lu-fw-card-label">{{ actionLabel(row.action) }}<span v-if="hasProd(row.action.key)" class="lu-fw-dot" title="has a production preset" /></div>
              <div v-if="actionDesc(row.action)" class="lu-fw-card-desc">{{ actionDesc(row.action) }}</div>
              <div class="lu-fw-card-model" title="currently active model">→ {{ activeModel(row.action.key) }}</div>
            </button>
          </template>
        </aside>

        <!-- Editor for the selected action -->
        <section v-if="action && draft" class="lu-fw-edit">
          <div class="lu-fw-h">
            <b>{{ actionLabel(action) }}</b>
            <span class="lu-fw-spacer" />
            <span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
            <UiButton v-if="compareMode" intent="ghost" size="small"
              :title="navCollapsed ? 'Show the feature list' : 'Hide the list for full column width'"
              @click="navCollapsed = !navCollapsed">{{ navCollapsed ? '☰ Show list' : '⟨ Collapse list' }}</UiButton>
            <UiButton :intent="compareMode ? 'primary' : 'secondary'" size="small"
              title="Compare this action across several model / switch / param configs"
              @click="compareMode = !compareMode">{{ compareMode ? '✓ Compare mode' : '⊞ Compare' }}</UiButton>
          </div>

          <!-- Job classification (this stays in FW — it's a per-feature routing
               concern, not part of the engine column). -->
          <div class="lu-field">
            <label>Job <span class="lu-muted">— this feature's task type; it runs on the job's model + switches unless pinned</span></label>
            <LuJobSelect :model-value="featureJobs[action.feature] || ''" :jobs="jobs"
              empty-label="— default job —"
              @update:model-value="setFeatureJob(action.feature, $event)" />
          </div>

          <!-- Shared test input — the action's {{variables}}; ONE set used by every
               column in Compare (a fair comparison). -->
          <div class="lu-fw-testin">
            <div class="lu-fw-testin-h"><b>Test input</b><span class="lu-muted">the {{ varHint }} the prompt fills — shared across compare columns</span></div>
            <div v-for="(_, k) in vars" :key="k" class="lu-field">
              <label>{{ humanizeVar(k) }}</label><UiTextarea v-model="vars[k]" auto-resize :rows="2" />
            </div>
            <div class="lu-fw-resetrow">
              <UiButton v-if="draft.builtIn" intent="ghost" size="small" @click="resetPrompt">Reset prompt to default</UiButton>
            </div>
          </div>

          <!-- ×1: the shared <ConfigColumn> (full editor). Compare renders the SAME
               component ×N in CompareStrip. -->
          <ConfigColumn v-if="!compareMode" :key="selAction" v-model="columnConfig"
            :action="selAction" :providers="providers"
            :sampler-catalog="samplerCatalog" :switch-catalog="switchCatalog"
            :vars="vars" :presets="actionPresets" :run-stream="props.runStream"
            inherit-label="Inherit job"
            @save-as="saveAs" @apply-preset="applyPreset" @use-production="useAsProduction" @delete-preset="delPreset" />

          <!-- ×N: Compare mode — N ConfigColumns over the shared action + input. -->
          <CompareStrip v-else :key="selAction"
            :action="selAction" :base-config="columnConfig" :providers="providers"
            :sampler-catalog="samplerCatalog" :switch-catalog="switchCatalog"
            :vars="vars" :presets="actionPresets"
            @promote="onComparePromote" @save-as="saveAs" @delete-preset="delPreset" />
        </section>
        <div v-else class="lu-muted" style="padding:20px">Pick an action on the left.</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lu-fw { display: flex; flex-direction: column; min-height: 0; }
select.lu-input { cursor: pointer; appearance: auto; }

.lu-fw-body { display: grid; grid-template-columns: minmax(300px, 28%) minmax(0, 1fr); gap: 16px; align-items: start; }
/* Compare mode: when the nav is collapsed the body is a single full-width column. */
.lu-fw.is-compare .lu-fw-body { grid-template-columns: minmax(280px, 24%) minmax(0, 1fr); }
.lu-fw-list { min-width: 0; border: 1px solid var(--border); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; max-height: calc(100vh - 240px); overflow-y: auto; overflow-x: hidden; position: sticky; top: 4px; }
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
.lu-fw-setall { background: var(--surface); border: 1px dashed var(--border); border-radius: 7px; padding: 5px 7px; }
.lu-fw-sublabel { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 6px 0 1px; }

.lu-fw-edit { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.lu-fw-h { display: flex; align-items: baseline; gap: 8px; }
.lu-fw-h b { font-size: 15px; color: var(--ink); }
.lu-fw-spacer { flex: 1; } .lu-fw-msg { font-size: 11.5px; }
.lu-field { display: flex; flex-direction: column; gap: 5px; }
.lu-field > label { font-size: 12px; color: var(--muted); }
.lu-fw-testin { border: 1px solid var(--border); border-radius: 10px; padding: 13px; background: var(--surface-2); display: flex; flex-direction: column; gap: 10px; }
.lu-fw-testin-h { display: flex; align-items: baseline; gap: 10px; } .lu-fw-testin-h b { font-size: 13px; } .lu-fw-testin-h .lu-muted { font-size: 11.5px; }
.lu-fw-resetrow { display: flex; justify-content: flex-end; }
</style>
