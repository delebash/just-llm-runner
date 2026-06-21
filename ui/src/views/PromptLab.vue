<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Prompt Lab — the shared per-feature prompt editor. Lists every AI feature's
// prompt (from the DB, seeded with defaults) and edits the system + user-prompt
// template, temperature, and reasoning flag, or resets a built-in to its seeded
// default. Backed by /v1/ai/prompts (the server reads the prompt from the DB on
// every run, so edits take effect immediately).
//
// Self-contained: same endpoints both apps mount, shared client + primitives,
// no host components. Imported by JustWrite AND JustVoice (the AI/Models area's
// per-action Lab). Ported from JustWrite's AiPromptsView.vue.
import { computed, onMounted, ref } from "vue";

import LuButton from "../components/LuButton.vue";
import LuCheckbox from "../components/LuCheckbox.vue";
import LuInput from "../components/LuInput.vue";
import LuTextarea from "../components/LuTextarea.vue";
import { request } from "../client.js";

const prompts = ref([]);
const selectedKey = ref("");
const draft = ref(null);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const message = ref("");
// Kept as a constant so the literal "{{…}}" never appears in the template (Vue's
// parser would treat it as an interpolation).
const varHint = "{{variable}} placeholders";

const selected = computed(() => prompts.value.find((p) => p.key === selectedKey.value) || null);
const dirty = computed(() => {
  const a = draft.value;
  const b = selected.value;
  if (!a || !b) return false;
  return a.system !== b.system || a.userTemplate !== b.userTemplate
    || Number(a.temperature) !== Number(b.temperature) || a.think !== b.think;
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const json = await request("/v1/ai/prompts");
    prompts.value = (json.prompts || []).slice().sort((a, b) => a.key.localeCompare(b.key));
    if (prompts.value.length && !prompts.value.some((p) => p.key === selectedKey.value)) {
      select(prompts.value[0].key);
    }
  } catch (e) {
    error.value = `Couldn't load prompts: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

function select(key) {
  selectedKey.value = key;
  const p = prompts.value.find((x) => x.key === key);
  draft.value = p ? { ...p } : null;
  message.value = "";
}

function _upsertLocal(updated) {
  const i = prompts.value.findIndex((p) => p.key === updated.key);
  if (i >= 0) prompts.value[i] = updated;
}

async function save() {
  if (!draft.value) return;
  saving.value = true; error.value = ""; message.value = "";
  try {
    const updated = await request(`/v1/ai/prompts/${encodeURIComponent(draft.value.key)}`, {
      method: "PUT",
      body: {
        feature: draft.value.feature,
        system: draft.value.system,
        userTemplate: draft.value.userTemplate,
        temperature: Number(draft.value.temperature),
        think: !!draft.value.think,
      },
    });
    _upsertLocal(updated);
    message.value = "Saved.";
  } catch (e) {
    error.value = `Save failed: ${e.message}`;
  } finally {
    saving.value = false;
  }
}

async function resetToDefault() {
  if (!draft.value) return;
  saving.value = true; error.value = ""; message.value = "";
  try {
    const updated = await request(`/v1/ai/prompts/${encodeURIComponent(draft.value.key)}/reset`, { method: "POST" });
    _upsertLocal(updated);
    draft.value = { ...updated };
    message.value = "Reset to seeded default.";
  } catch (e) {
    error.value = `Reset failed: ${e.message}`;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="lu-prompt-lab">
    <header class="lu-pl-head">
      <div>
        <div class="lu-pl-eyebrow lu-muted">AI</div>
        <h2 class="lu-pl-title">Feature prompts</h2>
      </div>
      <LuButton intent="ghost" :disabled="loading" @click="load">Refresh</LuButton>
    </header>

    <p class="lu-muted lu-pl-intro">
      Every AI feature's system + user prompt lives in the database (seeded with a default, editable here).
      Edits take effect immediately — the server loads each feature's prompt from the DB on every run.
    </p>

    <div v-if="error" class="lu-error lu-pl-error">{{ error }}</div>

    <div class="lu-pl-body">
      <aside class="lu-pl-list">
        <button
          v-for="p in prompts" :key="p.key"
          type="button" class="lu-pl-row" :class="{ 'is-active': p.key === selectedKey }"
          @click="select(p.key)">
          <span class="lu-pl-row-key">{{ p.key }}</span>
          <span class="lu-pl-row-feature lu-muted">{{ p.feature }}<template v-if="!p.builtIn"> · custom</template></span>
        </button>
        <div v-if="!loading && !prompts.length" class="lu-muted" style="padding:10px">No prompts found.</div>
      </aside>

      <section v-if="draft" class="lu-pl-editor">
        <div class="lu-field">
          <label>Feature (routing key for pins / usage)</label>
          <LuInput v-model="draft.feature" :readonly="draft.builtIn" />
        </div>
        <div class="lu-field lu-pl-grow">
          <label>System prompt</label>
          <LuTextarea v-model="draft.system" auto-resize :rows="12" />
        </div>
        <div class="lu-field">
          <label>User-prompt template <span class="lu-pl-hint">(supports {{ varHint }})</span></label>
          <LuTextarea v-model="draft.userTemplate" auto-resize :rows="5" />
        </div>
        <div class="lu-pl-row2">
          <div class="lu-field lu-pl-temp">
            <label>Temperature</label>
            <LuInput v-model="draft.temperature" type="number" />
          </div>
          <label class="lu-pl-think">
            <LuCheckbox v-model="draft.think" />
            <span class="lu-muted">Reasoning (think)</span>
          </label>
        </div>

        <div class="lu-pl-actions">
          <LuButton v-if="draft.builtIn" intent="ghost" :disabled="saving" @click="resetToDefault">Reset to default</LuButton>
          <span class="lu-pl-spacer" />
          <span v-if="message" class="lu-pl-msg lu-muted">{{ message }}</span>
          <LuButton intent="primary" :disabled="saving || !dirty" @click="save">{{ saving ? "Saving…" : "Save" }}</LuButton>
        </div>
      </section>
      <section v-else class="lu-pl-editor lu-pl-empty lu-muted">Select a feature to edit its prompt.</section>
    </div>
  </div>
</template>

<style scoped>
.lu-prompt-lab { display:flex; flex-direction:column; height:100%; min-height:0; }
.lu-pl-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:8px; }
.lu-pl-eyebrow { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
.lu-pl-title { margin:2px 0 0; font-size:20px; font-weight:600; color:var(--ink); }
.lu-pl-intro { margin:0 0 12px; max-width:78ch; font-size:12.5px; line-height:1.5; }
.lu-pl-error { margin-bottom:10px; }
.lu-pl-body { display:grid; grid-template-columns:248px minmax(0,1fr); gap:16px; flex:1; min-height:0; }
.lu-pl-list { overflow:auto; border:1px solid var(--border); border-radius:10px; padding:6px; display:flex; flex-direction:column; gap:2px; }
.lu-pl-row { display:flex; flex-direction:column; align-items:flex-start; gap:1px; text-align:left; padding:7px 10px; border:0; background:transparent; border-radius:7px; cursor:pointer; width:100%; font:inherit; }
.lu-pl-row:hover { background:var(--surface-3); }
.lu-pl-row.is-active { background:var(--accent-soft); box-shadow:inset 0 0 0 1.5px var(--accent); }
.lu-pl-row-key { font-weight:600; font-size:12.5px; color:var(--ink); }
.lu-pl-row-feature { font-size:11px; }
.lu-pl-editor { overflow:auto; display:flex; flex-direction:column; gap:12px; padding-right:4px; }
.lu-pl-empty { padding:24px; }
.lu-pl-hint { font-size:11px; }
.lu-pl-grow :deep(textarea) { min-height:220px; }
.lu-pl-row2 { display:flex; gap:24px; align-items:flex-end; }
.lu-pl-temp { max-width:120px; }
.lu-pl-think { display:flex; align-items:center; gap:8px; }
.lu-pl-actions { display:flex; align-items:center; gap:10px; margin-top:4px; padding-bottom:8px; }
.lu-pl-spacer { flex:1; }
.lu-pl-msg { font-size:12px; }
</style>
