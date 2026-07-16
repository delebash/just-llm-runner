<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// LuFeatureChip — the "runs on" chip for ONE AI feature/action (C5; the GUI
// moved from JustWrite's AiFeatureChip). Two modes:
//
//  • READ-ONLY provenance (default): PRESENTATIONAL — the host owns state (the
//    LuModelPicker precedent): the resolved provider + model names arrive as
//    props (the host reads useResolvedRoute — the server-resolved action-preset
//    route); clicking emits `navigate` and the HOST routes to AI settings.
//
//  • EDIT DOORWAY (`editable`, opt-in — T6, 2026-07-15): clicking opens a small
//    popover that edits THE ACTION'S PRESET (provider+model + reasoning level).
//    One source: the chip's resolved route names the preset (presetId/presetName)
//    and the save writes `PUT /v1/ai/engine-presets/{id}` — the SAME preset the
//    Feature Workbench's Lab edits. "used by N features" is derived
//    from the refs map (GET /v1/ai/preset-assignments). QC-43 any-write
//    invalidation refreshes every chip after the save (no local refresh math).
//
// The reasoning control has TWO shapes, branched on whether the PIN being saved is the
// built-in runner (see `draftIsLocal` below — on open that IS the route; it diverges only
// when the picker repoints mid-popover) (2026-07-16 house layering —
// docs/plans/2026-07-16-reasoning-budget-house-layering.md):
//   – CLOUD: the level select, writing the preset's think + reasoningEffort.
//     The provider's reasoning_map owns what a level means. Unchanged.
//   – LOCAL (the built-in runner): the level is only VOCABULARY — the emitted
//     budget is the layered `reasoning_budget` switch (base bundle → class tune →
//     applied tune, most-specific wins). So the preset keeps think on/off ONLY and
//     the picked level's number is written to the layer that WON (`valueSource`)
//     through the existing model-tunes / class-tunes endpoints. Writing it to the
//     preset, or to a layer that didn't win, would be a masked write — the value
//     would be overridden and the line would keep reading the old number.
//
// The read-only mode stays byte-compatible with every existing mount: `editable`
// defaults false and the `route` prop (the full resolved-route row, needed only
// by the popover) defaults null. (This restores the click-to-edit doorway that
// QC-26/#224 deleted — now rebuilt on the one-source preset model, not the dead
// per-surface pin.)

import { computed, ref, watch } from "vue";
import {
  PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot,
} from "reka-ui";
import Icon from "../common/components/Icon.vue";
import UiButton from "../common/components/UiButton.vue";
import { request } from "../client.js";
import { listClassTunes, mergeClassSwitches, putClassTune, upsertSwitchRows } from "../classTunes.js";
import { resolvedSourceLabel, useResolvedRoute } from "../composables/useResolvedRoute.js";
import { LOCAL_RUNNER_ID } from "../services/modelApply.js";
import LuModelPicker from "./LuModelPicker.vue";

const props = defineProps({
  // Feature key, for aria/copy only (e.g. "writerAI", "critique").
  feature: { type: String, required: true },
  // Optional inline label ("Rewrite", "Critique"). Omitted → "Runs on ·" lead
  // unless `compact`.
  label: { type: String, default: "" },
  compact: { type: Boolean, default: false },
  // Host-resolved display values (the preset resolution already applied).
  resolvedProviderName: { type: String, default: "—" },
  resolvedModel: { type: String, default: "—" },
  // Opt-in edit doorway. Read-only mounts leave this false (byte-compatible).
  editable: { type: Boolean, default: false },
  // The FULL resolved-route row ({ providerId, model, presetId, presetName,
  // presetSource, think, level, reasoningWord, value, valueSource, configured,
  // detail }) — the popover reads presetId/presetName (the preset blast radius),
  // providerId (the local/cloud branch below) and, on a LOCAL route,
  // value/valueSource (the thinking budget + the layer it came from). Only needed
  // in editable mode.
  route: { type: Object, default: null },
});
const emit = defineEmits(["navigate"]);

// The Reasoning "ask" vocabulary — mirrors the backend REASONING_LEVELS
// (llm/reasoning_map_api.py) + ConfigColumn's REASONING_OPTIONS. "" = Off (think
// stored false); a level = think stored true at that effort. One stored pair.
const REASONING_OPTIONS = [
  { value: "", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];
// The level vocabulary in ascending order + its display words — the LOCAL budget
// editor labels each level with ITS OWN map number ("Low (1024)"), so it reuses the
// words above rather than a second table.
const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];
const LEVEL_WORD = Object.fromEntries(REASONING_OPTIONS.map((o) => [o.value, o.label]));
const CUSTOM = "__custom"; // the display-only "Custom (N)" option (an unmatched value)

const tooltip = computed(() =>
  props.editable
    ? `Change the model & reasoning for ${props.label || props.feature} — edits its preset`
    : `Runs on ${props.label || props.feature} — manage under AI settings → Routing by feature`,
);

// ── the edit doorway (editable only) ────────────────────────────────────────
const popoverOpen = ref(false);
const loading = ref(false);
const saving = ref(false);
const saveErr = ref("");
const providers = ref([]);
const presetRow = ref(null); // the FULL EnginePresetRow, merged on save
const memberCount = ref(0);
const draftPin = ref(null); // { providerId, model } | null (LuModelPicker v-model)
const draftReasoning = ref(""); // "" | low | medium | high | xhigh | max  (CLOUD)
const savedNote = ref("");      // the LOCAL budget save keeps the popover open — this confirms it
const localLevelRows = ref([]); // the LOCAL provider's reasoning-map rows [{ level, word, tokens }]
const draftBudget = ref("");    // "" (Off) | a level | CUSTOM  (LOCAL)

const { refreshRoute } = useResolvedRoute();

// The LOCAL "Thinking" options: Off + every level the provider's map carries, each
// labelled with ITS number ("Low (1024)"). A resolved value matching no level's
// tokens surfaces as a display-only "Custom (N)" — a custom NUMBER is typed in the
// switch grids, not picked here.
const localBudgetOptions = computed(() => {
  const byLevel = Object.fromEntries(localLevelRows.value.map((r) => [r.level, r]));
  const opts = [{ value: "", label: "Off" }];
  for (const lvl of LEVEL_ORDER) {
    const row = byLevel[lvl];
    if (row && row.tokens != null) opts.push({ value: lvl, label: `${LEVEL_WORD[lvl]} (${row.tokens})` });
  }
  if (draftBudget.value === CUSTOM) {
    opts.push({ value: CUSTOM, label: `Custom (${props.route?.value ?? "invalid"})` });
  }
  return opts;
});

const presetName = computed(() => props.route?.presetName || "this preset");

// ── local vs cloud (2026-07-16) ─────────────────────────────────────────────
// Is the ROUTE's resolved provider the built-in runner? Uses the same
// `=== LOCAL_RUNNER_ID` id comparison modelApply.js already gates its Default/Embedding
// badges on (modelApply.js:70,72), not a provider-type lookup. This gates the value+source
// LINE (which reports the resolved route); the CONTROL branches on `draftIsLocal` below.
// Cloud keeps the level select (the map owns its numbers); LOCAL edits the layered
// `reasoning_budget` switch, because on a local box the budget is a property of the
// MODEL on THIS hardware, not of one feature's preset.
const isLocalRoute = computed(() => (props.route?.providerId || "") === LOCAL_RUNNER_ID);

// THE CONTROL AND THE SAVE MUST KEY OFF THE SAME THING, and that thing is the pin being
// WRITTEN — not the route the popover opened on. The spec says "branch on the ROUTE", and on
// open that is the same fact (draftPin seeds from the preset, which is what resolved). It
// diverges only when the picker repoints mid-popover, a case the spec didn't anticipate —
// and there the pin is right: branching display on the route while saving on the pin lets
// the two disagree, which silently discards a visible pick (a cloud "High" on screen saved
// as think=false). An inherit/empty pin is intentionally NOT local: with no model named there
// is no model whose budget we could write.
const draftIsLocal = computed(() => (draftPin.value?.providerId || "") === LOCAL_RUNNER_ID);
// The value+source line reports the RESOLVED route, so it is only truthful while the pin
// still names that route; after a repoint the resolved row describes the model you left.
const pinNamesRoute = computed(() =>
  (draftPin.value?.providerId || "") === (props.route?.providerId || "")
  && (draftPin.value?.model || "") === (props.route?.model || ""));
// The model the budget edit will land on (the save re-resolves onto the pin), so the blast
// line names what will actually change.
const budgetModel = computed(() => draftPin.value?.model || props.route?.model || "");

// A repoint INTO local must arrive with the level map loaded, or the dropdown renders with
// no levels. Keyed by provider, so re-entering local costs nothing after the first load.
// `!loading` keeps this to its actual job: loadPopover does its OWN awaited load on open (the
// seed must not race the map), so without the guard every open fetched the map twice.
watch(draftIsLocal, (local) => {
  if (local && popoverOpen.value && !loading.value && !localLevelRows.value.length) loadLocalMap();
});

// The resolved budget + the LAYER it came from, straight off the wire — no client
// math (the mirror law). Thinking off ⇒ no value ⇒ no line. `value` is null with
// source "invalid" when the layer's row isn't a number: say so, never guess a number.
const budgetLine = computed(() => {
  const r = props.route;
  // Needs the ROUTE local (so value/valueSource are a local budget at all) AND the pin still
  // naming it (otherwise the row describes a model the user has already navigated away from).
  if (!isLocalRoute.value || !draftIsLocal.value || !pinNamesRoute.value || !r?.think) return "";
  // The approved vocabulary covers tune/class/base/default/invalid. The resolver's origin
  // set is wider — `base · type · mtp · class · tune` (switch_resolve.py:24-25) — so a
  // reasoning_budget typed into the MoE/dense/MTP bundle arrives as "type"/"mtp". Show the
  // raw origin rather than a dangling dash; never claim a layer it didn't come from.
  const label = resolvedSourceLabel(r.valueSource) || r.valueSource;
  return r.value == null
    ? `thinking budget — ${label}`
    : `thinking budget ${r.value} — ${label}`;
});
// -1 is a LEGAL typed value (never seeded) and honoured verbatim by the engine — so
// it ships with the warning it earned: the Gemma thinking loop is verified on-box.
const isUnlimited = computed(() => !!budgetLine.value && props.route?.value === -1);

function onChipClick() {
  if (props.editable) { popoverOpen.value = true; return; }
  emit("navigate");
}

watch(popoverOpen, (open) => { if (open) loadPopover(); });

async function loadPopover() {
  loading.value = true;
  saveErr.value = "";
  savedNote.value = "";
  try {
    const [provRes, presetsRes, assignRes] = await Promise.all([
      request("/v1/llm-providers"),
      request("/v1/ai/engine-presets"),
      request("/v1/ai/preset-assignments"),
    ]);
    providers.value = provRes?.providers || [];
    const pid = props.route?.presetId || "";
    // GET the preset first (the plan: change only provider/model/think/effort) —
    // seed the draft from the STORED preset, not the resolved route (the resolved
    // provider may be the dispatch fallback, not what the preset pins).
    presetRow.value = (presetsRes?.presets || []).find((p) => p.id === pid) || null;
    const p = presetRow.value;
    draftPin.value = {
      providerId: p?.providerId || props.route?.providerId || "",
      model: p?.model || props.route?.model || "",
    };
    // The stored think+effort pair collapses to the one dropdown value: Off unless
    // both think is on AND an effort is set.
    draftReasoning.value = p && p.think && p.reasoningEffort ? p.reasoningEffort : "";
    const refs = assignRes?.features || {};
    memberCount.value = Object.values(refs).filter((v) => v === pid).length;
    if (draftIsLocal.value) { await loadLocalMap(); seedLocalBudget(props.route); }
  } catch (e) {
    saveErr.value = e?.message || "Could not load the preset.";
  } finally {
    loading.value = false;
  }
}

// The provider's level→number map (the dropdown's numbers). Keyed by PROVIDER, so one load
// covers any local model. Enrichment only: on failure Off still works, levels just don't list.
async function loadLocalMap() {
  const provider = draftPin.value?.providerId || props.route?.providerId || "";
  if (!provider) { localLevelRows.value = []; return; }
  try {
    const rmap = await request(`/v1/ai/reasoning-map/${encodeURIComponent(provider)}`);
    localLevelRows.value = rmap?.rows || [];
  } catch {
    localLevelRows.value = [];
  }
}

// Seed the dropdown from a RESOLVED ROUTE ROW — never from props.route directly: the caller
// passes a row it just fetched, and props only flow down on the parent's next render, so
// reading props here would re-seed off the pre-save value. The pick is DERIVED from what
// actually resolves (the route's `value`), not from the preset — on a local route the preset
// carries think on/off only; the number lives in the layers.
function seedLocalBudget(route) {
  if (!route?.think) {
    draftBudget.value = ""; // Off
    return;
  }
  const match = localLevelRows.value.find((r) => r.tokens != null && r.tokens === route.value);
  draftBudget.value = match ? match.level : CUSTOM;
}

// Write the picked level's number into the layer that ACTUALLY WON (valueSource) —
// the user's one-value design. Writing anywhere else would be a masked write: the
// number would sit in a layer a more specific one overrides, and the line would go
// on reading the old value. Existing endpoints only; never the preset.
//
// `route` is passed in (never read off props here) for two reasons: props flow down on
// the parent's next render, not when an await resolves; and the caller hands us a route
// re-resolved AFTER think was turned on — a think-OFF route reports valueSource "", so
// the winning layer is literally unknowable until thinking is on. Returns true iff it wrote.
async function saveLocalBudget(route) {
  const level = draftBudget.value;
  // Off ⇒ think false, no budget (thinking is off). Custom ⇒ display-only: the value
  // is already in its layer and no level was picked, so there is nothing to write.
  if (level === "" || level === CUSTOM) return false;
  const picked = localLevelRows.value.find((r) => r.level === level)?.tokens;
  if (picked == null) return false; // no number in the map for this level ⇒ nothing to write
  const modelId = route?.model || "";
  if (!modelId) return false;
  const src = route?.valueSource || "";
  if (src === "tune") {
    // The applied config owns every row it carries. model-tunes PUT is the SAME wholesale
    // replace as class-tunes (tests/test_model_tunes.py::test_put_replaces_the_whole_set),
    // so this reads the full set and sends it all back through the ONE shared upsert.
    const cur = await request(`/v1/ai/model-tunes?modelId=${encodeURIComponent(modelId)}`);
    await request("/v1/ai/model-tunes", {
      method: "PUT",
      body: { modelId, switches: upsertSwitchRows(cur?.rows, "reasoning_budget", picked) },
    });
    return true;
  }
  // Every other layer (class | base | type | mtp | default | invalid) → the (model, THIS
  // box's class) row, which out-ranks every one of them (the layer order is
  // base < type < mtp < class < tune, switch_resolve.py:80-92) and is out-ranked only by
  // an applied tune, handled above. `listClassTunes()` is the existing accessor for this
  // machine's server-derived classKey (LuClassTunes reads the same field, LuClassTunes.vue:78).
  const lib = await listClassTunes();
  const classKey = lib?.classKey || "";
  if (!classKey) throw new Error("Couldn't read this PC's hardware class.");
  // The lookup is UNCONDITIONAL — never gated on src === "class". A class row can exist
  // while a BROADER layer still owns reasoning_budget (the row just doesn't carry that key;
  // only one model is seeded with it, seed.py:396-400), so src reads "base"/"default" there
  // while a row full of other switches is sitting in it. mergeClassSwitches carries the
  // replace hazard; it yields {reasoning_budget} alone when there is no row — the "create"
  // the spec asked for — and preserves the row's other switches when there is one.
  const existing = (lib.tunes || []).find((t) => t.modelId === modelId && t.classKey === classKey);
  await putClassTune(modelId, mergeClassSwitches(existing?.rows, "reasoning_budget", picked), classKey);
  return true;
}

async function save() {
  if (!presetRow.value) { saveErr.value = "No preset to edit."; return; }
  saving.value = true;
  saveErr.value = "";
  savedNote.value = "";
  const local = draftIsLocal.value;
  try {
    // The PRESET write goes FIRST — it owns think on/off, and on a local route that
    // ordering is load-bearing: a think-OFF route resolves no budget at all
    // (reasoning.py:72 returns an empty plan ⇒ valueSource ""), so the winning layer is
    // unknowable until thinking is on. Writing the budget before this would have to GUESS
    // a layer, and guessing "class" while an applied tune exists is a masked write.
    //
    // Merge onto the FULL row — change ONLY provider/model/think/reasoningEffort;
    // every other tunable (temp/top_p/samplers/…) is preserved verbatim. A LOCAL
    // preset keeps think ON/OFF only (the plan: no per-feature local budget) — the
    // level is display vocabulary the local resolver never reads, so it is not stored.
    const merged = {
      ...presetRow.value,
      providerId: draftPin.value?.providerId || "",
      model: draftPin.value?.model || "",
      think: local ? draftBudget.value !== "" : draftReasoning.value !== "",
      reasoningEffort: local ? "" : (draftReasoning.value || ""),
    };
    await request(`/v1/ai/engine-presets/${encodeURIComponent(presetRow.value.id)}`, {
      method: "PUT",
      body: merged,
    });
    // QC-43: the kit client's post-write hook invalidates useResolvedRoute, so
    // every mounted chip (incl. this one, via its host's `route` prop) refetches.
    if (!local) { popoverOpen.value = false; return; }
    // LOCAL: re-resolve WITH think applied, so valueSource names the real winning layer,
    // then write the budget into THAT layer and re-resolve once more to show where it
    // landed (a write can land in a different layer than the one it read).
    const resolved = await refreshRoute(props.feature);
    // NO `|| props.route` fallback here. refreshRoute swallows fetch errors and returns null
    // (useResolvedRoute.js), and the preset PUT just dropped the cache — so falling back would
    // hand saveLocalBudget a stale row and put us straight back to GUESSING the winning layer,
    // the one thing this ordering exists to prevent. A visible failure beats a masked write.
    if (!resolved) {
      throw new Error("Saved the preset, but couldn't re-check which layer owns this model's budget — the budget was left unchanged.");
    }
    const wrote = await saveLocalBudget(resolved);
    const final = wrote ? await refreshRoute(props.feature) : resolved;
    // Re-seed from the row we were handed — props.route only flows down on the parent's
    // next render, so reading it here would re-seed off the PRE-save value.
    seedLocalBudget(final || resolved);
    savedNote.value = "Saved ✓";
  } catch (e) {
    saveErr.value = e?.message || "Save failed.";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <PopoverRoot v-model:open="popoverOpen">
    <PopoverAnchor as-child>
      <button class="afc-chip" @click.stop="onChipClick" v-tooltip.bottom="tooltip">
        <template v-if="label">
          <span class="afc-label">{{ label }}</span>
          <span class="afc-sep">·</span>
        </template>
        <template v-else-if="!compact">
          <span class="afc-label">Runs on</span>
          <span class="afc-sep">·</span>
        </template>
        <b class="afc-provider">{{ resolvedProviderName }}</b>
        <span class="afc-sep">·</span>
        <code class="afc-model">{{ resolvedModel }}</code>
        <Icon name="ChevRight" :size="9" class="afc-caret" />
      </button>
    </PopoverAnchor>

    <PopoverPortal v-if="editable">
      <PopoverContent class="afc-pop" side="bottom" align="start" :side-offset="6" :collision-padding="8">
        <div class="afc-pop-h">Runs on <b>{{ label || feature }}</b></div>

        <div v-if="loading" class="afc-pop-loading">Loading…</div>
        <template v-else>
          <LuModelPicker
            :model-value="draftPin"
            :providers="providers"
            editable
            stacked
            labels
            inherit-label="Inherit default"
            @update:model-value="draftPin = $event" />

          <!-- LOCAL: the thinking-budget editor (the level is just the vocabulary for a
               number in the model's layered config). CLOUD: the level select, unchanged —
               the provider's map owns what a level means. -->
          <label v-if="draftIsLocal" class="afc-pop-field">
            <span class="afc-pop-lbl">Thinking</span>
            <select class="lu-input afc-pop-sel" :value="draftBudget"
              @change="draftBudget = $event.target.value">
              <option v-for="o in localBudgetOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </label>
          <label v-else class="afc-pop-field">
            <span class="afc-pop-lbl">Reasoning</span>
            <select class="lu-input afc-pop-sel" :value="draftReasoning"
              @change="draftReasoning = $event.target.value">
              <option v-for="o in REASONING_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </label>

          <div v-if="budgetLine" class="afc-pop-cap">{{ budgetLine }}</div>
          <div v-if="isUnlimited" class="afc-pop-warn">Unlimited ⚠ — this model has been observed to loop; may think until the context fills</div>

          <!-- Blast radius. LOCAL edits a MODEL-on-this-hardware row, so it must never
               claim to be a preset-sized change. -->
          <div v-if="draftIsLocal" class="afc-pop-blast">
            Changes <b>{{ budgetModel }}</b>'s thinking budget on this hardware — every
            thinking feature on this model shares it
          </div>
          <div v-else class="afc-pop-blast">
            Changes the “<b>{{ presetName }}</b>” preset — used by {{ memberCount }}
            feature{{ memberCount === 1 ? "" : "s" }}
          </div>

          <div v-if="saveErr" class="afc-pop-err">{{ saveErr }}</div>
          <div v-else-if="savedNote" class="afc-pop-saved">{{ savedNote }}</div>

          <div class="afc-pop-foot">
            <UiButton intent="ghost" size="small" @click="popoverOpen = false">Cancel</UiButton>
            <UiButton intent="primary" size="small" :loading="saving" @click="save">Save</UiButton>
          </div>
        </template>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
.afc-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  font-size: 11.5px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  line-height: 1.3;
  white-space: nowrap;
}
.afc-chip:hover { background: var(--surface-2); border-color: var(--border-strong); }

.afc-label    { color: var(--muted); font-weight: 500; }
.afc-sep      { color: var(--muted); opacity: 0.6; }
.afc-provider { font-weight: 600; }
.afc-model {
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  color: var(--ink-2);
  background: transparent;
}
.afc-caret { color: var(--muted); margin-left: 2px; flex-shrink: 0; }

/* ── the edit popover ─────────────────────────────────────────────────────── */
.afc-pop {
  z-index: 60;
  width: 300px; max-width: calc(100vw - 24px);
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  font-size: 12px; color: var(--ink-2);
}
.afc-pop-h { font-size: 11.5px; color: var(--muted); }
.afc-pop-h b { color: var(--ink); font-weight: 600; }
.afc-pop-loading { color: var(--muted); font-size: 12px; padding: 4px 0; }
.afc-pop-field { display: flex; flex-direction: column; gap: 4px; }
.afc-pop-lbl { font-size: 11px; font-weight: 600; color: var(--muted); }
.afc-pop-sel { cursor: pointer; appearance: auto; width: 100%; }
.afc-pop-cap {
  font-size: 11px; color: var(--ink-2);
  font-variant-numeric: tabular-nums;
  padding: 4px 8px; border-radius: 6px; background: var(--surface-2);
}
/* The -1 loop warning — a real hazard (verified on-box), so it carries warning ink,
   not the muted note voice the retired "always thinks" line used. */
.afc-pop-warn { font-size: 10.5px; color: var(--danger); line-height: 1.4; }
.afc-pop-saved { font-size: 11px; color: var(--success, #3a7d63); font-weight: 600; }
.afc-pop-blast { font-size: 11px; color: var(--muted); line-height: 1.4; }
.afc-pop-blast b { color: var(--ink-2); }
.afc-pop-err { font-size: 11px; color: var(--danger); }
.afc-pop-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
</style>