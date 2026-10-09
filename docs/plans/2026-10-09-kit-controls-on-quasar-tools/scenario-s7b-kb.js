// SPDX-License-Identifier: MIT
// Slice 7b's states: the row menus (JustVoice's Personas and Voices, the kit's model catalog on
// JustWrite's AI Settings) and JustWrite's StatusSelect — closed, open, an item hovered, opened
// from the keyboard, dark.
const JW = [8781, 8782];
const JV = [8783, 8784];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const kbOpen = (sel) => `(() => { const t = document.querySelector('${sel}'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`;
const editMode = '[...document.querySelectorAll(".seg-toggle button")][0].click()';
export default [
  { app: "jv", port: JV, route: "/personas", name: "menu-keyboard", focus: ".ev-kebab", press: "ArrowDown", clip: ".ev-menu" },
  { app: "jv", port: JV, route: "/personas", name: "menu-keyboard-enter", focus: ".ev-kebab", press: "Enter", clip: ".ev-menu" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "status-open-pill", prep: editMode, click: ".status-pill", clip: ".status-pill" },
];
