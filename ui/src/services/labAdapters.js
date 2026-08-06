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
