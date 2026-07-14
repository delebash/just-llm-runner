<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Feature Workbench — per the lab+preset + taskKind-routing model. The unit is the
// ACTION; "feature" (writerAI, critique, …) is the visual group its actions live under.
// The LEFT list groups actions by their nav `group` (display-only) and, per action,
// shows the engine preset it resolves to (with provenance). The RIGHT pane is the
// action's LLM TASK (a dropdown to reassign it) + the shared <FeatureLab> (test + tune +
// Save-as-preset). The model + switches + params live in the preset (built in the Lab).
//   • Routing keys on the LLM-work taskKind, NOT the nav group; the cascade is 3-tier
//     (restored 2026-07-14) — this feature's OWN preset override → the action's TASK
//     preset → the global default. Here you can (a) reassign a feature's task, (b) give
//     THIS feature its own preset override (the fine-grain control), or (c) via the Lab's
//     "Use for this task", set the whole TASK's preset (every feature in it). Creating +
//     TESTING a task and its preset also lives on the Tasks page.
//
// Endpoints: prompts /v1/ai/prompts; the task→preset assignments + provenance
// /v1/ai/preset-assignments; the feature→task map + reassignment /v1/ai/task-kinds;
// the engine-preset library /v1/ai/engine-presets; the knob catalog /v1/ai/knob-catalog.
import { computed, onMounted, ref } from "vue";

import FeatureLab from "../components/FeatureLab.vue";
import Icon from "../common/components/Icon.vue";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import { request } from "../client.js";
import { taskLabel } from "../common/taskLabels.js";

const props = defineProps({
  // Optional host runner (streaming) — forwarded to the Lab test panel when present.
  runStream: { type: Function, default: null },
});

const prompts = ref([]);     // all action prompts {key, feature, system, userTemplate, …}
const routing = ref(null);   // {default, features:[…], pins:{key→{providerId,model}}}
const providers = ref([]);
const enginePresets = ref([]);   // EnginePresetRow[]
// The assignment maps: `.taskKinds` (task→preset, edited on the Tasks page) +
// `.features` (action→preset, the per-feature override, restored 2026-07-14) +
// `.defaultPresetId` (the global default) — the 3-tier provenance source.
const presetAssign = ref({ defaultPresetId: "", taskKinds: {}, features: {} });
const taskKinds = ref([]);        // task catalog [{id,label,description}] — the reassign dropdown
const featureTaskKinds = ref({}); // action key → its resolved task (provenance + the dropdown)
const knobCatalog = ref([]);      // knob_catalog metadata (C1)
// Plane-2 samplers as ORDERED raw catalog rows (common-first) → FeatureLab's
// prefilled <KnobGrid> checklist. The raw rows carry `kind` + `default`. (Launch
// switches live on the MODEL — Tune & measure, §7.1 — not in the Lab.)
const samplerCatalogList = computed(() => knobCatalog.value.filter((k) => k.plane === 2));
const loading = ref(true);
const error = ref("");
const message = ref("");

const selAction = ref("");   // selected ACTION key

const featMeta = computed(() => Object.fromEntries((routing.value?.features || []).map((f) => [f.key, f])));

// Nav model: GROUP → features → (sub-labels) → action cards, each level indented under
// its header (the `group` is display-only, not a routing key). A group whose actions ALL
// come from ONE multi-action feature is "merged" — no redundant feature sub-header.
const GROUP_FALLBACK = "Other";
const navGroups = computed(() => {
  const order = [];
  const byGroup = {};
  for (const f of routing.value?.features || []) {
    const actions = prompts.value.filter((p) => p.feature === f.key);
    if (!actions.length) continue;
    const grp = f.group || GROUP_FALLBACK;
    if (!(grp in byGroup)) { byGroup[grp] = []; order.push(grp); }
    byGroup[grp].push({ key: f.key, label: f.label, actions });
  }
  const known = new Set((routing.value?.features || []).map((f) => f.key));
  for (const p of prompts.value) {
    if (known.has(p.feature)) continue;
    if (!(GROUP_FALLBACK in byGroup)) { byGroup[GROUP_FALLBACK] = []; order.push(GROUP_FALLBACK); }
    let g = byGroup[GROUP_FALLBACK].find((x) => x.key === p.feature);
    if (!g) { g = { key: p.feature, label: p.feature, actions: [] }; byGroup[GROUP_FALLBACK].push(g); }
    g.actions.push(p);
  }
  return order.map((c) => {
    const features = byGroup[c];
    const merged = features.length === 1 && features[0].actions.length > 1 ? features[0] : null;
    return { label: c, features, merged };
  });
});

// Flat render list for the nav: one row per header / sub-label / card, each with an
// `indent` level so children sit visibly under their header.
const navRows = computed(() => {
  const rows = [];
  const pushActions = (f, base) => {
    for (const sg of subGroups(f.actions)) {
      if (sg.label) rows.push({ type: "sub", label: sg.label, indent: base });
      for (const a of sg.items) rows.push({ type: "card", action: a, indent: base });
    }
  };
  for (const grp of navGroups.value) {
    rows.push({ type: "group", label: grp.label });
    for (const f of grp.features) {
      if (grp.merged) pushActions(f, 1);
      else if (f.actions.length > 1) { rows.push({ type: "ghead", label: f.label, indent: 1 }); pushActions(f, 1); }
      else rows.push({ type: "card", action: f.actions[0], indent: 1 });
    }
  }
  return rows;
});
function ml(level) { return level ? { marginLeft: `${level * 18}px` } : {}; }

const action = computed(() => prompts.value.find((p) => p.key === selAction.value) || null);

// The action's display name: the seeded canonical label; else the feature's catalog
// label for a single-action feature; else a readable name derived from the key.
function actionLabel(p) {
  if (p.label) return p.label;
  const f = p.feature;
  if (p.key === f) return featMeta.value[f]?.label || f;
  let s = p.key;
  if (s.startsWith(`${f}.`)) s = s.slice(f.length + 1);
  else if (s.startsWith(f)) s = s.slice(f.length);
  s = s.replace(/[._-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : p.key;
}
function actionDesc(a) {
  return a?.description || featMeta.value[a?.feature]?.hint || "";
}
// Split a feature's actions into sub-sections by their `group`.
function subGroups(actions) {
  const order = [];
  const map = {};
  for (const a of actions) {
    const g = a.group || "";
    if (!(g in map)) { map[g] = []; order.push(g); }
    map[g].push(a);
  }
  return order.map((g) => ({ label: g, items: map[g] }));
}

// Routing pin — a read-only seed for the Lab column's model. Per-feature model choices
// now persist via presets (Use for this task), not the pin. Keyed by feature/action key.
function pin(key) { return routing.value?.pins?.[key] || null; }

async function load() {
  loading.value = true; error.value = "";
  try {
    const [p, r, pl] = await Promise.all([
      request("/v1/ai/prompts"), request("/v1/ai/routing"), request("/v1/llm-providers"),
    ]);
    prompts.value = p.prompts || [];
    routing.value = r;
    if (!routing.value.pins) routing.value.pins = {};
    providers.value = pl.providers || [];
    try { knobCatalog.value = (await request("/v1/ai/knob-catalog")).knobs || []; }
    catch { knobCatalog.value = []; }
    try { enginePresets.value = (await request("/v1/ai/engine-presets")).presets || []; }
    catch { enginePresets.value = []; }
    try { presetAssign.value = await request("/v1/ai/preset-assignments"); }
    catch { presetAssign.value = { defaultPresetId: "", taskKinds: {}, features: {} }; }
    try {
      const tk = await request("/v1/ai/task-kinds");
      taskKinds.value = tk.taskKinds || [];
      featureTaskKinds.value = tk.featureTaskKinds || {};
    } catch { taskKinds.value = []; featureTaskKinds.value = {}; }
    const firstCard = navRows.value.find((rw) => rw.type === "card");
    if (!action.value && firstCard) selectAction(firstCard.action.key);
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

function selectAction(key) {
  selAction.value = key;
  message.value = "";
}

// FeatureLab owns the Save-as / Delete engine-preset calls (one source for both hosts)
// and emits the refreshed list; we just store it.
function onPresetsChanged(list) { enginePresets.value = list || []; }

// ── provenance (3-tier: this feature's OWN override → its task preset → the global
// default; the override tier restored 2026-07-14) ──
const presetName = (id) => enginePresets.value.find((p) => p.id === id)?.name || "—";
// A per-feature override id counts only if its preset still EXISTS — a dangling
// override (the preset was deleted) falls through to the task tier, mirroring the
// server resolver (preset_resolve._resolve_with_source).
function overridePid(key) {
  const id = presetAssign.value.features?.[key];
  return id && enginePresets.value.some((p) => p.id === id) ? id : "";
}
function hasOverride(key) { return !!overridePid(key); }
// What a feature actually resolves to, with provenance. #48: the seeded preset names now
// align 1:1 with their task labels (2026-07-14 — e.g. the "Judgment & scoring" preset on
// the "Judgment & scoring" task), so "<preset> · <task>" would read as the same name
// twice; when they normalize equal, show it once. Each tier's id is existence-checked so
// a dangling preset falls through to the next tier, mirroring the server resolver.
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const presetExists = (id) => !!id && enginePresets.value.some((p) => p.id === id);
function featurePresetLabel(key) {
  const ovr = overridePid(key);
  if (ovr) return `${presetName(ovr)} · this feature`;
  const tk = featureTaskKinds.value?.[key];
  const tkPid = tk ? presetAssign.value.taskKinds?.[tk] : "";
  if (presetExists(tkPid)) {
    const pn = presetName(tkPid);
    const tl = taskLabel(tk, taskKinds.value);
    return normName(pn) === normName(tl) ? pn : `${pn} · ${tl}`;
  }
  const did = presetAssign.value.defaultPresetId;
  if (presetExists(did)) return `${presetName(did)} · default`;
  return "— none —";
}
// The per-feature preset OVERRIDE control (the fine-grain tier) — give THIS feature its
// own preset, or inherit from its task. Distinct from the Lab's "Use for this task",
// which sets the WHOLE task's preset (every feature in it).
const featurePresetOptions = computed(() => {
  const tk = featureTaskKinds.value?.[selAction.value];
  const inherit = tk ? `— inherit from task (${taskLabel(tk, taskKinds.value)}) —` : "— inherit from task —";
  return [{ value: "", label: inherit }, ...enginePresets.value.map((p) => ({ value: p.id, label: p.name }))];
});
async function setFeaturePreset(key, presetId) {
  if (!key) return;
  try {
    presetAssign.value = await request("/v1/ai/preset-assignments/feature", {
      method: "PUT", body: { featureKey: key, presetId },
    });
    message.value = presetId
      ? "This feature now runs its own preset (override)."
      : "Override cleared — this feature follows its task’s preset again.";
  } catch (e) { error.value = `Preset change failed: ${e.message}`; }
}
// The preset the selected feature resolves to (its task's, else the global default) —
// seeds the Lab column; changed via "Use for this task" (below) or on the Tasks page.
const selTaskPreset = computed(() => {
  const tk = featureTaskKinds.value?.[selAction.value];
  return (tk ? presetAssign.value.taskKinds?.[tk] : "") || presetAssign.value.defaultPresetId || "";
});
// The Lab's "Use for this task" assigns the chosen preset to the feature's TASK (every
// feature in it runs it) — the task-wide tier, distinct from the per-feature override
// above. The same task preset can also be set on the Tasks page.
async function onUseProduction(presetId) {
  const tk = featureTaskKinds.value?.[selAction.value];
  if (!tk) { error.value = "This feature has no task to assign a preset to."; return; }
  try {
    presetAssign.value = await request("/v1/ai/preset-assignments/task-kind", {
      method: "PUT", body: { taskKind: tk, presetId },
    });
    message.value = `Set for task “${taskLabel(tk, taskKinds.value)}” — every feature in it runs that preset now.`;
  } catch (e) { error.value = `Assign failed: ${e.message}`; }
}

// ── the action's LLM TASK — reassign from the feature side (the Tasks page is the
// other side). Every feature always has a task, so this is reassignment, not "none". ──
const taskOptions = computed(() => taskKinds.value.map((t) => ({ value: t.id, label: t.label })));
function featureTask(key) { return featureTaskKinds.value?.[key] || ""; }
async function setFeatureTask(key, taskKind) {
  if (!key || !taskKind || taskKind === featureTask(key)) return;
  try {
    const tk = await request("/v1/ai/task-kinds/feature", { method: "PUT", body: { featureKey: key, taskKind } });
    taskKinds.value = tk.taskKinds || taskKinds.value;
    featureTaskKinds.value = tk.featureTaskKinds || {};
    message.value = `Moved to task “${taskLabel(taskKind, taskKinds.value)}”.`;
  } catch (e) { error.value = `Task change failed: ${e.message}`; }
}
// Reset THIS feature to its factory routing: clear its per-feature preset override AND
// re-float its task to the seeded default (so it inherits that task's preset again).
async function resetFeature(key) {
  if (!key) return;
  try {
    // clear the per-feature preset override (returns the refreshed assignments)...
    presetAssign.value = await request("/v1/ai/preset-assignments/feature", {
      method: "PUT", body: { featureKey: key, presetId: "" },
    });
    // ...then re-float the feature to its seeded task.
    const tk = await request("/v1/ai/task-kinds/feature", { method: "PUT", body: { featureKey: key, taskKind: "" } });
    taskKinds.value = tk.taskKinds || taskKinds.value;
    featureTaskKinds.value = tk.featureTaskKinds || {};
    message.value = "Reset to defaults.";
  } catch (e) { error.value = `Reset failed: ${e.message}`; }
}

// The left list can be collapsed to give the Lab full width.
const navCollapsed = ref(false);

onMounted(load);
</script>

<template>
  <div class="lu-fw">
    <div v-if="error" class="lu-error" style="margin-bottom:10px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else-if="routing">
      <div class="lu-fw-body" :class="{ 'nav-collapsed': navCollapsed }">
        <!-- Left list: features grouped by their nav `group`. -->
        <aside v-show="!navCollapsed" class="lu-fw-list">
          <template v-for="(row, i) in navRows" :key="i">
            <div v-if="row.type === 'group'" class="lu-fw-cat">
              <div class="lu-fw-cat-name">{{ row.label }}</div>
            </div>
            <div v-else-if="row.type === 'ghead'" class="lu-fw-ghead" :style="ml(row.indent)">
              <div class="lu-fw-gname">{{ row.label }}</div>
            </div>
            <div v-else-if="row.type === 'sub'" class="lu-fw-sublabel" :style="ml(row.indent)">{{ row.label }}</div>
            <button v-else type="button" class="lu-fw-card" :style="ml(row.indent)"
              :class="{ 'is-active': row.action.key === selAction }" @click="selectAction(row.action.key)">
              <div class="lu-fw-card-label">{{ actionLabel(row.action) }}<span v-if="hasOverride(row.action.key)" class="lu-fw-dot" title="has its own per-feature preset override" /></div>
              <div v-if="actionDesc(row.action)" class="lu-fw-card-desc">{{ actionDesc(row.action) }}</div>
              <div class="lu-fw-card-model" title="engine preset for this feature">→ {{ featurePresetLabel(row.action.key) }}</div>
            </button>
          </template>
        </aside>

        <!-- Editor for the selected action: its LLM task + the shared Lab. -->
        <section v-if="action" class="lu-fw-edit">
          <div class="lu-fw-h">
            <b>{{ actionLabel(action) }}</b>
            <span v-if="taskOptions.length" class="lu-fw-task">
              <span class="lu-fw-task-k">Task</span>
              <UiSelect :model-value="featureTask(selAction)" :options="taskOptions" width="name"
                @update:model-value="(v) => setFeatureTask(selAction, v)" />
              <UiButton intent="ghost" size="small" title="Reset this feature to its default task + preset"
                @click="resetFeature(selAction)">↺</UiButton>
            </span>
            <span class="lu-fw-spacer" />
            <span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
            <UiButton intent="ghost" size="small"
              v-tooltip.bottom="navCollapsed ? 'Show list' : 'Hide list'"
              :aria-label="navCollapsed ? 'Show list' : 'Hide list'"
              @click="navCollapsed = !navCollapsed"><Icon name="SidebarToggle" :size="14" /></UiButton>
          </div>
          <div class="lu-fw-runs">
            <span class="lu-fw-task-k">Preset</span>
            <UiSelect :model-value="overridePid(selAction)" :options="featurePresetOptions" width="name"
              @update:model-value="(v) => setFeaturePreset(selAction, v)" />
            <UiButton v-if="overridePid(selAction)" intent="ghost" size="small"
              title="Clear this feature's override — follow its task's preset again"
              @click="setFeaturePreset(selAction, '')">↺</UiButton>
            <span class="lu-muted lu-fw-runs-note">Runs: {{ featurePresetLabel(selAction) }}</span>
          </div>
          <div class="lu-muted lu-fw-grainhint">
            Sets the preset for <b>this feature only</b>. To change every feature in the task at once,
            use “Use for this task” in the Lab below.
          </div>

          <FeatureLab :action="selAction" :prompt="action" :providers="providers" :presets="enginePresets"
            :sampler-catalog-list="samplerCatalogList" :task-kind="featureTaskKinds[selAction] || ''"
            :production-preset-id="selTaskPreset" :pin="pin(selAction)"
            @use-production="onUseProduction" @presets-changed="onPresetsChanged" />
        </section>
        <div v-else class="lu-muted" style="padding:20px">Pick an action on the left.</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
select.lu-input { cursor: pointer; appearance: auto; }
/* Nav sub-headers (FW's left list only; the shared shell classes live in styles.css). */
.lu-fw-ghead { display: flex; flex-direction: column; gap: 6px; padding: 4px 0 2px; }
.lu-fw-gname { font-size: 12px; font-weight: 700; color: var(--ink-2); }
.lu-fw-sublabel { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 6px 0 1px; }
/* The per-action LLM-task reassign control in the editor header. */
.lu-fw-task { display: inline-flex; align-items: center; gap: 6px; }
.lu-fw-task-k { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
/* The per-feature preset OVERRIDE row + its resolved-provenance note + the grain hint. */
.lu-fw-runs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-fw-runs-note { font-size: 11.5px; }
.lu-fw-grainhint { font-size: 11px; margin: 2px 0 4px; }
</style>
