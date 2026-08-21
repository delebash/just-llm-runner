// SPDX-License-Identifier: MIT
// @delebash/ui (for now housed inside @delebash/llm-ui at ui/src/common/) —
// general, app-agnostic UI primitives shared by ALL Vue apps. Token-driven; the
// host app defines the design tokens (this layer ships safe fallbacks). When this
// graduates to its own repo, this folder moves out wholesale and llm-ui imports
// it as a dependency — nothing here may import from ../ (the llm layer).
import "./styles.css";

export { default as UiButton } from "./components/UiButton.vue";
export { default as UiInput } from "./components/UiInput.vue";
export { default as UiSecretInput } from "./components/UiSecretInput.vue";
export { default as UiTextarea } from "./components/UiTextarea.vue";
export { default as UiCheckbox } from "./components/UiCheckbox.vue";
export { default as UiTag } from "./components/UiTag.vue";
export { default as UiChip } from "./components/UiChip.vue";
export { default as UiSelect } from "./components/UiSelect.vue";
// Multi-select on Popover+Listbox — born for the i18n target-languages picker,
// generic on purpose (2026-08-02 ruling: new capabilities land in the KIT, never an app).
export { default as UiMultiSelect } from "./components/UiMultiSelect.vue";
export { default as UiNumber } from "./components/UiNumber.vue";
export { default as UiTable } from "./components/UiTable.vue";
// The shared progress bar — was kit-internal only (DownloadBar/QuickSetup), which
// forced consumers to hand-roll their own (found 2026-08-04: two differing local
// bars in one app). Exported so no app ever needs a private progress control.
export { default as UiProgress } from "./components/UiProgress.vue";
export { default as UiColorPicker } from "./components/UiColorPicker.vue";
export { default as UiSegmented } from "./components/UiSegmented.vue";
// THE slider (2026-08-21). There was none, so 14 hand-rolled `<input
// type="range">` grew across the family, each with its own width, its own
// place for the number, and nowhere to say what the ends mean.
export { default as UiSlider } from "./components/UiSlider.vue";
export { default as UiToggle } from "./components/UiToggle.vue";
export { default as UiField } from "./components/UiField.vue";

// shared app-shell components + services (app-agnostic; host provides tokens/router)
export { default as Icon } from "./components/Icon.vue";
export { default as Breadcrumb } from "./components/Breadcrumb.vue";
// The eyebrow+H1 pane header (lifted from JW 2026-08-04 — both apps had invented
// their own). helpKey pins the "?" HelpTrigger far right.
export { default as PaneHeader } from "./components/PaneHeader.vue";
// The Settings chrome — top tab strip + content (the family shape; lifted from JW).
export { default as SettingsShell } from "./components/SettingsShell.vue";
// SettingsShell's strip, on its own — for a view that owns its own scroller and
// would inherit a second one by taking the whole shell.
export { default as UiTabStrip } from "./components/UiTabStrip.vue";
export { promptDialog, confirmDialog, dialogState, _resolveDialog, configureDialog, dialogLabels } from "./services/dialog.js";
// THE one reactive labels store behind kit chrome (dialog verbs, AI tabs, download-bar
// actions, connection-error copy) + its ONE door. An i18n'd host re-feeds it at boot
// and on every locale switch; single-locale hosts never call it (English canon).
export { familyLabels, configureFamilyLabels } from "./services/familyLabels.js";
export { tooltipDirective } from "./services/tooltip.js";

// shared in-app Help system — drawer + "?" trigger + open-state/config + the
// docs markdown renderer. The host supplies the docs content via configureHelp().
export { default as HelpDrawer } from "./components/HelpDrawer.vue";
export { default as HelpTrigger } from "./components/HelpTrigger.vue";
export { configureHelp, openHelp, closeHelp, toggleHelp, helpState, helpConfig } from "./services/help.js";
export { makeDocsHelpAdapter } from "./services/helpDocs.js";
export { renderHelpMarkdown, slugifyHeading } from "./services/helpMarkdown.js";

// shared toast host + imperative bridge (vue-sonner under the hood)
export { default as Toast } from "./components/Toast.vue";
export { pushToast, clearToasts } from "./services/toastBridge.js";

// shared external-link opener — kit anchors route clicks through openExternal;
// the host wires its shell bridge via configureExternal (Tauri swallows _blank).
// openPath/canOpenPath are the same seam for LOCAL folders ("Open folder").
export { configureExternal, openExternal, openPath, canOpenPath, isTauriShell } from "./services/external.js";

// THE one door for putting a file on the user's disk — native dialog when the
// host wired one, browser download otherwise. Every export in every app.
export { configureFileSave, saveBlob, downloadBlob, canSaveNatively } from "./services/fileSave.js";

// the Lab test-data registry (§7.3 + QC-35) — the host registers its listable
// material (JW: chapters/characters) AND a per-action affordance declaration
// map (pickers / "From this book" compose / applicable sample labels)
export { configureTestData, testDataSources, testDataAction, mergeVariables } from "./services/testData.js";

// shared empty-state placeholder
export { default as EmptyState } from "./components/EmptyState.vue";

// shared modal shell (Reka Dialog; self-contained token-driven styles) + the
// imperative prompt/confirm host built on it (driven by services/dialog.js)
export { default as AppModal } from "./components/AppModal.vue";
export { default as AppDialog } from "./components/AppDialog.vue";

// shared boot-time "can't reach the server" screen (host passes brand + URL)
export { default as ConnectionError } from "./components/ConnectionError.vue";

// shared server transport — the single fetch layer (host calls
// configureServerApi({ resolveBase, authToken }) once at boot)
export {
  configureServerApi, makeOriginAwareResolver, serverUrl, url, lastError,
  request, get, post, patch, put, del, requestBlob, postForm, safeRequest, checkServer,
} from "./services/serverApi.js";

// shared appearance/theming engine + catalogs (host calls applyAppearance at boot)
export * from "./services/appearance.js";

// shared UI locale (BCP-47 tag for UiNumber's Intl formatting; host drives it)
export { uiLocale, setUiLocale } from "./services/locale.js";

// shared language CODE → readable NAME (Intl.DisplayNames, follows uiLocale).
// Every app shows language somewhere and each was about to grow its own map;
// `en-US` reads as "American English", not as a code (2026-08-21).
export { languageName, languageOptionsFrom, useLanguageNames } from "./services/languageNames.js";

// shared byte formatter (DL-1) — the ONE size-label formatter, so a disk-usage /
// download surface in either app renders bytes identically.
export { fmtBytes } from "./services/downloadRate.js";

// shared composables (host-agnostic; vue-only)
export { useRovingTabindex } from "./composables/useRovingTabindex.js";
export { usePanelDismiss, PANEL_TOGGLE_ATTR } from "./composables/usePanelDismiss.js";
