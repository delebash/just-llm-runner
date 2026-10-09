// SPDX-License-Identifier: MIT
// Slice 1's states: UiChip (JustVoice's filter chips) and UiTag (JustVoice's voice table, JustWrite's
// chapter status tags) — rest, hover, keyboard focus, dark mode, another accent.
const JV = [8783, 8784];
const JW = [8781, 8782];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const accent = "document.documentElement.style.setProperty('--accent', 'oklch(0.62 0.17 30)'); document.documentElement.style.setProperty('--accent-soft', 'oklch(0.94 0.04 30)')";
const chips = ".projects__filters, .ui-chip";
export default [
  { app: "jv", port: JV, route: "/projects", name: "chips-rest", clip: ".ui-chip:nth-of-type(2)" },
  { app: "jv", port: JV, route: "/projects", name: "chips-row", clip: "div:has(> .ui-chip)" },
  { app: "jv", port: JV, route: "/projects", name: "chip-hover", hover: "div:has(> .ui-chip) > .ui-chip:nth-child(3)", clip: "div:has(> .ui-chip)" },
  { app: "jv", port: JV, route: "/projects", name: "chip-focus", focus: "div:has(> .ui-chip) > .ui-chip:nth-child(3)", clip: "div:has(> .ui-chip)" },
  { app: "jv", port: JV, route: "/projects", name: "chips-dark", prep: dark, clip: "div:has(> .ui-chip)" },
  { app: "jv", port: JV, route: "/projects", name: "chips-accent", prep: accent, clip: "div:has(> .ui-chip)" },
  { app: "jv", port: JV, route: "/voices", name: "chips-voices", clip: "div:has(> .ui-chip)" },
  { app: "jv", port: JV, route: "/voices", name: "tags-rows", clip: ".ui-table tbody" },
  { app: "jv", port: JV, route: "/voices", name: "tags-dark", prep: dark, clip: ".ui-table tbody" },
  { app: "jv", port: JV, route: "/voices", name: "tags-accent", prep: accent, clip: ".ui-table tbody" },
  { app: "jv", port: JV, route: "/captures", name: "tag-ghost", clip: ".captures__band-h" },
  { app: "jw", port: JW, route: "/chapters", name: "tags-status", clip: ".ui-table tbody" },
  { app: "jw", port: JW, route: "/chapters", name: "tags-dark", prep: dark, clip: ".ui-table tbody" },
];
void chips;
