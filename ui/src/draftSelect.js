// SPDX-License-Identifier: GPL-3.0-or-later
// Pure draft-pick helpers for the Add-model form's listing pre-select. Extracted from
// LuModelCatalog.vue so the loadability + 4-bit-floor rule is unit-testable: the kit has
// no vitest harness, but JustWrite's vitest imports this via the alias subpath
// (`@delebash/llm-ui/draftSelect.js`, the embedApi/modelApply precedent). No Vue, no I/O —
// pure over the `drafts` rows `classify_gguf_entries` returns.

/**
 * The path of the draft to pre-select from a repo listing's `drafts` rows, or "".
 *
 * A draft is a candidate ONLY if the engine can load its architecture (`loadable !==
 * false`): an unsupported arch (e.g. dspark) can only fail at spawn, so it is never the
 * default — the floor BELOW the bit-width floor. Among loadable candidates the existing
 * pick rule wins: the 4-bit floor first (`q4OrBetter`), then the smallest (a draft is a
 * speed device; small wins on every box — 2026-07-19-draft-fit-floor-and-lab-measure.md).
 */
export function pickDefaultDraftPath(drafts) {
  const loadable = (drafts || []).filter((d) => d && d.loadable !== false);
  if (!loadable.length) return "";
  const ranked = [...loadable].sort(
    (a, b) => (b.q4OrBetter ? 1 : 0) - (a.q4OrBetter ? 1 : 0) || (a.sizeMb || 0) - (b.sizeMb || 0),
  );
  return ranked[0].path;
}

/**
 * True when the repo ships draft(s) but the engine can load NONE of them — so MTP is left
 * off and the form should say WHY (never a silent gap for a model whose card advertises it).
 */
export function allDraftsUnloadable(drafts) {
  const ds = drafts || [];
  return ds.length > 0 && ds.every((d) => d && d.loadable === false);
}
