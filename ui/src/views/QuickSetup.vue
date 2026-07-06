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
import { useCatalogMeta } from "../composables/useCatalogMeta.js";
import { pickBestModel, pickLowestQuality, FIT_RUNNABLE, FIT_LABEL } from "../common/services/modelPick.js";
import { setAsDefault, setAsEmbedding, LOCAL_RUNNER_ID } from "../services/modelApply.js";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import AppModal from "../common/components/AppModal.vue";

const emit = defineEmits(["changed"]);

// LOCAL_RUNNER_ID (modelApply) + FIT_LABEL / FIT_RUNNABLE (modelPick) come from the shared kit
// — ONE source, no drift.

// ── modal + wizard state ────────────────────────────────────────────────────
const open = ref(false);
const step = ref("detect"); // detect | confirm | apply | done
const loading = ref(true);
const error = ref("");

const hw = ref(null);
const models = ref([]);
const detectedVramMb = ref(0);
// Card/VRAM override — re-scores Fit for a card other than this machine's.
const cardOverride = ref("auto");
const CARD_OPTIONS = [
  { value: "auto", label: "This machine" },
  { value: "0", label: "CPU only (no GPU)" },
  { value: "8192", label: "8 GB card" },
  { value: "12288", label: "12 GB card" },
  { value: "16384", label: "16 GB card" },
  { value: "24576", label: "24 GB card" },
  { value: "32768", label: "32 GB card" },
  { value: "49152", label: "48 GB card" },
  { value: "65536", label: "64 GB card" },
];

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
const { qualityById, typeById, embeddingById, useLimitedById, descriptionById, refresh: refreshCatalogMeta } = useCatalogMeta();
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
const fitting = computed(() =>
  models.value
    .filter((m) => FIT_RUNNABLE.has(m.fit))
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
  return pickBestModel(models.value, {
    typeOf,
    qualityOf,
    isEmbed,
    isUseLimited: useLimitedOf,
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
    const vramQ = cardOverride.value === "auto" ? "" : `?vram_mb=${cardOverride.value}`;
    const [h, m] = await Promise.all([
      request("/v1/llm-runner/hardware"),
      request(`/v1/llm-runner/models${vramQ}`),
      refreshCatalogMeta(), // shared catalog-meta maps (quality / use-limited / description)
    ]);
    hw.value = h;
    models.value = m.models || [];
    detectedVramMb.value = (h.gpus && h.gpus[0]?.vramMb) || 0;
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
  await Promise.all([loadAll(), loadRouting()]);
  step.value = "confirm"; // confirm renders the empty-state when nothing fits
}
function onModalClose() {
  open.value = false;
}
async function onCardChange() {
  // Re-score Fit for the chosen card, then re-pick the default (clear it so prefill
  // runs; keep the embedding, which is card-independent).
  pick.value = { default: "", embeddingId: pick.value.embeddingId, embeddingModel: pick.value.embeddingModel };
  await loadAll();
}

// ── apply: one model → every task preset (non-clobber) + embedding + download/load ──
const applying = ref(false);
const applyDetail = ref("");
async function apply() {
  applying.value = true;
  error.value = "";
  step.value = "apply";
  try {
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

// ── Optimize for this PC (2026-07-06): the fire-and-forget consumer of the
// auto-tune job. Same server-side sweep the Tune modal drives, but with
// save:true — the winner is persisted as this machine's tune automatically
// (the QuickSetup audience won't open the Tune modal to review knobs; the
// measured delta is what turns "runs" into "runs fast": 8.6× TTFT on the
// reference box). Optional + skippable: it monopolizes the GPU for ~3–5 min;
// the job keeps running server-side if the wizard closes.
const optState = ref(null); // null (not started) | the GET payload
let optTimer = null;
const optRunning = computed(() => optState.value?.status === "running");

function stopOptPoll() {
  if (optTimer) { clearInterval(optTimer); optTimer = null; }
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
async function startOptimize() {
  try {
    const st = await request("/v1/llm-runner/auto-tune", {
      method: "POST",
      body: { modelId: pick.value.default, save: true },
    });
    if (st.ok === false) throw new Error(st.error || "Auto-tune is busy.");
    optState.value = st;
    stopOptPoll();
    optTimer = setInterval(pollOptimize, 2000);
  } catch (e) {
    optState.value = { status: "error", error: e.message || "Couldn't start optimizing." };
  }
}
onBeforeUnmount(stopOptPoll);

defineExpose({ openWizard });
</script>

<template>
  <div class="lu-qs">
    <!-- Trigger (replaces the old inline card; opens the wizard) -->
    <div class="lu-qs-head">
      <div>
        <b class="lu-qs-title">Quick Setup</b>
        <span class="lu-muted lu-qs-sub">Detect your hardware, pick the best free local model that fits, and set it as your default — all editable.</span>
      </div>
      <UiButton intent="primary" size="small" @click="openWizard">Run Quick Setup</UiButton>
    </div>

    <AppModal
      v-if="open"
      eyebrow="Local LLM"
      :title="step === 'detect' ? 'Probing your hardware…' : step === 'apply' ? 'Setting up…' : step === 'done' ? 'All set' : 'Recommended setup'"
      :max-width="'640px'"
      :closable="step !== 'apply'"
      @close="onModalClose"
    >
      <!-- DETECT -->
      <div v-if="step === 'detect'" class="lu-muted lu-qs-loading">Reading GPU + model catalog…</div>

      <!-- CONFIRM (editable) -->
      <template v-else-if="step === 'confirm'">
        <div v-if="error" class="lu-error">{{ error }}</div>

        <section class="lu-qs-sec">
          <div class="lu-qs-k">Detected</div>
          <div class="lu-qs-detected"><b>{{ hwLine }}</b></div>
        </section>

        <!-- The bundled runner: plan-for-card + the local default model (Fit-gated). -->
        <section class="lu-qs-sec">
          <div class="lu-qs-k">Plan for card</div>
          <UiSelect v-model="cardOverride" :options="CARD_OPTIONS" @update:model-value="onCardChange" />
          <p class="lu-muted lu-qs-hint">Re-scores Fit for another card — plan ahead, or force CPU-only.</p>
        </section>

        <div v-if="loading" class="lu-muted">Re-scoring…</div>
        <template v-else-if="fitting.length">
          <!-- The one good model — a single editable pick that runs every task. -->
          <section class="lu-qs-sec">
            <div class="lu-qs-k">
              Default model
              <span class="lu-fit lu-qs-fit" :class="`lu-fit--${fitOf(pick.default)}`">{{ FIT_LABEL[fitOf(pick.default)] }}</span>
            </div>
            <UiSelect v-model="pick.default" :options="modelOptions" />
            <p class="lu-muted lu-qs-hint">One good model runs every task — writing, chat, extraction, judgment. Per-task overrides live on the Tasks tab; this sets the shared default.</p>
            <p v-if="descriptionOf(pick.default)" class="lu-qs-why">
              <b>About this model:</b> {{ descriptionOf(pick.default) }}
            </p>
          </section>
        </template>
        <div v-else class="lu-muted lu-qs-empty">
          No catalog models fit this card. Pick a larger card above, or add a smaller model to the catalog.
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
            <li v-if="modelById[pick.default]"><b>{{ modelById[pick.default].name }}</b> <span class="lu-muted">— becomes the model for every task, except any you've changed yourself on the Tasks tab.</span></li>
            <li v-if="pick.default">It <b>downloads now</b> if it isn't already on disk, then loads as the active model.</li>
            <li v-if="pick.embeddingModel">Embedding set to <code>{{ embedName }}</code> — runs on the bundled runner, downloads on first search/index.</li>
            <li>Per-feature pins you've set stay as they are.</li>
          </ul>
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
             the optimize offer needs only a picked model. -->
        <div v-if="pick.default" class="lu-qs-opt">
          <template v-if="!optState">
            <UiButton intent="secondary" size="small" @click="startOptimize">Optimize for this PC (a few minutes)</UiButton>
            <span class="lu-muted">Optional: runs a short measured sweep and saves the fastest
              launch settings for this machine — often several times faster to first token.</span>
          </template>
          <template v-else-if="optRunning">
            <span class="lu-qs-opt-status">Optimizing — {{ optState.detail || "measuring…" }}
              <template v-if="optState.trials?.length"> ({{ optState.trials.length }} trial{{ optState.trials.length === 1 ? "" : "s" }} done)</template>
            </span>
            <span class="lu-muted">You can close this — it finishes in the background.</span>
          </template>
          <template v-else-if="optState.status === 'done' && optState.best">
            <span class="lu-qs-opt-ok">Optimized ✓ {{ optState.best.tokensPerSec }} tok/s —
              {{ optState.saved ? "saved for this machine." : "save failed — open Tune & measure to save it." }}</span>
          </template>
          <template v-else-if="optState.status === 'cancelled'">
            <span class="lu-muted">Optimize cancelled.</span>
            <UiButton intent="ghost" size="small" @click="startOptimize">Try again</UiButton>
          </template>
          <template v-else>
            <span class="lu-error">{{ optState.error || "Optimize failed." }}</span>
            <UiButton intent="ghost" size="small" @click="startOptimize">Try again</UiButton>
          </template>
        </div>

        <p class="lu-muted">Change the model for any single task on the Tasks tab.</p>
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
          <UiButton intent="primary" @click="onModalClose">Close</UiButton>
        </template>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.lu-qs { border: 1px solid var(--border); border-radius: var(--r-md, 10px); background: var(--surface); padding: 12px 16px; }
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
.lu-qs-applying { font-size: 13px; }
.lu-qs-summary { margin: 8px 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.lu-qs-opt { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; margin: 10px 0; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm, 8px); font-size: 12px; }
.lu-qs-opt-status { font-size: 12.5px; color: var(--ink-2); }
.lu-qs-opt-ok { font-size: 12.5px; color: var(--accent-ink, var(--accent)); font-weight: 600; }
.lu-qs-spacer { flex: 1; }
.lu-fit { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 10.5px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); flex: none; }
.lu-fit--ok { background: var(--accent-soft); border-color: var(--accent-line, var(--accent)); color: var(--accent-ink, var(--accent)); }
.lu-fit--tight { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }
.lu-fit--no { background: var(--danger-bg, #f7e7e4); border-color: var(--danger-line, var(--danger)); color: var(--danger); }
.lu-fit--cpu, .lu-fit--unknown { background: var(--surface-3); }
</style>
