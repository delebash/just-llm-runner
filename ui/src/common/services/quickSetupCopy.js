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
  // Called when apply reaches done ({ modelId }) — the seam for app follow-ups
  // (docgen needs nothing today: setAsDefault already repoints its presets).
  onApplied: null,
});

export function configureQuickSetupCopy(partial = {}) {
  deepAssign(quickSetupCopy, partial);
}
