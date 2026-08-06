<script setup>
// SPDX-License-Identifier: MIT
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
// The Thinking control is THREE-STATE and PRESET-ONLY (2026-07-16 preset tier —
// docs/plans/2026-07-16-reasoning-budget-house-layering.md, "feature is the end of the
// line"): Off / Model|Provider default (think on, level stored EMPTY — local follows the
// selected model's layered budget live; cloud lets the provider decide) / a level (the
// preset's OWN ask). The save is the ONE preset PUT above for BOTH routes; this chip
// NEVER writes model-tunes/class-tunes (the layer libraries are edited in Tune &
// measure). Local vs cloud differs only in DISPLAY: option labels carry the local map's
// numbers, and the value+source line below reports what actually resolves.
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
// resolvedSourceLabel: the budget line's layer names. Importing the module also arms
// its any-write invalidation (QC-43), so a save here refreshes every mounted chip.
import { resolvedSourceLabel } from "../composables/useResolvedRoute.js";
import {
  presetToThinkingControl, resolvedToThinkingControl, THINKING_CUSTOM,
  thinkingControlToWire, thinkingOptionsFor,
} from "../thinkingControl.js";
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

// The Thinking control — vocabulary, options builder and both mappings live ONCE in
// ../thinkingControl.js (imported below); see it for the states' meaning.

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
const draftThinking = ref(""); // "" (Off) | a level | THINKING_CUSTOM (display-only)
const levelRows = ref([]); // the PROVIDER's reasoning-map rows [{ level, word, tokens }]

// The options — the ONE shared builder (thinkingControl.js), identical to the Lab's:
// Off + the provider's levels (numbered where it speaks numbers) + display-only Custom
// while Custom IS the state. The user's B ruling, 2026-07-16: the control shows what
// will actually run and save sets what's shown ("it is what it is").
const thinkingOptions = computed(() => thinkingOptionsFor({
  levelRows: levelRows.value,
  current: draftThinking.value,
  customValue: draftIsLocal.value ? props.route?.value : null,
}));

const presetName = computed(() => props.route?.presetName || "this preset");

// ── local vs cloud (2026-07-16 — DISPLAY-ONLY since the preset tier) ─────────
// Is the ROUTE's resolved provider the built-in runner? Uses the same
// `=== LOCAL_RUNNER_ID` id comparison modelApply.js already gates its Default/Embedding
// badges on (modelApply.js:70,72), not a provider-type lookup. This gates the
// value+source LINE (which reports the resolved route); `draftIsLocal` below picks the
// option labels. The SAVE does not branch — one preset PUT either way.
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
// A repoint to ANOTHER PROVIDER must arrive with that provider's level map, or the
// dropdown renders with no levels / stale labels. `!loading` keeps this to its actual
// job: loadPopover does its OWN awaited load on open (the seed must not race the map),
// so without the guard every open fetched the map twice.
watch(() => draftPin.value?.providerId, (pid, old) => {
  if (pid && pid !== old && popoverOpen.value && !loading.value) loadLevelMap();
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
    const refs = assignRes?.features || {};
    memberCount.value = Object.values(refs).filter((v) => v === pid).length;
    await loadLevelMap(); // every provider has a map (words and/or numbers) — labels need it
    // LOCAL seeds through the SHARED resolver (the B ruling): a stored level is the
    // preset's own ask; the follow state (empty level) shows the level whose map number
    // matches what actually runs, else Custom. CLOUD has no resolved number to match, so
    // it seeds from the stored pair — think-on/empty reads as Custom (the provider decides).
    draftThinking.value = draftIsLocal.value
      ? resolvedToThinkingControl(p, props.route?.value, levelRows.value)
      : presetToThinkingControl(p);
  } catch (e) {
    saveErr.value = e?.message || "Could not load the preset.";
  } finally {
    loading.value = false;
  }
}

// The provider's level map (the dropdown's labels — numbers where it speaks numbers,
// plain words where it doesn't). Keyed by PROVIDER, so one load covers any model.
// Enrichment only: on failure Off still works, levels just don't list.
async function loadLevelMap() {
  const provider = draftPin.value?.providerId || props.route?.providerId || "";
  if (!provider) { levelRows.value = []; return; }
  try {
    const rmap = await request(`/v1/ai/reasoning-map/${encodeURIComponent(provider)}`);
    levelRows.value = rmap?.rows || [];
  } catch {
    levelRows.value = [];
  }
}

// ONE preset save, both routes — the user's law verbatim: "changing provider model
// effort in chip for feature should be the same thing as going to routing by feature
// changing it there and clicking update." The thinking budget rides the SAME write
// (2026-07-16 preset tier): a picked level is the preset's own ask (the local resolver
// reads it via the map, source "preset"); "default" stores an EMPTY level — think on,
// follow the selected model's layered budget, nothing copied. No layer rows are ever
// written from here: the PC class config stays product data (the Tune & measure
// libraries edit it), your applied config stays what Apply wrote.
async function save() {
  if (!presetRow.value) { saveErr.value = "No preset to edit."; return; }
  saving.value = true;
  saveErr.value = "";
  try {
    // Merge onto the FULL row — change ONLY provider/model/think/reasoningEffort;
    // every other tunable (temp/top_p/samplers/…) is preserved verbatim. Save sets the
    // feature to what the control shows (the user's B ruling). The mapping is TOTAL
    // (thinkingControl.js): Custom writes {think: true, level: ""} — byte-identical to
    // the only stored shape it ever displays for, so it never silently changes thinking.
    const merged = {
      ...presetRow.value,
      providerId: draftPin.value?.providerId || "",
      model: draftPin.value?.model || "",
      ...thinkingControlToWire(draftThinking.value),
    };
    await request(`/v1/ai/engine-presets/${encodeURIComponent(presetRow.value.id)}`, {
      method: "PUT",
      body: merged,
    });
    // QC-43: the kit client's post-write hook invalidates useResolvedRoute, so
    // every mounted chip (incl. this one, via its host's `route` prop) refetches.
    popoverOpen.value = false;
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

          <!-- ONE three-state control, both routes (Off / Model|Provider default /
               levels). Local levels show their map numbers; the line below reports
               what actually resolves and which layer said so. -->
          <label class="afc-pop-field">
            <span class="afc-pop-lbl">Thinking</span>
            <select class="lu-input afc-pop-sel" :value="draftThinking"
              @change="draftThinking = $event.target.value">
              <option v-for="o in thinkingOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </label>

          <div v-if="budgetLine" class="afc-pop-cap">{{ budgetLine }}</div>
          <div v-if="isUnlimited" class="afc-pop-warn">Unlimited ⚠ — this model has been observed to loop; may think until the context fills</div>
          <!-- The capability gate's honest state (approved 2026-08-06): the preset asks
               for thinking but the resolved model can't think, so runs go out without it.
               REQUIRED annotation — an invisible gate would be the magic the gate kills. -->
          <div v-if="props.route?.thinkInactive" class="afc-pop-cap">Thinking on — inactive: this model doesn't think</div>

          <!-- Every save is preset-sized now — the thinking level rides the preset. -->
          <div class="afc-pop-blast">
            Changes the “<b>{{ presetName }}</b>” preset — used by {{ memberCount }}
            feature{{ memberCount === 1 ? "" : "s" }}
          </div>

          <div v-if="saveErr" class="afc-pop-err">{{ saveErr }}</div>

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
/* :global is REQUIRED, not a shortcut — PROVEN by DOM probe 2026-07-16, do not "clean up".
   reka-ui's PopoverContent root receives the `class` (attr fallthrough) but NOT Vue's
   scope attribute, so a scoped `.afc-pop` rule matches NOTHING and the popover ships
   BOXLESS — no width, no background, shrink-wrapped to its widest <select>, text bleeding
   over whatever is behind it. It looks correctly wired in source, which is why it shipped.
   Measured, same jsdom probe, same day:
     .afc-pop  (PopoverContent root) → data-dismissable-layer|style|tabindex|class|id|…  NO data-v
     .ui-modal (DialogContent root)  → data-v-f924ce02|data-dismissable-layer|class|…    HAS data-v
   So this is NOT general to reka portals: AppModal/HelpDrawer (DialogContent) are fine and
   stay scoped; UiSelect carries no scoped block. LuFeatureChip is the kit's ONLY
   PopoverContent. The slot's children DO get the scope id and stay scoped below — only the
   root rule must be global. If a reka upgrade ever propagates it, this can go back. */
:global(.afc-pop) {
  /* 999 — NOT a guess: this popover portals to <body> (PopoverPortal, no `to`), so in a
     modal it lands as a SIBLING of AppModal's .ui-modal-overlay (z 200) / .ui-modal
     (z 201), and reka's [data-reka-popper-content-wrapper] carries `z-index: auto` (no
     stacking context) — so THIS number competes directly with the overlay's. At 60 it
     painted behind the scrim + its backdrop blur = invisible ("model pick is not
     opening", user 2026-07-17). 999 matches .ui-select-content (common/styles.css) — the
     other body-portalled reka popper that already clears modals — one value for one role.
     Pinned by justwrite-app chipPopoverStacking.test.js. */
  z-index: 999;
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
.afc-pop-blast { font-size: 11px; color: var(--muted); line-height: 1.4; }
.afc-pop-blast b { color: var(--ink-2); }
.afc-pop-err { font-size: 11px; color: var(--danger); }
.afc-pop-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
</style>