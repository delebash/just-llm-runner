<script setup>
// SPDX-License-Identifier: MIT
// Shared progress bar. Determinate when `max > 0` (fills to value/max and shows
// a %); indeterminate (animated sweep) when the total is unknown. Token-styled
// so it renders native in either app. The kit had no progress bar before this.
//
// Quasar's QLinearProgress underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md): it is the track (.ui-progress-track, the
// progressbar), its bar the fill, and the look is the kit's theme (../../quasar/theme.css,
// "Progress"). The ARIA values stay percentages (0–100) and the label names the bar, as before.
import { QLinearProgress } from "quasar";
import { computed } from "vue";

const props = defineProps({
  value: { type: Number, default: 0 }, // current amount (e.g. bytes downloaded)
  max: { type: Number, default: 0 }, // total (0 / unknown → indeterminate)
  label: { type: String, default: "" }, // caption shown at the left
  // Track only — no label/% head row. For dense per-row cells (a dashboard grid)
  // where the numbers already live beside the bar. Added 2026-08-04, replacing
  // the second hand-rolled bar the export gap had forced on a consumer.
  bare: { type: Boolean, default: false },
});

const pct = computed(() => {
  if (!props.max || props.max <= 0) return null; // unknown total
  return Math.max(0, Math.min(100, Math.round((props.value / props.max) * 100)));
});
</script>

<template>
  <div class="ui-progress">
    <div v-if="!bare && (label || pct !== null)" class="ui-progress-head">
      <span class="ui-progress-label">{{ label }}</span>
      <span v-if="pct !== null" class="ui-progress-pct">{{ pct }}%</span>
    </div>
    <QLinearProgress
      class="ui-progress-track"
      :class="{ 'ui-progress-track--indet': pct === null }"
      :value="pct === null ? 0 : pct / 100"
      :indeterminate="pct === null"
      :animation-speed="200"
      aria-valuemax="100"
      :aria-valuenow="pct === null ? undefined : pct"
      :aria-label="label || undefined"
    />
  </div>
</template>

<style scoped>
.ui-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.ui-progress-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  font-size: 0.78rem;
  color: var(--muted);
}
.ui-progress-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-progress-pct {
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
</style>
