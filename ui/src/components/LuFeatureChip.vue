<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// LuFeatureChip — the read-only "runs on" provenance chip for ONE AI feature
// (C5; the GUI moved from JustWrite's AiFeatureChip). PRESENTATIONAL on
// purpose — the host owns state (the LuModelPicker precedent): the resolved
// provider + model names arrive as props (the host reads useResolvedRoute —
// the server-resolved task-preset route); clicking emits `navigate` and the
// HOST routes to its Tasks tab, the only routing editor.
//
// QC-26 (#224, 2026-07-09): the click-to-edit popover/pin mode was DELETED
// outright — per-surface pickers were removed structurally in B5-1 (§7.2)
// and every mount in both apps rendered the chip read-only, so the edit mode
// (pin props, provider/model selects, refresh, backdrop, Esc handling) was
// dead code. The chip now has exactly one mode: provenance.

import Icon from "../common/components/Icon.vue";

const props = defineProps({
  // Feature key, for aria/copy only (e.g. "writerAI", "critique").
  feature: { type: String, required: true },
  // Optional inline label ("Rewrite", "Critique"). Omitted → "Runs on ·" lead
  // unless `compact`.
  label: { type: String, default: "" },
  compact: { type: Boolean, default: false },
  // Host-resolved display values (the task-preset resolution already applied).
  resolvedProviderName: { type: String, default: "—" },
  resolvedModel: { type: String, default: "—" },
});
const emit = defineEmits(["navigate"]);
</script>

<template>
  <button class="afc-chip" @click.stop="emit('navigate')"
    v-tooltip.bottom="`Runs on the ${label || feature} task's model — manage it under Routing by task`">
    <template v-if="label">
      <span class="afc-label">{{ label }}</span>
      <span class="afc-sep">·</span>
    </template>
    <template v-else-if="!compact">
      <span class="afc-label">Runs on</span>
      <span class="afc-sep">·</span>
    </template>
    <b class="afc-provider">{{ resolvedProviderName }}</b>
    <span class="afc-sep">·</span>
    <code class="afc-model">{{ resolvedModel }}</code>
    <Icon name="ChevRight" :size="9" class="afc-caret" />
  </button>
</template>

<style scoped>
.afc-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  font-size: 11.5px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  line-height: 1.3;
  white-space: nowrap;
}
.afc-chip:hover { background: var(--surface-2); border-color: var(--border-strong); }

.afc-label    { color: var(--muted); font-weight: 500; }
.afc-sep      { color: var(--muted); opacity: 0.6; }
.afc-provider { font-weight: 600; }
.afc-model {
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  color: var(--ink-2);
  background: transparent;
}
.afc-caret { color: var(--muted); margin-left: 2px; flex-shrink: 0; }
</style>
