<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// THE one launch-switch editor (§7.1, locked 2026-07-08) — Quick tune (#20 → Plan B
// 2026-07-05), extracted from LuModelCatalog; opened from the model catalog's per-row
// Tune action AND from a Lab column's "Engine switches ↗" link (launch config lives on
// the MODEL — one editor, everywhere). Loads the model with ad-hoc Plane-1 engine
// flags + probes decode tok/s on this box.
//
// §7.6 (2026-07-08) + the same-day QC cluster (queue doc §9, QC-1..8): the grid is
// the KnobGrid LEDGER over the WHOLE plane-1 knob catalog — every switch is one
// flat, always-visible row (no Advanced expander, no checkboxes, no per-row
// resets), the flag name with its origin underneath, tags carrying the REAL
// editor names (Global launch default · Hardware-class default · your applied
// config · computed for this PC · engine default). Set rows pre-fill from the
// model's RESOLVED defaults INCLUDING the fit-computed values ("Add to grid" is
// retired); unset rows show the engine's own default as a muted placeholder —
// writing a value sets a row, clearing it unsets it. **Apply**
// is a SNAPSHOT: the model takes ownership of every set row (PUT /v1/ai/model-tunes;
// the server derives the machine key and stores the layer BASELINE beside it) — once
// applied, the model stops following later global/class changes (the user's decision:
// "once you tune a model you no longer get live updates"). Drift is surfaced honestly:
// when today's defaults differ from the baseline stored at apply time, a notice offers
// "Refresh from defaults" — it fills the GRID only; Apply commits. Apply also RELOADS
// the model immediately when it is currently running (no stale window: applied ==
// active), behind a blast-radius confirm naming the affected tasks. "Remove applied
// config" (DELETE) returns the model to the live layered defaults, same reload.
// Self-contained (loads its own knob catalog); mount behind v-if with a :model
// ({id, name}) and listen for @close.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { request } from "../client.js";
import { classKeyLabel, listClassTunes, putClassTune } from "../classTunes.js";
import { fetchKnobCatalog, plane1SwitchCatalog } from "../knobCatalog.js";
import { recordMeasurement } from "../measurements.js";
import { resolveModelDefaults } from "../modelDefaults.js";
import { TUNE_BADGES } from "../tuneState.js";
import { confirmDialog } from "../common/services/dialog.js";
import { pushToast } from "../common/services/toastBridge.js";
import AppModal from "../common/components/AppModal.vue";
import KnobGrid from "./KnobGrid.vue";
import LuClassTunes from "./LuClassTunes.vue";
import LuGlobalSwitches from "./LuGlobalSwitches.vue";
import LuMeasureHistory from "./LuMeasureHistory.vue";
import UiButton from "../common/components/UiButton.vue";
import UiTag from "../common/components/UiTag.vue";

const props = defineProps({
  model: { type: Object, required: true }, // { id, name } — the model being tuned
});
const emit = defineEmits(["close"]);

const gb = (mb) => (mb >= 10240 ? `${Math.round(mb / 1024)}` : `${(mb / 1024).toFixed(1)}`);

// Knob-catalog metadata (C1) — labels/typed inputs for the Plane-1 switch grid.
// Fetch + map come from the shared knobCatalog.js (one source with LuClassTunes'
// global mount); the raw list feeds the checklist (§7.6: every knob is a row)
// and the unknown-flag badge below.
const knobCatalog = ref([]);
const switchCatalog = computed(() => plane1SwitchCatalog(knobCatalog.value));
const plane1List = computed(() => knobCatalog.value.filter((k) => k.plane === 1));
async function loadKnobCatalog() {
  knobCatalog.value = await fetchKnobCatalog(); // [] on failure — enrichment only
}

const tuneRows = ref([]); // KnobGrid rows [{ name, value }] — the SET switches
const tunePhase = ref(""); // "" | loading | measuring | done | error
const tuneDetail = ref(""); // live load detail
const tuneResult = ref(null); // { tokensPerSec, completionTokens, ms, vramTotalMb, ramTotalMb }
const tuneErr = ref("");
const tuneBusy = computed(() => tunePhase.value === "loading" || tunePhase.value === "measuring");

// Per-row PROVENANCE (2026-07-07 origins; §7.6 makes them total): which layer
// wrote each SET value, in user language — and for UNSET knobs, which layer the
// value would come from if you left it unchecked (the inherited fallback: a
// class/global value when one exists underneath, else the engine's own default).
// Fit-computed values are ordinary rows tagged "computed for this PC" (2026-07-08:
// "Add to grid" retired — the user's snapshot decision means Apply deliberately
// takes ownership of them; "Refresh from defaults" re-derives them any time).
// QC-1 (2026-07-08): tags carry the REAL editor names — the same words as the
// "Global launch defaults" / "Hardware-class defaults" buttons they point at.
const ORIGIN_LABELS = {
  base: "Global launch default (all models)", type: "Global launch default (model type)",
  mtp: "Global launch default (spec decode)", class: "Hardware-class default",
  tune: "your applied config",
  computed: "computed for this PC", autotune: "auto-tune winner",
};
const tuneOrigins = ref({}); // flagName -> layer id, for the SET rows
const inheritedOrigins = ref({}); // flagName -> layer id an UNSET knob falls to (baseline)
const originTags = computed(() => {
  const out = {};
  for (const k of plane1List.value) out[k.flagName] = "engine default";
  for (const [k, v] of Object.entries(inheritedOrigins.value)) out[k] = ORIGIN_LABELS[v] || v;
  const set = new Set(tuneRows.value.map((r) => (r.name || "").trim()).filter(Boolean));
  for (const [k, v] of Object.entries(tuneOrigins.value)) {
    if (set.has(k)) out[k] = ORIGIN_LABELS[v] || v;
  }
  return out;
});

// ── the applied per-(model, machine) config (Plan B storage; §7.1 Apply semantics) ──
// { hwKey, rows, source, driftCount } | null — source ("auto" | "hand") and
// driftCount (defaults changed since apply; null = unknowable, e.g. a tune applied
// before baseline tracking) are server-derived (§7.6).
const savedTune = ref(null);
const saveState = ref(""); // "" | saving | removing
const saveErr = ref("");
const applyMsg = ref(""); // transient "Applied ✓ …" note after a completed Apply

// ── the §7.6 header badge (B3-4) — Auto-tuned / Hand-tuned / Untuned. QC-3
// (2026-07-08, the user: "this just has one class defaults andt that is not true,
// it is all of them"): the header state describes the WHOLE config, and only an
// applied snapshot genuinely is one thing — an untuned model's config is a MIX of
// layers, which the per-row origin tags show truthfully. So the header never
// claims a single layer; the has-a-class-default fact lives on the rows (and the
// catalog row badge).
const headerBadge = computed(() => {
  if (savedTune.value) {
    const fam = TUNE_BADGES[savedTune.value.source] || null;
    return {
      intent: "success",
      label: fam ? `${fam.label} on this PC ✓` : "Applied on this PC ✓",
    };
  }
  return { intent: TUNE_BADGES.untuned.intent, label: "Untuned — using the layered defaults" };
});
const driftCount = computed(() => savedTune.value?.driftCount || 0);

// "Refresh from defaults" (§7.6, the user's "update from defaults" button): load
// TODAY's layer baseline (+ its computed fit) into the GRID — never the DB; the
// applied config stands until Apply commits what you see.
async function refreshFromDefaults() {
  tuneErr.value = "";
  applyMsg.value = "";
  try {
    const res = await resolveModelDefaults(props.model.id, { excludeTune: true });
    fillFromResolved(res);
    inheritedOrigins.value = res.origins || {}; // the baseline IS the inherited truth
    pushToast({ message: "Loaded today's defaults into the grid — review, then Apply to commit." });
  } catch (e) {
    tuneErr.value = e.message || "Couldn't load today's defaults.";
  }
}

// Rows whose BARE name matches no plane-1 knob — likely a mistyped or since-
// DROPPED typed field that would render mis-spelled and fail the spawn (the D5
// degradation fold: visible badge, not a mystery load failure). A deliberate raw
// passthrough flag starts with "--" and is NOT badged.
const knownFlagNames = computed(
  () => new Set(knobCatalog.value.filter((k) => k.plane === 1).map((k) => k.flagName)),
);
const unknownNames = computed(() => {
  if (!knobCatalog.value.length) return new Set(); // catalog unavailable → don't badge
  const out = new Set();
  for (const r of tuneRows.value) {
    const n = (r.name || "").trim();
    if (n && !n.startsWith("--") && !knownFlagNames.value.has(n)) out.add(n);
  }
  return out;
});

async function loadSavedTune() {
  try {
    const res = await request(`/v1/ai/model-tunes?modelId=${encodeURIComponent(props.model.id)}`);
    savedTune.value = res.rows?.length ? res : null;
    if (savedTune.value) {
      // §7.6: with an applied config every SET row reads "your applied config" —
      // the inherited tags for UNSET knobs must come from the layer BASELINE
      // (what a knob falls back to if you uncheck it), not the tune-winning resolve.
      try {
        const base = await resolveModelDefaults(props.model.id, { excludeTune: true });
        inheritedOrigins.value = base.origins || {};
      } catch { /* enrichment — unset knobs just read "engine default" */ }
    }
  } catch {
    savedTune.value = null; // saved-state is an enrichment; tuning still works
  }
}
// The blast radius for the Apply confirm: the labels of every task whose resolved
// preset (its own row, else the global default) points at THIS model. Best-effort —
// null means "couldn't compute" and the confirm falls back to generic copy.
async function affectedTaskLabels() {
  try {
    const [tk, pa, ep] = await Promise.all([
      request("/v1/ai/task-kinds"), request("/v1/ai/preset-assignments"), request("/v1/ai/engine-presets"),
    ]);
    const modelOf = Object.fromEntries((ep.presets || []).map((p) => [p.id, p.model]));
    const asg = pa || {};
    // NOTE: /v1/ai/task-kinds returns `taskKinds` (the task catalog rows), NOT `tasks` —
    // same field every consumer reads (FeatureWorkbench.vue, TaskKinds.vue).
    return (tk.taskKinds || [])
      .filter((t) => modelOf[(asg.taskKinds || {})[t.id] || asg.defaultPresetId || ""] === props.model.id)
      .map((t) => t.label || t.id);
  } catch {
    return null;
  }
}

// Reload the model NOW when it is the currently-running one, so applied == active
// (the user's apply-now decision — never "wait for the next load"). Loads WITHOUT
// explicit switches so the spawn resolves the just-written config through the same
// path production uses (seen = run). Honest limit: /status reports the PRIMARY
// resident model; a co-resident secondary (e.g. the pinned embed) isn't respawned —
// its next load picks the config up.
async function reloadIfRunning() {
  const st = await request("/v1/llm-runner/status").catch(() => null);
  if (!(st?.status === "running" && st?.modelId === props.model.id)) return false;
  tunePhase.value = "loading";
  tuneDetail.value = "applying — reloading the model with the new config";
  await request("/v1/llm-runner/stop", { method: "POST" }).catch(() => {});
  await request("/v1/llm-runner/load", { method: "POST", body: { modelId: props.model.id } });
  await pollUntilSettled();
  tunePhase.value = "";
  tuneDetail.value = "";
  return true;
}

async function applyTune() {
  saveErr.value = "";
  applyMsg.value = "";
  // Blast-radius confirm (§7.1): name the affected tasks (capped) before committing.
  const labels = await affectedTaskLabels();
  const capped = labels && labels.length > 3
    ? `${labels.slice(0, 3).join(", ")} +${labels.length - 3} more`
    : (labels || []).join(", ");
  const scope = labels == null
    ? "Every task that uses this model on this PC will run these switches."
    : labels.length
      ? `Every task that uses this model on this PC will run these switches: ${capped}.`
      : "No task currently uses this model — the config takes effect whenever it loads.";
  const ok = await confirmDialog({
    title: `Apply to ${props.model.name || props.model.id}?`,
    message: `${scope} The model reloads now if it's running. (Temperature, tokens, and thinking stay per-task — unchanged.)`,
    confirmLabel: "Apply",
  });
  if (!ok) return;
  saveState.value = "saving";
  try {
    const switches = tuneRows.value
      .filter((r) => (r.name || "").trim())
      .map((r) => ({ flagName: r.name.trim(), flagValue: r.value ?? "" }));
    const res = await request("/v1/ai/model-tunes", {
      method: "PUT",
      body: { modelId: props.model.id, switches },
    });
    savedTune.value = res.rows?.length ? res : null;
    const reloaded = await reloadIfRunning();
    applyMsg.value = reloaded
      ? "Applied ✓ — the model reloaded; every task using it runs this config now."
      : "Applied ✓ — every task using this model runs this config from its next load.";
    // #14a: a toast too — the modal note alone was easy to miss ("i think we need a
    // toast or something so user really knows").
    pushToast({ message: applyMsg.value });
  } catch (e) {
    saveErr.value = e.message || "Couldn't apply the config.";
    tunePhase.value = "";
  } finally {
    saveState.value = "";
  }
}
async function removeTune() {
  saveErr.value = "";
  applyMsg.value = "";
  saveState.value = "removing";
  try {
    await request(`/v1/ai/model-tunes?modelId=${encodeURIComponent(props.model.id)}`, { method: "DELETE" });
    savedTune.value = null;
    await startTune(); // the grid returns to the layered defaults
    const reloaded = await reloadIfRunning(); // removal applies now too (active = resolved)
    applyMsg.value = reloaded ? "Removed — the model reloaded on its layered defaults." : "";
    pushToast({ message: applyMsg.value
      || "Removed ✓ — the model uses its layered defaults from its next load." });
  } catch (e) {
    saveErr.value = e.message || "Couldn't remove the applied config.";
    tunePhase.value = "";
  } finally {
    saveState.value = "";
  }
}

async function fetchResolved(id) {
  return resolveModelDefaults(id); // {switches, samplers, mtpCapable} — shared w/ ConfigColumn (one source)
}

// Fill the grid from a resolve result — SET rows = the layered switches PLUS the
// fit-computed values as ordinary rows (§7.6: the snapshot owns what you see;
// "Add to grid" is retired). ONE filler for open/reset/refresh — no drift between them.
function fillFromResolved(res) {
  tuneRows.value = [...res.switches, ...(res.computed || [])];
  tuneOrigins.value = {
    ...(res.origins || {}),
    ...Object.fromEntries((res.computed || []).map((c) => [c.name, "computed"])),
  };
  if (!savedTune.value) inheritedOrigins.value = res.origins || {};
}
async function startTune() {
  tuneRows.value = [];
  tuneResult.value = null;
  tuneErr.value = "";
  tunePhase.value = "";
  tuneDetail.value = "";
  try {
    fillFromResolved(await fetchResolved(props.model.id));
  } catch {
    tuneRows.value = []; // pre-fill is an enrichment; tuning still works empty
  }
}
async function resetTuneSwitches() {
  try {
    fillFromResolved(await fetchResolved(props.model.id));
  } catch (e) {
    tuneErr.value = e.message || "Couldn't reset to defaults.";
  }
}

// ── "Save for hardware class" (ROUND 8 Task C): keep a measured config as the
// DEFAULT for every PC of this box's class — writes a class-tune row via the
// shared library client (the server derives the class when omitted). Offered ON
// a result (per the spec): you save what you just measured, not a blind grid.
const myClassKey = ref("");
const classSaveState = ref(""); // "" | saving | saved
const classSaveErr = ref("");
// #19: the library editors open as POPUPS from links (the B2-4 popups pattern) —
// nothing embedded in this modal anymore. The ref points at the per-model popup's
// mount; saveForClass's reload is optional-chained, so a closed popup is a no-op
// and an open one refreshes live.
const showClassLib = ref(false);
const showGlobalLib = ref(false);
const classTunesRef = ref(null);
const myClassLabel = computed(() => classKeyLabel(myClassKey.value));
async function loadMyClassKey() {
  try {
    const res = await listClassTunes();
    myClassKey.value = res.classKey || "";
  } catch {
    myClassKey.value = ""; // enrichment — the button simply doesn't render
  }
}
async function saveForClass() {
  classSaveErr.value = "";
  classSaveState.value = "saving";
  try {
    const switches = rowsToSwitches(tuneRows.value);
    if (!Object.keys(switches).length) throw new Error("Add at least one switch first.");
    await putClassTune(props.model.id, switches);
    classSaveState.value = "saved";
    classTunesRef.value?.reload?.();
  } catch (e) {
    classSaveErr.value = e.message || "Couldn't save the class config.";
    classSaveState.value = "";
  }
}
function rowsToSwitches(rows) {
  const out = {};
  for (const r of rows || []) {
    const name = (r.name || "").trim();
    if (name) out[name] = r.value ?? "";
  }
  return out;
}
async function pollUntilSettled(maxMs = 180000) {
  const start = Date.now();
  for (;;) {
    const st = await request("/v1/llm-runner/status");
    if (st.status === "running") return st;
    if (st.status === "error") throw new Error(st.error || "Load failed.");
    tuneDetail.value = st.detail || st.status || "";
    if (Date.now() - start > maxMs) throw new Error("Timed out waiting for the model to load.");
    await new Promise((r) => setTimeout(r, 1200));
  }
}
// The measurement HISTORY (#142 rows 5+6): every real result persists — this
// modal records its own "Load & measure" numbers (it is the one actor that
// knows which switches it loaded; the auto-tune sweep records its trials
// server-side). Fire-and-forget: a history-write failure never fails a measure.
const measureHistRef = ref(null); // the drawer — refresh when a new row lands
function recordTuneResult(res, switches) {
  recordMeasurement(props.model.id, res.tokensPerSec, {
    vramTotalMb: res.vramTotalMb || 0, switches, source: "tune",
  })
    .then(() => measureHistRef.value?.reload?.())
    .catch(() => {});
}

async function runMeasure() {
  tuneErr.value = "";
  tuneResult.value = null;
  classSaveState.value = ""; // a new measurement is a new candidate for the class save
  classSaveErr.value = "";
  tunePhase.value = "loading";
  tuneDetail.value = "preparing";
  try {
    // Respawn cleanly with the requested flags (one model runs at a time).
    await request("/v1/llm-runner/stop", { method: "POST" }).catch(() => {});
    const switches = rowsToSwitches(tuneRows.value);
    await request("/v1/llm-runner/load", {
      method: "POST",
      body: { modelId: props.model.id, switches },
    });
    await pollUntilSettled();
    tunePhase.value = "measuring";
    const res = await request("/v1/llm-runner/measure", { method: "POST" });
    if (!res.ok) throw new Error(res.error || "Measurement failed.");
    tuneResult.value = res;
    tunePhase.value = "done";
    recordTuneResult(res, switches);
  } catch (e) {
    tuneErr.value = e.message || "Measurement failed.";
    tunePhase.value = "error";
  }
}

// ── Auto-tune (2026-07-06): the server-side measured sweep — a short sequence of
// real load→measure trials (batch 512/512 vs baseline, then n-cpu-moe around the
// anchor) run as ONE job (POST /v1/llm-runner/auto-tune; embed co-resident so the
// floor is production-true). The modal POLLS the job, narrates each trial, and on
// completion FILLS THE GRID with the winner — nothing auto-saves here: review,
// tweak if you like, then Save tune (the human stays in the loop; QuickSetup's
// save-on-done variant passes save:true instead).
const autoState = ref(null); // the GET payload: {status, detail, trials, best, error}
let autoTimer = null;
const autoRunning = computed(() => autoState.value?.status === "running");
const autoTrials = computed(() => autoState.value?.trials || []);

function stopAutoPoll() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}
function switchesToRows(switches) {
  return Object.entries(switches || {}).map(([name, value]) => ({ name, value: String(value ?? "") }));
}
async function pollAutoTune() {
  try {
    const st = await request("/v1/llm-runner/auto-tune");
    autoState.value = st;
    if (st.status === "running") return;
    stopAutoPoll();
    measureHistRef.value?.reload?.(); // the sweep recorded its trials server-side
    if (st.status === "done" && st.best) {
      tuneRows.value = switchesToRows(st.best.switches);
      // §7.6 provenance: the sweep replaced the grid — every set row is the
      // winner's value until the user edits or Applies (then it's their config).
      tuneOrigins.value = Object.fromEntries(
        Object.keys(st.best.switches || {}).map((k) => [k, "autotune"]));
      tuneResult.value = {
        tokensPerSec: st.best.tokensPerSec, completionTokens: null, ms: null,
        vramTotalMb: st.best.vramTotalMb, ramTotalMb: null,
      };
      tunePhase.value = "done";
    } else if (st.status === "error") {
      tuneErr.value = st.error || "Auto-tune failed.";
      tunePhase.value = "error";
    }
  } catch (e) {
    stopAutoPoll();
    autoState.value = null;
    tuneErr.value = e.message || "Auto-tune polling failed.";
  }
}
async function runAutoTune() {
  // #18: an explicit OK/Cancel before committing the box to a long sweep.
  const ok = await confirmDialog({
    title: "Run auto-tune?",
    message: "This can take a long time — 4 to 30 minutes depending on your hardware — while it loads and measures real configurations. It usually gives the best results for a model that hasn't been tuned yet. You can cancel after any trial.",
    confirmLabel: "Auto-tune",
  });
  if (!ok) return;
  tuneErr.value = "";
  tuneResult.value = null;
  try {
    const st = await request("/v1/llm-runner/auto-tune", {
      method: "POST",
      body: { modelId: props.model.id },
    });
    if (st.ok === false) throw new Error(st.error || "Auto-tune is busy.");
    autoState.value = st;
    stopAutoPoll();
    autoTimer = setInterval(pollAutoTune, 2000);
  } catch (e) {
    tuneErr.value = e.message || "Couldn't start auto-tune.";
  }
}
async function cancelAutoTune() {
  try {
    await request("/v1/llm-runner/auto-tune/cancel", { method: "POST" });
  } catch { /* the poll surfaces the final state either way */ }
}

onMounted(() => {
  loadKnobCatalog();
  startTune();
  loadSavedTune();
  loadMyClassKey();
});
onBeforeUnmount(stopAutoPoll);
</script>

<template>
  <AppModal :title="`Tune & measure — ${model.name || model.id}`" :max-width="'560px'" @close="emit('close')">
    <div class="lu-tune">
      <!-- QC-6 (2026-07-08, "do you really think this looks nice … the text"): ONE
           short lede — each row explains itself (origin tag + hover help); the
           two-paragraph explainer is gone, its detail lives in docs/models.md. -->
      <p class="lu-muted lu-tune-lede">
        Each switch shows where its value comes from — tweak, measure, then <b>Apply</b>
        (how tasks <i>ask</i> the model — temperature, tokens, thinking — stays on the Tasks tab).
      </p>

      <!-- #16 + B3-4: the tune state reads BIG — the §7.6 badge family (Auto-tuned /
           Hand-tuned / Class default / Untuned); Remove lives in the footer beside
           Apply ("move it next to save button so you can see it"). -->
      <div class="lu-tune-saved">
        <UiTag :intent="headerBadge.intent" class="lu-tune-savedtag">{{ headerBadge.label }}</UiTag>
      </div>
      <!-- §7.6 drift: defaults changed SINCE this config was applied (vs the baseline
           stored at apply time) — refresh fills the GRID only; Apply commits. -->
      <div v-if="driftCount > 0" class="lu-tune-drift">
        <span>Defaults have changed since you applied this config —
          {{ driftCount }} value{{ driftCount === 1 ? "" : "s" }} differ{{ driftCount === 1 ? "s" : "" }}.</span>
        <UiButton intent="secondary" size="small"
          title="Load today's defaults into the grid — your applied config stays until you hit Apply"
          @click="refreshFromDefaults">Refresh from defaults</UiButton>
      </div>

      <!-- #21: ONLY the switch grid scrolls — everything after this block (status,
           auto-tune narration, the result) stays in view without scrolling. The
           grid is the LEDGER over the whole plane-1 knob catalog (every switch one
           flat visible row, origin-tagged — QC cluster 2026-07-08) with the
           add-row grid as the no-catalog fallback. -->
      <div class="lu-tune-scroll">
        <KnobGrid v-model="tuneRows" ledger :catalog-list="plane1List"
          :catalog="switchCatalog" :origins="originTags"
          add-label="＋ Add a custom switch" />
        <div v-if="unknownNames.size" class="lu-tune-unk lu-muted">
          <UiTag intent="danger">unrecognized</UiTag>
          <span>{{ [...unknownNames].join(", ") }} — not a known engine flag (mistyped, or dropped
            by an engine update). Remove or fix it, or prefix with “--” for a raw flag.</span>
        </div>
      </div>

      <!-- #19: the shared launch-config libraries open as popups — links, not
           embedded editors. -->
      <div class="lu-tune-tools">
        <UiButton intent="ghost" size="small" @click="resetTuneSwitches">Reset to model default</UiButton>
        <!-- the two library links wrap TOGETHER (a grouped flex child), never one
             stranded on each line -->
        <span class="lu-tune-libs">
          <UiButton intent="secondary" size="small"
            title="This model's per-PC-class launch configs — the shared starting points a machine without its own applied config uses"
            @click="showClassLib = true">Hardware-class defaults ↗</UiButton>
          <UiButton intent="secondary" size="small"
            title="The always-on switch bundles (all models · MoE · dense · speculative decode) underneath every tune"
            @click="showGlobalLib = true">Global launch defaults ↗</UiButton>
        </span>
      </div>

      <LuMeasureHistory ref="measureHistRef" :model-id="model.id" />
      <div v-if="applyMsg" class="lu-tune-applied">{{ applyMsg }}</div>
      <div v-if="saveErr" class="lu-error">{{ saveErr }}</div>

      <div v-if="tunePhase === 'loading'" class="lu-tune-status">Loading… {{ tuneDetail }}</div>
      <div v-else-if="tunePhase === 'measuring'" class="lu-tune-status">Measuring decode speed…</div>

      <div v-if="autoRunning || (autoTrials.length && autoState?.status !== 'done')" class="lu-tune-status">
        Auto-tuning — {{ autoState?.detail || "working…" }}
      </div>
      <div v-if="autoTrials.length" class="lu-tune-trials lu-muted">
        <span v-for="t in autoTrials" :key="t.label" class="lu-tune-trial"
          :class="{ 'lu-tune-trial-bad': !t.ok }"
          :title="t.ok ? `${t.tokensPerSec} tok/s` : t.error">
          {{ t.label }}: {{ t.ok ? `${t.tokensPerSec} tok/s` : "✗" }}
        </span>
        <span v-if="autoState?.status === 'done' && autoState?.best" class="lu-tune-trial lu-tune-trial-win">
          winner → grid (review, then Apply)
        </span>
      </div>

      <div v-if="tuneResult" class="lu-tune-result">
        <div class="lu-tune-tps"><b>{{ tuneResult.tokensPerSec }}</b> tok/s</div>
        <div class="lu-tune-meta">
          {{ tuneResult.completionTokens }} tokens · {{ tuneResult.ms }} ms<template
            v-if="tuneResult.vramTotalMb"> · VRAM {{ gb(tuneResult.vramTotalMb) }} GB</template><template
            v-if="tuneResult.ramTotalMb"> · RAM {{ gb(tuneResult.ramTotalMb) }} GB</template>
        </div>
        <div v-if="!tuneResult.vramTotalMb" class="lu-muted lu-tune-cpu">No GPU detected — measured on CPU.</div>
        <!-- Apply keeps this config for THIS machine; this keeps it as the shared
             starting point for every PC of the same class (ROUND 8 Task C — "on a
             result": you share what you measured, not a blind grid). -->
        <div v-if="myClassKey" class="lu-tune-clsrow">
          <template v-if="classSaveState === 'saved'">
            <span class="lu-muted">Saved as the default for PCs like this one ({{ myClassLabel }}) ✓</span>
          </template>
          <template v-else>
            <span class="lu-muted">Works well? Make it the starting point for every PC like
              this one ({{ myClassLabel }}) — machines with their own saved tune keep it.</span>
            <UiButton intent="secondary" size="small" :loading="classSaveState === 'saving'"
              @click="saveForClass">Save for hardware class</UiButton>
          </template>
        </div>
        <div v-if="classSaveErr" class="lu-error">{{ classSaveErr }}</div>
      </div>

      <div v-if="tuneErr" class="lu-error">{{ tuneErr }}</div>
    </div>

    <!-- #19: the library popups — the SAME shared components the Edit view's
         buttons open (B2-4), here scoped to this model where it applies. -->
    <AppModal v-if="showClassLib" :title="`Hardware-class defaults — ${model.name || model.id}`"
      :max-width="'700px'" @close="showClassLib = false">
      <LuClassTunes ref="classTunesRef" expanded :model-id="model.id" :catalog="switchCatalog" />
    </AppModal>
    <AppModal v-if="showGlobalLib" title="Global launch defaults"
      :max-width="'760px'" @close="showGlobalLib = false">
      <LuGlobalSwitches expanded />
    </AppModal>

    <template #footer>
      <UiButton intent="ghost" @click="emit('close')">Close</UiButton>
      <span class="lu-tmm-spacer" />
      <UiButton v-if="savedTune" intent="secondary" :loading="saveState === 'removing'" :disabled="autoRunning"
        title="Delete this PC's applied config — the model returns to its layered defaults (reloads now if running)"
        @click="removeTune">Remove applied config</UiButton>
      <UiButton v-if="!autoRunning" intent="secondary" :disabled="tuneBusy"
        title="Run a measured sweep (4–30 minutes depending on hardware) and fill the grid with the fastest config — review, then Apply"
        @click="runAutoTune">Auto-tune</UiButton>
      <UiButton v-else intent="danger"
        title="Stop after the current trial finishes"
        @click="cancelAutoTune">Cancel auto-tune</UiButton>
      <UiButton intent="success" :loading="saveState === 'saving'" :disabled="autoRunning"
        title="Set this model's engine switches for every task that uses it on this PC — the model reloads now if it's running"
        @click="applyTune">Apply</UiButton>
      <UiButton intent="primary" :loading="tuneBusy" :disabled="autoRunning" @click="runMeasure">
        {{ tuneResult ? "Measure again" : "Load & measure" }}
      </UiButton>
    </template>
  </AppModal>
</template>

<style scoped>
.lu-tune { display: flex; flex-direction: column; gap: 12px; }
.lu-tune-lede { font-size: 12px; margin: 0; }
.lu-tune-saved { display: flex; align-items: center; gap: 10px; }
/* #16: the tune state reads BIG — a full-size badge, not row-note fine print. */
.lu-tune-saved .lu-tune-savedtag { font-size: 13px; padding: 5px 14px; }
/* §7.6 drift notice: one line + its action, quietly urgent (warn tint). */
.lu-tune-drift {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 11.5px; line-height: 1.45; color: var(--ink-2);
  padding: 7px 10px; border: 1px solid var(--warn-line, var(--border));
  background: var(--warn-soft, var(--surface-2)); border-radius: var(--r-sm, 8px);
}
.lu-tune-drift > span { flex: 1; min-width: 200px; }
/* #21: the switch grid scrolls in ITS OWN capped region so the load/measure status
   and the result below never fall out of view. scrollbar-gutter keeps a classic
   (space-taking) scrollbar from shifting rows when it appears. */
.lu-tune-scroll {
  max-height: 280px; overflow-y: auto; scrollbar-gutter: stable;
  display: flex; flex-direction: column; gap: 12px; padding-right: 4px;
}
.lu-tune-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-tune-libs { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.lu-tune-unk { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; }
.lu-tune-applied { font-size: 12px; color: var(--success, #3a7d63); font-weight: 600; }
.lu-tune-status { font-size: 12.5px; color: var(--ink-2); }
.lu-tune-result { padding: 12px 14px; background: var(--accent-soft); border: 1px solid var(--accent-line, var(--accent)); border-radius: var(--r-sm, 8px); }
.lu-tune-tps { font-size: 13px; color: var(--ink-2); }
.lu-tune-tps b { font-size: 22px; color: var(--accent-ink, var(--accent)); font-weight: 800; }
.lu-tune-meta { font-size: 11.5px; color: var(--ink-2); margin-top: 3px; }
.lu-tune-cpu { font-size: 11px; margin-top: 3px; }
.lu-tune-clsrow { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: 11.5px; }
.lu-tune-clsrow > span { flex: 1; min-width: 0; line-height: 1.45; }
.lu-tune-trials { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; }
.lu-tune-trial { padding: 2px 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; }
.lu-tune-trial-bad { opacity: 0.6; text-decoration: line-through; }
.lu-tune-trial-win { border-color: var(--accent-line, var(--accent)); background: var(--accent-soft); color: var(--accent-ink, var(--accent)); }
.lu-tmm-spacer { flex: 1; }
</style>
