<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Presets — the "Presets" page (2026-07-15 one-source rewrite). A PRESET owns the model
// + every tunable (provider/model, temperature, top_p, max_tokens, samplers, think +
// reasoning level). Features point AT a preset (their ref) — the one source of routing;
// the task tier is gone. Here you CREATE / rename / delete presets, see + change which
// FEATURES use each (move-to / assign, writing the feature's ref), and TEST + TUNE a
// preset's params in the Lab (<FeatureLab>) run against one of its member features (a
// preset has no prompt of its own, so its members are the test material). Built-ins have
// a per-preset Reset; a footer "Reset all" restores every built-in + seeded ref + the
// default. Reuses the shared master/detail shell (styles.css .lu-fw-*) + <FeatureLab>.
//
// Endpoints: /v1/ai/engine-presets (the preset library + CRUD + resets),
// /v1/ai/preset-assignments (the per-action refs + the global default; PUT
// /preset-assignments/feature moves a feature's ref), /v1/ai/prompts (member labels +
// the Lab's prompt), /v1/llm-providers, /v1/ai/knob-catalog. Shared across both apps —
// only the seed data differs.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import FeatureLab from "../components/FeatureLab.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTag from "../common/components/UiTag.vue";
import Icon from "../common/components/Icon.vue";
import { request } from "../client.js";
import { confirmDialog } from "../common/services/dialog.js";

const presets = ref([]);           // EnginePresetRow[]
const assign = ref({ defaultPresetId: "", features: {} });  // {defaultPresetId, features:{action->presetId}}
const prompts = ref([]);           // all action prompts (member labels + the Lab prompt)
const providers = ref([]);
const knobCatalog = ref([]);
const samplerCatalogList = computed(() => knobCatalog.value.filter((k) => k.plane === 2));
const loading = ref(true);
const error = ref("");
const message = ref("");

const selPreset = ref("");     // selected preset id
const testAgainst = ref("");   // the member action the Lab runs against

const promptByKey = computed(() => Object.fromEntries(prompts.value.map((p) => [p.key, p])));
const selected = computed(() => presets.value.find((p) => p.id === selPreset.value) || null);
const presetName = (id) => presets.value.find((p) => p.id === id)?.name || "—";
const presetExists = (id) => !!id && presets.value.some((p) => p.id === id);

// A member action's display name (its canonical prompt label, else a readable key).
function actionLabel(key) {
  const p = promptByKey.value[key];
  if (p?.label) return p.label;
  const s = String(key).replace(/[._-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}
// Members = the features whose ref points AT this preset (direct assignment). "Used by N"
// derives from the same map. (Every seeded action ships a ref, so the default preset's
// unassigned-catch is empty in practice — a member is always a direct ref.)
function membersOf(presetId) {
  return Object.entries(assign.value.features || {})
    .filter(([, pid]) => pid === presetId)
    .map(([k]) => k)
    .filter((k) => promptByKey.value[k])
    .sort();
}
const selMembers = computed(() => membersOf(selPreset.value));
const usedBy = (presetId) => membersOf(presetId).length;

// A feature's CURRENT preset (ref, existence-checked) + a readable "from X" label.
function currentPresetId(key) {
  const id = assign.value.features?.[key];
  return presetExists(id) ? id : "";
}
function currentPresetLabel(key) {
  const id = currentPresetId(key);
  return id ? presetName(id) : "the default";
}

// Presets a member can be MOVED to (all but its current). Leading "Move to…" so it reads
// as an action, not a current value.
function moveOptions(exclude) {
  return [{ value: "", label: "Move to…" },
    ...presets.value.filter((p) => p.id !== exclude).map((p) => ({ value: p.id, label: p.name }))];
}
// Assign-a-feature-here: every action NOT already in this preset, naming where it leaves.
function assignOptions(presetId) {
  const inThis = new Set(membersOf(presetId));
  return [{ value: "", label: "Assign a feature here…" },
    ...prompts.value.map((p) => p.key).filter((k) => !inThis.has(k)).sort()
      .map((k) => ({ value: k, label: `${actionLabel(k)} — from ${currentPresetLabel(k)}` }))];
}
const memberOptions = computed(() => selMembers.value.map((k) => ({ value: k, label: actionLabel(k) })));
const testPrompt = computed(() => promptByKey.value[testAgainst.value] || null);

async function load() {
  loading.value = true; error.value = "";
  try {
    const [ep, pa, pr, pl] = await Promise.all([
      request("/v1/ai/engine-presets"), request("/v1/ai/preset-assignments"),
      request("/v1/ai/prompts"), request("/v1/llm-providers"),
    ]);
    presets.value = ep.presets || [];
    assign.value = pa || { defaultPresetId: "", features: {} };
    prompts.value = pr.prompts || [];
    providers.value = pl.providers || [];
    try { knobCatalog.value = (await request("/v1/ai/knob-catalog")).knobs || []; }
    catch { knobCatalog.value = []; }
    if (!selPreset.value && presets.value.length) selectPreset(presets.value[0].id);
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

function selectPreset(id) {
  selPreset.value = id;
  message.value = "";
  testAgainst.value = membersOf(id)[0] || "";
}

// QC-15 (the no-naming-popups rule): "+ New preset" opens the real add form in the pane —
// name is a plain field, Save refuses until it's set. A new preset starts with NO values
// (a run on it sends no tunables — provider defaults — until the user tunes it in the Lab).
const creating = ref(false);
const draft = ref({ name: "" });
const canCreate = computed(() => !!draft.value.name.trim());
function startCreate() { creating.value = true; draft.value = { name: "" }; message.value = ""; }
function cancelCreate() { creating.value = false; }
async function createPreset() {
  if (!canCreate.value) return;
  const before = new Set(presets.value.map((p) => p.id));
  try {
    const r = await request("/v1/ai/engine-presets", { method: "POST", body: { name: draft.value.name.trim() } });
    presets.value = r.presets || [];
    const added = presets.value.find((p) => !before.has(p.id));
    creating.value = false;
    if (added) selectPreset(added.id);
    message.value = "Preset created.";
  } catch (e) { error.value = `Create failed: ${e.message}`; }
}

// QC-15: rename is an inline always-editable name field (no popup) — the selected
// preset's header IS the field; saving happens on blur. The PUT carries the whole row
// so only the name changes (the store overwrites every field from the body).
const nameDraft = ref("");
watch(selected, (p) => { nameDraft.value = p?.name || ""; }, { immediate: true });
async function saveName(p) {
  const name = nameDraft.value.trim();
  if (!p || !name || name === p.name) { nameDraft.value = p?.name || ""; return; }
  const prev = p.name;
  try {
    const r = await request(`/v1/ai/engine-presets/${encodeURIComponent(p.id)}`, {
      method: "PUT", body: { ...p, name },
    });
    presets.value = r.presets || [];
    message.value = "Preset renamed.";
    pushUndo(`rename ${name}`, async () => {
      const rr = await request(`/v1/ai/engine-presets/${encodeURIComponent(p.id)}`, {
        method: "PUT", body: { ...p, name: prev },
      });
      presets.value = rr.presets || [];
    });
  } catch (e) { error.value = `Rename failed: ${e.message}`; }
}

// Delete (user-created only) — its members re-float to the default (the server cascade
// drops the refs on delete); the confirm names the member count.
async function deletePreset(p) {
  if (!p || p.builtIn) return;
  const n = usedBy(p.id);
  const ok = await confirmDialog({
    title: `Delete preset “${p.name}”?`, danger: true,
    message: n
      ? `Its ${n} feature${n === 1 ? "" : "s"} re-float to the default preset.`
      : "No features use it — it's removed.",
  });
  if (!ok) return;
  try {
    const r = await request(`/v1/ai/engine-presets/${encodeURIComponent(p.id)}`, { method: "DELETE" });
    presets.value = r.presets || [];
    assign.value = await request("/v1/ai/preset-assignments");   // refs dropped server-side
    if (selPreset.value === p.id) selectPreset(presets.value[0]?.id || "");
    message.value = "Preset deleted.";
  } catch (e) { error.value = `Delete failed: ${e.message}`; }
}

// Per-preset Reset (built-in only) — restore ONE preset's params + samplers + seeded
// members to factory.
async function resetPreset(p) {
  if (!p?.builtIn) return;
  const ok = await confirmDialog({
    title: `Reset “${p.name}” to defaults?`,
    message: "Restores this preset's name, params, samplers, and seeded member features to their shipped defaults.",
  });
  if (!ok) return;
  try {
    const r = await request(`/v1/ai/engine-presets/${encodeURIComponent(p.id)}/reset`, { method: "POST" });
    presets.value = r.presets || [];
    assign.value = await request("/v1/ai/preset-assignments");   // seeded members return
    nameDraft.value = presets.value.find((x) => x.id === p.id)?.name || "";
    if (!membersOf(selPreset.value).includes(testAgainst.value)) testAgainst.value = membersOf(selPreset.value)[0] || "";
    message.value = "Preset reset to defaults.";
  } catch (e) { error.value = `Reset failed: ${e.message}`; }
}

// Global reset — restore ALL built-in presets + seeded refs + the default (custom
// presets are kept).
async function resetAll() {
  const ok = await confirmDialog({
    title: "Reset all presets to defaults?", danger: true,
    message: "Restores every built-in preset + the seeded feature assignments + the default preset. Your custom presets are kept.",
  });
  if (!ok) return;
  try {
    await request("/v1/ai/engine-presets/reset", { method: "POST" });
    await load();
    message.value = "Reset to defaults.";
  } catch (e) { error.value = `Reset failed: ${e.message}`; }
}

// QC-36 (the page-related-undo law): a page-LOCAL inverse stack for the two mutations
// this surface makes — feature MOVES (ref changes) + preset renames. ⌘Z pops the last
// inverse (the JW host scopes the global book-undo OFF /ai so this handler owns the key
// here). Bounded; `_undoing` guards the re-entrant apply.
const undoStack = ref([]);
const UNDO_LIMIT = 50;
let _undoing = false;
function pushUndo(label, inverse) {
  if (_undoing) return;
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
  const el = document.activeElement;
  if (el && el.matches?.("input, textarea, [contenteditable=true]")) return;
  if (!undoStack.value.length) return;
  e.preventDefault();
  e.stopPropagation();
  undoLast();
}
onMounted(() => window.addEventListener("keydown", onKeyUndo, { capture: true }));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeyUndo, { capture: true }));

// Move / assign a feature's ref (PUT /preset-assignments/feature). The member list
// visibly gains/loses the row (QC-37 — no toast); QC-36 records the inverse.
async function assignFeature(key, presetId, { record = true } = {}) {
  if (!key || !presetId) return;
  const from = currentPresetId(key);   // capture BEFORE the move (for the inverse)
  try {
    assign.value = await request("/v1/ai/preset-assignments/feature", {
      method: "PUT", body: { featureKey: key, presetId },
    });
    if (!membersOf(selPreset.value).includes(testAgainst.value)) testAgainst.value = membersOf(selPreset.value)[0] || "";
    if (record && from !== presetId) {
      pushUndo(`move ${actionLabel(key)} back to ${from ? presetName(from) : "the default"}`,
        () => assignFeature(key, from, { record: false }));
    }
  } catch (e) { error.value = `Reassign failed: ${e.message}`; }
}

// ── the Lab (test the PRESET's params against a member feature). FeatureLab owns the
// engine-preset Save-as / Update / Delete calls (one source for both hosts) + emits the
// refreshed list; we store it. On the Presets page the tested preset IS this page's
// preset, so "Use this preset" is dropped (showUseProduction=false) — Update writes it. ──
function onPresetsChanged(list) {
  presets.value = list || [];
  nameDraft.value = selected.value?.name || "";
}

const navCollapsed = ref(false);

onMounted(load);
</script>

<template>
  <div class="lu-fw">
    <div v-if="error" class="lu-error" style="margin-bottom:10px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else>
      <div class="lu-fw-body" :class="{ 'nav-collapsed': navCollapsed }">
        <!-- Left: the preset list + New + Reset all. -->
        <aside v-show="!navCollapsed" class="lu-fw-list">
          <UiButton intent="primary" size="small" class="lu-tk-new" @click="startCreate">＋ New preset</UiButton>
          <button v-for="p in presets" :key="p.id" type="button" class="lu-fw-card"
            :class="{ 'is-active': p.id === selPreset && !creating }" @click="selectPreset(p.id); creating = false">
            <div class="lu-fw-card-label">{{ p.name }}<UiTag v-if="p.builtIn" class="lu-tk-tag">built-in</UiTag></div>
            <div class="lu-fw-card-model">used by {{ usedBy(p.id) }} feature{{ usedBy(p.id) === 1 ? "" : "s" }}</div>
          </button>
          <div class="lu-tk-aside-foot">
            <UiButton intent="ghost" size="small" class="lu-tk-resetall"
              title="Restore every built-in preset + the seeded feature assignments — your custom presets are kept"
              @click="resetAll">↺ Reset all to defaults</UiButton>
          </div>
        </aside>

        <!-- Create mode (QC-15): the real add form, in the pane — name only, Save disabled
             until named. A new preset starts with NO values (provider defaults until tuned). -->
        <section v-if="creating" class="lu-fw-edit">
          <div class="lu-fw-h"><b>New preset</b><span class="lu-fw-spacer" /></div>
          <div class="lu-tk-sec lu-tk-createform">
            <div class="lu-tk-presetrow">
              <span class="lu-tk-presetrow-k">Name</span>
              <UiInput v-model="draft.name" width="name" class="lu-tk-createname" @keyup.enter="createPreset" />
            </div>
            <div class="lu-tk-createactions">
              <UiButton intent="secondary" size="small" @click="cancelCreate">Cancel</UiButton>
              <UiButton intent="primary" size="small" :disabled="!canCreate" @click="createPreset">Save</UiButton>
            </div>
            <div class="lu-muted lu-tk-createhint">A new preset has no values set — a run on it sends no tunables (provider defaults) until you tune it below.</div>
          </div>
        </section>

        <!-- Right: the selected preset — name + members + test/tune. -->
        <section v-else-if="selected" class="lu-fw-edit">
          <div class="lu-fw-h">
            <UiInput v-model="nameDraft" class="lu-tk-name" width="name"
              title="The preset's name — edit it right here" @blur="saveName(selected)" />
            <UiTag v-if="selected.builtIn" class="lu-tk-tag">built-in</UiTag>
            <UiButton v-if="selected.builtIn" intent="ghost" size="small"
              title="Reset this preset to its shipped defaults (params, samplers, members)"
              @click="resetPreset(selected)">Reset</UiButton>
            <UiButton v-if="!selected.builtIn" intent="ghost" size="small" @click="deletePreset(selected)">Delete</UiButton>
            <span class="lu-fw-spacer" />
            <span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
            <UiButton intent="ghost" size="small"
              v-tooltip.bottom="navCollapsed ? 'Show list' : 'Hide list'"
              :aria-label="navCollapsed ? 'Show list' : 'Hide list'"
              @click="navCollapsed = !navCollapsed"><Icon name="SidebarToggle" :size="14" /></UiButton>
          </div>

          <div class="lu-tk-sec">
            <div class="lu-tk-sec-h"><b>Features using this preset</b><span class="lu-muted">{{ selMembers.length }}</span>
              <span class="lu-tk-sec-spacer" />
              <UiSelect class="lu-tk-add" :model-value="''" :options="assignOptions(selPreset)" width="name"
                @update:model-value="(v) => v && assignFeature(v, selPreset)" />
            </div>
            <div v-if="selMembers.length" class="lu-tk-members">
              <div v-for="k in selMembers" :key="k" class="lu-tk-member">
                <span class="lu-tk-member-name">{{ actionLabel(k) }}</span>
                <UiSelect class="lu-tk-move" :model-value="''" :options="moveOptions(selPreset)" width="token"
                  @update:model-value="(v) => v && assignFeature(k, v)" />
              </div>
            </div>
            <div v-else class="lu-tk-empty lu-muted">No features yet — assign one above to test this preset.</div>
          </div>

          <div class="lu-tk-sec">
            <div class="lu-tk-sec-h"><b>Test &amp; tune</b><span class="lu-muted">the one params editor — Update writes THIS preset</span>
              <span class="lu-tk-sec-spacer" />
              <span v-if="selMembers.length" class="lu-tk-testrow">
                <span class="lu-tk-presetrow-k">Test against</span>
                <UiSelect :model-value="testAgainst" :options="memberOptions" width="name"
                  @update:model-value="(v) => testAgainst = v" />
              </span>
            </div>
            <FeatureLab v-if="testPrompt" :key="selPreset + '|' + testAgainst"
              :action="testAgainst" :prompt="testPrompt" :providers="providers" :presets="presets"
              :sampler-catalog-list="samplerCatalogList"
              :production-preset-id="selPreset" assign-label="preset" :show-use-production="false"
              @presets-changed="onPresetsChanged" />
            <div v-else class="lu-tk-empty lu-muted">Assign a feature to this preset to test + tune its params.</div>
          </div>
        </section>
        <div v-else class="lu-muted" style="padding:20px">Create or pick a preset on the left.</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lu-tk-new { width: 100%; justify-content: center; margin-bottom: 4px; }
.lu-tk-tag { margin-left: 6px; }
.lu-tk-aside-foot { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); display: flex; }
/* The inline name field is the pane's title — it reads like a heading but is directly
   editable (QC-15: no rename popup). */
.lu-tk-name :deep(input) { font-weight: 700; }
.lu-tk-createactions { display: flex; gap: 8px; }
.lu-tk-createhint { font-size: 11.5px; }
.lu-tk-createform { gap: 12px; }
.lu-tk-sec { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
.lu-tk-sec-h { display: flex; align-items: center; gap: 10px; } .lu-tk-sec-h b { font-size: 13px; color: var(--ink); } .lu-tk-sec-h .lu-muted { font-size: 11.5px; }
.lu-tk-sec-spacer { flex: 1; }
.lu-tk-members { display: flex; flex-direction: column; gap: 6px; }
.lu-tk-member { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.lu-tk-member-name { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--ink); }
.lu-tk-empty { font-size: 12px; padding: 8px 0; font-style: italic; }
.lu-tk-presetrow, .lu-tk-testrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lu-tk-presetrow-k { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
</style>
