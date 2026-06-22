<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Feature Workbench — the shared per-feature AI config + test surface (the
// "source of truth" the live pipeline runs). Generalizes JustVoice's SpeakerLab
// onto EVERY feature in the app's common catalog: for each feature you set its
// model/role, edit its system + user prompts and params, and TEST it on real
// input — then it's what production runs. Driven entirely off shared endpoints
// (/v1/ai/prompts · /v1/ai/routing · /v1/ai/run · /v1/llm-providers), so both
// JustWrite and JustVoice mount the SAME component over their own catalogs.
//
// Absorbs PromptLab (prompts) + the per-feature half of FeaturesRouting
// (model/role) and adds the Test panel. Roles stay as optional inheritance;
// a feature can pin its own model (per-feature override wins).
import { computed, onMounted, reactive, ref } from "vue";

import LuButton from "../components/LuButton.vue";
import LuCheckbox from "../components/LuCheckbox.vue";
import LuInput from "../components/LuInput.vue";
import LuTextarea from "../components/LuTextarea.vue";
import { request } from "../client.js";

const prompts = ref([]);       // [{key, feature, system, userTemplate, temperature, think, builtIn}]
const routing = ref(null);     // {default, quick, accuracy, features:[{key,...,providerId,model,role}]}
const providers = ref([]);     // [{id, name, defaultModel}]
const loading = ref(true);
const error = ref("");
const selectedKey = ref("");
const draft = ref(null);       // editable copy of the selected prompt
const route = reactive({ value: "" }); // "", "role:quick", "role:accuracy", or a providerId
const saving = ref(false);
const message = ref("");
// Kept as a constant so the literal braces never appear in the template (Vue's
// parser treats {{ }} as an interpolation).
const varHint = "{{variable}} placeholders";

const byId = computed(() => Object.fromEntries(providers.value.map((p) => [p.id, p])));
const providerName = (id) => byId.value[id]?.name || id || "—";
const selected = computed(() => prompts.value.find((p) => p.key === selectedKey.value) || null);

// the routing feature row for the selected prompt's `feature`
const featRow = computed(() =>
  draft.value ? (routing.value?.features || []).find((f) => f.key === draft.value.feature) : null,
);
const resolvedModel = computed(() => {
  if (route.value === "role:quick") return `Quick · ${providerName(routing.value?.quick?.providerId)}`;
  if (route.value === "role:accuracy") return `Accuracy · ${providerName(routing.value?.accuracy?.providerId)}`;
  if (route.value) return providerName(route.value);
  return `Default · ${providerName(routing.value?.default?.llmId)}`;
});

const dirtyPrompt = computed(() => {
  const a = draft.value, b = selected.value;
  if (!a || !b) return false;
  return a.system !== b.system || a.userTemplate !== b.userTemplate
    || Number(a.temperature) !== Number(b.temperature) || a.think !== b.think;
});
const dirtyRoute = computed(() => {
  const f = featRow.value;
  const cur = f ? (f.role ? `role:${f.role}` : f.providerId || "") : "";
  return route.value !== cur;
});
const dirty = computed(() => dirtyPrompt.value || dirtyRoute.value);

async function load() {
  loading.value = true; error.value = "";
  try {
    const [p, r, pl] = await Promise.all([
      request("/v1/ai/prompts"),
      request("/v1/ai/routing"),
      request("/v1/llm-providers"),
    ]);
    prompts.value = (p.prompts || []).slice().sort((a, b) => a.key.localeCompare(b.key));
    routing.value = r;
    providers.value = pl.providers || [];
    if (prompts.value.length && !prompts.value.some((x) => x.key === selectedKey.value)) select(prompts.value[0].key);
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

function select(key) {
  selectedKey.value = key;
  const p = prompts.value.find((x) => x.key === key);
  draft.value = p ? { ...p } : null;
  message.value = ""; testOut.value = null; testErr.value = "";
  const f = (routing.value?.features || []).find((x) => x.key === p?.feature);
  route.value = f ? (f.role ? `role:${f.role}` : f.providerId || "") : "";
  buildVars();
}

// ── Test panel: detect {{vars}} in the template, one input per var ──────────
const vars = reactive({});
const testOut = ref(null);   // { content, model, ms }
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
    // Override model/temp from the current (possibly unsaved) route + params so
    // the test reflects what you're tuning. (Prompt-text override is a small
    // pending server add — until then Test runs the SAVED prompt; save first.)
    const body = { action: draft.value.key, variables: { ...vars }, temperature: Number(draft.value.temperature) };
    if (route.value.startsWith("role:")) { /* role resolves server-side */ }
    else if (route.value) body.providerId = route.value;
    const r = await request("/v1/ai/run", { method: "POST", body });
    testOut.value = { content: r.content, model: r.model, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    testErr.value = e.message?.includes("501") ? "No LLM wired for this route — set a model above or connect a provider." : (e.message || "Run failed.");
  } finally {
    testing.value = false;
  }
}

// ── Save: prompt (PUT /v1/ai/prompts) + route (PUT /v1/ai/routing pin) ──────
async function save() {
  if (!draft.value) return;
  saving.value = true; error.value = ""; message.value = "";
  try {
    if (dirtyPrompt.value) {
      const updated = await request(`/v1/ai/prompts/${encodeURIComponent(draft.value.key)}`, {
        method: "PUT",
        body: { feature: draft.value.feature, system: draft.value.system, userTemplate: draft.value.userTemplate,
          temperature: Number(draft.value.temperature), think: !!draft.value.think },
      });
      const i = prompts.value.findIndex((p) => p.key === updated.key);
      if (i >= 0) prompts.value[i] = updated;
    }
    if (dirtyRoute.value) await saveRoute();
    message.value = "Saved — this is what the feature runs now.";
  } catch (e) {
    error.value = `Save failed: ${e.message}`;
  } finally {
    saving.value = false;
  }
}
async function saveRoute() {
  const r = routing.value;
  const pins = {};
  for (const f of r.features || []) if (f.providerId || f.role) pins[f.key] = { providerId: f.providerId, model: f.model, role: f.role };
  const feat = draft.value.feature;
  if (!route.value) delete pins[feat];
  else if (route.value.startsWith("role:")) pins[feat] = { providerId: "", model: "", role: route.value.slice(5) };
  else pins[feat] = { providerId: route.value, model: "", role: "" };
  routing.value = await request("/v1/ai/routing", {
    method: "PUT",
    body: { default: r.default, quick: r.quick, accuracy: r.accuracy, pins },
  });
}

async function resetPrompt() {
  if (!draft.value?.builtIn) return;
  const updated = await request(`/v1/ai/prompts/${encodeURIComponent(draft.value.key)}/reset`, { method: "POST" });
  const i = prompts.value.findIndex((p) => p.key === updated.key);
  if (i >= 0) prompts.value[i] = updated;
  draft.value = { ...updated };
  buildVars();
  message.value = "Reset to seeded default.";
}

onMounted(load);
</script>

<template>
  <div class="lu-fw">
    <div v-if="error" class="lu-error" style="margin-bottom:10px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading features…</div>

    <div v-else class="lu-fw-body">
      <!-- feature list (the app's common catalog) -->
      <aside class="lu-fw-list">
        <button v-for="p in prompts" :key="p.key" type="button"
          class="lu-fw-row" :class="{ 'is-active': p.key === selectedKey }" @click="select(p.key)">
          <span class="lu-fw-key">{{ p.key }}</span>
          <span class="lu-fw-feat lu-muted">{{ p.feature }}</span>
        </button>
      </aside>

      <!-- per-feature workbench -->
      <section v-if="draft" class="lu-fw-edit">
        <div class="lu-fw-h"><b>{{ draft.key }}</b><span class="lu-muted">feature: {{ draft.feature }}</span>
          <span class="lu-fw-spacer" /><span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span></div>

        <!-- model / role -->
        <div class="lu-field">
          <label>Model / role</label>
          <div class="lu-fw-route">
            <select class="lu-input" v-model="route.value">
              <option value="">Inherit default</option>
              <option value="role:quick">Inherit · Quick</option>
              <option value="role:accuracy">Inherit · Accuracy</option>
              <optgroup label="Pin a provider">
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
              </optgroup>
            </select>
            <span class="lu-muted lu-fw-resolved">→ {{ resolvedModel }}</span>
          </div>
        </div>

        <!-- prompts -->
        <div class="lu-field"><label>System prompt</label>
          <LuTextarea v-model="draft.system" auto-resize :rows="8" @input="buildVars" /></div>
        <div class="lu-field"><label>User template <span class="lu-muted">— {{ varHint }}</span></label>
          <LuTextarea v-model="draft.userTemplate" auto-resize :rows="4" @input="buildVars" /></div>

        <!-- params -->
        <div class="lu-fw-params">
          <div class="lu-field lu-fw-temp"><label>Temperature</label><LuInput v-model="draft.temperature" type="number" /></div>
          <label class="lu-fw-think"><LuCheckbox v-model="draft.think" /><span class="lu-muted">Reasoning (think)</span></label>
        </div>

        <!-- test -->
        <div class="lu-fw-test">
          <div class="lu-fw-th"><b>Test on real input</b><span class="lu-muted">runs this action through the live pipeline</span></div>
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

        <div class="lu-fw-actions">
          <LuButton v-if="draft.builtIn" intent="ghost" size="small" :disabled="saving" @click="resetPrompt">Reset to default</LuButton>
          <span class="lu-fw-spacer" />
          <LuButton intent="primary" :disabled="saving || !dirty" @click="save">{{ saving ? "Saving…" : "Save — use as production" }}</LuButton>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.lu-fw { display:flex; flex-direction:column; min-height:0; }
.lu-fw-body { display:grid; grid-template-columns:240px minmax(0,1fr); gap:16px; }
.lu-fw-list { border:1px solid var(--border); border-radius:10px; padding:6px; display:flex; flex-direction:column; gap:2px; max-height:640px; overflow:auto; }
.lu-fw-row { display:flex; flex-direction:column; gap:1px; text-align:left; padding:7px 10px; border:0; background:transparent; border-radius:7px; cursor:pointer; width:100%; font:inherit; }
.lu-fw-row:hover { background:var(--surface-3); }
.lu-fw-row.is-active { background:var(--accent-soft); box-shadow:inset 0 0 0 1.5px var(--accent); }
.lu-fw-key { font-weight:600; font-size:12.5px; color:var(--ink); }
.lu-fw-feat { font-size:11px; }
.lu-fw-edit { display:flex; flex-direction:column; gap:12px; min-width:0; }
.lu-fw-h { display:flex; align-items:baseline; gap:10px; }
.lu-fw-h b { font-size:15px; color:var(--ink); }
.lu-fw-h .lu-muted { font-size:11.5px; }
.lu-fw-spacer { flex:1; } .lu-fw-msg { font-size:11.5px; }
.lu-field { display:flex; flex-direction:column; gap:5px; }
.lu-field > label { font-size:12px; color:var(--muted); }
.lu-fw-route { display:flex; gap:10px; align-items:center; }
.lu-fw-route .lu-input { max-width:280px; cursor:pointer; appearance:auto; }
.lu-fw-resolved { font-size:11.5px; }
.lu-fw-params { display:flex; gap:24px; align-items:flex-end; }
.lu-fw-temp { max-width:110px; }
.lu-fw-think { display:flex; align-items:center; gap:8px; }
.lu-fw-test { border:1px solid var(--border); border-radius:10px; padding:13px; background:var(--surface-2); display:flex; flex-direction:column; gap:10px; }
.lu-fw-th { display:flex; align-items:baseline; gap:10px; } .lu-fw-th b { font-size:13px; } .lu-fw-th .lu-muted { font-size:11.5px; }
.lu-fw-trow { display:flex; align-items:center; gap:10px; }
.lu-fw-terr { font-size:12px; }
.lu-fw-out { border:1px solid var(--border); border-radius:8px; background:var(--surface); padding:10px 12px; }
.lu-fw-pre { margin:0; white-space:pre-wrap; word-break:break-word; font-family:var(--font-mono,monospace); font-size:11.5px; line-height:1.5; max-height:260px; overflow:auto; color:var(--ink); }
.lu-fw-stats { font-size:11.5px; margin-top:8px; }
.lu-fw-actions { display:flex; align-items:center; gap:10px; padding-top:4px; }
</style>
