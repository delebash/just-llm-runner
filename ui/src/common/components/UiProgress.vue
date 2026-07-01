<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared progress bar. Determinate when `max > 0` (fills to value/max and shows
// a %); indeterminate (animated sweep) when the total is unknown. Token-styled
// so it renders native in either app. The kit had no progress bar before this.
import { computed } from "vue";

const props = defineProps({
  value: { type: Number, default: 0 }, // current amount (e.g. bytes downloaded)
  max: { type: Number, default: 0 }, // total (0 / unknown → indeterminate)
  label: { type: String, default: "" }, // caption shown at the left
});

const pct = computed(() => {
  if (!props.max || props.max <= 0) return null; // unknown total
  return Math.max(0, Math.min(100, Math.round((props.value / props.max) * 100)));
});
</script>

<template>
  <div class="ui-progress">
    <div v-if="label || pct !== null" class="ui-progress-head">
      <span class="ui-progress-label">{{ label }}</span>
      <span v-if="pct !== null" class="ui-progress-pct">{{ pct }}%</span>
    </div>
    <div
      class="ui-progress-track"
      :class="{ 'ui-progress-track--indet': pct === null }"
      role="progressbar"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="pct === null ? undefined : pct"
      :aria-label="label || undefined"
    >
      <div
        class="ui-progress-fill"
        :style="pct !== null ? { width: `${pct}%` } : undefined"
      />
    </div>
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
.ui-progress-track {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: var(--surface-2, var(--border));
  overflow: hidden;
}
.ui-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.2s ease;
}
/* Unknown total → an indeterminate sweep. */
.ui-progress-track--indet .ui-progress-fill {
  width: 35%;
  animation: ui-progress-indet 1.1s ease-in-out infinite;
}
@keyframes ui-progress-indet {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(320%); }
}
</style>
