<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The editable hardware-class tune library for ONE model (ROUND 8 Task C) — a
// collapsed drawer inside the Tune modal (the sweep's home), mirroring the
// LuRunnerBinaries `<details>` editor. Each row is a launch config for a PC
// class (VRAM · RAM): the seeded starting points plus anything saved via "Save
// for hardware class" or added/imported here. Edit opens the config in a
// KnobGrid; Delete is offered on user rows only (a deleted BUILT-IN config
// re-seeds on the next server start — built-ins are edited, not deleted; an
// edit takes ownership and survives every reseed). Copy/Import move a config
// between users as one small JSON blob.
import { computed, ref } from "vue";

import KnobGrid from "./KnobGrid.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiTag from "../common/components/UiTag.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { classKeyLabel, deleteClassTune, listClassTunes, putClassTune } from "../classTunes.js";

const props = defineProps({
  modelId: { type: String, required: true },
  // name -> { label, help, options } — the Tune modal's Plane-1 switch catalog,
  // so the editor grid renders the same labels/inputs as the tune grid above it.
  catalog: { type: Object, default: () => ({}) },
});

const loaded = ref(false);
const loading = ref(false);
const error = ref("");
const myClassKey = ref(""); // the CURRENT box's class (server-derived)
const tunes = ref([]);      // this model's configs only

// Editor state — one at a time: null | { classKey, keyLocked, rows: [{name,value}] }
const editing = ref(null);
const saving = ref(false);
const showImport = ref(false);
const importText = ref("");
const copiedKey = ref(""); // transient "Copied ✓" feedback per row

function _apply(res) {
  myClassKey.value = res.classKey || "";
  tunes.value = (res.tunes || []).filter((t) => t.modelId === props.modelId);
}

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    _apply(await listClassTunes());
    loaded.value = true;
  } catch (e) {
    error.value = e.message || "Couldn't load the class library.";
  } finally {
    loading.value = false;
  }
}
function onToggle(e) {
  if (e.target.open && !loaded.value) reload();
}
defineExpose({ reload: () => (loaded.value ? reload() : undefined) });

const summaryOf = (t) => t.rows.map((r) => `${r.flagName}=${r.flagValue}`).join(" · ");

function startEdit(t) {
  showImport.value = false;
  editing.value = {
    classKey: t.classKey,
    keyLocked: true, // the class IS the row's identity — a new class = Add
    rows: t.rows.map((r) => ({ name: r.flagName, value: r.flagValue })),
  };
}
function startAdd() {
  showImport.value = false;
  editing.value = { classKey: myClassKey.value, keyLocked: false, rows: [] };
}
async function saveEdit() {
  const e = editing.value;
  if (!e) return;
  const key = (e.classKey || "").trim();
  const switches = Object.fromEntries(
    e.rows.filter((r) => (r.name || "").trim()).map((r) => [r.name.trim(), r.value ?? ""]),
  );
  if (!key || !Object.keys(switches).length) {
    error.value = "A class key and at least one switch are required.";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    _apply(await putClassTune(props.modelId, switches, key));
    editing.value = null;
  } catch (err) {
    error.value = err.message || "Couldn't save the class config.";
  } finally {
    saving.value = false;
  }
}
async function removeTune(t) {
  const ok = await confirmDialog({
    title: "Delete this class config?",
    message: `Remove the saved launch settings for ${classKeyLabel(t.classKey)}? PCs of that class go back to the engine's automatic settings.`,
    confirmLabel: "Delete",
  });
  if (!ok) return;
  error.value = "";
  try {
    _apply(await deleteClassTune(props.modelId, t.classKey));
  } catch (e) {
    error.value = e.message || "Couldn't delete the class config.";
  }
}

// Copy/Import — ONE JSON shape both ways, so a config travels between users:
// { "modelId": …, "classKey": "vram8|ram32", "switches": { "n_cpu_moe": "21", … } }
async function copyTune(t) {
  const blob = JSON.stringify({
    modelId: t.modelId, classKey: t.classKey,
    switches: Object.fromEntries(t.rows.map((r) => [r.flagName, r.flagValue])),
  }, null, 2);
  try {
    await navigator.clipboard.writeText(blob);
    copiedKey.value = t.classKey;
    setTimeout(() => { copiedKey.value = ""; }, 1500);
  } catch {
    // clipboard blocked (permissions) — show the blob for hand-copy instead
    showImport.value = true;
    importText.value = blob;
  }
}
async function runImport() {
  error.value = "";
  let parsed;
  try {
    parsed = JSON.parse(importText.value);
  } catch {
    error.value = "That isn't valid JSON — paste a config copied from this panel.";
    return;
  }
  const key = (parsed?.classKey || "").trim();
  const switches = parsed?.switches && typeof parsed.switches === "object" ? parsed.switches : null;
  if (!key || !switches || !Object.keys(switches).length) {
    error.value = 'The config needs a "classKey" and a non-empty "switches" object.';
    return;
  }
  saving.value = true;
  try {
    // Imports always target THIS model — the panel is model-scoped; a blob copied
    // from another model still imports here deliberately (same-family sharing).
    _apply(await putClassTune(props.modelId, switches, key));
    showImport.value = false;
    importText.value = "";
  } catch (e) {
    error.value = e.message || "Import failed.";
  } finally {
    saving.value = false;
  }
}

const hasRows = computed(() => tunes.value.length > 0);
</script>

<template>
  <details class="lu-ct" @toggle="onToggle">
    <summary class="lu-ct-summary">
      <span class="lu-ct-title">Hardware-class defaults</span>
      <span class="lu-muted">shared starting points by PC class (video memory · RAM)</span>
    </summary>

    <div class="lu-ct-body">
      <p class="lu-muted lu-ct-help">
        A class config is the launch setup for every PC with the same video memory and RAM —
        applied automatically unless this machine has its own saved tune. Edit a built-in to
        change it (your edit sticks); Copy/Import moves a config between users as text.
      </p>

      <div v-if="error" class="lu-error">{{ error }}</div>
      <div v-if="loading" class="lu-muted">Loading…</div>

      <template v-else-if="loaded">
        <table v-if="hasRows" class="lu-ct-tbl">
          <thead>
            <tr><th>PC class</th><th>Settings</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="t in tunes" :key="t.classKey">
              <td class="lu-ct-k">
                {{ classKeyLabel(t.classKey) }}
                <UiTag v-if="t.classKey === myClassKey" intent="success">this PC</UiTag>
                <UiTag v-if="t.builtIn" intent="info">built-in</UiTag>
              </td>
              <td class="lu-ct-sum">{{ summaryOf(t) }}</td>
              <td class="lu-ct-act">
                <UiButton intent="ghost" size="small" @click="startEdit(t)">Edit</UiButton>
                <UiButton intent="ghost" size="small" @click="copyTune(t)">
                  {{ copiedKey === t.classKey ? "Copied ✓" : "Copy" }}
                </UiButton>
                <UiButton v-if="!t.builtIn" intent="ghost" size="small" @click="removeTune(t)">Delete</UiButton>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="lu-muted lu-ct-empty">
          No class configs for this model yet — measure a config above and use
          “Save for hardware class”, or add one here.
        </p>

        <div class="lu-ct-bar">
          <UiButton intent="secondary" size="small" @click="startAdd">＋ Add class config</UiButton>
          <UiButton intent="secondary" size="small" @click="showImport = !showImport; editing = null">Import…</UiButton>
        </div>

        <div v-if="showImport" class="lu-ct-editor">
          <UiTextarea v-model="importText" :rows="5"
            placeholder='Paste a config copied from this panel — {"classKey": "vram8|ram32", "switches": {…}}' />
          <div class="lu-ct-edact">
            <UiButton intent="ghost" size="small" @click="showImport = false">Cancel</UiButton>
            <UiButton intent="primary" size="small" :loading="saving" @click="runImport">Import</UiButton>
          </div>
        </div>

        <div v-if="editing" class="lu-ct-editor">
          <label class="lu-ct-field">
            <span class="lu-ct-cap">Class key <span class="lu-muted">(vram&lt;GB&gt;|ram&lt;GB&gt; — this PC is {{ myClassKey }})</span></span>
            <UiInput v-model="editing.classKey" :disabled="editing.keyLocked" width="token" />
          </label>
          <KnobGrid v-model="editing.rows" :catalog="catalog" />
          <div class="lu-ct-edact">
            <UiButton intent="ghost" size="small" @click="editing = null">Cancel</UiButton>
            <UiButton intent="primary" size="small" :loading="saving" @click="saveEdit">Save class config</UiButton>
          </div>
        </div>
      </template>
    </div>
  </details>
</template>

<style scoped>
.lu-ct { border-top: 1px solid var(--border); padding-top: 10px; }
.lu-ct-summary { cursor: pointer; display: flex; flex-direction: column; gap: 2px; user-select: none; }
.lu-ct-title { font-weight: 700; font-size: 12.5px; color: var(--ink); }
.lu-ct-body { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.lu-ct-help { font-size: 11.5px; line-height: 1.5; margin: 0; }
.lu-ct-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.lu-ct-tbl th { text-align: left; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); padding: 3px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.lu-ct-tbl td { padding: 5px 6px; border-bottom: 1px solid var(--border-soft, var(--border)); vertical-align: top; }
.lu-ct-k { white-space: nowrap; color: var(--ink); display: flex; align-items: center; gap: 6px; }
.lu-ct-sum { font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--ink-2); word-break: break-word; }
.lu-ct-act { white-space: nowrap; text-align: right; }
.lu-ct-empty { margin: 0; font-size: 12px; }
.lu-ct-bar { display: flex; gap: 8px; }
.lu-ct-editor { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--r-sm, 8px); background: var(--surface-2); }
.lu-ct-field { display: flex; flex-direction: column; gap: 3px; }
.lu-ct-cap { font-size: 11px; color: var(--muted); }
.lu-ct-edact { display: flex; justify-content: flex-end; gap: 8px; }
</style>
