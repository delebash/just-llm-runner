<!-- SPDX-License-Identifier: MIT -->
<!-- Shared inline SVG icon set. App-agnostic (just a name→path map). Supersedes
     the per-app Icon.vue forks (JustVoice + JustWrite shipped identical copies). -->
<script setup>
import { computed } from "vue";
import { ICON_PATHS } from "../iconPaths.js";

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
  sw: { type: [Number, String], default: 1.6 },
  fill: { type: Boolean, default: false },
});

const d = computed(() => ICON_PATHS[props.name] || "");
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24"
       :fill="fill ? 'currentColor' : 'none'"
       stroke="currentColor" :stroke-width="sw"
       stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true">
    <path :d="d" />
  </svg>
</template>
