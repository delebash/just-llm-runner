<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// ConfigColumn — the FULL editor for ONE AI action's run config, and the reusable
// unit behind BOTH surfaces (Decision 23, 2026-06-24: "the Feature view's editor
// pane already IS one Compare column"). Rendered ×1 in Routing-by-feature (the
// per-feature editor) and ×N in Compare (a MODE inside that surface). One source
// for the whole lifecycle — RULE #7.
//
// A column carries, stacked vertically (Decision 23 layout): a presets/Promote bar
// → model → Plane-1 engine switches (the shared KnobGrid) → prompt (system + user)
// → Plane-2 params + the long-tail sampler KnobGrid → prompt preview + token count
// + a context-budget guard (b1) → Run + a result readout (output · words · tok/s ·
// time · cost).
//
// OWNERSHIP: the column is the editor UI + owns the run/preview/result. It does NOT
// touch routing or call preset endpoints itself — it EMITS (`save-as`,
// `apply-preset`, `use-production`, `delete-preset`) so the PARENT (Feature
// Workbench ×1 or the Compare strip ×N) decides what a promote means (write the
// action's routing pin + prompt + the job's switches). That keeps routing
// single-owned and lets Compare promote per-column. The config is a v-model.
//
// SWITCHES NOTE: Plane-1 engine switches are LOAD-TIME — they take effect when the
// local model (re)spawns with them, so the per-call /v1/ai/run test does NOT apply
// them (it uses whatever model is loaded); their live tok/s effect + the
// per-switch comparison are GPU-gated (router/residency #27/#29). The KnobGrid here
// EDITS them (for Promote → the action's job, and for the model-card load+measure
// path); the column surfaces that so the readout isn't mistaken for a switch A/B.
import { computed, onMounted, ref, watch } from "vue";

import { request } from "../client.js";
import { assemblePrompt, estimateTokens } from "../tokens.js";
import KnobGrid from "./KnobGrid.vue";
import LuModelPicker from "./LuModelPicker.vue";
import UiButton from "../common/components/UiButton.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";

// Reasoning-effort (a1/E2): Off = no reasoning; Low/Med/High map to each provider's
// native control server-side. JSON mode forces it off (B3) regardless of this pick.
const REASONING_OPTIONS = [
  { value: "", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const varHint = "{{variable}}"; // shown literally in the UI (avoids a nested {{ }} in the template)

const props = defineProps({
  action: { type: String, default: "" },
  providers: { type: Array, default: () => [] },
  // Plane-2 (samplers) + Plane-1 (engine switches) knob-catalog rows, ordered
  // common-first — drive the prefilled KnobGrid checklists. Raw catalog rows
  // ({ flagName, label, kind, default, help, options }); unknown keys still edit
  // raw under "Other keys".
  samplerCatalogList: { type: Array, default: () => [] },
  switchCatalogList: { type: Array, default: () => [] },
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
  // The feature's current IN-PRODUCTION preset id → preselect it + mark it.
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
  // v-model: { pin:{providerId,model}|null, switches:[{name,value}], system,
  // userTemplate, temperature, topP, maxTokens, reasoningEffort, jsonMode,
  // samplers:[{name,value}] }.
  modelValue: { type: Object, default: () => ({}) },
});
const emit = defineEmits([
  "update:modelValue", "result",
  "save-as", "apply-preset", "delete-preset", "remove", "use-production",
]);

// ── config patching (v-model) ───────────────────────────────────────────────
function patch(key, val) {
  emit("update:modelValue", { ...(props.modelValue || {}), [key]: val });
}
function patchPin(val) {
  patch("pin", val && val.providerId ? { providerId: val.providerId, model: val.model || "" } : null);
}

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
  patch("samplers", list ? [...rest, { name: "samplers", value: list.join(",") }] : rest);
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
  patch("samplers", (text || "").trim() ? [...rest, { name: "stop", value: text }] : rest);
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
function confirmSaveAs() {
  const name = newName.value.trim();
  naming.value = false;
  newName.value = "";
  if (name) emit("save-as", name);
}

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
// window. The window is the REAL launch value — the column's own `-c` (ctx_len)
// switch — falling back to the parent's loaded-model ctx, then a LABELED "assumed"
// default (never a silent guess). The user can still override the field. (#3)
const ASSUMED_WINDOW = 8192;
const ctxFromSwitches = computed(() => {
  const row = (props.modelValue?.switches || []).find((sw) => sw.name === "ctx_len");
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
});
const winOverride = ref(null); // null = auto-derive; a number = the user's override
const window = computed({
  get: () => {
    if (winOverride.value != null) return winOverride.value;
    if (props.contextWindow > 0) return props.contextWindow;
    if (ctxFromSwitches.value > 0) return ctxFromSwitches.value;
    return ASSUMED_WINDOW;
  },
  set: (v) => { winOverride.value = Math.max(0, Number(v) || 0); },
});
const windowSource = computed(() => {
  if (winOverride.value != null) return "set";
  if (props.contextWindow > 0) return "loaded";
  if (ctxFromSwitches.value > 0) return "-c";
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

function wordCount(s) {
  return (String(s || "").trim().match(/\S+/g) || []).length;
}
function buildBody() {
  const c = props.modelValue || {};
  // Plane-1 switches are NOT sent: they are load-time, applied when the model
  // (re)spawns (GPU-gated #27). The test uses the loaded/cloud model as-is.
  return {
    action: props.action,
    variables: { ...(props.vars || {}) },
    temperature: c.temperature === "" || c.temperature == null ? null : Number(c.temperature),
    think: !!c.reasoningEffort,                 // reasoning on when an effort is picked
    reasoningEffort: c.reasoningEffort || "",   // the level → native control server-side
    maxTokens: Number(c.maxTokens) || 0,
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
      testOut.value = { content: "", model: "", ms: 0, tokens: 0, tps: 0, words: 0, cost: 0 };
      const res = await props.runStream({
        ...o, signal: ctrl.signal,
        onDelta: (_d, full) => { if (testOut.value) { testOut.value.content = full; testOut.value.words = wordCount(full); } },
      });
      const u = res?.usage || {};
      const ms = Math.round(performance.now() - t0);
      const out = u.completionTokens || 0;
      testOut.value = {
        content: res?.content || "", model: res?.model || "", ms,
        tokens: (u.promptTokens || 0) + out,
        tps: ms > 0 && out > 0 ? +(out / (ms / 1000)).toFixed(1) : 0,
        words: wordCount(res?.content || ""),
        cost: res?.cost || 0, // streamed path has no cost yet (FW writing path)
      };
    } else {
      const r = await request("/v1/ai/run", { method: "POST", body: o });
      const ms = Math.round(performance.now() - t0);
      const out = r.completionTokens || 0;
      testOut.value = {
        content: r.content, model: r.model, ms,
        tokens: (r.promptTokens || 0) + out,
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
    else testErr.value = e.message?.includes("501") ? "No LLM wired — set a model above or connect a provider." : (e.message || "Run failed.");
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
function fmtCost(c) {
  if (!c) return "$0";
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
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
      <UiButton intent="success" size="small"
        :disabled="!selPreset || selPreset === productionPresetId"
        :title="!selPreset ? 'Load or save a preset first' : (selPreset === productionPresetId ? 'Already in production for this feature' : 'Make this preset the one this feature uses')"
        @click="emit('use-production', selPreset)">{{ selPreset && selPreset === productionPresetId ? '✓ In production' : 'Use in production' }}</UiButton>
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

    <!-- Plane-1 engine switches (KnobGrid checklist, D15). n_cpu_moe is excluded —
         it is a hardware-fit knob edited in the Hardware-fit row below. -->
    <details class="cc-switches">
      <summary class="cc-eyebrow">Engine switches <span class="lu-muted">— Plane-1 (load-time): ctx · kv-type · flash-attn · flags</span></summary>
      <div class="cc-switches-body">
        <KnobGrid checklist :catalog-list="switchCatalogList" :exclude="['n_cpu_moe']"
          :model-value="modelValue?.switches || []"
          add-label="＋ Add custom switch" name-placeholder="switch (e.g. ctx_len)"
          @update:model-value="patch('switches', $event)" />
        <p class="lu-muted cc-switch-note">Applied when the engine (re)loads — the Run below tests the
          currently-loaded / cloud model; per-switch tok/s needs a local model (router #27). Promote writes
          these to the action's job.</p>
      </div>
    </details>

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
      <label class="cc-chk"><UiCheckbox :model-value="modelValue?.jsonMode" @update:model-value="patch('jsonMode', $event)" /><span class="lu-muted">JSON</span></label>
    </div>

    <!-- Hardware fit knobs (Plane-1, load-time): blank = auto-computed for this
         machine at load; set to pin an override (stored in the preset). -->
    <div class="cc-params cc-fit">
      <span class="cc-eyebrow cc-fit-eye">Hardware fit <span class="lu-muted">blank = auto</span></span>
      <div class="cc-field cc-num"><label>-ngl</label>
        <UiInput :model-value="modelValue?.nglOverride" type="number" placeholder="auto" @update:model-value="patch('nglOverride', $event)" /></div>
      <div class="cc-field cc-num"><label>n_cpu_moe</label>
        <UiInput :model-value="modelValue?.nCpuMoeOverride" type="number" placeholder="auto" @update:model-value="patch('nCpuMoeOverride', $event)" /></div>
    </div>

    <!-- Plane-2 long-tail samplers (KnobGrid checklist). temperature + top_p are
         excluded — they are edited in the per-call params row above. -->
    <details class="cc-samplers">
      <summary class="cc-eyebrow">Samplers <span class="lu-muted">— top_k · min_p · penalties · mirostat … (mostly local)</span></summary>
      <div class="cc-samplers-body">
        <KnobGrid checklist :columns="3" :catalog-list="samplerCatalogList" :exclude="['temperature', 'top_p']" :reserved-keys="['samplers', 'stop']"
          :model-value="modelValue?.samplers || []"
          add-label="＋ Add custom sampler" name-placeholder="sampler (e.g. top_k)"
          @update:model-value="patch('samplers', $event)" />

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
          <label class="cc-win">window <span class="lu-muted" :title="windowSource === 'assumed' ? 'No -c (ctx_len) switch set — this is an assumed default, edit it to your model\'s real window' : 'From the column\'s -c (ctx_len) switch / loaded model'">({{ windowSource }})</span> <UiInput :model-value="window" type="number" class="cc-win-in" @update:model-value="window = $event" /></label>
        </div>
        <div v-if="overBudget" class="cc-budget cc-budget-over">
          ⚠ prompt ≈{{ promptTok }} + {{ outReserve || 0 }} output = {{ budgetUsed }} tok exceeds the {{ window }}-token window — it will truncate or error.
        </div>
        <div v-else-if="nearBudget" class="cc-budget cc-budget-near">
          ⚠ prompt ≈{{ promptTok }} + {{ outReserve || 0 }} output is close to the {{ window }}-token window.
        </div>
      </div>
    </details>

    <!-- Run + result -->
    <div class="cc-run">
      <UiButton v-if="!testing" intent="primary" size="small" :disabled="busy" @click="run">▶ Run</UiButton>
      <UiButton v-else intent="secondary" size="small" @click="cancel">■ Cancel</UiButton>
      <span v-if="testing" class="lu-muted cc-running">Running…</span>
      <span v-if="testErr" class="lu-error cc-err">{{ testErr }}</span>
    </div>

    <div v-if="testOut" class="cc-out">
      <pre class="cc-pre">{{ testOut.content }}</pre>
      <div class="lu-muted cc-stats">
        <template v-if="testOut.model">model <b>{{ testOut.model }}</b> · </template>
        <b>{{ testOut.words }}</b> words<template v-if="testOut.tokens"> · <b>{{ testOut.tokens }}</b> tok</template><template v-if="testOut.tps"> · <b>{{ testOut.tps }}</b> tok/s</template> · {{ testOut.ms }} ms · <b>{{ fmtCost(testOut.cost) }}</b>
      </div>
    </div>
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
.cc-chk { display: flex; align-items: center; gap: 7px; }
.cc-switches-body, .cc-samplers-body { margin-top: 8px; }
.cc-samporder { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 7px; }
.cc-samporder-list { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.cc-samporder-row { display: grid; grid-template-columns: minmax(140px, 200px) auto auto; gap: 6px; align-items: center; }
.cc-samporder-name { font-size: 12px; font-family: var(--font-mono, monospace); color: var(--ink); }
.cc-stops { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 6px; }
.cc-stops-ta { resize: vertical; min-height: 42px; font-family: var(--font-mono, monospace); font-size: 12px; }
.cc-switch-note { font-size: 11px; margin: 8px 0 0; line-height: 1.4; }
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
