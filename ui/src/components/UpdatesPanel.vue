<script setup>
// SPDX-License-Identifier: MIT
// Shared Updates / Changelog panel — current version + rendered release notes.
// The host passes its version and pre-rendered changelog HTML (the changelog
// source + markdown renderer stay app-side; the presentation is shared).
//
// `updater` (the desktop app, 2026-10-09): the shell's updater as the app's
// native.js hands it over — { status(), check(), download(), install(),
// onStatus(fn) → unsubscribe }. The head then says where the update stands, with
// its one button: Check again · Download · Restart now · the release's page on a
// Mac (which can't install an unsigned update). Without it, or with the shell's
// updates off, the panel is the notes alone.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import UiButton from "../common/components/UiButton.vue";
import { openExternal } from "../common/services/external.js";

const props = defineProps({
  appVersion: { type: String, default: "" },
  changelogHtml: { type: String, default: "" },
  updater: { type: Object, default: null },
});

const status = ref(null);
const busy = ref(false);
let unsubscribe = null;
onMounted(async () => {
  if (!props.updater) return;
  unsubscribe = props.updater.onStatus((s) => {
    status.value = s;
  });
  try {
    status.value = await props.updater.status();
  } catch {
    status.value = null;
  }
});
onBeforeUnmount(() => unsubscribe?.());

async function run(fn) {
  busy.value = true;
  try {
    const s = await fn();
    if (s) status.value = s;
  } catch (e) {
    status.value = { ...(status.value || {}), state: "error", error: String(e?.message || e) };
  } finally {
    busy.value = false;
  }
}

const line = computed(() => {
  const s = status.value;
  switch (s?.state) {
    case "idle":
    case "checking":
      return "Checking for updates…";
    case "latest":
      return "This is the latest version.";
    case "available":
      return s.canInstall ? `Version ${s.version} is out.` : `Version ${s.version} is out — download it from its release page.`;
    case "downloading":
      return `Downloading version ${s.version} — ${s.percent}%`;
    case "ready":
      return `Version ${s.version} is downloaded. It installs when you quit the app.`;
    case "error":
      return `Couldn't update: ${s.error}`;
    default:
      return "";
  }
});
</script>

<template>
  <div class="lu-updates">
    <div class="lu-updates-head">
      <span class="lu-pcard-title">Updates</span>
      <span class="lu-updates-ver">Current version <b>v{{ appVersion || "—" }}</b></span>
      <span class="lu-updates-spacer" />
      <span v-if="line" class="lu-updates-status">{{ line }}</span>
      <UiButton v-if="status?.state === 'latest' || status?.state === 'error'" intent="ghost" size="small"
        label="Check again" :disabled="busy" @click="run(updater.check)" />
      <UiButton v-else-if="status?.state === 'available' && status.canInstall" intent="primary" size="small"
        label="Download" :disabled="busy" @click="run(updater.download)" />
      <UiButton v-else-if="status?.state === 'available' && status.releaseUrl" intent="primary" size="small"
        label="Open the release page" @click="openExternal(status.releaseUrl)" />
      <UiButton v-else-if="status?.state === 'ready'" intent="primary" size="small"
        label="Restart now" title="Quit, install the update and start again" :disabled="busy" @click="run(updater.install)" />
      <slot name="actions" />
    </div>
    <div v-if="changelogHtml" class="lu-updates-log" v-html="changelogHtml" />
    <div v-else class="lu-muted lu-updates-empty">No release notes available.</div>
  </div>
</template>

<style scoped>
.lu-updates { display: flex; flex-direction: column; gap: 12px; }
.lu-updates-head { display: flex; align-items: baseline; gap: 12px; }
.lu-updates-ver { font-size: 12.5px; color: var(--ink-2); }
.lu-updates-status { font-size: 12.5px; color: var(--ink-2); }
.lu-updates-spacer { flex: 1; }
.lu-updates-empty { font-size: 12.5px; }
.lu-updates-log {
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
  padding: 14px 18px; max-height: 520px; overflow: auto; font-size: 13px; line-height: 1.6; color: var(--ink-2);
}
.lu-updates-log :deep(h1), .lu-updates-log :deep(h2), .lu-updates-log :deep(h3) {
  color: var(--ink); margin: 14px 0 6px; font-size: 14px;
}
.lu-updates-log :deep(h1:first-child), .lu-updates-log :deep(h2:first-child) { margin-top: 0; }
.lu-updates-log :deep(ul) { margin: 6px 0; padding-left: 20px; }
.lu-updates-log :deep(li) { margin: 3px 0; }
.lu-updates-log :deep(p) { margin: 6px 0; }
.lu-updates-log :deep(code) { font-family: var(--font-mono, monospace); font-size: 12px; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
</style>
