<script setup>
// SPDX-License-Identifier: MIT
// Feature Workbench — "Routing by feature". The unit is the ACTION; "feature"
// (writerAI, critique, …) is the visual group its actions live under. The LEFT list
// groups actions by their nav `group` (display-only) and, per action, shows the engine
// preset it resolves to. The RIGHT pane is the action's PRESET control (a dropdown that
// assigns the action's preset, or clears to the global default) + the shared
// <FeatureLab> (test + tune + Save-as-preset). The model + switches + params live in
// the preset (built in the Lab).
//   • Routing is ONE source (2026-07-15): a feature points at a preset (its ref),
//     else the global default. The task tier is gone; so is the separate Presets page
//     (the user's 2026-07-15 verdict — it recreated the task page). THE one preset
//     control is the Lab bar below: load a preset → "Use in production" assigns it
//     (the original 1302f88 control, restored); Save-as/Update/🗑 manage the library.
//
// Endpoints: prompts /v1/ai/prompts; the per-action refs + default
// /v1/ai/preset-assignments (+ PUT /preset-assignments/feature); the engine-preset
// library /v1/ai/engine-presets; the feature catalog (nav) /v1/ai/routing; the knob
// catalog /v1/ai/knob-catalog.
import { computed, onMounted, ref, watch } from "vue";

import FeatureLab from "../components/FeatureLab.vue";
import Icon from "../common/components/Icon.vue";
import UiButton from "../common/components/UiButton.vue";
import { request } from "../client.js";
import { confirmDialog } from "../common/services/dialog.js";
import { featurePanelFor, featurePanelMetaFor, pieceFor } from "../services/labAdapters.js";
import { pushToast } from "../common/services/toastBridge.js";

const props = defineProps({
  runStream: { type: Function, default: null },
  // The app's doors to its prompt-feeding data, rendered by the promptless Lab
  // (Option-A seam, ruling 2026-08-04). [{label, href}].
  dataLinks: { type: Array, default: () => [] },
  // Deep-link focus (parity batch 2026-08-06 — JV's retired #speakerlab lands
  // on its attribution action): an action key (or feature key) to select on
  // first load instead of the first card. Unknown → the normal default.
  initialAction: { type: String, default: "" },
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
const selFeature = ref(""); // a promptless feature's routing-only selection

// A kept-alive host re-consumes an action deep link by updating the prop (the
// load-time read below fires once per session — JV's #speakerlab redirect,
// 2026-08-06). Static hosts never trigger it; an unknown key is ignored.
watch(() => props.initialAction, (a) => {
  if (!a) return;
  if (prompts.value.some((p) => p.key === a)) selectAction(a);
  else if ((routing.value?.features || []).some((f) => f.key === a)) selectFeature(a);
});

const featMeta = computed(() => Object.fromEntries((routing.value?.features || []).map((f) => [f.key, f])));

const GROUP_FALLBACK = "Other";
const navGroups = computed(() => {
  const order = [];
  const byGroup = {};
  for (const f of routing.value?.features || []) {
    const actions = prompts.value.filter((p) => p.feature === f.key);
    // A feature with NO prompt rows still ROUTES (feature -> engine preset). Apps
    // that build their own prompts (i18n: feature_prompts={} because shielding owns
    // the request body) register features with zero actions - dropping them here
    // rendered "Routing by feature" EMPTY for the whole app (found live 2026-08-03).
    // They stay, and select a routing-only pane instead of a FeatureLab.
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
      else if (f.actions.length > 1) {
        // A feature whose rows include PIECES (approved 2026-08-06) is ONE
        // thing with parts: its own routable card leads (click → the routing
        // pane, one chooser for every piece), the rows follow under it. A
        // features-without-pieces group keeps the plain heading — JW's list
        // renders exactly as before (no app registers pieces there).
        if (f.actions.some((a) => pieceFor(a.key))) {
          rows.push({ type: "feature", featureKey: f.key, label: f.label, indent: 1 });
        } else {
          rows.push({ type: "ghead", label: f.label, indent: 1 });
          // A LABELED feature panel (the attribution restore's "Auto" row)
          // adds one selectable row right under the plain heading; nothing
          // registered → nothing rendered (JW pixel-identical).
          if (featurePanelMetaFor(f.key)?.label) {
            rows.push({ type: "panelrow", featureKey: f.key, indent: 1 });
          }
        }
        pushActions(f, 1);
      }
      else if (f.actions.length === 1) rows.push({ type: "card", action: f.actions[0], indent: 1 });
      else rows.push({ type: "feature", featureKey: f.key, label: f.label, indent: 1 });
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
    // Deep-link focus first; else the first card.
    if (!action.value && props.initialAction) {
      if (prompts.value.some((p) => p.key === props.initialAction)) {
        selectAction(props.initialAction);
      } else if ((routing.value?.features || []).some((f) => f.key === props.initialAction)) {
        selectFeature(props.initialAction);
      }
    }
    const firstCard = navRows.value.find((rw) => rw.type === "card");
    if (!action.value && !selFeature.value && firstCard) selectAction(firstCard.action.key);
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

function selectFeature(key) {
  selFeature.value = key;
  selAction.value = "";
}
function selectAction(key) {
  selFeature.value = "";
  selAction.value = key;
  message.value = "";
}

// FeatureLab owns the Save-as / Delete engine-preset calls (one source for both hosts).
function onPresetsChanged(list) { enginePresets.value = list || []; }
// The Lab persisted a savable per-action setting (the JSON-output toggle). Refresh our
// cached prompt row IN PLACE — not an array replace — so FeatureLab's shallow props.prompt
// watch doesn't re-fire (a re-fire re-seeds its draft and wipes the user's test inputs),
// while a remount on the next action-switch still reads the fresh value.
function onPromptChanged({ key, jsonMode }) {
  const row = prompts.value.find((p) => p.key === key);
  if (row) row.jsonMode = !!jsonMode;
}

// resolution (2026-07-15, one source; the FEATURE layer joined 2026-08-06 —
// the pieces rework): the action's ref → its feature's ref → the global
// default. Mirrors the server cascade (preset_resolve.py) exactly.
const presetName = (id) => enginePresets.value.find((p) => p.id === id)?.name || "—";
const presetExists = (id) => !!id && enginePresets.value.some((p) => p.id === id);
function refPid(key) {
  const id = presetAssign.value.features?.[key];
  return presetExists(id) ? id : "";
}
function featureOfAction(key) {
  return prompts.value.find((p) => p.key === key)?.feature || "";
}
function featurePresetLabel(key) {
  const pid = refPid(key);
  if (pid) return `${presetName(pid)} · assigned`;
  const fk = featureOfAction(key);
  const fpid = fk && fk !== key ? refPid(fk) : "";
  if (fpid) return `${presetName(fpid)} · assigned`;
  const did = presetAssign.value.defaultPresetId;
  if (presetExists(did)) return `${presetName(did)} · default`;
  return "— none —";
}

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

// ↺ Reset (relocated from the deleted Presets page): restore the built-in presets +
// every feature assignment + the default to the shipped seeds. Custom presets survive.
async function resetPresets() {
  const ok = await confirmDialog({
    title: "Reset presets to defaults?", danger: true,
    message: "Restores the built-in presets and every feature assignment to the shipped defaults. Your custom presets are kept.",
  });
  if (!ok) return;
  try {
    await request("/v1/ai/engine-presets/reset", { method: "POST" });
    await load();
    message.value = "Presets reset to defaults.";
  } catch (e) { error.value = `Reset failed: ${e.message}`; }
}

const selResolvedPreset = computed(() =>
  refPid(selAction.value)
  || refPid(featureOfAction(selAction.value))
  || presetAssign.value.defaultPresetId
  || "");
async function onUseProduction(presetId) {
  // A PIECE can't carry its own production assignment — "use in production"
  // from a piece's Lab writes THE FEATURE's ref (the one chooser its whole
  // family follows). Normal actions write their own ref, unchanged.
  const key = pieceFor(selAction.value)
    ? (featureOfAction(selAction.value) || selAction.value)
    : selAction.value;
  await setFeaturePreset(key, presetId);
}

// ── Promptless features: the app's pipeline owns the prompt (2026-08-04) ──
// The Lab shows the REAL generated prompt from the app's /v1/ai/prompt-preview
// (the family contract) so tuning runs what production runs. An app or feature
// without a preview fails LOUD into the assignment-only fallback — routing still
// picks the engine preset; nothing renders blank.
const builtPrompt = ref(null);   // {system, user} from the app's builder
const builtMeta = ref("");       // names the sample ("6 pending key(s) · es")
const previewErr = ref("");
const previewLoading = ref(false);
const selFeatureResolved = computed(() => refPid(selFeature.value) || presetAssign.value.defaultPresetId || "");
async function loadPreview(key) {
  builtPrompt.value = null;
  builtMeta.value = "";
  previewErr.value = "";
  if (!key) return;
  previewLoading.value = true;
  try {
    const r = await request("/v1/ai/prompt-preview", { method: "POST", body: { feature: key } });
    builtPrompt.value = { system: r.system || "", user: r.user || "" };
    // Stamp WHEN this sample was built (absolute time on purpose: a relative
    // "2 min ago" goes stale without a ticker — the clock stays true).
    const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    builtMeta.value = r.sample ? `${r.sample} · built ${at}` : "";
  } catch (e) {
    previewErr.value = e?.message || "The app's prompt preview is unavailable.";
  } finally {
    previewLoading.value = false;
  }
}
// A feature that HAS prompt rows and is selected as a card (a pieces parent —
// approved 2026-08-06) is not promptless: its texts are its rows below, so
// there is no app-built preview to fetch. Its pane is the routing home (one
// chooser for every piece) + the app's feature panel when one is registered.
const selFeatureHasRows = computed(() =>
  !!selFeature.value && prompts.value.some((p) => p.feature === selFeature.value));
// The attribution restore (2026-08-06): a feature whose panel is registered
// WITH a label gets a nav row, and selecting it shows ONLY the panel — its
// actions carry their own routing, so the one-chooser pane would lie there.
// Pieces parents (cleanup) keep the routing-home pane.
const selPanelMeta = computed(() => featurePanelMetaFor(selFeature.value));
const selIsPiecesParent = computed(() =>
  !!selFeature.value && prompts.value.some((p) => p.feature === selFeature.value && pieceFor(p.key)));
const selPanelPane = computed(() =>
  selFeatureHasRows.value && !selIsPiecesParent.value && !!selPanelMeta.value?.label);
const selFeatureTitle = computed(() =>
  selPanelPane.value ? selPanelMeta.value.label : (featMeta.value[selFeature.value]?.label || selFeature.value));
// A pieces parent may ALSO serve a preview (JV's dictation cleanup, task #22
// 2026-08-06): its pane then carries the full Lab over the REAL composed call.
const piecesParentOf = (k) => prompts.value.some((p) => p.feature === k && pieceFor(p.key));
watch(selFeature, (k) => {
  if (!k) return;
  if (!prompts.value.some((p) => p.feature === k) || piecesParentOf(k)) loadPreview(k);
});

const navCollapsed = ref(false);

// Per-feature "Reset to default" — the original affordance (the user's word: a COMPLETE
// reset of THIS feature to ITS defaults). Restores the feature's SEEDED preset ref (its
// OWN default preset — e.g. grounded-chat/medium, NOT a clear to the global default) AND
// resets its prompt (system/user/JSON) to the seed, then remounts <FeatureLab> so the form
// reloads from those defaults. Any customization for this feature is discarded. Toast, not
// inline text; the button stays (the feature is now assigned to its own default).
const labEpoch = ref(0);
async function resetFeature() {
  const key = selAction.value;
  if (!key) return;
  const ok = await confirmDialog({
    title: "Reset this feature to defaults?", danger: true,
    message: "Restores this feature's preset (model, params, reasoning) and its prompt to the shipped defaults. Any customization for this feature is discarded.",
  });
  if (!ok) return;
  try {
    message.value = "";
    await request(`/v1/ai/preset-assignments/feature/${encodeURIComponent(key)}/reset`, { method: "POST" });
    // Reset the feature's prompt to its seed too (a COMPLETE reset). A custom action with
    // no seeded prompt has nothing to reset — ignore its 400.
    try { await request(`/v1/ai/prompts/${encodeURIComponent(key)}/reset`, { method: "POST" }); } catch { /* no seeded prompt */ }
    await load();          // refresh prompts + assignments so the form reloads from defaults
    labEpoch.value += 1;   // remount <FeatureLab> → the column re-seeds from the restored preset
    pushToast({ message: "Reset to defaults." });
  } catch (e) { error.value = `Reset failed: ${e.message}`; }
}

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
            <button v-else-if="row.type === 'feature'" type="button" class="lu-fw-card" :style="ml(row.indent)"
              :class="{ 'is-active': row.featureKey === selFeature }" @click="selectFeature(row.featureKey)">
              <div class="lu-fw-card-label">{{ featMeta[row.featureKey]?.label || row.label }}</div>
              <div v-if="featMeta[row.featureKey]?.hint" class="lu-fw-card-desc">{{ featMeta[row.featureKey].hint }}</div>
              <div class="lu-fw-card-model" title="engine preset for this feature">→ {{ featurePresetLabel(row.featureKey) }}</div>
            </button>
            <!-- A labeled feature panel's row (the attribution "Auto" row): selects
                 the feature; its pane is the app's mechanism panel, not routing. -->
            <button v-else-if="row.type === 'panelrow'" type="button" class="lu-fw-card" :style="ml(row.indent)"
              :class="{ 'is-active': row.featureKey === selFeature }" @click="selectFeature(row.featureKey)">
              <div class="lu-fw-card-label">{{ featurePanelMetaFor(row.featureKey)?.label }}</div>
              <div class="lu-fw-card-model">{{ featurePanelMetaFor(row.featureKey)?.note }}</div>
            </button>
            <button v-else type="button" class="lu-fw-card" :style="ml(row.indent)"
              :class="{ 'is-active': row.action.key === selAction }" @click="selectAction(row.action.key)">
              <div class="lu-fw-card-label">{{ actionLabel(row.action) }}</div>
              <div v-if="actionDesc(row.action)" class="lu-fw-card-desc">{{ actionDesc(row.action) }}</div>
              <!-- A PIECE can't route alone — its relation line replaces the routing
                   arrow (a control that accepts input and does nothing would lie). -->
              <div v-if="pieceFor(row.action.key)" class="lu-fw-card-model">{{ pieceFor(row.action.key) }}</div>
              <div v-else class="lu-fw-card-model" title="engine preset for this feature">→ {{ featurePresetLabel(row.action.key) }}</div>
            </button>
          </template>
          <div class="lu-fw-aside-foot">
            <UiButton intent="ghost" size="small"
              title="Restore the built-in presets + every feature assignment to the shipped defaults — your custom presets are kept"
              @click="resetPresets">↺ Reset presets to defaults</UiButton>
          </div>
        </aside>

        <section v-if="action" class="lu-fw-edit">
          <div class="lu-fw-h">
            <b>{{ actionLabel(action) }}</b>
            <span class="lu-fw-spacer" />
            <span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
            <UiButton intent="danger" size="small"
              title="Reset this feature to its own default preset (model · params · reasoning) and prompt"
              @click="resetFeature">Reset to default</UiButton>
            <UiButton intent="ghost" size="small"
              v-tooltip.bottom="navCollapsed ? 'Show list' : 'Hide list'"
              :aria-label="navCollapsed ? 'Show list' : 'Hide list'"
              @click="navCollapsed = !navCollapsed"><Icon name="SidebarToggle" :size="14" /></UiButton>
          </div>
          <FeatureLab :key="`${selAction}:${labEpoch}`"
            :action="selAction" :prompt="action" :providers="providers" :presets="enginePresets"
            :sampler-catalog-list="samplerCatalogList"
            :production-preset-id="selResolvedPreset"
            @use-production="onUseProduction" @presets-changed="onPresetsChanged"
            @prompt-changed="onPromptChanged" />
        </section>
        <section v-else-if="selFeature" class="lu-fw-edit">
          <div class="lu-fw-h">
            <b>{{ selFeatureTitle }}</b>
            <span class="lu-fw-spacer" />
            <span v-if="message" class="lu-muted lu-fw-msg">{{ message }}</span>
          </div>

          <!-- A labeled panel row's pane (the attribution "Auto"): the app's
               mechanism panel IS the whole pane — the feature's actions carry
               their own routing on their own cards, so no chooser renders here. -->
          <template v-if="selPanelPane">
            <p v-if="selPanelMeta.note" class="lu-muted" style="margin:0 0 12px">{{ selPanelMeta.note }}</p>
            <component :is="selPanelMeta.component" :feature="selFeature" />
          </template>
          <template v-else>
          <p v-if="featMeta[selFeature]?.hint" class="lu-muted" style="margin:0 0 12px">{{ featMeta[selFeature].hint }}</p>

          <!-- The app's control for this feature (the featurePanels seam) on a
               pieces parent / promptless feature. Nothing registered → nothing. -->
          <component :is="featurePanelFor(selFeature)" v-if="featurePanelFor(selFeature)"
            :feature="selFeature" />

          <!-- A pieces parent (has prompt rows): the routing home — ONE preset
               feeds every piece below it; the texts are edited on their own rows. -->
          <template v-if="selFeatureHasRows">
          <div class="lu-fw-route">
            <label class="lu-fw-route-label" :for="`fw-route-${selFeature}`">Engine preset</label>
            <select :id="`fw-route-${selFeature}`" class="lu-input" style="max-width:340px"
              :value="refPid(selFeature) || ''"
              @change="(e) => setFeaturePreset(selFeature, e.target.value || null)">
              <option value="">Default preset ({{ presetName(presetAssign.defaultPresetId) }})</option>
              <option v-for="p in enginePresets" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
            </select>
            <p class="lu-muted" style="font-size:12px;margin:8px 0 0">
              One preset (provider · model · every switch) runs this whole feature —
              its texts below follow it. Open a text row to read, edit, or test it.
            </p>
          </div>

          <!-- A pieces parent whose app serves the composed prompt (the family
               prompt-preview door — JV's dictation cleanup, task #22
               2026-08-06): the SAME full Lab as a promptless feature, over the
               REAL composed call (the ground rules + the enabled sections), so
               what's tuned here is exactly what a production run sends. The
               chooser above stays THE assignment; piece texts stay edited on
               their own rows. No preview served → nothing extra (fail-quiet
               here: the routing home above is already a complete pane). -->
          <FeatureLab v-if="builtPrompt" :key="`${selFeature}:${labEpoch}`"
            :action="selFeature" :prompt="null"
            :built-prompt="builtPrompt" :built-meta="builtMeta"
            :data-links="props.dataLinks"
            :providers="providers" :presets="enginePresets"
            :sampler-catalog-list="samplerCatalogList"
            :production-preset-id="selFeatureResolved"
            @use-production="(id) => setFeaturePreset(selFeature, id)"
            @presets-changed="onPresetsChanged"
            @refresh-preview="loadPreview(selFeature)" />
          </template>

          <!-- The full Lab over the app-built prompt: model · params · Save as preset ·
               Use in production — the SAME preset surface prompt-row apps get. The
               preset row inside the Lab is THE assignment control (one source). -->
          <FeatureLab v-else-if="builtPrompt" :key="`${selFeature}:${labEpoch}`"
            :action="selFeature" :prompt="null"
            :built-prompt="builtPrompt" :built-meta="builtMeta"
            :data-links="props.dataLinks"
            :providers="providers" :presets="enginePresets"
            :sampler-catalog-list="samplerCatalogList"
            :production-preset-id="selFeatureResolved"
            @use-production="(id) => setFeaturePreset(selFeature, id)"
            @presets-changed="onPresetsChanged"
            @refresh-preview="loadPreview(selFeature)" />
          <div v-else-if="previewLoading" class="lu-muted">Building the prompt preview…</div>

          <!-- No preview from the app → LOUD, with assignment still possible. -->
          <div v-else class="lu-fw-route">
            <p class="lu-error" style="font-size:12px;margin:0 0 8px">{{ previewErr }}</p>
            <label class="lu-fw-route-label" :for="`fw-route-${selFeature}`">Engine preset</label>
            <select :id="`fw-route-${selFeature}`" class="lu-input" style="max-width:340px"
              :value="refPid(selFeature) || ''"
              @change="(e) => setFeaturePreset(selFeature, e.target.value || null)">
              <option value="">Default preset ({{ presetName(presetAssign.defaultPresetId) }})</option>
              <option v-for="p in enginePresets" :key="p.id" :value="p.id">{{ p.name || p.id }}</option>
            </select>
            <p class="lu-muted" style="font-size:12px;margin:8px 0 0">
              This app builds this feature's prompt itself — routing picks WHICH engine
              preset (provider · model · every switch) runs it.
            </p>
          </div>
          </template>
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
.lu-fw-aside-foot { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); display: flex; }
</style>
