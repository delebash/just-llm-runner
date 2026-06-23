// SPDX-License-Identifier: GPL-3.0-or-later
// @delebash/ui (for now housed inside @delebash/llm-ui at ui/src/common/) —
// general, app-agnostic UI primitives shared by ALL Vue apps. Token-driven; the
// host app defines the design tokens (this layer ships safe fallbacks). When this
// graduates to its own repo, this folder moves out wholesale and llm-ui imports
// it as a dependency — nothing here may import from ../ (the llm layer).
import "./styles.css";

export { default as UiButton } from "./components/UiButton.vue";
