<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// KnobGrid — ONE generic key/value editor for BOTH Plane-1 engine switches and
// Plane-2 samplers (design D15). v-model is an array of { name, value }; a row
// present = that knob is set/sent. It has TWO opt-in presentations over the SAME
// model + the SAME commit/patch/remove helpers (no forked logic):
//
//   • DEFAULT (add-a-row) — `catalog` is an object map (name -> {label,help,
//     options}). You add a blank row, type a name + value, remove. So a NEW
//     llama.cpp param needs no code — just a row. Used by the per-model switch
//     editor (LuModelCatalog) and the legacy job editor.
//   • CHECKLIST (`checklist` + `catalogList`) — a PREFILLED grid of KNOWN knobs
//     from the seeded knob_catalog (ordered common-first by the API). Each row is
//     an enable/disable checkbox + a kind-aware value (enum→select, int/float→
//     number, bool→On/Off select), with a per-row "↺ reset to default" when the
//     value differs from the catalog default, plus a footer "Reset to defaults".
//     Rows split into Common (shown) + Advanced (behind a "▸ Advanced" expander)
//     by each row's `tier`. Names NOT in the visible catalog (a custom key, or one
//     `exclude`d because it is edited elsewhere) fall into the raw "Other keys"
//     section so nothing is ever hidden. `catalogList` rows are the RAW catalog
//     rows: { flagName, label, kind, default, tier, help, options }.
import { computed, ref } from "vue";

import UiButton from "../common/components/UiButton.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";

const props = defineProps({
  modelValue: { type: Array, default: () => [] }, // [{ name, value }]
  catalog: { type: Object, default: () => ({}) }, // name -> { label, help, options }  (add-row mode)
  namePlaceholder: { type: String, default: "flag (e.g. ctx_len)" },
  valuePlaceholder: { type: String, default: "value" },
  addLabel: { type: String, default: "＋ Add switch" },
  // Checklist mode (opt-in) — leaves the add-row mode + its `catalog` prop intact.
  checklist: { type: Boolean, default: false },
  catalogList: { type: Array, default: () => [] }, // ordered raw rows [{ flagName, label, kind, default, help, options }]
  exclude: { type: Array, default: () => [] },     // flag names to hide from the managed list (edited elsewhere)
  reservedKeys: { type: Array, default: () => [] },// names managed by another control → hidden from "Other keys" too
  scrollMax: { type: String, default: "260px" },   // fixed height before the grid scrolls
});
const emit = defineEmits(["update:modelValue"]);

const rows = computed(() => props.modelValue || []);
function commit(next) {
  emit("update:modelValue", next);
}
function patch(i, key, v) {
  commit(rows.value.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
}
function add() {
  commit([...rows.value, { name: "", value: "" }]);
}
function remove(i) {
  commit(rows.value.filter((_, j) => j !== i));
}
function meta(name) {
  return props.catalog?.[name] || null;
}

// ── checklist mode ───────────────────────────────────────────────────────────
// The knobs shown as managed rows (catalog minus `exclude`), in catalog order.
const visibleCatalog = computed(() => props.catalogList.filter((k) => !props.exclude.includes(k.flagName)));
const visibleNames = computed(() => new Set(visibleCatalog.value.map((k) => k.flagName)));
// Anything in the model that is NOT a managed row — custom keys, blank new rows,
// or an excluded knob that happens to be set — shown raw so it is never dropped.
const extraRows = computed(() =>
  rows.value
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !visibleNames.value.has(r.name) && !props.reservedKeys.includes(r.name)),
);
function isOn(name) {
  return rows.value.some((r) => r.name === name);
}
function valOf(name) {
  const r = rows.value.find((x) => x.name === name);
  return r ? r.value : undefined;
}
// A knob's default value, normalized: a bool flag is a presence flag whose natural
// "on" value is "true" (or its catalog default); everything else uses the catalog
// default (may be "" → the user types it). Drives enable-prefill + reset + changed.
function defaultFor(m) {
  return m.kind === "bool" ? (m.default || "true") : (m.default ?? "");
}
function toggle(m, on) {
  if (on) {
    if (!isOn(m.flagName)) commit([...rows.value, { name: m.flagName, value: defaultFor(m) }]);
  } else {
    commit(rows.value.filter((r) => r.name !== m.flagName));
  }
}
function setVal(name, v) {
  commit(rows.value.map((r) => (r.name === name ? { ...r, value: v } : r)));
}
function isChanged(m) {
  return isOn(m.flagName) && (valOf(m.flagName) ?? "") !== defaultFor(m);
}
function resetOne(m) {
  setVal(m.flagName, defaultFor(m));
}
function resetAll() {
  commit(
    rows.value.map((r) => {
      const m = visibleCatalog.value.find((k) => k.flagName === r.name);
      return m ? { ...r, value: defaultFor(m) } : r;
    }),
  );
}

// Common rows show directly; advanced sit behind an expander (anti-overwhelm split).
const BOOL_OPTIONS = [{ value: "true", label: "On" }, { value: "false", label: "Off" }];
const commonRows = computed(() => visibleCatalog.value.filter((k) => k.tier !== "advanced"));
const advancedRows = computed(() => visibleCatalog.value.filter((k) => k.tier === "advanced"));
const advancedOpen = ref(false);
// ONE render list: common rows, an expander marker (when any advanced exist), then
// the advanced rows when open — so the row markup stays single-sourced (no dup).
const displayRows = computed(() => {
  const out = commonRows.value.map((m) => ({ m }));
  if (advancedRows.value.length) out.push({ expander: true });
  if (advancedOpen.value) out.push(...advancedRows.value.map((m) => ({ m })));
  return out;
});
</script>

<template>
  <!-- Checklist mode (opt-in): prefilled, enable/disable, kind-aware, scrollable. -->
  <div v-if="checklist && catalogList.length" class="ui-kg ui-kg-check">
    <div class="ui-kg-scroll" :style="{ maxHeight: scrollMax }">
      <template v-for="row in displayRows" :key="row.expander ? '__adv' : row.m.flagName">
        <button v-if="row.expander" type="button" class="ui-kg-advtoggle" @click="advancedOpen = !advancedOpen">
          {{ advancedOpen ? "▾" : "▸" }} Advanced <span class="ui-kg-advcount">({{ advancedRows.length }})</span>
        </button>
        <div v-else class="ui-kg-crow" :class="{ 'is-on': isOn(row.m.flagName) }">
          <UiCheckbox :model-value="isOn(row.m.flagName)" @update:model-value="(on) => toggle(row.m, on)" />
          <div class="ui-kg-metacell" :title="row.m.help || ''">
            <span class="ui-kg-label">{{ row.m.label || row.m.flagName }}</span>
            <code class="ui-kg-flag">{{ row.m.flagName }}</code>
          </div>
          <UiSelect
            v-if="row.m.kind === 'bool'"
            class="ui-kg-val"
            :model-value="valOf(row.m.flagName) ?? 'true'"
            :options="BOOL_OPTIONS"
            :disabled="!isOn(row.m.flagName)"
            @update:model-value="setVal(row.m.flagName, $event)"
          />
          <UiSelect
            v-else-if="row.m.options && row.m.options.length"
            class="ui-kg-val"
            :model-value="valOf(row.m.flagName) ?? ''"
            :options="row.m.options"
            :disabled="!isOn(row.m.flagName)"
            @update:model-value="setVal(row.m.flagName, $event)"
          />
          <UiInput
            v-else
            class="ui-kg-val"
            :model-value="valOf(row.m.flagName) ?? ''"
            :type="row.m.kind === 'int' || row.m.kind === 'float' ? 'number' : 'text'"
            :disabled="!isOn(row.m.flagName)"
            :placeholder="row.m.default || 'value'"
            @update:model-value="setVal(row.m.flagName, $event)"
          />
          <UiButton v-if="isChanged(row.m)" intent="ghost" size="small" title="Reset to default" @click="resetOne(row.m)">↺</UiButton>
          <span v-else class="ui-kg-resetspace" />
        </div>
      </template>

      <!-- Keys not in the list above: a custom key, or one set here while also
           edited elsewhere. Raw name/value so nothing is hidden from the user. -->
      <template v-if="extraRows.length">
        <div class="ui-kg-extras-h lu-muted">Other keys</div>
        <div v-for="({ r, i }) in extraRows" :key="`x${i}`" class="ui-kg-crow ui-kg-extra">
          <UiInput :model-value="r.name" :placeholder="namePlaceholder" class="ui-kg-name" @update:model-value="patch(i, 'name', $event)" />
          <UiInput :model-value="r.value" :placeholder="valuePlaceholder" class="ui-kg-val" @update:model-value="patch(i, 'value', $event)" />
          <UiButton intent="ghost" size="small" title="Remove" @click="remove(i)">✕</UiButton>
        </div>
      </template>
    </div>

    <div class="ui-kg-foot">
      <UiButton intent="ghost" size="small" @click="add">{{ addLabel }}</UiButton>
      <span class="ui-kg-footspace" />
      <UiButton intent="ghost" size="small" title="Reset the listed knobs to their defaults" @click="resetAll">Reset to defaults</UiButton>
    </div>
  </div>

  <!-- Default (add-a-row) mode — unchanged. -->
  <div v-else class="ui-kg">
    <div v-for="(r, i) in rows" :key="i" class="ui-kg-row">
      <UiInput
        :model-value="r.name"
        :placeholder="namePlaceholder"
        class="ui-kg-name"
        :title="meta(r.name)?.help || ''"
        @update:model-value="patch(i, 'name', $event)"
      />
      <UiSelect
        v-if="meta(r.name)?.options"
        :model-value="r.value"
        :options="meta(r.name).options"
        @update:model-value="patch(i, 'value', $event)"
      />
      <UiInput
        v-else
        :model-value="r.value"
        :placeholder="valuePlaceholder"
        @update:model-value="patch(i, 'value', $event)"
      />
      <UiButton intent="ghost" size="small" title="Remove" @click="remove(i)">✕</UiButton>
    </div>
    <UiButton intent="ghost" size="small" @click="add">{{ addLabel }}</UiButton>
  </div>
</template>

<style scoped>
.ui-kg { display: flex; flex-direction: column; gap: 7px; }
.ui-kg-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; }
.ui-kg-name :deep(input) { font-family: var(--font-mono, monospace); }

/* Checklist mode */
.ui-kg-check { gap: 0; }
.ui-kg-scroll { overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 4px; }
/* A tidy data grid: label sized to content + value adjacent, rows packed left so
   dead space falls on the right (never a gap between the label and its value). */
.ui-kg-crow { display: grid; grid-template-columns: auto 200px minmax(110px, 150px) auto; justify-content: start; gap: 9px; align-items: center; }
.ui-kg-crow.ui-kg-extra { grid-template-columns: 200px minmax(110px, 150px) auto; }
.ui-kg-metacell { display: flex; flex-direction: column; min-width: 0; }
.ui-kg-label { font-size: 12.5px; color: var(--ink); line-height: 1.25; }
.ui-kg-flag { font-family: var(--font-mono, monospace); font-size: 10px; color: var(--muted); }
.ui-kg-val :deep(input) { font-family: var(--font-mono, monospace); }
/* Advanced expander — a disclosure affordance styled like the section eyebrows
   (muted uppercase), not a ghost action button. */
.ui-kg-advtoggle { align-self: start; background: none; border: 0; cursor: pointer; font: inherit; font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); padding: 6px 2px 2px; }
.ui-kg-advtoggle:hover { color: var(--accent-ink, var(--accent)); }
.ui-kg-advcount { font-weight: 600; }
.ui-kg-resetspace { width: 0; }
.ui-kg-extras-h { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; margin: 8px 0 1px; }
.ui-kg-foot { display: flex; align-items: center; margin-top: 9px; }
.ui-kg-footspace { flex: 1; }
</style>
