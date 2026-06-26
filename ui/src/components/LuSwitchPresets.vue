<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Switch-presets editor — the capability/type flag bundles (base/moe/mtp) the
// resolver layers onto every model by `type`/`mtp` (design §6.5). Seeded +
// user-editable; a collapsible "advanced" section inside the model manager. The
// PUT replaces a preset's whole flag set (the card sends the full preset).
import { onMounted, ref } from "vue";

import { request } from "../client.js";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import { confirmDialog } from "../common/services/dialog.js";

const APPLIES = [
  { value: "all", label: "All models" },
  { value: "moe", label: "MoE (type=moe)" },
  { value: "dense", label: "Dense (type=dense)" },
  { value: "mtp", label: "Speculative (mtp=true)" },
];
const rows = ref([]);
const loading = ref(true);
const error = ref("");
const savingId = ref("");

function clone(list) {
  return (list || []).map((p) => ({ ...p, switches: (p.switches || []).map((s) => ({ ...s })) }));
}
async function load() {
  loading.value = true; error.value = "";
  try {
    rows.value = clone((await request("/v1/ai/switch-presets")).rows);
  } catch (e) { error.value = e.message || "Couldn't load presets."; }
  finally { loading.value = false; }
}
onMounted(load);

function addSwitch(p) { p.switches.push({ flagName: "", flagValue: "" }); }
function removeSwitch(p, i) { p.switches.splice(i, 1); }
function addPreset() {
  rows.value.push({ id: "", label: "", appliesTo: "all", position: rows.value.length, builtIn: false, switches: [], _new: true });
}
function slug(s) { return (s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

async function savePreset(p) {
  let id = (p.id || "").trim();
  if (p._new && !id) id = slug(p.label);
  if (!id) { error.value = "A preset needs a name."; return; }
  savingId.value = id; error.value = "";
  try {
    rows.value = clone((await request("/v1/ai/switch-presets", {
      method: "PUT",
      body: { id, label: p.label || "", appliesTo: p.appliesTo || "all", position: p.position || 0,
        switches: p.switches.filter((s) => (s.flagName || "").trim()) },
    })).rows);
  } catch (e) { error.value = e.message || "Save failed."; }
  finally { savingId.value = ""; }
}
async function deletePreset(p) {
  if (p._new) { rows.value = rows.value.filter((x) => x !== p); return; }
  const ok = await confirmDialog({
    title: `Delete the "${p.label || p.id}" preset?`,
    message: "Models matching it lose these switches. Reset restores the built-in presets.", danger: true,
  });
  if (!ok) return;
  try {
    rows.value = clone((await request(`/v1/ai/switch-presets?presetId=${encodeURIComponent(p.id)}`, { method: "DELETE" })).rows);
  } catch (e) { error.value = e.message || "Delete failed."; }
}
async function resetPresets() {
  const ok = await confirmDialog({ title: "Reset switch presets to factory?", message: "Restores base / moe / mtp. Your custom presets are kept." });
  if (!ok) return;
  try { await request("/v1/ai/switch-presets/reset", { method: "POST" }); await load(); }
  catch (e) { error.value = e.message || "Reset failed."; }
}
</script>

<template>
  <details class="lu-sp">
    <summary class="lu-sp-sum">Switch presets <span class="lu-muted">— advanced: the base/moe/mtp flag bundles every model layers by type</span></summary>
    <div class="lu-sp-body">
      <div v-if="error" class="lu-error">{{ error }}</div>
      <div v-if="loading" class="lu-muted">Loading…</div>
      <template v-else>
        <div v-for="(p, idx) in rows" :key="p.id || `new-${idx}`" class="lu-sp-card">
          <div class="lu-sp-card-h">
            <UiInput v-if="p._new" v-model="p.label" placeholder="Preset name" class="lu-sp-name" />
            <b v-else class="lu-sp-id">{{ p.label || p.id }} <span class="lu-muted">{{ p.id }}</span></b>
            <UiSelect v-model="p.appliesTo" :options="APPLIES" />
            <span class="lu-sp-spacer" />
            <UiButton intent="ghost" size="small" @click="deletePreset(p)">Delete</UiButton>
            <UiButton intent="primary" size="small" :loading="savingId === p.id" @click="savePreset(p)">Save</UiButton>
          </div>
          <div v-for="(s, i) in p.switches" :key="i" class="lu-sp-sw">
            <UiInput v-model="s.flagName" placeholder="flag (e.g. spec_type)" />
            <UiInput v-model="s.flagValue" placeholder="value (e.g. none)" />
            <UiButton intent="ghost" size="small" title="Remove" @click="removeSwitch(p, i)">✕</UiButton>
          </div>
          <UiButton intent="ghost" size="small" @click="addSwitch(p)">＋ Add switch</UiButton>
        </div>
        <div class="lu-sp-foot">
          <UiButton intent="secondary" size="small" @click="resetPresets">Reset to factory</UiButton>
          <UiButton intent="primary" size="small" @click="addPreset">＋ Add preset</UiButton>
        </div>
      </template>
    </div>
  </details>
</template>

<style scoped>
.lu-sp { margin-top: 12px; border: 1px solid var(--border); border-radius: var(--r-sm, 8px); background: var(--surface); }
.lu-sp-sum { cursor: pointer; padding: 9px 12px; font-size: 12px; font-weight: 600; color: var(--ink-2); }
.lu-sp-sum .lu-muted { font-weight: 400; }
.lu-sp-body { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.lu-sp-card { border: 1px solid var(--border); border-radius: var(--r-sm, 8px); padding: 10px; background: var(--surface-2); display: flex; flex-direction: column; gap: 7px; }
.lu-sp-card-h { display: flex; align-items: center; gap: 8px; }
.lu-sp-id { font-size: 12.5px; color: var(--ink); }
.lu-sp-id .lu-muted { font-family: var(--font-mono, monospace); font-size: 10.5px; font-weight: 400; }
.lu-sp-name { max-width: 160px; }
.lu-sp-spacer { flex: 1; }
.lu-sp-sw { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; }
.lu-sp-foot { display: flex; gap: 8px; justify-content: flex-end; }
</style>
