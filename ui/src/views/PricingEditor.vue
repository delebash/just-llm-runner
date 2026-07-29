<script setup>
// SPDX-License-Identifier: MIT
// Editor for cloud model pricing (the usage-ledger cost source). Backed by the
// shared /v1/ai/pricing CRUD (llm_runner/llm/pricing_api.py), persisted in the
// host DB's model_pricing table (seeded from pricing.DEFAULT_PRICING). Prices
// change, so they're editable here rather than hardcoded in pricing.py. Local
// models have no row → cost 0. Values are USD per 1,000,000 tokens.
import { onMounted, ref } from "vue";

import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { request } from "../client.js";

const rows = ref([]);
const loading = ref(true);
const error = ref("");
const draft = ref({ modelId: "", inputPerM: "", outputPerM: "" });
const busy = ref(""); // the modelId (or "__add") currently saving/deleting

function _apply(d) { rows.value = (d.rows || []).map((r) => ({ ...r })); }

async function load() {
  loading.value = true; error.value = "";
  try { _apply(await request("/v1/ai/pricing")); }
  catch (e) { error.value = e.message || "Couldn't load pricing."; }
  finally { loading.value = false; }
}

async function put(body, key) {
  busy.value = key; error.value = "";
  try { _apply(await request("/v1/ai/pricing", { method: "PUT", body })); return true; }
  catch (e) { error.value = e.message || "Save failed."; return false; }
  finally { busy.value = ""; }
}

function saveRow(r) {
  put({ modelId: r.modelId, inputPerM: Number(r.inputPerM) || 0, outputPerM: Number(r.outputPerM) || 0 }, r.modelId);
}

async function addRow() {
  const id = (draft.value.modelId || "").trim();
  if (!id) { error.value = "A model id is required."; return; }
  const ok = await put({ modelId: id, inputPerM: Number(draft.value.inputPerM) || 0, outputPerM: Number(draft.value.outputPerM) || 0 }, "__add");
  if (ok) draft.value = { modelId: "", inputPerM: "", outputPerM: "" };
}

async function delRow(r) {
  if (!(await confirmDialog(`Remove pricing for “${r.modelId}”? Its recorded cost becomes $0.`))) return;
  busy.value = r.modelId; error.value = "";
  try { _apply(await request(`/v1/ai/pricing?modelId=${encodeURIComponent(r.modelId)}`, { method: "DELETE" })); }
  catch (e) { error.value = e.message || "Delete failed."; }
  finally { busy.value = ""; }
}

onMounted(load);
</script>

<template>
  <div class="lu-pricing">
    <div class="lu-pricing-head">
      <span class="lu-pcard-title">Cloud pricing</span>
      <span class="lu-muted">USD per 1,000,000 tokens — edits take effect on the next call's recorded cost. Local models (Ollama / llama.cpp) are always $0.</span>
    </div>
    <div v-if="error" class="lu-error">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>
    <table v-else class="ui-formgrid lu-price-tbl">
      <thead>
        <tr><th>Model id</th><th>Input $/1M</th><th>Output $/1M</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.modelId">
          <td class="lu-price-id">{{ r.modelId }}</td>
          <td><UiInput v-model="r.inputPerM" type="number" width="token" /></td>
          <td><UiInput v-model="r.outputPerM" type="number" width="token" /></td>
          <td class="lu-price-act">
            <UiButton intent="primary" size="small" :loading="busy === r.modelId" @click="saveRow(r)">Save</UiButton>
            <UiButton intent="ghost" size="small" title="Remove" @click="delRow(r)">✕</UiButton>
          </td>
        </tr>
        <tr class="ui-formgrid-add lu-price-add">
          <td><UiInput v-model="draft.modelId" placeholder="e.g. gpt-5-mini" /></td>
          <td><UiInput v-model="draft.inputPerM" type="number" placeholder="0" width="token" /></td>
          <td><UiInput v-model="draft.outputPerM" type="number" placeholder="0" width="token" /></td>
          <td class="lu-price-act"><UiButton intent="secondary" size="small" :loading="busy === '__add'" @click="addRow">＋ Add</UiButton></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.lu-pricing { margin-top: 18px; }
.lu-pricing-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
/* Table mechanics come from the shared .ui-formgrid; only the width cap is this editor's. */
.lu-price-tbl { max-width: 620px; }
.lu-price-id { font-family: var(--font-mono, monospace); color: var(--ink); }
.lu-price-act { display: flex; gap: 6px; justify-content: flex-end; }
</style>
