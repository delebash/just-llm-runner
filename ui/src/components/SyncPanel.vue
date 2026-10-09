<script setup>
// SPDX-License-Identifier: MIT
// Settings → Sync — the family's sync screen over an app server's /v1/sync/* routes (the sync
// product `@delebash/sqlite-sync`; JustWrite's server/src/sync.js is the first host). One screen
// for every same-stack app: the app passes its words for what a "unit" is (a book), the units
// themselves, its file extension and — on the desktop — a folder picker.
//
// What it does (the design: the kit's docs/plans/2026-10-08-sync-product-design.md §2, §5):
//   - the status — when this device last synced, and with which device; Sync now;
//   - this device's name and how often it syncs on its own;
//   - "Let my other devices connect" and the pairing code (a QR code plus copyable text: the
//     library, its key, a token, this server's addresses), and pairing with another device's code;
//   - the cloud folder (Dropbox, OneDrive, …) the desktop's sync client keeps in step;
//   - by hand: export the units changed since the last export, import a file (merges);
//   - the devices this one has synced with.
//
// NOT in the package barrel (index.js): it needs `qrcode` (an optional peer, MIT), which only
// apps with sync install — the barrel is loaded by every app, and a bare import its build can't
// resolve breaks it. An app with sync imports it by path:
//   import SyncPanel from "@delebash/llm-ui/components/SyncPanel.vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import QRCode from "qrcode";
import { llmUiUrl, request } from "../client.js";
import UiButton from "../common/components/UiButton.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiInput from "../common/components/UiInput.vue";
import UiNumber from "../common/components/UiNumber.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import UiToggle from "../common/components/UiToggle.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { saveBlob } from "../common/services/fileSave.js";
import { pushToast } from "../common/services/toastBridge.js";

const props = defineProps({
  appName: { type: String, default: "the app" },
  // What one unit of sync is called, and its plural ("book" / "books").
  unitNoun: { type: Object, default: () => ({ one: "item", many: "items" }) },
  // The app's units, for the export picker: [{ id, title, updatedAt }] — updatedAt (ISO) ticks
  // the ones changed since the last export.
  units: { type: Array, default: () => [] },
  // The by-hand file's extension, without the dot.
  fileExtension: { type: String, default: "sync" },
  // The desktop's folder picker: () => Promise<string|null>. Without one (a browser), the folder
  // is typed.
  pickFolder: { type: Function, default: null },
});

const status = ref(null);
const loadError = ref("");
const busy = ref("");
const nameDraft = ref("");
const minutesDraft = ref(5);
const folderDraft = ref("");
const folderNote = ref("");
const pairing = ref(null); // { text, qr }
const joinCode = ref("");
const encrypt = ref(false);
const picked = reactive({});

const settings = computed(() => status.value?.settings ?? {});
const latest = computed(() => (status.value?.peers ?? []).find((p) => p.lastSync) ?? null);
const canSyncNow = computed(() => !!settings.value.folder || (settings.value.peers ?? []).length > 0);
const pickedIds = computed(() => props.units.filter((u) => picked[u.id]).map((u) => u.id));

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

const KIND = { file: "by hand", folder: "cloud folder", http: "network" };

async function load() {
  try {
    status.value = await request("/v1/sync/status");
    loadError.value = "";
    const s = status.value.settings;
    if (!nameDraft.value) nameDraft.value = s.deviceName || status.value.deviceName || "";
    minutesDraft.value = s.autoMinutes;
    folderDraft.value = s.folder || "";
    // the export picker: the units changed since the last export, or all of them before the first
    const since = Date.parse(s.lastExport ?? "");
    for (const u of props.units) {
      if (!(u.id in picked)) picked[u.id] = !Number.isFinite(since) || !u.updatedAt || Date.parse(u.updatedAt) > since;
    }
  } catch (e) {
    loadError.value = e.message;
  }
}

async function run(what, fn) {
  busy.value = what;
  try {
    return await fn();
  } catch (e) {
    pushToast({ message: e.message, kind: "error" });
    return undefined;
  } finally {
    busy.value = "";
    await load();
  }
}

const saveSettings = (body) => request("/v1/sync/settings", { method: "PUT", body });

async function saveName() {
  const name = nameDraft.value.trim();
  if (name === (settings.value.deviceName || status.value?.deviceName || "")) return;
  await run("name", () => saveSettings({ deviceName: name || null }));
}

async function saveMinutes() {
  const m = Math.max(0, Number(minutesDraft.value) || 0);
  if (m === settings.value.autoMinutes) return;
  await run("minutes", () => saveSettings({ autoMinutes: m }));
}

async function syncNow() {
  await run("sync", async () => {
    const r = await request("/v1/sync/run", { method: "POST", body: {} });
    const failed = [r.folder, ...(r.peers ?? [])].filter((x) => x && !x.ok);
    if (failed.length) pushToast({ message: `Sync didn't finish: ${failed.map((f) => f.error).join("; ")}`, kind: "error" });
    else pushToast({ message: "Synced.", kind: "success" });
  });
}

async function setListening(on) {
  await run("listen", async () => {
    const r = await saveSettings({ listenOnNetwork: on });
    if (r?.restartRequired) pushToast({ message: `Restart ${props.appName} for this to take effect.`, kind: "info" });
  });
}

async function showPairingCode() {
  await run("pair", async () => {
    const r = await request("/v1/sync/pair", { method: "POST", body: {} });
    const text = JSON.stringify(r.code);
    pairing.value = { text, qr: await QRCode.toDataURL(text, { margin: 1, width: 220 }) };
    if (r.restartRequired) pushToast({ message: `Restart ${props.appName} so your other devices can reach it.`, kind: "info" });
  });
}

async function copyPairingCode() {
  try {
    await navigator.clipboard.writeText(pairing.value.text);
    pushToast({ message: "Pairing code copied.", kind: "success" });
  } catch {
    pushToast({ message: "Couldn't copy — select the code and copy it.", kind: "error" });
  }
}

async function pairWithCode() {
  await run("join", async () => {
    const r = await request("/v1/sync/pair/join", { method: "POST", body: { code: joinCode.value.trim() } });
    joinCode.value = "";
    const who = r.peer?.name || "the other device";
    pushToast({
      message: r.url ? `Paired with ${who}.` : `Joined ${who}'s library. ${who} didn't answer — changes arrive through the cloud folder, or when it can be reached.`,
      kind: "success",
    });
  });
}

async function setFolder(folder) {
  folderNote.value = "";
  await run("folder", async () => {
    if (folder) {
      const { libraries } = await request("/v1/sync/folder/libraries", { method: "POST", body: { folder } });
      const others = libraries.filter((l) => l.library !== status.value?.library);
      if (others.length && !libraries.some((l) => l.library === status.value?.library)) {
        const names = others.flatMap((l) => l.devices.map((d) => d.name || d.id)).join(", ");
        folderNote.value = `This folder already holds another library (${names}). To join it, pair with a code from one of those devices first — otherwise your ${props.unitNoun.many} start a second library in this folder.`;
      }
    }
    await saveSettings({ folder: folder || null });
  });
}

async function chooseFolder() {
  const folder = await props.pickFolder();
  if (folder) await setFolder(folder);
}

async function exportFile() {
  await run("export", async () => {
    const res = await fetch(llmUiUrl("/v1/sync/export"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: pickedIds.value, encrypt: encrypt.value }),
    });
    if (!res.ok) throw new Error(`Export failed (HTTP ${res.status}).`);
    const disposition = res.headers.get("content-disposition") || "";
    const named = /filename="([^"]+)"/.exec(disposition);
    const filename = named ? decodeURIComponent(named[1]) : `${props.appName} ${new Date().toISOString().slice(0, 10)}.${props.fileExtension}`;
    const saved = await saveBlob(await res.blob(), filename, {
      title: `Save ${props.unitNoun.many} for another device`,
      filterName: `${props.appName} sync file`,
      filterExt: props.fileExtension,
    });
    if (!saved.cancelled) pushToast({ message: saved.downloaded ? "Sync file downloaded." : "Sync file saved.", kind: "success" });
  });
}

async function postImport(bytes, join) {
  const res = await fetch(llmUiUrl(`/v1/sync/import${join ? "?join=1" : ""}`), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function onImport(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  await run("import", async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let r = await postImport(bytes, false);
    if (r.status === 409 && r.body?.error === "library-mismatch") {
      const from = r.body.fromName ? ` (${r.body.fromName})` : "";
      const ok = await confirmDialog({
        title: "Join another library?",
        message: `This file is from another library${from}. Join it? Your ${props.unitNoun.many} merge into that library from now on.`,
        confirmLabel: "Join and import",
      });
      if (!ok) return;
      r = await postImport(bytes, true);
    }
    if (r.status !== 200) throw new Error(r.body?.detail || `Import failed (HTTP ${r.status}).`);
    pushToast({ message: `Imported from ${r.body.from || "the file"}: ${r.body.rows} change${r.body.rows === 1 ? "" : "s"}.`, kind: "success" });
  });
}

async function removePeer(url) {
  await run("remove", () => saveSettings({ removePeers: [url] }));
}

let timer = null;
onMounted(() => {
  load();
  timer = setInterval(load, 15000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="lu-sync">
    <div v-if="loadError" class="lu-error">{{ loadError }}</div>

    <!-- the status -->
    <div class="lu-card lu-sync-row">
      <div class="lu-sync-info">
        <b v-if="latest">Synced {{ ago(latest.lastSync) }} · from {{ latest.name || latest.id }}</b>
        <b v-else>Not synced with another device yet</b>
        <span class="lu-muted">This device: {{ status?.deviceName || "…" }}.</span>
      </div>
      <div class="lu-sync-actions">
        <UiButton intent="primary" size="small" :loading="busy === 'sync'" :disabled="!canSyncNow" :title="canSyncNow ? '' : 'Choose a cloud folder or pair a device first.'" @click="syncNow">Sync now</UiButton>
      </div>
    </div>

    <!-- this device -->
    <div class="lu-card lu-sync-block">
      <b>This device</b>
      <label class="lu-sync-field">
        <span>Name</span>
        <UiInput v-model="nameDraft" size="small" width="name" @blur="saveName" @keydown.enter="saveName" />
      </label>
      <span class="lu-muted">Your other devices see this name.</span>
      <label class="lu-sync-field">
        <span>Sync automatically every</span>
        <UiNumber v-model="minutesDraft" :min="0" size="small" width="token" @blur="saveMinutes" />
        <span>minutes</span>
      </label>
      <span class="lu-muted">0 syncs only when you press Sync now.</span>
    </div>

    <!-- other devices on the network: pairing -->
    <div class="lu-card lu-sync-block">
      <b>Other devices</b>
      <label class="lu-sync-toggle">
        <UiToggle :model-value="!!settings.listenOnNetwork" :disabled="busy === 'listen'" @update:model-value="setListening" />
        <span>Let my other devices connect</span>
      </label>
      <span class="lu-muted">This computer accepts {{ appName }} on your other devices — on the same Wi-Fi, or over Tailscale or ZeroTier. Takes effect when {{ appName }} restarts.</span>
      <div class="lu-sync-actions">
        <UiButton intent="secondary" size="small" :loading="busy === 'pair'" @click="showPairingCode">Show pairing code</UiButton>
      </div>
      <div v-if="pairing" class="lu-sync-pair">
        <img :src="pairing.qr" alt="Pairing code" width="220" height="220" />
        <div class="lu-sync-info">
          <span class="lu-muted">On the other device: Settings → Sync → Pair with a code, and paste or scan this. It carries this library's key — share it only with your own devices.</span>
          <code class="lu-sync-code">{{ pairing.text }}</code>
          <div class="lu-sync-actions">
            <UiButton intent="secondary" size="small" @click="copyPairingCode">Copy code</UiButton>
            <UiButton intent="ghost" size="small" @click="pairing = null">Hide</UiButton>
          </div>
        </div>
      </div>
      <b class="lu-sync-sub">Pair with a code</b>
      <UiTextarea v-model="joinCode" :rows="3" size="small" width="prose" placeholder="Paste the pairing code from your other device" />
      <div class="lu-sync-actions">
        <UiButton intent="primary" size="small" :loading="busy === 'join'" :disabled="!joinCode.trim()" @click="pairWithCode">Pair</UiButton>
      </div>
    </div>

    <!-- the cloud folder -->
    <div class="lu-card lu-sync-block">
      <b>Cloud folder</b>
      <span class="lu-muted">A folder that Dropbox, OneDrive or another sync app keeps the same on every device. Each device writes its own encrypted files there.</span>
      <code v-if="settings.folder" class="lu-sync-code">{{ settings.folder }}</code>
      <span v-else class="lu-muted"><em>No folder chosen.</em></span>
      <div v-if="!pickFolder" class="lu-sync-actions">
        <UiInput v-model="folderDraft" size="small" width="path" placeholder="The folder's full path" />
        <UiButton intent="secondary" size="small" :loading="busy === 'folder'" :disabled="!folderDraft.trim() || folderDraft.trim() === settings.folder" @click="setFolder(folderDraft.trim())">Use this folder</UiButton>
      </div>
      <div class="lu-sync-actions">
        <UiButton v-if="pickFolder" intent="secondary" size="small" :loading="busy === 'folder'" @click="chooseFolder">{{ settings.folder ? "Change folder…" : "Choose folder…" }}</UiButton>
        <UiButton v-if="settings.folder" intent="ghost" size="small" @click="setFolder(null)">Stop using it</UiButton>
      </div>
      <div v-if="folderNote" class="lu-error">{{ folderNote }}</div>
    </div>

    <!-- by hand -->
    <div class="lu-card lu-sync-block">
      <b>By hand</b>
      <span class="lu-muted">No network or account: export a file, take it to the other device any way you like, and import it there. Importing merges — the same file twice changes nothing.</span>
      <div v-if="units.length" class="lu-sync-units">
        <label v-for="u in units" :key="u.id" class="lu-sync-unit">
          <UiCheckbox v-model="picked[u.id]" /><span>{{ u.title || u.id }}</span>
        </label>
      </div>
      <span v-else class="lu-muted"><em>No {{ unitNoun.many }} yet.</em></span>
      <span class="lu-muted">Ticked: the {{ unitNoun.many }} changed since your last export.</span>
      <label class="lu-sync-toggle">
        <UiCheckbox v-model="encrypt" /><span>Encrypt the file with this library's key</span>
      </label>
      <div class="lu-sync-actions">
        <UiButton intent="primary" size="small" :loading="busy === 'export'" :disabled="!pickedIds.length" @click="exportFile">Export…</UiButton>
        <UiButton as="label" intent="secondary" size="small" :loading="busy === 'import'">
          Import…
          <input type="file" :accept="`.${fileExtension}`" style="display:none" @change="onImport" />
        </UiButton>
      </div>
    </div>

    <!-- the devices -->
    <div class="lu-card lu-sync-block">
      <b>Devices</b>
      <span v-if="!(status?.peers ?? []).length" class="lu-muted"><em>None yet.</em></span>
      <div v-for="p in status?.peers ?? []" :key="p.id" class="lu-sync-device">
        <span><b>{{ p.name || p.id }}</b> <span class="lu-muted">· {{ KIND[p.kind] || p.kind || "" }} · {{ ago(p.lastSync) }}</span></span>
      </div>
      <template v-if="(settings.peers ?? []).length">
        <b class="lu-sync-sub">Synced over the network</b>
        <div v-for="p in settings.peers" :key="p.url" class="lu-sync-device">
          <span>{{ p.name || p.url }} <span class="lu-muted">· {{ p.url }}</span></span>
          <UiButton intent="ghost" size="small" :loading="busy === 'remove'" @click="removePeer(p.url)">Remove</UiButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lu-sync { display: flex; flex-direction: column; gap: 12px; max-width: 640px; }
.lu-sync-row { display: flex; align-items: flex-start; gap: 16px; }
.lu-sync-block { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.lu-sync-info { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.lu-sync-block > b, .lu-sync-info > b { font-size: 13.5px; color: var(--ink); }
.lu-sync-sub { font-size: 12.5px; margin-top: 6px; }
.lu-sync .lu-muted { font-size: 12px; line-height: 1.5; max-width: 60ch; }
.lu-sync-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.lu-sync-field { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.lu-sync-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.lu-sync-pair { display: flex; gap: 14px; align-items: flex-start; }
.lu-sync-pair img { border-radius: 6px; background: #fff; flex: none; }
.lu-sync-code { display: block; max-width: 60ch; padding: 6px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; overflow-wrap: anywhere; }
.lu-sync-units { display: flex; flex-direction: column; gap: 4px; }
.lu-sync-unit { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.lu-sync-device { display: flex; align-items: center; gap: 10px; font-size: 13px; }
</style>
