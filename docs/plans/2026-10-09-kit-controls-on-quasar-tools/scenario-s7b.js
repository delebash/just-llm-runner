// Slice 7b's states: the row menus (JustVoice's Personas and Voices, the kit's model catalog on
// JustWrite's AI Settings) and JustWrite's StatusSelect — closed, open, an item hovered, opened
// from the keyboard, dark.
const JW = [8781, 8782];
const JV = [8783, 8784];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const kbOpen = (sel) => `(() => { const t = document.querySelector('${sel}'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`;
const editMode = '[...document.querySelectorAll(".seg-toggle button")][0].click()';
export default [
  { app: "jv", port: JV, route: "/personas", name: "menu-trigger", clip: ".ev-kebab" },
  { app: "jv", port: JV, route: "/personas", name: "menu-trigger-hover", hover: ".ev-kebab", clip: ".ev-kebab" },
  { app: "jv", port: JV, route: "/personas", name: "menu-open", click: ".ev-kebab", clip: ".ev-menu" },
  { app: "jv", port: JV, route: "/personas", name: "menu-open-trigger", click: ".ev-kebab", clip: ".ev-kebab" },
  { app: "jv", port: JV, route: "/personas", name: "menu-hover-item", click: ".ev-kebab", hover: ".ev-menu .ev-menu-item:nth-child(2)", clip: ".ev-menu" },
  { app: "jv", port: JV, route: "/personas", name: "menu-hover-danger", click: ".ev-kebab", hover: ".ev-menu .ev-menu-item.danger", clip: ".ev-menu" },
  { app: "jv", port: JV, route: "/personas", name: "menu-keyboard", focus: ".ev-kebab", press: "ArrowDown", clip: ".ev-menu" },
  { app: "jv", port: JV, route: "/personas", name: "menu-keyboard-enter", focus: ".ev-kebab", press: "Enter", clip: ".ev-menu" },
  { app: "jv", port: JV, route: "/personas", name: "menu-dark", prep: dark, click: ".ev-kebab", clip: ".ev-menu" },
  { app: "jv", port: JV, route: "/voices", name: "voices-menu", click: ".ev-kebab", clip: ".ev-menu" },
  { app: "jw", port: JW, route: "/ai", name: "catalog-menu", click: ".lu-mkebab", clip: ".lu-mmenu" },
  { app: "jw", port: JW, route: "/ai", name: "catalog-menu-hover", click: ".lu-mkebab", hover: ".lu-mmenu .lu-mmi:nth-child(2)", clip: ".lu-mmenu" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "status-closed", prep: editMode, clip: ".status-pill" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "status-hover", prep: editMode, hover: ".status-pill", clip: ".status-pill" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "status-open-pill", prep: editMode, click: ".status-pill", clip: ".status-pill" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "status-open-list", prep: editMode, click: ".status-pill", clip: ".status-menu" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "status-open-hover", prep: editMode, click: ".status-pill", hover: ".status-menu .status-opt:nth-of-type(3)", clip: ".status-menu" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "status-dark", prep: `${dark}; ${editMode}`, click: ".status-pill", clip: ".status-menu" },
];
