<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Feature Workbench — "Routing by feature". The unit is the ACTION; "feature"
// (writerAI, critique, …) is the visual group its actions live under. The LEFT list
// groups actions by their nav `group` (display-only) and, per action, shows the engine
// preset it resolves to. The RIGHT pane is the action's PRESET control (a dropdown that
// assigns the action's preset, or clears to the global default) + the shared
// <FeatureLab> (test + tune + Save-as-preset). The model + switches + params live in
// the preset (built in the Lab).
//   • Routing is ONE source now (2026-07-15): a feature points at a preset (its ref)
//     then the global default. The task tier is gone. Here you assign THIS feature's
//     preset; the Presets page owns creating/testing presets + their member lists.
//
// Endpoints: prompts /v1/ai/prompts; the per-action refs + default
// /v1/ai/preset-assignments (+ PUT /preset-assignments/feature); the engine-preset
// library /v1/ai/engine-presets; the feature catalog (nav) /v1/ai/routing; the knob
// catalog /v1/ai/knob-catalog.
import { computed, onMounted, ref } from "vue";

import FeatureLab from "../components/FeatureLab.vue";
import Icon from "../common/components/Icon.vue";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import { request } from "../client.js";

const props = defineProps({
  runStream: { type: Function, default: null },
});

const prompts = ref([]);
const routing = ref(null);
const providers = ref([]);
const enginePresets = ref([]);
const presetAssign = ref({ defaultPresetId: "", features: {} });
const knobCatalog = ref([]);
const samplerCatalogList = computed(() => knobCatalog.value.filter((k) => k.plane === 2));
const loading = ref(true);
const error = ref("");
const message = ref("");

const selAction = ref("");

const featMeta = computed(() => Object.fromEntries((routing.value?.features || []).map((f) => [f.key, f])));

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

async function load() {
  loading.value = true; error.value = "";
  try {
    const [p, r, pl] = await Promise.all([
      request("/v1/ai/prompts"), request("/v1/ai/routing"), request("/v1/llm-providers"),
    ]);
    prompts.value = p.prompts || [];
    routing.value = r;
    providers.value = pl.providers || [];
    try { knobCatalog.value = (await request("/v1/ai/knob-catalog")).knobs || []; }
    catch { knobCatalog.value = []; }
    try { enginePresets.value = (await request("/v1/ai/engine-presets")).presets || []; }
    catch { enginePresets.value = []; }
    try { presetAssign.value = await request("/v1/ai/preset-assignments"); }
    catch { presetAssign.value = { defaultPresetId: "", features: {} }; }
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

// FeatureLab owns the Save-as / Delete engine-preset calls (one source for both hosts).
function onPresetsChanged(list) { enginePresets.value = list || []; }

// resolution (2026-07-15, one source): the action's ref then the global default.
const presetName = (id) => enginePresets.value.find((p) => p.id === id)?.name || "—";
const presetExists = (id) => !!id && enginePresets.value.some((p) => p.id === id);
function refPid(key) {
  const id = presetAssign.value.features?.[key];
  return presetExists(id) ? id : "";
}
const defaultName = computed(() => presetName(presetAssign.value.defaultPresetId));

function featurePresetLabel(key) {
  const pid = refPid(key);
  if (pid) return `${presetName(pid)} · assigned`;
  const did = presetAssign.value.defaultPresetId;
  if (presetExists(did)) return `${presetName(did)} · default`;
  return "— none —";
}

const featurePresetOptions = computed(() => [
  { value: "", label: `— default preset (${defaultName.value}) —` },
  ...enginePresets.value.map((p) => ({ value: p.id, label: p.name })),
]);
function featurePresetValue(key) { return refPid(key); }
async function setFeaturePreset(key, presetId) {
  if (!key) return;
  try {
    presetAssign.value = await request("/v1/ai/preset-assignments/feature", {
      method: "PUT", body: { featureKey: key, presetId },
    });
    message.value = presetId
      ? "This feature now runs that preset."
      : "Cleared — this feature runs the default preset.";
  } catch (e) { error.value = `Preset change failed: ${e.message}`; }
}

const selResolvedPreset = computed(() => refPid(selAction.value) || presetAssign.value.defaultPresetId || "");
async function onUseProduction(presetId) {
  await setFeaturePreset(selAction.value, presetId);
}

const navCollapsed = ref(false);

onMounted(load);
</script>

<template>
  <div class="lu-fw">
    <div v-if="error" class="lu-error" style="margin-bottom:10px">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <template v-else-if="routing">
      <div class="lu-fw-body" :class="{ 'nav-collapsed': navCollapsed }">
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
              <div class="lu-fw-card-label">{{ actionLabel(row.action) }}</div>
              <div v-if="actionDesc(row.action)" class="lu-fw-card-desc">{{ actionDesc(row.action) }}</div>
              <div class="lu-fw-card-model" title="engine preset for this feature">→ {{ featurePresetLabel(row.action.key) }}</div>
            </button>
          </template>
        </aside>

        <section v-if="action" class="lu-fw-edit">
          <div class="lu-fw-h">
            <b>{{ actionLabel(action) }}</b>
            <span class="lu-fw-spacer" />
            <span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
            <UiButton intent="ghost" size="small"
              v-tooltip.bottom="navCollapsed ? 'Show list' : 'Hide list'"
              :aria-label="navCollapsed ? 'Show list' : 'Hide list'"
              @click="navCollapsed = !navCollapsed"><Icon name="SidebarToggle" :size="14" /></UiButton>
          </div>
          <div class="lu-fw-runs">
            <span class="lu-fw-task-k">Preset</span>
            <UiSelect :model-value="featurePresetValue(selAction)" :options="featurePresetOptions" width="name"
              @update:model-value="(v) => setFeaturePreset(selAction, v)" />
            <UiButton v-if="featurePresetValue(selAction)" intent="ghost" size="small"
              title="Clear — this feature runs the default preset"
              @click="setFeaturePreset(selAction, '')">↺</UiButton>
            <span class="lu-muted lu-fw-runs-note">Runs: {{ featurePresetLabel(selAction) }}</span>
          </div>
          <div class="lu-muted lu-fw-grainhint">
            Sets the preset for <b>this feature only</b>. Create + test presets (and their
            member lists) on the <b>Presets</b> page.
          </div>

          <FeatureLab :action="selAction" :prompt="action" :providers="providers" :presets="enginePresets"
            :sampler-catalog-list="samplerCatalogList"
            :production-preset-id="selResolvedPreset" assign-label="feature"
            @use-production="onUseProduction" @presets-changed="onPresetsChanged" />
        </section>
        <div v-else class="lu-muted" style="padding:20px">Pick an action on the left.</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
select.lu-input { cursor: pointer; appearance: auto; }
.lu-fw-ghead { display: flex; flex-direction: column; gap: 6px; padding: 4px 0 2px; }
.lu-fw-gname { font-size: 12px; font-weight: 700; color: var(--ink-2); }
.lu-fw-sublabel { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 6px 0 1px; }
.lu-fw-task-k { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.lu-fw-runs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-fw-runs-note { font-size: 11.5px; }
.lu-fw-grainhint { font-size: 11px; margin: 2px 0 4px; }
</style>
