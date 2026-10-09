// SPDX-License-Identifier: MIT
// Slice 7's states: the modal (JustWrite's Writing settings and Critique), the prompt and confirm
// dialogs (JustWrite's Save preset and Clear models cache), the feature chip's popover (in the
// Ask-the-book panel and inside a modal), the help drawer, and the toasts (JustWrite's dark ones
// with and without an action; JustVoice's sonner-look normal and warning ones).
const JW = [8781, 8782];
const JV = [8783, 8784];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const tab = (t) => `[...document.querySelectorAll('.ui-tabstrip__tab')].find((b) => b.textContent.trim() === '${t}').click()`;
const button = (re) => `[...document.querySelectorAll('button')].find((b) => /${re}/.test(b.textContent.trim())).click()`;
const and = (...js) => js.join("; ");
const editMode = '[...document.querySelectorAll(".seg-toggle button")][0].click()';
const later = (js, ms = 400) => `new Promise((r) => setTimeout(() => { ${js}; r(); }, ${ms}))`;
const ui = "document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia._s.get('ui')";
const MODAL = ".ui-modal";
const TOAST = ".ui-toast, [data-sonner-toast]";
const chat = "[...document.querySelectorAll('[data-panel-toggle]')].find((b) => /Ask the book/.test(b.textContent)).click()";
const clip = (ok) => `navigator.clipboard.writeText = () => Promise.${ok ? "resolve()" : "reject(new Error('denied'))"}`;
export default [
  { app: "jw", port: JW, route: "/settings", name: "toast", prep: `${ui}.showToast({ message: 'Chapter saved' }, 60000)`, clip: TOAST },
  { app: "jw", port: JW, route: "/settings", name: "toast-action", prep: `${ui}.showToast({ message: 'Moved to trash', action: { label: 'Undo', fn() {} } }, 60000)`, clip: TOAST },
  { app: "jw", port: JW, route: "/settings", name: "toast-hover-close", prep: `${ui}.showToast({ message: 'Chapter saved' }, 60000)`, hover: ".ui-toast__close, [data-close-button]", clip: TOAST },
  { app: "jv", port: JV, route: "/settings", name: "toast", prep: and(tab("MCP server"), clip(true), later(button("^Copy"))), clip: TOAST },
  { app: "jv", port: JV, route: "/settings", name: "toast-warning", prep: and(tab("MCP server"), clip(false), later(button("^Copy"))), clip: TOAST },
  { app: "jv", port: JV, route: "/settings", name: "toast-warning-dark", prep: and(dark, tab("MCP server"), clip(false), later(button("^Copy"))), clip: TOAST },
];
