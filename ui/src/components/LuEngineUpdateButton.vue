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
-->
<script setup>
import UiButton from "../common/components/UiButton.vue";
import { useEngine } from "../composables/useEngine.js";

const { updateInfo, updateToLatest, busy } = useEngine();
</script>

<template>
  <UiButton intent="info" size="small" :loading="busy"
    :title="`Update the engine to ${updateInfo?.latest}${updateInfo?.latestStable ? ` — llama.cpp ${updateInfo.latestStable.replace(/^v/, '')}, a stable release` : ''} (you have ${updateInfo?.current}) — the new build is checked before it replaces yours, and the old build folder is removed only once it installs`"
    @click="updateToLatest">Update to {{ updateInfo?.latest }}</UiButton>
</template>
