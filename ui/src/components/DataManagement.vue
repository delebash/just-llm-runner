<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared Data & Storage controls — backup / restore / reset over the host's
// SQLite DB via the shared /v1/data/* router (llm_runner.platform.make_data_router).
// Identical in every same-stack app; the host only passes its appName for the
// download filename + copy.
import { ref } from "vue";
import { request, requestBlob, postForm } from "../client.js";
import UiButton from "../common/components/UiButton.vue";
import { confirmDialog, promptDialog } from "../common/services/dialog.js";
import { pushToast } from "../common/services/toastBridge.js";

const props = defineProps({
  appName: { type: String, default: "Workspace" },
  // Optional host hook: save the backup blob via a native "save as" dialog —
  // (blob, suggestedName) => { ok?, cancelled?, error? }. When absent (or in a
  // plain browser) the export falls back to a normal download. Lets a desktop
  // host (e.g. through a Tauri bridge) choose where the backup lands + remember
  // it, while the kit itself stays app-agnostic.
  saveFile: { type: Function, default: null },
});
const busy = ref("");

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function exportBackup() {
  busy.value = "backup";
  try {
    const blob = await requestBlob("/v1/data/backup");
    const filename = `${props.appName.toLowerCase().replace(/\s+/g, "-")}-backup-${stamp()}.zip`;
    if (props.saveFile) {
      // Desktop host: native "save as" dialog (choose where + remember it).
      const res = await props.saveFile(blob, filename);
      if (res?.cancelled) return;
      if (res && res.ok === false) throw new Error(res.error || "save failed");
      pushToast({ message: "Backup saved.", kind: "success" });
    } else {
      // Browser fallback: download to the default location.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      pushToast({ message: "Backup downloaded.", kind: "success" });
    }
  } catch (e) {
    pushToast({ message: `Backup failed: ${e.message}`, kind: "error" });
  } finally {
    busy.value = "";
  }
}

async function onImport(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const ok = await confirmDialog({
    title: "Restore from backup?",
    message: "This replaces ALL current data with the backup's contents. Anything not in the backup is lost.",
    confirmLabel: "Restore",
    danger: true,
  });
  if (!ok) return;
  busy.value = "restore";
  try {
    const fd = new FormData();
    fd.append("file", file);
    await postForm("/v1/data/restore", fd);
    pushToast({ message: "Restored — reloading…", kind: "success" });
    setTimeout(() => window.location.reload(), 700);
  } catch (err) {
    pushToast({ message: `Restore failed: ${err.message}`, kind: "error" });
    busy.value = "";
  }
}

async function reset() {
  const typed = await promptDialog({
    title: `Reset ${props.appName}?`,
    label: "Wipes ALL data — projects, settings, AI providers — and reloads with the demo seed. Type RESET to confirm.",
    confirmLabel: "Reset",
    danger: true,
  });
  if (typed !== "RESET") {
    if (typed != null) pushToast({ message: "Confirmation didn't match — not reset." });
    return;
  }
  busy.value = "reset";
  try {
    await request("/v1/data/reset", { method: "POST" });
    pushToast({ message: "Reset — reloading…", kind: "success" });
    setTimeout(() => window.location.reload(), 700);
  } catch (e) {
    pushToast({ message: `Reset failed: ${e.message}`, kind: "error" });
    busy.value = "";
  }
}
</script>

<template>
  <div class="lu-data">
    <div class="lu-data-row">
      <div class="lu-data-info">
        <b>Backup &amp; restore</b>
        <span class="lu-muted">Download a full snapshot (database + assets) as a ZIP, or restore one — to move between machines or keep an off-device copy.</span>
      </div>
      <div class="lu-data-actions">
        <UiButton intent="primary" size="small" :loading="busy === 'backup'" @click="exportBackup">Export backup…</UiButton>
        <UiButton as="label" intent="secondary" size="small">
          Import backup…
          <input type="file" accept=".zip,application/zip" style="display:none" @change="onImport" />
        </UiButton>
      </div>
    </div>
    <div class="lu-data-row lu-data-danger">
      <div class="lu-data-info">
        <b>Reset {{ appName.toLowerCase() }}</b>
        <span class="lu-muted">Wipes the entire database and reloads with the demo seed. Take a backup first.</span>
      </div>
      <div class="lu-data-actions">
        <UiButton intent="danger" size="small" :loading="busy === 'reset'" @click="reset">Reset…</UiButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lu-data { display: flex; flex-direction: column; gap: 12px; }
.lu-data-row { display: flex; align-items: flex-start; gap: 16px; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; background: var(--surface); }
.lu-data-info { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.lu-data-info b { font-size: 13.5px; color: var(--ink); }
.lu-data-info .lu-muted { font-size: 12px; line-height: 1.5; }
.lu-data-actions { display: flex; gap: 8px; align-items: center; flex: none; }
.lu-data-danger { border-color: var(--danger-line, var(--danger)); }
</style>
