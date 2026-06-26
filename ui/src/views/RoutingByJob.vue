<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Routing by job — the PRIMARY routing surface (design §2.8/§9). "Pick one model
// per kind of task. Most people only touch this." Holds the global Defaults
// (Default LLM + embedding) + one ROW per job (the job→model map) + the job-list
// editor (add / rename / remove / reset over /v1/ai/jobs). Per-feature overrides
// live in the sibling "Routing by feature" workbench. Job CRUD lives here — with
// the job list — matching the app's manage-entities-where-listed pattern
// (Providers tab, Recommendations tab).
//
// #33: jobs render as a UiTable grid (was cards), reusing the SAME table + AppModal
// CRUD shape RecommendationsEditor.vue already uses — one pattern, not a copy.
import { onMounted, ref } from "vue";

import AppModal from "../common/components/AppModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import UiTable from "../common/components/UiTable.vue";
import LuModelPicker from "../components/LuModelPicker.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { request } from "../client.js";
import { useRouting } from "../composables/useRouting.js";

const DEFAULT_JOB_ID = "chat"; // the un-deletable fallback job (jobs_api.DEFAULT_JOB_ID)

const {
  routing, providers, jobs, loadRouting, jobUsedFor,
  setJob, setDefaultLlm, setDefaultEmbedding, reloadJobs,
} = useRouting();

const loading = ref(true);
const error = ref("");
const busy = ref(""); // a job id mid-action (delete), for button feedback

const TABLE_COLUMNS = [
  { id: "label", accessorKey: "label", header: "Job", sortable: true, enableGlobalFilter: true, cellStyle: { width: "150px" } },
  { id: "model", accessorKey: "_model", header: "Model", cellStyle: { minWidth: "260px" } },
  { id: "usedFor", accessorKey: "_usedFor", header: "Used for" },
  { id: "actions", accessorKey: "_actions", header: "", cellStyle: { width: "120px", textAlign: "right" } },
];

async function load() {
  loading.value = true;
  error.value = "";
  try {
    await loadRouting();
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ── add / edit job (modal) ───────────────────────────────────────────────────
const editing = ref(null); // null | { id?, label, description }  (no id = new)
const saving = ref(false);
const saveError = ref("");

function startAdd() {
  editing.value = { label: "", description: "" };
  saveError.value = "";
}
function startEdit(job) {
  editing.value = { id: job.id, label: job.label, description: job.description || "" };
  saveError.value = "";
}
function cancelEdit() {
  editing.value = null;
}

async function saveEdit() {
  const label = (editing.value.label || "").trim();
  if (!label) {
    saveError.value = "Name is required.";
    return;
  }
  saving.value = true;
  saveError.value = "";
  try {
    if (!editing.value.id) {
      await request("/v1/ai/jobs", { method: "POST", body: { label, description: editing.value.description || "" } });
    } else {
      const job = jobs.value.find((j) => j.id === editing.value.id);
      await request(`/v1/ai/jobs/${encodeURIComponent(editing.value.id)}`, {
        method: "PUT",
        body: { id: editing.value.id, label, description: editing.value.description || "", position: job?.position || 0 },
      });
    }
    await reloadJobs();
    editing.value = null;
  } catch (e) {
    saveError.value = e?.message || "Save failed.";
  } finally {
    saving.value = false;
  }
}

async function removeJob(job) {
  const ok = await confirmDialog({
    title: `Delete the "${job.label}" job?`,
    message: "Features classified into it fall back to the default job. Models routed to it are dropped.",
    danger: true,
  });
  if (!ok) return;
  busy.value = job.id;
  try {
    await request(`/v1/ai/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
    await reloadJobs();
  } catch (e) {
    error.value = e?.message || "Delete failed.";
  } finally {
    busy.value = "";
  }
}

async function resetJobs() {
  const ok = await confirmDialog({
    title: "Reset jobs to factory?",
    message: "Restores the built-in jobs (chat / prose / extraction / analysis). Your custom jobs are kept.",
  });
  if (!ok) return;
  try {
    await request("/v1/ai/jobs/reset", { method: "POST" });
    await reloadJobs();
  } catch (e) {
    error.value = e?.message || "Reset failed.";
  }
}
</script>

<template>
  <section class="lu-rbj">
    <p class="lu-rbj-lede lu-muted">
      Pick one model per kind of task. Most people only touch this. For fine control of a
      single feature, use <b>Routing by feature</b>.
    </p>

    <div v-if="error" class="lu-error lu-rbj-err">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else-if="routing">
      <!-- Global Defaults — the ultimate fallback every job + feature inherits. -->
      <div class="lu-rbj-card">
        <div class="lu-rbj-card-h"><b>Defaults</b><span class="lu-muted">what runs when nothing more specific is set</span></div>
        <div class="lu-rbj-defgrid">
          <label class="lu-rbj-dl">Default LLM</label>
          <LuModelPicker editable :model-value="{ providerId: routing.default.llmId, model: routing.default.model || '' }"
            :providers="providers" :show-roles="false" inherit-label="— pick a provider —"
            @update:model-value="setDefaultLlm" />
          <label class="lu-rbj-dl">Default embedding <span class="lu-muted">optional</span></label>
          <LuModelPicker editable kind="embedding"
            :model-value="{ providerId: routing.default.embeddingId, model: routing.default.embeddingModel || '' }"
            :providers="providers" :show-roles="false" inherit-label="— none —"
            @update:model-value="setDefaultEmbedding" />
        </div>
      </div>

      <!-- Jobs — one ROW per job (model + Used-for) + the CRUD editor. -->
      <div class="lu-rbj-jobs-h">
        <b>Jobs</b><span class="lu-muted">each task type runs on the model you pick; features inherit their job's model</span>
        <span class="lu-rbj-spacer" />
        <UiButton intent="secondary" size="small" @click="resetJobs">Reset to factory</UiButton>
        <UiButton intent="primary" size="small" @click="startAdd">＋ Add job</UiButton>
      </div>

      <UiTable
        :data="jobs"
        :columns="TABLE_COLUMNS"
        data-key="id"
        row-hover
      >
        <template #label="{ row }">
          <span class="lu-rchip lu-rchip--job">{{ row.label }}</span>
        </template>

        <template #model="{ row }">
          <LuModelPicker editable :model-value="routing.jobs?.[row.id] || null" :providers="providers"
            inherit-label="— use Default LLM —" @update:model-value="setJob(row.id, $event)" />
        </template>

        <template #usedFor="{ row }">
          <span class="lu-muted lu-rbj-usedfor">{{ jobUsedFor(row.id) }}</span>
        </template>

        <template #actions="{ row }">
          <UiButton intent="ghost" size="small" title="Rename / edit" @click.stop="startEdit(row)">Edit</UiButton>
          <UiButton v-if="row.id !== DEFAULT_JOB_ID" intent="danger" size="small"
            :loading="busy === row.id" title="Delete this job" @click.stop="removeJob(row)">Delete</UiButton>
        </template>

        <template #empty>
          <span class="lu-muted">No jobs — add one above, or "Reset to factory".</span>
        </template>
      </UiTable>
    </template>

    <!-- Add / edit job modal -->
    <AppModal
      v-if="editing"
      :title="editing.id ? 'Edit job' : 'Add job'"
      :max-width="'480px'"
      @close="cancelEdit"
    >
      <div class="lu-rbj-form">
        <label class="lu-rbj-label">Name
          <UiInput v-model="editing.label" placeholder="e.g. Marketing" />
        </label>
        <label class="lu-rbj-label">Description
          <UiTextarea v-model="editing.description" :rows="2" placeholder="What this job is for…" />
        </label>
        <div v-if="saveError" class="lu-error">{{ saveError }}</div>
      </div>
      <template #footer>
        <UiButton intent="ghost" @click="cancelEdit">Cancel</UiButton>
        <span class="lu-rbj-spacer" />
        <UiButton intent="primary" :loading="saving" @click="saveEdit">{{ editing.id ? "Save changes" : "Add job" }}</UiButton>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.lu-rbj { display: flex; flex-direction: column; gap: 14px; }
.lu-rbj-lede { font-size: 12.5px; margin: 0; max-width: 70ch; }
.lu-rbj-err { margin: 0; }
.lu-rbj-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); }
.lu-rbj-card-h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.lu-rbj-card-h b { font-size: 13px; color: var(--ink); } .lu-rbj-card-h .lu-muted { font-size: 11px; }
.lu-rbj-defgrid { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px 14px; align-items: center; }
.lu-rbj-dl { color: var(--ink-2); font-size: 12px; }
.lu-rbj-jobs-h { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.lu-rbj-jobs-h b { font-size: 13px; color: var(--ink); } .lu-rbj-jobs-h .lu-muted { font-size: 11px; }
.lu-rbj-spacer { flex: 1; }
.lu-rbj-usedfor { font-size: 11.5px; }
.lu-rchip { font-size: 9px; font-weight: 800; letter-spacing: .04em; border-radius: 999px; padding: 3px 9px; text-align: center; display: inline-block; }
.lu-rchip--job { background: var(--accent-soft); color: var(--accent-ink, var(--accent)); text-transform: uppercase; }
.lu-rbj-form { display: flex; flex-direction: column; gap: 14px; }
.lu-rbj-label { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-2); font-weight: 600; }
</style>
