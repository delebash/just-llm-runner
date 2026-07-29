// SPDX-License-Identifier: MIT
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

// The level vocabulary, ascending — ONE source for every surface's option list.
export const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];
export const LEVEL_WORD = { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

// Stored preset pair → the control value. Think on with an empty level MUST read as
// THINKING_CUSTOM, never collapse to "" (Off) — the collapse wrote think=false back
// on the next save, silently destroying the follow state.
export function presetToThinkingControl(p) {
  return !p?.think ? "" : (p.reasoningEffort || THINKING_CUSTOM);
}

// The level whose map row carries `value`, or null. The map is the SAME source the
// option labels come from ("Low (1024)"), so a match here always names an offered
// option — a user-edited map moves both together and they cannot disagree.
export function levelForValue(levelRows, value) {
  if (value == null) return null;
  const m = (levelRows || []).find((r) => r.tokens != null && r.tokens === value);
  return m ? m.level : null;
}

// The control value for a LOADED preset on a LOCAL route, given what actually resolves
// (the user's B ruling, 2026-07-16 — "say the thinking level if it matches, otherwise
// show custom with the number"): a stored level is the preset's OWN ask and shows as
// itself; the follow state (think on, empty level) shows the level whose map number
// matches the RESOLVED budget, else Custom. Think off is Off. Used by the chip AND the
// Lab so the two can never display different things for the same preset (they drifted
// twice on 2026-07-16 — the parity test pins it).
export function resolvedToThinkingControl(p, resolvedValue, levelRows) {
  if (!p?.think) return "";
  if (p.reasoningEffort) return p.reasoningEffort;
  return levelForValue(levelRows, resolvedValue) || THINKING_CUSTOM;
}

// The options for a surface's dropdown — ONE builder (the chip AND the Lab): Off +
// every level the provider's map carries, numbered where the provider speaks numbers
// ("Low (1024)") and plain where it speaks words ("Low"), + display-only Custom while
// Custom IS the current state (with its number when there is one). An EMPTY map (fetch
// failed / not seeded yet) falls back to plain level words — a control that offers only
// "Off" would be a worse lie than an unnumbered label.
export function thinkingOptionsFor({ levelRows, current, customValue }) {
  const opts = [{ value: "", label: "Off" }];
  const byLevel = Object.fromEntries((levelRows || []).map((r) => [r.level, r]));
  for (const lvl of LEVEL_ORDER) {
    const row = byLevel[lvl];
    if (levelRows?.length && !row) continue; // the provider genuinely lacks this level
    opts.push({
      value: lvl,
      label: row?.tokens != null ? `${LEVEL_WORD[lvl]} (${row.tokens})` : LEVEL_WORD[lvl],
    });
  }
  if (current === THINKING_CUSTOM) {
    opts.push({ value: THINKING_CUSTOM, label: customValue != null ? `Custom (${customValue})` : "Custom" });
  }
  return opts;
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
