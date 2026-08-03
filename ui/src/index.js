// SPDX-License-Identifier: MIT
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
export { default as ConsolePanel } from "./components/ConsolePanel.vue";
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

// the model-picker family (C5) — THE shared per-provider model-list cache
// (one cache + one endpoint accessor kit-wide; LuModelPicker rides it too),
// the presentational per-feature routing chip (host owns state via
// props/events + the #foot slot), and the embeddings client (ensure-resident
// for the bundled runner + POST /v1/ai/embeddings).
export { useProviderModels } from "./composables/useProviderModels.js";
export { useResolvedRoute } from "./composables/useResolvedRoute.js";
// The catalog-meta composable (quality order, PC-class configs, VRAM fit) — exported so
// an APP-LOCAL setup wizard can rank models without forking QuickSetup (2026-08-03: the
// i18n app's thin wizard; the family pattern is machinery in the kit, wizards per app).
export { useCatalogMeta } from "./composables/useCatalogMeta.js";
export { default as LuFeatureChip } from "./components/LuFeatureChip.vue";
export { ensureEmbeddingReady, embedTexts, _resetEnsureCache } from "./services/embedApi.js";
// The shared runner-models singleton — `refresh` (re-stat the catalog out-of-band, e.g.
// JustWrite's "Clear models cache") and the whole `useRunnerModels()` accessor so a host
// can reuse the SAME load path the model catalog uses (retryLoad → POST /v1/llm-runner/load,
// taskFor(id) → the DownloadBar-shaped live progress). JustWrite's warm-on-startup rides
// this — no second load impl.
export { refresh as refreshRunnerModels, useRunnerModels } from "./composables/useRunnerModels.js";
// The shared applied-default resolver — currentDefaultId is the default LOCAL chat model
// (empty when the default provider isn't the local runner). Same source as the catalog's
// Default badge; the host reads it to know WHICH model to warm.
export { useModelApply } from "./services/modelApply.js";
// THE one download bar — a host boot/loading surface reuses it to render a model LOAD
// (via useRunnerModels().taskFor(id)) instead of forking the control.
export { default as DownloadBar } from "./common/components/DownloadBar.vue";

// views
export { default as ProviderForm } from "./views/ProviderForm.vue";
export { default as QuickSetup } from "./views/QuickSetup.vue";
export { default as AiModelsArea } from "./views/AiModelsArea.vue";
export { default as FeatureWorkbench } from "./views/FeatureWorkbench.vue";
