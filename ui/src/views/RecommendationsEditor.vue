<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Manual editor for the per-model recommendations (QuickSetup Q3 layer — "what
// is this model good FOR"). Backed by the shared `/v1/ai/recommendations` CRUD
// endpoints (see llm_runner/llm/recommendations_api.py) and persisted in the
// host's DB via its RecommendationStore (JustWrite: model_recommendations
// table; JustVoice's host store when adopted). One UI for both apps.
//
// Shape: rows of {modelId, job, rank, why, builtIn}. Built-in rows are seeded
// merges (factory defaults the editor can reset); user rows are everything else.
// The editor: table of all rows · row-click to edit inline · "Add row" creates
// a new (modelId, job) pin · DELETE removes one · "Reset built-in defaults"
// re-seeds the built_in rows AND preserves user-added rows (proven live).
import { computed, onMounted, ref } from "vue";

import AppModal from "../common/components/AppModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiNumber from "../common/components/UiNumber.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTable from "../common/components/UiTable.vue";
import UiTag from "../common/components/UiTag.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import LuJobSelect from "../components/LuJobSelect.vue";
import { request } from "../client.js";

const rows = ref([]);
const models = ref([]); // runner catalog — for the modelId picker
const loading = ref(true);
const error = ref("");

const TABLE_COLUMNS = [
  { id: "modelId", accessorKey: "modelId", header: "Model", sortable: true, enableGlobalFilter: true },
  { id: "job", accessorKey: "job", header: "Job", sortable: true, enableGlobalFilter: true, cellStyle: { width: "140px" } },
  { id: "rank", accessorKey: "rank", header: "Rank", sortable: true, cellStyle: { width: "80px", textAlign: "right" } },
  { id: "why", accessorKey: "why", header: "Why", enableGlobalFilter: true },
  { id: "source", accessorKey: "builtIn", header: "Source", sortable: true, cellStyle: { width: "110px" } },
  { id: "actions", accessorKey: "_actions", header: "", cellStyle: { width: "70px", textAlign: "right" } },
];

const filter = ref("");

const modelOptions = computed(() => {
  // Catalog models + any user-pasted modelIds already used in rows (so editing
  // a "my-pasted-model" row offers itself in the picker).
  const known = new Set(models.value.map((m) => m.id));
  const extras = rows.value.map((r) => r.modelId).filter((id) => id && !known.has(id));
  return [
    ...models.value.map((m) => ({ value: m.id, label: `${m.name} (${m.id})` })),
    ...Array.from(new Set(extras)).map((id) => ({ value: id, label: `${id} (user-added)` })),
  ];
});

// ── load ────────────────────────────────────────────────────────────────────
async function loadAll() {
  loading.value = true;
  error.value = "";
  try {
    const [r, m] = await Promise.all([
      request("/v1/ai/recommendations"),
      request("/v1/llm-runner/models"),
    ]);
    rows.value = r.rows || [];
    models.value = m.models || [];
  } catch (e) {
    error.value = e?.message || "Couldn't load recommendations.";
  } finally {
    loading.value = false;
  }
}
onMounted(loadAll);

// ── editor modal (add / edit one row) ──────────────────────────────────────
const editing = ref(null);     // null | the row being edited (a draft copy)
const editingOriginal = ref(null); // the original (modelId, job) for delete-then-upsert when keys change

function startNew() {
  editing.value = { modelId: "", job: "chat", rank: 100, why: "" };
  editingOriginal.value = null;
}
function startEdit(row) {
  editing.value = { modelId: row.modelId, job: row.job, rank: row.rank, why: row.why };
  editingOriginal.value = { modelId: row.modelId, job: row.job };
}
function cancelEdit() {
  editing.value = null;
  editingOriginal.value = null;
}

const saveError = ref("");
const saving = ref(false);
async function saveEdit() {
  if (!editing.value.modelId.trim() || !editing.value.job.trim()) {
    saveError.value = "Model and Job are required.";
    return;
  }
  saving.value = true;
  saveError.value = "";
  try {
    // If the user changed the (modelId, job) primary key, delete the old row
    // first — the PUT will then create the new (modelId, job) cleanly.
    const orig = editingOriginal.value;
    const next = editing.value;
    if (orig && (orig.modelId !== next.modelId || orig.job !== next.job)) {
      await request(
        `/v1/ai/recommendations?modelId=${encodeURIComponent(orig.modelId)}&job=${encodeURIComponent(orig.job)}`,
        { method: "DELETE" },
      );
    }
    const r = await request("/v1/ai/recommendations", {
      method: "PUT",
      body: { modelId: next.modelId.trim(), job: next.job.trim(), rank: Number(next.rank) || 100, why: next.why || "" },
    });
    rows.value = r.rows || [];
    cancelEdit();
  } catch (e) {
    saveError.value = e?.message || "Save failed.";
  } finally {
    saving.value = false;
  }
}

// ── row actions ─────────────────────────────────────────────────────────────
const busy = ref("");  // composite key being acted on, for button feedback
async function deleteRow(row) {
  if (!confirm(`Delete recommendation "${row.modelId}" for job "${row.job}"?`)) return;
  const key = `${row.modelId}|${row.job}`;
  busy.value = key;
  try {
    const r = await request(
      `/v1/ai/recommendations?modelId=${encodeURIComponent(row.modelId)}&job=${encodeURIComponent(row.job)}`,
      { method: "DELETE" },
    );
    rows.value = r.rows || [];
  } catch (e) {
    error.value = e?.message || "Delete failed.";
  } finally {
    busy.value = "";
  }
}

const resetting = ref(false);
async function resetFactory() {
  if (!confirm("Reset factory recommendations? Deleted built-in rows will return; your user-added rows are kept.")) return;
  resetting.value = true;
  try {
    const r = await request("/v1/ai/recommendations/reset", { method: "POST" });
    rows.value = r.rows || [];
  } catch (e) {
    error.value = e?.message || "Reset failed.";
  } finally {
    resetting.value = false;
  }
}
</script>

<template>
  <section class="lu-rec">
    <div class="lu-rec-head">
      <div>
        <b class="lu-rec-title">Model recommendations</b>
        <span class="lu-muted lu-rec-sub">What each model is good FOR — drives the QuickSetup pre-fills. Auto-detect handles "will it fit" and "how to run it"; this is the curated layer humans maintain.</span>
      </div>
      <div class="lu-rec-actions">
        <UiButton intent="secondary" size="small" :loading="resetting" @click="resetFactory">Reset factory defaults</UiButton>
        <UiButton intent="primary" size="small" @click="startNew">＋ Add recommendation</UiButton>
      </div>
    </div>

    <div v-if="error" class="lu-error lu-rec-err">{{ error }}</div>

    <div class="lu-rec-toolbar">
      <UiInput v-model="filter" placeholder="Filter by model id, job, or why…" />
    </div>

    <UiTable
      :data="rows"
      :columns="TABLE_COLUMNS"
      data-key="_key"
      :global-filter="filter"
      :global-filter-fields="['modelId', 'job', 'why']"
      :pagination="{ pageSize: 25, pageSizeOptions: [10, 25, 50, 100] }"
      :default-sort="{ id: 'job', desc: false }"
      row-hover
      @row-click="({ data }) => startEdit(data)"
    >
      <template #modelId="{ row }">
        <code class="lu-mono">{{ row.modelId }}</code>
      </template>
      <template #job="{ row }">
        <UiTag intent="ghost">{{ row.job }}</UiTag>
      </template>
      <template #source="{ row }">
        <UiTag :intent="row.builtIn ? 'success' : 'secondary'">{{ row.builtIn ? "factory" : "user" }}</UiTag>
      </template>
      <template #actions="{ row }">
        <UiButton intent="danger" size="small" :loading="busy === `${row.modelId}|${row.job}`" @click.stop="deleteRow(row)">Delete</UiButton>
      </template>
      <template #empty>
        <span class="lu-muted">No recommendations yet — add one above, or hit "Reset factory defaults".</span>
      </template>
    </UiTable>

    <AppModal
      v-if="editing"
      :title="editingOriginal ? 'Edit recommendation' : 'Add recommendation'"
      :max-width="'520px'"
      @close="cancelEdit"
    >
      <div class="lu-rec-form">
        <label class="lu-rec-label">Model
          <UiSelect v-model="editing.modelId" :options="modelOptions" placeholder="Pick a catalog model or type an id" />
        </label>
        <label class="lu-rec-label">Job
          <LuJobSelect v-model="editing.job" />
          <span class="lu-muted lu-rec-hint">Jobs come from your editable list (Routing by job → Jobs).</span>
        </label>
        <label class="lu-rec-label">Rank
          <UiNumber v-model="editing.rank" :min="1" :max="999" :step="10" />
          <span class="lu-muted lu-rec-hint">Lower = preferred. The wizard uses this to order candidates within a job.</span>
        </label>
        <label class="lu-rec-label">Why
          <UiTextarea v-model="editing.why" placeholder="One-line cited reason shown in the wizard." />
        </label>
        <div v-if="saveError" class="lu-error">{{ saveError }}</div>
      </div>
      <template #footer>
        <UiButton intent="ghost" @click="cancelEdit">Cancel</UiButton>
        <span class="lu-rec-spacer" />
        <UiButton intent="primary" :loading="saving" @click="saveEdit">{{ editingOriginal ? "Save changes" : "Add" }}</UiButton>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.lu-rec { display: flex; flex-direction: column; gap: 12px; }
.lu-rec-head { display: flex; align-items: flex-start; gap: 12px; }
.lu-rec-head > div { flex: 1; min-width: 0; }
.lu-rec-title { font-size: 14px; color: var(--ink); }
.lu-rec-sub { font-size: 11.5px; margin-left: 8px; }
.lu-rec-actions { display: flex; gap: 8px; flex: none; }
.lu-rec-err { margin: 4px 0; }
.lu-rec-toolbar { display: flex; align-items: center; gap: 8px; }
.lu-rec-toolbar :deep(.ui-input-wrap) { flex: 1; }
.lu-mono { font-family: var(--font-mono, monospace); font-size: 12px; }
.lu-rec-form { display: flex; flex-direction: column; gap: 14px; }
.lu-rec-label { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-2); font-weight: 600; }
.lu-rec-hint { font-size: 10.5px; line-height: 1.4; margin-top: 2px; font-weight: 400; color: var(--muted); }
.lu-rec-spacer { flex: 1; }
</style>
