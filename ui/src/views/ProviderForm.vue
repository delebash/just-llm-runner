<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Add/Edit an AI provider — the shared form from the shared-ai-models mock:
// presets · Where-it-runs (Local/Online) · name · base URL · API key (hidden for
// local) · provider type (adapter, Decision 20) · chat + embedding model
// comboboxes (Fetch via the draft-probe endpoint) · Test · Save/Delete/Cancel.
// Self-contained: calls the shared /v1/llm-providers* endpoints via the shared
// client; emits "saved"/"deleted" so the parent reloads its list. The built-in
// provider also mounts the Local engine panel (which hosts the binaries editor) + model catalog.
import { computed, reactive, ref, watch } from "vue";

import AppModal from "../common/components/AppModal.vue";
import UiButton from "../common/components/UiButton.vue";
import LuCombobox from "../components/LuCombobox.vue";
import UiInput from "../common/components/UiInput.vue";
import LuClassTunes from "../components/LuClassTunes.vue";
import LuGlobalSwitches from "../components/LuGlobalSwitches.vue";
import LuRunnerEngine from "../components/LuRunnerEngine.vue";
import LuModelCatalog from "../components/LuModelCatalog.vue";
import UiSegmented from "../common/components/UiSegmented.vue";
import { request } from "../client.js";
import { PROVIDER_PRESETS, ONLINE_ONLY_TYPES, probeModels, createProvider } from "../composables/useProviderConnect.js";

const props = defineProps({
  provider: { type: Object, default: null }, // null = adding new
  // QC-39 (b): the built-in provider's form is mounted PERMANENTLY as the page's
  // top section — nothing to collapse back to, so no Cancel, and the section
  // supplies the card chrome (the form renders bare).
  permanent: { type: Boolean, default: false },
});
const emit = defineEmits(["saved", "deleted", "cancel"]);

const isNew = computed(() => !props.provider);
// The bundled llama.cpp runner — its where-it-runs + type are fixed (it's THE
// built-in engine), and it's the one provider with a managed model catalog.
const isBuiltin = computed(() => props.provider?.providerType === "local-llamacpp");

const draft = reactive({
  name: props.provider?.name || "",
  providerType: props.provider?.providerType || "openai-compat",
  baseUrl: props.provider?.baseUrl || "",
  apiKey: "", // write-only; "" preserves the stored key on edit
  defaultModel: props.provider?.defaultModel || "",
  embeddingModel: props.provider?.embeddingModel || "",
  timeoutSeconds: props.provider?.timeoutSeconds || 60,
});
// The stored Local/Online choice (server derives the id from the name, so there
// is no id field to type). New providers default to Local — but where-it-runs is
// only a CHOICE for the ambiguous types (openai-compat, ollama): the metered-cloud
// types are forced Online by `isLocal`, which also self-heals a row mis-saved as
// local (#1: an online provider saved while the toggle read Local sent
// apiKey=null — the clear sentinel — and silently wiped its stored key).
const local = ref(props.provider ? !!props.provider.local : true);
const lockedOnline = computed(() => ONLINE_ONLY_TYPES.has(draft.providerType));
const isLocal = computed(() => (lockedOnline.value ? false : local.value));

const PROVIDER_TYPES = [
  { value: "openai-compat", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "gemini", label: "Gemini (Google)" },
  { value: "ollama", label: "Ollama (native)" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "xai", label: "xAI (Grok)" },
  { value: "mistral", label: "Mistral" },
];
const WHERE = [{ value: true, label: "Local · free" }, { value: false, label: "Online · metered" }];

// presets — fill URL + type + where-it-runs from a known provider (shared with QuickSetup
// via useProviderConnect — one source, no drift).
const PRESETS = PROVIDER_PRESETS;
function applyPreset([name, url, type, isLocal]) {
  if (!draft.name) draft.name = name;
  draft.baseUrl = url;
  draft.providerType = type;
  local.value = isLocal;
}

// ── model discovery (draft-probe — works before save) ───────────────────────
const fetched = ref([]);
const fetching = ref(false);
const probeMsg = ref("");
const EMBED_RX = /embed/i;
const chatModels = computed(() => fetched.value.filter((m) => !EMBED_RX.test(m)));
const embedModels = computed(() => fetched.value.filter((m) => EMBED_RX.test(m)));

async function fetchModels() {
  fetching.value = true;
  probeMsg.value = "";
  try {
    const r = await probeModels({ providerType: draft.providerType, baseUrl: draft.baseUrl, apiKey: draft.apiKey, defaultModel: draft.defaultModel });
    fetched.value = r.models || [];
    if (!fetched.value.length) probeMsg.value = r.error || "No models returned — check the URL / key / that a model is loaded.";
  } catch (e) {
    probeMsg.value = e.message || "Fetch failed.";
  } finally {
    fetching.value = false;
  }
}

const testMsg = ref("");
async function testConnection() {
  testMsg.value = "Testing…";
  try {
    const r = await probeModels({ providerType: draft.providerType, baseUrl: draft.baseUrl, apiKey: draft.apiKey });
    // The built-in engine returns a composed health line (#139 — probing its lazy
    // router read "reachable, but no models listed" on a perfectly configured box;
    // models load on first use by design). Prefer it whenever the server sends one.
    if (r.detail) {
      testMsg.value = r.error ? `✗ ${r.detail}` : `✓ ${r.detail}`;
      return;
    }
    testMsg.value = (r.models && r.models.length)
      ? `✓ connected — ${r.models.length} models`
      : `✗ ${r.error || "reachable, but no models listed"}`;
  } catch (e) {
    testMsg.value = `✗ ${e.message || "failed"}`;
  }
}

// The two launch-config LIBRARY editors open as POPUPS (#6, user 2026-07-08: "make
// global launch and hardware class popup dialog edits instead of embeded") — the
// SAME shared components, expanded inside an AppModal instead of collapsed drawers
// stacked on the Edit view.
const showClassTunes = ref(false);
const showGlobalSwitches = ref(false);

const saving = ref(false);
const saveErr = ref("");
async function save() {
  if (!draft.name.trim()) { saveErr.value = "Name is required."; return; }
  saving.value = true; saveErr.value = "";
  // The id is derived server-side from the name on create; on edit the path param
  // identifies the row, so the body carries no id. apiKey contract: "" preserves
  // the stored key, null clears it — and this form has NO explicit remove-key
  // affordance, so it must never send null on edit (#1: the old `local ? null : …`
  // wiped a stored key every time the toggle read Local).
  const body = {
    name: draft.name, providerType: draft.providerType,
    baseUrl: draft.baseUrl, defaultModel: draft.defaultModel,
    embeddingModel: draft.embeddingModel, timeoutSeconds: Number(draft.timeoutSeconds) || 60,
    local: isLocal.value,
    apiKey: draft.apiKey || (isNew.value ? null : ""),
  };
  try {
    if (isNew.value) await createProvider(body);
    else await request(`/v1/llm-providers/${encodeURIComponent(props.provider.id)}`, { method: "PATCH", body });
    emit("saved");
  } catch (e) {
    saveErr.value = e.message || "Save failed.";
  } finally {
    saving.value = false;
  }
}
async function remove() {
  if (isNew.value) return;
  try {
    await request(`/v1/llm-providers/${encodeURIComponent(props.provider.id)}`, { method: "DELETE" });
    emit("deleted");
  } catch (e) {
    saveErr.value = e.message || "Delete failed.";
  }
}

// ── Reasoning levels (per-provider level→value map — U2/T6) ──────────────────
// The level→(word|tokens) table the ONE resolver reads (GET/PUT
// /v1/ai/reasoning-map/{provider}). Only for a SAVED provider — the map is keyed
// by provider id, so a brand-new unsaved provider has none yet. Seeded per
// provider TYPE server-side (fill-if-missing); one PUT per edited row on change.
const LEVEL_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
const reasoningRows = ref([]);
const reasoningProvider = computed(() => props.provider?.id || "");
// POPUP editor, not an inline auto-expanded table (user ruling 2026-07-16: "reasoning
// level in provider should be collapsable … actually i like the popup editor") — the
// same button+AppModal pattern as the launch-config libraries below. Loaded on open.
const showReasoning = ref(false);
watch(showReasoning, (open) => { if (open) loadReasoningMap(); });
// Hide the INAPPLICABLE column per provider type (user ruling 2026-07-16: a blank Word
// on the built-in provider is inert — the local path never reads a word — and a field
// that does nothing should say so or not exist). Mirrors REASONING_MAP_TYPE_SEEDS'
// semantics (reasoning_map_api.py): number-only types have no word form; word-only
// types have no token form; anthropic + unknown types speak BOTH (safe default —
// never lock a user out of a live column).
const NUMBER_ONLY_TYPES = new Set(["local-llamacpp", "gemini"]);
const WORD_ONLY_TYPES = new Set(["openai", "openai-compat", "openrouter", "ollama"]);
// D5 (#15 C4): these types run thinking at the MODEL's own default — the adapter emits no
// effort param (openai_sdk.EMIT_EFFORT_TYPES excludes them), so neither column is editable;
// show the line instead (a user must never edit a value nothing sends). deepseek moved here
// out of WORD_ONLY_TYPES (its dead cloud reasoning_effort branch was removed with the pivot).
const MODEL_DEFAULT_TYPES = new Set(["deepseek", "xai", "mistral"]);
const showModelDefault = computed(() => MODEL_DEFAULT_TYPES.has(draft.providerType));
const showWordCol = computed(() => !showModelDefault.value && !NUMBER_ONLY_TYPES.has(draft.providerType));
const showTokensCol = computed(() => !showModelDefault.value && !WORD_ONLY_TYPES.has(draft.providerType));
async function loadReasoningMap() {
  if (!reasoningProvider.value) return;
  try {
    const r = await request(`/v1/ai/reasoning-map/${encodeURIComponent(reasoningProvider.value)}`);
    reasoningRows.value = r?.rows || [];
  } catch { reasoningRows.value = []; }
}
function parseTokens(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
async function putReasoningRow(row) {
  if (!reasoningProvider.value) return;
  // Values are editable DATA — the server upserts by (provider, level). A failed
  // PUT leaves the row's edited value in place; the next load reconciles.
  try {
    await request(`/v1/ai/reasoning-map/${encodeURIComponent(reasoningProvider.value)}`, {
      method: "PUT",
      body: { level: row.level, word: row.word || "", tokens: row.tokens ?? null },
    });
  } catch { /* surfaced by the shared client error path */ }
}
</script>

<template>
  <div class="lu-pform" :class="{ 'lu-pform--bare': props.permanent }">
    <div v-if="isNew" class="lu-pf-presets">
      <span class="lu-muted lu-pf-presets-h">Start from a known provider — fills URL · type · where it runs</span>
      <div class="lu-pf-chips">
        <button v-for="p in PRESETS" :key="p[0]" type="button" class="lu-pf-chip" @click="applyPreset(p)">{{ p[0] }}</button>
      </div>
    </div>

    <div class="lu-fgrid">
      <span class="lu-fl">Where it runs</span>
      <div v-if="isBuiltin"><span class="lu-locked">Local · free · built-in</span></div>
      <div v-else-if="lockedOnline"><span class="lu-locked">Online · metered</span>
        <div class="lu-fh">This provider type is a metered cloud API — it always runs online.</div></div>
      <div v-else><UiSegmented v-model="local" :options="WHERE" />
        <div class="lu-fh">Local = on this machine, no key. Online = your metered cloud account.</div></div>

      <span class="lu-fl">Name</span>
      <UiInput v-model="draft.name" placeholder="My provider" />

      <span class="lu-fl">Base URL</span>
      <UiInput v-model="draft.baseUrl" placeholder="http://localhost:11434/v1" />

      <template v-if="!isLocal">
        <span class="lu-fl">API key</span>
        <div>
          <UiInput v-model="draft.apiKey" type="password"
            :placeholder="!isNew && provider?.hasApiKey ? '••••••••  (a key is saved)' : 'sk-…'" />
          <!-- The key is write-only server-side, so the form can never re-display it — a
               blank field on edit read as "no key saved" (user, 2026-07-06). State it. -->
          <div v-if="!isNew && provider?.hasApiKey && !draft.apiKey" class="lu-fh">
            🔒 An API key is saved (never shown). Leave blank to keep it — typing replaces it.
          </div>
        </div>
      </template>

      <span class="lu-fl">Provider type</span>
      <div v-if="isBuiltin"><span class="lu-locked">llama.cpp · built-in engine</span></div>
      <select v-else class="lu-input" :value="draft.providerType" @change="draft.providerType = $event.target.value">
        <option v-for="t in PROVIDER_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>

      <!-- Model slots are REMOTE-provider-only (user, 2026-07-06: "no default chat model
           like gpt-4o-mini, we pull model from provider once connected"). The local
           runner's General/Embedding slots live on the catalog below (the "Your setup"
           strip + Set-as-default / Set-as-embedding), so these fields never render for it.
           No hardcoded model ids anywhere — Fetch pulls the connected provider's list. -->
      <template v-if="!isBuiltin">
        <span class="lu-fl">Default chat model</span>
        <div>
          <LuCombobox v-model="draft.defaultModel" :items="chatModels" :loading="fetching"
            placeholder="Fetch or type a model id" @fetch="fetchModels" />
          <div v-if="probeMsg" class="lu-fh lu-fh-warn">{{ probeMsg }}</div>
          <div class="lu-fh">Fetched from the provider once connected — switch it per feature in Features.</div>
        </div>

        <span class="lu-fl">Embedding model <span class="lu-muted">optional</span></span>
        <div>
          <LuCombobox v-model="draft.embeddingModel" :items="embedModels" :loading="fetching"
            placeholder="leave blank if not used" @fetch="fetchModels" />
          <div class="lu-fh">Fills the RAG / semantic-search index — fetch the provider's list and pick its embedding model.</div>
        </div>
      </template>
    </div>

    <!-- Reasoning levels — a POPUP editor (user ruling 2026-07-16), same pattern as the
         launch-config library buttons below. Shown only for a saved provider (the map is
         keyed by id). Edits PUT one row on change. -->
    <div v-if="reasoningProvider" class="lu-pf-libs">
      <UiButton intent="secondary" size="small" @click="showReasoning = true">Reasoning levels…</UiButton>
      <span class="lu-muted lu-pf-libs-cap">what each level asks this provider for — words for effort-word providers, token budgets for the local engine</span>
    </div>
    <AppModal v-if="showReasoning" title="Reasoning levels"
      :max-width="'560px'" @close="showReasoning = false">
      <div v-if="showModelDefault" class="lu-fh">
        This provider runs thinking at the model's own default — no per-level control.
      </div>
      <template v-else>
        <div class="lu-rtable" :class="{ 'lu-rtable--two': !(showWordCol && showTokensCol) }">
          <div class="lu-rt-row lu-rt-head">
            <span>Level</span>
            <span v-if="showWordCol">Word</span>
            <span v-if="showTokensCol">Tokens</span>
          </div>
          <div v-for="row in reasoningRows" :key="row.level" class="lu-rt-row">
            <span class="lu-rt-lvl">{{ LEVEL_LABELS[row.level] || row.level }}</span>
            <UiInput v-if="showWordCol" :model-value="row.word" placeholder="—"
              @update:model-value="row.word = $event" @blur="putReasoningRow(row)" />
            <UiInput v-if="showTokensCol" type="number" :model-value="row.tokens ?? ''" placeholder="—"
              @update:model-value="row.tokens = parseTokens($event)" @blur="putReasoningRow(row)" />
          </div>
        </div>
        <div class="lu-fh">{{ showWordCol && showTokensCol
          ? "what each level asks this provider for — new models take the word, legacy models the token budget"
          : showTokensCol
            ? "the thinking-token budget each level asks this provider for"
            : "the effort word each level asks this provider for" }}</div>
      </template>
    </AppModal>

    <!-- lu-pf-eng: space between the Provider type row and this panel (user, 2026-07-07). -->
    <LuRunnerEngine v-if="isBuiltin" class="lu-pf-eng" />
    <LuModelCatalog v-if="isBuiltin" />
    <!-- The launch-config libraries — POPUP editors (#6): the cross-model class-tune
         library (ROUND 15) and the global launch defaults (#140), each the SAME shared
         component the drawers used, opened expanded in a dialog. -->
    <div v-if="isBuiltin" class="lu-pf-libs">
      <UiButton intent="secondary" size="small" @click="showClassTunes = true">Hardware/model class defaults…</UiButton>
      <UiButton intent="secondary" size="small" @click="showGlobalSwitches = true">Global launch defaults…</UiButton>
      <span class="lu-muted lu-pf-libs-cap">the launch-config libraries — per-PC-class starting points, and the always-on switch bundles under every tune</span>
    </div>
    <AppModal v-if="showClassTunes" title="Hardware/model class defaults — the library"
      :max-width="'760px'" @close="showClassTunes = false">
      <LuClassTunes expanded />
    </AppModal>
    <AppModal v-if="showGlobalSwitches" title="Global launch defaults"
      :max-width="'760px'" @close="showGlobalSwitches = false">
      <LuGlobalSwitches expanded />
    </AppModal>

    <div v-if="saveErr" class="lu-error lu-pf-err">{{ saveErr }}</div>

    <div class="lu-pf-foot">
      <UiButton intent="secondary" @click="testConnection">Test connection</UiButton>
      <span class="lu-muted lu-pf-test">{{ testMsg }}</span>
      <span class="lu-pf-spacer" />
      <UiButton v-if="!isNew && !isBuiltin" intent="danger" @click="remove">Delete</UiButton>
      <UiButton v-if="!props.permanent" intent="ghost" @click="emit('cancel')">Cancel</UiButton>
      <UiButton intent="primary" :loading="saving" @click="save">{{ saving ? "Saving…" : "Save provider" }}</UiButton>
    </div>
  </div>
</template>

<style scoped>
/* QC-39: neutral surfaces — the page-scale accent-soft (pink) wash is gone
   (mockup (a)/(b), the user's pick); accent stays at chip/focus scale. The
   inline expanded form reads as an expanded card in the provider list; the
   permanent built-in mount renders bare (its section owns the chrome). */
.lu-pform { padding: 14px 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); margin-top: 8px; }
.lu-pform--bare { border: 0; border-radius: 0; background: transparent; padding: 0; margin-top: 0; }
.lu-pf-presets { margin-bottom: 12px; }
.lu-pf-presets-h { display: block; font-size: 11px; margin-bottom: 6px; }
.lu-pf-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.lu-pf-chip {
  font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 999px;
  padding: 5px 12px; background: var(--surface); color: var(--ink-2); cursor: pointer;
}
.lu-pf-chip:hover { border-color: var(--accent); color: var(--accent-ink, var(--accent)); background: var(--surface); }
.lu-fgrid { display: grid; grid-template-columns: 130px minmax(0,1fr); gap: 9px 12px; font-size: 12.5px; align-items: center; }
.lu-fl { color: var(--ink-2); font-size: 11.5px; }
.lu-fh { font-size: 11px; color: var(--muted); margin-top: 3px; }
.lu-fh-warn { color: var(--danger); }
.lu-pf-err { margin-top: 10px; }
/* Space between the form grid (Provider type is its last built-in row) and the Local
   engine panel (user, 2026-07-07: "space between provider type and local engine"). */
.lu-pf-eng { margin-top: 14px; }
/* The launch-config library buttons under the catalog — same 14px rhythm. */
.lu-pf-libs { margin-top: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-pf-libs-cap { font-size: 11px; }
.lu-pf-foot { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
.lu-pf-spacer { flex: 1; }
.lu-pf-test { font-size: 11.5px; }
/* the native provider-type select reuses .lu-input; force select chrome */
select.lu-input { cursor: pointer; appearance: auto; }
/* fixed (non-editable) value for the built-in engine's locked fields */
.lu-locked {
  display: inline-flex; align-items: center; font-size: 12px; color: var(--ink-2);
  background: var(--surface-3); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px;
}
.lu-pf-reason { margin-top: 14px; }
.lu-pf-reason-h { font-size: 11.5px; font-weight: 600; color: var(--ink-2); margin-bottom: 6px; }
.lu-rtable { display: flex; flex-direction: column; gap: 6px; }
.lu-rt-row { display: grid; grid-template-columns: 90px minmax(0,1fr) minmax(0,1fr); gap: 8px; align-items: center; }
/* One value column when the provider speaks only words OR only numbers (the
   inapplicable column is hidden — an inert field must not render). */
.lu-rtable--two .lu-rt-row { grid-template-columns: 90px minmax(0,1fr); }
.lu-rt-head { font-size: 11px; color: var(--muted); }
.lu-rt-lvl { font-size: 12px; color: var(--ink-2); }
</style>
