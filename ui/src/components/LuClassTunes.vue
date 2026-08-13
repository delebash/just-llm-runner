<script setup>
// SPDX-License-Identifier: MIT
// The editable PC-class library — TWO-LEVEL, TYPE-FIRST (2026-07-22 user
// redesign). USER-FACING NAME (2026-07-26): a class is a "PC class" and the thing it
// holds per model is a "PC class config"; the INTERNALS keep the hardware-class
// vocabulary throughout (class_key, /v1/ai/hardware-class, saveHardwareClass) — the
// rename was copy-only. A PC class is a NAMED bucket (free label) identified by its
// memory architecture + memory: discrete (VRAM + RAM), integrated (one shared
// pool), unified (one SoC pool). Each class HOLDS several model-configs (a model +
// launch switches). Auto-detect matches the box's class; "Use for this PC" overrides
// a wrong sensor. TWO mounts over one component (no fork):
//   • GLOBAL (`modelId` empty) — the full library: classes, each holding its configs.
//   • PER-MODEL (`modelId` set, in a model's Tune modal) — opens straight into the
//     config editor for THIS model at the box's class (the 'Save for PC class'
//     path; the class is auto-created if new).
// TWO in-place editors, each serving add AND edit, NO popup (the QC-15 no-naming-popup
// law): the CLASS editor (Name · Type · VRAM/RAM) and the CONFIG editor (Model +
// switches). Copy/Import move a config between users as one small JSON blob.
import { computed, ref } from "vue";

import KnobGrid from "./KnobGrid.vue";
import LuModelTypeTag from "./LuModelTypeTag.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTag from "../common/components/UiTag.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { pushToast } from "../common/services/toastBridge.js";
import { request } from "../client.js";
import {
  bandOf, classKeyLabel, deleteClassTune, deleteHardwareClass, DGPU_RAM_RUNGS,
  listClassTunes, modelBelongsToClass, putClassTune, saveHardwareClass, VRAM_BANDS,
} from "../classTunes.js";
import { fetchKnobCatalog, plane1SwitchCatalog } from "../knobCatalog.js";
import { modelTypeLabel, useCatalogMeta } from "../composables/useCatalogMeta.js";
import { useHardware } from "../composables/useHardware.js";

const props = defineProps({
  // "" = GLOBAL mode (the whole library); set = that model's config editor only.
  modelId: { type: String, default: "" },
  // name -> { label, help, kind } — the host's Plane-1 switch catalog (the Tune modal
  // passes its own). Empty → self-loaded on first open (global mount).
  catalog: { type: Object, default: () => ({}) },
  // true = render the body directly + load on mount (the AppModal popup mount).
  expanded: { type: Boolean, default: false },
});
const globalMode = computed(() => !props.modelId);
// Per-model popup opens straight into this model's config editor (QC-5): no list.
const directEdit = computed(() => props.expanded && !globalMode.value);

const MEM_TYPE_OPTIONS = [
  { label: "Dedicated GPU (separate VRAM)", value: "discrete" },
  { label: "Integrated GPU (shares system RAM)", value: "integrated" },
  { label: "Unified memory (Apple Silicon / SoC)", value: "unified" },
];
const MEM_TYPE_LABEL = {
  discrete: "Dedicated GPU", integrated: "Integrated GPU", unified: "Unified memory",
};

const loaded = ref(false);
const loading = ref(false);
const error = ref("");
// THIS MACHINE's own numbers, never its class band (the user, 2026-07-26: "This PC ·
// 8-11 GB VRAM · 32 or 48 GB RAM wrong this pc is what it is that is all"). A class is a
// bucket that a RANGE of machines falls into; printing the bucket where the user expects
// their own hardware is what made the line read as nonsense. The class label survives
// only as the FALLBACK when detection gives nothing, so the line is never blank.
// The phrase itself comes from the shared probe (2026-07-27) — the same sentence appears
// above the model catalog, and a class FLOOR is only honest beside it while both agree.
const { hardwareLabel: myHardware, refresh: refreshHardware } = useHardware();
const myClassKey = ref("");   // the CURRENT box's class (detected or overridden)
const overrideKey = ref("");  // the class_key_override setting ("" = auto-detect)
const classes = ref([]);      // the hardware classes [{classKey, memType, vramGb, ramGb, name, builtIn}]
const tunes = ref([]);        // the model-configs [{modelId, classKey, builtIn, rows}]
// The catalog rows (model names · the Add-config picker · the not-tested list) come from
// the SHARED useCatalogMeta singleton, not a second /v1/ai/model-catalog fetch of our own
// (2026-07-26). This component needs both the ROWS and the strict `embedding` FLAG, and
// holding a private copy of the rows while reading the flag from the singleton would be
// two live copies of one wire response driving one derived list — the exact drift shape
// the singleton exists to prevent. `refresh()` is called below only when the shared rows
// are empty, so the fetch count is unchanged and the component no longer depends on a
// sibling (LuModelCatalog) having mounted first to populate the flag map.
const { catalogRows, embeddingById, typeById, refresh: refreshCatalogMeta } = useCatalogMeta();
const models = catalogRows;
// Dense vs MoE, everywhere a model is named here (2026-07-26, the user: "we need
// distinction of moe vs dense"). It is the fact that explains why a 26B MoE is the sane
// pick on hardware a 12B dense strains — the MoE runs a fraction of its parameters per
// token. Same word, same tag as the catalog row (LuModelTypeTag).
const typeOf = (id) => typeById.value[id] || "dense";
const ownCatalog = ref({});
const catalogMap = computed(() =>
  Object.keys(props.catalog).length ? props.catalog : ownCatalog.value);
const modelName = (id) => models.value.find((m) => m.id === id)?.name || id;
// The add-config picker offers EVERY chat model, unfiltered (2026-07-26 — it briefly
// filtered to the class's members, and that was wrong twice over). This is an AUTHORING
// control in a maintainer tool, not a presentation: the membership rule exists to stop the
// class LIST claiming a 70B runs on a laptop, and the list still enforces it. Deciding to
// write down a config the estimate doubts is the author's call — the floors are estimates,
// and `min_ram_mb` is very often simply BLANK, since only `minVramMb` auto-fills (from the
// inspect result, LuModelCatalog.vue:686). A filtered picker therefore made every
// hand-added model unconfigurable: no floors → member of nothing → offered nowhere.
// The honest half of the trade is `pickedShortfall` below, which states the gap in words
// AFTER a pick. Embeds stay out — CPU by policy, not a class idea.
const modelOptions = computed(() =>
  models.value
    .filter((m) => embeddingById.value[m.id] !== true)
    // The type rides in the LABEL, not as a tag: UiSelect renders SelectItemText
    // (UiSelect.vue:99), which is text only. Same " · X" suffix shape the catalog's own
    // pickers use (LuModelCatalog.vue:779's " · Recommended").
    .map((m) => ({ label: `${m.name || m.id} · ${modelTypeLabel(typeOf(m.id))}`, value: m.id })));

/** The picked model doesn't clear this class — said in WORDS, after the pick.
 *  Deliberately not a mark inside the option label: UiSelect renders text only and is
 *  width-capped, so a reason clause truncates, and a bare "⚠" is a glyph you would have to
 *  already know (the same defect as an unexplained bold). Here there is room for a
 *  sentence. It never blocks Save — it informs, and the author decides. Silent when the
 *  floors are unknown, because "claim nothing" is what unknown floors mean everywhere
 *  else (classTunes.js:124). */
const pickedShortfall = computed(() => {
  const e = editingConfig.value;
  if (!e?.modelId || !e.classKey) return "";
  const m = models.value.find((x) => x.id === e.modelId);
  const c = classes.value.find((x) => x.classKey === e.classKey);
  if (!m || !c || !m.minVramMb || !m.minRamMb) return "";
  if (modelBelongsToClass(m.minVramMb, m.minRamMb, c)) return "";
  const asGb = (mb) => Math.round(mb / 1024);
  return `${m.name || m.id} needs about ${asGb(m.minVramMb)} GB VRAM and ${asGb(m.minRamMb)} GB RAM — more than this PC class has. You can still save a config for it.`;
});

// The model-configs grouped under their class key.
const configsByClass = computed(() => {
  const map = {};
  for (const t of tunes.value) (map[t.classKey] ||= []).push(t);
  return map;
});
// EVERY chat model is addressable under EVERY class (2026-07-26, the user: show them all,
// "just for those not tested they have no switches"). A config is only per-switch rows
// keyed (model_id, class_key, flag_name) — there is no config-level entity — so "not
// tested" IS the stored truth for a model with no rows, and listing it creates nothing.
// Only the CONFIG'D models were visible before, which made the panel look like the class
// held a short fixed roster. Embedding models are excluded: policy places them on the CPU,
// so listing them under a VRAM class would invite a switch set that never applies. The
// predicate is the catalog's own strict flag (useCatalogMeta embeddingById) — never an
// /embed/i name guess, which bge-m3 defeats (useCatalogMeta.js:30-36).
// GLOBAL mount only: in the per-model mount `tunes` is filtered to one model, so every
// OTHER model would falsely read as untested.
// MEMBERS only (the user's ruling, 2026-07-26, after seeing a 70B listed under
// "Integrated GPU · 32 GB" as merely "not tested"): a class lists the models that can
// actually RUN on its hardware — modelBelongsToClass, the same rule the catalog row's
// "Runs on:" line reads — and of those, this map holds the ones with no switches yet.
// A model that cannot run on the class simply is not there; "no switches yet" is only
// ever said where Add switches would make sense.
const unconfiguredMembersByClass = computed(() => {
  const map = {};
  if (!globalMode.value) return map;
  for (const c of classes.value) {
    const have = new Set((configsByClass.value[c.classKey] || []).map((t) => t.modelId));
    map[c.classKey] = models.value
      .filter((m) => !have.has(m.id) && embeddingById.value[m.id] !== true
        && modelBelongsToClass(m.minVramMb, m.minRamMb, c))
      .map((m) => ({ id: m.id, name: m.name || m.id }));
  }
  return map;
});
// Collapsed by default, per class: the tested configs stay the headline, the rest is one
// quiet line you can open.
const showUntested = ref({});
function toggleUntested(classKey) {
  showUntested.value = { ...showUntested.value, [classKey]: !showUntested.value[classKey] };
}

// This panel is where the user REASONS about classes, so it uses the range form — a
// class holds a run of machines, and the short form printed only the run's floor
// (a 10 GB card reading "8 GB VRAM"). Tight spots elsewhere keep `classKeyLabel`.
// FLOOR labels, never ranges (the user, 2026-07-26: "it should be 8gb and 16gb we list good
// floor", and then "23gb vram no card has that"). The range form printed `next_band - 1`, so
// the 16 band rendered "16–23 GB VRAM" — 23 is arithmetic, not hardware; no card ships it.
// The stored floor is the honest label, and a spec is read as a minimum.
const classLabel = (c) => classKeyLabel(c.classKey, c.name); // name if set, else the floor
const classHardware = (c) => classKeyLabel(c.classKey);      // the floor, always
const summaryOf = (t) => t.rows.map((r) => `${r.flagName}=${r.flagValue}`).join(" · ");

// Editors — ONE at a time (the editor REPLACES the list, never stacks below).
const editingClass = ref(null);   // { origClassKey, name, memType, vramGb, ramGb }
const editingConfig = ref(null);  // { classKey, modelId, modelLocked, rows }
const showImport = ref(false);
const importText = ref("");
const saving = ref(false);
const copiedKey = ref("");
const anyEditor = computed(() =>
  !!(editingClass.value || editingConfig.value || showImport.value));

function _apply(res) {
  myClassKey.value = res.classKey || "";
  classes.value = res.classes || [];
  tunes.value = (res.tunes || []).filter((t) => !props.modelId || t.modelId === props.modelId);
}

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    _apply(await listClassTunes());
    try {
      overrideKey.value = (await request("/v1/ai/engine-config")).classKeyOverride || "";
    } catch { /* enrichment only */ }
    await refreshHardware(); // self-swallowing; on failure the line falls back to the class label
    if (!models.value.length) {
      await refreshCatalogMeta(); // shared + self-swallowing: on failure the rows stay [] and ids render verbatim
    }
    if (!Object.keys(props.catalog).length && !Object.keys(ownCatalog.value).length) {
      ownCatalog.value = plane1SwitchCatalog(await fetchKnobCatalog());
    }
    loaded.value = true;
    // Per-model popup: drop straight into this model's config editor for the box's class.
    if (directEdit.value && !editingConfig.value) {
      const mine = tunes.value.find((t) => t.classKey === myClassKey.value);
      startConfigEdit(mine || { classKey: myClassKey.value, modelId: props.modelId, rows: [] },
        !mine);
    }
  } catch (e) {
    error.value = e.message || "Couldn't load the PC class library.";
  } finally {
    loading.value = false;
  }
}
function onToggle(e) { if (e.target.open && !loaded.value) reload(); }
if (props.expanded) reload();
defineExpose({ reload: () => (loaded.value ? reload() : undefined) });

// ── the box's class (auto-detect vs "Use for this PC") ────────────────────────
async function setForThisPC(classKey) {
  error.value = "";
  try {
    await request("/v1/ai/engine-config", { method: "PUT", body: { classKeyOverride: classKey } });
    await reload();
  } catch (e) { error.value = e.message || "Couldn't set the class for this PC."; }
}
async function useAutoDetect() {
  error.value = "";
  try {
    await request("/v1/ai/engine-config", { method: "PUT", body: { classKeyOverride: "" } });
    await reload();
  } catch (e) { error.value = e.message || "Couldn't switch back to auto-detect."; }
}

// ── the CLASS editor (Name · Type · VRAM/RAM) ─────────────────────────────────
function startAddClass() {
  showImport.value = false; editingConfig.value = null;
  editingClass.value = { origClassKey: "", name: "", memType: "discrete", vramGb: null, ramGb: null,
    vramBwGbps: null, ramBwGbps: null };
}
function startEditClass(c) {
  showImport.value = false; editingConfig.value = null;
  editingClass.value = {
    origClassKey: c.classKey, name: c.name || "", memType: c.memType || "discrete",
    vramGb: c.vramGb || null, ramGb: c.ramGb || null,
    // Class-typical memory bandwidths (fit-redesign §5.5 ladder source 3) —
    // seeded, editable, superseded by any real measurement on a box.
    vramBwGbps: c.vramBwGbps || null, ramBwGbps: c.ramBwGbps || null,
  };
}
// The number box hands back a raw STRING, so a typed "3.5" would otherwise reach the
// key template and print `dgpu-vram3.5|ram16` verbatim (no regex matches a fractional
// key) and then 422 on the server's int field. Truncate exactly the way Python does
// (`int()`, hardware.py:194) so the preview and the save can never disagree.
const wholeGb = (v) => Math.trunc(Number(v) || 0);

// What the typed numbers will ACTUALLY be saved as. The server bands a hand-typed
// discrete class exactly this way (`banded_class_key`, runner/hardware.py:193-196 —
// the detection-only `snap_ram_gb` does NOT apply to typed numbers), so typing 10 and
// getting the 8-band class stops being a surprise discovered after saving. One-pool
// types are never banded, so there is nothing to warn about and the line stays hidden.
const editorClassPreview = computed(() => {
  const e = editingClass.value;
  if (!e || e.memType !== "discrete") return "";
  const vram = wholeGb(e.vramGb);
  const ram = wholeGb(e.ramGb);
  if (vram <= 0 || ram <= 0) return "";
  return classKeyLabel(`dgpu-vram${bandOf(vram, VRAM_BANDS)}|ram${bandOf(ram, DGPU_RAM_RUNGS)}`);
});

async function saveClass() {
  const e = editingClass.value;
  if (!e) return;
  const ram = wholeGb(e.ramGb);
  const vram = e.memType === "discrete" ? wholeGb(e.vramGb) : 0;
  if (ram <= 0) { error.value = "Enter the memory in whole GB."; return; }
  if (e.memType === "discrete" && vram <= 0) { error.value = "Enter the VRAM in whole GB."; return; }
  saving.value = true; error.value = "";
  try {
    _apply(await saveHardwareClass({
      name: e.name, memType: e.memType, vramGb: vram, ramGb: ram, origClassKey: e.origClassKey,
      // 0 = "unknown" (the speed ladder skips the class source); the server keeps
      // the stored value only when the field is absent, so always send numbers.
      vramBwGbps: Number(e.vramBwGbps) || 0, ramBwGbps: Number(e.ramBwGbps) || 0,
    }));
    editingClass.value = null;
  } catch (err) {
    error.value = err.message || "Couldn't save the PC class.";
  } finally { saving.value = false; }
}
async function removeClass(c) {
  const ok = await confirmDialog({
    title: "Delete this PC class?",
    message: `Remove "${classLabel(c)}" and all of its PC class configs? PCs of that class go back to the engine's automatic settings.`,
    confirmLabel: "Delete",
  });
  if (!ok) return;
  error.value = "";
  try { _apply(await deleteHardwareClass(c.classKey)); }
  catch (e) { error.value = e.message || "Couldn't delete the PC class."; }
}

// ── the CONFIG editor (Model + switches, under a class) ────────────────────────
// `modelId` prefills the picker — the not-tested list's "Add switches" opens THIS same
// editor already pointed at (model, class) instead of a second flow (2026-07-26). The
// picker stays UNLOCKED when prefilled this way: the user picked the row, not the app, so
// changing their mind in place must still work; only the per-model mount locks it.
function startAddConfig(classKey, modelId = "") {
  showImport.value = false; editingClass.value = null;
  editingConfig.value = {
    classKey, modelId: props.modelId || modelId || "",
    modelLocked: !!props.modelId, rows: [],
  };
}
function startConfigEdit(t, isNew = false) {
  showImport.value = false; editingClass.value = null;
  editingConfig.value = {
    classKey: t.classKey, modelId: t.modelId, modelLocked: !isNew,
    rows: (t.rows || []).map((r) => ({ name: r.flagName, value: r.flagValue })),
  };
}
async function saveConfig() {
  const e = editingConfig.value;
  if (!e) return;
  const mid = (e.modelId || "").trim();
  const switches = Object.fromEntries(
    e.rows.filter((r) => (r.name || "").trim()).map((r) => [r.name.trim(), r.value ?? ""]));
  if (!mid) { error.value = "Pick the model this config is for."; return; }
  if (!Object.keys(switches).length) { error.value = "Add at least one launch switch."; return; }
  saving.value = true; error.value = "";
  try {
    _apply(await putClassTune(mid, switches, e.classKey));
    if (directEdit.value) {
      const saved = tunes.value.find((t) => t.modelId === mid && t.classKey === e.classKey);
      if (saved) startConfigEdit(saved);
      pushToast({ message: "PC class config saved ✓" });
    } else {
      editingConfig.value = null;
    }
  } catch (err) {
    error.value = err.message || "Couldn't save the config.";
  } finally { saving.value = false; }
}
async function removeConfig(t) {
  const ok = await confirmDialog({
    title: "Delete this PC class config?",
    message: `Remove ${modelName(t.modelId)}'s launch settings for this PC class?`,
    confirmLabel: "Delete",
  });
  if (!ok) return;
  error.value = "";
  try { _apply(await deleteClassTune(t.modelId, t.classKey)); }
  catch (e) { error.value = e.message || "Couldn't delete the config."; }
}

// ── Copy / Import — ONE JSON shape both ways (a config travels between users) ──
async function copyConfig(t) {
  const blob = JSON.stringify({
    modelId: t.modelId, classKey: t.classKey,
    switches: Object.fromEntries(t.rows.map((r) => [r.flagName, r.flagValue])),
  }, null, 2);
  const id = `${t.modelId}|${t.classKey}`;
  try {
    await navigator.clipboard.writeText(blob);
    copiedKey.value = id;
    setTimeout(() => { copiedKey.value = ""; }, 1500);
  } catch {
    showImport.value = true; importText.value = blob;
  }
}
function copyEditingConfig() {
  const e = editingConfig.value;
  const t = e && tunes.value.find((x) => x.modelId === e.modelId && x.classKey === e.classKey);
  if (t) copyConfig(t);
}
function startImport() {
  editingClass.value = null; editingConfig.value = null;
  showImport.value = true; importText.value = "";
}
async function runImport() {
  error.value = "";
  let parsed;
  try { parsed = JSON.parse(importText.value); }
  catch { error.value = "That isn't valid JSON — paste a config copied from this panel."; return; }
  const key = (parsed?.classKey || "").trim();
  const switches = parsed?.switches && typeof parsed.switches === "object" ? parsed.switches : null;
  if (!key || !switches || !Object.keys(switches).length) {
    error.value = 'The config needs a "classKey" and a non-empty "switches" object.'; return;
  }
  const mid = props.modelId || (parsed?.modelId || "").trim();
  if (!mid) { error.value = 'The config needs a "modelId" here — this panel spans every model.'; return; }
  saving.value = true;
  try {
    _apply(await putClassTune(mid, switches, key));
    showImport.value = false; importText.value = "";
  } catch (e) { error.value = e.message || "Import failed."; }
  finally { saving.value = false; }
}
</script>

<template>
  <component :is="expanded ? 'div' : 'details'" class="lu-ct" :class="{ 'lu-ct--expanded': expanded }" @toggle="onToggle">
    <summary v-if="!expanded" class="lu-ct-summary">
      <span class="lu-ct-title">PC classes</span>
      <span class="lu-muted">named PC profiles — each holds the PC class config per model</span>
    </summary>

    <div class="lu-ct-body">
      <p class="lu-muted lu-ct-help">
        A PC class groups PCs with similar memory. Each class stores one set of launch
        switches per model, used automatically on every PC in that class — unless that
        machine has its own tuned config.
        <b>Detection picks your class; you can override it below.</b>
      </p>

      <div v-if="error" class="lu-error">{{ error }}</div>
      <div v-if="loading" class="lu-muted">Loading…</div>

      <!-- PER-MODEL popup: the config editor only (no list). -->
      <template v-else-if="loaded && directEdit && editingConfig">
        <div class="lu-ct-editor">
          <!-- The MACHINE's own numbers lead here too. This mount (a model's Tune modal →
               "Save for PC class") renders the editor ALONE — no This-PC line above it, and
               TuneMeasureModal never prints VRAM/RAM either — so before this, a 10 GB card
               owner read "8 GB VRAM" with nothing on the panel to say it is a bucket floor
               rather than a misread of their card. That is §23's exact failure case, and it
               is the one place the floor-label ruling would otherwise still bite. -->
          <div class="lu-ct-forrow">This PC · <b>{{ myHardware || "hardware not detected" }}</b></div>
          <div class="lu-ct-forrow">Saving to PC class · <b>{{ classKeyLabel(editingConfig.classKey) }}</b></div>
          <KnobGrid v-model="editingConfig.rows" :catalog="catalogMap" />
          <div class="lu-ct-edact">
            <UiButton intent="ghost" size="small" @click="copyEditingConfig">
              {{ copiedKey === `${editingConfig.modelId}|${editingConfig.classKey}` ? "Copied ✓" : "Copy" }}
            </UiButton>
            <UiButton intent="primary" size="small" :loading="saving" @click="saveConfig">Save for this class</UiButton>
          </div>
        </div>
      </template>

      <!-- GLOBAL: the class list, or an editor (one at a time). -->
      <template v-else-if="loaded">
        <!-- This PC — the machine's OWN specs, not the band it lands in. The matching
             class is tagged in the list below, so the class is not repeated here. -->
        <div class="lu-ct-mine">
          <span>This PC · <b>{{ myHardware || (myClassKey ? classKeyLabel(myClassKey) : "not detected") }}</b>
            <UiTag v-if="overrideKey" intent="info">Set manually</UiTag></span>
          <UiButton v-if="overrideKey" intent="secondary" size="small" @click="useAutoDetect">Use auto-detect</UiButton>
        </div>

        <!-- The CLASS editor -->
        <div v-if="editingClass" class="lu-ct-editor">
          <label class="lu-ct-field">
            <span class="lu-ct-cap">Name <span class="lu-muted">(optional — a label like "My Laptop")</span></span>
            <UiInput v-model="editingClass.name" placeholder="e.g. My PC" />
          </label>
          <label class="lu-ct-field">
            <span class="lu-ct-cap">Hardware type</span>
            <UiSelect v-model="editingClass.memType" :options="MEM_TYPE_OPTIONS" width="name" />
          </label>
          <div class="lu-ct-mrow">
            <label v-if="editingClass.memType === 'discrete'" class="lu-ct-field">
              <span class="lu-ct-cap">VRAM (GB)</span>
              <UiInput v-model="editingClass.vramGb" type="number" width="token" />
            </label>
            <label class="lu-ct-field">
              <span class="lu-ct-cap">{{ editingClass.memType === 'discrete' ? 'System RAM (GB)' : 'Memory (GB)' }}</span>
              <UiInput v-model="editingClass.ramGb" type="number" width="token" />
            </label>
          </div>
          <!-- Class-typical memory bandwidths (the speed badge's LAST-resort source —
               a measurement or the device's own report always outranks them). -->
          <div class="lu-ct-mrow">
            <label v-if="editingClass.memType === 'discrete'" class="lu-ct-field">
              <span class="lu-ct-cap">VRAM bandwidth (GB/s) <span class="lu-muted">(optional — speed estimate)</span></span>
              <UiInput v-model="editingClass.vramBwGbps" type="number" width="token" />
            </label>
            <label class="lu-ct-field">
              <span class="lu-ct-cap">{{ editingClass.memType === 'discrete' ? 'RAM bandwidth (GB/s)' : 'Memory bandwidth (GB/s)' }} <span class="lu-muted">(optional)</span></span>
              <UiInput v-model="editingClass.ramBwGbps" type="number" width="token" />
            </label>
          </div>
          <!-- The snap, said BEFORE the save: typing 10 GB saves the 8-band class, and
               finding that out afterwards reads as the app losing your number. -->
          <div v-if="editorClassPreview" class="lu-muted lu-ct-snap">
            Saved as <b>{{ editorClassPreview }}</b> — one class covers a range of machines,
            so nearby sizes share a config.
          </div>
          <div class="lu-ct-edact">
            <UiButton intent="ghost" size="small" @click="editingClass = null">Cancel</UiButton>
            <UiButton intent="primary" size="small" :loading="saving" @click="saveClass">Save class</UiButton>
          </div>
        </div>

        <!-- The CONFIG editor (a model + switches, under a class) -->
        <div v-else-if="editingConfig" class="lu-ct-editor">
          <div class="lu-ct-forrow">For class · <b>{{ classKeyLabel(editingConfig.classKey) }}</b></div>
          <label class="lu-ct-field">
            <span class="lu-ct-cap">Model</span>
            <span v-if="editingConfig.modelLocked" class="lu-ct-fixed">{{ modelName(editingConfig.modelId) }}</span>
            <UiSelect v-else v-model="editingConfig.modelId" :options="modelOptions" width="name" />
          </label>
          <p v-if="pickedShortfall" class="lu-muted lu-ct-shortfall">{{ pickedShortfall }}</p>
          <KnobGrid v-model="editingConfig.rows" :catalog="catalogMap" />
          <div class="lu-ct-edact">
            <UiButton v-if="editingConfig.modelLocked" intent="ghost" size="small" @click="copyEditingConfig">
              {{ copiedKey === `${editingConfig.modelId}|${editingConfig.classKey}` ? "Copied ✓" : "Copy" }}
            </UiButton>
            <UiButton intent="ghost" size="small" @click="editingConfig = null">Cancel</UiButton>
            <UiButton intent="primary" size="small" :loading="saving" @click="saveConfig">Save config</UiButton>
          </div>
        </div>

        <!-- The IMPORT editor -->
        <div v-else-if="showImport" class="lu-ct-editor">
          <UiTextarea v-model="importText" :rows="5"
            placeholder='Paste a config copied from this panel — {"modelId": …, "classKey": …, "switches": {…}}' />
          <div class="lu-ct-edact">
            <UiButton intent="ghost" size="small" @click="showImport = false">Cancel</UiButton>
            <UiButton intent="primary" size="small" :loading="saving" @click="runImport">Import</UiButton>
          </div>
        </div>

        <!-- The CLASS LIST (each class holds its model-configs) -->
        <template v-else>
          <p v-if="!classes.length" class="lu-muted lu-ct-empty">
            No PC classes yet — add one for your PC, or measure a config in a model's
            Tune dialog and use "Save for PC class".
          </p>
          <div v-for="c in classes" :key="c.classKey" class="lu-ct-class">
            <div class="lu-ct-chead">
              <span class="lu-ct-cname">
                <b>{{ classLabel(c) }}</b>
                <span v-if="c.name" class="lu-muted lu-ct-chw">{{ classHardware(c) }}</span>
                <!-- Sentence case, like every other tag on this page — and `Built-in`
                     matches the provider row's own tag (AiModelsArea.vue:472) so one
                     word does not render two ways on one screen. -->
                <UiTag v-if="c.classKey === myClassKey" intent="success">This PC</UiTag>
                <UiTag v-if="c.builtIn" intent="info">Built-in</UiTag>
              </span>
              <span class="lu-ct-cact">
                <UiButton v-if="c.classKey !== myClassKey" intent="secondary" size="small" @click="setForThisPC(c.classKey)">Use for this PC</UiButton>
                <UiButton intent="ghost" size="small" @click="startEditClass(c)">Edit</UiButton>
                <UiButton v-if="!c.builtIn" intent="ghost" size="small" @click="removeClass(c)">Delete</UiButton>
              </span>
            </div>
            <table v-if="(configsByClass[c.classKey] || []).length" class="lu-ct-tbl">
              <tbody>
                <tr v-for="t in configsByClass[c.classKey]" :key="t.modelId">
                  <td class="lu-ct-model">
                    {{ modelName(t.modelId) }}
                    <LuModelTypeTag :type="typeOf(t.modelId)" class="lu-ct-mtype" />
                  </td>
                  <td class="lu-ct-sum">{{ summaryOf(t) }}</td>
                  <td class="lu-ct-act">
                    <UiButton intent="ghost" size="small" @click="startConfigEdit(t)">Edit</UiButton>
                    <UiButton intent="ghost" size="small" @click="copyConfig(t)">
                      {{ copiedKey === `${t.modelId}|${t.classKey}` ? "Copied ✓" : "Copy" }}
                    </UiButton>
                    <UiButton v-if="!t.builtIn" intent="ghost" size="small" @click="removeConfig(t)">Delete</UiButton>
                  </td>
                </tr>
              </tbody>
            </table>
            <!-- The class's OTHER members — models that can run on this hardware but
                 carry no switches yet (2026-07-26; membership-filtered, so a model
                 that could never run here is not listed at all). Collapsed, because
                 the configured models are the headline; open, each row states the
                 honest truth — no switches yet — and offers the one action that
                 changes it. -->
            <template v-if="(unconfiguredMembersByClass[c.classKey] || []).length">
              <button type="button" class="lu-ct-untbtn lu-muted" @click="toggleUntested(c.classKey)">
                {{ showUntested[c.classKey] ? "▾" : "▸" }}
                {{ unconfiguredMembersByClass[c.classKey].length }} more
                {{ unconfiguredMembersByClass[c.classKey].length === 1 ? "model" : "models" }} in this class — no switches yet
              </button>
              <table v-if="showUntested[c.classKey]" class="lu-ct-tbl">
                <tbody>
                  <tr v-for="m in unconfiguredMembersByClass[c.classKey]" :key="m.id">
                    <td class="lu-ct-model">
                      {{ m.name }}
                      <LuModelTypeTag :type="typeOf(m.id)" class="lu-ct-mtype" />
                    </td>
                    <td class="lu-ct-sum lu-muted">no switches</td>
                    <td class="lu-ct-act">
                      <UiButton intent="ghost" size="small" @click="startAddConfig(c.classKey, m.id)">Add switches</UiButton>
                    </td>
                  </tr>
                </tbody>
              </table>
            </template>
            <div class="lu-ct-addcfg">
              <UiButton intent="ghost" size="small" @click="startAddConfig(c.classKey)">＋ Add model to this class</UiButton>
            </div>
          </div>

          <div class="lu-ct-bar">
            <UiButton intent="secondary" size="small" @click="startAddClass">＋ Add PC class</UiButton>
            <UiButton intent="secondary" size="small" @click="startImport">Import config…</UiButton>
          </div>
        </template>
      </template>
    </div>
  </component>
</template>

<style scoped>
.lu-ct { border-top: 1px solid var(--border); padding-top: 10px; }
.lu-ct--expanded { border-top: none; padding-top: 0; }
.lu-ct--expanded .lu-ct-body { margin-top: 0; }
.lu-ct-summary { cursor: pointer; display: flex; flex-direction: column; gap: 2px; user-select: none; }
.lu-ct-title { font-weight: 700; font-size: 12.5px; color: var(--ink); }
.lu-ct-body { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.lu-ct-help { font-size: 11.5px; line-height: 1.5; margin: 0; }
.lu-ct-mine { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--ink); flex-wrap: wrap; }
.lu-ct-class { border: 1px solid var(--border); border-radius: var(--r-sm, 8px); overflow: hidden; }
.lu-ct-chead { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 10px; background: var(--surface-2); flex-wrap: wrap; }
.lu-ct-cname { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12.5px; color: var(--ink); }
.lu-ct-chw { font-size: 10.5px; }
.lu-ct-cact { display: inline-flex; gap: 4px; }
.lu-ct-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.lu-ct-tbl td { padding: 5px 10px; border-top: 1px solid var(--border-soft, var(--border)); vertical-align: top; }
.lu-ct-model { color: var(--ink); white-space: nowrap; }
/* One tag after the name — nowrap above is safe here because it is exactly one short
   tag, not a list that could outgrow the column. */
.lu-ct-mtype { margin-left: 6px; }
.lu-ct-sum { font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--ink-2); word-break: break-word; width: 100%; }
.lu-ct-act { white-space: nowrap; text-align: right; }
.lu-ct-addcfg { padding: 4px 8px 8px; }
/* The not-tested disclosure: a quiet full-width row, not a button-looking control —
   it reveals a list, it doesn't change anything. */
.lu-ct-untbtn { display: block; width: 100%; text-align: left; padding: 5px 10px; border: none;
  border-top: 1px solid var(--border-soft, var(--border)); background: none; font: inherit;
  font-size: 11.5px; cursor: pointer; }
.lu-ct-untbtn:hover { background: var(--surface-2); }
.lu-ct-empty { margin: 0; font-size: 12px; }
.lu-ct-bar { display: flex; gap: 8px; }
.lu-ct-editor { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--r-sm, 8px); background: var(--surface-2); }
.lu-ct-forrow { font-size: 12px; color: var(--ink-2); }
.lu-ct-field { display: flex; flex-direction: column; gap: 3px; }
.lu-ct-mrow { display: flex; gap: 10px; flex-wrap: wrap; }
.lu-ct-cap { font-size: 11px; color: var(--muted); }
.lu-ct-fixed { font-size: 12px; color: var(--ink-2); }
.lu-ct-snap { font-size: 11px; line-height: 1.4; }
.lu-ct-shortfall { margin: 0; font-size: 11px; line-height: 1.4; }
.lu-ct-edact { display: flex; justify-content: flex-end; gap: 8px; }
</style>
