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
    <button class="iconbtn lu-titlebar-btn" :disabled="!canBack"
      v-tooltip.bottom="canBack ? 'Back' : 'Back (no history)'" @click="router.back()">
      <Icon name="ChevLeft" :size="16" />
    </button>
    <button class="iconbtn lu-titlebar-btn" :disabled="!canForward"
      v-tooltip.bottom="canForward ? 'Forward' : 'Forward (no history)'" @click="router.forward()">
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

/* WINDOW DRAG — lifted from JustWrite 2026-08-07, the only app that had it. §11 wants a
   native-feel title row in every app; dragging the window by it IS that feel, and docgen
   had no app-region rule anywhere, so its bar didn't drag at all. The frame owns the
   behaviour now and every consumer gets it.
   `user-select: none` rides along: without it a drag selects the title text.
   The two no-drag rules are what make this SAFE to own. The moment the frame is a drag
   surface, anything interactive inside it stops responding unless it opts out — the
   frame's own buttons, and whatever the host puts in the slot (JW's whole control
   cluster, docgen's mode cycler + AiStatusButton). Adding drag without them would have
   handed both apps a dead title bar.
   All of it is inert outside a Tauri/Electron webview, so the headless browser path is
   untouched in every app. */
.lu-titlebar { -webkit-app-region: drag; user-select: none; }
.lu-titlebar-btn { -webkit-app-region: no-drag; }
.lu-titlebar :slotted(*) { -webkit-app-region: no-drag; }
</style>
