<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared Quick Setup — the intuitive FRONT DOOR for local models. A modal wizard
// (detect → confirm → apply → done) that picks ONE good model that fits your box and
// wires it as the shared default across every task, plus the always-on embedding.
//
// How the pick works (the §10 speed-floor rule — modelPick.js): it joins the runner's live
// Fit (/v1/llm-runner/models — VRAM/RAM gated, re-scorable for another card) with the
// catalog's `type` (dense|moe) + quality order (/v1/ai/model-catalog, qualityRank LOWER =
// better) and takes the most capable model that still streams faster than you read — a dense
// model fully on the GPU, or a usable A3B-MoE offload — excluding the slow dense-partial-
// offload, the embedding model (by the catalog `embedding` flag), and use-limited licenses.
// The embedding is the catalog's embed model; it rides routing.default.
//
// Apply (the "task owns the preset" model — 2026-07-02 Plan A): the chosen model is
// written onto every TASK PRESET (/v1/ai/engine-presets) that still points at the
// PREVIOUS shared default — NON-CLOBBER: a task whose preset the user re-pointed on the
// Tasks tab keeps its own model. Each preset keeps its per-task settings (top_p / json /
// samplers); only `.model` changes. The embedding is set via /v1/ai/routing (pins kept);
// then the chosen model is downloaded (if needed) + loaded as the active one.
//
// JustWrite mounts this kit view; JustVoice has its own (TTS) setup wizard. It replaces the
// old jobs-based wiring (/v1/ai/jobs + a routing `jobs` map — both retired with taskKinds).
import { computed, onBeforeUnmount, ref } from "vue";

import { request } from "../client.js";
import { listClassTunes } from "../classTunes.js";
import { useCatalogMeta } from "../composables/useCatalogMeta.js";
import { recommendedModelId, pickLowestQuality, FIT_GPU, FIT_RUNNABLE, FIT_LABEL } from "../common/services/modelPick.js";
import { applyPreview, modelHasTunes, setAsDefault, setAsEmbedding, LOCAL_RUNNER_ID } from "../services/modelApply.js";
import { confirmDialog } from "../common/services/dialog.js";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiProgress from "../common/components/UiProgress.vue";
import AppModal from "../common/components/AppModal.vue";

const emit = defineEmits(["changed"]);
// inline (user, 2026-07-06: "the orginal text to be to th right of the button" · "quick setup
// button so people know what it does" · "leave out the all editable"): render the Run button
// PLUS its one-line description to the right, bare (no card), for embedding on the Built-in
// server card. ROUND 4 first shipped this as a button ONLY; the user restored the caption.
// Default (unset) keeps the full titled strip for other mounts.
const props = defineProps({ inline: { type: Boolean, default: false } });

// LOCAL_RUNNER_ID (modelApply) + FIT_LABEL / FIT_RUNNABLE (modelPick) come from the shared kit
// — ONE source, no drift.

// ── modal + wizard state ────────────────────────────────────────────────────
const open = ref(false);
const step = ref("detect"); // detect | confirm | apply | done
const loading = ref(true);
const error = ref("");

const hw = ref(null);
const models = ref([]);
// The "Plan for card" what-if selector was REMOVED (model-per-hardware plan Phase 2,
// user decision #7): the wizard configures THIS machine — Apply always lands on the real
// box, so a config planned for a hypothetical card never matched where it ran. The
// hardware-class question moved to data (the class→model map); the server's vram_mb
// query param survives for the power-user catalog view.

// Editable pick: the one good LLM (`default`) + the embedding provider/model.
// Pre-filled from Fit × quality, the default is overridable in the confirm step.
const pick = ref({ default: "", embeddingId: "", embeddingModel: "" });

// QuickSetup is LOCAL-ONLY (user decision 2026-07-06, reversing the 2026-07-05 other-provider
// option): it configures the bundled runner and nothing else. External providers (Ollama /
// LM Studio / cloud) are set up on the provider list (ProviderForm), never in this wizard.

// ── catalog meta (by id) — quality order + type + embedding + use-limited + description ──
// The /v1/llm-runner/models view is fit-shaped and carries none of these; the catalog does.
// `type` (dense|moe) + `embedding` drive the §10 speed-floor pick. Shared with LuModelCatalog
// through the useCatalogMeta singleton (one source, no drift — the useRunnerModels precedent).
const { classPicks, qualityById, typeById, embeddingById, useLimitedById, descriptionById, refresh: refreshCatalogMeta } = useCatalogMeta();
function qualityOf(m) { return qualityById.value[m.id] ?? 100; }
function typeOf(m) { return typeById.value[m.id] || "dense"; }
function useLimitedOf(m) { return !!useLimitedById.value[m.id]; }
function descriptionOf(id) { return descriptionById.value[id] || ""; }
// Embedding models are excluded from the LLM auto-pick + the model dropdown. The explicit
// catalog `embedding` flag is authoritative (bge-m3 has no "embed" in its name); the name
// regex stays as a fallback for a user-added embed not yet flagged.
function isEmbed(m) {
  return embeddingById.value[m.id] === true || /embed/i.test(m.id || "") || /embed/i.test(m.name || "");
}

// ── derived ─────────────────────────────────────────────────────────────────
function paramsNum(p) {
  const n = Number.parseFloat(String(p || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 999;
}
// CHAT candidates need a GPU (user, 2026-07-06 — CPU prose is too slow to support);
// embeds keep the CPU band (fittingEmbeds below, "yes on embeding").
const fitting = computed(() =>
  models.value
    .filter((m) => !isEmbed(m) && FIT_GPU.has(m.fit))
    .sort((a, b) => paramsNum(a.params) - paramsNum(b.params)),
);
const modelById = computed(() => Object.fromEntries(models.value.map((m) => [m.id, m])));
// One <option> per catalog LLM (embedding excluded — it has its own line), Fit annotated,
// so the default can be overridden to any model.
const modelOptions = computed(() =>
  models.value
    .filter((m) => !isEmbed(m))
    .map((m) => ({
      value: m.id,
      label: `${m.name} · ${FIT_LABEL[m.fit] || "—"}${m.params ? ` · ${m.params}` : ""}`,
    })),
);
// Only the FITTING embed models — the editable embedding dropdown (design §3). Best-fit
// default = lowest quality_rank (the §10 embedding pick, via the shared comparator).
const fittingEmbeds = computed(() => models.value.filter((m) => isEmbed(m) && FIT_RUNNABLE.has(m.fit)));
const embedOptions = computed(() =>
  fittingEmbeds.value.map((m) => ({ value: m.id, label: `${m.name}${m.params ? ` · ${m.params}` : ""}` })),
);
function bestEmbedId() { return pickLowestQuality(fittingEmbeds.value, { qualityOf }); }
function onEmbedChange() { pick.value.embeddingId = LOCAL_RUNNER_ID; } // all embed options are local

const embedName = computed(() => {
  const e = models.value.find((m) => m.id === pick.value.embeddingModel);
  return e?.name || pick.value.embeddingModel || "";
});

const hwLine = computed(() => {
  const h = hw.value;
  if (!h) return "";
  const g = h.gpus && h.gpus[0];
  const vram = g?.vramMb ? ` · ${Math.round(g.vramMb / 1024)} GB VRAM` : "";
  const ram = h.ramMb ? ` · ${Math.round(h.ramMb / 1024)} GB RAM` : "";
  const os = h.platform ? ` · ${h.platform}` : "";
  return `${g ? g.name : "CPU only"}${vram}${ram}${os}`;
});
function fitOf(id) {
  return modelById.value[id]?.fit || "unknown";
}

// The one good LLM — the §10 speed-floor pick ("most capable that still streams faster than
// you read"): among the runnable, non-embedding, non-use-limited models, prefer the ones
// fast enough (a dense model fully on GPU, or a usable A3B-MoE offload), excluding the slow
// dense-partial-offload, and rank by quality_rank; fall back to best-runnable if none clear
// the floor. The pure rule lives in modelPick.js (Node-verifiable); here we bind the
// catalog-join accessors (type / quality / embedding / use-limited).
function bestFittingId() {
  // Delegates to the ONE composed rule in modelPick.js (class map first, §10
  // speed-floor fallback) — the catalog's "Recommended for this PC" badge calls
  // the same function, so the wizard and the badge can never disagree.
  const vramMb = (hw.value?.gpus && hw.value.gpus[0]?.vramMb) || 0;
  return recommendedModelId(fitting.value, {
    classPicks: classPicks.value,
    vramMb,
    byId: modelById.value,
    typeOf,
    qualityOf,
    isEmbed,
    isUseLimited: useLimitedOf,
    runnable: FIT_GPU, // chat picks never land on a CPU-spill model (user decision)
  });
}

// Apply is enabled once there's a fitting local pick; a box with nothing that fits
// stays disabled (the empty-state points at a bigger card / a smaller model).
const applyDisabled = computed(() => !fitting.value.length || !pick.value.default);

// ── load hardware + catalog (optionally for an overridden card) ──────────────
async function loadAll() {
  loading.value = true;
  error.value = "";
  try {
    const [h, m] = await Promise.all([
      request("/v1/llm-runner/hardware"),
      request("/v1/llm-runner/models"),
      refreshCatalogMeta(), // shared catalog-meta maps (quality / use-limited / description)
    ]);
    hw.value = h;
    models.value = m.models || [];
    prefillPick();
  } catch (e) {
    error.value = `Couldn't read hardware / catalog: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

// Pre-fill the default (the §10 speed-floor pick) + the embedding (the catalog's embed
// model). Never overwrites a value already set (a user pick, or a saved embedding).
function prefillPick() {
  if (!pick.value.default) pick.value.default = bestFittingId();
  if (!pick.value.embeddingModel) {
    const best = bestEmbedId();
    if (best) {
      pick.value.embeddingId = LOCAL_RUNNER_ID;
      pick.value.embeddingModel = best;
    }
  }
}

// Saved embedding wins over the nomic fallback — only overwrite the pre-fill when the
// stored routing actually carries one (order-independent vs prefillPick's fallback).
async function loadRouting() {
  try {
    const r = await request("/v1/ai/routing");
    if (r.default?.embeddingId) pick.value.embeddingId = r.default.embeddingId;
    if (r.default?.embeddingModel) pick.value.embeddingModel = r.default.embeddingModel;
  } catch {
    /* routing may be empty on a fresh install — keep the pre-filled best-fit embed default */
  }
}

// ── open / close ────────────────────────────────────────────────────────────
async function openWizard() {
  open.value = true;
  step.value = "detect";
  pick.value = { default: "", embeddingId: "", embeddingModel: "" };
  previewState.value = null;
  optState.value = null;
  tunedAlready.value = false;
  classTuned.value = false;
  optQuick.value = false;
  await Promise.all([
    loadAll(),
    loadRouting(),
    // D4-1 (a)+(c): the change preview — computed by the SAME dominantOf the Apply
    // writer uses (modelApply.applyPreview), so the changelist can never drift.
    applyPreview().then((p) => { previewState.value = p; }).catch(() => { previewState.value = null; }),
  ]);
  // Reconcile AFTER all three resolve (order-safe — the catalog is loaded here):
  // 1. The wizard opens ON the applied setup (user, 2026-07-06: "if model is already
  //    applied then drop down should select that model") — the dropdown starts at the
  //    CURRENT default when it still exists in the catalog, so re-opening the wizard
  //    proposes NO change; the recommendation is only the fresh-box/fallback pick.
  // 2. Dead references never preselect (a deleted model must not be silently kept —
  //    the round-2 dangling-refs honesty): a routing embed pointing at a model no
  //    longer in the catalog falls back to the best fitting embed, or none.
  const dom = previewState.value?.dominant;
  if (dom && modelById.value[dom]) pick.value.default = dom;
  if (pick.value.embeddingModel && !modelById.value[pick.value.embeddingModel]) {
    pick.value.embeddingId = "";
    pick.value.embeddingModel = "";
    const best = bestEmbedId();
    if (best) {
      pick.value.embeddingId = LOCAL_RUNNER_ID;
      pick.value.embeddingModel = best;
    }
  }
  step.value = "confirm"; // confirm renders the empty-state when nothing fits
}
function onModalClose() {
  open.value = false;
}
// Close guard (user, 2026-07-06 — reversing the earlier "leave it running in background": the
// sweep pegs the GPU and PAUSES every other AI feature, so a headless background run is a trap
// the user can't see). While a sweep runs, the modal's X + Esc are disabled (:closable below);
// this footer Close asks first — OK stops the sweep and closes, Cancel returns to the tuning
// screen.
async function attemptClose() {
  if (optRunning.value) {
    const ok = await confirmDialog({
      title: "Optimization is still running",
      message: "Auto-tuning is still measuring the fastest launch settings for this machine, and it holds the GPU so other AI features are paused. Close now and stop it? No tuned settings will be saved.",
      confirmLabel: "Close and stop",
      cancelLabel: "Keep optimizing",
    });
    if (!ok) return;
    await skipOptimize();
  }
  open.value = false;
}

// ── D4-1 (a)+(c) changelist (reactive against the live pick) ────────────────
const previewState = ref(null);
const repointedPresets = computed(() => {
  const st = previewState.value;
  if (!st || !pick.value.default) return [];
  return st.presets.filter((p) => p.model === st.dominant && p.model !== pick.value.default);
});
const keptPresets = computed(() => {
  const st = previewState.value;
  if (!st) return [];
  return st.presets.filter((p) => p.model !== st.dominant);
});

// ── apply: one model → every task preset (non-clobber) + embedding + download/load ──
const applying = ref(false);
const applyDetail = ref("");
async function apply() {
  applying.value = true;
  error.value = "";
  try {
    // A sweep still running (this wizard, the Tune dialog, an earlier window) holds the
    // GPU and its trial loop stop()s the router between trials — a load issued under it
    // gets torn down and reads as a hang (the user's 2026-07-07 repro: cancel didn't
    // take, re-ran Quick Setup, the VRAM load hung). Confirm, stop it, THEN load.
    const tune = await request("/v1/llm-runner/auto-tune").catch(() => null);
    if (tune?.status === "running") {
      const ok = await confirmDialog({
        title: "Optimization is still running",
        message: "An optimize sweep is still measuring launch settings and holds the GPU. Applying now stops it — no tuned settings will be saved.",
        confirmLabel: "Stop it and apply",
        cancelLabel: "Keep optimizing",
      });
      if (!ok) return;
      await request("/v1/llm-runner/auto-tune/cancel", { method: "POST" }).catch(() => {});
    }
    step.value = "apply";
    // The chosen chat default goes through the shared modelApply.setAsDefault — the SAME
    // writer the catalog's Set-as-default uses, so the surfaces never drift: it writes
    // `{...p, providerId, model}` onto every task preset that still shares the previous
    // default (non-clobber; each preset keeps its per-task settings). The embedding stays a
    // LOCAL runner concern (the RAG index) — only written when one is chosen (no clobber of
    // a saved embed with a blank).
    const target = pick.value.default;
    await setAsDefault(LOCAL_RUNNER_ID, target);
    if (pick.value.embeddingModel) await setAsEmbedding(pick.value.embeddingId, pick.value.embeddingModel);
    // Download (if needed) + load the chosen model as the active one, polling status so the
    // user sees progress. The embedding downloads on first search/index.
    if (target) {
      await request("/v1/llm-runner/load", { method: "POST", body: { modelId: target } });
      await pollLoad();
    }
    // NO auto-sweep on Apply (user, 2026-07-07: the measured sweep is too long for a
    // "quick" setup — "6 trials 12 minutes … not acceptable especially for a quick
    // setup"). Apply just loads the model; a matching hardware-class tune (the class-seed)
    // is already in the resolved switches at load, so a known box is fast instantly with
    // no sweep. Optimizing is now an explicit choice on the done step ("Optimize for this
    // PC"); the long measured sweep otherwise lives in the Lab. `tunedAlready` still drives
    // the done-step button label (Optimize vs Re-optimize).
    tunedAlready.value = target ? await modelHasTunes(target) : false;
    // The done step tells the truth about WHICH launch config this box got (ROUND 8
    // Task B remainder): its own measured tune > a matching hardware-class tune >
    // the engine's computed fit (→ offer the ~2-min quick pass + the full sweep).
    classTuned.value = false;
    if (target && !tunedAlready.value) {
      try {
        const lib = await listClassTunes();
        classTuned.value = (lib.tunes || []).some(
          (t) => t.modelId === target && t.classKey === lib.classKey && t.rows?.length,
        );
      } catch { /* enrichment — the untuned copy still renders honestly */ }
    }
    step.value = "done";
    emit("changed");
  } catch (e) {
    error.value = `Apply failed: ${e.message}`;
    step.value = "confirm";
  } finally {
    applying.value = false;
  }
}

async function pollLoad() {
  for (let i = 0; i < 600; i++) {
    let st;
    try {
      st = await request("/v1/llm-runner/status");
    } catch {
      return;
    }
    applyDetail.value = st.detail || st.status || "";
    if (st.status === "running") return;
    if (st.status === "error") {
      error.value = st.error || "Model failed to load.";
      return;
    }
    await new Promise((res) => setTimeout(res, 1200));
  }
}

// ── Optimize for this PC (2026-07-06, reshaped 2026-07-07): the consumer of the
// auto-tune job. Same server-side sweep the Tune modal drives, but with
// save:true — the winner is persisted as this machine's tune automatically
// (the QuickSetup audience won't open the Tune modal to review knobs; the
// measured delta is what turns "runs" into "runs fast": 8.6× TTFT on the
// reference box). EXPLICIT-ONLY: Apply never auto-starts it (user, 2026-07-07 —
// the adaptive walk runs 10+ minutes, too long for a "quick" setup; a known
// hardware class gets the seeded class-tune at load instead), it monopolizes
// the GPU while it runs, and closing the wizard mid-run confirm-stops it
// (attemptClose).
const optState = ref(null); // null (not started) | the GET payload
const tunedAlready = ref(false); // (model, THIS machine) already has measured tune rows
const classTuned = ref(false);   // a hardware-class tune matched this box + model at load
// The ~2-min quick pass (user: "both lab and 2 min sweep") — the SAME sweep with a
// server-side time box; the run stops with the best result so far. optQuick drives
// the honest copy (a capped pass phrases its running/done text differently).
const QUICK_TUNE_SECONDS = 120;
const optQuick = ref(false);
let optTimer = null;
const optRunning = computed(() => optState.value?.status === "running");
// The finished trials so far (each a real load→measure result) — the honest "it's working"
// signal on a LONG job: shown live with their tok/s so progress is visible without a fake ETA.
const optTrialsDone = computed(() => optState.value?.trials || []);

// Live progress affordances (user, 2026-07-06: "is small … something moving to show it is still
// working" + "much longer than 2-4 mins … mine has been running for 4 mins already"). A reliable
// completion ETA is IMPOSSIBLE — the sweep (autotune.py) is an adaptive n-cpu-moe walk with no
// pre-known trial count, and each trial is a full unload→reload→measure (~2 min on the 2070S),
// so it can run 10+ minutes. So: a ticking elapsed clock + the indeterminate bar + the live
// trial list, never a countdown.
const optElapsed = ref(0); // seconds since the sweep began (this window's view of it)
let optStartedAt = 0;
let optTickTimer = null;
const optElapsedLabel = computed(() => {
  const s = optElapsed.value;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});
const optRunLabel = computed(() => optState.value?.detail || "measuring…");
function startOptTick() {
  optStartedAt = Date.now();
  optElapsed.value = 0;
  if (optTickTimer) clearInterval(optTickTimer);
  optTickTimer = setInterval(() => { optElapsed.value = Math.floor((Date.now() - optStartedAt) / 1000); }, 1000);
}
function stopOptTick() { if (optTickTimer) { clearInterval(optTickTimer); optTickTimer = null; } }

function stopOptPoll() {
  if (optTimer) { clearInterval(optTimer); optTimer = null; }
  stopOptTick();
}
async function pollOptimize() {
  try {
    const st = await request("/v1/llm-runner/auto-tune");
    optState.value = st;
    if (st.status !== "running") stopOptPoll();
  } catch {
    stopOptPoll(); // transient — the block's retry button re-arms
  }
}
async function startOptimize(budgetSeconds = 0) {
  optQuick.value = budgetSeconds > 0;
  try {
    const st = await request("/v1/llm-runner/auto-tune", {
      method: "POST",
      body: { modelId: pick.value.default, save: true,
              ...(budgetSeconds > 0 ? { budgetSeconds } : {}) },
    });
    if (st.ok === false) {
      // Busy guard: a sweep is already running (the Tune modal / another window) —
      // ADOPT the shared job instead of erroring (plan Phase 2): render its live
      // state and poll it to completion like our own.
      const cur = await request("/v1/llm-runner/auto-tune").catch(() => null);
      if (cur?.status === "running") {
        optState.value = cur;
        optQuick.value = (cur.budgetSeconds || 0) > 0; // adopt the job's own shape
        stopOptPoll();
        optTimer = setInterval(pollOptimize, 2000);
        startOptTick();
        return;
      }
      throw new Error(st.error || "Couldn't start optimizing.");
    }
    optState.value = st;
    stopOptPoll();
    optTimer = setInterval(pollOptimize, 2000);
    startOptTick();
  } catch (e) {
    optState.value = { status: "error", error: e.message || "Couldn't start optimizing." };
  }
}
// Skip = cancel, PROMPT (2026-07-07): the backend aborts the trial in flight (the
// load-wait observes the flag), frees the GPU, and restores the applied model with
// its resolved switches — no more waiting out a 240s trial load ("cant cance tune").
// The cancel response IS the live status ("stopping…"), reflected immediately.
async function skipOptimize() {
  try {
    const st = await request("/v1/llm-runner/auto-tune/cancel", { method: "POST" });
    if (st?.status) optState.value = st;
  } catch { /* already finished — the next poll shows the terminal state */ }
  await pollOptimize();
}
// Re-optimize (tuned machines only): explicit overwrite consent first (amendment A8 —
// the sweep's save REPLACES this machine's rows; with the 1b strict-beat rule it only
// actually replaces them when a strictly faster config is measured).
async function reOptimize() {
  const ok = await confirmDialog({
    title: "Overwrite this machine's tuned settings?",
    message: "This machine already has a measured launch config for this model. Re-optimizing runs a new sweep and replaces the saved settings only if a strictly faster configuration is found.",
    confirmLabel: "Re-optimize",
  });
  if (ok) startOptimize();
}
onBeforeUnmount(stopOptPoll);

defineExpose({ openWizard });
</script>

<template>
  <div class="lu-qs" :class="{ 'lu-qs--bare': props.inline }">
    <!-- Trigger (replaces the old inline card; opens the wizard). inline = the button + its
         one-line description to the right (user restored the caption "so people know what it
         does"); the default is the full titled strip. -->
    <template v-if="props.inline">
      <UiButton intent="primary" @click="openWizard">Run Quick Setup</UiButton>
      <!-- QC-42 (the user's exact copy): the wizard is built-in-only — say so
           right of the button, bigger than the description, so nobody expects
           it to configure an online provider. -->
      <span class="lu-qs-barefor">For the Local built-in provider</span>
      <span class="lu-muted lu-qs-baresub">Detect your hardware, pick the best free local model that fits, and set it as your default.</span>
    </template>
    <div v-else class="lu-qs-head">
      <div>
        <b class="lu-qs-title">Quick Setup</b>
        <span class="lu-muted lu-qs-sub">Detect your hardware, pick the best free local model that fits, and set it as your default — all editable.</span>
      </div>
      <UiButton intent="primary" size="small" @click="openWizard">Run Quick Setup</UiButton>
    </div>

    <AppModal
      v-if="open"
      :title="step === 'detect' ? 'Probing your hardware…' : step === 'apply' ? 'Setting up…' : step === 'done' ? 'All set' : 'Recommended setup — for the Local built-in provider only'"
      :max-width="'640px'"
      :closable="step !== 'apply' && !optRunning"
      @close="onModalClose"
    >
      <!-- DETECT -->
      <div v-if="step === 'detect'" class="lu-muted lu-qs-loading">Reading GPU + model catalog…</div>

      <!-- CONFIRM (editable) -->
      <template v-else-if="step === 'confirm'">
        <div v-if="error" class="lu-error">{{ error }}</div>

        <p class="lu-muted lu-qs-req">Requirements: a video card with at least 8 GB VRAM and 32 GB of system RAM.</p>

        <section class="lu-qs-sec">
          <div class="lu-qs-k">Detected</div>
          <div class="lu-qs-detected"><b>{{ hwLine }}</b></div>
        </section>

        <div v-if="loading" class="lu-muted">Reading the catalog…</div>
        <template v-else-if="fitting.length">
          <!-- The one good model — a single editable pick that runs every task. -->
          <section class="lu-qs-sec">
            <div class="lu-qs-k">
              Default model
              <span class="lu-fit lu-qs-fit" :class="`lu-fit--${fitOf(pick.default)}`">{{ FIT_LABEL[fitOf(pick.default)] }}</span>
            </div>
            <UiSelect v-model="pick.default" :options="modelOptions" />
            <p class="lu-muted lu-qs-hint">One good model runs every task — writing, chat, extraction, judgment. Per-task overrides live under Routing by task; this sets the shared default.</p>
            <p v-if="descriptionOf(pick.default)" class="lu-qs-why">
              <b>About this model:</b> {{ descriptionOf(pick.default) }}
            </p>
          </section>
        </template>
        <div v-else class="lu-muted lu-qs-empty">
          No chat model can run well on this machine — writing needs a video card with at least 8 GB VRAM and 32 GB of system RAM (CPU-only generation is too slow to support).
        </div>

        <!-- The embedding — always LOCAL (the RAG index). -->
        <section v-if="embedOptions.length" class="lu-qs-sec">
          <div class="lu-qs-k">Embedding</div>
          <UiSelect v-model="pick.embeddingModel" :options="embedOptions" @update:model-value="onEmbedChange" />
          <p class="lu-muted lu-qs-hint">Powers semantic search + grounded chat. Runs on the bundled runner alongside your chat model; a smaller embed is fine.</p>
        </section>

        <!-- What will happen on Apply. -->
        <section class="lu-qs-sec lu-qs-routing">
          <div class="lu-qs-k">What happens when you click Apply</div>
          <ul class="lu-qs-rlist">
            <li v-if="modelById[pick.default]"><b>{{ modelById[pick.default].name }}</b> <span class="lu-muted">— becomes the model for every task, except any you've changed yourself under Routing by task.</span></li>
            <li v-if="pick.default">It <b>downloads now</b> if it isn't already on disk, then loads as the active model.</li>
            <li v-if="pick.embeddingModel">Embedding set to <code>{{ embedName }}</code> — runs on the bundled runner, downloads on first search/index.</li>
            <li>Per-feature pins you've set stay as they are.</li>
          </ul>
        </section>

        <!-- D4-1 (a)+(c): a box that's already configured (mixed task models, or measured
             tunes for a current model) sees EXACTLY which tasks Apply will change before
             anything writes — the lists come from the SAME dominant-model logic the Apply
             writer uses. A fresh box renders nothing here and stays one-click. -->
        <section v-if="previewState?.configured" class="lu-qs-sec lu-qs-changes">
          <div class="lu-qs-k">This machine is already set up — what Apply will change</div>
          <template v-if="repointedPresets.length">
            <ul class="lu-qs-rlist">
              <li v-for="p in repointedPresets" :key="p.id">
                <b>{{ p.name }}</b> <span class="lu-muted">re-points from <code>{{ p.model }}</code> to <code>{{ pick.default }}</code></span>
              </li>
            </ul>
          </template>
          <p v-else class="lu-muted">All tasks already use this model — Apply changes no task routing.</p>
          <p v-if="keptPresets.length" class="lu-muted lu-qs-hint">
            Kept as you set them: {{ keptPresets.map((p) => p.name).join(", ") }}.
          </p>
          <p class="lu-muted lu-qs-hint">Your saved machine tunes are never touched by Apply.</p>
        </section>
      </template>

      <!-- APPLY -->
      <template v-else-if="step === 'apply'">
        <p class="lu-qs-applying">Setting your default model and loading <b>{{ modelById[pick.default]?.name || pick.default }}</b>…</p>
        <p class="lu-muted">{{ applyDetail || "working…" }}</p>
      </template>

      <!-- DONE -->
      <template v-else-if="step === 'done'">
        <p><b>Setup applied.</b></p>
        <ul class="lu-qs-summary">
          <li>Default model · <code>{{ modelById[pick.default]?.name || pick.default }}</code></li>
          <li v-if="pick.embeddingModel">Embedding · <code>{{ embedName }}</code></li>
        </ul>

        <!-- C8 integration: the wizard is local-only, so the old `isBundled` guard is gone —
             the optimize offer needs only a picked model. EXPLICIT-ONLY (2026-07-07): Apply
             never auto-starts the sweep; an untuned machine gets "Optimize for this PC", a
             tuned machine gets Re-optimize behind an explicit overwrite confirm. -->
        <div v-if="pick.default" class="lu-qs-opt">
          <!-- The truth ladder (ROUND 8 Task B remainder): own measured tune >
               a matching hardware-class tune > the engine's computed fit. The
               wholly-untuned branch offers BOTH the ~2-min quick pass and the
               full sweep (user: "both lab and 2 min sweep"); the deeper path is
               the model's Tune dialog. -->
          <template v-if="!optState">
            <template v-if="tunedAlready">
              <UiButton intent="secondary" size="small" @click="reOptimize">Re-optimize</UiButton>
              <span class="lu-muted">This machine already has measured launch settings for this model — re-run the sweep only if your hardware changed.</span>
            </template>
            <template v-else-if="classTuned">
              <span class="lu-qs-opt-ok">Tuned settings for your hardware were applied ✓</span>
              <span class="lu-muted">PCs with this much video memory and RAM come pre-measured, so no sweep is needed. Optional: a full measured sweep can still fine-tune this exact machine — it can take 10 minutes or more; other AI features pause while it runs.</span>
              <UiButton intent="secondary" size="small" @click="startOptimize()">Optimize for this PC</UiButton>
            </template>
            <template v-else>
              <span class="lu-muted">No measured settings for this PC yet — it runs on the engine's automatic memory fitting, which works but may not be the fastest.</span>
              <div class="lu-qs-opt-btns">
                <UiButton intent="secondary" size="small" @click="startOptimize(QUICK_TUNE_SECONDS)">Quick optimize (~2 min)</UiButton>
                <UiButton intent="secondary" size="small" @click="startOptimize()">Full optimize</UiButton>
              </div>
              <span class="lu-muted">Quick tries the most likely settings within about 2 minutes and keeps the best; Full keeps measuring (10 minutes or more) and is often several times faster to first token. Deeper control lives in the model's Tune dialog. Other AI features pause while a sweep runs.</span>
            </template>
          </template>
          <template v-else-if="optRunning">
            <div class="lu-qs-opt-run">
              <div class="lu-qs-opt-line">
                <b class="lu-qs-opt-title">{{ optQuick ? "Quick optimize — measuring…" : "Optimizing for this PC…" }}</b>
                <span class="lu-qs-opt-elapsed">{{ optElapsedLabel }} elapsed</span>
              </div>
              <UiProgress :label="optRunLabel" />
              <p class="lu-muted lu-qs-opt-eta">
                <template v-if="optQuick">This quick pass is time-boxed to about 2 minutes — it
                  tries the most likely settings and keeps the best one found. Your GPU is busy
                  while it runs, so other AI features pause until it finishes or you stop it.</template>
                <template v-else>This runs a sequence of load-and-measure trials and can take 10
                  minutes or more — longer for larger models. Your GPU is busy while it runs, so
                  other AI features pause until it finishes or you stop it.</template>
              </p>
              <ul v-if="optTrialsDone.length" class="lu-qs-opt-trials">
                <li v-for="(t, i) in optTrialsDone" :key="i" :class="{ 'is-fail': !t.ok }">
                  <span class="lu-qs-opt-tl">{{ t.label }}</span>
                  <span v-if="t.ok" class="lu-qs-opt-tv">{{ Math.round(t.tokensPerSec) }} tok/s</span>
                  <span v-else class="lu-qs-opt-tx">{{ t.error && t.error.startsWith("skipped") ? "skipped" : "failed" }}</span>
                </li>
              </ul>
              <div class="lu-qs-opt-act">
                <UiButton intent="secondary" @click="skipOptimize">Skip</UiButton>
                <span class="lu-muted lu-qs-opt-skiphint">Skipping keeps everything set up; you can optimize later from the model's Tune dialog.</span>
              </div>
            </div>
          </template>
          <template v-else-if="optState.status === 'done' && optState.best">
            <!-- Self-diagnosing quick pass (ROUND 8): a capped run that saved nothing
                 routes the user deeper (the full sweep / the Tune dialog) instead of
                 reading like a verdict — 2 minutes is a probe, not proof. -->
            <span class="lu-qs-opt-ok">Optimized ✓ {{ optState.best.tokensPerSec }} tok/s —
              {{ optState.saved
                ? "saved for this machine."
                : (optState.best.label === "baseline"
                    ? (optQuick
                        ? "the quick pass found nothing faster — Full optimize or the model's Tune dialog can search deeper."
                        : "your current launch is already the fastest — nothing needed saving.")
                    : "save failed — open Tune & measure to save it.") }}</span>
          </template>
          <template v-else-if="optState.status === 'cancelled'">
            <span class="lu-muted">Optimize cancelled.</span>
            <UiButton intent="ghost" size="small" @click="startOptimize()">Try again</UiButton>
          </template>
          <template v-else>
            <span class="lu-error">{{ optState.error || "Optimize failed." }}</span>
            <UiButton intent="ghost" size="small" @click="startOptimize()">Try again</UiButton>
          </template>
        </div>
      </template>

      <template #footer>
        <template v-if="step === 'confirm'">
          <UiButton intent="ghost" @click="onModalClose">Cancel</UiButton>
          <span class="lu-qs-spacer" />
          <UiButton intent="primary" :disabled="applyDisabled" :loading="applying" @click="apply">
            Apply setup
          </UiButton>
        </template>
        <template v-else-if="step === 'done'">
          <span class="lu-qs-spacer" />
          <UiButton intent="primary" @click="attemptClose">Close</UiButton>
        </template>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.lu-qs { border: 1px solid var(--border); border-radius: var(--r-md, 10px); background: var(--surface); padding: 12px 16px; }
.lu-qs--bare { border: none; border-radius: 0; background: transparent; padding: 0; display: inline-flex; align-items: center; gap: 12px; }
.lu-qs-barefor { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.lu-qs-baresub { font-size: 12px; line-height: 1.4; }
.lu-qs-head { display: flex; align-items: center; gap: 12px; }
.lu-qs-head > div { flex: 1; min-width: 0; }
.lu-qs-title { font-size: 14px; color: var(--ink); }
.lu-qs-sub { font-size: 11.5px; margin-left: 8px; }
.lu-qs-loading { text-align: center; padding: 24px 0; }
.lu-qs-sec { margin-bottom: 18px; }
.lu-qs-k {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); margin-bottom: 8px; font-weight: 700;
  display: flex; align-items: center; gap: 8px;
}
.lu-qs-fit { margin-left: auto; }
.lu-qs-detected { font-size: 13px; color: var(--ink-2); }
.lu-qs-hint { font-size: 11.5px; line-height: 1.55; margin: 6px 0 0; }
.lu-qs-why {
  font-size: 12px; line-height: 1.5; margin: 8px 0 0;
  padding: 8px 10px; background: var(--surface-2); border-radius: 6px;
  color: var(--ink-2); border-left: 2px solid var(--accent);
}
.lu-qs-why b { color: var(--ink); }
.lu-qs-routing { background: var(--surface-2); padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border); }
.lu-qs-rlist { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; line-height: 1.45; }
.lu-qs-rlist li { padding-left: 14px; position: relative; }
.lu-qs-rlist li::before { content: "•"; position: absolute; left: 0; color: var(--muted); }
.lu-qs-rlist code { font-family: var(--font-mono, monospace); font-size: 11.5px; }
.lu-qs-empty { font-size: 12.5px; padding: 8px 0; }
.lu-qs-req { font-size: 12px; margin: 0 0 12px; }
.lu-qs-applying { font-size: 13px; }
.lu-qs-summary { margin: 8px 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.lu-qs-opt { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; margin: 10px 0; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm, 8px); font-size: 12px; }
.lu-qs-opt-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.lu-qs-opt-run { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.lu-qs-opt-line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.lu-qs-opt-title { font-size: 13.5px; color: var(--ink); }
.lu-qs-opt-elapsed { font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.lu-qs-opt-eta { font-size: 12px; margin: 0; line-height: 1.5; }
.lu-qs-opt-trials { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 132px; overflow-y: auto; }
.lu-qs-opt-trials li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.lu-qs-opt-trials li.is-fail { opacity: .6; }
.lu-qs-opt-tl { flex: 1; min-width: 0; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lu-qs-opt-tv { font-variant-numeric: tabular-nums; color: var(--accent-ink, var(--accent)); font-weight: 600; }
.lu-qs-opt-tx { font-size: 11px; color: var(--muted); }
.lu-qs-opt-act { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
.lu-qs-opt-skiphint { font-size: 11.5px; }
.lu-qs-opt-ok { font-size: 12.5px; color: var(--accent-ink, var(--accent)); font-weight: 600; }
.lu-qs-spacer { flex: 1; }
.lu-fit { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 10.5px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); flex: none; }
.lu-fit--ok { background: var(--accent-soft); border-color: var(--accent-line, var(--accent)); color: var(--accent-ink, var(--accent)); }
.lu-fit--tight { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }
.lu-fit--no { background: var(--danger-bg, #f7e7e4); border-color: var(--danger-line, var(--danger)); color: var(--danger); }
.lu-fit--cpu, .lu-fit--unknown { background: var(--surface-3); }
</style>
