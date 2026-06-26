<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Routing by job — the PRIMARY routing surface (design §2.8/§9). "Pick one model
// per kind of task. Most people only touch this." Holds the global Defaults
// (Default LLM + embedding) + one card per job (the job→model map) + the job-list
// editor (add / rename / remove / reset over /v1/ai/jobs). Per-feature overrides
// live in the sibling "Routing by feature" workbench. Job CRUD lives here — with
// the job list — matching the app's manage-entities-where-listed pattern
// (Providers tab, Recommendations tab). Switch-preset/flag editing per job comes
// with the Switches-phase UI (design §6).
import { onMounted, ref } from "vue";

import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
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
const busy = ref("");          // a job id mid-action (delete), for button feedback
const editing = ref(null);     // 'new' | a job id | null
const draft = ref({ label: "", description: "" });

async function load() {
  loading.value = true; error.value = "";
  try {
    await loadRouting();
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ── job-list editor (CRUD over /v1/ai/jobs) ──────────────────────────────────
function startAdd() { editing.value = "new"; draft.value = { label: "", description: "" }; }
function startEdit(job) { editing.value = job.id; draft.value = { label: job.label, description: job.description || "" }; }
function cancelEdit() { editing.value = null; }

const saving = ref(false);
async function saveEdit() {
  const label = (draft.value.label || "").trim();
  if (!label) { cancelEdit(); return; }
  saving.value = true; error.value = "";
  try {
    if (editing.value === "new") {
      await request("/v1/ai/jobs", { method: "POST", body: { label, description: draft.value.description || "" } });
    } else {
      const job = jobs.value.find((j) => j.id === editing.value);
      await request(`/v1/ai/jobs/${encodeURIComponent(editing.value)}`, {
        method: "PUT",
        body: { id: editing.value, label, description: draft.value.description || "", position: job?.position || 0 },
      });
    }
    await reloadJobs();
    editing.value = null;
  } catch (e) {
    error.value = e?.message || "Save failed.";
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

      <!-- Jobs — one card per job (model + Used-for) + the CRUD editor. -->
      <div class="lu-rbj-jobs-h">
        <b>Jobs</b><span class="lu-muted">each task type runs on the model you pick; features inherit their job's model</span>
        <span class="lu-rbj-spacer" />
        <UiButton intent="secondary" size="small" @click="resetJobs">Reset to factory</UiButton>
        <UiButton intent="primary" size="small" @click="startAdd">＋ Add job</UiButton>
      </div>

      <div class="lu-rbj-cards">
        <div v-for="job in jobs" :key="job.id" class="lu-rbj-jobcard">
          <template v-if="editing === job.id">
            <UiInput v-model="draft.label" placeholder="Job name" />
            <UiTextarea v-model="draft.description" :rows="2" placeholder="What this job is for…" />
            <div class="lu-rbj-editrow">
              <UiButton intent="ghost" size="small" @click="cancelEdit">Cancel</UiButton>
              <span class="lu-rbj-spacer" />
              <UiButton intent="primary" size="small" :loading="saving" @click="saveEdit">Save</UiButton>
            </div>
          </template>
          <template v-else>
            <div class="lu-rbj-jobcard-h">
              <span class="lu-rchip lu-rchip--job">{{ job.label }}</span>
              <span class="lu-rbj-spacer" />
              <UiButton intent="ghost" size="small" title="Rename / edit" @click="startEdit(job)">Edit</UiButton>
              <UiButton v-if="job.id !== DEFAULT_JOB_ID" intent="danger" size="small"
                :loading="busy === job.id" title="Delete this job" @click="removeJob(job)">Delete</UiButton>
            </div>
            <p class="lu-rbj-jobcard-desc">{{ job.description }} <span class="lu-muted">Used for: {{ jobUsedFor(job.id) }}</span></p>
            <LuModelPicker editable :model-value="routing.jobs?.[job.id] || null" :providers="providers"
              inherit-label="— use Default LLM —" @update:model-value="setJob(job.id, $event)" />
          </template>
        </div>

        <!-- New-job editor card -->
        <div v-if="editing === 'new'" class="lu-rbj-jobcard lu-rbj-jobcard--new">
          <UiInput v-model="draft.label" placeholder="New job name (e.g. Marketing)" />
          <UiTextarea v-model="draft.description" :rows="2" placeholder="What this job is for…" />
          <div class="lu-rbj-editrow">
            <UiButton intent="ghost" size="small" @click="cancelEdit">Cancel</UiButton>
            <span class="lu-rbj-spacer" />
            <UiButton intent="primary" size="small" :loading="saving" @click="saveEdit">Add job</UiButton>
          </div>
        </div>
      </div>
    </template>
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
.lu-rbj-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.lu-rbj-jobcard { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); display: flex; flex-direction: column; gap: 8px; }
.lu-rbj-jobcard--new { border-color: var(--accent); }
.lu-rbj-jobcard-h { display: flex; align-items: center; gap: 8px; }
.lu-rbj-jobcard-desc { margin: 0; font-size: 12px; color: var(--ink-2); line-height: 1.45; }
.lu-rbj-editrow { display: flex; align-items: center; gap: 8px; }
.lu-rchip { font-size: 9px; font-weight: 800; letter-spacing: .04em; border-radius: 999px; padding: 3px 9px; text-align: center; }
.lu-rchip--job { background: var(--accent-soft); color: var(--accent-ink, var(--accent)); text-transform: uppercase; }
</style>
