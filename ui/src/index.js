// SPDX-License-Identifier: GPL-3.0-or-later
// Public entry for @delebash/llm-ui — the shared LLM provider / prompt / usage
// UI for JustVoice + JustWrite. Plain JS + Vue SFCs, consumed via a Vite alias
// to this src/ in both apps. Self-contained: the views call the SAME server
// endpoints both apps mount (via the host-configured origin-aware client) and
// ship their own token-driven styles — no per-app data adapter, no host
// components. The host calls configureLlmUi({ baseUrl }) once at boot.

import "./styles.css";

// client — the host calls configureLlmUi({ baseUrl }) once at boot
export { configureLlmUi, llmUiBase, llmUiUrl, request, requestStream } from "./client.js";

// shared general primitives — the future @delebash/ui (housed in ./common for
// now). Ui* supersede the per-app Jw*/Jv*/Lu*. Re-exporting also loads
// common/styles.css (the .ui-* rules).
export { UiButton, UiInput, UiTextarea, UiCheckbox, UiTag, UiSegmented, UiToggle, UiField } from "./common/index.js";
export { useRovingTabindex } from "./common/composables/useRovingTabindex.js";

// llm-ui-specific primitives still local (Select pending convergence)
export { default as LuCombobox } from "./components/LuCombobox.vue";
export { default as LuModelPicker } from "./components/LuModelPicker.vue";

// views
export { default as PromptLab } from "./views/PromptLab.vue";
export { default as ProviderForm } from "./views/ProviderForm.vue";
export { default as QuickSetup } from "./views/QuickSetup.vue";
export { default as RoutingPresets } from "./views/RoutingPresets.vue";
export { default as AiModelsArea } from "./views/AiModelsArea.vue";
export { default as FeatureWorkbench } from "./views/FeatureWorkbench.vue";
