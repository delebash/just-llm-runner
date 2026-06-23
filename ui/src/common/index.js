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

// shared composables (host-agnostic; vue-only)
export { useRovingTabindex } from "./composables/useRovingTabindex.js";
