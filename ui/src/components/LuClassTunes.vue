<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The editable hardware-class tune library (ROUND 8 Task C + the ROUND 15
// cross-model view) — a collapsed drawer mirroring the LuRunnerBinaries
// `<details>` editor, in TWO modes over the same table/editor (no fork):
//   • PER-MODEL (`modelId` set) — inside a model's Tune modal (the sweep's
//     home): that model's class configs; imports target the open model.
//   • GLOBAL (`modelId` empty) — the cross-model audit view on the Built-in
//     server's Edit view: every (model × class) config with a Model column,
//     Add picks the model from the catalog, Import honors the blob's own
//     modelId. Knob labels self-load when no `catalog` prop is given.
// Each row is a launch config for a PC class (VRAM · RAM): the seeded starting
// points plus anything saved via "Save for hardware class" or added/imported
// here. Delete is offered on user rows only (a deleted BUILT-IN config re-seeds
// on the next server start — built-ins are edited, not deleted; an edit takes
// ownership and survives every reseed). Copy/Import move a config between users
// as one small JSON blob.
import { computed, ref } from "vue";

import KnobGrid from "./KnobGrid.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTag from "../common/components/UiTag.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import { confirmDialog, promptDialog } from "../common/services/dialog.js";
import { pushToast } from "../common/services/toastBridge.js";
import { request } from "../client.js";
import { classKeyLabel, deleteClassTune, listClassTunes, putClassTune } from "../classTunes.js";
import { fetchKnobCatalog, plane1SwitchCatalog } from "../knobCatalog.js";

const props = defineProps({
  // "" = GLOBAL mode (every model); set = that model's configs only.
  modelId: { type: String, default: "" },
  // name -> { label, help, kind } — the host's Plane-1 switch catalog (the
  // Tune modal passes its own). Empty → self-loaded on first open (global mount).
  catalog: { type: Object, default: () => ({}) },
  // true = render the body directly (no collapsed <details>/summary) and load on
  // mount — the POPUP mount (#6: the Edit view opens this in an AppModal, whose
  // title already is the header). Default false = the classic drawer.
  expanded: { type: Boolean, default: false },
});
const globalMode = computed(() => !props.modelId);
// QC-5 (2026-07-08, the user: "hardware defuatls brings up grid instead of your
// hardware default edit page"): the per-model POPUP opens STRAIGHT INTO the
// editor for this model — this PC's class row when one exists, else a new config
// prefilled with this PC's class. The list/table stays the GLOBAL library's
// affordance (many models — you pick a row there). Consequence recorded in the
// queue doc: per-model Import moves to the global library.
const directEdit = computed(() => props.expanded && !globalMode.value);

const loaded = ref(false);
const loading = ref(false);
const error = ref("");
const myClassKey = ref(""); // the CURRENT box's class (server-derived, override-aware)
const overrideKey = ref(""); // the class_key_override setting ("" = auto-detect)
const allKeys = ref([]);    // every distinct class key in the library (Add suggestions)
const tunes = ref([]);      // this mode's configs (all, or one model's)
const models = ref([]);     // catalog rows (global mode: names + the Add picker)
const ownCatalog = ref({}); // self-loaded knob labels when no `catalog` prop
const catalogMap = computed(() =>
  Object.keys(props.catalog).length ? props.catalog : ownCatalog.value,
);
const modelName = (id) => models.value.find((m) => m.id === id)?.name || id;
const modelOptions = computed(() =>
  models.value.map((m) => ({ label: m.name || m.id, value: m.id })),
);

// Editor state — one at a time:
// null | { modelId, classKey, keyLocked, rows: [{name,value}] }
const editing = ref(null);
const saving = ref(false);
const showImport = ref(false);
const importText = ref("");
const copiedKey = ref(""); // transient "Copied ✓" feedback per row

const rowId = (t) => `${t.modelId}|${t.classKey}`;

function _apply(res) {
  myClassKey.value = res.classKey || "";
  const all = res.tunes || [];
  // Distinct keys across the WHOLE library (before the per-model filter) — the
  // Add form suggests them so a shared class isn't re-typed with a typo.
  allKeys.value = [...new Set(all.map((t) => t.classKey))];
  tunes.value = all.filter((t) => !props.modelId || t.modelId === props.modelId);
}
const keySuggestions = computed(() =>
  [...new Set([myClassKey.value, ...allKeys.value].filter(Boolean))],
);

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    _apply(await listClassTunes());
    // The override state (§9, "detection proposes, never dictates") — enrichment:
    // a failed read just hides the "set manually" tag; the line still renders.
    try {
      overrideKey.value = (await request("/v1/ai/engine-config")).classKeyOverride || "";
    } catch { /* enrichment only */ }
    if (globalMode.value && !models.value.length) {
      // Model names + the Add picker; a failure just leaves raw ids (enrichment).
      try {
        models.value = (await request("/v1/ai/model-catalog")).rows || [];
      } catch { /* ids render verbatim */ }
    }
    if (!Object.keys(props.catalog).length && !Object.keys(ownCatalog.value).length) {
      ownCatalog.value = plane1SwitchCatalog(await fetchKnobCatalog());
    }
    loaded.value = true;
    if (directEdit.value && !editing.value) {
      const mine = tunes.value.find((t) => t.classKey === myClassKey.value);
      if (mine) startEdit(mine);
      else startAdd();
    }
  } catch (e) {
    error.value = e.message || "Couldn't load the class library.";
  } finally {
    loading.value = false;
  }
}
function onToggle(e) {
  if (e.target.open && !loaded.value) reload();
}
if (props.expanded) reload(); // the popup mount has no summary click to trigger it
defineExpose({ reload: () => (loaded.value ? reload() : undefined) });

const summaryOf = (t) => t.rows.map((r) => `${r.flagName}=${r.flagValue}`).join(" · ");

function startEdit(t) {
  showImport.value = false;
  editing.value = {
    modelId: t.modelId,
    classKey: t.classKey,
    keyLocked: true, // (model, class) IS the row's identity — a new pair = Add
    rows: t.rows.map((r) => ({ name: r.flagName, value: r.flagValue })),
  };
}
function startAdd() {
  showImport.value = false;
  editing.value = {
    modelId: props.modelId || "",
    classKey: myClassKey.value,
    keyLocked: false,
    rows: [],
  };
}
async function saveEdit() {
  const e = editing.value;
  if (!e) return;
  const mid = (e.modelId || "").trim();
  const key = (e.classKey || "").trim();
  const switches = Object.fromEntries(
    e.rows.filter((r) => (r.name || "").trim()).map((r) => [r.name.trim(), r.value ?? ""]),
  );
  if (!mid) {
    error.value = "Pick the model this config is for.";
    return;
  }
  if (!key || !Object.keys(switches).length) {
    error.value = "A class key and at least one switch are required.";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    _apply(await putClassTune(mid, switches, key));
    if (directEdit.value) {
      // Direct-edit stays on the editor (there is no list behind it) — re-enter
      // the saved row so the key locks, and confirm with a toast.
      const saved = tunes.value.find((t) => t.modelId === mid && t.classKey === key);
      if (saved) startEdit(saved);
      pushToast({ message: "Hardware/model class default saved ✓" });
    } else {
      editing.value = null;
    }
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
    _apply(await deleteClassTune(t.modelId, t.classKey));
  } catch (e) {
    error.value = e.message || "Couldn't delete the class config.";
  }
}

// The class-key override (§9, 2026-07-22 — "detection proposes, never dictates"):
// which class this MACHINE files under. Stored server-side (class_key_override
// runner setting) and applied at the ONE accessor every consumer reads, so the
// library match, the recommendation, and the badges all follow it together.
async function changeClassKey() {
  const key = await promptDialog({
    title: "Which PC class should this machine use?",
    message: "Detection proposes a class from your video memory and RAM. Setting it here makes this machine use a different class's configs — for when detection is wrong, or you want a specific library entry. Key form: vram<GB>|ram<GB>.",
    label: "Class key",
    defaultValue: myClassKey.value,
    confirmLabel: "Use this class",
  });
  if (!key) return; // cancelled (or emptied — clearing lives on "Use auto-detect")
  error.value = "";
  try {
    await request("/v1/ai/engine-config", { method: "PUT", body: { classKeyOverride: key } });
    await reload();
  } catch (e) {
    error.value = e.message || "Couldn't set the class override.";
  }
}
async function clearClassKeyOverride() {
  error.value = "";
  try {
    await request("/v1/ai/engine-config", { method: "PUT", body: { classKeyOverride: "" } });
    await reload();
  } catch (e) {
    error.value = e.message || "Couldn't clear the class override.";
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
    copiedKey.value = rowId(t);
    setTimeout(() => { copiedKey.value = ""; }, 1500);
  } catch {
    // clipboard blocked (permissions) — show the blob for hand-copy instead
    showImport.value = true;
    importText.value = blob;
  }
}
// Copy from the EDITOR view (§9 evening addition — "Copy wherever a config is
// visible": the per-model popup opens straight into the editor, so the table's
// Copy never renders there). Copies the SAVED row — save first to share edits.
function copyEditing() {
  const e = editing.value;
  const t = e && tunes.value.find((x) => x.modelId === e.modelId && x.classKey === e.classKey);
  if (t) copyTune(t);
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
  // Per-model mount: imports target the OPEN model deliberately (same-family
  // sharing). Global mount: the blob says which model it belongs to.
  const mid = props.modelId || (parsed?.modelId || "").trim();
  if (!mid) {
    error.value = 'The config needs a "modelId" here — this panel spans every model.';
    return;
  }
  saving.value = true;
  try {
    _apply(await putClassTune(mid, switches, key));
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
  <component :is="expanded ? 'div' : 'details'" class="lu-ct" :class="{ 'lu-ct--expanded': expanded }" @toggle="onToggle">
    <!-- Copy (#22, 2026-07-08): the old "— all models" suffix read as ONE tune
         covering every model. This is a LIBRARY: each row is one model's launch
         config for one PC class. -->
    <summary v-if="!expanded" class="lu-ct-summary">
      <span class="lu-ct-title">Hardware/model class defaults{{ globalMode ? " — the library" : "" }}</span>
      <span class="lu-muted">{{ globalMode
        ? "every saved config in one table — each row is one model × one PC class (video memory · RAM)"
        : "shared starting points by PC class (video memory · RAM)" }}</span>
    </summary>

    <div class="lu-ct-body">
      <!-- QC-6 (2026-07-08): ONE definition sentence + the user-decided standing
           caption — the explainer paragraph is gone (detail: docs/models.md). -->
      <p class="lu-muted lu-ct-help">
        A class config is <b>one model's</b> launch setup for every PC with the same video
        memory and RAM — used automatically unless the machine has its own applied config.
        <b>Models with an applied config keep their saved values</b> — a change here reaches
        them only when you refresh or remove their applied config in Tune &amp; measure.
      </p>

      <!-- §9 (2026-07-22): this PC's class in PLAIN WORDS (the raw key beside it),
           with the override affordance — detection proposes, never dictates. -->
      <div v-if="loaded" class="lu-ct-mine">
        <span class="lu-ct-minetxt">Your PC:
          <b>{{ myClassKey ? classKeyLabel(myClassKey) : "class not detected" }}</b>
          <code v-if="myClassKey" class="lu-ct-mykey">{{ myClassKey }}</code>
          <UiTag v-if="overrideKey" intent="info">set manually</UiTag>
        </span>
        <span class="lu-ct-mineact">
          <UiButton intent="secondary" size="small" @click="changeClassKey">Change…</UiButton>
          <UiButton v-if="overrideKey" intent="secondary" size="small" @click="clearClassKeyOverride">Use auto-detect</UiButton>
        </span>
      </div>

      <div v-if="error" class="lu-error">{{ error }}</div>
      <div v-if="loading" class="lu-muted">Loading…</div>

      <!-- QC-2 + QC-5 (2026-07-08): one thing on screen at a time — the list +
           button bar show only when nothing is being edited/imported (the editor
           REPLACES them, never stacks below), and the per-model popup skips the
           list entirely (directEdit). -->
      <template v-else-if="loaded">
        <table v-if="!directEdit && !editing && !showImport && hasRows" class="lu-ct-tbl">
          <thead>
            <tr><th v-if="globalMode">Model</th><th>PC class</th><th>Settings</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="t in tunes" :key="rowId(t)">
              <td v-if="globalMode" class="lu-ct-model">{{ modelName(t.modelId) }}</td>
              <td class="lu-ct-k">
                {{ classKeyLabel(t.classKey) }}
                <UiTag v-if="t.classKey === myClassKey" intent="success">this PC</UiTag>
                <UiTag v-if="t.builtIn" intent="info">built-in</UiTag>
              </td>
              <td class="lu-ct-sum">{{ summaryOf(t) }}</td>
              <td class="lu-ct-act">
                <UiButton intent="ghost" size="small" @click="startEdit(t)">Edit</UiButton>
                <UiButton intent="ghost" size="small" @click="copyTune(t)">
                  {{ copiedKey === rowId(t) ? "Copied ✓" : "Copy" }}
                </UiButton>
                <UiButton v-if="!t.builtIn" intent="ghost" size="small" @click="removeTune(t)">Delete</UiButton>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="!directEdit && !editing && !showImport" class="lu-muted lu-ct-empty">
          {{ globalMode
            ? "No class configs saved yet — measure a config in a model's Tune dialog and use “Save for hardware class”, or add one here."
            : "No class configs for this model yet — measure a config above and use “Save for hardware class”, or add one here." }}
        </p>

        <div v-if="!directEdit && !editing && !showImport" class="lu-ct-bar">
          <UiButton intent="secondary" size="small" @click="startAdd">＋ Add class config</UiButton>
          <UiButton intent="secondary" size="small" @click="showImport = !showImport; editing = null">Import…</UiButton>
        </div>

        <div v-if="showImport" class="lu-ct-editor">
          <UiTextarea v-model="importText" :rows="5"
            :placeholder="globalMode
              ? 'Paste a config copied from this panel — {&quot;modelId&quot;: …, &quot;classKey&quot;: &quot;vram8|ram32&quot;, &quot;switches&quot;: {…}}'
              : 'Paste a config copied from this panel — {&quot;classKey&quot;: &quot;vram8|ram32&quot;, &quot;switches&quot;: {…}}'" />
          <div class="lu-ct-edact">
            <UiButton intent="ghost" size="small" @click="showImport = false">Cancel</UiButton>
            <UiButton intent="primary" size="small" :loading="saving" @click="runImport">Import</UiButton>
          </div>
        </div>

        <div v-if="editing" class="lu-ct-editor">
          <label v-if="globalMode" class="lu-ct-field">
            <span class="lu-ct-cap">Model</span>
            <span v-if="editing.keyLocked" class="lu-ct-fixed">{{ modelName(editing.modelId) }}</span>
            <UiSelect v-else v-model="editing.modelId" :options="modelOptions" width="name" />
          </label>
          <label class="lu-ct-field">
            <span class="lu-ct-cap">Class key <span class="lu-muted">(vram&lt;GB&gt;|ram&lt;GB&gt; — this PC is {{ myClassKey }})</span></span>
            <!-- Suggests the library's existing keys while typing (free text still
                 allowed) so a shared class isn't fragmented by a typo — the user's
                 approved addition, 2026-07-22. -->
            <UiInput v-model="editing.classKey" :disabled="editing.keyLocked" width="token" list="lu-ct-key-suggestions" />
            <datalist id="lu-ct-key-suggestions">
              <option v-for="k in keySuggestions" :key="k" :value="k">{{ classKeyLabel(k) }}</option>
            </datalist>
          </label>
          <KnobGrid v-model="editing.rows" :catalog="catalogMap" />
          <div class="lu-ct-edact">
            <!-- Copy in the editor too (§9: Copy wherever a config is visible) —
                 renders once the row is saved (keyLocked); copies the saved rows. -->
            <UiButton v-if="editing.keyLocked" intent="ghost" size="small" @click="copyEditing">
              {{ copiedKey === `${editing.modelId}|${editing.classKey}` ? "Copied ✓" : "Copy" }}
            </UiButton>
            <!-- directEdit: the popup's own close is the way out — no Cancel to a
                 list that isn't there. -->
            <UiButton v-if="!directEdit" intent="ghost" size="small" @click="editing = null">Cancel</UiButton>
            <UiButton intent="primary" size="small" :loading="saving" @click="saveEdit">Save class config</UiButton>
          </div>
        </div>
      </template>
    </div>
  </component>
</template>

<style scoped>
.lu-ct { border-top: 1px solid var(--border); padding-top: 10px; }
/* Popup mount (#6): the AppModal title is the header — no drawer chrome. */
.lu-ct--expanded { border-top: none; padding-top: 0; }
.lu-ct--expanded .lu-ct-body { margin-top: 0; }
.lu-ct-summary { cursor: pointer; display: flex; flex-direction: column; gap: 2px; user-select: none; }
.lu-ct-title { font-weight: 700; font-size: 12.5px; color: var(--ink); }
.lu-ct-body { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.lu-ct-help { font-size: 11.5px; line-height: 1.5; margin: 0; }
.lu-ct-mine { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--ink); flex-wrap: wrap; }
.lu-ct-minetxt { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lu-ct-mykey { font-size: 10.5px; color: var(--muted); }
.lu-ct-mineact { display: inline-flex; gap: 6px; }
.lu-ct-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.lu-ct-tbl th { text-align: left; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); padding: 3px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.lu-ct-tbl td { padding: 5px 6px; border-bottom: 1px solid var(--border-soft, var(--border)); vertical-align: top; }
.lu-ct-model { color: var(--ink); }
.lu-ct-k { white-space: nowrap; color: var(--ink); display: flex; align-items: center; gap: 6px; }
.lu-ct-sum { font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--ink-2); word-break: break-word; }
.lu-ct-act { white-space: nowrap; text-align: right; }
.lu-ct-empty { margin: 0; font-size: 12px; }
.lu-ct-bar { display: flex; gap: 8px; }
.lu-ct-editor { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--r-sm, 8px); background: var(--surface-2); }
.lu-ct-field { display: flex; flex-direction: column; gap: 3px; }
.lu-ct-cap { font-size: 11px; color: var(--muted); }
.lu-ct-fixed { font-size: 12px; color: var(--ink-2); }
.lu-ct-edact { display: flex; justify-content: flex-end; gap: 8px; }
</style>
