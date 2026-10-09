// Slice 6's states: the tab strip (JustWrite's one row, JustVoice's two), the segmented control
// (JustWrite's connected Appearance rows and icon toggle, the AI scope, JustVoice's small persona
// filters), the slider (JustVoice's Generation settings and persona knobs), the progress bar
// (docgen's dashboard) and the colour picker (JustWrite's project colours) — at rest, hovered,
// keyboard-focused, dark, another accent, open.
const JW = [8781, 8782];
const JV = [8783, 8784];
const DG = [8785, 8786];
const dark = "document.documentElement.setAttribute('data-theme', 'dark')";
const accent = "document.documentElement.style.setProperty('--accent', 'oklch(0.62 0.17 30)'); document.documentElement.style.setProperty('--accent-soft', 'oklch(0.94 0.04 30)')";
const tab = (t) => `[...document.querySelectorAll('.ui-tabstrip__tab')].find((b) => b.textContent.trim() === '${t}').click()`;
const and = (...js) => js.join("; ");
const persona = "/personas/persona_391625bf20db492d9ffc22855d12eef8";
const rangeFocus = "input.ui-slider-range, .ui-slider-range .q-slider__track-container";
const sliderRow = ".setting-row:has(.ui-slider)";
export default [
  { app: "jw", port: JW, route: "/settings", name: "strip-rest", clip: ".ui-tabstrip" },
  { app: "jw", port: JW, route: "/settings", name: "strip-hover", hover: ".ui-tabstrip__tab:nth-child(3)", clip: ".ui-tabstrip" },
  { app: "jw", port: JW, route: "/settings", name: "strip-kbfocus", focus: ".ui-tabstrip__tab:nth-child(2)", clip: ".ui-tabstrip" },
  { app: "jw", port: JW, route: "/settings", name: "strip-dark", prep: dark, clip: ".ui-tabstrip" },
  { app: "jw", port: JW, route: "/settings", name: "strip-other", prep: tab("Appearance"), clip: ".ui-tabstrip" },
  { app: "jw", port: JW, route: "/settings", name: "seg-rest", prep: tab("Appearance"), clip: ".ui-seg" },
  { app: "jw", port: JW, route: "/settings", name: "seg-hover", prep: tab("Appearance"), hover: ".ui-seg button:nth-child(4)", clip: ".ui-seg" },
  { app: "jw", port: JW, route: "/settings", name: "seg-kbfocus", prep: tab("Appearance"), focus: ".ui-seg button.active", clip: ".ui-seg" },
  { app: "jw", port: JW, route: "/settings", name: "seg-dark", prep: and(dark, tab("Appearance")), clip: ".ui-seg" },
  { app: "jw", port: JW, route: "/settings", name: "seg-accent", prep: and(accent, tab("Appearance")), clip: ".ui-seg" },
  { app: "jw", port: JW, route: "/settings", name: "seg-all", prep: tab("Appearance"), clip: ".setting-row:has(.ui-seg) ~ .setting-row:has(.ui-seg)" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "segtoggle-rest", clip: ".seg-toggle" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "segtoggle-hover", hover: ".seg-toggle button:nth-child(2)", clip: ".seg-toggle" },
  { app: "jw", port: JW, route: "/chapters/ch1", name: "segtoggle-kbfocus", focus: ".seg-toggle button.active", clip: ".seg-toggle" },
  { app: "jw", port: JW, route: "/ai", name: "scope-rest", clip: ".lu-scope" },
  { app: "jw", port: JW, route: "/ai", name: "scope-hover", hover: ".lu-scope button:nth-child(2)", clip: ".lu-scope" },
  { app: "jw", port: JW, route: "/ai", name: "scope-dark", prep: dark, clip: ".lu-scope" },
  { app: "jw", port: JW, route: "/settings", name: "color-rest", clip: ".ui-color-picker" },
  { app: "jw", port: JW, route: "/settings", name: "color-hover", hover: ".ui-color-swatch", clip: ".ui-color-picker" },
  { app: "jw", port: JW, route: "/settings", name: "color-open-swatch", click: ".ui-color-swatch", clip: ".ui-color-picker" },
  { app: "jw", port: JW, route: "/settings", name: "color-open-pop", click: ".ui-color-swatch", clip: ".ui-color-pop" },
  { app: "jw", port: JW, route: "/settings", name: "color-open-hover", click: ".ui-color-swatch", hover: ".ui-color-pop .ui-color-preset:nth-child(3)", clip: ".ui-color-pop" },
  { app: "jw", port: JW, route: "/settings", name: "color-open-custom-hover", click: ".ui-color-swatch", hover: ".ui-color-pop .ui-color-custom", clip: ".ui-color-pop" },
  { app: "jw", port: JW, route: "/settings", name: "color-open-dark", prep: dark, click: ".ui-color-swatch", clip: ".ui-color-pop" },
  { app: "jv", port: JV, route: "/settings", name: "strip-rest", clip: ".ui-tabstrip" },
  { app: "jv", port: JV, route: "/settings", name: "strip-row2", prep: tab("Cache"), clip: ".ui-tabstrip" },
  { app: "jv", port: JV, route: "/settings", name: "strip-row2-hover", prep: tab("Cache"), hover: ".ui-tabstrip__tab:nth-child(17)", clip: ".ui-tabstrip" },
  { app: "jv", port: JV, route: "/settings", name: "slider-rest", prep: tab("Generation"), clip: sliderRow },
  { app: "jv", port: JV, route: "/settings", name: "slider-hover", prep: tab("Generation"), hover: ".ui-slider-range", clip: sliderRow },
  { app: "jv", port: JV, route: "/settings", name: "slider-kbfocus", prep: tab("Generation"), focus: rangeFocus, clip: sliderRow },
  { app: "jv", port: JV, route: "/settings", name: "slider-dark", prep: and(dark, tab("Generation")), clip: sliderRow },
  { app: "jv", port: JV, route: "/settings", name: "slider-accent", prep: and(accent, tab("Generation")), clip: sliderRow },
  { app: "jv", port: JV, route: "/settings", name: "slider-section", prep: tab("Generation"), clip: ".jv-section:has(.ui-slider)" },
  { app: "jv", port: JV, route: persona, name: "seg-small-rest", clip: ".ui-seg--small" },
  { app: "jv", port: JV, route: persona, name: "seg-small-hover", hover: ".ui-seg--small button:nth-child(2)", clip: ".ui-seg--small" },
  { app: "jv", port: JV, route: persona, name: "seg-small-kbfocus", focus: ".ui-seg--small button.active", clip: ".ui-seg--small" },
  { app: "jv", port: JV, route: persona, name: "seg-kind", clip: ".ui-seg--small ~ .ui-seg--small, div:has(> .ui-seg--small) ~ div .ui-seg--small" },
  { app: "jv", port: JV, route: persona, name: "knob-rest", clip: ".ui-slider" },
  { app: "jv", port: JV, route: persona, name: "knob-hover", hover: ".ui-slider-range", clip: ".ui-slider" },
  { app: "dg", port: DG, route: "/", name: "progress-rest", clip: ".ui-progress" },
  { app: "dg", port: DG, route: "/", name: "progress-dark", prep: dark, clip: ".ui-progress" },
];
