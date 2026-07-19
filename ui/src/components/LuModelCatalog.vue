<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The bundled-runner model catalog — mounted under Providers → Built-in (next to the
// Local engine panel). ONE fit-grouped list (fitting → divider → non-fitting) with
// search + sort + Add-your-own-GGUF. Each row shows a hardware Fit estimate +
// on-disk/loaded status with Download / Set-as-default / Set-as-embedding actions, and
// manages catalog rows (Add · Edit · Delete · Reset). The live model state + download
// progress are SHARED (useRunnerModels); per-model tuning is TuneMeasureModal.
//
// Scope: this catalog backs the BUNDLED runner only — the one provider with a manifest +
// VRAM-fit + HF-GGUF download/spawn lifecycle (/v1/llm-runner/*). Ollama / LM Studio
// manage their own models, so they keep the Fetch-models combobox instead of this table.
import { computed, ref } from "vue";

import { request } from "../client.js";
import { useRunnerModels } from "../composables/useRunnerModels.js";
import { useCatalogMeta } from "../composables/useCatalogMeta.js";
import { applyPreview, useModelApply } from "../services/modelApply.js";
import { FIT_RUNNABLE, pickBestEmbedId, pickLowestQuality, recommendedModelId } from "../common/services/modelPick.js";
import { TUNE_BADGES, fetchTuneState, tuneBadgeOf } from "../tuneState.js";
import AppModal from "../common/components/AppModal.vue";
import TuneMeasureModal from "./TuneMeasureModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiTag from "../common/components/UiTag.vue";
import UiProgress from "../common/components/UiProgress.vue";
import DownloadBar from "../common/components/DownloadBar.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { openExternal } from "../common/services/external.js";

// Shared runner-models state (models / status / load / progress) — one source for the
// grid + this list. Everything comes from the ONE singleton so the two surfaces never drift.
const {
  models, vramMb, loading, error, loadErr, loadingId,
  downloadingId, cancelling,
  needsEngine, fmtBytes, FIT_LABEL, refresh, download, cancelDownload, cancelLoad, taskFor,
} = useRunnerModels();
// (barFor is gone — T3: its channel choice lives in the shared taskFor adapter, the
// ONE per-model projection both the rows and the slot cards render from.)

// Search + sort + fit-grouping (design §4): ONE visible list — models that FIT the machine
// grouped first, the rest below — with a search box and a sort control (replaces the old
// installed-first "Your models / Browse catalog" toggle).
const query = ref("");
const sortBy = ref("quality");
// "Benchmark score", not "Quality" (user, 2026-07-06): quality_rank orders by PUBLISHED
// GENERAL-purpose benchmarks — it measures neither creative writing nor this machine.
// The honest per-box answer is the "Recommended for this PC" badge below.
const SORT_OPTIONS = [
  { value: "quality", label: "Sort: Benchmark score" },
  { value: "name", label: "Sort: Name" },
  { value: "size", label: "Sort: Size" },
];
function paramsNum(p) {
  const n = Number.parseFloat(String(p || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 999;
}
function matchesQuery(m) {
  const q = query.value.trim().toLowerCase();
  if (!q) return true;
  return (m.name || "").toLowerCase().includes(q) || (m.id || "").toLowerCase().includes(q);
}
function sortModels(list) {
  const by = sortBy.value;
  return [...list].sort((a, b) => {
    if (by === "name") return (a.name || "").localeCompare(b.name || "");
    if (by === "size") return paramsNum(b.params) - paramsNum(a.params); // largest first
    const qa = qualityOf(a); // quality (default): lower quality_rank = better, first
    const qb = qualityOf(b);
    if (qa !== qb) return qa - qb;
    return (a.name || "").localeCompare(b.name || "");
  });
}
const filtered = computed(() => models.value.filter(matchesQuery));
const hasAny = computed(() => filtered.value.length > 0);
// One render list, TWO sections (option C, user 2026-07-06): "Chat & writing models" then
// "Embedding models" — the app needs ONE of each, and embeds no longer interleave with chat
// models in the benchmark sort. Section-header + doesn't-fit-divider sentinels ride the same
// list so the row markup stays written ONCE. Non-fit placement (user, 2026-07-07: "the
// doesn't fit should be below the embed"): BOTH kinds' non-fitting models sink to ONE
// group at the very bottom, under the Embedding section, behind a single divider — the
// sections above show only what this machine can actually run.
const chatRows = computed(() => filtered.value.filter((m) => !embeddingOf(m)));
const embedRows = computed(() => filtered.value.filter((m) => embeddingOf(m)));
const groupedRows = computed(() => {
  const fits = (list) => sortModels(list.filter((m) => FIT_RUNNABLE.has(m.fit)));
  const rest = (list) => sortModels(list.filter((m) => !FIT_RUNNABLE.has(m.fit)));
  const rows = [];
  const chatFit = fits(chatRows.value);
  const embedFit = fits(embedRows.value);
  if (chatFit.length) {
    rows.push({ __section: "Chat & writing models", hint: "write prose, chat, extract — pick one as your General model", __key: "sec-chat" });
    rows.push(...chatFit);
  }
  if (embedFit.length) {
    rows.push({ __section: "Embedding models", hint: "power semantic search + grounded chat — pick one as your Embedding model", __key: "sec-embed" });
    rows.push(...embedFit);
  }
  const noFit = [...rest(chatRows.value), ...rest(embedRows.value)]; // chat first, then embeds
  if (noFit.length) {
    rows.push({ __divider: true, count: noFit.length, __key: "divider-nofit" });
    rows.push(...noFit);
  }
  return rows;
});

// Applied state (Default / Embedding badges) + the Set-as-default / Set-as-embedding writers —
// the shared modelApply service (also used by QuickSetup, so a badge tracks a QuickSetup Apply
// without a re-fetch).
const { currentDefaultId, currentEmbeddingId, refreshApplied, setAsDefault, setAsEmbedding, LOCAL_RUNNER_ID } = useModelApply();
const applyingId = ref(""); // model id whose Set-as-default / Set-as-embedding write is in flight
async function makeDefault(m) {
  applyingId.value = m.id;
  try {
    await setAsDefault(LOCAL_RUNNER_ID, m.id);
    // "LOAD as default" (user, 2026-07-07): the button loads the model too — before
    // the rename it only re-pointed the task presets and nothing entered VRAM until
    // first use. Fire-and-forget: the shared poller renders the row's loading→loaded.
    await request("/v1/llm-runner/load", { method: "POST", body: { modelId: m.id } });
    refresh();
  } catch (e) { error.value = e.message || "Couldn't set the default."; }
  finally { applyingId.value = ""; }
}
// The stop/unload wire call — ONE source (Unload's unloadModel + Re-download's unload-first
// both ride it, no duplicated fetch/body).
const stopModel = (m) => request("/v1/llm-runner/stop", { method: "POST", body: { modelId: m.id } });
// Unload (user, 2026-07-07: "no way to unload"): free a resident model's VRAM without
// loading something else. The router stays up; the model loads again on Load-as-default
// or on the next request that needs it.
async function unloadModel(m) {
  busy.value = `unload:${m.id}`;
  try {
    await stopModel(m);
    await refresh();
  } catch (e) { error.value = e.message || "Couldn't unload."; }
  finally { busy.value = ""; }
}
async function makeEmbedding(m) {
  applyingId.value = m.id;
  try {
    await setAsEmbedding(LOCAL_RUNNER_ID, m.id);
    // "Load as default" parity for embeds (user, 2026-07-07: "the embed … should have
    // same as regular model Load as default and unload"): loading rides the SANCTIONED
    // co-resident path — ensure-embedding downloads-if-needed + loads + PINS the embed
    // we just configured, alongside the chat model (a plain /load could contend with
    // the chat default for the primary slot; this endpoint exists for exactly this).
    await request("/v1/llm-runner/ensure-embedding", { method: "POST" });
    refresh();
  } catch (e) { error.value = e.message || "Couldn't set the embedding."; }
  finally { applyingId.value = ""; }
}
// The strip cards' Load — warm a model that's already the assigned default/embedding
// without re-writing the assignment (the row buttons assign AND load; a card with the
// slot already set only needs the load half). Same writers, same poller.
async function loadAssigned(m, isEmbed) {
  applyingId.value = m.id;
  try {
    if (isEmbed) await request("/v1/llm-runner/ensure-embedding", { method: "POST" });
    else await request("/v1/llm-runner/load", { method: "POST", body: { modelId: m.id } });
    refresh();
  } catch (e) { error.value = e.message || "Couldn't load."; }
  finally { applyingId.value = ""; }
}

const busy = ref(""); // CATALOG-op id in flight (delete) — distinct from the shared loadingId

// ── Fit + size display ─
const gb = (mb) => (mb >= 10240 ? `${Math.round(mb / 1024)}` : `${(mb / 1024).toFixed(1)}`);
function fitLabel(m) {
  return FIT_LABEL[m.fit] || "—";
}
function fitTitle(m) {
  if (m.fit === "cpu") return "No GPU detected — runs on CPU (slower).";
  if (m.fit === "unknown") return "VRAM requirement unknown for this model.";
  if (!m.minVramMb) return "";
  const have = vramMb.value ? ` · you have ${gb(vramMb.value)} GB` : "";
  return `needs ~${gb(m.minVramMb)} GB VRAM${have}`;
}
// Grid TYPE tags (Plan B — the Params column is REPLACED: the params count already
// rides the name/description, the user wants the space for architecture/role).
function typeOf(m) { return typeById.value[m.id] || "dense"; }
function mtpOf(m) { return mtpById.value[m.id] === true; }

// Model catalog meta (license / use-limited / description — the fit-shaped /models view
// doesn't carry them). Shared with QuickSetup through the useCatalogMeta singleton (one
// source, no drift); loadCatalogMeta (its refresh) re-pulls after a catalog edit.
const { qualityById, typeById, mtpById, embeddingById, licenseById, useLimitedById, descriptionById, poolingById, hfRepoById, notesById, sizeBytesById, minVramById, tierById, classPicks, refresh: loadCatalogMeta } = useCatalogMeta();
function licenseOf(m) { return licenseById.value[m.id] || ""; }
function descriptionOf(m) { return descriptionById.value[m.id] || ""; }
function notesOf(m) { return notesById.value[m.id] || ""; }
// The sort fields, VISIBLE on the rows (#146 — sorting by an invisible column is
// opaque): the benchmark rank (100 = unranked) + the size (file size when known,
// else the params label riding the fit view).
function rowMeta(m) {
  const bits = [];
  const q = qualityOf(m);
  bits.push(q >= 100 ? "unranked" : `rank ${q}`);
  const sz = sizeBytesById.value[m.id];
  if (sz) bits.push(fmtBytes(sz));
  else if (m.params) bits.push(m.params);
  return bits.join(" · ");
}
// The model's Hugging Face card URL (user, 2026-07-07: "open full detail in there web
// browser") — huggingface.co/<repo>; "" (no repo → no link) for hand-added local rows.
function cardUrlOf(m) { const repo = hfRepoById.value[m.id] || ""; return repo ? `https://huggingface.co/${repo}` : ""; }
function useLimitedOf(m) { return !!useLimitedById.value[m.id]; }
function poolingOf(m) { return poolingById.value[m.id] || ""; }
function qualityOf(m) { return qualityById.value[m.id] ?? 100; }
function embeddingOf(m) { return embeddingById.value[m.id] === true; }

// ── The "Your setup" strip (option C → the PAIR'S CONTROL PANEL, 2026-07-07) ──
// The strip states the two-slot requirement (one General model + one Embedding model)
// off the SAME shared applied state the row badges use (modelApply); the badge calls
// the SAME composed rule as QuickSetup (recommendedModelId, modelPick.js) — one source,
// so the wizard and the badge can never disagree about "best for this machine".
// 2026-07-07 (user took the recommendation): each card also shows the slot model's LIVE
// load state + its own Load/Unload — the one place a manual user sees that the app runs
// TWO models side by side and manages both. Same writers as the rows (no drift); the
// idle state reads calm ("loads on first use") because loading is automatic on first use.
const modelById = computed(() => Object.fromEntries(models.value.map((m) => [m.id, m])));
function nameOf(id) { const m = modelById.value[id]; return m ? m.name || m.id : id; }
const defaultName = computed(() => (currentDefaultId.value ? nameOf(currentDefaultId.value) : ""));
const embeddingName = computed(() => (currentEmbeddingId.value ? nameOf(currentEmbeddingId.value) : ""));
const defaultModel = computed(() => modelById.value[currentDefaultId.value] || null);
const embeddingModel = computed(() => modelById.value[currentEmbeddingId.value] || null);
// The slot's live state, folded to the card vocabulary. `null` = no model to show.
function slotState(m) {
  if (!m) return null;
  if (m.status === "loaded") return "loaded";
  if (m.status === "loading") return "working";
  if (m.status === "stopping") return "stopping"; // T2b: teardown/cancel resolving
  if (m.status === "error") return "error";
  if (m.status === "disk") return "idle";       // downloaded — loads on first use
  return "missing";                              // not downloaded yet
}
// Dead-reference honesty (round-2 item 3, validate-at-read): the applied id can point
// at a model that was DELETED from the catalog — say so instead of rendering the dead
// id as if it were fine (the user's repro: deleted all models, the UI still claimed a
// working setup). Loading (models empty) must not flash the warning.
const defaultGone = computed(() =>
  !loading.value && !!currentDefaultId.value && !modelById.value[currentDefaultId.value]);
const embeddingGone = computed(() =>
  !loading.value && !!currentEmbeddingId.value && !modelById.value[currentEmbeddingId.value]);
// TOTAL card VRAM — the SAME input QuickSetup feeds the shared rule. The checker
// caught the original version feeding useRunnerModels' vramMb, which is the
// budget-aware REMAINING VRAM (the /models endpoint subtracts the resident set) —
// with a model loaded, the badge could mark a SMALLER class than the wizard picks.
// One rule needs one input: both call sites read gpus[0].vramMb from /hardware.
const totalVramMb = ref(0);
request("/v1/llm-runner/hardware")
  .then((h) => { totalVramMb.value = (h?.gpus && h.gpus[0]?.vramMb) || 0; })
  .catch(() => {}); // no hardware read → 0 → the map yields "" and §10 decides
const recommendedId = computed(() => recommendedModelId(models.value, {
  classPicks: classPicks.value,
  vramMb: totalVramMb.value,
  byId: modelById.value,
  typeOf,
  qualityOf,
  isEmbed: embeddingOf,
  isUseLimited: useLimitedOf,
}));
// The recommended EMBEDDING (#5, 2026-07-08: "dont we recommend an embed model") —
// QuickSetup's exact pick, now through the ONE shared leftover-aware rule (#274:
// this was a drifted duplicate of the old raw-card sort). The chat side of the
// leftover is the model that will actually RUN beside the embed: the applied
// default while it's still in the catalog, else this card's own recommendation —
// the same applied-first precedence as the wizard's reconcile.
const recommendedEmbedId = computed(() => {
  const chatId = (currentDefaultId.value && modelById.value[currentDefaultId.value])
    ? currentDefaultId.value
    : recommendedId.value;
  const leftoverMb = Math.max(0, totalVramMb.value - (minVramById.value[chatId] ?? 0));
  return pickBestEmbedId(models.value, {
    leftoverMb,
    qualityOf,
    isEmbed: embeddingOf,
    minVramOf: (m) => minVramById.value[m.id] || 0,
    tierOf: (m) => tierById.value[m.id] || "mid",
  });
});
function licenseTitle(m) {
  const lic = licenseOf(m);
  return useLimitedOf(m)
    ? `${lic || "license"} — use-limited: not free for unrestricted/commercial use, never a default. The catalog only lists it; the weights download on your machine.`
    : (lic ? `${lic} — permissive (free to use).` : "license unknown");
}

// ── Tune & measure (#20) — the modal is shared (TuneMeasureModal), opened per model ─
const tuning = ref(null); // null | the model being tuned
// §7.6 (B3-4): the per-machine tune-provenance badges — ONE server-derived state
// (/v1/ai/model-tunes/state) + ONE shared wording map (tuneState.js) with the Tune
// modal's header tag. Refetched when the Tune modal closes (an Apply/Remove in it
// changes exactly this). Null = enrichment unavailable; rows render badge-less.
const tuneState = ref(null);
async function loadTuneState() {
  tuneState.value = await fetchTuneState();
}
loadTuneState();
function tuneBadge(m) {
  const id = tuneBadgeOf(tuneState.value, m.id);
  if (!id) return null; // untuned rows carry NO badge — absence reads untuned (flagged in the §7.6 record)
  const titles = {
    auto: "This PC runs your applied config — produced by the auto-tune sweep",
    hand: "This PC runs your applied config — hand-set in Tune & measure",
    class: "No applied config on this PC — it starts from the Hardware/model class default for your PC class",
  };
  return { ...TUNE_BADGES[id], title: titles[id] };
}
function closeTuneModal() {
  tuning.value = null;
  loadTuneState();
}

// ── manager: add / edit / delete a catalog model (#30) ─
// Backed by the EXISTING tested router /v1/ai/model-catalog (CRUD+reset). The catalog row
// carries the editable fields (hfRepo/quant/type/params); the /models view above is
// fit-shaped, so edit fetches the catalog row. `type` drives which switch preset applies.
const editing = ref(null); // null | a draft catalog row
const editingNew = ref(false);
const saving = ref(false);
const saveErr = ref("");
// Pre-download GGUF inspect (POST /model-catalog/inspect): fills the file-derived fields on
// the draft (type/mtp/trainedCtx, persisted on Save) + a read-only preview (samplers/size/
// est VRAM). `inspected` is the last preview; null before Read-from-link.
const inspecting = ref(false);
const inspectErr = ref("");
const inspected = ref(null);

const samplersLabel = computed(() => {
  const s = inspected.value?.samplers || editing.value?.samplers || {};
  // STABLE display order (#141 — inspect vs DB row rendered the same set in two
  // different orders): canonical-first, then alphabetical for the rest.
  const canon = ["temperature", "top_k", "top_p", "min_p"];
  const entries = Object.entries(s).sort(([a], [b]) => {
    const ia = canon.indexOf(a);
    const ib = canon.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(" · ") : "—";
});

// The MTP row's plain-language fact (2026-07-13): THREE states off the model's real
// arrangement, not the enable flag. Read from the PERSISTED row (editing.*) so the
// opened form reads identically to a live Read-from-link (which mutates editing.* in
// place); the header BUILT-IN truth takes the fresh inspect value when one is in hand.
// A separate-draft model no longer reads as a bare "no" — the whole point of the row.
const mtpFact = computed(() => {
  const e = editing.value || {};
  const builtin = inspected.value ? inspected.value.mtpBuiltin : e.mtpBuiltin;
  if (builtin) return "built-in — in-file prediction heads";
  // An external draft that ships in the model's OWN repo (no separate draft-repo).
  if (e.mtpDraftFile && !e.mtpDraftRepo) return "separate — external draft file (separate download)";
  // A draft from ANOTHER repo — the tier-C official family drafter (persisted as a
  // draft-repo), or one discovered live but not yet applied. Borrowed, not shipped.
  if ((e.mtpDraftFile && e.mtpDraftRepo) || inspected.value?.mtpInheritedFile)
    return "separate — borrows the base family's assistant draft (separate download)";
  return "not available";
});

// ── repo file listing (Plan B D9): the quant dropdown + MTP-draft detection ──
const listing = ref(null); // null | { quants, drafts } for editing.hfRepo
const listingErr = ref("");
const quantCustom = ref(false); // "Custom…" picked → free-type quant input

const quantOptions = computed(() => {
  const qs = listing.value?.quants || [];
  const opts = qs.map((q) => ({
    value: q.quant,
    label: `${q.quant} · ${gb(q.sizeMb)} GB${q.qat ? " · QAT" : ""}${q.kind === "IQ" ? " · IQ" : q.kind === "special" ? " · special" : ""}`,
  }));
  return [...opts, { value: "__custom", label: "Custom…" }];
});
const draftOptions = computed(() => [
  { value: "", label: "None" },
  ...(listing.value?.drafts || []).map((d) => ({
    value: d.path,
    label: `${d.path}${d.quant ? ` · ${d.quant}` : ""}${d.sizeMb ? ` · ${gb(d.sizeMb)} GB` : ""}`,
  })),
]);
async function loadRepoFiles({ autopick = true } = {}) {
  const e = editing.value;
  if (!e?.hfRepo?.trim()) return;
  listingErr.value = "";
  try {
    const params = new URLSearchParams({ repo: e.hfRepo.trim() });
    const r = await request(`/v1/ai/model-catalog/list-files?${params}`, { method: "POST" });
    listing.value = r;
    // free-typed quant not in the listing → stay in custom mode
    quantCustom.value = !!(e.quant && !r.quants.some((q) => q.quant === e.quant));
    // The pre-picks run only on an EXPLICIT Read-from-link (autopick) — the Edit-open
    // background listing must never mutate the draft: a user who deliberately cleared
    // the draft and saved would get it silently re-picked on every reopen.
    if (!autopick) return;
    // recommended-for-box default when no quant chosen yet (v1 heuristic: the
    // largest quant whose file size fits the detected VRAM; else the smallest —
    // size ≠ VRAM exactly, but it's an honest pre-pick the user can change).
    if (!e.quant && r.quants.length) {
      const fitting = vramMb.value ? r.quants.filter((q) => q.sizeMb <= vramMb.value) : [];
      e.quant = (fitting.length ? fitting[fitting.length - 1] : r.quants[0]).quant;
    }
    // detect pre-select (D9): a repo shipping an MTP draft pre-picks the SMALLEST
    // one when the model has none configured — a draft should be small/fast (the
    // user's measured gemma pick, Q4_0 @ 240MB, IS the smallest). "None" stays.
    if (r.drafts.length && !e.mtpDraftFile) {
      onDraftPick([...r.drafts].sort((a, b) => (a.sizeMb || 0) - (b.sizeMb || 0))[0].path);
    }
  } catch (err) {
    listing.value = null;
    listingErr.value = err.message || "Couldn't list the repo's files.";
  }
}
function onQuantPick(v) {
  if (v === "__custom") { quantCustom.value = true; return; }
  quantCustom.value = false;
  editing.value.quant = v;
  // The stored download size is QUANT-SPECIFIC (#141): a different quant makes it
  // stale — clear it; Read from link (or the next download) refreshes it live.
  editing.value.sizeBytes = null;
}
function onDraftPick(path) {
  const e = editing.value;
  e.mtpDraftFile = path || "";
  const d = (listing.value?.drafts || []).find((x) => x.path === path);
  e.mtpDraftQuant = d?.quant || "";
  // "Setting it … auto-enables MTP" (the form's own promise): a picked draft checks
  // MTP; clearing falls back to the header BUILT-IN truth from the last inspect (a
  // built-in-MTP model stays enabled with no draft; false if neither).
  e.mtp = path ? true : !!inspected.value?.mtpBuiltin;
}

async function inspectLink() {
  const e = editing.value;
  if (!e?.hfRepo?.trim()) { inspectErr.value = "Enter the Hugging Face repo first."; return; }
  inspecting.value = true; inspectErr.value = ""; inspected.value = null;
  try {
    // ONE click fills everything: the repo listing (quant options + draft
    // detect + a recommended quant when blank) THEN the header inspect, which
    // needs the chosen quant. Listing failure is non-fatal (free-type remains).
    await loadRepoFiles();
    const params = new URLSearchParams({ repo: e.hfRepo.trim(), quant: e.quant || "" });
    const r = await request(`/v1/ai/model-catalog/inspect?${params}`, { method: "POST" });
    // File-derived scalar facts flow into the draft (persisted by the Save PUT);
    // the sampler set persists from the local file at download (identify → set_derived).
    e.type = r.type || "dense";
    // MTP split (2026-07-13): identity reads the header BUILT-IN truth (`mtpBuiltin`),
    // never the enable flag — so the download read can no longer clobber the box.
    e.mtpBuiltin = !!r.mtpBuiltin;
    // Tier-C: no draft chosen but an OFFICIAL companion drafter was discovered → borrow
    // it (verified to resolve server-side) so a StyleTune-style model can run MTP too.
    if (!e.mtpDraftFile && r.mtpInheritedFile) {
      e.mtpDraftRepo = r.mtpInheritedRepo || "";
      e.mtpDraftFile = r.mtpInheritedFile || "";
      e.mtpDraftQuant = r.mtpInheritedQuant || "";
    }
    // Auto-CHECK on detect (user-agreed): MTP is on when the model is built-in capable
    // OR a draft (its own or the inherited one) is configured. The user can uncheck.
    e.mtp = !!r.mtpBuiltin || !!e.mtpDraftFile;
    e.trainedCtx = r.trainedCtx ?? null;
    if (r.totalParams) e.totalParams = r.totalParams; // file-derived (dense); MoE stays curated
    if (!e.minVramMb && r.estVramMb) e.minVramMb = r.estVramMb;
    // Identity facts persist on the row (#141 — Edit-open == Read-from-link):
    e.architecture = r.architecture || "";
    e.experts = r.experts || 0;
    e.sizeLabel = r.sizeLabel || "";
    e.sizeBytes = r.sizeBytes || null;
    // The VRAM estimate persists too (#141 parity — the "≈ N MB VRAM" line must show
    // in the opened form, not only right after a live read).
    e.estVramMb = r.estVramMb ?? null;
    inspected.value = {
      architecture: r.architecture || "", experts: r.experts || 0, sizeLabel: r.sizeLabel || "",
      samplers: r.samplers || {}, sizeBytes: r.sizeBytes || 0, estVramMb: r.estVramMb ?? null,
      mtpBuiltin: !!r.mtpBuiltin, // header truth — onDraftPick falls back to it on clear
      mtpInheritedRepo: r.mtpInheritedRepo || "", mtpInheritedFile: r.mtpInheritedFile || "",
    };
    // Description is FILE/LINK-OWNED (#143, user decree: "if user clicks read from
    // file all fields should be updated"): an explicit Read from link REGENERATES
    // it from the just-read facts. Personal text belongs in Notes below, which
    // this never touches.
    e.description = composedDescription();
    // The Name is model-owned the same way: Load-from-HF regenerates it from the
    // just-read repo + quant so it can't stay stale (it stays editable afterward).
    e.name = composedName();
  } catch (err) {
    inspectErr.value = err.message || "Couldn't read the model from the link.";
  } finally {
    inspecting.value = false;
  }
}

// The composed description mirrors the field's own placeholder register ("fast 9B for
// quick chat and drafts"): short " · "-joined facts, no sentence padding. Sources are
// the same facts inspectLink just wrote (params/type/ctx/MTP) + the listing's quant row
// (for QAT + file size); anything missing is simply skipped.
function composedDescription() {
  const e = editing.value;
  const bits = [];
  const params = (e.totalParams || e.sizeLabel || inspected.value?.sizeLabel || "").toString().trim();
  const kind = e.embedding ? "embedding model" : e.type === "moe" ? "mixture-of-experts model" : "model";
  bits.push(params ? `${params} ${kind}` : kind);
  if (e.trainedCtx) bits.push(`${Math.round(e.trainedCtx / 1024)}k context`);
  // Honest MTP phrasing: an external draft file vs built-in prediction layers. Keyed
  // to the MODEL's capability (a draft, or the header built-in), not the enable flag.
  if (e.mtpDraftFile) bits.push("MTP draft for faster generation");
  else if (e.mtpBuiltin) bits.push("MTP for faster generation");
  if (e.quant) {
    const q = (listing.value?.quants || []).find((x) => x.quant === e.quant);
    bits.push(`${e.quant}${q?.qat ? " (QAT)" : ""}`);
    if (q?.sizeMb) bits.push(`${gb(q.sizeMb)} GB`);
    else if (e.sizeBytes) bits.push(`${gb(e.sizeBytes / (1024 * 1024))} GB`);
  }
  return bits.join(" · ");
}

// The auto-name mirrors the field's placeholder ("Qwen3 14B · Q4_K_M"): the model's
// own name — the HF repo's last segment, minus the "-GGUF" packaging tag, dashes and
// underscores turned to spaces — plus the chosen quant. Regenerated by Load-from-HF
// alongside the description, so the Name always reflects the model that was loaded.
function composedName() {
  const e = editing.value;
  const base = ((e.hfRepo || "").trim().split("/").pop() || "")
    .replace(/[-_.]?gguf$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const model = base ? base.charAt(0).toUpperCase() + base.slice(1) : "";
  return [model, e.quant].filter(Boolean).join(" · ");
}

function blankModel() {
  return { id: "", name: "", hfRepo: "", quant: "", type: "dense", totalParams: "",
    activeParams: "", mtp: false, mtpBuiltin: false, mtpDraftRepo: "", mtpDraftFile: "", mtpDraftQuant: "",
    trainedCtx: null, samplers: {}, minVramMb: null, minRamMb: null,
    tier: "mid", license: "", useLimited: false, embedding: false, description: "", notes: "",
    architecture: "", experts: 0, sizeLabel: "", sizeBytes: null, estVramMb: null, qualityRank: 100, position: 0 };
}

// ── the slot cards' INLINE PICKERS (#144, extended by #5 2026-07-08: "leave the
// drop downs visible so you can change it will just unload and load" — the picker
// renders ALWAYS, showing the current assignment; changing it goes through the SAME
// assign+load writers as the rows, which swap the resident model. Use-limited
// models are pickable (a manual pick is deliberate, like the rows) but carry the
// ⚠ in their label; the recommended pick of each kind is tagged). ──
function slotOptions(kind /* false = chat, true = embed */, currentId) {
  const rec = kind ? recommendedEmbedId.value : recommendedId.value;
  const list = models.value.filter((m) => embeddingOf(m) === kind && FIT_RUNNABLE.has(m.fit));
  // The assigned model stays pickable even if it no longer fits (a shrunk box must
  // still SHOW the current assignment rather than a blank select).
  const cur = modelById.value[currentId];
  if (cur && !list.some((m) => m.id === cur.id) && embeddingOf(cur) === kind) list.push(cur);
  return list
    .sort((a, b) => qualityOf(a) - qualityOf(b))
    .map((m) => ({
      value: m.id,
      label: `${m.name || m.id}${useLimitedOf(m) ? " ⚠" : ""}${m.id === rec ? " · Recommended" : ""}`,
    }));
}
const chatSlotOptions = computed(() => slotOptions(false, currentDefaultId.value));
const embedSlotOptions = computed(() => slotOptions(true, currentEmbeddingId.value));
function pickSlot(id, isEmbed) {
  const m = modelById.value[id];
  if (!m) return;
  if (isEmbed) makeEmbedding(m);
  else makeDefault(m);
}
// Embed task templates (Move 0, RAG build): the per-model wrapper strings
// /v1/ai/embeddings applies ({text} slot; empty = pass-through). Loaded/saved
// via their own /v1/ai/embed-templates rows, shown only on embedding models.
const editingTpl = ref({ documentTemplate: "", queryTemplate: "" });
async function loadEditingTpl(modelId) {
  editingTpl.value = { documentTemplate: "", queryTemplate: "" };
  try {
    const res = await request("/v1/ai/embed-templates");
    const row = (res.rows || []).find((r) => r.modelId === modelId);
    if (row) editingTpl.value = { documentTemplate: row.documentTemplate || "", queryTemplate: row.queryTemplate || "" };
  } catch { /* form still opens; templates just read empty */ }
}
function startAdd() { editing.value = blankModel(); editingNew.value = true; saveErr.value = ""; inspected.value = null; inspectErr.value = ""; listing.value = null; listingErr.value = ""; quantCustom.value = false; editingTpl.value = { documentTemplate: "", queryTemplate: "" }; }
async function startEdit(m) {
  saveErr.value = ""; inspected.value = null; inspectErr.value = "";
  listing.value = null; listingErr.value = ""; quantCustom.value = false;
  try {
    const cat = await request("/v1/ai/model-catalog");
    const row = (cat.rows || []).find((r) => r.id === m.id) || { ...blankModel(), id: m.id, name: m.name };
    editing.value = { ...blankModel(), ...row };
    editingNew.value = false;
    if (row.embedding) loadEditingTpl(row.id);
    else editingTpl.value = { documentTemplate: "", queryTemplate: "" };
    // Auto-load the repo listing (ROUND-8 Task-D leftover, caught by the user's
    // screenshots: the seeded form opened with PLAIN text inputs where Read-from-link
    // shows dropdowns): fire-and-forget so Quant + Draft render as pickers with sizes
    // on open — no click needed; a failure just leaves the free-type inputs. The
    // pre-picks are disabled here (autopick:false) — the background load must never
    // mutate the row; only an explicit Read-from-link pre-picks quant/draft.
    loadRepoFiles({ autopick: false });
  } catch (e) {
    saveErr.value = e.message || "Couldn't load the model.";
    editing.value = { ...blankModel(), id: m.id, name: m.name }; editingNew.value = false;
  }
}
function cancelEdit() { editing.value = null; saveErr.value = ""; inspected.value = null; inspectErr.value = ""; listing.value = null; listingErr.value = ""; quantCustom.value = false; }

function slugFromName(name) {
  return (name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
async function saveModel() {
  const e = editing.value;
  if (editingNew.value && !e.id?.trim()) e.id = slugFromName(e.name);
  if (!e.id?.trim()) { saveErr.value = "A name (for the id) is required."; return; }
  saving.value = true; saveErr.value = "";
  try {
    await request("/v1/ai/model-catalog", {
      method: "PUT",
      body: { ...e, id: e.id.trim(), minVramMb: e.minVramMb || null, minRamMb: e.minRamMb || null, position: e.position || 0 },
    });
    // Embed task templates ride their own row (Move 0): save when an embedding
    // model has any side set; both sides cleared = drop the row (pass-through).
    if (e.embedding) {
      const tpl = editingTpl.value;
      if ((tpl.documentTemplate || "").trim() || (tpl.queryTemplate || "").trim()) {
        await request("/v1/ai/embed-templates", {
          method: "PUT",
          body: { modelId: e.id.trim(), documentTemplate: tpl.documentTemplate || "", queryTemplate: tpl.queryTemplate || "" },
        });
      } else {
        await request(`/v1/ai/embed-templates?modelId=${encodeURIComponent(e.id.trim())}`, { method: "DELETE" });
      }
    }
    editing.value = null;
    await refresh();
    loadCatalogMeta();
  } catch (err) {
    saveErr.value = err.message || "Save failed.";
  } finally {
    saving.value = false;
  }
}
async function deleteModel(m) {
  // Delete policy (a) — BLOCK-WITH-REPOINT (user, 2026-07-06). References are checked
  // live (task presets by model + the embedding slot). With a replacement available,
  // one click re-points and deletes. With NONE (the user's empty-case question):
  // presets have NO "none" state (their catch), so "Delete anyway" keeps the dead id
  // and the validate-at-read layer labels it "removed from the catalog" everywhere.
  let used = [];
  let fullRows = [];
  try {
    const [prev, pr] = await Promise.all([applyPreview(), request("/v1/ai/engine-presets")]);
    fullRows = pr.presets || [];
    used = (prev.presets || []).filter((p) => p.model === m.id);
  } catch { /* references unreadable → fall through to the plain confirm below */ }
  const embedRef = m.id === currentEmbeddingId.value;

  if (!used.length && !embedRef) {
    const ok = await confirmDialog({
      title: `Remove "${m.name || m.id}" from the catalog?`,
      message: "Removes the catalog entry and deletes its downloaded weights from disk. Reset restores the built-in entries; weights re-download on demand.",
      danger: true,
    });
    if (!ok) return;
    return _doDelete(m);
  }

  // A replacement of the SAME kind that fits this machine — the shared quality order picks.
  const kind = embeddingOf(m);
  const cands = models.value.filter((x) => x.id !== m.id && embeddingOf(x) === kind && FIT_RUNNABLE.has(x.fit));
  const repl = cands.some((c) => c.id === recommendedId.value) && !kind
    ? recommendedId.value
    : pickLowestQuality(cands, { qualityOf }) || "";
  const usedBits = [
    used.length ? `${used.length} task preset${used.length > 1 ? "s" : ""}` : "",
    embedRef ? "the embedding slot" : "",
  ].filter(Boolean).join(" and ");
  const ok = await confirmDialog({
    title: `Delete ${m.name || m.id}?`,
    message: repl
      ? `It's in use by ${usedBits}. They'll be re-pointed to ${nameOf(repl)}, then the entry is removed and its downloaded weights are deleted from disk.`
      : `It's in use by ${usedBits}, and no other ${kind ? "embedding" : "chat"} model is available to re-point to. Delete anyway and everything pointing at it will show "removed from the catalog" until you pick a replacement. Its downloaded weights are deleted from disk.`,
    confirmLabel: repl ? "Re-point & delete" : "Delete anyway",
    danger: true,
  });
  if (!ok) return;
  busy.value = `del:${m.id}`;
  try {
    if (repl) {
      for (const u of used) {
        const row = fullRows.find((r) => r.id === u.id);
        if (row) {
          await request(`/v1/ai/engine-presets/${encodeURIComponent(row.id)}`, {
            method: "PUT", body: { ...row, providerId: LOCAL_RUNNER_ID, model: repl },
          });
        }
      }
      if (embedRef) await setAsEmbedding(LOCAL_RUNNER_ID, repl);
    }
  } catch (e) {
    error.value = e.message || "Couldn't re-point the references — nothing was deleted.";
    busy.value = "";
    return;
  }
  return _doDelete(m);
}

async function _doDelete(m) {
  busy.value = `del:${m.id}`; // namespaced so Delete's spinner ≠ the row's load/download spinner
  try {
    // Delete the downloaded weights FIRST (the runner resolves the repo from the still-present
    // catalog row), then remove the catalog entry. Weights re-download on demand if re-added.
    await request("/v1/llm-runner/models-cache/delete", { method: "POST", body: { modelId: m.id } });
    await request(`/v1/ai/model-catalog?modelId=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    await refresh();
    loadCatalogMeta(); // keep the shared catalog-meta map in sync (like save/reset do)
    refreshApplied(); // the strip + badges re-read the (possibly re-pointed) applied state
  } catch (e) { error.value = e.message || "Delete failed."; } finally { busy.value = ""; }
}

// Re-download / repair a model WITHOUT touching its catalog entry (the corrupt-GGUF recovery,
// 2026-07-11). Clears the cached (possibly corrupt/incomplete) weights — models-cache/delete
// KEEPS the catalog row and is idempotent if the file's already gone — then re-fetches. This is
// the one-click follow-up the runner's "corrupted or incomplete" error tells the user to run;
// it's also the repair path for a merely-suspect download, no delete-and-re-add dance needed.
async function redownload(m) {
  busy.value = `redl:${m.id}`; // own namespace so its spinner ≠ Delete's / the row load spinner
  error.value = "";
  try {
    // A RESIDENT model's GGUF is memory-mapped by llama-server (locked on Windows) — deleting
    // the cache under the engine fails. Unload FIRST (same stop writer as the Unload button) so
    // the file is free to replace; on failure this throws → error surfaced, cache NOT deleted.
    // The model reloads on next use / Load as default.
    if (m.status === "loaded") await stopModel(m);
    await request("/v1/llm-runner/models-cache/delete", { method: "POST", body: { modelId: m.id } });
    await download(m.id); // re-fetch from Hugging Face (own progress channel + refresh)
  } catch (e) { error.value = e.message || "Re-download failed."; } finally { busy.value = ""; }
}
async function resetCatalog() {
  const ok = await confirmDialog({ title: "Reset the model catalog to factory?", message: "Restores the built-in models. Your added models are kept." });
  if (!ok) return;
  try {
    await request("/v1/ai/model-catalog/reset", { method: "POST" });
    await refresh();
    loadCatalogMeta();
  } catch (e) { error.value = e.message || "Reset failed."; }
}

loadCatalogMeta();
refreshApplied();
</script>

<template>
  <div class="lu-mcat">
    <!-- "Your setup" — the pair's CONTROL PANEL: the app runs BOTH slots side by side
         (one General model + one Embedding model). Each card shows its model's live
         load state + its own Load/Unload (the same writers as the rows below). -->
    <div class="lu-setup">
      <div class="lu-setup-card" :class="{ 'lu-setup-card--empty': !defaultName || defaultGone }">
        <div class="lu-setup-role">General model</div>
        <!-- The picker IS the card's value line and stays visible when set (#5:
             "leave the drop downs visible so you can change it will just unload and
             load") — changing it assigns + loads through the same writers as the
             rows, swapping the resident model. -->
        <div v-if="defaultGone" class="lu-setup-val">{{ currentDefaultId }} — removed from the catalog</div>
        <UiSelect v-if="chatSlotOptions.length" class="lu-setup-pick"
          :model-value="defaultGone ? '' : (currentDefaultId || '')" :options="chatSlotOptions"
          placeholder="Choose a model…" @update:model-value="pickSlot($event, false)" />
        <div class="lu-setup-hint">
          {{ defaultGone
            ? "Your tasks still point at it, but it's gone — pick a replacement here."
            : defaultName
              ? "Writes prose, chats, extracts — every task uses it unless you override a task. Changing it swaps the loaded model."
              : recommendedId
                ? `Writes prose, chats, extracts — we recommend ${nameOf(recommendedId)} for this PC.`
                : "Writes prose, chats, extracts — pick one to get started." }}
        </div>
        <div v-if="defaultModel && !defaultGone" class="lu-setup-live">
          <span v-if="slotState(defaultModel) === 'loaded'" class="lu-pill lu-pill--run">● loaded</span>
          <!-- T3: THE shared control (QuickSetup's bar — phases, Cancel, one wording)
               replaces the bare "↓ working…" word; "stopping" renders it too
               ("Unloading…", no Cancel — an unload isn't cancellable). -->
          <DownloadBar v-else-if="slotState(defaultModel) === 'working' || slotState(defaultModel) === 'stopping'"
            class="lu-setup-dlbar" :title="defaultName" role="General model" :task="taskFor(defaultModel.id)" />
          <span v-else-if="slotState(defaultModel) === 'error'" class="lu-error-inline">load failed — see its row below</span>
          <span v-else-if="slotState(defaultModel) === 'idle'" class="lu-muted">○ loads on first use</span>
          <span v-else class="lu-muted">not downloaded — see its row below</span>
          <UiButton v-if="slotState(defaultModel) === 'idle'" intent="secondary" size="small"
            :loading="applyingId === defaultModel.id"
            title="Load it into memory now so your first write doesn't pay the load wait"
            @click="loadAssigned(defaultModel, false)">Load now</UiButton>
          <UiButton v-else-if="slotState(defaultModel) === 'loaded'" intent="ghost" size="small"
            :loading="busy === 'unload:' + defaultModel.id"
            title="Unload from memory — frees VRAM; it loads again on next use"
            @click="unloadModel(defaultModel)">Unload</UiButton>
        </div>
      </div>
      <div class="lu-setup-card" :class="{ 'lu-setup-card--empty': !embeddingName || embeddingGone }">
        <div class="lu-setup-role">Embedding model</div>
        <div v-if="embeddingGone" class="lu-setup-val">{{ currentEmbeddingId }} — removed from the catalog</div>
        <UiSelect v-if="embedSlotOptions.length" class="lu-setup-pick"
          :model-value="embeddingGone ? '' : (currentEmbeddingId || '')" :options="embedSlotOptions"
          placeholder="Choose an embedding model…" @update:model-value="pickSlot($event, true)" />
        <div class="lu-setup-hint">
          {{ embeddingGone
            ? "Search still points at it, but it's gone — pick a replacement here."
            : embeddingName
              ? "Powers semantic search + grounded chat, alongside your General model. Changing it swaps the loaded model."
              : recommendedEmbedId
                ? `Powers semantic search + grounded chat — we recommend ${nameOf(recommendedEmbedId)} for this PC.`
                : "Powers semantic search + grounded chat — pick one to get started." }}
        </div>
        <div v-if="embeddingModel && !embeddingGone" class="lu-setup-live">
          <span v-if="slotState(embeddingModel) === 'loaded'" class="lu-pill lu-pill--run">● loaded</span>
          <DownloadBar v-else-if="slotState(embeddingModel) === 'working' || slotState(embeddingModel) === 'stopping'"
            class="lu-setup-dlbar" :title="embeddingName" role="Embedding model" :task="taskFor(embeddingModel.id)" />
          <span v-else-if="slotState(embeddingModel) === 'error'" class="lu-error-inline">load failed — see its row below</span>
          <span v-else-if="slotState(embeddingModel) === 'idle'" class="lu-muted">○ loads on first search</span>
          <span v-else class="lu-muted">not downloaded — see its row below</span>
          <UiButton v-if="slotState(embeddingModel) === 'idle'" intent="secondary" size="small"
            :loading="applyingId === embeddingModel.id"
            title="Load it into memory now, alongside your chat model"
            @click="loadAssigned(embeddingModel, true)">Load now</UiButton>
          <UiButton v-else-if="slotState(embeddingModel) === 'loaded'" intent="ghost" size="small"
            :loading="busy === 'unload:' + embeddingModel.id"
            title="Unload from memory — frees VRAM; it loads again on the next search"
            @click="unloadModel(embeddingModel)">Unload</UiButton>
        </div>
      </div>
    </div>
    <p class="lu-setup-cap lu-muted">The app runs these two side by side — the General model
      writes and chats; the Embedding model powers search. Each loads automatically the first
      time it's needed; Load now just skips that first wait.</p>

    <!-- #10 (user, 2026-07-08): a real section heading over the catalog. -->
    <div class="lu-mcat-title">Model Catalog</div>
    <div class="lu-mcat-bar">
      <UiInput v-model="query" class="lu-mcat-search" placeholder="Search models…" />
      <UiSelect v-model="sortBy" :options="SORT_OPTIONS" class="lu-mcat-sort"
        title="Benchmark score = published general-purpose benchmark order — not writing-specific, and it doesn't know your hardware. The “Recommended for this PC” badge is the per-machine answer." />
      <span class="lu-mcat-spacer" />
      <UiButton intent="secondary" size="small" @click="resetCatalog">Reset catalog</UiButton>
      <UiButton intent="primary" size="small" @click="startAdd"><template #icon>＋</template>Add model</UiButton>
    </div>

    <div v-if="error" class="lu-error lu-mcat-err">{{ error }}</div>
    <div v-else-if="loading" class="lu-mcat-empty">Loading catalog…</div>
    <div v-else-if="!hasAny" class="lu-mcat-empty">
      <template v-if="query.trim()">No models match “{{ query }}”.</template>
      <template v-else>No models in the catalog — <b>Add model</b> to add your own, or <b>Reset catalog</b> to restore the built-ins.</template>
    </div>

    <div v-else class="lu-mcat-wrap">
      <table class="lu-mgrid">
        <thead>
          <tr><th>Model</th><th>Type</th><th>License</th><th>Fit</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          <template v-for="m in groupedRows" :key="m.__key || m.id">
            <tr v-if="m.__section" class="lu-msection"><td colspan="6"><b>{{ m.__section }}</b><span class="lu-muted"> — {{ m.hint }}</span></td></tr>
            <tr v-else-if="m.__divider" class="lu-mgroup"><td colspan="6">Doesn't fit this machine — {{ m.count }} more</td></tr>
            <tr v-else>
              <td class="lu-mn">
                <span class="lu-mn-name">{{ m.name }}</span>
                <!-- The DEFAULT indicator is the right-aligned green "Default ✓" button
                     (below) — one place, aligned with the provider rows (2026-07-17). The
                     left "Default" tag was removed; the Embedding badge stays (it is NOT
                     the default indicator, and a model can be the embed without being the
                     chat default). -->
                <UiTag v-if="m.id === currentEmbeddingId" intent="info" class="lu-mbadge">Embedding</UiTag>
                <UiTag v-if="m.id === recommendedId" intent="accent2" class="lu-mbadge"
                  title="What Quick Setup would pick for this machine — the curated hardware-class map first, then the speed-floor rule">
                  Recommended for this PC</UiTag>
                <!-- §7.6 (B3-4): the tune-provenance badge — Auto-tuned / Hand-tuned /
                     Class default; untuned rows carry none. -->
                <UiTag v-if="tuneBadge(m)" :intent="tuneBadge(m).intent" class="lu-mbadge"
                  :title="tuneBadge(m).title">{{ tuneBadge(m).label }}</UiTag>
                <div class="lu-mid">{{ m.id }}</div>
                <!-- The sort fields, visible (#146): benchmark rank + size. -->
                <div class="lu-mrowmeta lu-muted" title="Benchmark rank (lower = better; published general-purpose tests) · download size">{{ rowMeta(m) }}</div>
                <div v-if="descriptionOf(m)" class="lu-mdesc">{{ descriptionOf(m) }}</div>
                <div v-if="notesOf(m)" class="lu-mnotes">Your notes: {{ notesOf(m) }}</div>
                <a v-if="cardUrlOf(m)" class="lu-mlink lu-mcardlink" :href="cardUrlOf(m)"
                  target="_blank" rel="noopener" title="Open the model's Hugging Face page — full details, files, license"
                  @click.prevent="openExternal(cardUrlOf(m))">Model card ↗</a>
              </td>
              <td class="lu-mm lu-mtype">
                <!-- Params column REPLACED (Plan B — the count already rides name/description).
                     Architecture + capabilities: Dense/MoE is the type; MTP/Embed are flags. -->
                <UiTag intent="secondary" class="lu-typetag">{{ typeOf(m) === "moe" ? "MoE" : "Dense" }}</UiTag>
                <UiTag v-if="mtpOf(m)" intent="info" class="lu-typetag" title="Multi-token prediction — speculative decode enables by default">MTP</UiTag>
                <UiTag v-if="embeddingOf(m)" intent="accent2" class="lu-typetag" title="Embedding model — powers semantic search + grounded chat">Embed</UiTag>
              </td>
              <td>
                <span v-if="licenseOf(m)" class="lu-lic" :class="{ 'lu-lic--warn': useLimitedOf(m) }" :title="licenseTitle(m)">
                  <template v-if="useLimitedOf(m)">⚠ </template>{{ licenseOf(m) }}
                </span>
                <span v-else class="lu-muted">—</span>
              </td>
              <td>
                <span class="lu-fit" :class="`lu-fit--${m.fit}`" :title="fitTitle(m)">{{ fitLabel(m) }}</span>
              </td>
              <td>
                <span v-if="m.status === 'loaded'" class="lu-pill lu-pill--run">● loaded</span>
                <!-- T3: the row keeps its COMPACT bar (density rule) but everything it
                     shows — channel choice, friendly words — comes from the same
                     taskFor adapter the cards render. -->
                <UiProgress v-else-if="m.status === 'loading'" class="lu-mprog"
                  :value="taskFor(m.id).done" :max="taskFor(m.id).total" :label="taskFor(m.id).label" />
                <span v-else-if="m.status === 'stopping'" class="lu-mstat">Unloading…</span>
                <span v-else-if="m.status === 'error'" class="lu-mstat lu-mstat--err"
                  :title="needsEngine ? 'Install the engine first — see Local engine above' : (loadErr || 'Load failed')">
                  {{ needsEngine ? "install engine ↑" : (loadErr || "failed") }}
                </span>
                <span v-else-if="m.status === 'disk'" class="lu-pill lu-pill--disk">Downloaded</span>
                <span v-else class="lu-mstat">Not downloaded</span>
              </td>
              <td class="lu-mact">
                <UiButton intent="ghost" size="small" title="Edit catalog fields" @click="startEdit(m)">Edit</UiButton>
                <UiButton intent="ghost" size="small" title="Remove from catalog and delete its downloaded weights" :loading="busy === 'del:' + m.id" @click="deleteModel(m)">Delete</UiButton>
                <UiButton v-if="m.status === 'error' || m.status === 'disk' || m.status === 'loaded'" intent="secondary" size="small"
                  :loading="busy === 'redl:' + m.id"
                  title="Clear the downloaded file and fetch it again — repairs a corrupted or incomplete download. A loaded model is unloaded first. Keeps the catalog entry."
                  @click="redownload(m)">Re-download</UiButton>
                <UiButton v-if="m.status === 'loaded' || m.status === 'disk'" intent="ghost" size="small"
                  title="Tune engine flags &amp; measure decode speed" @click="tuning = m">Tune</UiButton>
                <UiButton v-if="m.status === 'loaded'" intent="ghost" size="small"
                  :loading="busy === 'unload:' + m.id"
                  title="Unload from memory — frees VRAM; it loads again on Load as default or next use"
                  @click="unloadModel(m)">Unload</UiButton>
                <template v-if="m.status === 'loading'">
                  <!-- BOTH channels cancel. The standalone Download row stops via
                       /download/cancel; a spawn-LOAD row aborts via /stop — a true abort
                       in every phase (T2 cancel token), the partial GGUF kept. -->
                  <UiButton v-if="m.id === downloadingId" intent="ghost" size="small"
                    :loading="cancelling" title="Stop this download — the partial file stays cached"
                    @click="cancelDownload()">Cancel</UiButton>
                  <UiButton v-else intent="ghost" size="small"
                    title="Stop loading this model — the download aborts and its VRAM is freed"
                    @click="cancelLoad(m.id)">Cancel</UiButton>
                </template>
                <UiButton v-else-if="m.status === 'available'" intent="primary" size="small"
                  :loading="loadingId === m.id" @click="download(m.id)">Download</UiButton>
                <!-- Load-state on the row stays with the STATUS column's "● loaded" pill +
                     the ghost Unload above (user, 2026-07-07 follow-up: "i forgot you have
                     status of loaded and button already says load as default, but we do
                     need unload button" — the label stays plain; Unload renders on any
                     loaded row, incl. the default). -->
                <!-- Same intent as the general branch below — parity (user, 2026-07-07 +
                     re-flagged 2026-07-15: "how can the load as default button be styled
                     different for embed vs main"). Only the TARGET differs: this writes
                     the embedding default; the other writes the general default. -->
                <!-- Green when it IS the default (2026-07-17, user: "make it green when
                     default is true… more obvious"); a disabled button greys out whatever
                     the intent, so the default state stays ENABLED + clickable (re-apply is
                     idempotent) — matching the provider "Default ✓" which is clickable too. -->
                <UiButton v-else-if="embeddingOf(m)" :intent="m.id === currentEmbeddingId ? 'success' : 'primary'" size="small"
                  :disabled="m.status === 'stopping'" :loading="applyingId === m.id"
                  title="Make this the embedding model (semantic search + grounded chat) and load it now, alongside your chat model"
                  @click="makeEmbedding(m)">
                  {{ m.id === currentEmbeddingId ? "Default ✓" : "Load as default" }}
                </UiButton>
                <UiButton v-else :intent="m.id === currentDefaultId ? 'success' : 'primary'" size="small"
                  :disabled="m.status === 'stopping'" :loading="applyingId === m.id"
                  title="Make this the default model for every task and load it now" @click="makeDefault(m)">
                  {{ m.id === currentDefaultId ? "Default ✓" : "Load as default" }}
                </UiButton>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="lu-muted lu-mcat-foot">
      Models download from
      <a class="lu-mlink" href="https://huggingface.co/models?library=gguf" target="_blank" rel="noopener"
        @click.prevent="openExternal('https://huggingface.co/models?library=gguf')">Hugging Face ↗</a>
      — the open model hub. Models load automatically when a task uses them; your chat default and the embedding can run together.
    </div>

    <!-- Add / edit a catalog model. Switch editing lives in the Lab (per-Task presets),
         not here — this form is catalog metadata only. -->
    <AppModal v-if="editing" :title="editingNew ? 'Add model' : `Edit ${editing.name || editing.id}`"
      :max-width="'560px'" @close="cancelEdit">
      <div class="lu-mm-form">
        <label class="lu-mm-l">Name<UiInput v-model="editing.name" placeholder="Qwen3 14B · Q4_K_M" /></label>
        <!-- The id isn't a field to fill — it's derived from the name on save. Show
             the value that WILL be saved (resolved truth), not an empty box. -->
        <div v-if="editingNew && editing.name?.trim()" class="lu-mm-idline lu-muted">id: {{ slugFromName(editing.name) }}</div>

        <div class="lu-mm-note"><b>Download source</b> — where the GGUF is pulled from. The one thing you must set; the rest is read from the model itself.</div>
        <label class="lu-mm-l">
          <span class="lu-mm-lrow">Hugging Face repo
            <a v-if="editing.hfRepo?.trim()" class="lu-mlink" :href="`https://huggingface.co/${editing.hfRepo.trim()}`"
              target="_blank" rel="noopener" title="Open the model card in your browser — full details, files, license"
              @click.prevent="openExternal(`https://huggingface.co/${editing.hfRepo.trim()}`)">model card ↗</a>
          </span>
          <UiInput v-model="editing.hfRepo" placeholder="unsloth/Qwen3-14B-GGUF" />
        </label>
        <!-- #12c/d (user, 2026-07-08): the load-info action sits ABOVE the quant
             dropdown (it's what FILLS the quant list), renamed to say where the
             info comes from, in a stand-out color. -->
        <div class="lu-mm-inspect">
          <UiButton intent="info" size="small" :loading="inspecting" @click="inspectLink">Load model info from HF</UiButton>
          <span class="lu-muted">lists the repo's quants (sizes · QAT/IQ) + reads the GGUF header</span>
        </div>
        <div v-if="inspectErr" class="lu-error">{{ inspectErr }}</div>
        <div v-if="listingErr" class="lu-error">{{ listingErr }}</div>
        <label class="lu-mm-l">Quant
          <template v-if="quantOptions.length > 1 && !quantCustom">
            <UiSelect :model-value="editing.quant" :options="quantOptions"
              placeholder="pick a quant" @update:model-value="onQuantPick" />
          </template>
          <span v-else class="lu-mm-qrow">
            <UiInput v-model="editing.quant" placeholder="Q4_K_M" />
            <UiButton v-if="quantOptions.length > 1" intent="ghost" size="small"
              @click="quantCustom = false">choose from list</UiButton>
          </span>
        </label>

        <!-- #141: every row reads from the PERSISTED catalog facts (seeded, or written
             at download / by the boot backfill), so Edit-open shows exactly what
             Read-from-link shows; a fresh inspect overrides live. -->
        <div class="lu-mm-note"><b>Auto-detected from the file</b> <span class="lu-muted">— read from the GGUF header (Read from link, or confirmed at download)</span></div>
        <div class="lu-mm-auto">
          <div class="lu-mm-auto-row"><span class="lu-muted">Architecture</span><span>{{ (inspected?.architecture || editing.architecture) || "—" }}<template v-if="inspected?.experts || editing.experts"> · {{ inspected?.experts || editing.experts }} experts</template></span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">Size (file)</span><span>{{ (inspected?.sizeLabel || editing.sizeLabel) || "—" }}</span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">Trained context</span><span>{{ editing.trainedCtx ? `${editing.trainedCtx.toLocaleString()} tokens` : "—" }}</span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">MTP</span><span>{{ mtpFact }}</span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">Recommended samplers</span><span>{{ samplersLabel }}</span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">Download size</span><span>{{ (inspected?.sizeBytes || editing.sizeBytes) ? fmtBytes(inspected?.sizeBytes || editing.sizeBytes) : "—" }}<template v-if="inspected?.estVramMb ?? editing.estVramMb"> · ≈ {{ (inspected?.estVramMb ?? editing.estVramMb).toLocaleString() }} MB VRAM (full GPU · 8K ctx)</template></span></div>
        </div>
        <div v-if="poolingOf(editing)" class="lu-mm-note"><b>Embedding pooling: {{ poolingOf(editing) }}</b> <span class="lu-muted">— how the model's token vectors are combined into one embedding (mean · cls · last). Curated per embedding model; read-only here because the wrong pooling degrades search quality.</span></div>

        <!-- Capability checkboxes (Plan B — replace the read-only Type/MTP rows; the user's
             editable-over-auto rule: auto-detected, override if you know better). MoE ⇄ the
             exclusive `type`; MTP + Embedding are independent flags. -->
        <div class="lu-mm-note"><b>What this model is</b> <span class="lu-muted">— auto-detected from the file; override if you know better.</span></div>
        <div class="lu-mm-caps">
          <UiCheckbox :model-value="editing.type === 'moe'"
            @update:model-value="editing.type = $event ? 'moe' : 'dense'">
            <span>MoE <span class="lu-muted">— mixture-of-experts (offloads experts to RAM)</span></span>
          </UiCheckbox>
          <UiCheckbox v-model="editing.mtp">
            <span>MTP <span class="lu-muted">— multi-token prediction (speculative decode). Check to enable + configure below.</span></span>
          </UiCheckbox>
          <UiCheckbox v-model="editing.embedding">
            <span>Embedding <span class="lu-muted">— a RAG/search model, not a chat LLM</span></span>
          </UiCheckbox>
        </div>

        <!-- Consistency (2026-07-13, decision A): each capability checkbox REVEALS +
             owns its config below, in checkbox order (MoE · MTP · Embedding); uncheck
             hides it. MoE/MTP change resolved switches via switch_resolve; Embedding
             drives placement + pooling (its own plane) — same interaction, uniform. -->
        <template v-if="editing.type === 'moe'">
          <div class="lu-mm-note"><b>MoE</b> <span class="lu-muted">— experts offload to system RAM; the launch pins layers on GPU and frees VRAM via CPU MoE layers (adds <code>no_mmap</code> at load). Tune <code>n_cpu_moe</code> per box in Quick tune.</span></div>
        </template>

        <template v-if="editing.mtp">
          <div class="lu-mm-note"><b>MTP config</b> <span class="lu-muted">—
            <template v-if="editing.mtpBuiltin">built-in prediction heads; no external draft needed. </template>
            <template v-else>runs via an external speculative-decode draft file (a separate download). </template>
            Enabling adds <code>spec_type=draft-mtp</code> at load; uncheck to turn MTP off.</span></div>
          <label class="lu-mm-l">Draft file <span class="lu-muted">{{ editing.mtpBuiltin ? "optional — built-in MTP" : "the speculative-decode model (feeds --model-draft)" }}</span>
            <UiSelect v-if="listing?.drafts?.length" :model-value="editing.mtpDraftFile"
              :options="draftOptions" @update:model-value="onDraftPick" />
            <UiInput v-else v-model="editing.mtpDraftFile" placeholder="MTP/…-Q4_0-MTP.gguf" />
          </label>
          <label class="lu-mm-l">Draft repo <span class="lu-muted">optional — blank = the same repo as the model</span>
            <UiInput v-model="editing.mtpDraftRepo" placeholder="" /></label>
          <div v-if="inspected?.mtpInheritedFile && (editing.mtpDraftRepo === inspected.mtpInheritedRepo)" class="lu-mm-note"><span class="lu-muted">Borrowed official drafter: <code>{{ inspected.mtpInheritedRepo }}</code> / <code>{{ inspected.mtpInheritedFile }}</code> — this model ships none of its own, so it uses the base family's.</span></div>
        </template>

        <template v-if="editing.embedding">
          <div class="lu-mm-note"><b>Task templates</b> <span class="lu-muted">— some embedding models need an instruction around the text ({text} is the slot; leave empty if the model needs none). Changing these needs a Rebuild of the book index.</span></div>
          <label class="lu-mm-l">Document template <span class="lu-muted">applied when indexing</span><UiTextarea v-model="editingTpl.documentTemplate" placeholder="search_document: {text}" /></label>
          <label class="lu-mm-l">Query template <span class="lu-muted">applied to questions/searches</span><UiTextarea v-model="editingTpl.queryTemplate" placeholder="search_query: {text}" /></label>
        </template>

        <div class="lu-mm-note"><b>Fit estimate</b> — a pre-download guess so the list can show “will it fit?”; once downloaded the GGUF sets the real fit.</div>
        <div class="lu-mm-row">
          <label class="lu-mm-l">Total params<UiInput v-model="editing.totalParams" placeholder="14B" /></label>
          <label class="lu-mm-l">Active params <span class="lu-muted">MoE only</span><UiInput v-model="editing.activeParams" placeholder="3.6B" /></label>
        </div>
        <div class="lu-mm-row">
          <label class="lu-mm-l">Min VRAM (MB)<UiInput v-model.number="editing.minVramMb" type="number" placeholder="11000" /></label>
          <label class="lu-mm-l">Min RAM (MB)<UiInput v-model.number="editing.minRamMb" type="number" placeholder="14000" /></label>
        </div>

        <label class="lu-mm-l">License <span class="lu-muted">— SPDX id (Apache-2.0 · MIT · Llama-Community · …)</span><UiInput v-model="editing.license" placeholder="Apache-2.0" /></label>
        <div class="lu-mm-l"><UiCheckbox v-model="editing.useLimited"><span>Use-limited license <span class="lu-muted">— not free for unrestricted/commercial use; shows the ⚠ badge</span></span></UiCheckbox></div>

        <div class="lu-mm-note"><b>Description & your notes</b> <span class="lu-muted">— the description refreshes from the file facts on Read from link; Notes are yours alone and are never touched by reads, downloads, or resets.</span></div>
        <label class="lu-mm-l">Description <span class="lu-muted">generated from hf info card</span><UiTextarea v-model="editing.description" placeholder="What this model is — refreshed from the file facts" /></label>
        <label class="lu-mm-l">Notes <span class="lu-muted">yours — measurements, taste, use policy</span><UiTextarea v-model="editing.notes" placeholder="e.g. measured writer TTFT 1.6 s on my box; my go-to for dark scenes" /></label>
        <label class="lu-mm-l">Benchmark rank <span class="lu-muted">— published general-benchmark order; lower = better; 100 = unranked (sorts last)</span><UiInput v-model.number="editing.qualityRank" type="number" placeholder="100" /></label>

        <div v-if="saveErr" class="lu-error">{{ saveErr }}</div>
      </div>
      <template #footer>
        <UiButton intent="ghost" @click="cancelEdit">Cancel</UiButton>
        <span class="lu-mm-spacer" />
        <UiButton intent="primary" :loading="saving" @click="saveModel">{{ editingNew ? "Add model" : "Save" }}</UiButton>
      </template>
    </AppModal>

    <!-- Tune & measure (#20) — shared modal, opened per model; closing refetches
         the badge state (an Apply/Remove inside changes exactly that). -->
    <TuneMeasureModal v-if="tuning" :model="tuning" @close="closeTuneModal" />
  </div>
</template>

<style scoped>
.lu-mcat { margin-top: 14px; }
.lu-mcat-head { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.lu-mcat-head b { color: var(--ink-2); }
.lu-mcat-err { margin-bottom: 8px; }
.lu-mcat-empty { font-size: 12.5px; color: var(--muted); padding: 14px; text-align: center; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm, 8px); }
.lu-mcat-wrap { max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-sm, 8px); background: var(--surface); }
.lu-mgrid { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lu-mgrid th {
  position: sticky; top: 0; z-index: 1; background: var(--surface-2); text-align: left;
  font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
  font-weight: 700; padding: 7px 11px; border-bottom: 1px solid var(--border);
}
.lu-mgrid td { padding: 8px 11px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.lu-mgrid tr:last-child td { border-bottom: 0; }
.lu-mn { font-weight: 600; color: var(--ink); min-width: 150px; }
.lu-mid { font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--muted); font-weight: 400; margin-top: 1px; }
.lu-mrowmeta { font-size: 10.5px; font-weight: 400; margin-top: 1px; }
.lu-mdesc { font-size: 11px; color: var(--ink-2); font-weight: 400; margin-top: 3px; max-width: 46ch; line-height: 1.4; }
.lu-mnotes { font-size: 10.5px; color: var(--muted); font-weight: 400; font-style: italic; margin-top: 2px; max-width: 46ch; line-height: 1.4; }
.lu-setup-pick { margin-top: 7px; }
/* Default / Embedding badges sit inline after the model name; the fit-group divider row. */
.lu-mbadge { margin-left: 6px; vertical-align: middle; }
.lu-mgroup td { background: var(--surface-2); color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; padding: 5px 11px; }
.lu-mm { color: var(--ink-2); white-space: nowrap; }
.lu-mact { text-align: right; white-space: nowrap; }

/* License badge — neutral for permissive (Apache/MIT), a gold warning chip for
   use-limited licenses (Llama-Community, *-Research, Gemma terms). */
.lu-lic { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); background: var(--surface); white-space: nowrap; }
.lu-lic--warn { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }

/* .lu-pill* moved to shared common/styles.css (used by the grid too). */
.lu-mstat { font-size: 11px; color: var(--muted); }
.lu-mstat--err { color: var(--danger); font-size: 11px; display: inline-block; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.lu-mprog { min-width: 150px; }

.lu-mcat-foot { font-size: 11px; margin-top: 7px; }
.lu-mlink { color: var(--accent-ink, var(--accent)); }
.lu-mcardlink { display: inline-block; font-size: 10.5px; font-weight: 400; margin-top: 3px; }
.lu-mm-lrow { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.lu-mm-lrow .lu-mlink { font-weight: 400; font-size: 11px; }

/* The strip cards' live state + Load/Unload row + the pair caption (2026-07-07). */
.lu-setup-live { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-size: 11.5px; }
/* The shared bar fills the card's live row (its own margin-top is for QuickSetup's stack). */
.lu-setup-dlbar { flex: 1; min-width: 0; margin-top: 0; }
.lu-error-inline { color: var(--danger); font-size: 11px; }
.lu-setup-cap { font-size: 11.5px; line-height: 1.5; margin: 8px 0 0; }

/* "Your setup" strip — the two required slots (General + Embedding), status-only cards. */
.lu-setup {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
}
.lu-setup-card {
  border: 1px solid var(--lu-border, var(--border, #e2e2e2));
  border-radius: 10px;
  background: var(--lu-surface, var(--surface, #fff));
  padding: 10px 14px;
}
.lu-setup-card--empty {
  border-style: dashed;
  background: var(--lu-surface-2, var(--surface-2, #fafafa));
}
.lu-setup-role {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--lu-ink-2, var(--ink-2, #666));
}
.lu-setup-val { font-weight: 600; font-size: 13.5px; margin-top: 2px; }
.lu-setup-card--empty .lu-setup-val { color: var(--lu-warn, #b45309); }
.lu-setup-hint { font-size: 11.5px; color: var(--lu-ink-2, var(--ink-2, #666)); margin-top: 2px; line-height: 1.4; }

/* Section-header rows (Chat & writing / Embedding) inside the one table — a
   pronounced band (#11) so you always know which kind of model you're looking
   at. QC-39 (the user's mockup pick): the band's FILL is neutral surface-2 —
   the page-scale accent-soft wash is gone — and the pronouncement is the 3px
   accent edge (chip-scale accent). */
.lu-msection td {
  padding: 9px 11px 8px;
  font-size: 12.5px;
  background: var(--surface-2, #f0f0f0);
  border-left: 3px solid var(--accent, #3a7d63);
  border-bottom: 1px solid var(--lu-border, var(--border, #e2e2e2));
}
.lu-msection b { color: var(--ink); }

/* Manager: heading (#10) + header bar (search → sort → spacer → actions) + the add/edit
   modal form (#30). The heading's margin-top keeps the 2026-07-07 breathing room between
   the "Your setup" strip cards and this block. */
.lu-mcat-title { font-weight: 700; font-size: 14px; color: var(--ink); margin-top: 14px; }
.lu-mcat-bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; margin-bottom: 8px; }
.lu-mcat-search { flex: 0 1 220px; }
.lu-mcat-sort { flex: 0 0 auto; }
.lu-mcat-spacer { flex: 1; }
.lu-mm-form { display: flex; flex-direction: column; gap: 12px; }
.lu-mm-l { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-2); font-weight: 600; }
.lu-mm-l .lu-muted { font-weight: 400; }
.lu-mm-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.lu-mm-idline { font-size: 11px; font-variant-ligatures: none; margin-top: -2px; }
.lu-mm-note { font-size: 11px; color: var(--muted); line-height: 1.4; }
.lu-mm-note b { color: var(--ink-2); font-weight: 700; }
.lu-mm-inspect { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-mm-auto { display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.lu-mm-auto-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; align-items: baseline; }
.lu-mm-auto-row > .lu-muted:first-child { flex: 0 0 auto; }
.lu-mm-spacer { flex: 1; }
.lu-mm-caps { display: flex; flex-direction: column; gap: 6px; }
.lu-mm-qrow { display: flex; align-items: center; gap: 8px; }
.lu-mtype { white-space: nowrap; }
.lu-typetag { margin-right: 4px; }
</style>
