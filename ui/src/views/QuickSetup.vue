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
import { computed, ref } from "vue";

import { request } from "../client.js";
import { useCatalogMeta } from "../common/composables/useCatalogMeta.js";
import { detectLocal, createProvider, listModels, PROVIDER_PRESETS } from "../common/composables/useProviderConnect.js";
import { pickBestModel, pickLowestQuality, FIT_RUNNABLE, FIT_LABEL } from "../common/services/modelPick.js";
import { setAsDefault, setAsEmbedding, LOCAL_RUNNER_ID } from "../common/services/modelApply.js";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiInput from "../common/components/UiInput.vue";
import UiChip from "../common/components/UiChip.vue";
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

// ── "Run models with": the bundled runner (local) OR a connected provider (Ollama / LM
// Studio / cloud). Default = the bundled runner (LOCAL_RUNNER_ID). When an external provider
// is chosen, its model list comes from GET /v1/llm-providers/{id}/models (the registered
// adapter's STORED key, via listModels — probeModels can't see a saved cloud key), Apply
// flips the presets to (providerId, model), and the runner download/load is skipped (the
// provider serves itself).
const runWith = ref(LOCAL_RUNNER_ID);
const providers = ref([]);            // all registered providers (GET /v1/llm-providers)
const providerModels = ref([]);       // the chosen external provider's model ids
const providerModel = ref("");        // the chosen external model
const providerModelsError = ref("");  // a failed /models listing (bad key / provider down) — surfaced, never silent
// Connect-a-provider flow (the in-wizard front door — detected-local one-click + cloud key).
const connectOpen = ref(false);
const detected = ref([]);             // detectLocal() → local servers found on this box
const cloudChip = ref(null);          // the picked cloud PROVIDER_PRESETS row awaiting a key
const cloudKey = ref("");
const connecting = ref(false);
const connectError = ref("");

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

// ── "Run models with" derived ────────────────────────────────────────────────
const isBundled = computed(() => runWith.value === LOCAL_RUNNER_ID);
const selectedProvider = computed(() => providers.value.find((p) => p.id === runWith.value) || null);
// Reachable = registered AND (local OR has a key). A keyless cloud provider is hidden (it
// would 501 on use / 404 on /models); the bundled runner is excluded — it's the "Bundled
// runner" option itself.
const reachableProviders = computed(() =>
  providers.value.filter((p) => p.id !== LOCAL_RUNNER_ID && p.registered && (p.local || p.hasApiKey)),
);
const runWithOptions = computed(() => [
  { value: LOCAL_RUNNER_ID, label: "Bundled runner (recommended)" },
  ...reachableProviders.value.map((p) => ({ value: p.id, label: p.name })),
]);
const providerModelOptions = computed(() => providerModels.value.map((m) => ({ value: m, label: m })));
// Cloud presets (PROVIDER_PRESETS rows are [label, url, type, isLocal]) → the connect chips.
const cloudPresets = computed(() => PROVIDER_PRESETS.filter((p) => p[3] === false));
const detectedUnregistered = computed(() => detected.value.filter((d) => !d.alreadyRegistered));
// Apply is enabled once there's something to set: a fitting local pick (bundled) or a chosen
// external model. A bundled box with nothing that fits stays disabled; an external one never
// depends on local Fit.
const applyDisabled = computed(() =>
  isBundled.value ? !fitting.value.length || !pick.value.default : !providerModel.value,
);

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

// ── providers + connect ──────────────────────────────────────────────────────
async function loadProviders() {
  try {
    providers.value = (await request("/v1/llm-providers")).providers || [];
  } catch {
    providers.value = [];
  }
}
// List the chosen external provider's models (registered adapter, stored key). SURFACES a
// listing error (bad key / provider down) instead of a silent blank dropdown, and defaults
// the model to the provider's saved defaultModel when present, else the first listed.
async function loadProviderModels(id) {
  providerModelsError.value = "";
  providerModels.value = [];
  providerModel.value = "";
  try {
    const r = await listModels(id);
    providerModels.value = r.models || [];
    providerModelsError.value = r.error || "";
    const def = selectedProvider.value?.defaultModel || "";
    providerModel.value = def && providerModels.value.includes(def) ? def : providerModels.value[0] || "";
  } catch (e) {
    providerModelsError.value = e.message || "Couldn't list this provider's models.";
  }
}
function onRunWithChange() {
  if (isBundled.value) {
    providerModels.value = [];
    providerModel.value = "";
    providerModelsError.value = "";
  } else {
    loadProviderModels(runWith.value);
  }
}
async function openConnect() {
  connectOpen.value = true;
  connectError.value = "";
  cloudChip.value = null;
  cloudKey.value = "";
  detected.value = await detectLocal();
}
function pickCloudChip(p) {
  cloudChip.value = p;
  cloudKey.value = "";
  connectError.value = "";
}
// Register a provider, then point "Run models with" at it + list its models. A create OR
// listing failure surfaces in connectError (T5 — never a silent no-op). Shared by the
// detected-local (no key) and cloud (with key) connect paths.
async function connectProvider(body) {
  connecting.value = true;
  connectError.value = "";
  try {
    const created = await createProvider(body);
    await loadProviders();
    runWith.value = created.id;
    connectOpen.value = false;
    cloudChip.value = null;
    cloudKey.value = "";
    await loadProviderModels(created.id);
  } catch (e) {
    connectError.value = e.message || "Couldn't connect that provider.";
  } finally {
    connecting.value = false;
  }
}
function connectDetected(d) {
  return connectProvider({
    name: d.name,
    providerType: d.providerType,
    baseUrl: d.baseUrl,
    local: true,
    defaultModel: (d.models && d.models[0]) || "",
  });
}
function connectCloud() {
  if (!cloudChip.value) return;
  const p = cloudChip.value; // [label, url, type, isLocal]
  return connectProvider({ name: p[0], providerType: p[2], baseUrl: p[1], local: false, apiKey: cloudKey.value || null });
}

// ── open / close ────────────────────────────────────────────────────────────
async function openWizard() {
  open.value = true;
  step.value = "detect";
  pick.value = { default: "", embeddingId: "", embeddingModel: "" };
  // Reset "Run models with" + connect state so a reopen after an external Apply doesn't
  // strand a stale provider selection with an empty model list (verify-gate T5).
  runWith.value = LOCAL_RUNNER_ID;
  providerModels.value = [];
  providerModel.value = "";
  providerModelsError.value = "";
  connectOpen.value = false;
  detected.value = [];
  cloudChip.value = null;
  cloudKey.value = "";
  connectError.value = "";
  // Providers are card-independent — loaded ONCE here, not in loadAll (which re-runs on a
  // card change).
  await Promise.all([loadAll(), loadRouting(), loadProviders()]);
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
    // The chosen chat default: the bundled runner's LOCAL model, or the EXTERNAL provider's
    // model. BOTH go through the shared modelApply.setAsDefault (provider-aware, 3b-ii-a) —
    // the SAME writer the catalog's Set-as-default uses, so the surfaces never drift: it
    // writes `{...p, providerId, model}` onto every task preset that still shares the previous
    // default (non-clobber; each preset keeps its per-task settings). The embedding stays a
    // LOCAL runner concern (the RAG index), keeping the user's saved provider — only written
    // when one is chosen (no clobber of a saved embed with a blank).
    if (isBundled.value) {
      const target = pick.value.default;
      await setAsDefault(LOCAL_RUNNER_ID, target);
      if (pick.value.embeddingModel) await setAsEmbedding(pick.value.embeddingId, pick.value.embeddingModel);
      // Download (if needed) + load the chosen model as the active one, polling status so the
      // user sees progress. The embedding downloads on first search/index.
      if (target) {
        await request("/v1/llm-runner/load", { method: "POST", body: { modelId: target } });
        await pollLoad();
      }
    } else {
      // External provider: flip every shared-default preset to (providerId, model). No runner
      // download/load — the provider serves the model itself.
      await setAsDefault(runWith.value, providerModel.value);
      if (pick.value.embeddingModel) await setAsEmbedding(pick.value.embeddingId, pick.value.embeddingModel);
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

        <!-- Run models with: the bundled runner, or a connected provider (Ollama / LM Studio / cloud). -->
        <section class="lu-qs-sec">
          <div class="lu-qs-k">Run models with</div>
          <UiSelect v-model="runWith" :options="runWithOptions" @update:model-value="onRunWithChange" />
          <p class="lu-muted lu-qs-hint">Run models on this machine with the bundled runner, or point every task at a provider you connect — Ollama, LM Studio, or a cloud API.</p>
          <div class="lu-qs-connect">
            <UiButton v-if="!connectOpen" intent="ghost" size="small" @click="openConnect">+ Connect a provider</UiButton>
            <div v-else class="lu-qs-connectbox">
              <template v-if="detectedUnregistered.length">
                <div class="lu-qs-subk">Detected on this machine</div>
                <div v-for="d in detectedUnregistered" :key="d.baseUrl" class="lu-qs-drow">
                  <span><b>{{ d.name }}</b> <span class="lu-muted">{{ d.baseUrl }}</span></span>
                  <UiButton intent="secondary" size="small" :loading="connecting" @click="connectDetected(d)">Connect</UiButton>
                </div>
              </template>
              <div class="lu-qs-subk">Connect a cloud provider</div>
              <div class="lu-qs-chips">
                <UiChip v-for="p in cloudPresets" :key="p[0]" :selected="cloudChip?.[0] === p[0]" @click="pickCloudChip(p)">{{ p[0] }}</UiChip>
              </div>
              <div v-if="cloudChip" class="lu-qs-cloudkey">
                <UiInput v-model="cloudKey" type="password" :placeholder="`${cloudChip[0]} API key`" />
                <UiButton intent="primary" size="small" :loading="connecting" :disabled="!cloudKey" @click="connectCloud">Connect</UiButton>
              </div>
              <div v-if="connectError" class="lu-error">{{ connectError }}</div>
              <div><UiButton intent="ghost" size="small" @click="connectOpen = false">Done</UiButton></div>
            </div>
          </div>
        </section>

        <!-- BUNDLED runner: plan-for-card + the local default model (Fit-gated). -->
        <template v-if="isBundled">
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
            No catalog models fit this card. Pick a larger card above, add a smaller model, or connect a provider above.
          </div>
        </template>

        <!-- EXTERNAL provider: pick the model it will serve. -->
        <section v-else class="lu-qs-sec">
          <div class="lu-qs-k">Model</div>
          <UiSelect v-if="providerModelOptions.length" v-model="providerModel" :options="providerModelOptions" />
          <p v-if="providerModelsError" class="lu-error">{{ providerModelsError }}</p>
          <p v-else-if="!providerModelOptions.length" class="lu-muted lu-qs-hint">No models found for this provider.</p>
          <p class="lu-muted lu-qs-hint">{{ selectedProvider ? selectedProvider.name : "This provider" }} serves the model — the bundled runner won't download anything.</p>
        </section>

        <!-- The embedding — always LOCAL (the RAG index); shown for both the bundled + external paths. -->
        <section v-if="embedOptions.length" class="lu-qs-sec">
          <div class="lu-qs-k">Embedding</div>
          <UiSelect v-model="pick.embeddingModel" :options="embedOptions" @update:model-value="onEmbedChange" />
          <p class="lu-muted lu-qs-hint">Powers semantic search + grounded chat. Runs on the bundled runner<template v-if="isBundled"> alongside your chat model</template>; a smaller embed is fine.</p>
        </section>

        <!-- What will happen on Apply (branches bundled vs external). -->
        <section class="lu-qs-sec lu-qs-routing">
          <div class="lu-qs-k">What happens when you click Apply</div>
          <ul class="lu-qs-rlist">
            <template v-if="isBundled">
              <li v-if="modelById[pick.default]"><b>{{ modelById[pick.default].name }}</b> <span class="lu-muted">— becomes the model for every task, except any you've changed yourself on the Tasks tab.</span></li>
              <li v-if="pick.default">It <b>downloads now</b> if it isn't already on disk, then loads as the active model.</li>
            </template>
            <template v-else>
              <li v-if="providerModel"><b>{{ selectedProvider ? selectedProvider.name : runWith }} · {{ providerModel }}</b> <span class="lu-muted">— becomes the model for every task, except any you've changed yourself on the Tasks tab.</span></li>
              <li>The provider serves it — <b>nothing downloads</b> to this machine.</li>
            </template>
            <li v-if="pick.embeddingModel">Embedding set to <code>{{ embedName }}</code> — runs on the bundled runner, downloads on first search/index.</li>
            <li>Per-feature pins you've set stay as they are.</li>
          </ul>
        </section>
      </template>

      <!-- APPLY -->
      <template v-else-if="step === 'apply'">
        <p v-if="isBundled" class="lu-qs-applying">Setting your default model and loading <b>{{ modelById[pick.default]?.name || pick.default }}</b>…</p>
        <p v-else class="lu-qs-applying">Setting <b>{{ (selectedProvider ? selectedProvider.name : runWith) }} · {{ providerModel }}</b> as your default…</p>
        <p class="lu-muted">{{ applyDetail || "working…" }}</p>
      </template>

      <!-- DONE -->
      <template v-else-if="step === 'done'">
        <p><b>Setup applied.</b></p>
        <ul class="lu-qs-summary">
          <li v-if="isBundled">Default model · <code>{{ modelById[pick.default]?.name || pick.default }}</code></li>
          <li v-else>Default · <code>{{ (selectedProvider ? selectedProvider.name : runWith) }} · {{ providerModel }}</code></li>
          <li v-if="pick.embeddingModel">Embedding · <code>{{ embedName }}</code></li>
        </ul>
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
/* Connect-a-provider flow (in-wizard) */
.lu-qs-connect { margin-top: 8px; }
.lu-qs-connectbox { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; margin-top: 6px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; }
.lu-qs-subk { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 700; }
.lu-qs-drow { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; }
.lu-qs-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.lu-qs-cloudkey { display: flex; gap: 8px; align-items: center; }
.lu-qs-cloudkey > :first-child { flex: 1; min-width: 0; }
.lu-qs-applying { font-size: 13px; }
.lu-qs-summary { margin: 8px 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.lu-qs-spacer { flex: 1; }
.lu-fit { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 10.5px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); flex: none; }
.lu-fit--ok { background: var(--accent-soft); border-color: var(--accent-line, var(--accent)); color: var(--accent-ink, var(--accent)); }
.lu-fit--tight { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }
.lu-fit--no { background: var(--danger-bg, #f7e7e4); border-color: var(--danger-line, var(--danger)); color: var(--danger); }
.lu-fit--cpu, .lu-fit--unknown { background: var(--surface-3); }
</style>
