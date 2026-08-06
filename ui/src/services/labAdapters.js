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

// ── Feature PIECES (approved 2026-08-06 — JV's Routing-by-feature rework) ──
// A piece is a prompt row that cannot run or route by itself in production —
// attribution's two instruction styles (the system picks one per run), dictation
// cleanup's four sections (they concatenate into ONE call). A piece row stays a
// visible, editable, Lab-testable card, but shows its RELATION line instead of a
// routing arrow — a routing control on a row that can't route would lie. The map
// is actionKey → the relation sentence. Empty everywhere an app registers
// nothing (JW renders pixel-identical).
const _pieces = {};

export function registerFeaturePieces(map) {
  Object.assign(_pieces, map || {});
}

export function pieceFor(actionKey) {
  return (actionKey && _pieces[actionKey]) || "";
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
