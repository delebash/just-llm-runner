<script setup>
// SPDX-License-Identifier: MIT
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
// Apply (the one-source preset model — 2026-07-15): the chosen model is written onto every
// preset the features point at (/v1/ai/engine-presets) that still points at the PREVIOUS
// shared default — NON-CLOBBER: a preset the user re-pointed (Routing by feature) keeps its
// own model. Each preset keeps its settings (top_p / samplers / reasoning); only `.model`
// changes. The embedding is set via /v1/ai/routing; then the chosen model is downloaded
// (if needed) + loaded as the active one.
//
// JustWrite mounts this kit view; JustVoice has its own (TTS) setup wizard. It replaces the
// old jobs-based wiring (/v1/ai/jobs + a routing `jobs` map — both long retired).
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { request } from "../client.js";
import { useHardware } from "../composables/useHardware.js";
import { listClassTunes } from "../classTunes.js";
import { useCatalogMeta } from "../composables/useCatalogMeta.js";
import { recommendedModelId, pickBestEmbedId, FIT_GPU, FIT_RUNNABLE, FIT_LABEL } from "../common/services/modelPick.js";
import { applyPreview, modelHasTunes, setAsDefault, setAsEmbedding, LOCAL_RUNNER_ID } from "../services/modelApply.js";
import { confirmDialog } from "../common/services/dialog.js";
import { fmtTps } from "../common/services/runStats.js";
import { createDownloadTask, engineInstallChannel, modelDownloadChannel, modelLoadChannel } from "../composables/useDownloadTask.js";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiProgress from "../common/components/UiProgress.vue";
import AppModal from "../common/components/AppModal.vue";
import DownloadBar from "../common/components/DownloadBar.vue";

const emit = defineEmits(["changed", "closed"]);
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

// The box probe, SHARED (2026-07-27). `mainGpu` is the LARGEST GPU — the server's own
// rule (hardware.py:45); the two `gpus[0]` reads this file used to make scored the
// wizard against the iGPU on any laptop that enumerates it first.
const { hardwareInfo: hw, mainGpu, maxVramMb, refresh: refreshHardware } = useHardware();
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
const { classTuneRefs, myClassKey, qualityById, typeById, embeddingById, useLimitedById, descriptionById, minVramById, estVramById, tierById, refresh: refreshCatalogMeta } = useCatalogMeta();
function qualityOf(m) { return qualityById.value[m.id] ?? 100; }
function typeOf(m) { return typeById.value[m.id] || "dense"; }
function useLimitedOf(m) { return !!useLimitedById.value[m.id]; }
function descriptionOf(id) { return descriptionById.value[id] || ""; }
function minVramOf(m) { return minVramById.value[m.id] || 0; }
function tierOf(m) { return tierById.value[m.id] || "mid"; }
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
// Only the FITTING embed models — the editable embedding dropdown (design §3) still
// lists every raw-card-runnable embed: a bigger manual pick is a deliberate choice.
const fittingEmbeds = computed(() => models.value.filter((m) => isEmbed(m) && FIT_RUNNABLE.has(m.fit)));
const embedOptions = computed(() =>
  fittingEmbeds.value.map((m) => ({ value: m.id, label: `${m.name}${m.params ? ` · ${m.params}` : ""}` })),
);
// The DEFAULT embed pick (#274, the user's confirmed rule): the most capable embedding
// that fits what's LEFT of the card after the chat pick — the two co-reside, so the raw
// card is the wrong fit input (the 8GB/8B bug). CPU-band embeds always qualify (the
// ROUND-4 law — deliberately CPU on the user's own box). The rule lives ONCE in
// modelPick.js; the catalog's recommendedEmbedId calls the same function.
// The wizard's leftover baseline is the chat pick's CLAIM — est_vram (what it wants)
// over min_vram (its bare floor) — 2026-07-25, matching the loader's own
// `_embed_gpu_leftover_mb` semantics so the pick and the load can't disagree.
function wizardLeftoverMb() {
  const cardMb = maxVramMb.value;
  const claim = estVramById.value[pick.value.default] || minVramById.value[pick.value.default] || 0;
  return Math.max(0, cardMb - claim);
}
function bestEmbedId() {
  return pickBestEmbedId(models.value, { leftoverMb: wizardLeftoverMb(), qualityOf, isEmbed, minVramOf, tierOf });
}
function onEmbedChange() { pick.value.embeddingId = LOCAL_RUNNER_ID; } // all embed options are local
// Where the SELECTED embed will actually run beside the wizard's chat pick (the
// honest-placement line, 2026-07-25): same rule shape as the loader — CPU-tier
// never claims the GPU; others only when their floor fits the leftover.
const embedPlaceLine = computed(() => {
  const id = pick.value.embeddingModel;
  if (!id) return "";
  const cardMb = maxVramMb.value;
  const gpuOk = cardMb > 0 && tierById.value[id] !== "cpu"
    && (minVramById.value[id] || 0) > 0 && minVramById.value[id] <= wizardLeftoverMb();
  return gpuOk
    ? "It will run on your GPU alongside the writing model."
    : "It runs on the CPU on this PC — the GPU stays with your writing model.";
});

const embedName = computed(() => {
  const e = models.value.find((m) => m.id === pick.value.embeddingModel);
  return e?.name || pick.value.embeddingModel || "";
});

const hwLine = computed(() => {
  const h = hw.value;
  if (!h) return "";
  const g = mainGpu.value;
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
  // Delegates to the ONE composed rule in modelPick.js (a class CONFIG for this
  // box's class first — §9, 2026-07-22 — then the §10 speed-floor fallback); the
  // catalog's "Recommended for this PC" badge calls the same function, so the
  // wizard and the badge can never disagree.
  return recommendedModelId(fitting.value, {
    classTuneRefs: classTuneRefs.value,
    myClassKey: myClassKey.value,
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

// A friendly verdict headline (the LocalProse-comparison review, 2026-07-19): derived from
// the REAL fit of the picked model so it never overpromises — a full-GPU fit reads "the full
// setup", a tight offload says so. Empty when nothing fits (the no-GPU empty state owns that
// case). NOT a word-count/context claim: the honest figure is the EFFECTIVE ctx (tuned per
// box), which the wizard doesn't carry — the catalog's trained 256k would mislead.
const fitVerdict = computed(() => {
  if (!fitting.value.length || !pick.value.default) return "";
  const f = fitOf(pick.value.default);
  if (f === "ok") return "This machine runs the full local setup.";
  if (f === "tight") return "This machine runs the setup — a tight fit, but it works.";
  return "";
});
// Only surface the QAT "good to know" when the PICK is actually a QAT model (the description
// carries the "QAT" tag) — the ladder is QAT-first, but a non-QAT pick (Llama-70B, a MoE)
// must not get a false claim. Honest-truth rule (design-conformance §5).
const isQatPick = computed(() => /\bQAT\b/i.test(descriptionOf(pick.value.default) || ""));

// ── load hardware + catalog (optionally for an overridden card) ──────────────
async function loadAll() {
  loading.value = true;
  error.value = "";
  try {
    const [, m] = await Promise.all([
      refreshHardware(),
      request("/v1/llm-runner/models"),
      refreshCatalogMeta(), // shared catalog-meta maps (quality / use-limited / description)
    ]);
    models.value = m.models || [];
    prefillPick();
  } catch (e) {
    error.value = `Couldn't read hardware / catalog: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

// Pre-fill the chat default (the class-map/§10 pick). Never overwrites a value already
// set. The EMBED prefill deliberately does NOT happen here (#274 pass-3 find): openWizard's
// reconcile below can swap the chat default to the APPLIED model, and the embed pick now
// depends on the chat pick's leftover — so the embed fills only after the chat is final.
function prefillPick() {
  if (!pick.value.default) pick.value.default = bestFittingId();
}

// A routing-saved embedding is the user's choice and wins — openWizard's post-reconcile
// auto-fill only runs when routing carried none (or a dead reference).
async function loadRouting() {
  try {
    const r = await request("/v1/ai/routing");
    if (r.default?.embeddingId) pick.value.embeddingId = r.default.embeddingId;
    if (r.default?.embeddingModel) pick.value.embeddingModel = r.default.embeddingModel;
  } catch {
    /* routing may be empty on a fresh install — keep the pre-filled best-fit embed default */
  }
}

// Is the llama.cpp engine already installed on this box? Drives whether Apply shows the
// engine bar first (user, 2026-07-15: "if engine is not installed … first user interaction
// will be quick setup we need same type of progress bar cancel"). Fetched at openWizard.
const engineInstalled = ref(true); // assume present until the status fetch says otherwise
const engineNeeded = computed(() => !engineInstalled.value);
async function loadEngineStatus() {
  try {
    const es = await request("/v1/llm-runner/engine/status");
    engineInstalled.value = !!es.installed;
  } catch {
    engineInstalled.value = true; // unknown → don't show a spurious engine step
  }
}

// ── open / close ────────────────────────────────────────────────────────────
// The detect phase's own deadline (2026-07-26). It bounds the WHOLE load rather than
// each fetch, so it holds no matter which call stalls — including refreshCatalogMeta,
// which this file doesn't own. 20s is generous for a cold GPU probe on a slow box;
// past that the honest answer is an error the user can act on, not a spinner.
const DETECT_TIMEOUT_MS = 20000;

async function openWizard() {
  open.value = true;
  step.value = "detect";
  pick.value = { default: "", embeddingId: "", embeddingModel: "" };
  previewState.value = null;
  optState.value = null;
  tunedAlready.value = false;
  classTuned.value = false;
  optQuick.value = false;
  // THE SPINNER MUST ALWAYS END (2026-07-26 — reported stuck on "Probing your hardware…"
  // after a workspace reset). The step advance used to be this function's LAST statement,
  // so anything that threw in the reconcile below, or any request that never settled,
  // pinned the modal on `detect` forever — and silently, because the error banner only
  // renders once `confirm` is reached. Three guards, each closing one hole: the race
  // bounds a hang, the catch records WHY, and the finally guarantees the step advances
  // so whatever went wrong is actually readable. Every loader already swallows its own
  // rejection, so the catch here is for the reconcile and the deadline.
  try {
    await Promise.race([
      Promise.all([
        loadAll(),
        loadRouting(),
        loadEngineStatus(),
        // D4-1 (a)+(c): the change preview — computed by the SAME dominantOf the Apply
        // writer uses (modelApply.applyPreview), so the changelist can never drift.
        applyPreview().then((p) => { previewState.value = p; }).catch(() => { previewState.value = null; }),
      ]),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`the server didn't answer within ${Math.round(DETECT_TIMEOUT_MS / 1000)}s`)),
        DETECT_TIMEOUT_MS,
      )),
    ]);
    // Reconcile AFTER all resolve (order-safe — the catalog is loaded here):
    // 1. The wizard opens ON the applied setup (user, 2026-07-06: "if model is already
    //    applied then drop down should select that model") — the dropdown starts at the
    //    CURRENT default when it still exists in the catalog, so re-opening the wizard
    //    proposes NO change; the recommendation is only the fresh-box/fallback pick.
    // 2. Dead references never preselect (a deleted model must not be silently kept —
    //    the round-2 dangling-refs honesty): a routing embed pointing at a model no
    //    longer in the catalog falls back to the best fitting embed, or none.
    const dom = previewState.value?.dominant;
    if (dom && modelById.value[dom]) pick.value.default = dom;
    // 3. The embed default fills LAST, once the chat default above is FINAL (#274: the
    //    pick fits the card's leftover beside the chat model, so it must see the model
    //    that will actually run). A routing-saved embed that still exists is the user's
    //    choice and is kept; empty or dead → the leftover-aware best pick.
    if (pick.value.embeddingModel && !modelById.value[pick.value.embeddingModel]) {
      pick.value.embeddingId = "";
      pick.value.embeddingModel = "";
    }
    if (!pick.value.embeddingModel) {
      const best = bestEmbedId();
      if (best) {
        pick.value.embeddingId = LOCAL_RUNNER_ID;
        pick.value.embeddingModel = best;
      }
    }
  } catch (e) {
    // Don't overwrite a more specific message a loader already recorded.
    if (!error.value) error.value = `Couldn't finish reading your setup — ${e.message}`;
  } finally {
    step.value = "confirm"; // confirm renders the empty-state when nothing fits
  }
}
function onModalClose() {
  open.value = false;
}
// The host may want to route away when a deep-linked run ends (AiModelsArea
// re-emits this only for an auto-opened wizard). Watching `open` catches BOTH
// close paths — onModalClose and attemptClose — from one place.
watch(open, (v, prev) => { if (!v && prev) emit("closed"); });
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

// ── apply: one model → every preset (non-clobber) + embedding + download/load ──
// The runner's raw `detail` is engineer-speak ("model weights", "loading into VRAM").
// This audience gets plain language + a real progress bar with speed/ETA (user,
// 2026-07-15: "make the words more userfriendly"). The friendly phrasing moved to THE
// shared loadPhases.js (T3, 2026-07-17 — one vocabulary, every model surface; a JW
// source test pins that no local copy regrows here); imported at the top.

const applying = ref(false);

// ── the THREE download bars: engine · chat · embed (2026-07-15, the ONE-DOWNLOADER
// consolidation — user: "reuse the control … stop repeating code … if component exists to
// do this already use it instead of writing your own"). Each is the SHARED createDownloadTask
// over its server channel, rendered by the SHARED DownloadBar — ONE implementation, ONE bar,
// replacing the old hand-rolled chatBar/embedBar + runChat/runEmbed/cancel/retry copy. They
// run in parallel where they can: the embed rides its OWN download channel (needs no engine),
// so it fetches alongside the engine install; the chat LOAD needs the engine, so it waits for
// the engine task when one is running, then fires.
// The channels are THE shared factories (useDownloadTask.js, promoted 2026-07-18 —
// LuBookSearchSetup rides the same engine/download channels); the model channels take
// a thunk so each start reads the LIVE pick at call time (a re-apply may change it).
const engineTask = createDownloadTask(engineInstallChannel());
const chatTask = createDownloadTask(modelLoadChannel(() => pick.value.default));
const embedTask = createDownloadTask(modelDownloadChannel(() => pick.value.embeddingModel));

// Sequencing: the chat load is gated on the engine. When the engine install finishes, fire the
// load; when it's cancelled/errors, the chat can't proceed (no load attempt) — say so, pointing
// at the engine bar. A later successful engine retry re-fires the load automatically.
watch(() => engineTask.state, (s) => {
  if (step.value !== "apply") return;
  if (s === "done" && pick.value.default && chatTask.state !== "done") chatTask.start();
  else if (s === "cancelled") chatTask.fail("The engine install was cancelled — install it above, then this continues.");
  else if (s === "error") chatTask.fail("The engine didn't install — retry it above, then this continues.");
});
// The wizard advances only when the CHAT model is genuinely live; a successful chat retry
// advances too (the watch fires again). The embed never gates the step (it self-downloads on
// first search); its honest done-note rides the done step.
watch(() => chatTask.state, (s) => {
  if (s === "done" && step.value === "apply") finishApply();
});

// The completion tail — EXTRACTED so a Retry (via the chat watch) reaches it too. It records
// whether this box already has measured/class tunes for the chosen model (drives the done-step
// Optimize vs Re-optimize label + the "tuned for your hardware ✓" note), then advances to the
// done step. Guarded so a double-finish can't run it twice.
async function finishApply() {
  if (step.value === "done") return;
  const target = pick.value.default;
  tunedAlready.value = target ? await modelHasTunes(target) : false;
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
}

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
    // LOCAL runner concern (the RAG index) — only written when one is chosen.
    const target = pick.value.default;
    await setAsDefault(LOCAL_RUNNER_ID, target);
    if (pick.value.embeddingModel) await setAsEmbedding(pick.value.embeddingId, pick.value.embeddingModel);

    // Fresh run for the three bars.
    engineTask.reset();
    chatTask.reset();
    embedTask.reset();

    // The embed rides its OWN download channel (no engine needed — lifecycle.download states a
    // download can proceed while another model is loaded); fire it in PARALLEL, skipped when
    // already on disk. It never gates the step (it self-downloads on first search too).
    const needEmbed = !!pick.value.embeddingModel
      && !modelById.value[pick.value.embeddingModel]?.downloaded;
    if (needEmbed) embedTask.start();

    // The chat model needs the engine. Missing → install it FIRST (its own bar) and hold the
    // chat as "Waiting for the engine…"; the engine watch fires the load the moment it
    // finishes. Present → load immediately. Nothing to load (no fitting model) → straight to done.
    if (!target) {
      await finishApply();
    } else if (engineNeeded.value) {
      chatTask.waiting("Waiting for the engine…");
      engineTask.start();
    } else {
      chatTask.start();
    }
  } catch (e) {
    error.value = `Apply failed: ${e.message}`;
    step.value = "confirm";
  } finally {
    applying.value = false;
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
// The 2-minute pass (user: "both lab and 2 min sweep") — the SAME sweep with a
// server-side time box; the run stops with the best result so far. optQuick drives
// the honest copy (a capped pass phrases its running/done text differently).
const QUICK_TUNE_SECONDS = 120;
const optQuick = ref(false);
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

let optTimer = null;
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
      <!-- QC-42: the wizard is built-in-only — say so right of the button, bigger
           than the description, so nobody expects it to configure an online
           provider. Since 2026-07-19 this band sits at the top of the Local tab
           rather than inside the built-in provider's card, so these WORDS are the
           only thing carrying the scope — hence naming llama.cpp outright. -->
      <span class="lu-qs-barefor">Sets up the built-in llama.cpp provider only</span>
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
      :closable="!optRunning && engineTask.state !== 'running' && chatTask.state !== 'running' && embedTask.state !== 'running'"
      @close="onModalClose"
    >
      <!-- DETECT -->
      <div v-if="step === 'detect'" class="lu-muted lu-qs-loading">Reading GPU + model catalog…</div>

      <!-- CONFIRM (editable) -->
      <template v-else-if="step === 'confirm'">
        <div v-if="error" class="lu-error">{{ error }}</div>

        <p v-if="fitVerdict" class="lu-qs-verdict">{{ fitVerdict }}</p>
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
            <p class="lu-muted lu-qs-hint">One good model runs every feature — writing, chat, extraction, judgment. Per-feature choices live under Routing by feature; this sets the shared default.</p>
            <p v-if="descriptionOf(pick.default)" class="lu-qs-why">
              <b>About this model:</b> {{ descriptionOf(pick.default) }}
            </p>
          </section>
          <p v-if="isQatPick" class="lu-qs-goodtoknow">
            <b>Good to know:</b> these are QAT (quantization-aware trained) models — about
            3–4× lighter on memory than full precision while keeping close to the original
            quality. That's how a capable model fits your card.
          </p>
        </template>
        <div v-else class="lu-qs-empty">
          No local model can run well on this machine — generating on the CPU alone is too slow
          for writing. You can still use every AI feature by connecting an <b>online provider</b>
          below: your work stays on your disk, and only the text a feature needs is sent. Local
          search still runs on your CPU.
        </div>

        <!-- The embedding — always LOCAL (the RAG index). Hidden when no chat model fits:
             that state routes OUT to an online provider (no local Apply happens), so the
             local embed picker + the Apply changelist below would be contradictory UI. -->
        <section v-if="fitting.length && embedOptions.length" class="lu-qs-sec">
          <div class="lu-qs-k">Embedding</div>
          <UiSelect v-model="pick.embeddingModel" :options="embedOptions" @update:model-value="onEmbedChange" />
          <p class="lu-muted lu-qs-hint">Powers semantic search + grounded chat. {{ embedPlaceLine || "Runs on the bundled runner alongside your chat model; a smaller embed is fine." }}</p>
        </section>

        <!-- What will happen on Apply. -->
        <section v-if="fitting.length" class="lu-qs-sec lu-qs-routing">
          <div class="lu-qs-k">What happens when you click Apply</div>
          <ul class="lu-qs-rlist">
            <li v-if="modelById[pick.default]"><b>{{ modelById[pick.default].name }}</b> <span class="lu-muted">— becomes the model for every preset, except any you've changed yourself under Routing by feature.</span></li>
            <li v-if="pick.default">It <b>downloads now</b> if it isn't already on disk, then loads as the active model.</li>
            <li v-if="pick.embeddingModel">Search model set to <code>{{ embedName }}</code> — it <b>downloads now</b> too (it powers search + Ask the book) and runs alongside your main model.</li>
          </ul>
        </section>

        <!-- D4-1 (a)+(c): a box that's already configured (mixed task models, or measured
             tunes for a current model) sees EXACTLY which tasks Apply will change before
             anything writes — the lists come from the SAME dominant-model logic the Apply
             writer uses. A fresh box renders nothing here and stays one-click. -->
        <section v-if="fitting.length && previewState?.configured" class="lu-qs-sec lu-qs-changes">
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
        <p class="lu-qs-applying">
          {{ engineTask.state
            ? "Setting up your models — installing the engine first, then your model."
            : "Setting up your models — both download at once." }}
        </p>

        <!-- ONE bar per download (the SHARED DownloadBar over the SHARED createDownloadTask):
             the engine (only when it isn't installed yet), the chat model, and the search
             model. Each carries its own Cancel / Retry. -->
        <DownloadBar v-if="engineTask.state" title="The engine" role="the program that runs models" :task="engineTask" />
        <DownloadBar v-if="chatTask.state" :title="modelById[pick.default]?.name || pick.default" role="writes + chats" :task="chatTask" />
        <DownloadBar v-if="embedTask.state" :title="embedName" role="powers search + Ask the book" :task="embedTask" />

        <p class="lu-muted lu-qs-applynote">
          A model is several gigabytes, so a first run can take a few minutes — each only
          downloads once. Cancel stops a download; Retry starts it again.
        </p>
      </template>

      <!-- DONE -->
      <template v-else-if="step === 'done'">
        <p><b>Setup applied.</b></p>
        <ul class="lu-qs-summary">
          <li>Default model · <code>{{ modelById[pick.default]?.name || pick.default }}</code></li>
          <li v-if="pick.embeddingModel">Embedding · <code>{{ embedName }}</code></li>
        </ul>
        <p v-if="embedTask.state && embedTask.state !== 'done'" class="lu-muted lu-qs-applynote">
          The search model didn't finish downloading — it downloads itself on your first
          search, or you can grab it any time from the model catalog.
        </p>

        <!-- C8 integration: the wizard is local-only, so the old `isBundled` guard is gone —
             the optimize offer needs only a picked model. EXPLICIT-ONLY (2026-07-07): Apply
             never auto-starts the sweep; an untuned machine gets "Optimize for this PC", a
             tuned machine gets Re-optimize behind an explicit overwrite confirm. -->
        <div v-if="pick.default" class="lu-qs-opt">
          <!-- The truth ladder (ROUND 8 Task B remainder): own measured tune >
               a matching hardware-class tune > the engine's computed fit. The
               wholly-untuned branch offers BOTH the 2-minute pass and the
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
                <UiButton intent="secondary" size="small" @click="startOptimize(QUICK_TUNE_SECONDS)">2-minute optimize</UiButton>
                <UiButton intent="secondary" size="small" @click="startOptimize()">Full optimize</UiButton>
              </div>
              <span class="lu-muted">The 2-minute pass tries the most likely settings and keeps the best; Full keeps measuring (10 minutes or more) and is often several times faster to first token. Both are the same measured sweep as the model's Tune &amp; measure, with the winner saved automatically. Other AI features pause while a sweep runs.</span>
            </template>
          </template>
          <template v-else-if="optRunning">
            <div class="lu-qs-opt-run">
              <div class="lu-qs-opt-line">
                <b class="lu-qs-opt-title">{{ optQuick ? "2-minute optimize — measuring…" : "Optimizing for this PC…" }}</b>
                <span class="lu-qs-opt-elapsed">{{ optElapsedLabel }} elapsed</span>
              </div>
              <UiProgress :label="optRunLabel" />
              <p class="lu-muted lu-qs-opt-eta">
                <template v-if="optQuick">This pass is time-boxed to about 2 minutes — it
                  tries the most likely settings and keeps the best one found. Your GPU is busy
                  while it runs, so other AI features pause until it finishes or you stop it.</template>
                <template v-else>This runs a sequence of load-and-measure trials and can take 10
                  minutes or more — longer for larger models. Your GPU is busy while it runs, so
                  other AI features pause until it finishes or you stop it.</template>
              </p>
              <ul v-if="optTrialsDone.length" class="lu-qs-opt-trials">
                <li v-for="(t, i) in optTrialsDone" :key="i" :class="{ 'is-fail': !t.ok }">
                  <span class="lu-qs-opt-tl">{{ t.label }}</span>
                  <span v-if="t.ok" class="lu-qs-opt-tv">{{ fmtTps(t.tokensPerSec) }}</span>
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
            <!-- Self-diagnosing 2-minute pass (ROUND 8): a capped run that saved nothing
                 routes the user deeper (the full sweep / the Tune dialog) instead of
                 reading like a verdict — 2 minutes is a probe, not proof. -->
            <span class="lu-qs-opt-ok">Optimized ✓ {{ fmtTps(optState.best.tokensPerSec) }} —
              {{ optState.saved
                ? "saved for this machine."
                : (optState.best.label === "baseline"
                    ? (optQuick
                        ? "the 2-minute pass found nothing faster — Full optimize or the model's Tune dialog can search deeper."
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
          <!-- Nothing fits locally: the primary action routes OUT to the provider list (this
               wizard sits inside the Providers & models tab, so closing lands there). C8 holds
               — no provider-connect INSIDE the wizard; it just hands off. -->
          <UiButton v-if="!fitting.length" intent="primary" @click="onModalClose">Set up an online provider</UiButton>
          <UiButton v-else intent="primary" :disabled="applyDisabled" :loading="applying" @click="apply">
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
.lu-qs-empty { font-size: 12.5px; line-height: 1.55; padding: 8px 0; color: var(--ink-2); }
.lu-qs-empty b { color: var(--ink); }
.lu-qs-req { font-size: 12px; margin: 0 0 12px; }
.lu-qs-verdict { font-size: 15px; font-weight: 700; color: var(--ink); margin: 0 0 10px; }
.lu-qs-goodtoknow { font-size: 12px; line-height: 1.5; margin: 14px 0 0; padding: 8px 10px; background: var(--surface-2); border-radius: 6px; color: var(--ink-2); }
.lu-qs-goodtoknow b { color: var(--ink); }
.lu-qs-applying { font-size: 13px; }
.lu-qs-applynote { font-size: 11.5px; margin-top: 8px; }
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
