// SPDX-License-Identifier: GPL-3.0-or-later
// THE three-state Thinking control vocabulary (2026-07-16 preset tier) — ONE source for
// the control-value ↔ preset-wire mapping, imported by every surface that renders or
// saves the control (LuFeatureChip, ConfigColumn, FeatureLab, CompareStrip). Extracted
// on a rules-checker R3 finding: the pair was hand-inlined at six sites with the bare
// "default" literal in three, and the "the literal 'default' never reaches the wire as
// a level" invariant held only by every copy independently remembering to collapse it.
//
// The states:
//   ""                 = Off              (preset stores think=false, level "")
//   THINKING_DEFAULT   = think on, EMPTY level — local: FOLLOW the selected model's
//                        layered budget (resolved live, nothing copied); cloud: the
//                        provider's own default (no word sent)
//   a level            = the preset's OWN ask (local: the map's number, source
//                        "preset"; cloud: the map's word)
export const THINKING_DEFAULT = "default";

// Stored preset pair → the control value. Think on with an empty level MUST read as
// THINKING_DEFAULT, never collapse to "" (Off) — the collapse wrote think=false back
// on the next save, silently destroying the follow state.
export function presetToThinkingControl(p) {
  return !p?.think ? "" : (p.reasoningEffort || THINKING_DEFAULT);
}

// Control value → the stored/wire pair. THINKING_DEFAULT collapses to an EMPTY level —
// the sentinel string itself must never ship as a level.
export function thinkingControlToWire(v) {
  const value = v || "";
  return {
    think: value !== "",
    reasoningEffort: value === "" || value === THINKING_DEFAULT ? "" : value,
  };
}
