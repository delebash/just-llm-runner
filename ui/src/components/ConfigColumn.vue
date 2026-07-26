<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// ConfigColumn — the FULL editor for ONE AI action's run config, and the reusable
// unit behind BOTH surfaces (Decision 23, 2026-06-24: "the Feature view's editor
// pane already IS one Compare column"). Rendered ×1 in Routing-by-feature (the
// per-feature editor) and ×N in Compare (a MODE inside that surface). One source
// for the whole lifecycle — RULE #7.
//
// A column carries, stacked vertically (Decision 23 layout): a presets/Promote bar
// → model (+ the Engine-switches link) → prompt (system + user) → Plane-2 params +
// the long-tail sampler KnobGrid → prompt preview + token count + a context-budget
// guard (b1) → Run + a result readout (output · words · tok/s · time · cost).
//
// OWNERSHIP: the column is the editor UI + owns the run/preview/result. It does NOT
// touch routing or call preset endpoints itself — it EMITS (`save-as`,
// `apply-preset`, `use-production`, `delete-preset`) so the PARENT (Feature
// Workbench ×1 or the Compare strip ×N) decides what a promote means. That keeps
// routing single-owned and lets Compare promote per-column. The config is a v-model.
//
// SWITCHES NOTE (§7.1, locked 2026-07-08): the column edits NO launch switches — a
// loaded model is one process with one set of launch flags shared by every task, so
// launch config is owned by the MODEL (Tune & measure over the switch_resolve stack:
// global bundles → PC class config → this machine's tune). The "Engine switches ↗"
// link under the model picker opens THE one editor (TuneMeasureModal) for the
// column's model; the column itself carries only what a TASK owns: samplers, tokens,
// JSON, reasoning. The old per-column switch grid wrote preset rows that nothing
// applied at load — deleted, not rebuilt.
import { computed, onMounted, ref, watch } from "vue";

import { request } from "../client.js";
import { resolvedSourceLabel, useResolvedRoute } from "../composables/useResolvedRoute.js";
import { runAiFeature } from "../services/aiFeature.js";
import { LOCAL_RUNNER_ID } from "../services/modelApply.js";
import { useAiTasksStore } from "../stores/aiTasks.js";
import { resolveModelDefaults } from "../modelDefaults.js";
import { assemblePrompt, estimateTokens } from "../tokens.js";
import { fmtCost, fmtSeconds, fmtTokens, fmtTps, fmtWords } from "../common/services/runStats.js";
import {
  levelForValue, THINKING_CUSTOM, thinkingControlToWire, thinkingOptionsFor,
} from "../thinkingControl.js";
import AiTaskStrip from "./AiTaskStrip.vue";
import KnobGrid from "./KnobGrid.vue";
import LuModelPicker from "./LuModelPicker.vue";
import TuneMeasureModal from "./TuneMeasureModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";

// QC-23 ("what happend to the shared ai progress bar?"): each column instance
// gets a stable id, stamped into its runAiFeature task registration's `meta` so
// THIS column's strip finds THIS column's task (Run-all fires N same-action
// tasks in parallel — the label alone can't tell them apart).
let _labColSeq = 1;

// Reasoning — the SAME control the chip renders, built by the SAME shared builder
// (thinkingControl.js): Off · the provider's levels, numbered where it speaks numbers
// ("Low (1024)") · display-only Custom (with its number) while Custom IS the state.
// The user's B ruling, 2026-07-16 — the control shows what will actually run and save
// sets what's shown. JSON mode forces it off (B3) regardless. No clamp anywhere ("no
// magic behind the curtains": there is no min(), the resolved value IS the budget).
const varHint = "{{variable}}"; // shown literally in the UI (avoids a nested {{ }} in the template)

const props = defineProps({
  action: { type: String, default: "" },
  providers: { type: Array, default: () => [] },
  // Plane-2 (samplers) knob-catalog rows, ordered common-first — drive the
  // prefilled KnobGrid checklist. Raw catalog rows ({ flagName, kind, default, help,
  // options }); unknown keys still edit raw under "Other keys". (No `label` — the knob
  // catalog's label column was DELETED 2026-07-16: the exact switch name is the name.)
  samplerCatalogList: { type: Array, default: () => [] },
  // The shared test input (parent-owned; ONE set across Compare's columns).
  vars: { type: Object, default: () => ({}) },
  // Host runner for live streaming (Cancel + token usage). Null → one-shot /run.
  // Note: the streamed done-frame carries no cost/model, so cost shows only on the
  // one-shot /run path (which Compare uses); the live stream is the FW writing path.
  runStream: { type: Function, default: null },
  // The inherit option's label on the model picker.
  inheritLabel: { type: String, default: "— inherit —" },
  // This action's saved presets (parent-owned list, already filtered to the action).
  presets: { type: Array, default: () => [] },
  // The feature's current IN-PRODUCTION preset id → preselect it + mark it
  // ("● in production"); "Use in production" assigns the loaded preset (the
  // parent writes the feature's ref).
  productionPresetId: { type: String, default: "" },
  // Show the system/user prompt editors. Features ×1 = true; Compare may pass false
  // to compare engines on a shared (locked) prompt, true for prompt A/B.
  promptEditable: { type: Boolean, default: true },
  // Model context window (tokens) for the budget guard. 0 → the column shows an
  // editable default the user can set to their model's window.
  contextWindow: { type: Number, default: 0 },
  label: { type: String, default: "" },      // column title (Compare)
  removable: { type: Boolean, default: false }, // show the ✕ remove (Compare)
  busy: { type: Boolean, default: false },     // parent disables during Run-all
  // v-model: { pin:{providerId,model}|null, system, userTemplate, temperature,
  // topP, maxTokens, reasoningEffort, jsonMode, samplers:[{name,value}] }.
  modelValue: { type: Object, default: () => ({}) },
});
// Below defineProps on purpose — these read `props` (declaration order, no TDZ-timing
// cleverness).
const isLocalPin = computed(() => (props.modelValue?.pin?.providerId || "") === LOCAL_RUNNER_ID);
// The pinned provider's level map — the option NUMBERS ("Low (1024)") and the
// resolved-value match both read it. Enrichment: an empty map falls back to plain level
// words inside the shared builder, never to an Off-only control.
const levelRows = ref([]);
watch(() => props.modelValue?.pin?.providerId, async (pid) => {
  if (!pid) { levelRows.value = []; return; }
  try {
    levelRows.value = (await request(`/v1/ai/reasoning-map/${encodeURIComponent(pid)}`))?.rows || [];
  } catch {
    levelRows.value = [];
  }
}, { immediate: true });
const emit = defineEmits([
  "update:modelValue", "result", "save-json",
  "save-as", "update-preset", "apply-preset", "delete-preset", "remove", "use-production",
]);

// The ACTION's json_mode is an EDITABLE, SAVABLE setting (2026-07-16, user-restored the
// checkbox): ONE "Output as JSON" toggle that (a) applies when THIS column runs AND (b)
// persists to the action's prompt row (feature-level — never a preset field, so routing
// can never flip a per-action parser). Toggling patches the column (run + display update
// now) and emits `save-json` up; the parent writes it to /v1/ai/prompts.
function onJsonToggle(v) {
  patch("jsonMode", !!v);
  emit("save-json", !!v);
}

// ── config patching (v-model) ───────────────────────────────────────────────
function patch(key, val) {
  emit("update:modelValue", { ...(props.modelValue || {}), [key]: val });
}
function patchPin(val) {
  const pin = val && val.providerId ? { providerId: val.providerId, model: val.model || "" } : null;
  // A USER-driven provider/model pick re-opens the model seed for the sampler grid
  // (samplers are model-specific — the new model's baseline should show). A PRESET
  // load keeps its own 'preset' tag (it goes through CompareStrip.presetToConfig, not
  // patchPin), so the seed never clobbers a freshly-loaded preset.
  patchMany({ pin, samplersSource: "model" });
}
function patchMany(obj) {
  emit("update:modelValue", { ...(props.modelValue || {}), ...obj });
}

// ── model -> baseline seed (sampler grid + the model's real context window) ──
// When THIS column's model changes, pre-fill the Plane-2 sampler grid with that
// model's RESOLVED baseline (the SAME `resolveModelDefaults` source Tune & measure
// reads — ONE fetch) and capture the model's resolved `-c` (ctx_len) for the budget
// guard below (the launch config lives on the MODEL, §7.1 — the column only reads
// it). `seedFields` is the provenance guard (`samplersSource` on the config): never
// clobber a loaded PRESET (CompareStrip.presetToConfig tags 'preset') or a USER edit
// (`onEditSamplers` tags 'user'); only (re)seed when the grid is empty or a prior
// model seed. An async token + a post-await re-check make a late fetch safe against
// a preset-apply / another model-change meanwhile.
let seedToken = 0;
// The pinned model's resolved ctx_len (its real launch window) — feeds the budget guard.
const resolvedCtx = ref(0);
function providerIsKnownCloud(providerId) {
  const p = props.providers.find((x) => x.id === providerId);
  return !!p && !p.local; // known cloud → skip (a local-engine concept); unknown → attempt
}
// The guarded-seed rule for a grid (kept generic — the guard shape predates §7.1).
// Returns the {grid, source} fields to patch, or {} when the guard says keep the current.
function seedFields(gridKey, srcKey, rows) {
  const mv = props.modelValue || {};
  const src = mv[srcKey];
  if (src === "preset" || src === "user") return {};           // never clobber preset/user
  if ((mv[gridKey] || []).length && src !== "model") return {}; // keep a non-model existing set
  return { [gridKey]: rows, [srcKey]: "model" };
}
async function seedFromModel(modelId, providerId) {
  if (!modelId || providerIsKnownCloud(providerId)) { resolvedCtx.value = 0; return; }
  const my = ++seedToken;
  const res = await resolveModelDefaults(modelId);
  if (my !== seedToken) return;                          // superseded by a newer model change
  if (props.modelValue?.pin?.model !== modelId) return; // model changed mid-fetch
  // The model's REAL launch window (resolved ctx_len — same truth the load uses).
  const ctxRow = (res.switches || []).find((r) => r.name === "ctx_len");
  const ctxN = Number(ctxRow?.value);
  resolvedCtx.value = Number.isFinite(ctxN) && ctxN > 0 ? ctxN : 0;
  // Samplers: the model fills the SECONDARY knobs the task leaves blank (§65). `temperature`
  // is task-owned (params row, excluded from the grid) → dropped; `top_p` is model-filled but
  // ALSO lives in the params row → routed to `topP` below, not into the grid.
  const gridSamplers = (res.samplers || []).filter((r) => r.name !== "temperature" && r.name !== "top_p");
  const patch = {
    ...seedFields("samplers", "samplersSource", gridSamplers),
  };
  // top_p -> the params-row `topP`, only when the model recommends one, the column's topP
  // is blank (task/user wins per-knob), AND the sampler grid is being (re)seeded (same guard).
  const topPRow = (res.samplers || []).find((r) => r.name === "top_p");
  const topPBlank = props.modelValue?.topP === "" || props.modelValue?.topP == null;
  if (topPRow && topPBlank && "samplers" in patch) patch.topP = topPRow.value;
  if (Object.keys(patch).length) patchMany(patch);
}
// Watch the model STRING (not an array getter) so it fires ONLY when the model actually
// changes — an array getter re-fires on every modelValue reference change (incl. the
// seed's own writes), which would loop.
watch(
  () => props.modelValue?.pin?.model,
  (mid) => seedFromModel(mid, props.modelValue?.pin?.providerId),
  { immediate: true },
);
function onEditSamplers(rows) {
  patchMany({ samplers: rows, samplersSource: "user" });
}

// ── Engine switches → THE one editor (§7.1): the link under the model picker opens
// Tune & measure for the column's model. Shown only for a non-cloud pinned model
// (cloud APIs have no launch switches — samplers only). On close, re-run the model
// seed so the budget window (ctx) reflects a just-applied tune.
const tuningModel = ref(null); // { id, name } | null — mounts TuneMeasureModal
const canTuneModel = computed(() => {
  const pin = props.modelValue?.pin;
  return !!(pin?.model && !providerIsKnownCloud(pin.providerId));
});
function openTune() {
  const pin = props.modelValue?.pin;
  if (pin?.model) tuningModel.value = { id: pin.model, name: pin.model };
}
function onTuneClosed() {
  tuningModel.value = null;
  seedFromModel(props.modelValue?.pin?.model, props.modelValue?.pin?.providerId);
}

// ── the resolved LOCAL thinking budget for THIS column's pinned route (2026-07-16)
// The Reasoning select is the ASK. On a LOCAL route the emitted budget is NOT a task
// value: it is the model's layered `reasoning_budget` switch (base bundle → PC class config
// → applied tune), same as every other launch-adjacent value the column only READS
// (§7.1). So the column shows what resolves + which layer it came from, and never
// offers to edit it here — Tune & measure (the "Engine switches ↗" link above) is
// that editor. The resolved-route endpoint takes providerId/model overrides, so the
// line follows THIS column's pin rather than the feature's production route.
// Cloud/no-pin: nothing renders.
const { ensureRoute, routeFor } = useResolvedRoute();
// A STRING key (the file's own precedent above: never an array getter) — it fires the
// ensure only when the pin ACTUALLY changes, not on every modelValue reference change.
const pinnedRouteKey = computed(() => {
  const pin = props.modelValue?.pin;
  return props.action && pin?.providerId && pin?.model
    ? `${props.action}|${pin.providerId}|${pin.model}`
    : "";
});
watch(pinnedRouteKey, (key) => {
  if (!key) return;
  const pin = props.modelValue.pin;
  ensureRoute(props.action, "", pin.providerId, pin.model);
}, { immediate: true });
// HONEST SCOPE: this reports the ROUTE, not this column's Reasoning select. The endpoint
// derives think/level from the action's ASSIGNED PRESET (prompts.py:628-629) and accepts
// only providerId/model overrides — so the line is "what a run of this action on this pin
// resolves to". When the preset has thinking OFF there is no resolved budget at all
// (value null, source "") and the line correctly says nothing rather than inventing a
// number, even if this column's own select is set for a test run.
// The RESOLVED budget for this column's pin — what a run of this action on this pin
// would actually emit. Feeds both the Custom label's number and the normalize below.
const pinnedValue = computed(() => {
  const pin = props.modelValue?.pin;
  if (!pinnedRouteKey.value || !isLocalPin.value) return null;
  const r = routeFor(props.action, "", pin.providerId, pin.model);
  return r?.think ? (r.value ?? null) : null;
});

// The ONE options builder — byte-identical to the chip's (thinkingControl.js).
const REASONING_OPTIONS = computed(() => thinkingOptionsFor({
  levelRows: levelRows.value,
  current: props.modelValue?.reasoningEffort,
  customValue: pinnedValue.value,
}));

// NORMALIZE Custom → the level that actually resolves (the B ruling: "it should not be
// custom" when a level matches). The parent seeds from the STORED pair, so the follow
// state (think on + empty level) arrives as Custom; once the route + map are in, this
// re-seeds it to the matched level so the Lab reads "Low (1024)" exactly like the chip —
// and a Save then writes what's shown. Terminates: the patch makes the value a level, so
// the guard stops it. Only the follow state is touched (a genuinely unmatched value —
// a number typed into a switch grid — stays Custom).
watch([() => props.modelValue?.reasoningEffort, pinnedValue, levelRows], () => {
  if (props.modelValue?.reasoningEffort !== THINKING_CUSTOM) return;
  const lvl = levelForValue(levelRows.value, pinnedValue.value);
  if (lvl) patch("reasoningEffort", lvl);
});

const localBudgetLine = computed(() => {
  const pin = props.modelValue?.pin;
  if (!pinnedRouteKey.value) return "";
  const r = routeFor(props.action, "", pin.providerId, pin.model);
  // Cloud (or an unresolved/thinking-off route) has no layered budget to report.
  if (!r || r.providerId !== LOCAL_RUNNER_ID || !r.think || r.value == null) return "";
  const label = resolvedSourceLabel(r.valueSource);
  // A `reasoning_budget` typed into the MoE/dense/MTP bundles resolves with origin
  // "type"/"mtp" (switch_resolve.py:24-25) — outside the approved 5-label vocabulary. Say
  // the layer's raw origin rather than trailing an empty dash.
  return `local: thinking budget ${r.value} — ${label || r.valueSource}`;
});

// ── sampler ORDER (the reserved `samplers` entry in the samplers array) ───────
// Off = engine default order. On = a per-request order, stored as a single
// {name:"samplers", value:"penalties,dry,…"} row; the server splits it to an array.
// The default MUST match llama.cpp's real default chain (common/common.h,
// common_params_sampling.samplers) — otherwise enabling the control OVERRIDES the
// engine and silently DROPS the omitted stages. That chain is 9 names; an earlier
// 7-name list dropped `penalties` (the combined repeat/presence/frequency stage)
// and `top_n_sigma`. Names are llama.cpp sampler-chain names, verified valid request
// names in sampling.cpp common_sampler_types_from_names() (note `penalties`, `typ_p`).
const DEFAULT_SAMPLER_ORDER = ["penalties", "dry", "top_n_sigma", "top_k", "typ_p", "top_p", "min_p", "xtc", "temperature"];
const samplerArr = computed(() => props.modelValue?.samplers || []);
const orderRow = computed(() => samplerArr.value.find((r) => r.name === "samplers") || null);
const orderOn = computed(() => !!orderRow.value);
const orderList = computed(() => {
  const v = orderRow.value?.value || "";
  const names = v.split(",").map((s) => s.trim()).filter(Boolean);
  return names.length ? names : [...DEFAULT_SAMPLER_ORDER];
});
function writeOrder(list) {
  const rest = samplerArr.value.filter((r) => r.name !== "samplers");
  // a user order edit tags the grid 'user' so a later model change never drops it.
  patchMany({ samplers: list ? [...rest, { name: "samplers", value: list.join(",") }] : rest, samplersSource: "user" });
}
function toggleOrder(on) { writeOrder(on ? [...DEFAULT_SAMPLER_ORDER] : null); }
function moveOrder(i, d) {
  const list = [...orderList.value];
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  writeOrder(list);
}

// ── reserved `stop` key: per-feature STOP sequences (one per line). Rides the
// samplers array like the order key; the server splits it to an array + maps it
// per adapter (openai/llama.cpp stop · gemini stopSequences · ollama options.stop
// · anthropic stop_sequences). Stored verbatim so the textarea round-trips.
const stopRow = computed(() => samplerArr.value.find((r) => r.name === "stop") || null);
const stopText = computed(() => stopRow.value?.value || "");
function writeStop(text) {
  const rest = samplerArr.value.filter((r) => r.name !== "stop");
  // a user stop-sequence edit tags the grid 'user' so a later model change never drops it.
  patchMany({ samplers: (text || "").trim() ? [...rest, { name: "stop", value: text }] : rest, samplersSource: "user" });
}

// ── presets bar (emits; the parent owns the endpoints) ──────────────────────
const selPreset = ref("");
const naming = ref(false);
const newName = ref("");
function onApplyPreset(id) {
  selPreset.value = id;
  emit("apply-preset", id);
}
function startNaming() { naming.value = true; newName.value = ""; }
// #27: the save happens in the PARENT (the column only emits the name), so the
// created id isn't known here — remember the pending name and adopt the NEW id
// when the refreshed preset list flows back down, so the dropdown lands on the
// preset the user just saved instead of staying blank.
const pendingSaveName = ref("");
function confirmSaveAs() {
  const name = newName.value.trim();
  naming.value = false;
  newName.value = "";
  if (name) {
    pendingSaveName.value = name;
    emit("save-as", name);
  }
}
watch(() => props.presets, (list, old) => {
  if (!pendingSaveName.value) return;
  const oldIds = new Set((old || []).map((p) => p.id));
  const created = (list || []).find((p) => !oldIds.has(p.id) && p.name === pendingSaveName.value);
  if (created) selPreset.value = created.id;
  // One-shot either way: the first refresh after a save either carries the new
  // preset or the save failed — don't adopt a stray later addition.
  pendingSaveName.value = "";
});

// ── prompt preview + token count + budget guard (b1/E2) ─────────────────────
const previewText = computed(() =>
  assemblePrompt(props.modelValue?.system, props.modelValue?.userTemplate, props.vars),
);
const estTokens = computed(() => estimateTokens(previewText.value));
const exactTokens = ref(null);
const counting = ref(false);
watch(previewText, () => { exactTokens.value = null; });
async function countExact() {
  counting.value = true;
  try {
    const r = await request("/v1/llm-runner/tokenize", { method: "POST", body: { text: previewText.value } });
    exactTokens.value = r.ok ? r.count : null; // not ok → no local model; keep the heuristic
  } catch {
    exactTokens.value = null;
  } finally {
    counting.value = false;
  }
}
// Budget guard: prompt tokens + reserved output (maxTokens) vs the model's context
// window. The window is the REAL launch value — the pinned model's RESOLVED ctx_len
// (the same truth the load uses, §7.1) — falling back to the parent's loaded-model
// ctx, then a LABELED "assumed" default (never a silent guess). The user can still
// override the field. (#3)
const ASSUMED_WINDOW = 8192;
const winOverride = ref(null); // null = auto-derive; a number = the user's override
const window = computed({
  get: () => {
    if (winOverride.value != null) return winOverride.value;
    if (props.contextWindow > 0) return props.contextWindow;
    if (resolvedCtx.value > 0) return resolvedCtx.value;
    return ASSUMED_WINDOW;
  },
  set: (v) => { winOverride.value = Math.max(0, Number(v) || 0); },
});
const windowSource = computed(() => {
  if (winOverride.value != null) return "set";
  if (props.contextWindow > 0) return "loaded";
  if (resolvedCtx.value > 0) return "model";
  return "assumed";
});
const promptTok = computed(() => (exactTokens.value != null ? exactTokens.value : estTokens.value));
const outReserve = computed(() => Number(props.modelValue?.maxTokens) || 0);
const budgetUsed = computed(() => promptTok.value + outReserve.value);
const overBudget = computed(() => window.value > 0 && budgetUsed.value > window.value);
const nearBudget = computed(() => window.value > 0 && !overBudget.value && budgetUsed.value > window.value * 0.85);

// ── run THIS column's config against the shared input ───────────────────────
const testing = ref(false);
const testOut = ref(null);
const testErr = ref("");
const testCtrl = ref(null);
// QC-23: this column's registered task (matched by the meta stamp) drives the
// SHARED AiTaskStrip below the run row — the same progress strip every other AI
// surface mounts, replacing the bare "Running…" text this surface had.
const labColId = `labcol-${_labColSeq++}`;
const aiTasks = useAiTasksStore();
const myTask = computed(() => aiTasks.runningTasks.find((t) => t.meta?.labColId === labColId) || null);

function wordCount(s) {
  return (String(s || "").trim().match(/\S+/g) || []).length;
}
function buildBody() {
  const c = props.modelValue || {};
  // No launch switches here (§7.1): a local model loads with ITS OWN resolved
  // config (global → class → machine tune), so the test runs exactly what
  // production runs. The column sends only per-request (task-owned) values.
  return {
    action: props.action,
    variables: { ...(props.vars || {}) },
    temperature: c.temperature === "" || c.temperature == null ? null : Number(c.temperature),
    // The three-state pair — the ONE mapping (thinkingControl.js). "default" is sent as
    // an EXPLICIT empty level so the run follows the model's layered budget / provider
    // default, never falling back to the preset's stored level. No clamp anywhere.
    ...thinkingControlToWire(c.reasoningEffort),
    maxTokens: Number(c.maxTokens) || 0,
    // the action's saved JSON-output setting (the "Output as JSON" checkbox).
    jsonMode: !!c.jsonMode,
    topP: c.topP === "" || c.topP == null ? null : Number(c.topP),
    providerId: c.pin?.providerId || "",
    model: c.pin?.model || "",
    system: c.system ?? undefined,
    userTemplate: c.userTemplate ?? undefined,
    samplers: (c.samplers || [])
      .filter((r) => (r.name || "").trim())
      .map((r) => ({ flagName: r.name.trim(), flagValue: r.value || "" })),
  };
}

// Exposed so a parent (Compare) can fire every column at once. Resolves when done.
async function run() {
  if (testing.value) return null;
  testing.value = true;
  testErr.value = "";
  testOut.value = null;
  const t0 = performance.now();
  const o = buildBody();
  try {
    if (props.runStream) {
      const ctrl = new AbortController();
      testCtrl.value = ctrl;
      testOut.value = { content: "", model: "", ms: 0, promptTokens: 0, outputTokens: 0, tps: 0, words: 0, cost: 0 };
      const res = await props.runStream({
        ...o, signal: ctrl.signal,
        onDelta: (_d, full) => { if (testOut.value) { testOut.value.content = full; testOut.value.words = wordCount(full); } },
      });
      const u = res?.usage || {};
      const ms = Math.round(performance.now() - t0);
      const out = u.completionTokens || 0;
      testOut.value = {
        content: res?.content || "", model: res?.model || "", ms,
        promptTokens: u.promptTokens || 0, outputTokens: out,
        tps: ms > 0 && out > 0 ? +(out / (ms / 1000)).toFixed(1) : 0,
        words: wordCount(res?.content || ""),
        cost: res?.cost || 0, // streamed path has no cost yet (FW writing path)
      };
    } else {
      // One-shot path through the shared feature wrapper so every Lab run
      // REGISTERS in the global AI task panel (#36 — "no ai progress bar no
      // task") and Cancel is real here too (it only worked on the stream path
      // before: testCtrl was never set one-shot).
      const ctrl = new AbortController();
      testCtrl.value = ctrl;
      const r = await runAiFeature({
        ...o, signal: ctrl.signal,
        task: { label: `Lab test — ${props.action}`, meta: { labColId } },
      });
      const ms = Math.round(performance.now() - t0);
      const out = r.completionTokens || 0;
      testOut.value = {
        content: r.content, model: r.model, ms,
        promptTokens: r.promptTokens || 0, outputTokens: out,
        // Decode speed = output tokens / wall-second (prompt is prefilled). The
        // lab's tuning + ranking yardstick.
        tps: ms > 0 && out > 0 ? +(out / (ms / 1000)).toFixed(1) : 0,
        words: wordCount(r.content),
        cost: r.cost || 0,
      };
    }
    emit("result", testOut.value);
    return testOut.value;
  } catch (e) {
    if (e?.name === "AbortError" || /abort|cancel/i.test(e?.message || "")) testErr.value = "Cancelled.";
    else testErr.value = (e?.statusCode === 501 || e.message?.includes("501")) ? "No LLM wired — set a model above or connect a provider." : (e.message || "Run failed.");
    emit("result", null);
    return null;
  } finally {
    testing.value = false;
    testCtrl.value = null;
  }
}
function cancel() {
  testCtrl.value?.abort();
}

// Preselect + load the feature's in-production preset into this column on open
// ("whatever preset is in production loads the dropdown with that one").
onMounted(() => {
  if (props.productionPresetId) {
    selPreset.value = props.productionPresetId;
    emit("apply-preset", props.productionPresetId);
  }
});

defineExpose({ run, cancel });
</script>

<template>
  <div class="cc">
    <!-- Column header (Compare): title + remove -->
    <div v-if="label || removable" class="cc-head">
      <span class="cc-title">{{ label }}</span>
      <span class="cc-spacer" />
      <UiButton v-if="removable" intent="ghost" size="small" title="Remove column" @click="emit('remove')">✕</UiButton>
    </div>

    <!-- Engine-preset bar — load an existing preset into this column, or save the
         (tested) config as a new preset. The parent owns the /engine-presets calls. -->
    <div class="cc-presets">
      <span class="cc-eyebrow">Preset</span>
      <UiSelect width="name" :model-value="selPreset"
        :options="[{ value: '', label: '— start fresh —' }, ...presets.map((p) => ({ value: p.id, label: p.name }))]"
        @update:model-value="onApplyPreset" />
      <span v-if="selPreset && selPreset === productionPresetId" class="cc-inprod" title="This preset is in production for this feature">● in production</span>
      <UiButton v-if="selPreset && selPreset !== productionPresetId" intent="success" size="small"
        title="Make this preset the one this feature uses"
        @click="emit('use-production', selPreset)">Use in production</UiButton>
      <UiButton v-if="selPreset && !naming" intent="secondary" size="small" title="Save changes to the loaded preset in place — &quot;Save as preset&quot; makes a new copy instead" @click="emit('update-preset', selPreset)">Save</UiButton>
      <UiInput v-if="naming" v-model="newName" placeholder="name — Enter" class="cc-name-in"
        @keyup.enter="confirmSaveAs" @keyup.esc="naming = false; newName = ''" />
      <UiButton v-else intent="primary" size="small" title="Save this tested config as a reusable preset" @click="startNaming">＋ Save as preset</UiButton>
      <UiButton v-if="selPreset" intent="ghost" size="small" title="Delete this preset" @click="emit('delete-preset', selPreset)">🗑</UiButton>
    </div>

    <!-- Model -->
    <div class="cc-field">
      <label>Provider &amp; model</label>
      <LuModelPicker editable :model-value="modelValue?.pin || null" :providers="providers" :labels="true"
        :inherit-label="inheritLabel" @update:model-value="patchPin" />
    </div>

    <!-- Engine switches live on the MODEL (§7.1) — one editor, linked, not embedded.
         The model decides how it runs (switches, shared by every task using it,
         needs a reload); this task decides how it's asked (the params below). -->
    <div v-if="canTuneModel" class="cc-engsw">
      <UiButton intent="secondary" size="small"
        title="Open Tune & measure for this model — engine switches are set once per model and shared by every task that uses it"
        @click="openTune">Engine switches ↗</UiButton>
      <span class="lu-muted">shared by every task using this model — set in Tune &amp; measure</span>
    </div>

    <!-- Prompt (system + user) -->
    <template v-if="promptEditable">
      <div class="cc-field"><label>System prompt</label>
        <textarea class="lu-input cc-ta" rows="5" :value="modelValue?.system || ''"
          @input="patch('system', $event.target.value)" /></div>
      <div class="cc-field"><label>Instruction <span class="lu-muted">— user template · {{ varHint }} placeholders</span></label>
        <textarea class="lu-input cc-ta" rows="3" :value="modelValue?.userTemplate || ''"
          @input="patch('userTemplate', $event.target.value)" /></div>
    </template>

    <!-- Plane-2 per-call params -->
    <div class="cc-params">
      <div class="cc-field cc-num"><label>Temp</label>
        <UiInput :model-value="modelValue?.temperature" type="number" @update:model-value="patch('temperature', $event)" /></div>
      <div class="cc-field cc-num"><label>Top-p <span class="lu-muted">blank=def</span></label>
        <UiInput :model-value="modelValue?.topP" type="number" @update:model-value="patch('topP', $event)" /></div>
      <div class="cc-field cc-num"><label>Max tok <span class="lu-muted">0=none</span></label>
        <UiInput :model-value="modelValue?.maxTokens" type="number" @update:model-value="patch('maxTokens', $event)" /></div>
      <div class="cc-field cc-reason"><label>Reasoning</label>
        <UiSelect :model-value="modelValue?.reasoningEffort || ''" :options="REASONING_OPTIONS"
          @update:model-value="patch('reasoningEffort', $event)" /></div>
      <div class="cc-field cc-json">
        <label class="cc-chk" title="Output as JSON — the model must return valid JSON for this feature. Turn on when the app needs the result as structured data instead of prose. Saved for this feature."><UiCheckbox :model-value="!!modelValue?.jsonMode" @update:model-value="onJsonToggle" /><span>Output as JSON</span></label>
      </div>
    </div>

    <!-- The layered thinking budget a LOCAL run on this column's pinned model uses, and
         which layer it came from. Sits under the params row (where the Reasoning select
         lives) rather than inside that field — .cc-reason is capped at 120px and would
         wrap this to a column of fragments. -->
    <div v-if="localBudgetLine" class="cc-localbudget lu-muted"
      title="The model's layered reasoning_budget on this PC (Global launch defaults → PC class config → your applied config) — edit it in Tune &amp; measure">{{ localBudgetLine }}</div>

    <!-- Plane-2 long-tail samplers (KnobGrid checklist). temperature + top_p are
         excluded — they are edited in the per-call params row above. #35 (B4-3,
         2026-07-08): ONE flat column — no multi-column spread, no Advanced section. -->
    <details class="cc-samplers">
      <summary class="cc-eyebrow">Samplers <span class="lu-muted">— top_k · min_p · penalties · mirostat … (mostly local)</span></summary>
      <div class="cc-samplers-body">
        <KnobGrid checklist flat :catalog-list="samplerCatalogList" :exclude="['temperature', 'top_p']" :reserved-keys="['samplers', 'stop']"
          :model-value="modelValue?.samplers || []"
          add-label="＋ Add custom sampler" name-placeholder="sampler (e.g. top_k)"
          @update:model-value="onEditSamplers" />

        <!-- Sampler ORDER — the chain the samplers apply in (off = engine default). -->
        <div class="cc-samporder">
          <label class="cc-chk"><UiCheckbox :model-value="orderOn" @update:model-value="toggleOrder" /><span class="lu-muted">Custom sampler order</span></label>
          <div v-if="orderOn" class="cc-samporder-list">
            <div v-for="(name, i) in orderList" :key="name" class="cc-samporder-row">
              <span class="cc-samporder-name"><span class="lu-muted">{{ i + 1 }}.</span> {{ name }}</span>
              <UiButton intent="ghost" size="small" :disabled="i === 0" title="Move up" @click="moveOrder(i, -1)">▲</UiButton>
              <UiButton intent="ghost" size="small" :disabled="i === orderList.length - 1" title="Move down" @click="moveOrder(i, 1)">▼</UiButton>
            </div>
            <UiButton intent="ghost" size="small" title="Restore the engine's default sampler order" @click="toggleOrder(true)">Reset order</UiButton>
          </div>
        </div>

        <!-- Per-feature STOP sequences — one per line; generation halts on any. -->
        <div class="cc-stops">
          <span class="cc-eyebrow">Stop sequences <span class="lu-muted">— one per line; generation halts on any</span></span>
          <textarea class="lu-input cc-stops-ta" rows="2" :value="stopText"
            placeholder="one stop string per line" @input="writeStop($event.target.value)" />
        </div>
      </div>
    </details>

    <!-- Preview + token count + budget guard -->
    <details class="cc-preview">
      <summary class="cc-eyebrow">Preview &amp; tokens
        <span class="lu-muted">— {{ exactTokens != null ? `${exactTokens} tokens` : `≈${estTokens} tokens` }}<span v-if="overBudget" class="cc-over"> · ⚠ over window</span></span>
      </summary>
      <div class="cc-preview-body">
        <pre class="cc-pre">{{ previewText || "(empty)" }}</pre>
        <div class="cc-preview-foot">
          <span class="lu-muted">{{ exactTokens != null ? `${exactTokens} tokens (exact)` : `≈ ${estTokens} tokens (est)` }}</span>
          <UiButton v-if="exactTokens == null" intent="ghost" size="small" :loading="counting"
            title="Count with the loaded local model's tokenizer" @click="countExact">Count exact</UiButton>
          <span class="cc-spacer" />
          <label class="cc-win">window <span class="lu-muted" :title="windowSource === 'assumed' ? 'No local model picked — this is an assumed default, edit it to your model\'s real window' : 'From the model\'s resolved launch config (Tune & measure) / loaded model'">({{ windowSource }})</span> <UiInput :model-value="window" type="number" class="cc-win-in" @update:model-value="window = $event" /></label>
        </div>
        <div v-if="overBudget" class="cc-budget cc-budget-over">
          ⚠ prompt ≈{{ promptTok }} + {{ outReserve || 0 }} output = {{ budgetUsed }} tok exceeds the {{ window }}-token window — it will truncate or error.
        </div>
        <div v-else-if="nearBudget" class="cc-budget cc-budget-near">
          ⚠ prompt ≈{{ promptTok }} + {{ outReserve || 0 }} output is close to the {{ window }}-token window.
        </div>
      </div>
    </details>

    <!-- Run + result. While a REGISTERED run is in flight the shared AiTaskStrip
         (QC-23) is the progress surface — elapsed, first-token, tok/s, Cancel —
         exactly like every other AI surface; the bare ■ Cancel + "Running…" pair
         remains only for a run no task registered (the host runStream path). -->
    <div class="cc-run">
      <UiButton v-if="!testing" intent="primary" size="small" :disabled="busy" @click="run">▶ Run</UiButton>
      <template v-else-if="!myTask">
        <UiButton intent="secondary" size="small" @click="cancel">■ Cancel</UiButton>
        <span class="lu-muted cc-running">Running…</span>
      </template>
      <span v-if="testErr" class="lu-error cc-err">{{ testErr }}</span>
    </div>
    <AiTaskStrip v-if="myTask" :task="myTask" />

    <div v-if="testOut" class="cc-out">
      <pre class="cc-pre">{{ testOut.content }}</pre>
      <div class="lu-muted cc-stats">
        <template v-if="testOut.model">model <b>{{ testOut.model }}</b> · </template>
        {{ fmtWords(testOut.words) }}<template v-if="testOut.outputTokens"> · {{ fmtTokens(testOut) }}</template><template v-if="testOut.tps"> · {{ fmtTps(testOut.tps) }}</template> · {{ fmtSeconds(testOut.ms) }} · {{ fmtCost(testOut.cost) }}
      </div>
    </div>

    <!-- THE one switch editor (§7.1), opened for this column's model. -->
    <TuneMeasureModal v-if="tuningModel" :model="tuningModel" @close="onTuneClosed" />
  </div>
</template>

<style scoped>
.cc { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.cc-head { display: flex; align-items: center; gap: 8px; }
.cc-title { font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.cc-spacer { flex: 1; }
.cc-field { display: flex; flex-direction: column; gap: 5px; }
.cc-field > label { font-size: 12px; color: var(--muted); }
.cc-ta { font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.5; resize: vertical; width: 100%; }
.cc-presets { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); }
.cc-eyebrow { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); cursor: pointer; }
.cc-name-in { max-width: 150px; }
.cc-inprod { font-size: 10px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--success, #3a7d63); white-space: nowrap; }
.cc-prod { margin-left: auto; font-size: 10px; font-weight: 700; border-radius: 999px; padding: 3px 9px; background: var(--accent); color: var(--on-accent, #fff); }
.cc-params { display: flex; gap: 14px 18px; align-items: flex-end; flex-wrap: wrap; }
.cc-num { max-width: 92px; }
.cc-reason { max-width: 120px; }
/* The resolved local budget line — pulled up snug under the params row it reports on. */
.cc-localbudget { font-size: 11px; margin-top: -4px; font-variant-numeric: tabular-nums; }
.cc-chk { display: flex; align-items: center; gap: 7px; }
.cc-engsw { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.cc-engsw .lu-muted { font-size: 11px; }
.cc-samplers-body { margin-top: 8px; }
.cc-samporder { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 7px; }
.cc-samporder-list { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.cc-samporder-row { display: grid; grid-template-columns: minmax(140px, 200px) auto auto; gap: 6px; align-items: center; }
.cc-samporder-name { font-size: 12px; font-family: var(--font-mono, monospace); color: var(--ink); }
.cc-stops { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 6px; }
.cc-stops-ta { resize: vertical; min-height: 42px; font-family: var(--font-mono, monospace); font-size: 12px; }
.cc-preview-body { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.cc-preview-foot { display: flex; align-items: center; gap: 10px; font-size: 11.5px; flex-wrap: wrap; }
.cc-win { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); }
.cc-win-in { max-width: 80px; }
.cc-over { color: var(--danger); font-weight: 700; }
.cc-budget { font-size: 11.5px; border-radius: 7px; padding: 6px 9px; line-height: 1.4; }
.cc-budget-over { background: var(--danger-soft, #fde8e8); color: var(--danger); border: 1px solid var(--danger); }
.cc-budget-near { background: var(--accent-soft); color: var(--accent-ink, var(--accent)); }
.cc-run { display: flex; align-items: center; gap: 10px; }
.cc-running { font-size: 11.5px; } .cc-err { font-size: 12px; }
.cc-out { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 10px 12px; }
.cc-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.5; max-height: 240px; overflow: auto; color: var(--ink); }
.cc-stats { font-size: 11.5px; margin-top: 8px; }
</style>
