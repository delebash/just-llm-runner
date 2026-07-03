// SPDX-License-Identifier: GPL-3.0-or-later
// Shared one-shot channel: hand a tuned {model + engine switches} config from Tune &
// measure (the Models surfaces) into the Tasks Lab as a new Compare column, so a tuned
// config doesn't die in the measure modal (Phase 5). Matches the dialog.js / toastBridge.js
// singleton pattern (module-level reactive refs + helpers) — placed here beside them.
//
// `activeAiTab` is the shared AI-area subnav tab: the sender (the Tune modal, opened from
// the built-in provider's model catalog on the Providers tab) flips it to "tasks", and
// AiModelsArea binds its tab to it. `labHandoff` is
// the pending payload; the Tasks Lab CONSUMES it once (takeLabHandoff) and clears it, so
// it seeds exactly ONE column and never re-fires on a re-render / task re-select.
import { ref } from "vue";

// Pending handoff — { providerId, model, switches:[{name,value}] } | null.
export const labHandoff = ref(null);

// The shared AI-area tab (default matches AiModelsArea's prior local default).
export const activeAiTab = ref("providers");

// Send a tuned config to the Tasks Lab: stash it, then switch to the Tasks tab.
export function sendToTasksLab({ providerId = "", model = "", switches = [] } = {}) {
  labHandoff.value = { providerId, model, switches };
  activeAiTab.value = "tasks";
}

// Consume + clear the pending handoff — returns the payload or null. One-shot: the Lab
// seeds one column from it; a second read gets null (no re-seed on re-render).
export function takeLabHandoff() {
  const h = labHandoff.value;
  labHandoff.value = null;
  return h;
}
