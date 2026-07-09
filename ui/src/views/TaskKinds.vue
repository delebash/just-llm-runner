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
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import FeatureLab from "../components/FeatureLab.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTag from "../common/components/UiTag.vue";
import Icon from "../common/components/Icon.vue";
import { request } from "../client.js";
import { confirmDialog } from "../common/services/dialog.js";
import { pushToast } from "../common/services/toastBridge.js";

const tasks = ref([]);              // [{id,label,description,position,builtIn}]
const featureTaskKinds = ref({});  // action key → task id
const presets = ref([]);           // EnginePresetRow[]
const assign = ref({ defaultPresetId: "", taskKinds: {} });
const prompts = ref([]);           // all action prompts (member labels + the Lab prompt)
const providers = ref([]);
const knobCatalog = ref([]);
const routing = ref(null);
const samplerCatalogList = computed(() => knobCatalog.value.filter((k) => k.plane === 2));
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
const taskLabel = (id) => tasks.value.find((t) => t.id === id)?.label || id;
function taskPreset(taskId) { return assign.value.taskKinds?.[taskId] || ""; }
// QC-15 (2026-07-08, option A): no "— inherit default —" — the fallback concept is
// gone from the UI (a task always points at a preset; a dangling/empty one renders
// as an explicit no-preset warning, never as silent inheritance).
const presetOptions = computed(() => presets.value.map((p) => ({ value: p.id, label: p.name })));
// Tasks a member can be MOVED to (all but its current one). Leading "Move to…" so the
// control reads as an action, not a current value (a feature always has a task).
function moveOptions(exclude) {
  return [{ value: "", label: "Move to…" }, ...tasks.value.filter((t) => t.id !== exclude).map((t) => ({ value: t.id, label: t.label }))];
}
// QC-16 (option A): the picker says what it DOES — assigning MOVES the feature here
// (every feature always has a task), so the label is the verb and each option names
// the task it would leave.
function addOptions(taskId) {
  const inThis = new Set(membersOf(taskId));
  return [{ value: "", label: "Move a feature here…" },
    ...Object.keys(featureTaskKinds.value).filter((k) => !inThis.has(k)).sort()
      .map((k) => ({ value: k, label: `${actionLabel(k)} — from ${taskLabel(featureTaskKinds.value[k])}` }))];
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
    assign.value = pa || { defaultPresetId: "", taskKinds: {} };
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

// QC-15 (option A, the no-naming-popups rule): "+ New task" opens the real add form
// in the pane — name is a plain field, and Save refuses until BOTH name and preset
// are set (an empty task with no preset does nothing; the form forces it honest).
const creating = ref(false);
const draft = ref({ label: "", presetId: "" });
const canCreate = computed(() => !!draft.value.label.trim() && !!draft.value.presetId);
function startCreate() {
  creating.value = true;
  draft.value = { label: "", presetId: "" };
  message.value = "";
}
function cancelCreate() { creating.value = false; }
async function createTask() {
  if (!canCreate.value) return;
  const before = new Set(tasks.value.map((t) => t.id));
  try {
    applyTaskResp(await request("/v1/ai/task-kinds", { method: "POST", body: { label: draft.value.label.trim() } }));
    const added = tasks.value.find((t) => !before.has(t.id));
    if (added) {
      await setTaskPreset(added.id, draft.value.presetId);
      selectTask(added.id);
    }
    creating.value = false;
    message.value = "Task created.";
  } catch (e) { error.value = `Create failed: ${e.message}`; }
}

// QC-15 (option A): rename is an inline always-editable name field (no popup) — the
// selected task's header IS the field; saving happens on blur. Built-ins are
// renameable (matching prior behavior; per-task Reset restores the shipped name).
const nameDraft = ref("");
watch(selected, (t) => { nameDraft.value = t?.label || ""; }, { immediate: true });
async function saveName(t) {
  const label = nameDraft.value.trim();
  if (!t || !label || label === t.label) { nameDraft.value = t?.label || ""; return; }
  try {
    applyTaskResp(await request(`/v1/ai/task-kinds/${encodeURIComponent(t.id)}`, {
      method: "PUT", body: { label, description: t.description || "" },
    }));
    message.value = "Task renamed.";
  } catch (e) { error.value = `Rename failed: ${e.message}`; }
}

async function deleteTask(t) {
  if (t.builtIn) return;
  const ok = await confirmDialog({
    title: `Delete task “${t.label}”?`, danger: true,
    message: "Its members re-float to their factory tasks, and its preset assignment is removed.",
  });
  if (!ok) return;
  try {
    applyTaskResp(await request(`/v1/ai/task-kinds/${encodeURIComponent(t.id)}`, { method: "DELETE" }));
    if (selTask.value === t.id) selectTask(tasks.value[0]?.id || "");
    message.value = "Task deleted.";
  } catch (e) { error.value = `Delete failed: ${e.message}`; }
}

// QC-36 (the page-related-undo law): a page-LOCAL inverse stack for the two
// mutations this surface makes — feature MOVES + task→preset changes. ⌘Z pops
// the last inverse (the JW host scopes the global book-undo OFF /ai so this
// handler owns the key here; the kit page is otherwise route-agnostic). Bounded
// so it can't grow without limit; `_undoing` guards the re-entrant apply.
const undoStack = ref([]);
const UNDO_LIMIT = 50;
let _undoing = false;
function pushUndo(label, inverse) {
  if (_undoing) return;             // an inverse's own effects don't re-record
  undoStack.value.push({ label, inverse });
  if (undoStack.value.length > UNDO_LIMIT) undoStack.value.shift();
}
async function undoLast() {
  const entry = undoStack.value.pop();
  if (!entry) return;
  _undoing = true;
  try { await entry.inverse(); message.value = `Undid: ${entry.label}`; }
  finally { _undoing = false; }
}
function onKeyUndo(e) {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
  if (e.key.toLowerCase() !== "z") return;
  // Don't steal ⌘Z from a focused text field (the create-form name, etc.).
  const el = document.activeElement;
  if (el && el.matches?.("input, textarea, [contenteditable=true]")) return;
  if (!undoStack.value.length) return;
  e.preventDefault();
  e.stopPropagation();
  undoLast();
}
onMounted(() => window.addEventListener("keydown", onKeyUndo, { capture: true }));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeyUndo, { capture: true }));

async function assignFeature(key, taskId, { record = true } = {}) {
  if (!key || !taskId) return;
  const from = featureTaskKinds.value[key];   // capture BEFORE the move (for the inverse)
  try {
    applyTaskResp(await request("/v1/ai/task-kinds/feature", { method: "PUT", body: { featureKey: key, taskKind: taskId } }));
    // if the member left the selected task, keep the test-against valid
    if (!membersOf(selTask.value).includes(testAgainst.value)) testAgainst.value = membersOf(selTask.value)[0] || "";
    // QC-37 (toast law, supersedes the QC-16 move toast): the member list
    // visibly gains/loses the row — the move is on screen, no toast.
    // QC-36: record the inverse (move it back to where it came from).
    if (record && from && from !== taskId) {
      pushUndo(`move ${actionLabel(key)} back to ${taskLabel(from)}`,
        () => assignFeature(key, from, { record: false }));
    }
  } catch (e) { error.value = `Reassign failed: ${e.message}`; }
}

async function setTaskPreset(taskId, presetId, { record = true } = {}) {
  const prev = taskPreset(taskId);            // capture BEFORE (for the inverse)
  try {
    assign.value = await request("/v1/ai/preset-assignments/task-kind", { method: "PUT", body: { taskKind: taskId, presetId } });
    message.value = "Preset assigned.";
    // QC-36: record the inverse (restore the prior preset).
    if (record && prev !== presetId) {
      pushUndo(`preset for ${taskLabel(taskId)}`,
        () => setTaskPreset(taskId, prev, { record: false }));
    }
  } catch (e) { error.value = `Assign failed: ${e.message}`; }
}
// Per-task Reset (built-in only) — restore ONE task's name/description/preset to
// factory AND undo the feature moves involving it (QC-27, the user's "yes undo moves").
async function resetTask(t) {
  if (!t?.builtIn) return;
  const ok = await confirmDialog({
    title: `Reset “${t.label}” to defaults?`,
    message: "Restores this task's name, description, preset, and features to their shipped defaults — features moved out come back, and features moved in return to their own tasks.",
  });
  if (!ok) return;
  try {
    applyTaskResp(await request(`/v1/ai/task-kinds/${encodeURIComponent(t.id)}/reset`, { method: "POST" }));
    assign.value = await request("/v1/ai/preset-assignments");
    message.value = "Task reset to defaults.";
  } catch (e) { error.value = `Reset failed: ${e.message}`; }
}
// Global reset — restore ALL seeded routing to factory (built-in presets + task names +
// every assignment). Custom tasks + custom presets are kept. (QC-15: the copy no longer
// names the Default-preset fallback — that concept left the UI; the backend reset still
// restores the whole seeded assignment state.)
async function resetAll() {
  const ok = await confirmDialog({
    title: "Reset all tasks to defaults?", danger: true,
    message: "Restores the built-in presets + task names and every task→preset / feature→task assignment. Your custom tasks + custom presets are kept.",
  });
  if (!ok) return;
  try {
    await request("/v1/ai/task-kinds/reset", { method: "POST" });
    await load();
    message.value = "Reset to defaults.";
  } catch (e) { error.value = `Reset failed: ${e.message}`; }
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
        <!-- Left: the task list + New. (QC-15: the Default-preset fallback row is GONE —
             the UI never claims silent inheritance; a task with no preset warns instead.) -->
        <aside v-show="!navCollapsed" class="lu-fw-list">
          <UiButton intent="primary" size="small" class="lu-tk-new" @click="startCreate">＋ New task</UiButton>
          <button v-for="t in tasks" :key="t.id" type="button" class="lu-fw-card"
            :class="{ 'is-active': t.id === selTask && !creating }" @click="selectTask(t.id); creating = false">
            <div class="lu-fw-card-label">{{ t.label }}<UiTag v-if="t.builtIn" class="lu-tk-tag">built-in</UiTag></div>
            <div class="lu-fw-card-model">{{ taskPreset(t.id) ? presetName(taskPreset(t.id)) : "⚠ no preset" }} · {{ membersOf(t.id).length }} features</div>
          </button>
          <div class="lu-tk-aside-foot">
            <UiButton intent="ghost" size="small" class="lu-tk-resetall"
              title="Restore the seeded task/preset + feature assignments — your custom tasks + presets are kept"
              @click="resetAll">↺ Reset all to defaults</UiButton>
          </div>
        </aside>

        <!-- Create mode (QC-15): the real add form, in the pane — a plain name field +
             the preset select; Save stays disabled until BOTH are set. No name popup. -->
        <section v-if="creating" class="lu-fw-edit">
          <div class="lu-fw-h"><b>New task</b><span class="lu-fw-spacer" /></div>
          <div class="lu-tk-sec lu-tk-createform">
            <div class="lu-tk-presetrow">
              <span class="lu-tk-presetrow-k">Name</span>
              <UiInput v-model="draft.label" width="name" class="lu-tk-createname" />
            </div>
            <div class="lu-tk-presetrow">
              <span class="lu-tk-presetrow-k">Preset</span>
              <UiSelect v-model="draft.presetId" :options="presetOptions" width="name" placeholder="— pick a preset —" />
            </div>
            <div class="lu-tk-createactions">
              <UiButton intent="secondary" size="small" @click="cancelCreate">Cancel</UiButton>
              <UiButton intent="primary" size="small" :disabled="!canCreate" @click="createTask">Save</UiButton>
            </div>
          </div>
        </section>

        <!-- Right: the selected task — members + preset & test. -->
        <section v-else-if="selected" class="lu-fw-edit">
          <div class="lu-fw-h">
            <!-- QC-15: the name IS an editable field (no Rename popup); saves on blur. -->
            <UiInput v-model="nameDraft" class="lu-tk-name" width="name"
              title="The task's name — edit it right here" @blur="saveName(selected)" />
            <UiTag v-if="selected.builtIn" class="lu-tk-tag">built-in</UiTag>
            <UiButton v-if="selected.builtIn" intent="ghost" size="small"
              title="Reset this task to its defaults (name, description, preset)"
              @click="resetTask(selected)">Reset</UiButton>
            <UiButton v-if="!selected.builtIn" intent="ghost" size="small" @click="deleteTask(selected)">Delete</UiButton>
            <span class="lu-fw-spacer" />
            <span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
            <UiButton intent="ghost" size="small"
              v-tooltip.bottom="navCollapsed ? 'Show list' : 'Hide list'"
              :aria-label="navCollapsed ? 'Show list' : 'Hide list'"
              @click="navCollapsed = !navCollapsed"><Icon name="SidebarToggle" :size="14" /></UiButton>
          </div>
          <div v-if="selected.description" class="lu-tk-desc">{{ selected.description }}</div>

          <!-- #28 + #29 (B4-1/B4-2, 2026-07-08): TWO columns — the task's features
               on the left; Preset & test-against on the right; the Lab itself runs
               full-width below (it is the workbench, not a column's detail). The
               add-a-feature picker sits ON the Features heading line (#28). -->
          <div class="lu-tk-cols">
            <div class="lu-tk-sec">
              <div class="lu-tk-sec-h"><b>Features in this task</b><span class="lu-muted">{{ selMembers.length }}</span>
                <span class="lu-tk-sec-spacer" />
                <UiSelect class="lu-tk-add" :model-value="''" :options="addOptions(selTask)" width="name"
                  @update:model-value="(v) => v && assignFeature(v, selTask)" />
              </div>
              <div v-if="selMembers.length" class="lu-tk-members">
                <div v-for="k in selMembers" :key="k" class="lu-tk-member">
                  <span class="lu-tk-member-name">{{ actionLabel(k) }}</span>
                  <!-- token width: in the two-column layout a name-wide select
                       squeezed the feature names to "Conti…" — the NAME is the
                       row's point; the move control is the utility. -->
                  <UiSelect class="lu-tk-move" :model-value="''" :options="moveOptions(selTask)" width="token"
                    @update:model-value="(v) => v && assignFeature(k, v)" />
                </div>
              </div>
              <div v-else class="lu-tk-empty lu-muted">No features yet — move one in above to test this task.</div>
            </div>

            <div class="lu-tk-sec">
              <div class="lu-tk-sec-h"><b>Preset &amp; test</b><span class="lu-muted">the model + samplers this task runs</span></div>
              <div class="lu-tk-presetrow">
                <span class="lu-tk-presetrow-k">Preset</span>
                <UiSelect :model-value="taskPreset(selTask)" :options="presetOptions" width="name"
                  placeholder="— no preset — pick one" @update:model-value="(v) => setTaskPreset(selTask, v)" />
              </div>
              <div v-if="selMembers.length" class="lu-tk-testrow">
                <span class="lu-tk-presetrow-k">Test against</span>
                <UiSelect :model-value="testAgainst" :options="memberOptions" width="name"
                  @update:model-value="(v) => testAgainst = v" />
                <span class="lu-muted lu-tk-testhint">run this task's preset on a member feature's prompt</span>
              </div>
              <div v-else class="lu-tk-empty lu-muted">Assign a feature to this task to test its preset.</div>
            </div>
          </div>

          <div class="lu-tk-sec">
            <FeatureLab v-if="testPrompt" :key="testAgainst"
              :action="testAgainst" :prompt="testPrompt" :providers="providers" :presets="presets"
              :sampler-catalog-list="samplerCatalogList" :task-kind="selTask"
              :production-preset-id="taskPreset(selTask)" :pin="pin(testAgainst)"
              @use-production="onUseForTask" @presets-changed="onPresetsChanged" />
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
.lu-tk-aside-foot { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); display: flex; }
/* The inline name field is the pane's title — it reads like the old <b> heading
   but is directly editable (QC-15: no rename popup). */
.lu-tk-name :deep(input) { font-weight: 700; }
.lu-tk-createactions { display: flex; gap: 8px; }
.lu-tk-desc { font-size: 12.5px; color: var(--ink-2); }
.lu-tk-sec { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
/* #29: features | preset-&-test side by side; stacks on narrow panes. */
.lu-tk-cols { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(280px, 1fr); gap: 0 22px; align-items: start; }
@media (max-width: 900px) { .lu-tk-cols { grid-template-columns: 1fr; } }
.lu-tk-sec-h { display: flex; align-items: center; gap: 10px; } .lu-tk-sec-h b { font-size: 13px; color: var(--ink); } .lu-tk-sec-h .lu-muted { font-size: 11.5px; }
.lu-tk-sec-spacer { flex: 1; }
.lu-tk-members { display: flex; flex-direction: column; gap: 6px; }
.lu-tk-member { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.lu-tk-member-name { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--ink); }
.lu-tk-empty { font-size: 12px; padding: 8px 0; font-style: italic; }
.lu-tk-presetrow, .lu-tk-testrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lu-tk-presetrow-k { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.lu-tk-testhint { font-size: 11.5px; }
</style>
