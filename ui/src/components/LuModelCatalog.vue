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
import { FIT_RUNNABLE, pickLowestQuality, recommendedModelId } from "../common/services/modelPick.js";
import AppModal from "../common/components/AppModal.vue";
import TuneMeasureModal from "./TuneMeasureModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiTag from "../common/components/UiTag.vue";
import UiProgress from "../common/components/UiProgress.vue";
import { confirmDialog } from "../common/services/dialog.js";

// Shared runner-models state (models / status / load / progress) — one source for the
// grid + this list. Everything comes from the ONE singleton so the two surfaces never drift.
const {
  models, vramMb, loading, error, downloaded, total, loadErr, loadingId,
  needsEngine, progressLabel, fmtBytes, FIT_LABEL, refresh, download,
} = useRunnerModels();

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
// list so the row markup stays written ONCE; every sentinel carries a unique __key (two
// sections would otherwise collide on the old 'divider' key).
function fitSplit(list, section) {
  const fit = sortModels(list.filter((m) => FIT_RUNNABLE.has(m.fit)));
  const rest = sortModels(list.filter((m) => !FIT_RUNNABLE.has(m.fit)));
  const rows = [...fit];
  if (rest.length) {
    if (fit.length) rows.push({ __divider: true, count: rest.length, __key: `divider-${section}` });
    rows.push(...rest);
  }
  return rows;
}
const chatRows = computed(() => filtered.value.filter((m) => !embeddingOf(m)));
const embedRows = computed(() => filtered.value.filter((m) => embeddingOf(m)));
const groupedRows = computed(() => {
  const rows = [];
  if (chatRows.value.length) {
    rows.push({ __section: "Chat & writing models", hint: "write prose, chat, extract — pick one as your General model", __key: "sec-chat" });
    rows.push(...fitSplit(chatRows.value, "chat"));
  }
  if (embedRows.value.length) {
    rows.push({ __section: "Embedding models", hint: "power semantic search + grounded chat — pick one as your Embedding model", __key: "sec-embed" });
    rows.push(...fitSplit(embedRows.value, "embed"));
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
// Unload (user, 2026-07-07: "no way to unload"): free a resident model's VRAM without
// loading something else. The router stays up; the model loads again on Load-as-default
// or on the next request that needs it.
async function unloadModel(m) {
  busy.value = `unload:${m.id}`;
  try {
    await request("/v1/llm-runner/stop", { method: "POST", body: { modelId: m.id } });
    await refresh();
  } catch (e) { error.value = e.message || "Couldn't unload."; }
  finally { busy.value = ""; }
}
async function makeEmbedding(m) {
  applyingId.value = m.id;
  try { await setAsEmbedding(LOCAL_RUNNER_ID, m.id); } catch (e) { error.value = e.message || "Couldn't set the embedding."; }
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
const { qualityById, typeById, mtpById, embeddingById, licenseById, useLimitedById, descriptionById, poolingById, classPicks, refresh: loadCatalogMeta } = useCatalogMeta();
function licenseOf(m) { return licenseById.value[m.id] || ""; }
function descriptionOf(m) { return descriptionById.value[m.id] || ""; }
function useLimitedOf(m) { return !!useLimitedById.value[m.id]; }
function poolingOf(m) { return poolingById.value[m.id] || ""; }
function qualityOf(m) { return qualityById.value[m.id] ?? 100; }
function embeddingOf(m) { return embeddingById.value[m.id] === true; }

// ── The "Your setup" strip (option C) + the "Recommended for this PC" badge ──
// The strip states the two-slot requirement (one General model + one Embedding model)
// off the SAME shared applied state the row badges use (modelApply); the badge calls
// the SAME composed rule as QuickSetup (recommendedModelId, modelPick.js) — one source,
// so the wizard and the badge can never disagree about "best for this machine".
const modelById = computed(() => Object.fromEntries(models.value.map((m) => [m.id, m])));
function nameOf(id) { const m = modelById.value[id]; return m ? m.name || m.id : id; }
const defaultName = computed(() => (currentDefaultId.value ? nameOf(currentDefaultId.value) : ""));
const embeddingName = computed(() => (currentEmbeddingId.value ? nameOf(currentEmbeddingId.value) : ""));
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
function licenseTitle(m) {
  const lic = licenseOf(m);
  return useLimitedOf(m)
    ? `${lic || "license"} — use-limited: not free for unrestricted/commercial use, never a default. The catalog only lists it; the weights download on your machine.`
    : (lic ? `${lic} — permissive (free to use).` : "license unknown");
}

// ── Tune & measure (#20) — the modal is shared (TuneMeasureModal), opened per model ─
const tuning = ref(null); // null | the model being tuned

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
  const entries = Object.entries(s);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(" · ") : "—";
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
async function loadRepoFiles() {
  const e = editing.value;
  if (!e?.hfRepo?.trim()) return;
  listingErr.value = "";
  try {
    const params = new URLSearchParams({ repo: e.hfRepo.trim() });
    const r = await request(`/v1/ai/model-catalog/list-files?${params}`, { method: "POST" });
    listing.value = r;
    // free-typed quant not in the listing → stay in custom mode
    quantCustom.value = !!(e.quant && !r.quants.some((q) => q.quant === e.quant));
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
}
function onDraftPick(path) {
  const e = editing.value;
  e.mtpDraftFile = path || "";
  const d = (listing.value?.drafts || []).find((x) => x.path === path);
  e.mtpDraftQuant = d?.quant || "";
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
    e.mtp = !!r.mtp;
    e.trainedCtx = r.trainedCtx ?? null;
    if (r.totalParams) e.totalParams = r.totalParams; // file-derived (dense); MoE stays curated
    if (!e.minVramMb && r.estVramMb) e.minVramMb = r.estVramMb;
    inspected.value = {
      architecture: r.architecture || "", experts: r.experts || 0, sizeLabel: r.sizeLabel || "",
      samplers: r.samplers || {}, sizeBytes: r.sizeBytes || 0, estVramMb: r.estVramMb ?? null,
    };
    // B2 (Smart-Add remainder): auto-compose a plain-language description from the
    // just-read facts — ONLY into an EMPTY field. A hand-typed or previously saved
    // description is never clobbered, and the field stays fully editable after.
    if (!e.description?.trim()) e.description = composedDescription();
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
  const params = (e.totalParams || inspected.value?.sizeLabel || "").toString().trim();
  const kind = e.embedding ? "embedding model" : e.type === "moe" ? "mixture-of-experts model" : "model";
  bits.push(params ? `${params} ${kind}` : kind);
  if (e.trainedCtx) bits.push(`${Math.round(e.trainedCtx / 1024)}k context`);
  if (e.mtp || e.mtpDraftFile) bits.push("MTP draft for faster generation");
  if (e.quant) {
    const q = (listing.value?.quants || []).find((x) => x.quant === e.quant);
    bits.push(`${e.quant}${q?.qat ? " (QAT)" : ""}`);
    if (q?.sizeMb) bits.push(`${gb(q.sizeMb)} GB`);
  }
  return bits.join(" · ");
}

function blankModel() {
  return { id: "", name: "", hfRepo: "", quant: "", type: "dense", totalParams: "",
    activeParams: "", mtp: false, mtpDraftRepo: "", mtpDraftFile: "", mtpDraftQuant: "",
    trainedCtx: null, samplers: {}, minVramMb: null, minRamMb: null,
    tier: "mid", license: "", useLimited: false, embedding: false, description: "", qualityRank: 100, position: 0 };
}
function startAdd() { editing.value = blankModel(); editingNew.value = true; saveErr.value = ""; inspected.value = null; inspectErr.value = ""; listing.value = null; listingErr.value = ""; quantCustom.value = false; }
async function startEdit(m) {
  saveErr.value = ""; inspected.value = null; inspectErr.value = "";
  listing.value = null; listingErr.value = ""; quantCustom.value = false;
  try {
    const cat = await request("/v1/ai/model-catalog");
    const row = (cat.rows || []).find((r) => r.id === m.id) || { ...blankModel(), id: m.id, name: m.name };
    editing.value = { ...blankModel(), ...row };
    editingNew.value = false;
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
      message: "Removes the catalog entry (downloaded files on disk are not deleted). Reset restores built-ins.",
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
      ? `It's in use by ${usedBits}. They'll be re-pointed to ${nameOf(repl)}, then the entry is removed (downloaded files stay on disk).`
      : `It's in use by ${usedBits}, and no other ${kind ? "embedding" : "chat"} model is available to re-point to. Delete anyway and everything pointing at it will show "removed from the catalog" until you pick a replacement.`,
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
    await request(`/v1/ai/model-catalog?modelId=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    await refresh();
    loadCatalogMeta(); // keep the shared catalog-meta map in sync (like save/reset do)
    refreshApplied(); // the strip + badges re-read the (possibly re-pointed) applied state
  } catch (e) { error.value = e.message || "Delete failed."; } finally { busy.value = ""; }
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
    <!-- "Your setup" — the app needs BOTH slots filled: one General model + one Embedding
         model (Quick Setup fills both automatically; this states it for the manual path). -->
    <div class="lu-setup">
      <div class="lu-setup-card" :class="{ 'lu-setup-card--empty': !defaultName || defaultGone }">
        <div class="lu-setup-role">General model</div>
        <div class="lu-setup-val">{{ defaultGone ? `${currentDefaultId} — removed from the catalog` : (defaultName || "Not set") }}</div>
        <div class="lu-setup-hint">
          {{ defaultGone
            ? "Your tasks still point at it, but it's gone — pick a new one below (“Load as default”)."
            : defaultName
              ? "Writes prose, chats, extracts — every task uses it unless you override a task."
              : "Pick one under Chat & writing models below — “Load as default”." }}
        </div>
      </div>
      <div class="lu-setup-card" :class="{ 'lu-setup-card--empty': !embeddingName || embeddingGone }">
        <div class="lu-setup-role">Embedding model</div>
        <div class="lu-setup-val">{{ embeddingGone ? `${currentEmbeddingId} — removed from the catalog` : (embeddingName || "Not set") }}</div>
        <div class="lu-setup-hint">
          {{ embeddingGone
            ? "Search still points at it, but it's gone — pick a new one below (“Set as embedding”)."
            : embeddingName
              ? "Powers semantic search + grounded chat, alongside your general model."
              : "Pick one under Embedding models below — “Set as embedding”." }}
        </div>
      </div>
    </div>

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
                <UiTag v-if="m.id === currentDefaultId" intent="success" class="lu-mbadge">Default</UiTag>
                <UiTag v-else-if="m.id === currentEmbeddingId" intent="info" class="lu-mbadge">Embedding</UiTag>
                <UiTag v-if="m.id === recommendedId" intent="accent2" class="lu-mbadge"
                  title="What Quick Setup would pick for this machine — the curated hardware-class map first, then the speed-floor rule">
                  Recommended for this PC</UiTag>
                <div class="lu-mid">{{ m.id }}</div>
                <div v-if="descriptionOf(m)" class="lu-mdesc">{{ descriptionOf(m) }}</div>
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
                <UiProgress v-else-if="m.status === 'loading'" class="lu-mprog"
                  :value="downloaded" :max="total" :label="progressLabel" />
                <span v-else-if="m.status === 'error'" class="lu-mstat lu-mstat--err"
                  :title="needsEngine ? 'Install the engine first — see Local engine above' : (loadErr || 'Load failed')">
                  {{ needsEngine ? "install engine ↑" : (loadErr || "failed") }}
                </span>
                <span v-else-if="m.status === 'disk'" class="lu-pill lu-pill--disk">Downloaded</span>
                <span v-else class="lu-mstat">Not downloaded</span>
              </td>
              <td class="lu-mact">
                <UiButton intent="ghost" size="small" title="Edit catalog fields" @click="startEdit(m)">Edit</UiButton>
                <UiButton intent="ghost" size="small" title="Remove from catalog" :loading="busy === 'del:' + m.id" @click="deleteModel(m)">Delete</UiButton>
                <UiButton v-if="m.status === 'loaded' || m.status === 'disk'" intent="ghost" size="small"
                  title="Tune engine flags &amp; measure decode speed" @click="tuning = m">Tune</UiButton>
                <UiButton v-if="m.status === 'loaded'" intent="ghost" size="small"
                  :loading="busy === 'unload:' + m.id"
                  title="Unload from memory — frees VRAM; it loads again on Load as default or next use"
                  @click="unloadModel(m)">Unload</UiButton>
                <span v-if="m.status === 'loading'" class="lu-muted lu-mwait">working…</span>
                <UiButton v-else-if="m.status === 'available'" intent="primary" size="small"
                  :loading="loadingId === m.id" @click="download(m.id)">Download</UiButton>
                <UiButton v-else-if="embeddingOf(m)" intent="secondary" size="small"
                  :disabled="m.id === currentEmbeddingId" :loading="applyingId === m.id"
                  title="Use this as the embedding model (semantic search + grounded chat)" @click="makeEmbedding(m)">
                  {{ m.id === currentEmbeddingId ? "Embedding ✓" : "Set as embedding" }}
                </UiButton>
                <UiButton v-else intent="primary" size="small"
                  :disabled="m.id === currentDefaultId" :loading="applyingId === m.id"
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
      <a class="lu-mlink" href="https://huggingface.co/models?library=gguf" target="_blank" rel="noopener">Hugging Face ↗</a>
      — the open model hub. Models load automatically when a task uses them; your chat default and the embedding can run together.
    </div>

    <!-- Add / edit a catalog model. Switch editing lives in the Lab (per-Task presets),
         not here — this form is catalog metadata only. -->
    <AppModal v-if="editing" :title="editingNew ? 'Add model' : `Edit ${editing.name || editing.id}`"
      :max-width="'560px'" @close="cancelEdit">
      <div class="lu-mm-form">
        <label class="lu-mm-l">Name<UiInput v-model="editing.name" placeholder="Qwen3 14B · Q4_K_M" /></label>
        <label v-if="editingNew" class="lu-mm-l">Id <span class="lu-muted">blank → derived from name</span><UiInput v-model="editing.id" placeholder="qwen3-14b-q4_k_m" /></label>

        <div class="lu-mm-note"><b>Download source</b> — where the GGUF is pulled from. The one thing you must set; the rest is read from the model itself.</div>
        <label class="lu-mm-l">Hugging Face repo<UiInput v-model="editing.hfRepo" placeholder="unsloth/Qwen3-14B-GGUF" /></label>
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
        <div class="lu-mm-inspect">
          <UiButton intent="secondary" size="small" :loading="inspecting" @click="inspectLink">Read from link</UiButton>
          <span class="lu-muted">lists the repo's quants (sizes · QAT/IQ) + reads the GGUF header — no download</span>
        </div>
        <div v-if="inspectErr" class="lu-error">{{ inspectErr }}</div>
        <div v-if="listingErr" class="lu-error">{{ listingErr }}</div>

        <template v-if="listing?.drafts?.length || editing.mtpDraftFile">
          <div class="lu-mm-note"><b>MTP draft model</b> <span class="lu-muted">— this repo ships a
            SEPARATE speculative-decode file at its own quant (Gemma-style; auto-detected from the
            <code>MTP/</code> folder). Setting it feeds <code>--model-draft</code> and auto-enables MTP —
            uncheck MTP below or turn it off in Quick tune if you don't want it.</span></div>
          <label class="lu-mm-l">Draft file
            <UiSelect v-if="listing?.drafts?.length" :model-value="editing.mtpDraftFile"
              :options="draftOptions" @update:model-value="onDraftPick" />
            <UiInput v-else v-model="editing.mtpDraftFile" placeholder="MTP/…-Q4_0-MTP.gguf" />
          </label>
          <label class="lu-mm-l">Draft repo <span class="lu-muted">optional — blank = the same repo</span>
            <UiInput v-model="editing.mtpDraftRepo" placeholder="" /></label>
        </template>

        <div class="lu-mm-note"><b>Auto-detected from the file</b> <span class="lu-muted">— read from the GGUF header (Read from link, or confirmed at download)</span></div>
        <div class="lu-mm-auto">
          <div v-if="inspected" class="lu-mm-auto-row"><span class="lu-muted">Architecture</span><span>{{ inspected.architecture || "—" }}<template v-if="inspected.experts"> · {{ inspected.experts }} experts</template></span></div>
          <div v-if="inspected?.sizeLabel" class="lu-mm-auto-row"><span class="lu-muted">Size (file)</span><span>{{ inspected.sizeLabel }}</span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">Trained context</span><span>{{ editing.trainedCtx ? `${editing.trainedCtx.toLocaleString()} tokens` : "—" }}</span></div>
          <div class="lu-mm-auto-row"><span class="lu-muted">Recommended samplers</span><span>{{ samplersLabel }}</span></div>
          <div v-if="inspected?.sizeBytes" class="lu-mm-auto-row"><span class="lu-muted">Download size</span><span>{{ fmtBytes(inspected.sizeBytes) }}<template v-if="inspected.estVramMb"> · ≈ {{ inspected.estVramMb.toLocaleString() }} MB VRAM (full GPU · 8K ctx)</template></span></div>
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
            <span>MTP <span class="lu-muted">— multi-token prediction; speculative decode auto-enables</span></span>
          </UiCheckbox>
          <UiCheckbox v-model="editing.embedding">
            <span>Embedding <span class="lu-muted">— a RAG/search model, not a chat LLM</span></span>
          </UiCheckbox>
        </div>

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

        <div class="lu-mm-note"><b>Curation</b> <span class="lu-muted">— editable "what this is" + the quality order QuickSetup uses to pick the best model that fits your box.</span></div>
        <label class="lu-mm-l">Description<UiTextarea v-model="editing.description" placeholder="Plain-language 'what this model is' — e.g. fast 9B for quick chat and drafts" /></label>
        <label class="lu-mm-l">Benchmark rank <span class="lu-muted">— published general-benchmark order; lower = better; 100 = unranked (sorts last)</span><UiInput v-model.number="editing.qualityRank" type="number" placeholder="100" /></label>

        <div v-if="saveErr" class="lu-error">{{ saveErr }}</div>
      </div>
      <template #footer>
        <UiButton intent="ghost" @click="cancelEdit">Cancel</UiButton>
        <span class="lu-mm-spacer" />
        <UiButton intent="primary" :loading="saving" @click="saveModel">{{ editingNew ? "Add model" : "Save" }}</UiButton>
      </template>
    </AppModal>

    <!-- Tune & measure (#20) — shared modal, opened per model. -->
    <TuneMeasureModal v-if="tuning" :model="tuning" @close="tuning = null" />
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
.lu-mdesc { font-size: 11px; color: var(--ink-2); font-weight: 400; margin-top: 3px; max-width: 46ch; line-height: 1.4; }
/* Default / Embedding badges sit inline after the model name; the fit-group divider row. */
.lu-mbadge { margin-left: 6px; vertical-align: middle; }
.lu-mgroup td { background: var(--surface-2); color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; padding: 5px 11px; }
.lu-mm { color: var(--ink-2); white-space: nowrap; }
.lu-mact { text-align: right; white-space: nowrap; }
.lu-mwait { font-size: 11px; }

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

/* Section-header rows (Chat & writing / Embedding) inside the one table. */
.lu-msection td {
  padding: 14px 8px 6px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--lu-border, var(--border, #e2e2e2));
}

/* Manager: header bar (search → sort → spacer → actions) + the add/edit modal form (#30). */
.lu-mcat-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.lu-mcat-search { flex: 0 1 220px; }
.lu-mcat-sort { flex: 0 0 auto; }
.lu-mcat-spacer { flex: 1; }
.lu-mm-form { display: flex; flex-direction: column; gap: 12px; }
.lu-mm-l { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-2); font-weight: 600; }
.lu-mm-l .lu-muted { font-weight: 400; }
.lu-mm-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
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
