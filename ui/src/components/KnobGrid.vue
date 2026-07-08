<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// KnobGrid — ONE generic key/value editor for BOTH Plane-1 engine switches and
// Plane-2 samplers (design D15). v-model is an array of { name, value }; a row
// present = that knob is set/sent. It has TWO opt-in presentations over the SAME
// model + the SAME commit/patch/remove helpers (no forked logic):
//
//   • DEFAULT (add-a-row) — `catalog` is an object map (name -> {label,help,
//     options}). You add a blank row, type a name + value, remove. So a NEW
//     llama.cpp param needs no code — just a row. Used by the Tune & measure
//     switch grid (LuModelCatalog).
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
  scrollMax: { type: String, default: "260px" },   // fixed height before the grid scrolls (single-column only)
  columns: { type: Number, default: 1 },           // >1 → flat multi-column grid (no Common/Advanced split), no inner scroll
  // Per-row PROVENANCE tags (2026-07-07, add-row mode): name -> a short display
  // string ("all models" · "your PC class" · "saved tune" · …) rendered muted
  // beside the row — the caller maps origin ids to user language. Empty = no tags.
  origins: { type: Object, default: () => ({}) },
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

const BOOL_OPTIONS = [{ value: "true", label: "On" }, { value: "false", label: "Off" }];
// Multi-column (samplers): ONE flat list — all knobs visible at once, flowing
// row-major into the next column (user decision 2026-06-30: no Common/Advanced
// split — anyone tuning these is already advanced). Single-column (switches) keeps
// the anti-overwhelm tiered expander: common rows shown, advanced behind a toggle.
const commonRows = computed(() => visibleCatalog.value.filter((k) => k.tier !== "advanced"));
const advancedRows = computed(() => visibleCatalog.value.filter((k) => k.tier === "advanced"));
const advancedOpen = ref(false);
const displayRows = computed(() => {
  if (props.columns > 1) return visibleCatalog.value.map((m) => ({ m }));
  const out = commonRows.value.map((m) => ({ m }));
  if (advancedRows.value.length) out.push({ expander: true });
  if (advancedOpen.value) out.push(...advancedRows.value.map((m) => ({ m })));
  return out;
});
</script>

<template>
  <!-- Checklist mode (opt-in): prefilled, enable/disable, kind-aware, scrollable. -->
  <div v-if="checklist && catalogList.length" class="ui-kg ui-kg-check" :class="{ 'is-cols': columns > 1 }" :style="columns > 1 ? { '--kg-cols': columns } : null">
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

  <!-- Default (add-a-row) mode. Every row is the SAME 3-column grid (name+origin
       stack · value · remove) — the origin tag sits UNDER the name (the checklist
       metacell precedent), never as its own content-sized column: a per-row auto
       column made each row's value field end at a different x, worst on the longest
       tag ("speculative decode" — the user's #13 "indented from the right"). -->
  <div v-else class="ui-kg">
    <div v-for="(r, i) in rows" :key="i" class="ui-kg-row">
      <div class="ui-kg-namecell">
        <UiInput
          :model-value="r.name"
          :placeholder="namePlaceholder"
          class="ui-kg-name"
          :title="meta(r.name)?.help || ''"
          @update:model-value="patch(i, 'name', $event)"
        />
        <span v-if="origins[r.name]" class="ui-kg-origin" title="Where this value comes from">{{ origins[r.name] }}</span>
      </div>
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
/* ONE row shape for every row (#13): name(+origin under it) · value · remove.
   align-items start (not center) so the value control tops-align with the name
   input when a row carries the origin line. */
.ui-kg-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: start; }
.ui-kg-namecell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ui-kg-name :deep(input) { font-family: var(--font-mono, monospace); }
.ui-kg-origin { font-size: 9.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; padding-left: 2px; }

/* Checklist mode */
.ui-kg-check { gap: 0; }
/* scrollbar-gutter: stable reserves the scrollbar's space ALWAYS, so a classic
   (space-taking) scrollbar appearing on overflow — Windows/WebView2; headless uses
   overlay scrollbars — never shifts the rows sideways. */
.ui-kg-scroll { overflow-y: auto; scrollbar-gutter: stable; display: flex; flex-direction: column; gap: 6px; padding-right: 4px; }
/* A tidy data grid: label sized to content + value adjacent, rows packed left so
   dead space falls on the right (never a gap between the label and its value). */
.ui-kg-crow { display: grid; grid-template-columns: auto 200px minmax(110px, 150px) auto; justify-content: start; gap: 9px; align-items: center; }
.ui-kg-crow.ui-kg-extra { grid-template-columns: 200px minmax(110px, 150px) auto; }

/* Multi-column flat grid (samplers, columns>1): knobs flow row-major so each
   successive/added knob lands in the next column. Columns hold a MIN width and the
   grid SCROLLS (both axes) rather than shrinking to fit — vertical past scrollMax,
   horizontal when the columns can't fit (e.g. a narrow Compare column); scrollbar-
   gutter (on the base .ui-kg-scroll rule) keeps it from shifting. "Other keys" +
   custom rows span the full width. */
.ui-kg-check.is-cols .ui-kg-scroll { display: grid; grid-template-columns: repeat(var(--kg-cols, 3), minmax(210px, 1fr)); gap: 6px 16px; align-content: start; overflow-x: auto; padding-right: 0; }
.ui-kg-check.is-cols .ui-kg-crow { grid-template-columns: auto minmax(0, 1fr) 84px auto; gap: 7px; }
.ui-kg-check.is-cols .ui-kg-label, .ui-kg-check.is-cols .ui-kg-flag { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-kg-check.is-cols .ui-kg-extras-h, .ui-kg-check.is-cols .ui-kg-crow.ui-kg-extra { grid-column: 1 / -1; }
.ui-kg-check.is-cols .ui-kg-crow.ui-kg-extra { grid-template-columns: 200px minmax(110px, 150px) auto; justify-content: start; }
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
