// SPDX-License-Identifier: MIT
// Display-only memory-size snapping (fit-redesign §5.6/§8.15). Floors are STORED
// and compared RAW (that's what makes the RAM gate honest — §13.5); what the USER
// reads snaps UP to a size real hardware ships (the 2026-07-27 ruling: a "Needs"
// line answers a tier question — "what machine do I need" — in tier units, and a
// raw 2,765 MB would be false precision). Display-only by construction: a wrong
// rung can mislabel a row but can never misroute a fit decision. The hover keeps
// the raw number. No Vue, no I/O — JW's vitest imports this via the alias subpath
// (the draftSelect.js precedent).

// Every rung is a REAL shipped product (§8.15's decided rule — rung exists iff
// hardware shipped it): 1060-3GB · 1650 · 2060 · 2070S-class · 3080 · 1080 Ti ·
// 3060/4070 · 4080 · 7900 XT/RTX 4000 Ada · 3090/4090 · 5090 · RTX 6000 Ada.
export const VRAM_DISPLAY_LADDER_GB = [3, 4, 6, 8, 10, 11, 12, 16, 20, 24, 32, 48];
// Machine RAM sizes (the est_ram rungs' display sibling).
export const RAM_DISPLAY_LADDER_GB = [4, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 128];

function snapUpGb(mb, ladder, pastTopStepGb) {
  if (!mb || mb <= 0) return 0;
  const gb = mb / 1024;
  for (const rung of ladder) {
    if (gb <= rung) return rung;
  }
  return Math.ceil(gb / pastTopStepGb) * pastTopStepGb;
}

/** Raw VRAM MB → the display GB (snapped UP the real-cards ladder). */
export function displayVramGb(mb) {
  return snapUpGb(mb, VRAM_DISPLAY_LADDER_GB, 16);
}

/** Raw RAM MB → the display GB (snapped UP the machine-sizes ladder). */
export function displayRamGb(mb) {
  return snapUpGb(mb, RAM_DISPLAY_LADDER_GB, 32);
}
