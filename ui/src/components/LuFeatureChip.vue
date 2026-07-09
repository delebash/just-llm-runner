<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// LuFeatureChip — the click-to-edit chip showing the resolved provider + model
// for ONE AI feature, with a popover to pin/inherit (C5; the GUI moved from
// JustWrite's AiFeatureChip). PRESENTATIONAL on purpose — the host owns state
// (the LuModelPicker precedent): resolved names, pin values, and the option
// lists arrive as props; picks leave as events; the host interprets its own
// inherit sentinel and writes its own routing store. The `#foot` slot carries
// the host's "manage all routing" link (the kit doesn't import a router).
//
// Two states only:
//   - inherit → no pin; the chip shows the host-resolved default provider+model.
//   - pinned  → the chip tints and shows the pinned provider+model.
//
// READONLY mode (B5-1, §7.2 — per-surface pickers removed): `readonly` turns
// the chip into a pure "runs on" provenance chip. No popover, no pin state —
// clicking emits `navigate` and the HOST routes to its Tasks tab (the only
// editor). The resolved provider+model props then carry the task-preset
// resolution (the host reads useResolvedRoute), not pin state.

import { ref, onMounted, onBeforeUnmount, nextTick } from "vue";
import Icon from "../common/components/Icon.vue";
import UiSelect from "../common/components/UiSelect.vue";

const props = defineProps({
  // Feature key, for aria/copy only (e.g. "writerAI", "critique").
  feature: { type: String, required: true },
  // Optional inline label ("Rewrite", "Critique"). Omitted → "Engine ·" lead
  // unless `compact`.
  label: { type: String, default: "" },
  compact: { type: Boolean, default: false },
  // Read-only provenance mode (§7.2): no popover; click emits `navigate`.
  readonly: { type: Boolean, default: false },
  // Host-resolved display values (the fallback-to-default already applied).
  resolvedProviderName: { type: String, default: "—" },
  resolvedModel: { type: String, default: "—" },
  // Pin state. `pinnedProviderId` is the value for the provider select — the
  // host maps its inherit sentinel into it (and back on the event).
  pinned: { type: Boolean, default: false },
  pinnedProviderId: { type: String, default: "" },
  pinnedModel: { type: String, default: "" },
  providerOptions: { type: Array, default: () => [] },
  modelOptions: { type: Array, default: () => [] },
});
const emit = defineEmits(["select-provider", "select-model", "refresh", "navigate"]);

// Popover state + dismissal (Esc, chip toggle, transparent backdrop).
const open = ref(false);

async function toggle() {
  if (props.readonly) {
    // Provenance chip — the host routes to its Tasks tab (the only editor).
    emit("navigate");
    return;
  }
  open.value = !open.value;
  if (open.value && props.pinned) {
    // Refresh the model list whenever the popover opens with a pinned
    // provider — a lazy cache skips after a failed attempt, so we'd see
    // "no models" forever without this.
    emit("refresh");
    await nextTick();
  }
}

function onDocKey(e) {
  if (e.key === "Escape" && open.value) { open.value = false; e.stopPropagation(); }
}
onMounted(() => {
  document.addEventListener("keydown", onDocKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onDocKey);
});
</script>

<template>
  <span class="afc-wrap">
    <button class="afc-chip" :class="{ pinned: pinned && !readonly, open }" @click.stop="toggle"
      v-tooltip.bottom="readonly
        ? `Runs on the ${label || feature} task's model — manage it on the Tasks tab`
        : `Click to change provider or model for ${label || feature}`">
      <template v-if="label">
        <span class="afc-label">{{ label }}</span>
        <span class="afc-sep">·</span>
      </template>
      <template v-else-if="!compact">
        <span class="afc-label">{{ readonly ? "Runs on" : "Engine" }}</span>
        <span class="afc-sep">·</span>
      </template>
      <b class="afc-provider">{{ resolvedProviderName }}</b>
      <span class="afc-sep">·</span>
      <code class="afc-model">{{ resolvedModel }}</code>
      <Icon :name="readonly ? 'ChevRight' : 'ChevDown'" :size="9" class="afc-caret" />
    </button>

    <!-- Transparent backdrop. Lives inline (not teleported) so it shares
         the chip's stacking context — that way its z-index 69 is just
         below the popover's z-index 70 and standard hit-testing keeps
         popover clicks on the popover. The Reka SelectContent portals
         to body at z-index 999 and sits above everything either way,
         so its own clicks never reach the backdrop. -->
    <div v-if="open" class="afc-backdrop" @click="open = false" />

    <div v-if="open" class="afc-pop" role="dialog" :aria-label="`Routing for ${label || feature}`"
      @click.stop @mousedown.stop>
      <div class="afc-pop-head">
        <span class="afc-pop-eyebrow">Routing for</span>
        <span class="afc-pop-feature">{{ label || feature }}</span>
      </div>

      <div class="afc-pop-row">
        <label class="afc-pop-label">Provider</label>
        <UiSelect
          :model-value="pinnedProviderId"
          @update:model-value="emit('select-provider', $event)"
          :options="providerOptions" />
      </div>

      <div class="afc-pop-row">
        <label class="afc-pop-label">Model</label>
        <span class="afc-pop-model-wrap">
          <UiSelect
            :model-value="pinnedModel"
            @update:model-value="emit('select-model', $event)"
            :options="modelOptions"
            :disabled="!pinned"
            :placeholder="pinned ? 'Pick a model' : 'Follows default'" />
          <button class="afc-refresh"
            v-tooltip.bottom="pinned ? 'Refresh model list from the provider' : 'Pin to a specific provider first'"
            :disabled="!pinned"
            @click.stop="emit('refresh')">
            <Icon name="Refresh" :size="11" />
          </button>
        </span>
      </div>

      <div class="afc-pop-foot">
        <slot name="foot" :close="() => (open = false)" />
      </div>
    </div>
  </span>
</template>

<style scoped>
.afc-wrap { position: relative; display: inline-flex; }

/* Full-viewport transparent backdrop. Sits BEHIND the popover (z-index
   70) but in front of all page chrome — clicks that aren't on the
   popover or a Reka portal land here and dismiss. Reka SelectContent at
   z-index 999 stays above this and intercepts its own clicks normally. */
.afc-backdrop {
  position: fixed;
  inset: 0;
  z-index: 69;
  background: transparent;
}

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
.afc-chip.pinned { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent-ink); }
.afc-chip.open   { border-color: var(--accent); background: var(--accent-soft); }

.afc-label    { color: var(--muted); font-weight: 500; }
.afc-chip.pinned .afc-label { color: var(--accent-ink); opacity: 0.85; }
.afc-sep      { color: var(--muted); opacity: 0.6; }
.afc-provider { font-weight: 600; }
.afc-model {
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  color: var(--ink-2);
  background: transparent;
}
.afc-chip.pinned .afc-model { color: var(--accent-ink); }
.afc-caret { color: var(--muted); margin-left: 2px; }

/* Popover — anchored to the wrap with absolute positioning; right edge
   aligned to the chip's right edge so it doesn't overflow when the chip
   is near the page edge. */
.afc-pop {
  position: absolute;
  top: calc(100% + 6px); right: 0;
  z-index: 70;
  min-width: 280px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  display: flex; flex-direction: column;
  gap: 10px;
}
.afc-pop-head {
  display: flex; flex-direction: column; gap: 2px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-soft);
}
.afc-pop-eyebrow {
  font-family: var(--font-mono, monospace); font-size: 9.5px;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--muted); font-weight: 600;
}
.afc-pop-feature { font-size: 13px; font-weight: 600; color: var(--ink); }

.afc-pop-row { display: flex; flex-direction: column; gap: 4px; }
.afc-pop-label {
  font-family: var(--font-mono, monospace); font-size: 10px;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); font-weight: 500;
}
.afc-pop-model-wrap { display: flex; align-items: center; gap: 6px; }
.afc-pop-model-wrap > :first-child { flex: 1; min-width: 0; }
.afc-refresh {
  display: grid; place-items: center;
  width: 26px; height: 26px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
}
.afc-refresh:hover:not(:disabled) { background: var(--surface-2); color: var(--ink-2); }
.afc-refresh:disabled { opacity: 0.4; cursor: not-allowed; }

.afc-pop-foot {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.45;
  padding-top: 6px;
  border-top: 1px solid var(--border-soft);
}
.afc-pop-foot :deep(a) { color: var(--accent-ink); text-decoration: none; }
.afc-pop-foot :deep(a:hover) { text-decoration: underline; }
</style>
