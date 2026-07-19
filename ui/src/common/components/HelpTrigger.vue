<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  HelpTrigger — the small "?" affordance that opens the shared HelpDrawer
  scoped to a doc slug. Rendered automatically by a pane header (its `helpKey`
  prop) or embedded inline next to any control. App-agnostic; token-driven;
  supersedes the per-app HelpTrigger.vue forks.

  Props:
    slug  — doc filename (no .md), optionally with a section anchor:
            "voices", "voices#cloning". See the host's docs/toc.json for the
            canonical slug list; section anchors follow GitHub-style slug rules.
    label — overrides the tooltip's "what surface this opens" half.

  Requires the host to register the `tooltip` directive globally
  (app.directive("tooltip", tooltipDirective) — both apps already do).
-->
<script setup>
import { computed } from "vue";
import Icon from "./Icon.vue";
import { toggleHelp, helpConfig } from "../services/help.js";

const props = defineProps({
  slug: { type: String, required: true },
  label: { type: String, default: "" },
});

const slugOnly = computed(() => String(props.slug || "").split("#")[0]);
const tooltipText = computed(
  () => `Help — ${props.label || helpConfig.titleForSlug(slugOnly.value)}`,
);

function open() {
  // toggleHelp accepts the convenience form "slug#anchor" and splits it. A
  // second click on the SAME trigger closes the drawer (user ruling
  // 2026-07-19 — nav triggers open AND close, like chat's).
  toggleHelp(props.slug);
}
</script>

<template>
  <button
    type="button"
    class="help-trigger"
    data-panel-toggle
    :aria-label="tooltipText"
    v-tooltip.bottom="tooltipText"
    @click="open">
    <Icon name="Help" :size="16" />
  </button>
</template>

<style scoped>
.help-trigger {
  appearance: none;
  background: transparent;
  width: 26px;
  height: 26px;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  cursor: pointer;
  color: var(--muted);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.help-trigger:hover {
  background: var(--hover, var(--surface-2));
  border-color: var(--border-strong);
  color: var(--ink);
}
.help-trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
