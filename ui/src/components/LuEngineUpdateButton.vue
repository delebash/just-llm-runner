<!-- SPDX-License-Identifier: MIT -->
<!--
  LuEngineUpdateButton — THE one "Update to {build}" control for the bundled
  llama.cpp engine. Bound to the shared useEngine() module singleton, so the
  label, :title, intent and action live in ONE place and can never drift between
  surfaces. Rendered in BOTH the Local-engine panel (LuRunnerEngine) and the
  built-in provider's collapsed list row (AiModelsArea) — the user wanted the row
  affordance to be "the same control" as the panel's (2026-07-21); one shared
  component is the truest form of that (a copy would drift — the T3 reuse rule +
  the "THE one download bar" convergence precedent).

  The CALLER gates visibility on `updateInfo?.updateAvailable` (v-if), so the
  panel's `v-else` "Reinstall" branch still pairs; this component is just the button.

  The offered build is one of two kinds (`latestKind`, 2026-09-28): the build this app
  is tested with (the kit's pin) or llama.cpp's official release — whichever is newer.
  The tooltip names which; the wording is the user's ("your rec go", kit TASKS).
-->
<script setup>
import { computed } from "vue";
import UiButton from "../common/components/UiButton.vue";
import { useEngine } from "../composables/useEngine.js";

const { updateInfo, updateToLatest, busy } = useEngine();

const tooltip = computed(() => {
  const u = updateInfo.value;
  const kind = u?.latestKind === "tested"
    ? "the build this app is tested with"
    : `llama.cpp's official release${u?.latestStable ? ` ${u.latestStable}` : ""}`;
  return `Update the engine to ${u?.latest}, ${kind} (you have ${u?.current}) — the new build is checked before it replaces yours, and the old build folder is removed only once it installs`;
});
</script>

<template>
  <UiButton intent="info" size="small" :loading="busy" :title="tooltip"
    @click="updateToLatest">Update to {{ updateInfo?.latest }}</UiButton>
</template>
