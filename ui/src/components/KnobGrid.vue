<script setup>
// SPDX-License-Identifier: MIT
// KnobGrid — ONE generic key/value editor for BOTH Plane-1 engine switches and
// Plane-2 samplers (design D15). v-model is an array of { name, value }; a row
// present = that knob is set/sent. It has TWO opt-in presentations over the SAME
// model + the SAME commit/patch/remove helpers (no forked logic):
//
//   • DEFAULT (add-a-row) — `catalog` is an object map (name -> {help, kind,
//     perRequest, options}). You add a blank row, type a name + value, remove (✕) —
//     a row present is a flag sent; absent = the engine's own behavior (the user's
//     command-line model, QC-17/18 2026-07-09). Values are PLAIN text/number
//     boxes (`kind` only picks the input type) — EXCEPT a knob that declares
//     seeded options, which renders a dropdown (QC-18 amended 2026-07-24, the
//     user's go after the "nobe" spec_type typo killed a load with the error
//     visible only in the router log; enum knobs get a select, everything else
//     stays free text). So a NEW llama.cpp param still needs no code — just a
//     row. A `perRequest` knob renders THE
//     one per-request note under its row (the labeling law, 2026-07-16 — a row here
//     must be a real launch switch or say it isn't). Used by the Global launch
//     defaults bundles, the PC class config editor, AND the Tune & measure grid.
//     Pass `groups` (+ per-name `rowGroups`) to render the SAME rows under
//     section headings (QC-10: "heading for each section instead") — the Tune
//     grid groups by which layer each value came from; rows added here land in
//     the first group.
//   • CHECKLIST (`checklist` + `catalogList`) — a PREFILLED grid of KNOWN knobs
//     from the seeded knob_catalog (ordered common-first by the API) — the
//     SAMPLER grids. Each row is an enable/disable checkbox + a kind-aware value,
//     with a per-row "↺ reset to default" when the value differs from the catalog
//     default, plus a footer "Reset to defaults". Rows split into Common (shown)
//     + Advanced (behind a "▸ Advanced" expander) by each row's `tier`. Names NOT
//     in the visible catalog (a custom key, or one `exclude`d because it is
//     edited elsewhere) fall into the raw "Other keys" section so nothing is ever
//     hidden. `catalogList` rows are the RAW catalog rows: { flagName,
//     kind, default, tier, help, options }. The row shows the EXACT flag name
//     only — no friendly label (user ruling 2026-07-16).
//   (The 2026-07-08 LEDGER mode — every catalog knob always visible with "engine
//   default" placeholders — was REMOVED 2026-07-09 with QC-17: the app no longer
//   claims to know the engine's defaults; unset switches simply don't render.)
import { computed, ref } from "vue";

import UiButton from "../common/components/UiButton.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";

const props = defineProps({
  modelValue: { type: Array, default: () => [] }, // [{ name, value }]
  catalog: { type: Object, default: () => ({}) }, // name -> { help, kind, perRequest }  (add-row mode)
  namePlaceholder: { type: String, default: "flag (e.g. ctx_len)" },
  valuePlaceholder: { type: String, default: "value" },
  addLabel: { type: String, default: "＋ Add switch" },
  // Grouped add-row mode (QC-10/17, 2026-07-09): section headings over the SAME
  // rows/helpers. `groups` = ordered [{ key, label }]; `rowGroups` maps a flag
  // name to its group key. Unmapped/new rows land in `fallbackGroup` (a group
  // key), else the FIRST group — QC-28 needs freshly-added rows in "Your
  // applied config", the LAST group, so the host names it explicitly. Empty
  // groups don't render.
  groups: { type: Array, default: () => [] },
  rowGroups: { type: Object, default: () => ({}) },
  fallbackGroup: { type: String, default: "" },
  // Checklist mode (opt-in) — leaves the add-row mode + its `catalog` prop intact.
  checklist: { type: Boolean, default: false },
  catalogList: { type: Array, default: () => [] }, // ordered raw rows [{ flagName, kind, default, help, options }]
  exclude: { type: Array, default: () => [] },     // flag names to hide from the managed list (edited elsewhere)
  reservedKeys: { type: Array, default: () => [] },// names managed by another control → hidden from "Other keys" too
  // Fixed height before the grid scrolls (single-column only). Pass "" to disable
  // the inner scroll entirely — for mounts that already live inside their own
  // scroll region (§7.6 Tune modal: exactly one scroller per area).
  scrollMax: { type: String, default: "260px" },
  columns: { type: Number, default: 1 },           // >1 → flat multi-column grid (no Common/Advanced split), no inner scroll
  // Single-column checklist WITHOUT the Common/Advanced tier split (queue #35 /
  // B4-3, 2026-07-08: "don't make a specific advance section … one column") —
  // the Lab's sampler grid wants one flat column; multi-column is already flat.
  flat: { type: Boolean, default: false },
  // Hide the footer "Reset to defaults" (catalog-default reset) — for hosts that
  // carry their own, differently-scoped reset (the Tune modal's "Reset to model
  // default" re-fetches the RESOLVED baseline; two reset buttons with different
  // meanings side-by-side is the confusion class the §7.6 rework removes).
  showFooterReset: { type: Boolean, default: true },
  // Per-row PROVENANCE tags (2026-07-07, both modes): name -> a short display
  // string ("all models" · "your PC class" · "saved tune" · "engine default" · …)
  // rendered muted under the row's name/label — the caller maps origin ids to
  // user language. Empty = no tags. In checklist mode the tag renders in the
  // metacell under the flag name (§7.6: every knob is visible, each labeled with
  // where its value comes from).
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
// QC-18: the value box is text or number — kind picks the input type, nothing else.
function valueType(name) {
  const kind = meta(name)?.kind;
  return kind === "int" || kind === "float" ? "number" : "text";
}
// QC-18 amendment (2026-07-24): a knob that declares seeded options renders a
// dropdown in add-row mode too (the checklist mode always did — same rule now).
function valueOptions(name) {
  const opts = meta(name)?.options;
  return Array.isArray(opts) && opts.length ? opts : null;
}
// ── add-row sections ──
// Always a section list (one unlabeled section when no `groups`), each row keeping
// its ORIGINAL array index so the same patch/remove helpers drive both shapes.
const sections = computed(() => {
  if (!props.groups.length) return [{ key: "", label: "", rows: rows.value.map((r, i) => ({ r, i })) }];
  const secs = props.groups.map((g) => ({ ...g, rows: [] }));
  const byKey = Object.fromEntries(secs.map((s) => [s.key, s]));
  const fallback = byKey[props.fallbackGroup] || secs[0];
  rows.value.forEach((r, i) => {
    (byKey[props.rowGroups[(r.name || "").trim()]] || fallback).rows.push({ r, i });
  });
  return secs.filter((s) => s.rows.length);
});

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
// A SET advanced knob is promoted into the always-visible list (§7.6: a value in
// effect must never hide behind the collapsed Advanced expander — "we keep hiding
// things" was the defect class); only UNSET advanced knobs collapse.
const commonRows = computed(() =>
  visibleCatalog.value.filter((k) => k.tier !== "advanced" || isOn(k.flagName)));
const advancedRows = computed(() =>
  visibleCatalog.value.filter((k) => k.tier === "advanced" && !isOn(k.flagName)));
const advancedOpen = ref(false);
const displayRows = computed(() => {
  if (props.columns > 1 || props.flat) return visibleCatalog.value.map((m) => ({ m }));
  const out = commonRows.value.map((m) => ({ m }));
  if (advancedRows.value.length) out.push({ expander: true });
  if (advancedOpen.value) out.push(...advancedRows.value.map((m) => ({ m })));
  return out;
});
</script>

<template>
  <!-- Checklist mode (opt-in): prefilled, enable/disable, kind-aware, scrollable. -->
  <div v-if="checklist && catalogList.length" class="ui-kg ui-kg-check" :class="{ 'is-cols': columns > 1 }" :style="columns > 1 ? { '--kg-cols': columns } : null">
    <div class="ui-kg-scroll" :style="scrollMax ? { maxHeight: scrollMax } : null">
      <template v-for="row in displayRows" :key="row.expander ? '__adv' : row.m.flagName">
        <button v-if="row.expander" type="button" class="ui-kg-advtoggle" @click="advancedOpen = !advancedOpen">
          {{ advancedOpen ? "▾" : "▸" }} Advanced <span class="ui-kg-advcount">({{ advancedRows.length }})</span>
        </button>
        <div v-else class="ui-kg-crow" :class="{ 'is-on': isOn(row.m.flagName) }">
          <UiCheckbox :model-value="isOn(row.m.flagName)" @update:model-value="(on) => toggle(row.m, on)" />
          <div class="ui-kg-metacell" :title="row.m.help || ''">
            <code class="ui-kg-flag">{{ row.m.flagName }}</code>
            <span v-if="origins[row.m.flagName]" class="ui-kg-origin"
              title="Where this value comes from">{{ origins[row.m.flagName] }}</span>
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
      <UiButton v-if="showFooterReset" intent="ghost" size="small" title="Reset the listed knobs to their defaults" @click="resetAll">Reset to defaults</UiButton>
    </div>
  </div>

  <!-- Default (add-a-row) mode — optionally sectioned by `groups` (QC-10). Every
       row is the SAME 3-column grid (name+origin stack · value · remove) — the
       origin tag sits UNDER the name (the checklist metacell precedent), never as
       its own content-sized column: a per-row auto column made each row's value
       field end at a different x, worst on the longest tag ("speculative decode" —
       the user's #13 "indented from the right"). QC-18: the value is a plain
       text/number box; the hover help (on both fields) says what the switch does
       and which values it accepts. -->
  <div v-else class="ui-kg">
    <template v-for="sec in sections" :key="sec.key || '__all'">
      <div v-if="sec.label" class="ui-kg-group-h">{{ sec.label }}</div>
      <template v-for="{ r, i } in sec.rows" :key="i">
        <div class="ui-kg-row">
          <div class="ui-kg-namecell">
            <UiInput
              :model-value="r.name"
              :placeholder="namePlaceholder"
              class="ui-kg-name"
              :title="meta(r.name)?.help || ''"
              @update:model-value="patch(i, 'name', $event)"
            />
            <span v-if="!groups.length && origins[r.name]" class="ui-kg-origin" title="Where this value comes from">{{ origins[r.name] }}</span>
          </div>
          <UiSelect
            v-if="valueOptions(r.name)"
            :model-value="r.value"
            :options="valueOptions(r.name)"
            :title="meta(r.name)?.help || ''"
            @update:model-value="patch(i, 'value', $event)"
          />
          <UiInput
            v-else
            :model-value="r.value"
            :placeholder="valuePlaceholder"
            :type="valueType(r.name)"
            :title="meta(r.name)?.help || ''"
            @update:model-value="patch(i, 'value', $event)"
          />
          <UiButton intent="ghost" size="small" title="Remove" @click="remove(i)">✕</UiButton>
        </div>
        <!-- The labeling law (user, 2026-07-16): a row in a switches surface must be a
             real engine switch or SAY it isn't. THE one note site — it rides the catalog
             flag, so all three add-row grids (Tune & measure · PC class configs · global
             bundles) get it from here; no per-grid copy. Full-width (not in the namecell)
             so the sentence stays one legible line. -->
        <div v-if="meta(r.name)?.perRequest" class="ui-kg-perreq">
          per-request — sent with every request as JSON, not a launch flag; applies without reload
        </div>
      </template>
    </template>
    <UiButton intent="ghost" size="small" class="ui-kg-add" @click="add">{{ addLabel }}</UiButton>
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
/* The per-request note — the muted note family (same --muted ink as .ui-kg-origin),
   but PROSE: sentence case, no uppercase/tracking, and it wraps. The negative top
   margin pulls it under its own row against the .ui-kg flex gap so it reads as that
   row's note, not a free-floating line. */
.ui-kg-perreq { font-size: 10.5px; color: var(--muted); line-height: 1.35; margin: -4px 0 1px; padding-left: 2px; }

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
.ui-kg-check.is-cols .ui-kg-flag { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-kg-check.is-cols .ui-kg-extras-h, .ui-kg-check.is-cols .ui-kg-crow.ui-kg-extra { grid-column: 1 / -1; }
.ui-kg-check.is-cols .ui-kg-crow.ui-kg-extra { grid-template-columns: 200px minmax(110px, 150px) auto; justify-content: start; }
.ui-kg-metacell { display: flex; flex-direction: column; min-width: 0; }
/* The exact switch name IS the row's name now — the friendly `.ui-kg-label` line was
   deleted (user ruling 2026-07-16); the monospace flag is promoted to the primary line. */
.ui-kg-flag { font-family: var(--font-mono, monospace); font-size: 12.5px; color: var(--ink); line-height: 1.25; }
.ui-kg-val :deep(input) { font-family: var(--font-mono, monospace); }
/* Advanced expander — a disclosure affordance styled like the section eyebrows
   (muted uppercase), not a ghost action button. */
.ui-kg-advtoggle { align-self: start; background: none; border: 0; cursor: pointer; font: inherit; font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); padding: 6px 2px 2px; }
.ui-kg-advtoggle:hover { color: var(--accent-ink, var(--accent)); }
.ui-kg-advcount { font-weight: 600; }
.ui-kg-resetspace { width: 0; }
.ui-kg-extras-h { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; margin: 8px 0 1px; }

/* Grouped add-row sections (QC-10): a small bold heading per layer — the same
   voice as the Global bundles' section labels ("All models" · "MoE models"). */
.ui-kg-group-h { font-weight: 600; font-size: 12px; color: var(--ink); margin-top: 6px; }
.ui-kg-group-h:first-child { margin-top: 0; }
.ui-kg-add { align-self: start; }
.ui-kg-foot { display: flex; align-items: center; margin-top: 9px; }
.ui-kg-footspace { flex: 1; }
</style>
