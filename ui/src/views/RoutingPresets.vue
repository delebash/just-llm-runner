<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Routing presets ("hardware presets") — named snapshots of the whole routing
// config (default + Quick/Accuracy roles + per-feature pins). Save the current
// routing as a named preset, then Apply / Rename / Delete to switch the entire
// AI config in one click (e.g. desktop vs laptop, offline vs cloud). Built on
// the shared /v1/ai/routing-presets endpoints; lives with the Features (routing)
// editor since a preset is a snapshot of exactly what that tab edits.
import { onMounted, ref } from "vue";

import { request } from "../client.js";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";

const emit = defineEmits(["applied"]);

const presets = ref([]);
const loading = ref(true);
const error = ref("");
const busy = ref(false);
const newName = ref("");
const editingId = ref(null);
const editName = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    presets.value = (await request("/v1/ai/routing-presets")).presets || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function saveCurrent() {
  const name = newName.value.trim();
  if (!name || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    presets.value = (await request("/v1/ai/routing-presets/from-current", { method: "POST", body: { name } })).presets || [];
    newName.value = "";
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function apply(p) {
  busy.value = true;
  error.value = "";
  try {
    await request(`/v1/ai/routing-presets/${p.id}/apply`, { method: "POST" });
    emit("applied");
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

function startRename(p) {
  editingId.value = p.id;
  editName.value = p.name;
}
async function saveRename(p) {
  const name = editName.value.trim();
  editingId.value = null;
  if (!name || name === p.name) return;
  busy.value = true;
  try {
    presets.value = (await request(`/v1/ai/routing-presets/${p.id}`, { method: "PUT", body: { name } })).presets || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function remove(p) {
  if (!window.confirm(`Delete the "${p.name}" config preset?`)) return;
  busy.value = true;
  try {
    presets.value = (await request(`/v1/ai/routing-presets/${p.id}`, { method: "DELETE" })).presets || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

function summary(p) {
  const r = p.routing || {};
  const bits = [];
  if (r.default?.llmId) bits.push(`default ${r.default.llmId}`);
  if (r.quick?.model) bits.push(`quick ${r.quick.model}`);
  if (r.accuracy?.model) bits.push(`accuracy ${r.accuracy.model}`);
  const pins = Object.keys(r.pins || {}).length;
  if (pins) bits.push(`${pins} pinned`);
  return bits.join(" · ") || "empty routing";
}
</script>

<template>
  <div class="lu-presets">
    <div class="lu-presets-head">
      <b class="lu-presets-title">Saved configs</b>
      <span class="lu-muted lu-presets-sub">Snapshot the whole routing above as a named preset, then apply it in one click — handy across machines or offline/cloud profiles.</span>
    </div>

    <div v-if="error" class="lu-error">{{ error }}</div>
    <div v-if="loading" class="lu-muted">Loading…</div>

    <ul v-else-if="presets.length" class="lu-presets-list">
      <li v-for="p in presets" :key="p.id" class="lu-preset">
        <div class="lu-preset-main">
          <template v-if="editingId === p.id">
            <UiInput v-model="editName" class="lu-preset-rename" @keyup.enter="saveRename(p)" />
            <UiButton intent="secondary" size="small" :disabled="busy" @click="saveRename(p)">Save</UiButton>
          </template>
          <template v-else>
            <b class="lu-preset-name">{{ p.name }}</b>
            <span class="lu-muted lu-preset-summary">{{ summary(p) }}</span>
          </template>
        </div>
        <div class="lu-preset-actions">
          <UiButton intent="primary" size="small" :disabled="busy" @click="apply(p)">Apply</UiButton>
          <UiButton intent="ghost" size="small" :disabled="busy" @click="startRename(p)">Rename</UiButton>
          <UiButton intent="ghost" size="small" :disabled="busy" @click="remove(p)">Delete</UiButton>
        </div>
      </li>
    </ul>

    <div v-else class="lu-muted lu-presets-empty">No saved configs yet — set your routing above, then save it below.</div>

    <div class="lu-presets-save">
      <UiInput v-model="newName" placeholder="Name this config (e.g. Desktop, Offline)…" @keyup.enter="saveCurrent" />
      <UiButton intent="secondary" :loading="busy" :disabled="!newName.trim()" @click="saveCurrent">Save current routing</UiButton>
    </div>
  </div>
</template>

<style scoped>
/* max-width matches FeaturesRouting's .lu-feat so this card lines up with the
   routing table above it instead of stretching wider. */
.lu-presets { max-width: 1000px; border: 1px solid var(--border); border-radius: var(--r-md, 10px); background: var(--surface); padding: 12px 16px; margin-top: 16px; }
.lu-presets-head { margin-bottom: 10px; }
.lu-presets-title { font-size: 14px; color: var(--ink); }
.lu-presets-sub { font-size: 11.5px; margin-left: 8px; }
.lu-presets-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.lu-preset { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
.lu-preset-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-preset-name { color: var(--ink); font-size: 13px; }
.lu-preset-summary { font-size: 11.5px; }
.lu-preset-rename { max-width: 220px; }
.lu-preset-actions { display: flex; gap: 6px; flex: none; }
.lu-presets-empty { font-size: 12.5px; padding: 8px 0; }
.lu-presets-save { display: flex; gap: 8px; margin-top: 12px; }
.lu-presets-save :deep(input) { flex: 1; }
</style>
