<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Add/Edit an AI provider — the shared form from the shared-ai-models mock:
// presets · Where-it-runs (Local/Online) · name · base URL · API key (hidden for
// local) · provider type (adapter, Decision 20) · chat + embedding model
// comboboxes (Fetch via the draft-probe endpoint) · Test · Save/Delete/Cancel.
// Self-contained: calls the shared /v1/llm-providers* endpoints via the shared
// client; emits "saved"/"deleted" so the parent reloads its list. (The local
// model/Fit section is added next — it's runner-backed + GPU-gated.)
import { computed, reactive, ref } from "vue";

import LuButton from "../components/LuButton.vue";
import LuCombobox from "../components/LuCombobox.vue";
import LuInput from "../components/LuInput.vue";
import LuSegmented from "../components/LuSegmented.vue";
import { request } from "../client.js";

const props = defineProps({
  provider: { type: Object, default: null }, // null = adding new
});
const emit = defineEmits(["saved", "deleted", "cancel"]);

const isNew = computed(() => !props.provider);
const isLocalUrl = (u) => /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(u || "");

const draft = reactive({
  id: props.provider?.id || "",
  name: props.provider?.name || "",
  providerType: props.provider?.providerType || "openai-compat",
  baseUrl: props.provider?.baseUrl || "",
  apiKey: "", // write-only; "" preserves the stored key on edit
  defaultModel: props.provider?.defaultModel || "",
  embeddingModel: props.provider?.embeddingModel || "",
  timeoutSeconds: props.provider?.timeoutSeconds || 60,
});
const local = ref(props.provider ? isLocalUrl(props.provider.baseUrl) : true);

const PROVIDER_TYPES = [
  { value: "openai-compat", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "gemini", label: "Gemini (Google)" },
  { value: "ollama", label: "Ollama (native)" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openrouter", label: "OpenRouter" },
];
const WHERE = [{ value: true, label: "Local · free" }, { value: false, label: "Online · metered" }];

// presets — fill URL + type + where-it-runs from a known provider
const PRESETS = [
  ["Local engine", "http://localhost:8080/v1", "openai-compat", true],
  ["Ollama", "http://localhost:11434", "ollama", true],
  ["LM Studio", "http://localhost:1234/v1", "openai-compat", true],
  ["OpenAI", "https://api.openai.com/v1", "openai", false],
  ["Anthropic", "https://api.anthropic.com", "anthropic", false],
  ["Gemini", "https://generativelanguage.googleapis.com", "gemini", false],
  ["OpenRouter", "https://openrouter.ai/api/v1", "openai-compat", false],
];
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
    const r = await request("/v1/llm-providers/probe-models", {
      method: "POST",
      body: {
        providerType: draft.providerType,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || null,
        defaultModel: draft.defaultModel,
      },
    });
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
    const r = await request("/v1/llm-providers/probe-models", {
      method: "POST",
      body: { providerType: draft.providerType, baseUrl: draft.baseUrl, apiKey: draft.apiKey || null },
    });
    testMsg.value = (r.models && r.models.length)
      ? `✓ connected — ${r.models.length} models`
      : `✗ ${r.error || "reachable, but no models listed"}`;
  } catch (e) {
    testMsg.value = `✗ ${e.message || "failed"}`;
  }
}

const saving = ref(false);
const saveErr = ref("");
async function save() {
  if (!draft.id.trim() || !draft.name.trim()) { saveErr.value = "Id and name are required."; return; }
  saving.value = true; saveErr.value = "";
  // On edit, an empty apiKey means "keep the stored key"; a local provider sends none.
  const body = {
    id: draft.id, name: draft.name, providerType: draft.providerType,
    baseUrl: draft.baseUrl, defaultModel: draft.defaultModel,
    embeddingModel: draft.embeddingModel, timeoutSeconds: Number(draft.timeoutSeconds) || 60,
    apiKey: local.value ? null : (draft.apiKey || (isNew.value ? null : "")),
  };
  try {
    if (isNew.value) await request("/v1/llm-providers", { method: "POST", body });
    else await request(`/v1/llm-providers/${encodeURIComponent(draft.id)}`, { method: "PATCH", body });
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
    await request(`/v1/llm-providers/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
    emit("deleted");
  } catch (e) {
    saveErr.value = e.message || "Delete failed.";
  }
}
</script>

<template>
  <div class="lu-pform">
    <div v-if="isNew" class="lu-pf-presets">
      <span class="lu-muted lu-pf-presets-h">Start from a known provider — fills URL · type · where it runs</span>
      <div class="lu-pf-chips">
        <button v-for="p in PRESETS" :key="p[0]" type="button" class="lu-pf-chip" @click="applyPreset(p)">{{ p[0] }}</button>
      </div>
    </div>

    <div class="lu-fgrid">
      <span class="lu-fl">Where it runs</span>
      <div><LuSegmented v-model="local" :options="WHERE" />
        <div class="lu-fh">Local = on this machine, no key. Online = your metered cloud account.</div></div>

      <span class="lu-fl">Id</span>
      <LuInput v-model="draft.id" :readonly="!isNew" placeholder="my-provider" />

      <span class="lu-fl">Name</span>
      <LuInput v-model="draft.name" placeholder="My provider" />

      <span class="lu-fl">Base URL</span>
      <LuInput v-model="draft.baseUrl" placeholder="http://localhost:11434/v1" />

      <template v-if="!local">
        <span class="lu-fl">API key</span>
        <LuInput v-model="draft.apiKey" type="password" :placeholder="isNew ? 'sk-…' : 'leave blank to keep current'" />
      </template>

      <span class="lu-fl">Provider type</span>
      <select class="lu-input" :value="draft.providerType" @change="draft.providerType = $event.target.value">
        <option v-for="t in PROVIDER_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>

      <span class="lu-fl">Default chat model</span>
      <div>
        <LuCombobox v-model="draft.defaultModel" :items="chatModels" :loading="fetching"
          placeholder="Fetch or type a model id" @fetch="fetchModels" />
        <div v-if="probeMsg" class="lu-fh lu-fh-warn">{{ probeMsg }}</div>
        <div class="lu-fh">The provider's default — switch it per feature in Features.</div>
      </div>

      <span class="lu-fl">Embedding model <span class="lu-muted">optional</span></span>
      <div>
        <LuCombobox v-model="draft.embeddingModel" :items="embedModels" :loading="fetching"
          placeholder="leave blank if not used" @fetch="fetchModels" />
        <div class="lu-fh">Fills the RAG / semantic-search index. OpenAI: text-embedding-3-small · Ollama: nomic-embed-text.</div>
      </div>
    </div>

    <div v-if="saveErr" class="lu-error lu-pf-err">{{ saveErr }}</div>

    <div class="lu-pf-foot">
      <LuButton intent="secondary" @click="testConnection">Test connection</LuButton>
      <span class="lu-muted lu-pf-test">{{ testMsg }}</span>
      <span class="lu-pf-spacer" />
      <LuButton v-if="!isNew" intent="danger" @click="remove">Delete</LuButton>
      <LuButton intent="ghost" @click="emit('cancel')">Cancel</LuButton>
      <LuButton intent="primary" :loading="saving" @click="save">{{ saving ? "Saving…" : "Save provider" }}</LuButton>
    </div>
  </div>
</template>

<style scoped>
.lu-pform { padding: 14px 16px; border-top: 1px solid var(--border); background: var(--accent-soft); }
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
.lu-pf-foot { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
.lu-pf-spacer { flex: 1; }
.lu-pf-test { font-size: 11.5px; }
/* the native provider-type select reuses .lu-input; force select chrome */
select.lu-input { cursor: pointer; appearance: auto; }
</style>
