<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The Features tab of the shared AI area (from the shared-ai-models mock): the
// three routing cards — global Defaults, the Quick/Accuracy model roles, and the
// per-feature routing table (each feature inherits a role or pins its own
// provider ▸ model). Edits the shared /v1/ai/routing endpoint (host-store
// boundary); the feature catalog + current pins come back merged from the
// server. "✎ prompt" links to the prompt editor (reuses PromptLab — prompts +
// temperature + reasoning live there already).
import { computed, onMounted, ref } from "vue";

import { request } from "../client.js";
import LuButton from "../components/LuButton.vue";

const routing = ref(null); // { default, quick, accuracy, features:[{key,label,hint,defaultRole,providerId,model,role}] }
const providers = ref([]);
const loading = ref(true);
const error = ref("");
const saving = ref(false);
const saved = ref(false);

const byId = computed(() => Object.fromEntries(providers.value.map((p) => [p.id, p])));
const providerName = (id) => byId.value[id]?.name || id || "—";

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [r, pl] = await Promise.all([request("/v1/ai/routing"), request("/v1/llm-providers")]);
    routing.value = r;
    providers.value = pl.providers || [];
  } catch (e) {
    error.value = `Couldn't load routing: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

// Model options for an explicit-provider pick: "(provider default)" + the
// provider's saved default model. Richer per-provider fetch is a later tweak.
function modelOptions(providerId) {
  const p = byId.value[providerId];
  const out = [{ value: "", label: "(provider default)" }];
  if (p?.defaultModel) out.push({ value: p.defaultModel, label: p.defaultModel });
  return out;
}

// A feature row's "route" select encodes inherit-default ("") / a role
// ("role:quick"|"role:accuracy") / an explicit provider id.
function routeValue(f) {
  if (f.role) return `role:${f.role}`;
  if (f.providerId) return f.providerId;
  return "";
}
function setRoute(f, val) {
  saved.value = false;
  if (!val) { f.providerId = ""; f.role = ""; f.model = ""; return; }
  if (val.startsWith("role:")) { f.role = val.slice(5); f.providerId = ""; f.model = ""; return; }
  f.providerId = val; f.role = ""; f.model = "";
}
function resolvedRole(role) {
  const t = routing.value?.[role];
  if (!t?.providerId) return "not set";
  return `${providerName(t.providerId)}${t.model ? ` · ${t.model}` : ""}`;
}

function touch() { saved.value = false; }

async function save() {
  saving.value = true;
  error.value = "";
  try {
    const r = routing.value;
    const pins = {};
    for (const f of r.features) {
      if (f.providerId || f.role) pins[f.key] = { providerId: f.providerId, model: f.model, role: f.role };
    }
    const body = { default: r.default, quick: r.quick, accuracy: r.accuracy, pins };
    routing.value = await request("/v1/ai/routing", { method: "PUT", body });
    saved.value = true;
  } catch (e) {
    error.value = `Save failed: ${e.message}`;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="lu-feat">
    <div v-if="error" class="lu-error" style="margin-bottom:12px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading routing…</div>

    <template v-else-if="routing">
      <!-- Defaults -->
      <section class="lu-fcard">
        <div class="lu-fcard-h"><b>Routing &amp; defaults</b><span class="lu-muted">what an unpinned feature falls back to</span></div>
        <div class="lu-fgrid2">
          <label class="lu-fl">Default LLM</label>
          <select class="lu-input" v-model="routing.default.llmId" @change="touch">
            <option value="">— pick a provider —</option>
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.defaultModel ? ` · ${p.defaultModel}` : "" }}</option>
          </select>

          <label class="lu-fl">Default embedding <span class="lu-muted">optional</span></label>
          <select class="lu-input" v-model="routing.default.embeddingId" @change="touch">
            <option value="">— none —</option>
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.embeddingModel ? ` · ${p.embeddingModel}` : "" }}</option>
          </select>
        </div>
      </section>

      <!-- Roles -->
      <section class="lu-fcard">
        <div class="lu-fcard-h"><b>Model roles</b><span class="lu-muted">two go-to models features can inherit</span></div>
        <div class="lu-roles">
          <div v-for="role in ['quick', 'accuracy']" :key="role" class="lu-role">
            <div class="lu-role-n"><span class="lu-rchip" :class="`lu-rchip--${role}`">{{ role === 'quick' ? 'QUICK' : 'ACCURACY' }}</span>
              {{ role === 'quick' ? 'Fast · interactive' : 'Careful · accuracy-critical' }}</div>
            <div class="lu-role-row">
              <select class="lu-input" v-model="routing[role].providerId" @change="routing[role].model = ''; touch()">
                <option value="">— inherit default —</option>
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <select class="lu-input" v-model="routing[role].model" :disabled="!routing[role].providerId" @change="touch">
                <option v-for="o in modelOptions(routing[role].providerId)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
          </div>
        </div>
      </section>

      <!-- Feature routing table -->
      <section class="lu-fcard">
        <div class="lu-fcard-h"><b>Feature routing</b><span class="lu-muted">{{ routing.features.length }} features · each inherits a role or pins its own model</span></div>
        <div class="lu-ftable-wrap">
          <table class="lu-ftable">
            <thead><tr><th>Feature</th><th>Route</th><th>Model</th><th /></tr></thead>
            <tbody>
              <tr v-for="f in routing.features" :key="f.key">
                <td class="lu-ft-feat"><div class="lu-ft-name">{{ f.label }}</div><div class="lu-ft-hint">{{ f.hint }}</div></td>
                <td>
                  <select class="lu-input lu-ft-sel" :value="routeValue(f)" @change="setRoute(f, $event.target.value)">
                    <option value="">Inherit default · {{ providerName(routing.default.llmId) }}</option>
                    <option value="role:quick">Inherit · Quick</option>
                    <option value="role:accuracy">Inherit · Accuracy</option>
                    <optgroup label="Pin a provider">
                      <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
                    </optgroup>
                  </select>
                </td>
                <td>
                  <select v-if="f.providerId" class="lu-input lu-ft-sel" v-model="f.model" @change="touch">
                    <option v-for="o in modelOptions(f.providerId)" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                  <span v-else-if="f.role" class="lu-muted lu-ft-follow">follows {{ f.role }} · {{ resolvedRole(f.role) }}</span>
                  <span v-else class="lu-muted lu-ft-follow">default · {{ providerName(routing.default.llmId) }}</span>
                </td>
                <td class="lu-ft-tune"><a class="lu-mlink" href="#/ai-prompts">✎ prompt</a></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="lu-feat-foot">
        <span v-if="saved" class="lu-saved">✓ Saved</span>
        <span class="lu-pf-spacer" />
        <LuButton intent="primary" :loading="saving" @click="save">{{ saving ? "Saving…" : "Save routing" }}</LuButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lu-feat { max-width: 1000px; }
.lu-fcard { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md, 10px); padding: 14px 16px; margin-bottom: 14px; }
.lu-fcard-h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.lu-fcard-h b { font-size: 14px; color: var(--ink); }
.lu-fcard-h .lu-muted { font-size: 11.5px; }

.lu-fgrid2 { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px 12px; align-items: center; }
.lu-fl { color: var(--ink-2); font-size: 12px; }
select.lu-input { cursor: pointer; appearance: auto; }

.lu-roles { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.lu-role { border: 1px solid var(--border); border-radius: var(--r-sm, 8px); padding: 11px 13px; background: var(--surface-2); }
.lu-role-n { font-size: 12.5px; color: var(--ink-2); display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.lu-role-row { display: flex; gap: 8px; }
.lu-role-row .lu-input { flex: 1; min-width: 0; }
.lu-rchip { font-size: 9.5px; font-weight: 800; letter-spacing: .04em; border-radius: 999px; padding: 2px 8px; }
.lu-rchip--quick { background: var(--accent-soft); color: var(--accent-ink, var(--accent)); border: 1px solid var(--accent-line, var(--accent)); }
.lu-rchip--accuracy { background: var(--gold-soft, #f5edda); color: var(--gold, #b08a3e); border: 1px solid var(--gold-line, #e2d2b0); }

.lu-ftable-wrap { border: 1px solid var(--border); border-radius: var(--r-sm, 8px); overflow: hidden; }
.lu-ftable { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lu-ftable th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.lu-ftable td { padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.lu-ftable tr:last-child td { border-bottom: 0; }
.lu-ft-feat { max-width: 340px; }
.lu-ft-name { font-weight: 600; color: var(--ink); }
.lu-ft-hint { font-size: 11px; color: var(--muted); margin-top: 1px; }
.lu-ft-sel { min-width: 190px; }
.lu-ft-follow { font-size: 11.5px; }
.lu-ft-tune { white-space: nowrap; text-align: right; }
.lu-mlink { color: var(--accent-ink, var(--accent)); font-size: 12px; cursor: pointer; }

.lu-feat-foot { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.lu-pf-spacer { flex: 1; }
.lu-saved { color: var(--success, var(--accent)); font-size: 12px; font-weight: 600; }
</style>
