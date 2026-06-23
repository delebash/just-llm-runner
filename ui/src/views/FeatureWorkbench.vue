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
import UiTextarea from "../common/components/UiTextarea.vue";
import { request } from "../client.js";

const prompts = ref([]);     // all action prompts {key, feature, system, userTemplate, temperature, think, builtIn}
const routing = ref(null);   // {default, quick, accuracy, features:[…], pins:{key→{providerId,model,role}}}
const providers = ref([]);
const presets = ref([]);     // feature presets (per action)
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

// Actions grouped by feature, in catalog order. Each group carries the feature
// label/hint (for the header) and its action prompts.
const groups = computed(() => {
  const out = [];
  const seen = new Set();
  for (const f of routing.value?.features || []) {
    const actions = prompts.value.filter((p) => p.feature === f.key);
    if (actions.length) { out.push({ key: f.key, label: f.label, hint: f.hint, actions }); seen.add(f.key); }
  }
  // Any prompt whose feature isn't in the catalog still gets a home.
  const orphans = {};
  for (const p of prompts.value) if (!seen.has(p.feature)) (orphans[p.feature] ||= []).push(p);
  for (const [k, actions] of Object.entries(orphans)) out.push({ key: k, label: k, hint: "", actions });
  return out;
});

const action = computed(() => prompts.value.find((p) => p.key === selAction.value) || null);
const actionPresets = computed(() => presets.value.filter((p) => p.action === selAction.value));
const activePreset = computed(() => actionPresets.value.find((p) => p.active) || null);
const isMulti = (g) => g.actions.length > 1;

// A readable action name from its key (the feature prefix stripped). Single-action
// features show the feature label itself.
function actionLabel(p) {
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
  if (!val || (!val.providerId && !val.role)) delete pins[key]; // inherit → no pin row
  else pins[key] = { providerId: val.providerId || "", model: val.model || "", role: val.role || "" };
  saveRouting();
}
function setRole(role, val) {
  routing.value[role] = { providerId: val?.providerId || "", model: val?.model || "" };
  saveRouting();
}
function featureOf(key) { return prompts.value.find((p) => p.key === key)?.feature || ""; }
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// What an action currently resolves to, in plain terms (the nav "→ …" + the
// editor note). Cascade (Option A — no feature-level default): the action's own
// pin → its feature's default role (from the catalog) → the global Default LLM.
function activeModel(key) {
  const p = pin(key);
  if (p?.providerId) return providerName(p.providerId) + (p.model ? ` · ${p.model}` : "");
  if (p?.role) return `${cap(p.role)} role`;
  const dr = featMeta.value[featureOf(key)]?.defaultRole;
  if (dr) return `${cap(dr)} role`;
  const d = routing.value?.default?.llmId;
  return d ? `Default · ${providerName(d)}` : "Default LLM (unset)";
}
// Bulk-set every action in a group to one pin (Option A keeps no feature-level
// pin — "set all" just writes each action's own pin).
function setGroupAll(g, val) {
  const pins = routing.value.pins || (routing.value.pins = {});
  for (const a of g.actions) {
    if (!val || (!val.providerId && !val.role)) delete pins[a.key];
    else pins[a.key] = { providerId: val.providerId || "", model: val.model || "", role: val.role || "" };
  }
  saveRouting();
}
// The shared pin when every action in a group has the same one, else null (mixed).
function groupCommonPin(g) {
  const sig = (k) => JSON.stringify(pin(k) || null);
  const first = sig(g.actions[0].key);
  return g.actions.every((a) => sig(a.key) === first) ? (pin(g.actions[0].key) || null) : null;
}

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
    // Presets are optional per app (an app may not mount the endpoint yet).
    try { presets.value = (await request("/v1/ai/feature-presets")).presets || []; }
    catch { presets.value = []; }
    if (!action.value && groups.value.length) selectAction(groups.value[0].actions[0].key);
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
}

async function saveRouting() {
  const r = routing.value;
  routing.value = await request("/v1/ai/routing", {
    method: "PUT",
    body: { default: r.default, quick: r.quick, accuracy: r.accuracy, pins: r.pins || {} },
  });
  if (!routing.value.pins) routing.value.pins = {};
}

// ── presets (per action) ─────────────────────────────────────────────────────
function snapshot(name) {
  const p = pin(selAction.value);
  return {
    action: selAction.value, name,
    providerId: p && !p.role ? p.providerId || "" : "",
    role: p?.role || "",
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
  if (p.role) pins[selAction.value] = { providerId: "", model: "", role: p.role };
  else if (p.providerId) pins[selAction.value] = { providerId: p.providerId, model: p.model || "", role: "" };
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
  if (draft.value) await request(`/v1/ai/prompts/${encodeURIComponent(draft.value.key)}`, {
    method: "PUT",
    body: {
      feature: draft.value.feature, system: draft.value.system, userTemplate: draft.value.userTemplate,
      temperature: Number(draft.value.temperature) || 0, think: !!draft.value.think,
    },
  });
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
async function runTest() {
  if (!draft.value) return;
  testing.value = true; testErr.value = ""; testOut.value = null;
  const t0 = performance.now();
  try {
    const body = { action: draft.value.key, variables: { ...vars }, temperature: Number(draft.value.temperature) };
    const r = await request("/v1/ai/run", { method: "POST", body });
    testOut.value = { content: r.content, model: r.model, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    testErr.value = e.message?.includes("501") ? "No LLM wired for this route — set a model above or connect a provider." : (e.message || "Run failed.");
  } finally {
    testing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="lu-fw">
    <div v-if="error" class="lu-error" style="margin-bottom:10px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else-if="routing">
      <!-- Globals (absorbed from Feature Routing) -->
      <section class="lu-fw-globals">
        <div class="lu-fw-gcard">
          <div class="lu-fw-gh"><b>Defaults</b><span class="lu-muted">what an action falls back to when nothing more specific is set</span></div>
          <div class="lu-fw-grid">
            <label class="lu-fw-gl">Default LLM</label>
            <select class="lu-input" v-model="routing.default.llmId" @change="saveRouting">
              <option value="">— pick a provider —</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.defaultModel ? ` · ${p.defaultModel}` : "" }}</option>
            </select>
            <label class="lu-fw-gl">Default embedding <span class="lu-muted">optional</span></label>
            <select class="lu-input" v-model="routing.default.embeddingId" @change="saveRouting">
              <option value="">— none —</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.embeddingModel ? ` · ${p.embeddingModel}` : "" }}</option>
            </select>
          </div>
        </div>
        <div class="lu-fw-gcard">
          <div class="lu-fw-gh"><b>Model roles</b><span class="lu-muted">two go-to models any action can inherit</span></div>
          <div class="lu-fw-roles">
            <div v-for="role in ['quick', 'accuracy']" :key="role" class="lu-fw-role">
              <span class="lu-rchip" :class="`lu-rchip--${role}`">{{ role === 'quick' ? 'QUICK' : 'ACCURACY' }}</span>
              <LuModelPicker :model-value="routing[role]" :providers="providers" :show-roles="false"
                inherit-label="— use Default LLM —" @update:model-value="setRole(role, $event)" />
            </div>
          </div>
        </div>
      </section>

      <div class="lu-fw-body">
        <!-- Nav: actions grouped by feature -->
        <aside class="lu-fw-list">
          <template v-for="g in groups" :key="g.key">
            <!-- single-action feature → one card (label + its feature blurb) -->
            <button v-if="!isMulti(g)" type="button" class="lu-fw-card"
              :class="{ 'is-active': g.actions[0].key === selAction }" @click="selectAction(g.actions[0].key)">
              <div class="lu-fw-card-label">{{ g.label }}<span v-if="hasProd(g.actions[0].key)" class="lu-fw-dot" title="has a production preset" /></div>
              <div v-if="actionDesc(g.actions[0])" class="lu-fw-card-desc">{{ actionDesc(g.actions[0]) }}</div>
              <div class="lu-fw-card-model" title="currently active model">→ {{ activeModel(g.actions[0].key) }}</div>
            </button>
            <!-- multi-action feature → heading + a "Set all" applicator (writes
                 every action's model at once), hint, then a card per action. -->
            <template v-else>
              <div class="lu-fw-ghead">
                <span class="lu-fw-gname">{{ g.label }}</span>
                <span class="lu-fw-gspacer" />
                <span class="lu-fw-setall-lbl">Set all</span>
                <LuModelPicker :model-value="groupCommonPin(g)" :providers="providers" inherit-label="Inherit default" :compact="true"
                  :title="`Set the provider + model for all ${g.actions.length} ${g.label} actions at once`"
                  @update:model-value="setGroupAll(g, $event)" />
              </div>
              <p v-if="g.hint" class="lu-fw-ghint">{{ g.hint }}</p>
              <template v-for="sg in subGroups(g.actions)" :key="sg.label || g.key">
                <div v-if="sg.label" class="lu-fw-sublabel">{{ sg.label }}</div>
                <button v-for="a in sg.items" :key="a.key" type="button" class="lu-fw-card lu-fw-card--sub"
                  :class="{ 'is-active': a.key === selAction }" @click="selectAction(a.key)">
                  <div class="lu-fw-card-label">{{ actionLabel(a) }}<span v-if="hasProd(a.key)" class="lu-fw-dot" title="has a production preset" /></div>
                  <div v-if="actionDesc(a)" class="lu-fw-card-desc">{{ actionDesc(a) }}</div>
                  <div class="lu-fw-card-model" title="currently active model">→ {{ activeModel(a.key) }}</div>
                </button>
              </template>
            </template>
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

          <!-- Provider + model for this action (shared LuModelPicker) -->
          <div class="lu-field">
            <label>Provider &amp; model <span class="lu-muted">— inherits the default unless you pin a provider + model here</span></label>
            <div class="lu-fw-route">
              <LuModelPicker :model-value="pin(selAction)" :providers="providers" :labels="true"
                inherit-label="Inherit default" @update:model-value="setPin(selAction, $event)" />
              <span class="lu-muted lu-fw-resolved">→ {{ activeModel(selAction) }}</span>
            </div>
          </div>

          <div class="lu-field"><label>System prompt</label>
            <UiTextarea v-model="draft.system" auto-resize :rows="7" @input="buildVars" /></div>
          <div class="lu-field"><label>Instruction <span class="lu-muted">— user template · {{ varHint }}</span></label>
            <UiTextarea v-model="draft.userTemplate" auto-resize :rows="4" @input="buildVars" /></div>

          <div class="lu-fw-params">
            <div class="lu-field lu-fw-temp"><label>Temperature</label><UiInput v-model="draft.temperature" type="number" /></div>
            <label class="lu-fw-think"><UiCheckbox v-model="draft.think" /><span class="lu-muted">Reasoning (think)</span></label>
            <span class="lu-fw-spacer" />
            <UiButton v-if="draft.builtIn" intent="ghost" size="small" @click="resetPrompt">Reset prompt to default</UiButton>
          </div>

          <div class="lu-fw-test">
            <div class="lu-fw-th"><b>Test on real input</b><span class="lu-muted">runs the live saved config for this action</span></div>
            <div v-for="(_, k) in vars" :key="k" class="lu-field">
              <label>{{ k }}</label><UiTextarea v-model="vars[k]" auto-resize :rows="2" />
            </div>
            <div class="lu-fw-trow">
              <UiButton intent="primary" size="small" :loading="testing" @click="runTest">▶ Run</UiButton>
              <span v-if="testErr" class="lu-error lu-fw-terr">{{ testErr }}</span>
            </div>
            <div v-if="testOut" class="lu-fw-out">
              <pre class="lu-fw-pre">{{ testOut.content }}</pre>
              <div class="lu-muted lu-fw-stats">model <b>{{ testOut.model }}</b> · {{ testOut.ms }} ms</div>
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

/* Globals */
.lu-fw-globals { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
.lu-fw-gcard { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); }
.lu-fw-gh { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.lu-fw-gh b { font-size: 13px; color: var(--ink); } .lu-fw-gh .lu-muted { font-size: 11px; }
.lu-fw-grid { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 9px 10px; align-items: center; }
.lu-fw-gl { color: var(--ink-2); font-size: 12px; }
.lu-fw-roles { display: flex; flex-direction: column; gap: 8px; }
.lu-fw-role { display: grid; grid-template-columns: auto 1fr 1fr; gap: 8px; align-items: center; }
.lu-rchip { font-size: 9px; font-weight: 800; letter-spacing: .04em; border-radius: 999px; padding: 3px 8px; text-align: center; }
.lu-rchip--quick { background: var(--accent-soft); color: var(--accent-ink, var(--accent)); }
.lu-rchip--accuracy { background: var(--gold-soft, #f5edda); color: var(--gold, #b08a3e); }
select.lu-input { cursor: pointer; appearance: auto; }

/* Body = nav + editor. The nav is a self-contained scroller (capped height,
   sticky) so a long action list never stretches the page. */
.lu-fw-body { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 16px; align-items: start; }
.lu-fw-list { border: 1px solid var(--border); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; max-height: calc(100vh - 240px); overflow-y: auto; position: sticky; top: 4px; }
/* Writer-Lab-style action card: label + blurb, accent on hover/active. */
.lu-fw-card { text-align: left; width: 100%; font: inherit; cursor: pointer; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); transition: border-color .12s, background .12s; }
.lu-fw-card:hover { border-color: var(--accent); background: var(--accent-soft); }
.lu-fw-card.is-active { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.lu-fw-card--sub { margin-left: 10px; }
.lu-fw-card-label { font-size: 12.5px; font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 6px; }
.lu-fw-card-desc { font-size: 11px; color: var(--muted); line-height: 1.4; margin-top: 3px; }
.lu-fw-card-model { font-size: 10.5px; font-weight: 600; color: var(--accent-ink, var(--accent)); margin-top: 4px; }
.lu-fw-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
/* multi-action section: dark heading + feature-default model, hint, sub-labels */
.lu-fw-ghead { display: flex; align-items: center; gap: 8px; padding: 8px 4px 2px; margin-top: 6px; border-top: 1px solid var(--border); }
.lu-fw-ghead:first-child { border-top: 0; margin-top: 0; }
.lu-fw-gname { font-size: 13px; font-weight: 700; color: var(--ink); }
.lu-fw-gspacer { flex: 1; }
.lu-fw-setall-lbl { font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.lu-fw-ghint { margin: 0 4px 4px; font-size: 10.5px; line-height: 1.4; color: var(--muted); }
.lu-fw-sublabel { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 7px 0 1px 10px; }

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
.lu-fw-route { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.lu-fw-resolved { font-size: 11.5px; }
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
