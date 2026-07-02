<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// TaskKinds — the "Tasks" page (2026-07-02 user-creatable tasks model). A TASK is the
// LLM-work bucket a feature is assigned to; it carries a name + an engine preset + the
// features assigned to it. Here you CREATE / rename / delete tasks, ASSIGN features
// (add + move-to; every feature always has a task, so it's reassignment not removal),
// and SET UP + TEST a task's preset — the Lab (<FeatureLab>) run against one of the
// task's member features (a task has no prompt of its own, so its members are the test
// material). Reuses the shared master/detail shell (styles.css .lu-fw-*) + <FeatureLab>.
//
// Endpoints: /v1/ai/task-kinds (catalog + map + CRUD + feature-assign), /v1/ai/engine-presets
// (the preset library), /v1/ai/preset-assignments (task→preset + the global default),
// /v1/ai/prompts (member labels + the Lab's prompt), /v1/ai/routing (pins), /v1/llm-providers,
// /v1/ai/knob-catalog. Shared across both apps — only the seed data differs.
import { computed, onMounted, ref } from "vue";

import FeatureLab from "../components/FeatureLab.vue";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTag from "../common/components/UiTag.vue";
import { request } from "../client.js";
import { promptDialog, confirmDialog } from "../common/services/dialog.js";

const tasks = ref([]);              // [{id,label,description,position,builtIn}]
const featureTaskKinds = ref({});  // action key → task id
const presets = ref([]);           // EnginePresetRow[]
const assign = ref({ defaultPresetId: "", taskKinds: {}, features: {} });
const prompts = ref([]);           // all action prompts (member labels + the Lab prompt)
const providers = ref([]);
const knobCatalog = ref([]);
const routing = ref(null);
const samplerCatalogList = computed(() => knobCatalog.value.filter((k) => k.plane === 2));
const switchCatalogList = computed(() => knobCatalog.value.filter((k) => k.plane === 1));
const loading = ref(true);
const error = ref("");
const message = ref("");

const selTask = ref("");       // selected task id
const testAgainst = ref("");   // the member action the Lab runs against

const promptByKey = computed(() => Object.fromEntries(prompts.value.map((p) => [p.key, p])));
const selected = computed(() => tasks.value.find((t) => t.id === selTask.value) || null);

// A member action's display name (its canonical prompt label, else a readable key).
function actionLabel(key) {
  const p = promptByKey.value[key];
  if (p?.label) return p.label;
  const s = String(key).replace(/[._-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}
function membersOf(taskId) {
  return Object.entries(featureTaskKinds.value).filter(([, tk]) => tk === taskId).map(([k]) => k).sort();
}
const selMembers = computed(() => membersOf(selTask.value));

const presetName = (id) => presets.value.find((p) => p.id === id)?.name || "—";
function taskPreset(taskId) { return assign.value.taskKinds?.[taskId] || ""; }
const presetOptions = computed(() => [
  { value: "", label: "— inherit default —" },
  ...presets.value.map((p) => ({ value: p.id, label: p.name })),
]);
const defaultOptions = computed(() => [
  { value: "", label: "— none —" },
  ...presets.value.map((p) => ({ value: p.id, label: p.name })),
]);
// Tasks a member can be MOVED to (all but its current one). Leading "Move to…" so the
// control reads as an action, not a current value (a feature always has a task).
function moveOptions(exclude) {
  return [{ value: "", label: "Move to…" }, ...tasks.value.filter((t) => t.id !== exclude).map((t) => ({ value: t.id, label: t.label }))];
}
// Features NOT already in this task → the "+ Add feature" picker (assigning MOVES it here).
function addOptions(taskId) {
  const inThis = new Set(membersOf(taskId));
  return [{ value: "", label: "+ Add a feature…" },
    ...Object.keys(featureTaskKinds.value).filter((k) => !inThis.has(k)).sort()
      .map((k) => ({ value: k, label: actionLabel(k) }))];
}
const memberOptions = computed(() => selMembers.value.map((k) => ({ value: k, label: actionLabel(k) })));
function pin(key) { return routing.value?.pins?.[key] || null; }

function applyTaskResp(r) {
  if (r?.taskKinds) tasks.value = r.taskKinds;
  featureTaskKinds.value = r?.featureTaskKinds || {};
}

async function load() {
  loading.value = true; error.value = "";
  try {
    const [tk, ep, pa, pr, rt, pl] = await Promise.all([
      request("/v1/ai/task-kinds"), request("/v1/ai/engine-presets"),
      request("/v1/ai/preset-assignments"), request("/v1/ai/prompts"),
      request("/v1/ai/routing"), request("/v1/llm-providers"),
    ]);
    applyTaskResp(tk);
    presets.value = ep.presets || [];
    assign.value = pa || { defaultPresetId: "", taskKinds: {}, features: {} };
    prompts.value = pr.prompts || [];
    routing.value = rt; if (!routing.value.pins) routing.value.pins = {};
    providers.value = pl.providers || [];
    try { knobCatalog.value = (await request("/v1/ai/knob-catalog")).knobs || []; }
    catch { knobCatalog.value = []; }
    if (!selTask.value && tasks.value.length) selectTask(tasks.value[0].id);
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

function selectTask(id) {
  selTask.value = id;
  message.value = "";
  const m = membersOf(id);
  testAgainst.value = m[0] || "";
}

async function newTask() {
  const label = await promptDialog({ title: "New task", label: "Name", confirmLabel: "Create" });
  if (!label || !String(label).trim()) return;
  const before = new Set(tasks.value.map((t) => t.id));
  try {
    applyTaskResp(await request("/v1/ai/task-kinds", { method: "POST", body: { label: String(label).trim() } }));
    const added = tasks.value.find((t) => !before.has(t.id));
    if (added) selectTask(added.id);
    message.value = "Task created.";
  } catch (e) { error.value = `Create failed: ${e.message}`; }
}

async function renameTask(t) {
  const label = await promptDialog({ title: "Rename task", label: "Name", value: t.label, confirmLabel: "Save" });
  if (!label || !String(label).trim() || String(label).trim() === t.label) return;
  try {
    applyTaskResp(await request(`/v1/ai/task-kinds/${encodeURIComponent(t.id)}`, {
      method: "PUT", body: { label: String(label).trim(), description: t.description || "" },
    }));
    message.value = "Task renamed.";
  } catch (e) { error.value = `Rename failed: ${e.message}`; }
}

async function deleteTask(t) {
  if (t.builtIn) return;
  const ok = await confirmDialog({
    title: `Delete task “${t.label}”?`, danger: true,
    message: "Its members re-float to their factory tasks, and its preset assignment + recommendations are removed.",
  });
  if (!ok) return;
  try {
    applyTaskResp(await request(`/v1/ai/task-kinds/${encodeURIComponent(t.id)}`, { method: "DELETE" }));
    if (selTask.value === t.id) selectTask(tasks.value[0]?.id || "");
    message.value = "Task deleted.";
  } catch (e) { error.value = `Delete failed: ${e.message}`; }
}

async function assignFeature(key, taskId) {
  if (!key || !taskId) return;
  try {
    applyTaskResp(await request("/v1/ai/task-kinds/feature", { method: "PUT", body: { featureKey: key, taskKind: taskId } }));
    // if the member left the selected task, keep the test-against valid
    if (!membersOf(selTask.value).includes(testAgainst.value)) testAgainst.value = membersOf(selTask.value)[0] || "";
    message.value = "Feature reassigned.";
  } catch (e) { error.value = `Reassign failed: ${e.message}`; }
}

async function setTaskPreset(taskId, presetId) {
  try {
    assign.value = await request("/v1/ai/preset-assignments/task-kind", { method: "PUT", body: { taskKind: taskId, presetId } });
    message.value = "Preset assigned.";
  } catch (e) { error.value = `Assign failed: ${e.message}`; }
}
async function setDefaultPreset(presetId) {
  try {
    assign.value = await request("/v1/ai/preset-assignments/default", { method: "PUT", body: { presetId } });
    message.value = "Default preset set.";
  } catch (e) { error.value = `Default failed: ${e.message}`; }
}

// ── the Lab (test the TASK's preset against a member feature). FeatureLab owns the
// engine-preset Save-as / Delete calls (one source for both hosts) + emits the refreshed
// list; we store it. "Use for this task" makes the tested preset THIS TASK's preset. ──
function onPresetsChanged(list) { presets.value = list || []; }
async function onUseForTask(presetId) {
  if (!selTask.value) return;
  await setTaskPreset(selTask.value, presetId);
  message.value = "In production — this task runs that preset now.";
}

const navCollapsed = ref(false);
const testPrompt = computed(() => promptByKey.value[testAgainst.value] || null);

onMounted(load);
</script>

<template>
  <div class="lu-fw">
    <div v-if="error" class="lu-error" style="margin-bottom:10px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else>
      <div class="lu-fw-body" :class="{ 'nav-collapsed': navCollapsed }">
        <!-- Left: the task list + New + the global-default fallback. -->
        <aside v-show="!navCollapsed" class="lu-fw-list">
          <UiButton intent="primary" size="small" class="lu-tk-new" @click="newTask">＋ New task</UiButton>
          <button v-for="t in tasks" :key="t.id" type="button" class="lu-fw-card"
            :class="{ 'is-active': t.id === selTask }" @click="selectTask(t.id)">
            <div class="lu-fw-card-label">{{ t.label }}<UiTag v-if="t.builtIn" class="lu-tk-tag">built-in</UiTag></div>
            <div class="lu-fw-card-model">{{ taskPreset(t.id) ? presetName(taskPreset(t.id)) : "inherits default" }} · {{ membersOf(t.id).length }} features</div>
          </button>
          <div class="lu-tk-default">
            <div class="lu-tk-default-k">Default preset <span class="lu-muted">(fallback for any task with none)</span></div>
            <UiSelect :model-value="assign.defaultPresetId || ''" :options="defaultOptions" width="name"
              @update:model-value="setDefaultPreset" />
          </div>
        </aside>

        <!-- Right: the selected task — members + preset & test. -->
        <section v-if="selected" class="lu-fw-edit">
          <div class="lu-fw-h">
            <b>{{ selected.label }}</b>
            <UiTag v-if="selected.builtIn" class="lu-tk-tag">built-in</UiTag>
            <UiButton intent="ghost" size="small" @click="renameTask(selected)">Rename</UiButton>
            <UiButton v-if="!selected.builtIn" intent="ghost" size="small" @click="deleteTask(selected)">Delete</UiButton>
            <span class="lu-fw-spacer" />
            <span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
            <UiButton intent="ghost" size="small"
              @click="navCollapsed = !navCollapsed">{{ navCollapsed ? '☰ Show list' : '⟨ Collapse list' }}</UiButton>
          </div>
          <div v-if="selected.description" class="lu-tk-desc">{{ selected.description }}</div>

          <!-- Members (features assigned to this task) -->
          <div class="lu-tk-sec">
            <div class="lu-tk-sec-h"><b>Features in this task</b><span class="lu-muted">{{ selMembers.length }}</span></div>
            <div v-if="selMembers.length" class="lu-tk-members">
              <div v-for="k in selMembers" :key="k" class="lu-tk-member">
                <span class="lu-tk-member-name">{{ actionLabel(k) }}</span>
                <UiSelect class="lu-tk-move" :model-value="''" :options="moveOptions(selTask)" width="name"
                  @update:model-value="(v) => v && assignFeature(k, v)" />
              </div>
            </div>
            <div v-else class="lu-tk-empty lu-muted">No features yet — add one below to test this task.</div>
            <UiSelect class="lu-tk-add" :model-value="''" :options="addOptions(selTask)" width="name"
              @update:model-value="(v) => v && assignFeature(v, selTask)" />
          </div>

          <!-- Preset & test -->
          <div class="lu-tk-sec">
            <div class="lu-tk-sec-h"><b>Preset &amp; test</b><span class="lu-muted">the model + samplers this task runs</span></div>
            <div class="lu-tk-presetrow">
              <span class="lu-tk-presetrow-k">Preset</span>
              <UiSelect :model-value="taskPreset(selTask)" :options="presetOptions" width="name"
                @update:model-value="(v) => setTaskPreset(selTask, v)" />
            </div>
            <template v-if="selMembers.length">
              <div class="lu-tk-testrow">
                <span class="lu-tk-presetrow-k">Test against</span>
                <UiSelect :model-value="testAgainst" :options="memberOptions" width="name"
                  @update:model-value="(v) => testAgainst = v" />
                <span class="lu-muted lu-tk-testhint">run this task's preset on a member feature's prompt</span>
              </div>
              <FeatureLab v-if="testPrompt" :key="testAgainst"
                :action="testAgainst" :prompt="testPrompt" :providers="providers" :presets="presets"
                :sampler-catalog-list="samplerCatalogList" :switch-catalog-list="switchCatalogList"
                :production-preset-id="taskPreset(selTask)" :pin="pin(testAgainst)"
                @use-production="onUseForTask" @presets-changed="onPresetsChanged" />
            </template>
            <div v-else class="lu-tk-empty lu-muted">Assign a feature to this task to test its preset.</div>
          </div>
        </section>
        <div v-else class="lu-muted" style="padding:20px">Create or pick a task on the left.</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lu-tk-new { width: 100%; justify-content: center; margin-bottom: 4px; }
.lu-tk-tag { margin-left: 6px; }
.lu-tk-default { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 5px; }
.lu-tk-default-k { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--ink); }
.lu-tk-default-k .lu-muted { font-weight: 600; letter-spacing: 0; text-transform: none; }
.lu-tk-desc { font-size: 12.5px; color: var(--ink-2); }
.lu-tk-sec { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
.lu-tk-sec-h { display: flex; align-items: baseline; gap: 10px; } .lu-tk-sec-h b { font-size: 13px; color: var(--ink); } .lu-tk-sec-h .lu-muted { font-size: 11.5px; }
.lu-tk-members { display: flex; flex-direction: column; gap: 6px; }
.lu-tk-member { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.lu-tk-member-name { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--ink); }
.lu-tk-add { align-self: flex-start; }
.lu-tk-empty { font-size: 12px; padding: 8px 0; font-style: italic; }
.lu-tk-presetrow, .lu-tk-testrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lu-tk-presetrow-k { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.lu-tk-testhint { font-size: 11.5px; }
</style>
