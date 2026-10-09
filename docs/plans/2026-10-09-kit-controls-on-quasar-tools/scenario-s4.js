// SPDX-License-Identifier: MIT
// Slice 4's states: UiInput, UiTextarea, UiNumber — rest, hover, keyboard focus, typed text,
// dark, another accent; JustWrite, JustVoice, docgen.
const JV = [8783, 8784];
const JW = [8781, 8782];
const DG = [8785, 8786];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const accent = "document.documentElement.style.setProperty('--accent', 'oklch(0.62 0.17 30)'); document.documentElement.style.setProperty('--accent-soft', 'oklch(0.94 0.04 30)')";
// type into the first matching field the way a user does (native setter + input event)
const type = (sel, text) => `(() => { const box = document.querySelector('${sel}'); const el = box.matches('input,textarea') ? box : box.querySelector('input,textarea'); el.focus(); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, '${text}'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); })()`;
const focusIn = (sel) => `(() => { const box = document.querySelector('${sel}'); (box.matches('input,textarea') ? box : box.querySelector('input,textarea')).focus(); })()`;
export default [
  { app: "jw", port: JW, route: "/chapters", name: "search-rest", clip: ".entity-search-input" },
  { app: "jw", port: JW, route: "/chapters", name: "search-hover", hover: ".entity-search-input", clip: ".entity-search-input" },
  { app: "jw", port: JW, route: "/chapters", name: "search-focus", prep: focusIn(".entity-search-input"), clip: ".entity-search-input" },
  { app: "jw", port: JW, route: "/chapters", name: "search-typed", prep: type(".entity-search-input", "Brass"), clip: ".entity-index, main" },
  { app: "jw", port: JW, route: "/chapters", name: "search-dark", prep: dark, clip: ".entity-search-input" },
  { app: "jw", port: JW, route: "/chapters", name: "navfilter-focus", prep: focusIn(".nav-filter .ui-input, .nav-filter input"), clip: ".nav-filter" },
  { app: "jw", port: JW, route: "/settings", name: "settings-fields", clip: ".settings-main, main" },
  { app: "jw", port: JW, route: "/settings", name: "title-focus", prep: focusIn(".settings-main .ui-input, main .ui-input"), clip: ".settings-main, main" },
  { app: "jw", port: JW, route: "/settings", name: "premise-focus", prep: focusIn(".ui-textarea"), clip: ".settings-main, main" },
  { app: "jw", port: JW, route: "/settings", name: "settings-dark", prep: dark, clip: ".settings-main, main" },
  { app: "jw", port: JW, route: "/settings", name: "settings-accent", prep: accent, clip: ".settings-main, main" },
  { app: "jv", port: JV, route: "/projects", name: "search-rest", clip: ".projects__search" },
  { app: "jv", port: JV, route: "/projects", name: "search-focus", prep: focusIn(".projects__search"), clip: ".projects__search" },
  { app: "jv", port: JV, route: "/projects", name: "search-dark", prep: dark, clip: ".projects__search" },
  { app: "jv", port: JV, route: "/voices", name: "bench-textarea", clip: ".voices-view__bench-field" },
  { app: "jv", port: JV, route: "/voices", name: "bench-focus", prep: focusIn(".voices-view__bench-field .ui-textarea"), clip: ".voices-view__bench-field" },
  { app: "dg", port: DG, route: "/setup", name: "setup-fields", clip: ".setup, main" },
  { app: "dg", port: DG, route: "/setup", name: "setup-path-focus", prep: focusIn(".setup .ui-input"), clip: ".setup, main" },
  { app: "dg", port: DG, route: "/setup", name: "setup-dark", prep: dark, clip: ".setup, main" },
];
