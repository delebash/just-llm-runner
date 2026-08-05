// SPDX-License-Identifier: MIT
// THE reactive labels store over the family contract (2026-08-04). familyContract.js
// stays PURE DATA (the apps' node contract gates import it dependency-free); THIS is
// what kit components actually read, so an i18n'd host (JW) can re-feed translated
// words at boot and on every locale switch and mounted chrome follows live. Hosts
// that ship one locale never call the door and get the English canon for free.
//
// ONE store, ONE door. dialogLabels/configureDialog (services/dialog.js) are a view
// and an alias over this — never a second copy of the words.
//
// THE INVARIANT — configureFamilyLabels deep-assigns INTO the existing nested group
// objects and NEVER replaces them. Components capture group refs at setup
// (`const L = familyLabels.downloadBar`); a door that swapped in a new group object
// would leave every already-mounted component pointing at the orphaned old one —
// frozen at English, silently. Guarded by JW's bite test
// (src/i18n/familyLabels.bite.test.js): configure → a mounted component's text changes.
import { reactive } from "vue";

import { FAMILY_LABELS } from "../familyContract.js";

const clone = (node) => JSON.parse(JSON.stringify(node));

export const familyLabels = reactive(clone(FAMILY_LABELS));

// Accepts a partial: unknown keys are added, `undefined` leaves the current word
// alone (so a partial feed — configureDialog's alias, say — never blanks a label).
export function configureFamilyLabels(partial = {}) {
  deepAssign(familyLabels, partial);
}

export function deepAssign(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") {
      deepAssign(target[key], value); // into the EXISTING group object — the invariant
    } else {
      target[key] = value;
    }
  }
}
