// SPDX-License-Identifier: MIT
// Lab adapters — the per-FEATURE seam that lets an app's real pipeline stand in
// for the generic Lab run (family parity batch 2026-08-05; the Speaker-Lab
// reunification is the first consumer). The kit Lab keeps everything it already
// owns — columns, provider/model pick, params, presets, prompt editing, compare —
// and the adapter supplies only what is genuinely the app's:
//
//   run(body, { signal })  → REPLACES the generic /v1/ai/run for this feature's
//     Lab runs: the app endpoint that IS the production pipeline (JV attribution
//     runs /v1/extraction/analyze-text — segmentation, anchors, floors — so the
//     Lab tests what production runs, never a look-alike). `body` is the column's
//     full run config (action · variables · provider/model pin · params ·
//     samplers · the column's `extra` from configExtra). Resolve to
//     { content?, model?, promptTokens?, completionTokens?, cost?, data? } —
//     `data` is the structured result `render` consumes; `content` stays the raw
//     model output (the Lab keeps it viewable).
//
//   render  → a component for the feature's RESULT (the attribution table:
//     speaker · line · confidence % · reassign). Mounted per column, and handed
//     EVERY column's results too — cross-column compare / disagreement
//     highlighting needs the neighbors. Props: { result, allResults, config,
//     action, columnLabel }.
//
//   configExtra → a component for per-column APP controls (attribution's tier +
//     confidence floor). v-models the column config's `extra` object; whatever it
//     writes there rides the run body.
//
//   varConfig → per-VARIABLE input affordances (2026-08-06 — JV's Speaker-Lab
//     restoration): { <varName>: { editor?: Component, hidden?: true,
//     counters?: true } }. `editor` replaces the variable's plain textarea (a
//     v-model:String component — it must serialize to the same string the
//     adapter's run parses); `hidden` skips the input entirely (the adapter
//     owns that variable at run time); `counters` adds a live words · chars ·
//     ~tokens readout over the box. Absent → plain textareas, unchanged.
//
// Registered once at boot via installLlmUi({ labAdapters: { <featureKey>: … } });
// keyed by the FEATURE key, so every action row of that feature (and the
// promptless feature pane, whose action IS the feature key) gets the adapter.
const _adapters = {};

export function registerLabAdapters(map) {
  Object.assign(_adapters, map || {});
}

export function labAdapterFor(featureKey) {
  return (featureKey && _adapters[featureKey]) || null;
}

// ── SECTIONED features (decided 2026-08-08 — the dictation-cleanup redesign;
// it RETIRES the 2026-08-06 pieces concept, whose nav rows carried tuning
// surfaces that either did nothing durable or acted one level up). A sectioned
// feature's prompt rows are PARTS of one composed call: the `<feature>.base`
// row's system is a template whose `{{section}}` markers fill with the OTHER
// rows' texts when the app's own toggles enable them — marker order IS paste
// order, visible and user-editable. The feature renders as ONE nav card; its
// pane edits every text, mounts the app's panel (the live toggles), and runs
// the standard Lab over the app's prompt-preview — the REAL composition, so
// the Lab mirrors production by construction (the standing premise). A set of
// FEATURE keys; empty by default (JW/docgen render pixel-identical).
const _sectioned = new Set();

export function registerSectionedFeatures(list) {
  for (const k of list || []) _sectioned.add(k);
}

export function sectionedFeature(featureKey) {
  return !!featureKey && _sectioned.has(featureKey);
}

// ── Feature PANELS (same approval; row form 2026-08-06 — the attribution
// restore) — an app control pane for a feature. Keyed by FEATURE. Registered
// as a bare component (back-compat) or as { component, label, note }: with
// label/note the workbench renders a NAV ROW for it under the feature's
// heading (JV's "Auto — Picks which of the three below runs"), and selecting
// that row shows ONLY the panel as the pane (the feature's actions carry
// their own routing). Component receives { feature }. Empty by default — JW
// registers nothing and renders pixel-identical.
const _panels = {};

export function registerFeaturePanels(map) {
  Object.assign(_panels, map || {});
}

function panelEntry(featureKey) {
  const e = featureKey && _panels[featureKey];
  if (!e) return null;
  // A wrapper object carries `component`; anything else IS the component.
  return typeof e === "object" && "component" in e ? e : { component: e, label: "", note: "" };
}

export function featurePanelFor(featureKey) {
  return panelEntry(featureKey)?.component || null;
}

export function featurePanelMetaFor(featureKey) {
  return panelEntry(featureKey);
}
