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
//    Presets page and Feature Workbench edit. "used by N features" is derived
//    from the refs map (GET /v1/ai/preset-assignments). QC-43 any-write
//    invalidation refreshes every chip after the save (no local refresh math).
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
  // presetSource, think, level, reasoningWord, ask, cap, effective, capSource,
  // configured, detail }) — the popover reads presetId/presetName (blast radius)
  // and the cap/effective line from it. Only needed in editable mode.
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

const tooltip = computed(() =>
  props.editable
    ? `Change the model & reasoning for ${props.label || props.feature} — edits its preset`
    : `Runs on ${props.label || props.feature} — manage under AI settings → Presets`,
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
const draftReasoning = ref(""); // "" | low | medium | high | xhigh | max

const presetName = computed(() => props.route?.presetName || "this preset");

// The cap/effective line — LOCAL routes only (cloud carries cap = null, and a
// reasoning-off route carries empty reasoning fields ⇒ no line). No client math:
// ask / cap / effective come straight from the resolved-route row.
const capLine = computed(() => {
  const r = props.route;
  if (!r || r.cap == null) return "";
  const askTxt = r.ask == null ? "Max" : r.ask;
  return `ask ${askTxt} · hardware cap ${r.cap} · effective ${r.effective ?? r.cap}`;
});
// "Always thinks" note: a Max / no-number ask runs at the full hardware cap.
const alwaysThinksNote = computed(() => {
  const r = props.route;
  if (!r || r.cap == null) return "";
  return r.ask == null ? "Max always thinks up to the hardware cap." : "";
});

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
    // The stored think+effort pair collapses to the one dropdown value: Off unless
    // both think is on AND an effort is set.
    draftReasoning.value = p && p.think && p.reasoningEffort ? p.reasoningEffort : "";
    const refs = assignRes?.features || {};
    memberCount.value = Object.values(refs).filter((v) => v === pid).length;
  } catch (e) {
    saveErr.value = e?.message || "Could not load the preset.";
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!presetRow.value) { saveErr.value = "No preset to edit."; return; }
  saving.value = true;
  saveErr.value = "";
  try {
    // Merge onto the FULL row — change ONLY provider/model/think/reasoningEffort;
    // every other tunable (temp/top_p/samplers/…) is preserved verbatim.
    const merged = {
      ...presetRow.value,
      providerId: draftPin.value?.providerId || "",
      model: draftPin.value?.model || "",
      think: draftReasoning.value !== "",
      reasoningEffort: draftReasoning.value || "",
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

          <label class="afc-pop-field">
            <span class="afc-pop-lbl">Reasoning</span>
            <select class="lu-input afc-pop-sel" :value="draftReasoning"
              @change="draftReasoning = $event.target.value">
              <option v-for="o in REASONING_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </label>

          <div v-if="capLine" class="afc-pop-cap">{{ capLine }}</div>
          <div v-if="alwaysThinksNote" class="afc-pop-note">{{ alwaysThinksNote }}</div>

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
.afc-pop-note { font-size: 10.5px; color: var(--muted); }
.afc-pop-blast { font-size: 11px; color: var(--muted); line-height: 1.4; }
.afc-pop-blast b { color: var(--ink-2); }
.afc-pop-err { font-size: 11px; color: var(--danger); }
.afc-pop-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
</style>