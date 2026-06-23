<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Feature Workbench — the single AI config + test surface (AI ▸ Features). The
// unit is the ACTION (37 of them); "feature" (writerAI, critique, …) is just the
// visual GROUP its actions live under. Per action: pick its model (or inherit the
// feature default / a role / the global default), edit its prompt + params, TEST
// on real input, save NAMED presets, and mark one "use as production".
//
// It also absorbs the old Feature Routing: the GLOBALS (default LLM + embedding,
// Quick/Accuracy roles) sit at the top; each feature GROUP header carries that
// feature's DEFAULT model, which its actions inherit unless they override.
//
// Model assignment is stored as routing pins keyed by feature OR action key
// (/v1/ai/routing); prompts in /v1/ai/prompts; presets in /v1/ai/feature-presets.
// Shared across both apps — only the feature catalog differs.
import { computed, onMounted, reactive, ref } from "vue";

import LuButton from "../components/LuButton.vue";
import LuCheckbox from "../components/LuCheckbox.vue";
import LuInput from "../components/LuInput.vue";
import LuTextarea from "../components/LuTextarea.vue";
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
const saving = ref(false);
const collapsed = reactive({}); // feature key → collapsed in the nav

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
const selFeatureKey = computed(() => action.value?.feature || "");
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

// ── model picker (routing pins keyed by feature OR action) ───────────────────
// Like Feature Routing: a "route" select (inherit / role / a provider) + a model
// select for an explicit provider. (A real per-provider model LIST needs a new
// endpoint — for now: the provider's saved default model.)
function modelOptions(providerId) {
  const p = byId.value[providerId];
  const out = [{ value: "", label: "(provider default)" }];
  if (p?.defaultModel) out.push({ value: p.defaultModel, label: p.defaultModel });
  return out;
}
function pin(key) { return routing.value?.pins?.[key] || null; }
function pinRoute(key) {
  const p = pin(key);
  if (p?.role) return `role:${p.role}`;
  if (p?.providerId) return p.providerId;
  return "";
}
function setPinRoute(key, val) {
  const pins = routing.value.pins || (routing.value.pins = {});
  if (!val) delete pins[key];
  else if (val.startsWith("role:")) pins[key] = { providerId: "", model: "", role: val.slice(5) };
  else pins[key] = { providerId: val, model: pins[key]?.providerId === val ? pins[key].model : "", role: "" };
  saveRouting();
}
function setPinModel(key, model) {
  const p = pin(key);
  if (!p) return;
  p.model = model;
  saveRouting();
}
// What a key actually resolves to, for the muted "→ …" note.
function resolvedText(key, isAction) {
  const p = pin(key);
  if (p?.role) return `role · ${p.role}`;
  if (p?.providerId) return providerName(p.providerId) + (p.model ? ` · ${p.model}` : "");
  if (isAction) {
    const fk = selFeatureKey.value;
    const fp = pin(fk);
    if (fp?.role) return `feature default · role ${fp.role}`;
    if (fp?.providerId) return `feature default · ${providerName(fp.providerId)}${fp.model ? ` · ${fp.model}` : ""}`;
  }
  return `global default · ${providerName(routing.value?.default?.llmId)}`;
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
async function saveAs() {
  const name = newName.value.trim();
  if (!name) return;
  presets.value = (await request("/v1/ai/feature-presets", { method: "POST", body: snapshot(name) })).presets || [];
  selPreset.value = actionPresets.value.find((p) => p.name === name)?.id || "";
  naming.value = false; newName.value = ""; message.value = `Preset "${name}" saved.`;
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
      const name = `${resolvedText(selAction.value, true)} · ${new Date().toLocaleDateString()}`;
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
              <select class="lu-input" v-model="routing[role].providerId" @change="routing[role].model = ''; saveRouting()">
                <option value="">— inherit default —</option>
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <select class="lu-input" v-model="routing[role].model" :disabled="!routing[role].providerId" @change="saveRouting">
                <option v-for="o in modelOptions(routing[role].providerId)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
          </div>
        </div>
      </section>

      <div class="lu-fw-body">
        <!-- Nav: actions grouped by feature -->
        <aside class="lu-fw-list">
          <template v-for="g in groups" :key="g.key">
            <!-- single-action feature: the group IS the action -->
            <button v-if="!isMulti(g)" type="button" class="lu-fw-row"
              :class="{ 'is-active': g.actions[0].key === selAction }" @click="selectAction(g.actions[0].key)">
              <span class="lu-fw-name">{{ g.label }}</span>
              <span v-if="g.hint" class="lu-fw-hint lu-muted">{{ g.hint }}</span>
            </button>
            <!-- multi-action feature: header (collapse + feature default) then actions -->
            <template v-else>
              <div class="lu-fw-ghead">
                <button type="button" class="lu-fw-gtog" @click="collapsed[g.key] = !collapsed[g.key]">
                  <span class="lu-fw-caret">{{ collapsed[g.key] ? '▸' : '▾' }}</span>
                  <span class="lu-fw-gname">{{ g.label }}</span>
                  <span class="lu-fw-gcount">{{ g.actions.length }}</span>
                </button>
                <div class="lu-fw-gdefault" :title="`Default model for all ${g.actions.length} ${g.label} actions`">
                  <select class="lu-input lu-fw-mini" :value="pinRoute(g.key)" @change="setPinRoute(g.key, $event.target.value)">
                    <option value="">Default</option>
                    <option value="role:quick">Quick</option>
                    <option value="role:accuracy">Accuracy</option>
                    <optgroup label="Pin a provider">
                      <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
                    </optgroup>
                  </select>
                  <select v-if="pin(g.key)?.providerId" class="lu-input lu-fw-mini" :value="pin(g.key).model" @change="setPinModel(g.key, $event.target.value)">
                    <option v-for="o in modelOptions(pin(g.key).providerId)" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                </div>
              </div>
              <template v-if="!collapsed[g.key]">
                <button v-for="a in g.actions" :key="a.key" type="button" class="lu-fw-row lu-fw-sub"
                  :class="{ 'is-active': a.key === selAction }" @click="selectAction(a.key)">
                  <span class="lu-fw-name">{{ actionLabel(a) }}</span>
                  <span v-if="presets.find((x) => x.action === a.key && x.active)" class="lu-fw-dot" title="has a production preset" />
                </button>
              </template>
            </template>
          </template>
        </aside>

        <!-- Editor for the selected action -->
        <section v-if="action && draft" class="lu-fw-edit">
          <div class="lu-fw-h">
            <span class="lu-muted lu-fw-crumb">{{ featMeta[selFeatureKey]?.label || selFeatureKey }} ›</span>
            <b>{{ actionLabel(action) }}</b>
            <span class="lu-muted lu-fw-mono">{{ action.key }}</span>
            <span class="lu-fw-spacer" /><span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
          </div>

          <!-- Presets bar (SpeakerLab parity) -->
          <div class="lu-fw-presets">
            <span class="lu-fw-eyebrow">Presets</span>
            <select class="lu-input lu-fw-presel" :value="selPreset" @change="applyPreset($event.target.value)">
              <option value="">— current —</option>
              <option v-for="p in actionPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <LuButton v-if="selPreset" intent="ghost" size="small" title="Delete this preset" @click="delPreset">🗑</LuButton>
            <template v-if="naming">
              <LuInput v-model="newName" placeholder="preset name…" class="lu-fw-name-in" @keyup.enter="saveAs" />
              <LuButton intent="secondary" size="small" @click="saveAs">Save</LuButton>
            </template>
            <LuButton v-else intent="secondary" size="small" title="Save this config as a named preset" @click="naming = true">＋ Save as</LuButton>
            <LuButton intent="secondary" size="small" :loading="saving" title="Apply this config to the live pipeline" @click="useAsProduction">✓ Use as production</LuButton>
            <span v-if="activePreset" class="lu-fw-prod" :title="`The live pipeline runs '${activePreset.name}'.`">✓ PRODUCTION · {{ activePreset.name }}</span>
          </div>

          <!-- Model for this action -->
          <div class="lu-field">
            <label>Model</label>
            <div class="lu-fw-route">
              <select class="lu-input" :value="pinRoute(selAction)" @change="setPinRoute(selAction, $event.target.value)">
                <option value="">Inherit feature default</option>
                <option value="role:quick">Inherit · Quick</option>
                <option value="role:accuracy">Inherit · Accuracy</option>
                <optgroup label="Pin a provider">
                  <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
                </optgroup>
              </select>
              <select v-if="pin(selAction)?.providerId" class="lu-input" :value="pin(selAction).model" @change="setPinModel(selAction, $event.target.value)">
                <option v-for="o in modelOptions(pin(selAction).providerId)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <span class="lu-muted lu-fw-resolved">→ {{ resolvedText(selAction, true) }}</span>
            </div>
          </div>

          <div class="lu-field"><label>System prompt</label>
            <LuTextarea v-model="draft.system" auto-resize :rows="7" @input="buildVars" /></div>
          <div class="lu-field"><label>Instruction <span class="lu-muted">— user template · {{ varHint }}</span></label>
            <LuTextarea v-model="draft.userTemplate" auto-resize :rows="4" @input="buildVars" /></div>

          <div class="lu-fw-params">
            <div class="lu-field lu-fw-temp"><label>Temperature</label><LuInput v-model="draft.temperature" type="number" /></div>
            <label class="lu-fw-think"><LuCheckbox v-model="draft.think" /><span class="lu-muted">Reasoning (think)</span></label>
            <span class="lu-fw-spacer" />
            <LuButton v-if="draft.builtIn" intent="ghost" size="small" @click="resetPrompt">Reset prompt to default</LuButton>
          </div>

          <div class="lu-fw-test">
            <div class="lu-fw-th"><b>Test on real input</b><span class="lu-muted">runs the live saved config for this action</span></div>
            <div v-for="(_, k) in vars" :key="k" class="lu-field">
              <label>{{ k }}</label><LuTextarea v-model="vars[k]" auto-resize :rows="2" />
            </div>
            <div class="lu-fw-trow">
              <LuButton intent="primary" size="small" :loading="testing" @click="runTest">▶ Run</LuButton>
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

/* Body = nav + editor */
.lu-fw-body { display: grid; grid-template-columns: 268px minmax(0, 1fr); gap: 16px; align-items: start; }
.lu-fw-list { border: 1px solid var(--border); border-radius: 10px; padding: 6px; display: flex; flex-direction: column; gap: 1px; }
.lu-fw-row { display: flex; flex-direction: column; gap: 1px; text-align: left; padding: 7px 9px; border: 0; background: transparent; border-radius: 7px; cursor: pointer; width: 100%; font: inherit; }
.lu-fw-row:hover { background: var(--surface-3); }
.lu-fw-row.is-active { background: var(--accent-soft); box-shadow: inset 0 0 0 1.5px var(--accent); }
.lu-fw-sub { padding-left: 22px; flex-direction: row; align-items: center; gap: 7px; }
.lu-fw-name { font-weight: 600; font-size: 12.5px; color: var(--ink); }
.lu-fw-sub .lu-fw-name { font-weight: 500; font-size: 12px; }
.lu-fw-hint { font-size: 10.5px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lu-fw-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-left: auto; flex: none; }
.lu-fw-ghead { display: flex; align-items: center; gap: 6px; padding: 6px 6px 4px; margin-top: 4px; }
.lu-fw-gtog { display: flex; align-items: center; gap: 6px; background: transparent; border: 0; cursor: pointer; font: inherit; padding: 0; color: var(--ink); flex: 1; min-width: 0; }
.lu-fw-caret { font-size: 9px; color: var(--muted); width: 10px; }
.lu-fw-gname { font-size: 11px; font-weight: 800; letter-spacing: .03em; text-transform: uppercase; color: var(--muted); }
.lu-fw-gcount { font-size: 10px; color: var(--muted); background: var(--surface-3); border-radius: 999px; padding: 0 6px; }
.lu-fw-gdefault { display: flex; gap: 4px; }
.lu-fw-mini { font-size: 11px; padding: 3px 6px; max-width: 104px; }

/* Editor */
.lu-fw-edit { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.lu-fw-h { display: flex; align-items: baseline; gap: 8px; }
.lu-fw-h b { font-size: 15px; color: var(--ink); }
.lu-fw-crumb { font-size: 12px; } .lu-fw-mono { font-family: var(--font-mono, monospace); font-size: 11px; }
.lu-fw-spacer { flex: 1; } .lu-fw-msg { font-size: 11.5px; }
.lu-fw-presets { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); }
.lu-fw-eyebrow { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.lu-fw-presel { max-width: 200px; cursor: pointer; appearance: auto; }
.lu-fw-name-in { max-width: 170px; }
.lu-fw-prod { margin-left: auto; font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 3px 10px; background: var(--accent); color: var(--on-accent, #fff); }
.lu-field { display: flex; flex-direction: column; gap: 5px; }
.lu-field > label { font-size: 12px; color: var(--muted); }
.lu-fw-route { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.lu-fw-route .lu-input { max-width: 240px; cursor: pointer; appearance: auto; }
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
