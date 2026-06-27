<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Feature Workbench — the single AI config + test surface (AI ▸ Features). The
// unit is the ACTION (37 of them); "feature" (writerAI, critique, …) is just the
// visual GROUP its actions live under. Per action: pick its model (or inherit a
// role / the global Default LLM), edit its prompt + params, TEST on real input,
// save NAMED presets, and mark one "use as production".
//
// It also absorbs the old Feature Routing: the GLOBALS (default LLM + embedding,
// Quick/Accuracy roles) sit at the top; each multi-action group header has a
// "Set all" applicator that writes the model for every action in the group at
// once (there is no separate per-feature default — an action resolves: its own
// pin → its feature's default role → the Default LLM).
//
// Model assignment is stored as routing pins keyed by feature OR action key
// (/v1/ai/routing); prompts in /v1/ai/prompts; presets in /v1/ai/feature-presets.
// Shared across both apps — only the feature catalog differs.
import { computed, nextTick, onMounted, reactive, ref } from "vue";

import UiButton from "../common/components/UiButton.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiInput from "../common/components/UiInput.vue";
import LuModelPicker from "../components/LuModelPicker.vue";
import KnobGrid from "../components/KnobGrid.vue";
import LuJobSelect from "../components/LuJobSelect.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import { request } from "../client.js";

// Optional host runner — streams an action through the host's task system
// (live progress, Cancel, the app's batch AI list, token usage). When given, the
// test panel streams live with tokens + word count + a Cancel button; when
// absent it falls back to a one-shot /v1/ai/run (output only). JustWrite passes a
// wrapper around runAiFeatureStream (→ aiTasks); JV will wire its own.
const props = defineProps({
  runStream: { type: Function, default: null },
});

const prompts = ref([]);     // all action prompts {key, feature, system, userTemplate, temperature, think, builtIn}
const routing = ref(null);   // {default, jobs:{jobId→{providerId,model}}, features:[…], pins:{key→{providerId,model}}}
const jobs = ref([]);        // the editable job list [{id,label,description,…}]
const featureJobs = ref({}); // feature key → job id
const providers = ref([]);
const presets = ref([]);     // feature presets (per action)
const samplerRows = ref([]); // the selected action's long-tail samplers (KnobGrid v-model: {name,value})
const loading = ref(true);
const error = ref("");
const message = ref("");

const selAction = ref("");   // selected ACTION key
const draft = ref(null);     // editable copy of the selected action's prompt
const selPreset = ref("");
const naming = ref(false);
const newName = ref("");
const nameRef = ref(null);
const saving = ref(false);

const varHint = "{{variable}} placeholders";

const byId = computed(() => Object.fromEntries(providers.value.map((p) => [p.id, p])));
const providerName = (id) => byId.value[id]?.name || id || "—";
const featMeta = computed(() => Object.fromEntries((routing.value?.features || []).map((f) => [f.key, f])));

// jobLabel — display label for a job id (used by the nav's activeModel note).
// (Job→model cards + Defaults moved to the "Routing by job" tab; this workbench
// only classifies features into jobs + does per-action pins/prompts/test.)
const jobLabel = (id) => jobs.value.find((j) => j.id === id)?.label || id;

// Nav model: CATEGORY → features → (sub-labels) → action cards, each level
// indented under its header. A category whose actions ALL come from ONE
// multi-action feature is "merged" — the Set-all picker sits on the CATEGORY
// header (e.g. Writing/writerAI, Analysis/critique), so there's no redundant
// feature sub-header. Otherwise each multi-action feature inside the category
// gets its own sub-header + Set-all; single-action features are plain cards.
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
  // Everything under a category sits at ONE indent level — a sub-label / group
  // header doesn't push its cards in further (no double indent).
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
const activePreset = computed(() => actionPresets.value.find((p) => p.active) || null);

// The action's display name: the seeded canonical label (point-of-use name) when
// set; else the feature's catalog label for a single-action feature; else a
// readable name derived from the key (feature prefix stripped).
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
// Split a feature's actions into Writer-Lab-style sub-sections by their `group`
// (e.g. writerAI → "Prose actions" / "Line edits"); "" = no sub-label.
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
// The picker UI is the shared <LuModelPicker>; the host just reads the current
// pin and writes the picker's emitted pin back into routing, then saves.
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
}
// Set-all: write the same pin to every action in a feature group at once (each
// action gets its own pin — there's no feature-level pin). Empty → clear them all
// (every action falls back to inherit).
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
// Label for a Set-all picker's inherit option — flags a mixed group so the empty
// selection isn't mistaken for "all inherit".
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
    // Presets are optional per app (an app may not mount the endpoint yet).
    try { presets.value = (await request("/v1/ai/feature-presets")).presets || []; }
    catch { presets.value = []; }
    const firstCard = navRows.value.find((r) => r.type === "card");
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
  selPreset.value = ""; naming.value = false; message.value = "";
  testOut.value = null; testErr.value = ""; buildVars();
  loadSamplers(key);
}

// The action's long-tail samplers (top_k/min_p/mirostat/…) beyond the built-in
// temp/top-p/json/think fields — stored in feature_sampler_params, merged into the
// dispatch `extra`. Saved with the action on "Use as production".
async function loadSamplers(key) {
  try {
    const r = await request(`/v1/ai/feature-samplers?feature=${encodeURIComponent(key)}`);
    samplerRows.value = (r.samplers || []).map((s) => ({ name: s.flagName, value: s.flagValue }));
  } catch {
    samplerRows.value = [];
  }
}

async function saveRouting() {
  const r = routing.value;
  routing.value = await request("/v1/ai/routing", {
    method: "PUT",
    body: { default: r.default, jobs: r.jobs || {}, pins: r.pins || {} },
  });
  if (!routing.value.pins) routing.value.pins = {};
  if (!routing.value.jobs) routing.value.jobs = {};
}

// ── presets (per action) ─────────────────────────────────────────────────────
function snapshot(name) {
  const p = pin(selAction.value);
  return {
    action: selAction.value, name,
    providerId: p?.providerId || "",
    model: p?.model || "",
    system: draft.value?.system || "", userTemplate: draft.value?.userTemplate || "",
    temperature: draft.value?.temperature === "" || draft.value?.temperature == null ? null : Number(draft.value.temperature),
    think: !!draft.value?.think,
  };
}
function startNaming() {
  naming.value = true; newName.value = "";
  nextTick(() => { (nameRef.value?.$el || nameRef.value)?.focus?.(); });
}
async function saveAs() {
  const name = newName.value.trim();
  if (!name) { naming.value = false; return; }
  // Save → reload the dropdown (all of this action's configs) with the new one selected.
  presets.value = (await request("/v1/ai/feature-presets", { method: "POST", body: snapshot(name) })).presets || [];
  selPreset.value = actionPresets.value.find((p) => p.name === name)?.id || "";
  naming.value = false; newName.value = ""; message.value = `Saved "${name}".`;
}
function applyPreset(id) {
  selPreset.value = id;
  if (!id || !draft.value) { return; }
  const p = presets.value.find((x) => x.id === id);
  if (!p) return;
  draft.value.system = p.system; draft.value.userTemplate = p.userTemplate;
  draft.value.temperature = p.temperature; draft.value.think = p.think;
  const pins = routing.value.pins || (routing.value.pins = {});
  if (p.providerId) pins[selAction.value] = { providerId: p.providerId, model: p.model || "" };
  else delete pins[selAction.value];
  buildVars();
}
async function delPreset() {
  if (!selPreset.value) return;
  presets.value = (await request(`/v1/ai/feature-presets/${selPreset.value}`, { method: "DELETE" })).presets || [];
  selPreset.value = "";
}
// Apply the draft to the LIVE config: write the action's prompt + persist its
// routing pin (saveRouting already ran on each pin change, but re-save to be safe).
async function applyToLive() {
  if (draft.value) {
    await request(`/v1/ai/prompts/${encodeURIComponent(draft.value.key)}`, {
      method: "PUT",
      body: {
        feature: draft.value.feature, system: draft.value.system, userTemplate: draft.value.userTemplate,
        temperature: Number(draft.value.temperature) || 0, think: !!draft.value.think,
        maxTokens: Number(draft.value.maxTokens) || 0,
        jsonMode: !!draft.value.jsonMode,
        topP: draft.value.topP === "" || draft.value.topP == null ? null : Number(draft.value.topP),
      },
    });
    // Persist the action's long-tail samplers alongside its prompt.
    await request("/v1/ai/feature-samplers", {
      method: "PUT",
      body: {
        feature: draft.value.key,
        samplers: samplerRows.value
          .filter((r) => (r.name || "").trim())
          .map((r) => ({ flagName: r.name.trim(), flagValue: r.value || "" })),
      },
    });
  }
  await saveRouting();
}
async function useAsProduction() {
  if (!draft.value) return;
  saving.value = true; error.value = ""; message.value = "";
  try {
    let id = selPreset.value;
    if (id) {
      const name = presets.value.find((p) => p.id === id)?.name || selAction.value;
      presets.value = (await request(`/v1/ai/feature-presets/${id}`, { method: "PUT", body: snapshot(name) })).presets || [];
    } else {
      const name = `${activeModel(selAction.value)} · ${new Date().toLocaleDateString()}`;
      presets.value = (await request("/v1/ai/feature-presets", { method: "POST", body: snapshot(name) })).presets || [];
      id = actionPresets.value.find((p) => p.name === name)?.id || ""; selPreset.value = id;
    }
    await applyToLive();
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

// ── test panel ───────────────────────────────────────────────────────────────
const vars = reactive({});
const testOut = ref(null);
const testErr = ref("");
const testing = ref(false);
function buildVars() {
  for (const k of Object.keys(vars)) delete vars[k];
  const tpl = `${draft.value?.userTemplate || ""}\n${draft.value?.system || ""}`;
  const found = new Set([...tpl.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]));
  for (const v of found) vars[v] = vars[v] || "";
  if (!found.size) vars.user_content = vars.user_content || "";
}
const testCtrl = ref(null);
function wordCount(s) { return (String(s || "").trim().match(/\S+/g) || []).length; }
function cancelTest() { testCtrl.value?.abort(); }

async function runTest() {
  if (!draft.value) return;
  testing.value = true; testErr.value = ""; testOut.value = null;
  const t0 = performance.now();
  // Test the in-editor CANDIDATE (loaded preset / unsaved edits), not just the
  // live prompt — so you can try presets before promoting one to production.
  const o = {
    action: draft.value.key, variables: { ...vars },
    temperature: Number(draft.value.temperature), think: !!draft.value.think,
    maxTokens: Number(draft.value.maxTokens) || 0,
    jsonMode: !!draft.value.jsonMode,
    topP: draft.value.topP === "" || draft.value.topP == null ? null : Number(draft.value.topP),
    system: draft.value.system, userTemplate: draft.value.userTemplate,
  };
  try {
    if (props.runStream) {
      // Stream via the host: live progress + Cancel + the batch AI list + tokens.
      const ctrl = new AbortController();
      testCtrl.value = ctrl;
      testOut.value = { content: "", model: "", ms: 0, tokens: 0, tps: 0, words: 0 };
      const res = await props.runStream({
        ...o, signal: ctrl.signal,
        onDelta: (_d, full) => { if (testOut.value) { testOut.value.content = full; testOut.value.words = wordCount(full); } },
      });
      const u = res?.usage || {};
      const ms = Math.round(performance.now() - t0);
      const outTokens = u.completionTokens || 0;
      testOut.value = {
        content: res?.content || "", model: res?.model || "",
        ms,
        tokens: (u.promptTokens || 0) + outTokens,
        // Decode speed = output tokens / wall-second (prompt tokens are prefilled,
        // not decoded, so they're excluded). The lab's engine-tuning yardstick.
        tps: ms > 0 && outTokens > 0 ? +(outTokens / (ms / 1000)).toFixed(1) : 0,
        words: wordCount(res?.content || ""),
      };
    } else {
      const r = await request("/v1/ai/run", { method: "POST", body: o });
      testOut.value = { content: r.content, model: r.model, ms: Math.round(performance.now() - t0), tokens: 0, tps: 0, words: wordCount(r.content) };
    }
  } catch (e) {
    if (e?.name === "AbortError" || /abort|cancel/i.test(e?.message || "")) testErr.value = "Cancelled.";
    else testErr.value = e.message?.includes("501") ? "No LLM wired for this route — set a model above or connect a provider." : (e.message || "Run failed.");
  } finally {
    testing.value = false; testCtrl.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="lu-fw">
    <div v-if="error" class="lu-error" style="margin-bottom:10px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else-if="routing">
      <!-- Defaults + the per-job model cards moved to the "Routing by job" tab
           (RoutingByJob.vue). This workbench is per-feature: classify each feature
           into a job + the rare per-action pin/prompt/test. -->
      <div class="lu-fw-body">
        <!-- Nav: category → (feature sub-header) → action cards, each level
             indented under its header. A header with a "Set all" picker routes
             every action under it at once. -->
        <aside class="lu-fw-list">
          <template v-for="(row, i) in navRows" :key="i">
            <!-- Category header (merged single-feature category carries Set-all) -->
            <div v-if="row.type === 'cat'" class="lu-fw-cat">
              <div class="lu-fw-cat-name">{{ row.label }}</div>
              <LuModelPicker v-if="row.setAll" class="lu-fw-setall" compact stacked
                :model-value="groupCommonPin(row.setAll)" :providers="providers"
                :inherit-label="setAllLabel(row.setAll)"
                :title="`Set the provider + model for all ${row.setAll.actions.length} actions under ${row.label}`"
                @update:model-value="setGroupAll(row.setAll, $event)" />
            </div>
            <!-- Feature sub-header (multi-action feature in a multi-feature category) -->
            <div v-else-if="row.type === 'ghead'" class="lu-fw-ghead" :style="ml(row.indent)">
              <div class="lu-fw-gname">{{ row.label }}</div>
              <LuModelPicker class="lu-fw-setall" compact stacked
                :model-value="groupCommonPin(row.setAll)" :providers="providers"
                :inherit-label="setAllLabel(row.setAll)"
                :title="`Set the provider + model for all ${row.setAll.actions.length} ${row.label} actions`"
                @update:model-value="setGroupAll(row.setAll, $event)" />
            </div>
            <!-- Sub-label divider (writerAI's Prose actions / Line edits) -->
            <div v-else-if="row.type === 'sub'" class="lu-fw-sublabel" :style="ml(row.indent)">{{ row.label }}</div>
            <!-- Action card -->
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
            <span class="lu-fw-spacer" /><span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
          </div>

          <!-- Presets bar (SpeakerLab parity) -->
          <div class="lu-fw-presets">
            <span class="lu-fw-eyebrow">Presets</span>
            <select class="lu-input lu-fw-presel" :value="selPreset" @change="applyPreset($event.target.value)">
              <option value="">— current —</option>
              <option v-for="p in actionPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <UiButton v-if="selPreset" intent="ghost" size="small" title="Delete this config" @click="delPreset">🗑</UiButton>
            <UiInput v-if="naming" ref="nameRef" v-model="newName" placeholder="name — press Enter" class="lu-fw-name-in"
              @keyup.enter="saveAs" @keyup.esc="naming = false; newName = ''" />
            <UiButton v-else intent="secondary" size="small" title="Save this config as a named preset" @click="startNaming">＋ Save as</UiButton>
            <UiButton intent="secondary" size="small" :loading="saving" title="Apply this config to the live pipeline" @click="useAsProduction">✓ Use as production</UiButton>
            <span v-if="activePreset" class="lu-fw-prod" :title="`The live pipeline runs '${activePreset.name}'.`">✓ PRODUCTION · {{ activePreset.name }}</span>
          </div>

          <!-- Provider + model for this action (shared LuModelPicker). The
               selects ARE the source of truth — the inherit option names what it
               resolves to (e.g. "Inherit default · Quick"), so there's no
               separate redundant "→ role" note. -->
          <div class="lu-field">
            <label>Job <span class="lu-muted">— this feature's task type; it runs on the job's model unless pinned below</span></label>
            <LuJobSelect :model-value="featureJobs[action.feature] || ''" :jobs="jobs"
              empty-label="— default job —"
              @update:model-value="setFeatureJob(action.feature, $event)" />
          </div>
          <div class="lu-field">
            <label>Provider &amp; model <span class="lu-muted">— pin this action to a specific provider + model (overrides its job)</span></label>
            <LuModelPicker editable :model-value="pin(selAction)" :providers="providers" :labels="true"
              inherit-label="Inherit job" @update:model-value="setPin(selAction, $event)" />
          </div>

          <div class="lu-field"><label>System prompt</label>
            <UiTextarea v-model="draft.system" auto-resize :rows="7" @input="buildVars" /></div>
          <div class="lu-field"><label>Instruction <span class="lu-muted">— user template · {{ varHint }}</span></label>
            <UiTextarea v-model="draft.userTemplate" auto-resize :rows="4" @input="buildVars" /></div>

          <div class="lu-fw-params">
            <div class="lu-field lu-fw-temp"><label>Temperature</label><UiInput v-model="draft.temperature" type="number" /></div>
            <div class="lu-field lu-fw-temp"><label>Top-p <span class="lu-muted">blank = default</span></label><UiInput v-model="draft.topP" type="number" /></div>
            <div class="lu-field lu-fw-temp"><label>Max tokens <span class="lu-muted">0 = none</span></label><UiInput v-model="draft.maxTokens" type="number" /></div>
            <label class="lu-fw-think"><UiCheckbox v-model="draft.think" /><span class="lu-muted">Reasoning (think)</span></label>
            <label class="lu-fw-think"><UiCheckbox v-model="draft.jsonMode" /><span class="lu-muted">JSON output</span></label>
            <span class="lu-fw-spacer" />
            <UiButton v-if="draft.builtIn" intent="ghost" size="small" @click="resetPrompt">Reset prompt to default</UiButton>
          </div>

          <!-- Advanced samplers (Plane-2 long tail) — the same KnobGrid as engine
               switches; saved with the action on "Use as production", merged into
               the chat call at dispatch. Most apply to local models. -->
          <details class="lu-fw-samplers" style="margin: 2px 0 6px">
            <summary class="lu-fw-eyebrow" style="cursor: pointer">Advanced samplers
              <span class="lu-muted">— extra knobs: top_k · min_p · mirostat · dry_* … (mostly local models)</span>
            </summary>
            <div style="margin-top: 8px">
              <KnobGrid v-model="samplerRows" add-label="＋ Add sampler" name-placeholder="sampler (e.g. top_k)" />
            </div>
          </details>

          <div class="lu-fw-test">
            <div class="lu-fw-th"><b>Test on real input</b><span class="lu-muted">runs the prompt + model shown above — try a preset before you save it</span></div>
            <div v-for="(_, k) in vars" :key="k" class="lu-field">
              <label>{{ humanizeVar(k) }}</label><UiTextarea v-model="vars[k]" auto-resize :rows="2" />
            </div>
            <div class="lu-fw-trow">
              <UiButton v-if="!testing" intent="primary" size="small" @click="runTest">▶ Run</UiButton>
              <UiButton v-else intent="secondary" size="small" @click="cancelTest">■ Cancel</UiButton>
              <span v-if="testing" class="lu-muted lu-fw-running">Running… (also in the AI tasks strip)</span>
              <span v-if="testErr" class="lu-error lu-fw-terr">{{ testErr }}</span>
            </div>
            <div v-if="testOut" class="lu-fw-out">
              <pre class="lu-fw-pre">{{ testOut.content }}</pre>
              <div class="lu-muted lu-fw-stats">
                <template v-if="testOut.model">model <b>{{ testOut.model }}</b> · </template>
                <b>{{ testOut.words }}</b> words<template v-if="testOut.tokens"> · <b>{{ testOut.tokens }}</b> tokens</template><template v-if="testOut.tps"> · <b>{{ testOut.tps }}</b> tok/s</template> · {{ testOut.ms }} ms
              </div>
            </div>
          </div>
        </section>
        <div v-else class="lu-muted" style="padding:20px">Pick an action on the left.</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lu-fw { display: flex; flex-direction: column; min-height: 0; }

/* (Defaults + per-job role cards moved to the Routing-by-job tab — their styles
   live in RoutingByJob.vue now; removed the dead globals CSS here.) */
select.lu-input { cursor: pointer; appearance: auto; }

/* Body = nav + editor. The nav is a self-contained scroller (capped height,
   sticky) so a long action list never stretches the page. */
/* Nav column grows with the window (flex-like) so the Set-all pickers are always
   readable; min 480px keeps them usable when narrow. Editor takes the rest. */
.lu-fw-body { display: grid; grid-template-columns: minmax(300px, 28%) minmax(0, 1fr); gap: 16px; align-items: start; }
/* min-width:0 so the column never forces horizontal scroll — the picker selects
   (min-width:0) shrink to fit instead of overflowing. */
.lu-fw-list { min-width: 0; border: 1px solid var(--border); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; max-height: calc(100vh - 240px); overflow-y: auto; overflow-x: hidden; position: sticky; top: 4px; }
/* Writer-Lab-style action card: label + blurb, accent on hover/active. */
/* No width:100% — the card is a flex item that stretches to the list width, so a
   margin-left (indent) insets it cleanly instead of overflowing + clipping. A
   left rail makes the "under this header" grouping obvious. */
.lu-fw-card { text-align: left; font: inherit; cursor: pointer; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--border); border-left: 3px solid var(--border); background: var(--surface-2); transition: border-color .12s, background .12s; }
.lu-fw-card:hover { border-color: var(--accent); background: var(--accent-soft); }
.lu-fw-card.is-active { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.lu-fw-card-label { font-size: 12.5px; font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 6px; }
.lu-fw-card-desc { font-size: 11px; color: var(--muted); line-height: 1.4; margin-top: 3px; }
.lu-fw-card-model { font-size: 10.5px; font-weight: 600; color: var(--accent-ink, var(--accent)); margin-top: 4px; }
.lu-fw-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
/* Category header — the nav's primary grouping (Writing / Analysis / …); a
   merged single-feature category also carries its Set-all picker below the name. */
.lu-fw-cat { display: flex; flex-direction: column; gap: 7px; padding: 10px 2px 2px; margin-top: 8px; border-top: 1px solid var(--border); }
.lu-fw-cat:first-child { border-top: 0; margin-top: 0; padding-top: 2px; }
.lu-fw-cat-name { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--ink); }
/* Feature sub-header inside a multi-feature category (name + Set-all). */
.lu-fw-ghead { display: flex; flex-direction: column; gap: 6px; padding: 4px 0 2px; }
.lu-fw-gname { font-size: 12px; font-weight: 700; color: var(--ink-2); }
/* Set-all route picker on a header — a faint dashed surface so it reads as
   "set the model for everything indented below". */
.lu-fw-setall { background: var(--surface); border: 1px dashed var(--border); border-radius: 7px; padding: 5px 7px; }
.lu-fw-sublabel { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 6px 0 1px; }

/* Editor */
.lu-fw-edit { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.lu-fw-h { display: flex; align-items: baseline; gap: 8px; }
.lu-fw-h b { font-size: 15px; color: var(--ink); }
.lu-fw-spacer { flex: 1; } .lu-fw-msg { font-size: 11.5px; }
.lu-fw-presets { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); }
.lu-fw-eyebrow { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.lu-fw-presel { max-width: 200px; cursor: pointer; appearance: auto; }
.lu-fw-name-in { max-width: 170px; }
.lu-fw-prod { margin-left: auto; font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 3px 10px; background: var(--accent); color: var(--on-accent, #fff); }
.lu-field { display: flex; flex-direction: column; gap: 5px; }
.lu-field > label { font-size: 12px; color: var(--muted); }
.lu-fw-params { display: flex; gap: 24px; align-items: flex-end; }
.lu-fw-temp { max-width: 110px; }
.lu-fw-think { display: flex; align-items: center; gap: 8px; }
.lu-fw-test { border: 1px solid var(--border); border-radius: 10px; padding: 13px; background: var(--surface-2); display: flex; flex-direction: column; gap: 10px; }
.lu-fw-th { display: flex; align-items: baseline; gap: 10px; } .lu-fw-th b { font-size: 13px; } .lu-fw-th .lu-muted { font-size: 11.5px; }
.lu-fw-trow { display: flex; align-items: center; gap: 10px; } .lu-fw-terr { font-size: 12px; }
.lu-fw-out { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 10px 12px; }
.lu-fw-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.5; max-height: 260px; overflow: auto; color: var(--ink); }
.lu-fw-stats { font-size: 11.5px; margin-top: 8px; }
</style>
