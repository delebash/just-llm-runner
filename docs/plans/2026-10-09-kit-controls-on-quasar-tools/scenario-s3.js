// Slice 3's states: UiCheckbox (JustVoice's persona table, JustWrite's Export) and UiToggle
// (the AI settings' warm-on-startup switch, docgen's Server settings) — rest, checked/on, hover,
// keyboard focus, disabled, dark, another accent.
const JV = [8783, 8784];
const JW = [8781, 8782];
const DG = [8785, 8786];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const accent = "document.documentElement.style.setProperty('--accent', 'oklch(0.62 0.17 30)'); document.documentElement.style.setProperty('--accent-soft', 'oklch(0.94 0.04 30)')";
const check2 = "document.querySelectorAll('tbody .ui-checkbox')[1].click()";
const rows = "tbody tr:nth-child(-n+3)";
export default [
  { app: "jv", port: JV, route: "/personas", name: "cb-rest", clip: "table" },
  { app: "jv", port: JV, route: "/personas", name: "cb-checked", prep: check2, clip: "table" },
  { app: "jv", port: JV, route: "/personas", name: "cb-hover", hover: "tbody tr:nth-child(3) .ui-checkbox", clip: "tbody tr:nth-child(3)" },
  { app: "jv", port: JV, route: "/personas", name: "cb-focus", focus: "tbody tr:nth-child(3) .ui-checkbox", clip: "tbody tr:nth-child(3)" },
  { app: "jv", port: JV, route: "/personas", name: "cb-checked-dark", prep: `${check2}; ${dark}`, clip: "table" },
  { app: "jv", port: JV, route: "/personas", name: "cb-checked-accent", prep: `${check2}; ${accent}`, clip: "table" },
  { app: "jv", port: JV, route: "/captures", name: "cb-disabled", clip: ".captures__autopaste" },
  { app: "jw", port: JW, route: "/export", name: "cb-label", clip: ".ui-checkbox" },
  { app: "jw", port: JW, route: "/export", name: "cb-label-checked", prep: "document.querySelector('.ui-checkbox').click()", clip: ".ui-checkbox" },
  { app: "jv", port: JV, route: "/ai", name: "tg-off", clip: ".lu-warm-toggle" },
  { app: "jv", port: JV, route: "/ai", name: "tg-hover", hover: ".lu-warm-toggle .ui-toggle", clip: ".lu-warm-toggle" },
  { app: "jv", port: JV, route: "/ai", name: "tg-focus", focus: ".lu-warm-toggle .ui-toggle", clip: ".lu-warm-toggle" },
  { app: "jv", port: JV, route: "/ai", name: "tg-dark", prep: dark, clip: ".lu-warm-toggle" },
  { app: "dg", port: DG, route: "/settings/server", name: "tg-rows", clip: ".card, section" },
  { app: "dg", port: DG, route: "/settings/server", name: "tg-dark", prep: dark, clip: ".card, section" },
  { app: "jw", port: JW, route: "/ai", name: "tg-jw", clip: ".lu-warm-toggle" },
];
void rows;
