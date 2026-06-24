// SPDX-License-Identifier: GPL-3.0-or-later
// @delebash/ui (for now housed inside @delebash/llm-ui at ui/src/common/) —
// general, app-agnostic UI primitives shared by ALL Vue apps. Token-driven; the
// host app defines the design tokens (this layer ships safe fallbacks). When this
// graduates to its own repo, this folder moves out wholesale and llm-ui imports
// it as a dependency — nothing here may import from ../ (the llm layer).
import "./styles.css";

export { default as UiButton } from "./components/UiButton.vue";
export { default as UiInput } from "./components/UiInput.vue";
export { default as UiTextarea } from "./components/UiTextarea.vue";
export { default as UiCheckbox } from "./components/UiCheckbox.vue";
export { default as UiTag } from "./components/UiTag.vue";
export { default as UiChip } from "./components/UiChip.vue";
export { default as UiSelect } from "./components/UiSelect.vue";
export { default as UiSegmented } from "./components/UiSegmented.vue";
export { default as UiToggle } from "./components/UiToggle.vue";
export { default as UiField } from "./components/UiField.vue";

// shared app-shell components + services (app-agnostic; host provides tokens/router)
export { default as Icon } from "./components/Icon.vue";
export { default as Breadcrumb } from "./components/Breadcrumb.vue";
export { promptDialog, confirmDialog, dialogState, _resolveDialog } from "./services/dialog.js";
export { tooltipDirective } from "./services/tooltip.js";

// shared in-app Help system — drawer + "?" trigger + open-state/config + the
// docs markdown renderer. The host supplies the docs content via configureHelp().
export { default as HelpDrawer } from "./components/HelpDrawer.vue";
export { default as HelpTrigger } from "./components/HelpTrigger.vue";
export { configureHelp, openHelp, closeHelp, helpState, helpConfig } from "./services/help.js";
export { renderHelpMarkdown, slugifyHeading } from "./services/helpMarkdown.js";

// shared toast host + imperative bridge (vue-sonner under the hood)
export { default as Toast } from "./components/Toast.vue";
export { pushToast, clearToasts } from "./services/toastBridge.js";

// shared empty-state placeholder
export { default as EmptyState } from "./components/EmptyState.vue";

// shared boot-time "can't reach the server" screen (host passes brand + URL)
export { default as ConnectionError } from "./components/ConnectionError.vue";

// shared composables (host-agnostic; vue-only)
export { useRovingTabindex } from "./composables/useRovingTabindex.js";
