// SPDX-License-Identifier: MIT
// While a menu or a select's list is open, the page behind takes no pointer: the first click
// outside only closes the list, and nothing behind it reacts to the pointer meanwhile — as the
// kit's menus and selects did under Reka UI, which set pointer-events: none on <body> (the list
// sets its own back to auto). Quasar's QMenu leaves the page live: a click outside a row's ⋯ menu
// also opened the row behind it (measured on JustVoice's Personas, Q3 slice 7b —
// docs/plans/2026-10-09-kit-controls-on-quasar.md). Quasar's click-outside still sees that click
// (its target is then <html>), so the list closes as before.
//
// Usage: useModalPopup(openRef) in the component that owns the list, and `pointer-events: auto`
// on the list itself.
import { onBeforeUnmount, watch } from "vue";

let holders = 0;
let saved = "";
function hold(on) {
  if (typeof document === "undefined") return;
  if (on) {
    if (holders++ === 0) {
      saved = document.body.style.pointerEvents;
      document.body.style.pointerEvents = "none";
    }
  } else if (holders > 0 && --holders === 0) {
    document.body.style.pointerEvents = saved;
  }
}

export function useModalPopup(isOpen) {
  let held = false;
  watch(isOpen, (open) => {
    if (open && !held) { held = true; hold(true); }
    else if (!open && held) { held = false; hold(false); }
  });
  onBeforeUnmount(() => {
    if (held) { held = false; hold(false); }
  });
}
