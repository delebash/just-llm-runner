// Slice 2's states: UiButton — intents (primary, secondary, ghost), sizes (small, icon), disabled;
// rest, hover, keyboard focus, dark mode, another accent; JustVoice and JustWrite.
const JV = [8783, 8784];
const JW = [8781, 8782];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const accent = "document.documentElement.style.setProperty('--accent', 'oklch(0.62 0.17 30)'); document.documentElement.style.setProperty('--accent-soft', 'oklch(0.94 0.04 30)')";
const jvBar = "div:has(> .ui-btn--primary)";
const jvPrimary = ".ui-btn--primary";
export default [
  { app: "jv", port: JV, route: "/projects", name: "btns-rest", clip: jvBar },
  { app: "jv", port: JV, route: "/projects", name: "btn-primary-hover", hover: jvPrimary, clip: jvBar },
  { app: "jv", port: JV, route: "/projects", name: "btn-secondary-hover", hover: `${jvBar} .ui-btn--secondary`, clip: jvBar },
  { app: "jv", port: JV, route: "/projects", name: "btn-primary-focus", focus: jvPrimary, clip: jvBar },
  { app: "jv", port: JV, route: "/projects", name: "btns-dark", prep: dark, clip: jvBar },
  { app: "jv", port: JV, route: "/projects", name: "btns-accent", prep: accent, clip: jvBar },
  { app: "jv", port: JV, route: "/personas", name: "btn-disabled", clip: "div:has(> .ui-btn.is-disabled)" },
  { app: "jv", port: JV, route: "/personas", name: "btn-disabled-hover", hover: ".ui-btn.is-disabled", clip: "div:has(> .ui-btn.is-disabled)" },
  { app: "jv", port: JV, route: "/voices", name: "btns-rows", clip: ".ui-table tbody" },
  { app: "jv", port: JV, route: "/voices", name: "btns-rows-hover", hover: ".ui-table tbody tr:nth-child(2) .ui-btn", clip: ".ui-table tbody tr:nth-child(2)" },
  { app: "jv", port: JV, route: "/ai", name: "btns-providers", clip: ".lu-prow, .lu-provider-row, [class*='prov']" },
  { app: "jv", port: JV, route: "/ai", name: "btns-providers-dark", prep: dark, clip: ".lu-prow, .lu-provider-row, [class*='prov']" },
  { app: "jw", port: JW, route: "/chapters", name: "btns-header", clip: ".pane-header, header" },
  { app: "jw", port: JW, route: "/chapters", name: "btn-ghost-hover", hover: ".ui-btn--ghost", clip: ".pane-header, header" },
  { app: "jw", port: JW, route: "/chapters", name: "btn-primary-focus", focus: ".ui-btn--primary", clip: ".pane-header, header" },
  { app: "jw", port: JW, route: "/chapters", name: "btns-dark", prep: dark, clip: ".pane-header, header" },
  { app: "jw", port: JW, route: "/settings", name: "settings-buttons", clip: ".settings-main, main" },
  { app: "jw", port: JW, route: "/ai", name: "ai-buttons", clip: ".lu-prow, [class*='prov']" },
];
