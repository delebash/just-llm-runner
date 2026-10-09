// SPDX-License-Identifier: MIT
// Slice 5's states: UiSelect (JustVoice's voice filters) and UiMultiSelect (docgen's target
// languages) — closed, keyboard focus, open, an item hovered, dark, another accent, filtered.
const JV = [8783, 8784];
const DG = [8785, 8786];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const accent = "document.documentElement.style.setProperty('--accent', 'oklch(0.62 0.17 30)'); document.documentElement.style.setProperty('--accent-soft', 'oklch(0.94 0.04 30)')";
const kbFocus = (sel) => `(() => { const t = document.querySelector('${sel}'); (t.matches('button') ? t : t.querySelector('.q-select__focus-target')).focus(); })()`;
const sel1 = ".ui-select-trigger";
const sel2 = "div:has(> .ui-select-trigger) > .ui-select-trigger:nth-of-type(2), .ui-select-trigger:nth-of-type(2)";
export default [
  { app: "jv", port: JV, route: "/voices", name: "sel-row", clip: `div:has(> ${sel1})` },
  { app: "jv", port: JV, route: "/voices", name: "sel-hover", hover: sel1, clip: `div:has(> ${sel1})` },
  { app: "jv", port: JV, route: "/voices", name: "sel-kbfocus", prep: kbFocus(sel1), clip: `div:has(> ${sel1})` },
  { app: "jv", port: JV, route: "/voices", name: "sel-open-trigger", click: sel1, clip: `div:has(> ${sel1})` },
  { app: "jv", port: JV, route: "/voices", name: "sel-open-list", click: sel1, clip: ".ui-select-content" },
  { app: "jv", port: JV, route: "/voices", name: "sel-open-hover", click: sel1, hover: ".ui-select-content .ui-select-item:nth-of-type(3)", clip: ".ui-select-content" },
  { app: "jv", port: JV, route: "/voices", name: "sel-open-dark", prep: dark, click: sel1, clip: ".ui-select-content" },
  { app: "jv", port: JV, route: "/voices", name: "sel-open-accent", prep: accent, click: sel1, clip: ".ui-select-content" },
  { app: "jv", port: JV, route: "/personas", name: "sel-row", clip: `div:has(> ${sel1})` },
  { app: "jv", port: JV, route: "/personas", name: "sel-open-list", click: sel1, clip: ".ui-select-content" },
  { app: "dg", port: DG, route: "/setup", name: "ms-closed", clip: ".ui-mselect-trigger" },
  { app: "dg", port: DG, route: "/setup", name: "ms-hover", hover: ".ui-mselect-trigger", clip: ".ui-mselect-trigger" },
  { app: "dg", port: DG, route: "/setup", name: "ms-open-list", click: ".ui-mselect-trigger", clip: ".ui-mselect-content" },
  { app: "dg", port: DG, route: "/setup", name: "ms-open-trigger", click: ".ui-mselect-trigger", clip: ".ui-mselect-trigger" },
  { app: "dg", port: DG, route: "/setup", name: "ms-filtered", click: ".ui-mselect-trigger", type: "spa", clip: ".ui-mselect-content" },
  { app: "dg", port: DG, route: "/setup", name: "ms-nomatch", click: ".ui-mselect-trigger", type: "zzz", clip: ".ui-mselect-content" },
  { app: "dg", port: DG, route: "/setup", name: "ms-open-dark", prep: dark, click: ".ui-mselect-trigger", clip: ".ui-mselect-content" },
];
void sel2;
