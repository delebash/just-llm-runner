<!-- SPDX-License-Identifier: MIT -->
<!--
  LuWarmStartupToggle — THE one "load the default local model into VRAM on startup"
  control. Bound to the shared useEngine() module singleton (warmDefaultOnStartup +
  setWarmDefaultOnStartup), so the label, action and value live in ONE place and can
  never drift between surfaces (T3 + the LuEngineUpdateButton/InstallButton precedent).

  Lives on the MAIN Local page (AiModelsArea), not inside a provider's Edit form — the
  warm setting is a GLOBAL engine-config knob, not a per-provider one, so it belongs on
  the Local scope (user, 2026-07-21: "its buried in edit put it on main local"). Self-
  seeding: fetches the value once on mount if the singleton hasn't yet.
-->
<script setup>
import { onMounted } from "vue";

import UiToggle from "../common/components/UiToggle.vue";
import { useEngine } from "../composables/useEngine.js";

const { warmDefaultOnStartup, setWarmDefaultOnStartup, refreshWarm } = useEngine();

onMounted(() => {
  if (warmDefaultOnStartup.value === null) refreshWarm();
});
</script>

<template>
  <label class="lu-warm-toggle">
    <UiToggle :model-value="!!warmDefaultOnStartup" @update:model-value="setWarmDefaultOnStartup" />
    <span class="lu-warm-cap">Load the default local model into memory on startup</span>
  </label>
</template>

<style scoped>
.lu-warm-toggle { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
.lu-warm-cap { font-size: 12.5px; font-weight: 600; color: var(--lu-ink-2, var(--ink-2, #666)); }
</style>
