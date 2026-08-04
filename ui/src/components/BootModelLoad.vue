<script setup>
// SPDX-License-Identifier: MIT
// THE boot-time loading-model control (2026-08-04 ruling: "the loading model ui
// control should be [in the kit] and the app mounts it on its own splash page").
// Renders the SAME shared DownloadBars every load surface uses — the engine-install
// bar while the gate runs, then the model's load bar TITLED WITH THE MODEL NAME
// (shared behavior: every consumer shows which model is warming) — plus the one
// universal escape. Auto-dismisses on resident (700 ms beat: taskFor emits only
// running/error/empty, never "done", so the bar simply stops). Cancel/error leave
// the bar showing its own Retry; Continue never traps anyone on a boot screen.
// The host owns the splash PAGE — plate, layout, z-index — and v-ifs it on
// `warmModelId` (exported beside startWarmOnBoot); this control owns everything
// inside the load group and renders nothing until a task actually exists.
import { computed, watch } from "vue";
import DownloadBar from "../common/components/DownloadBar.vue";
import { useRunnerModels } from "../composables/useRunnerModels.js";
import { warmModelId } from "../services/warmBoot.js";

defineProps({
  engineTitle: { type: String, default: "Setting up the AI engine" },
  continueLabel: { type: String, default: "Continue without waiting" },
});

const rm = useRunnerModels();
const warmTask = computed(() => (warmModelId.value ? rm.taskFor(warmModelId.value) : null));
const engineTask = computed(() =>
  rm.engineGateTask?.value && rm.engineGateTask.value.state === "running" ? rm.engineGateTask.value : null);
const warmRowStatus = computed(() =>
  warmModelId.value ? (rm.models.value.find((m) => m.id === warmModelId.value)?.status || "") : "");
watch(warmRowStatus, (s) => {
  if (warmModelId.value && (s === "loaded" || s === "sleeping")) setTimeout(dismiss, 700);
});
function dismiss() {
  warmModelId.value = ""; // the ONE signal the host splash renders on
}
</script>

<template>
  <div v-if="engineTask || (warmTask && warmTask.state)" class="lu-bootload">
    <DownloadBar v-if="engineTask" class="lu-bootload__bar" :task="engineTask" :title="engineTitle" />
    <DownloadBar v-else class="lu-bootload__bar" :task="warmTask" :title="warmModelId" />
    <button type="button" class="lu-bootload__skip" @click="dismiss">{{ continueLabel }}</button>
  </div>
</template>

<style scoped>
/* Neutral by design — the host splash positions and skins the group (JW parks it
   in the plate's parchment gap, i18n centres it in the art's bottom strip). */
.lu-bootload { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 100%; }
.lu-bootload__bar { width: 100%; }
.lu-bootload__skip {
  border: 0; background: none; padding: 0; cursor: pointer;
  font: inherit; color: inherit;
  text-decoration: underline; text-underline-offset: 2px;
}
</style>
