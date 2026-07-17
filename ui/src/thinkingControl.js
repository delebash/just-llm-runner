// SPDX-License-Identifier: GPL-3.0-or-later
// THE Thinking-control vocabulary (2026-07-16, the user's B ruling extended EVERYWHERE:
// "all same everywhere") — ONE source for the control-value ↔ preset-wire mapping,
// imported by every surface that renders or saves the control (LuFeatureChip,
// ConfigColumn, FeatureLab, CompareStrip). Extracted on a rules-checker R3 finding;
// the "Default"/"Model default"/"Provider default" dropdown entries are DELETED (they
// appeared in no user conversation — never-own-decisions exhibit 2).
//
// The states:
//   ""                = Off — preset stores think=false, level ""
//   a level           = the preset's OWN ask (local: the map's number, source
//                       "preset"; cloud: the map's word)
//   THINKING_CUSTOM   = display-only: what runs matches no offered level — either a
//                       number typed straight into a switch grid (local), or a stored
//                       think-on pair with an EMPTY level (the follow / provider-
//                       default state). "Custom" is the USER's own word for the
//                       unmatched case. Saving with it selected writes the truthful
//                       pair {think: true, level: ""} — byte-identical to the stored
//                       state it displays, so a save never silently changes thinking.
export const THINKING_CUSTOM = "__custom";

// Stored preset pair → the control value. Think on with an empty level MUST read as
// THINKING_CUSTOM, never collapse to "" (Off) — the collapse wrote think=false back
// on the next save, silently destroying the follow state.
export function presetToThinkingControl(p) {
  return !p?.think ? "" : (p.reasoningEffort || THINKING_CUSTOM);
}

// Control value → the stored/wire pair. Total and truthful for every state:
// Off → think false; a level → the ask; CUSTOM → think on with an empty level (the
// only stored shape CUSTOM ever displays for). The sentinel strings themselves can
// never ship as a level.
export function thinkingControlToWire(v) {
  const value = v || "";
  if (value === "") return { think: false, reasoningEffort: "" };
  if (value === THINKING_CUSTOM) return { think: true, reasoningEffort: "" };
  return { think: true, reasoningEffort: value };
}
