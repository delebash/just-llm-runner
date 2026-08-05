<script setup>
// SPDX-License-Identifier: MIT
// The family TitleBar FRAME — lifted from JW's donor (2026-08-04, the contract's
// tier-3 shape: "TitleBar (slots for app extras)"). The frame owns what every app
// shares: browser-style back/forward over the router's history state (Vue Router
// stamps back/forward onto the entry; buttons light only when there's somewhere
// to go — JW's mechanic, with docgen's post-nav setTimeout(0) settle) and the
// centred title. Everything to the RIGHT is the app's own via the default slot
// (JW: theme + mode menus, chat, AiStatusButton · docgen: mode cycle +
// AiStatusButton). Renders class "titlebar" alongside "lu-titlebar" so both
// apps' existing CSS and the e2e selectors keep working.
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import Icon from "./Icon.vue";

defineProps({ title: { type: String, default: "" } });

const router = useRouter();
const canBack = ref(false);
const canForward = ref(false);
function syncNav() {
  const st = window.history.state || {};
  canBack.value = st.back != null;
  canForward.value = st.forward != null;
}
let stopAfterEach;
onMounted(() => {
  syncNav();
  stopAfterEach = router.afterEach(() => setTimeout(syncNav, 0));
});
onBeforeUnmount(() => stopAfterEach?.());
</script>

<template>
  <header class="titlebar lu-titlebar">
    <button class="iconbtn lu-titlebar-btn" :disabled="!canBack" title="Back" @click="router.back()">
      <Icon name="ChevLeft" :size="16" />
    </button>
    <button class="iconbtn lu-titlebar-btn" :disabled="!canForward" title="Forward" @click="router.forward()">
      <Icon name="ChevRight" :size="16" />
    </button>
    <span class="titlebar__title lu-titlebar-title"><slot name="title">{{ title }}</slot></span>
    <span class="lu-titlebar-spacer" />
    <!-- The app's own right side: mode/theme controls, status buttons, anything. -->
    <slot />
  </header>
</template>

<style scoped>
.lu-titlebar { display: flex; align-items: center; gap: 6px; }
.lu-titlebar-spacer { flex: 1; }
</style>
