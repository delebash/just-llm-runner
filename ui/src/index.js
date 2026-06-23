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

// primitives (token-driven; render native in any host that defines the tokens)
export { default as LuButton } from "./components/LuButton.vue";
export { default as LuCheckbox } from "./components/LuCheckbox.vue";
export { default as LuCombobox } from "./components/LuCombobox.vue";
export { default as LuInput } from "./components/LuInput.vue";
export { default as LuModelPicker } from "./components/LuModelPicker.vue";
export { default as LuSegmented } from "./components/LuSegmented.vue";
export { default as LuTextarea } from "./components/LuTextarea.vue";

// views
export { default as PromptLab } from "./views/PromptLab.vue";
export { default as ProviderForm } from "./views/ProviderForm.vue";
export { default as QuickSetup } from "./views/QuickSetup.vue";
export { default as RoutingPresets } from "./views/RoutingPresets.vue";
export { default as AiModelsArea } from "./views/AiModelsArea.vue";
export { default as FeatureWorkbench } from "./views/FeatureWorkbench.vue";
