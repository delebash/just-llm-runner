// SPDX-License-Identifier: GPL-3.0-or-later
// Public entry for @delebash/llm-ui — the shared LLM provider / prompt / usage
// UI for JustVoice + JustWrite. Plain JS + Vue SFCs, consumed via a Vite alias
// to this src/ in both apps. Self-contained: the views call the SAME server
// endpoints both apps mount (via the host-configured origin-aware client) and
// ship their own token-driven styles — no per-app data adapter, no host
// components. The host calls configureLlmUi({ baseUrl }) once at boot.

import "./styles.css";

// client — the host calls configureLlmUi({ baseUrl }) once at boot. (request/
// requestStream stay internal to the kit's LLM views via ./client.js relative
// imports; the public `request` is the shared serverApi transport below.)
export { configureLlmUi, llmUiBase, llmUiUrl, requestBlob, postForm } from "./client.js";

// shared general primitives + shells + services — the future @delebash/ui
// (housed in ./common for now): Ui* primitives, Icon/Breadcrumb, dialog/tooltip,
// the Help system, Toast, EmptyState, ConnectionError, the serverApi transport,
// and the appearance engine. Re-exporting also loads common/styles.css.
export * from "./common/index.js";

// llm-ui-specific primitives still local (model picker/combobox)
export { default as LuCombobox } from "./components/LuCombobox.vue";
export { default as LuModelPicker } from "./components/LuModelPicker.vue";
export { default as DataManagement } from "./components/DataManagement.vue";
export { default as LogsPanel } from "./components/LogsPanel.vue";
export { default as UpdatesPanel } from "./components/UpdatesPanel.vue";

// the shared AI task queue (Decision 22) — the global in-flight registry
// (Pinia; the host provides the active Pinia — `pinia` is a peer dep), the
// run/stream feature wrappers over the kit client, the provider-error
// humanizer, and the strip / panel / header-chip surfaces.
export { useAiTasksStore } from "./stores/aiTasks.js";
export { runAiFeature, runAiFeatureStream } from "./services/aiFeature.js";
export { friendlyAiError } from "./services/aiErrors.js";
export { default as AiTaskStrip } from "./components/AiTaskStrip.vue";
export { default as AiStatusPanel } from "./components/AiStatusPanel.vue";
export { default as AiStatusButton } from "./components/AiStatusButton.vue";

// views
export { default as PromptLab } from "./views/PromptLab.vue";
export { default as ProviderForm } from "./views/ProviderForm.vue";
export { default as QuickSetup } from "./views/QuickSetup.vue";
export { default as AiModelsArea } from "./views/AiModelsArea.vue";
export { default as FeatureWorkbench } from "./views/FeatureWorkbench.vue";
