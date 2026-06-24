<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared server-logs viewer — tail the in-memory ring (/v1/logs/tail), copy it,
// or download the full ring (/v1/logs/download). Same panel in every same-stack
// app (the host mounts make_logs_router + installs the ring).
import { onMounted, ref } from "vue";
import { request, llmUiUrl } from "../client.js";
import UiButton from "../common/components/UiButton.vue";

const text = ref("");
const loading = ref(false);
const copied = ref(false);

async function refresh() {
  loading.value = true;
  try {
    const r = await request("/v1/logs/tail?lines=200");
    text.value = r.text || "";
  } catch (e) {
    text.value = `Couldn't load logs: ${e.message}`;
  } finally {
    loading.value = false;
  }
}
async function copyLogs() {
  try {
    await navigator.clipboard.writeText(text.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch { /* clipboard blocked — ignore */ }
}

onMounted(refresh);
</script>

<template>
  <div class="lu-logs">
    <div class="lu-logs-head">
      <span class="lu-pcard-title">Server logs</span>
      <span class="lu-muted lu-logs-sub">Recent log lines — useful for diagnosing errors, model-load failures, and boot issues.</span>
      <span class="lu-logs-spacer" />
      <UiButton intent="secondary" size="small" :loading="loading" @click="refresh">↻ Refresh</UiButton>
      <UiButton intent="ghost" size="small" @click="copyLogs">{{ copied ? "Copied" : "Copy" }}</UiButton>
      <a class="lu-logs-dl" :href="llmUiUrl('/v1/logs/download')" download>Download</a>
    </div>
    <pre class="lu-logs-pre">{{ text || "No log lines yet." }}</pre>
  </div>
</template>

<style scoped>
.lu-logs { display: flex; flex-direction: column; gap: 10px; }
.lu-logs-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.lu-logs-sub { font-size: 11.5px; }
.lu-logs-spacer { flex: 1; }
.lu-logs-dl { font-size: 12px; font-weight: 600; color: var(--accent-ink, var(--accent)); text-decoration: none; padding: 4px 6px; }
.lu-logs-dl:hover { text-decoration: underline; }
.lu-logs-pre {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.5;
  max-height: 460px; overflow: auto; background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; color: var(--ink-2);
}
</style>
