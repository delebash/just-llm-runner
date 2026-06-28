<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// ConfigColumn — ONE runnable model config for an AI action: a model pick + the
// per-call params (temperature / top-p / max tokens / think / JSON) + the Plane-2
// long-tail samplers (the shared KnobGrid) + a Run button and a result readout
// (content + decode tok/s). It is the reusable unit behind BOTH the Feature
// Workbench (one column: edit + test one action) and the Compare lab (N columns:
// the SAME action across several model/param/sampler configs, ranked by tok/s) —
// so the run + tok/s logic lives here ONCE, not copied per surface (T3).
//
// The PROMPT + the test INPUT (vars) are owned by the PARENT and passed in, so
// Compare shares one input across all columns (a fair comparison) and the
// Workbench feeds its in-editor draft prompt. The column runs via the host
// `runStream` (live, with Cancel) when given, else a one-shot POST /v1/ai/run
// (both return token usage → the same decode-tok/s math).
import { ref } from "vue";

import { request } from "../client.js";
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

const props = defineProps({
  action: { type: String, default: "" },
  providers: { type: Array, default: () => [] },
  samplerCatalog: { type: Object, default: () => ({}) },
  // The shared test input (parent-owned; one set across Compare's columns).
  vars: { type: Object, default: () => ({}) },
  // Optional in-editor prompt override {system, userTemplate}; null → the action's
  // stored prompt (Compare). The Workbench passes its unsaved draft.
  promptOverride: { type: Object, default: null },
  // Host runner for live streaming (Cancel + token usage). Null → one-shot /run.
  runStream: { type: Function, default: null },
  // The inherit option's label on the model picker (Compare wants an explicit pick).
  inheritLabel: { type: String, default: "— inherit —" },
  // v-model: { pin:{providerId,model}|null, temperature, topP, maxTokens, think,
  // jsonMode, samplers:[{name,value}] }.
  modelValue: { type: Object, default: () => ({}) },
});
const emit = defineEmits(["update:modelValue", "result"]);

const testing = ref(false);
const testOut = ref(null);
const testErr = ref("");
const testCtrl = ref(null);

function wordCount(s) {
  return (String(s || "").trim().match(/\S+/g) || []).length;
}
function patch(key, val) {
  emit("update:modelValue", { ...(props.modelValue || {}), [key]: val });
}
function patchPin(val) {
  patch("pin", val && val.providerId ? { providerId: val.providerId, model: val.model || "" } : null);
}

function buildBody() {
  const c = props.modelValue || {};
  const o = {
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
    samplers: (c.samplers || [])
      .filter((r) => (r.name || "").trim())
      .map((r) => ({ flagName: r.name.trim(), flagValue: r.value || "" })),
  };
  if (props.promptOverride) {
    o.system = props.promptOverride.system;
    o.userTemplate = props.promptOverride.userTemplate;
  }
  return o;
}

// Run THIS column's config against the shared input. Exposed so a parent (Compare)
// can fire every column at once. Resolves when done; emits `result`.
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
      testOut.value = { content: "", model: "", ms: 0, tokens: 0, tps: 0, words: 0 };
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
      };
    } else {
      const r = await request("/v1/ai/run", { method: "POST", body: o });
      const ms = Math.round(performance.now() - t0);
      const out = r.completionTokens || 0;
      testOut.value = {
        content: r.content, model: r.model, ms,
        tokens: (r.promptTokens || 0) + out,
        // Decode speed = output tokens / wall-second (prompt is prefilled, not
        // decoded). The lab's tuning + ranking yardstick.
        tps: ms > 0 && out > 0 ? +(out / (ms / 1000)).toFixed(1) : 0,
        words: wordCount(r.content),
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

defineExpose({ run, cancel });
</script>

<template>
  <div class="cc">
    <div class="cc-field">
      <label>Provider &amp; model</label>
      <LuModelPicker editable :model-value="modelValue?.pin || null" :providers="providers" :labels="true"
        :inherit-label="inheritLabel" @update:model-value="patchPin" />
    </div>

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

    <details class="cc-samplers">
      <summary class="cc-eyebrow">Advanced samplers
        <span class="lu-muted">— top_k · min_p · mirostat … (mostly local)</span>
      </summary>
      <div class="cc-samplers-body">
        <KnobGrid :model-value="modelValue?.samplers || []" :catalog="samplerCatalog"
          add-label="＋ Add sampler" name-placeholder="sampler (e.g. top_k)"
          @update:model-value="patch('samplers', $event)" />
      </div>
    </details>

    <div class="cc-run">
      <UiButton v-if="!testing" intent="primary" size="small" @click="run">▶ Run</UiButton>
      <UiButton v-else intent="secondary" size="small" @click="cancel">■ Cancel</UiButton>
      <span v-if="testing" class="lu-muted cc-running">Running…</span>
      <span v-if="testErr" class="lu-error cc-err">{{ testErr }}</span>
    </div>

    <div v-if="testOut" class="cc-out">
      <pre class="cc-pre">{{ testOut.content }}</pre>
      <div class="lu-muted cc-stats">
        <template v-if="testOut.model">model <b>{{ testOut.model }}</b> · </template>
        <b>{{ testOut.words }}</b> words<template v-if="testOut.tokens"> · <b>{{ testOut.tokens }}</b> tokens</template><template v-if="testOut.tps"> · <b>{{ testOut.tps }}</b> tok/s</template> · {{ testOut.ms }} ms
      </div>
    </div>
  </div>
</template>

<style scoped>
.cc { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.cc-field { display: flex; flex-direction: column; gap: 5px; }
.cc-field > label { font-size: 12px; color: var(--muted); }
.cc-params { display: flex; gap: 14px 18px; align-items: flex-end; flex-wrap: wrap; }
.cc-num { max-width: 92px; }
.cc-reason { max-width: 120px; }
.cc-chk { display: flex; align-items: center; gap: 7px; }
.cc-eyebrow { font-size: 10px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); cursor: pointer; }
.cc-samplers-body { margin-top: 8px; }
.cc-run { display: flex; align-items: center; gap: 10px; }
.cc-running { font-size: 11.5px; } .cc-err { font-size: 12px; }
.cc-out { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 10px 12px; }
.cc-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.5; max-height: 240px; overflow: auto; color: var(--ink); }
.cc-stats { font-size: 11.5px; margin-top: 8px; }
</style>
