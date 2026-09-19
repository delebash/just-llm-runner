// SPDX-License-Identifier: MIT
// The Quick Setup wizard's VOICE — the app-domain sentences (band caption, confirm
// title, model hint, bar roles, done body). Canon words (buttons, "The engine") live
// in familyLabels.quickSetup and are NOT here — one door per purpose (the contract:
// labels translate canon, copy carries voice; neither may smuggle the other).
//
// catalogCopy precedent: English (JW-voiced) defaults; a host overrides via
// installLlmUi({ quickSetupCopy }) → configureQuickSetupCopy. Deep-assign IN PLACE
// (the familyLabels invariant — components capture the object at setup).
import { reactive } from "vue";

import { deepAssign } from "./familyLabels.js";

export const quickSetupCopy = reactive({
  // Under the band's Run button (inline mount) / the titled strip (default mount).
  bandSub: "Detect your hardware, pick the best free local model that fits, and set it as your default.",
  headSub: "Detect your hardware, pick the best free local model that fits, and set it as your default — all editable.",
  // The confirm step's modal title.
  confirmTitle: "Recommended setup — for the Local built-in provider only",
  // Under the Default-model picker.
  modelHint: "One good model runs every feature — writing, chat, extraction, judgment. Per-feature choices live under Routing by feature; this sets the shared default.",
  // The chat model's DownloadBar role line.
  chatRole: "writes + chats",
  // The embedding's role (embedding-capable hosts only).
  embedRole: "powers search + Ask the book",
  // An app line under the done-step summary ("" = none).
  doneBody: "",
  // The one-minute speed check's card (speed-truth plan 2026-09-19 §6). {size}
  // is the test model's download size, formatted. The user ruling this answers:
  // "present it to them clearly what this is, why it is recommended, and allow
  // them to skip".
  checkBody: "No preset matches this hardware, so the model recommended on the next screen "
    + "would be chosen from estimates. A one-minute check downloads a small test model ({size}, one time), "
    + "runs it briefly two ways, and measures how fast this PC really moves model data — "
    + "the number that decides which models run at reading speed.",
  checkSkipNote: "Skip it and the recommendation is estimated from your hardware's specs instead. "
    + "Nothing else changes either way.",
  checkDoneNote: "Measured — the recommendation on the next screen now uses this PC's real speed.",
  // Called when apply reaches done ({ modelId }) — the seam for app follow-ups
  // (docgen needs nothing today: setAsDefault already repoints its presets).
  onApplied: null,
});

export function configureQuickSetupCopy(partial = {}) {
  deepAssign(quickSetupCopy, partial);
}
