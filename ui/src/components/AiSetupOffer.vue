<script setup>
// SPDX-License-Identifier: MIT
// The once-ever "set up AI features" offer — LIFTED from JW's AiSetupDialog
// (the donor, 2026-07-11) per ruling R3 (2026-08-04): every app uses the one-time
// modal; permanent setup buttons are retired. Words are the family canon
// (familyLabels.aiOffer); {appName} fills from the host. Router-free on purpose —
// the host routes on the emits (quick-setup → its AI page with ?quicksetup=1,
// connect-provider → ?providers=online) and persists its own once-flag on close.
import { ref } from "vue";

import AppModal from "../common/components/AppModal.vue";
import Icon from "../common/components/Icon.vue";
import UiButton from "../common/components/UiButton.vue";
import { familyLabels } from "../common/services/familyLabels.js";

const props = defineProps({ appName: { type: String, default: "This app" } });
const emit = defineEmits(["close", "quick-setup", "connect-provider"]);
const L = familyLabels.aiOffer;
const modal = ref(null);

const body = () => (L.body || "").replace("{appName}", props.appName);

// Close via AppModal so the leave transition plays, then the parent v-if drops us.
function dismiss() {
  modal.value?.close();
}
function onQuickSetup() {
  emit("quick-setup");
  dismiss();
}
function onConnectProvider() {
  emit("connect-provider");
  dismiss();
}
</script>

<template>
  <AppModal ref="modal" :eyebrow="L.eyebrow" :title="L.title" @close="emit('close')">
    <p class="lu-aso-body">{{ body() }}</p>

    <div class="lu-aso-options">
      <button type="button" class="lu-aso-opt" @click="onQuickSetup">
        <span class="lu-aso-ic"><Icon name="Cpu" :size="20" /></span>
        <span class="lu-aso-txt">
          <b>{{ L.quickSetup }}</b>
          <span>{{ L.quickSetupSub }}</span>
        </span>
        <Icon class="lu-aso-go" name="ChevRight" :size="18" />
      </button>

      <button type="button" class="lu-aso-opt" @click="onConnectProvider">
        <span class="lu-aso-ic"><Icon name="Cloud" :size="20" /></span>
        <span class="lu-aso-txt">
          <b>{{ L.connectProvider }}</b>
          <span>{{ L.connectProviderSub }}</span>
        </span>
        <Icon class="lu-aso-go" name="ChevRight" :size="18" />
      </button>
    </div>

    <template #footer>
      <UiButton intent="ghost" @click="dismiss">{{ L.skip }}</UiButton>
    </template>
  </AppModal>
</template>

<style scoped>
.lu-aso-body {
  margin: 0 0 16px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--muted);
}
.lu-aso-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.lu-aso-opt {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  text-align: left;
  padding: 14px 16px;
  border: 1px solid var(--border);
  background: var(--surface-2, var(--surface));
  border-radius: 12px;
  cursor: pointer;
  color: inherit;
  font: inherit;
  transition: border-color 130ms ease, background 130ms ease, transform 130ms ease;
}
.lu-aso-opt:hover {
  border-color: color-mix(in oklab, var(--accent) 55%, var(--border));
  background: color-mix(in oklab, var(--accent) 7%, var(--surface));
  transform: translateY(-1px);
}
.lu-aso-ic {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 11px;
  color: var(--accent);
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}
.lu-aso-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lu-aso-txt b {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}
.lu-aso-txt span {
  font-size: 12.5px;
  color: var(--muted);
}
.lu-aso-go {
  flex: none;
  color: var(--muted);
}
.lu-aso-opt:hover .lu-aso-go {
  color: var(--accent);
}
</style>
