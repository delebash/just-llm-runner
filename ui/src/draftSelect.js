// SPDX-License-Identifier: MIT
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
 * The quant to pre-select from a repo listing's `quants` rows (size-ascending from the
 * server), or "". The v1 heuristic stands — largest quant whose FILE SIZE fits the
 * detected VRAM — but the nothing-fits fallback changed (fit-redesign §4 0.4): the old
 * "else the smallest" handed an 8 GB box a 1-bit IQ1_M (file-size-vs-VRAM is MoE-blind,
 * so on a MoE repo NOTHING "fits" and the fallback always fired). Now: smallest quant at
 * ≥4-bit (`q4OrBetter`, the server's one predicate) — only a repo shipping nothing at
 * 4-bit falls to the truly smallest.
 */
export function pickDefaultQuant(quants, vramMb) {
  const rows = quants || [];
  if (!rows.length) return "";
  const fitting = vramMb ? rows.filter((q) => q.sizeMb <= vramMb) : [];
  if (fitting.length) return fitting[fitting.length - 1].quant;
  // Nothing fits by file size (every MoE repo lands here — file ≠ VRAM when
  // experts offload): take the ≥4-bit floor, then QUALITY-FIRST within a small
  // size neighborhood — the LARGEST candidate within 15% of the smallest
  // ≥4-bit. The user's 2026-08-13 checkpoint case: unsloth's UD-Q4_K_XL is the
  // better pick than UD-Q4_K_M at near-identical size (dynamic quants spend
  // their extra bits where they matter); a bare smallest-≥4-bit rule threw
  // that quality away to save ~3%. The window stays tight so the pick never
  // jumps a real size tier (Q8 at ~2× stays out).
  const atFloor = rows.filter((q) => q.q4OrBetter);
  if (!atFloor.length) return rows[0].quant;
  const limit = atFloor[0].sizeMb * 1.15;
  const near = atFloor.filter((q) => q.sizeMb <= limit);
  return near[near.length - 1].quant;
}

/**
 * True when the repo ships draft(s) but the engine can load NONE of them — so MTP is left
 * off and the form should say WHY (never a silent gap for a model whose card advertises it).
 */
export function allDraftsUnloadable(drafts) {
  const ds = drafts || [];
  return ds.length > 0 && ds.every((d) => d && d.loadable === false);
}
