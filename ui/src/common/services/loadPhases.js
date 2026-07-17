// SPDX-License-Identifier: GPL-3.0-or-later
// THE one phase vocabulary for MODEL load / download / unload progress (T3,
// 2026-07-17 approved plan — the user: the integrated UI speaks "terms with
// quicksetup"). MOVED VERBATIM from QuickSetup.vue's local block (the 2026-07-15
// "make the words more userfriendly" ruling) — QuickSetup now imports from here and a
// JW source test pins that no local copy regrows. Every model surface (QuickSetup's
// bars, the catalog slot cards, the catalog rows) renders through friendlyPhase.
// Scope honesty: the ENGINE install keeps its own friendlyEnginePhase (useEngine.js)
// — a pre-existing, separate vocabulary, deliberately not folded in.
export const PHASE_WORDS = {
  queued: "Getting ready",
  // T1 (2026-07-17): the neutral phase before any real download chunk lands — the
  // download itself sets "model weights"; a cached file never announces one.
  preparing: "Getting ready",
  "model weights": "Downloading the model",
  "MTP draft model": "Downloading the fast-generation helper file",
  "loading into VRAM": "Loading it into your graphics card",
  // T2/T2b (2026-07-17): the transient teardown statuses arrive with EMPTY detail —
  // friendlyPhase falls through to the STATUS for these.
  stopping: "Unloading…",
  cancelling: "Cancelling…",
};

export function friendlyPhase(detail, status) {
  const d = String(detail || "").trim();
  if (PHASE_WORDS[d]) return PHASE_WORDS[d];
  if (d) return d; // already a sentence (the MTP notes)
  if (PHASE_WORDS[status]) return PHASE_WORDS[status];
  if (status === "downloading") return "Downloading";
  if (status === "starting") return "Starting the engine";
  return "Working";
}
