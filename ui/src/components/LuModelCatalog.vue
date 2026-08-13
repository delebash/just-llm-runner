<script setup>
// SPDX-License-Identifier: MIT
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

import { catalogCopyConfig, request } from "../client.js";

// Host-voiced copy tokens with JW's words as defaults (see configureLlmUi).
const CC = {
  showEmbedding: true,
  chatSectionLabel: "Chat & writing models",
  chatSectionHint: "write prose, chat, extract — pick one as your General model",
  generalUse: "Writes prose, chats, extracts",
  slotsFootnote: "The app runs these two side by side — the General model writes and chats; the Embedding model powers search. Each loads automatically the first time it's needed; Load now just skips that first wait.",
  ...catalogCopyConfig(),
};
import { useRunnerModels } from "../composables/useRunnerModels.js";
import { useCatalogMeta } from "../composables/useCatalogMeta.js";
import { useHardware } from "../composables/useHardware.js";
import { applyPreview, useModelApply } from "../services/modelApply.js";
import { FIT_RUNNABLE, pickBestEmbedId, pickLowestQuality, recommendedModelId } from "../common/services/modelPick.js";
import { allDraftsUnloadable, pickDefaultDraftPath, pickDefaultQuant } from "../draftSelect.js";
import { displayRamGb, displayVramGb } from "../fitDisplay.js";
import { TUNE_BADGES, fetchTuneState, isUntunedHere, tuneBadgeIdOf } from "../tuneState.js";
import { classKeyLabel, listClassTunes, memberClassesOf } from "../classTunes.js";
import AppModal from "../common/components/AppModal.vue";
import LuModelTypeTag from "./LuModelTypeTag.vue";
import TuneMeasureModal from "./TuneMeasureModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiInput from "../common/components/UiInput.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTextarea from "../common/components/UiTextarea.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import UiTag from "../common/components/UiTag.vue";
import UiTable from "../common/components/UiTable.vue";
import DownloadBar from "../common/components/DownloadBar.vue";
import { confirmDialog } from "../common/services/dialog.js";
import { openExternal } from "../common/services/external.js";
import {
  DropdownMenuRoot, DropdownMenuTrigger, DropdownMenuPortal,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "reka-ui";

// Shared runner-models state (models / status / load / progress) — one source for the
// grid + this list. Everything comes from the ONE singleton so the two surfaces never drift.
const {
  models, vramMb, loading, error, loadingId,
  fmtBytes, FIT_LABEL, refresh, download, retryLoad, taskFor,
} = useRunnerModels();
// ONE mechanism (2026-07-21, the user's ruling "same mech, same function"): the rows + slot
// cards render the SAME createDownloadTask via taskFor(id), fed by the singleton's poll —
// Cancel/Retry live IN the bar (no per-row Cancel buttons, no separate downloadingIds/
// cancellingIds gating), and every load trigger routes through retryLoad (engine check first).

// Search + sort + fit-grouping (design §4): ONE visible list — models that FIT the machine
// grouped first, the rest below — with a search box and a sort control (replaces the old
// installed-first "Your models / Browse catalog" toggle).
const query = ref("");
// Column-header sorting (user, 2026-07-22 — replaces the Sort dropdown): each column is
// click-to-sort with a direction toggle + arrow. `quality` = the published GENERAL-purpose
// benchmark rank (lower = better; the "Bench" column) — it measures neither creative writing
// nor this machine; the honest per-box answer is the "Recommended for this PC" badge below.
const sortKey = ref("quality");
const sortDir = ref("asc"); // quality asc = best (lowest rank) first
// The sortable columns, in render order. `num` = right-aligned numeric; `defDir` = the
// natural FIRST-click direction (all read best ascending here).
// `w` = the column's SHARE of the table, not a pixel size. With `table-layout: fixed`
// (see the style block) the browser divides the container by these proportions, so the
// grid always fits its panel at any window size and each column's text wraps inside its
// own column. Percentages replaced a scatter of hand-guessed px/ch caps (max-width 320px,
// 46ch, min-width 210px…), each of which was a guess that held at one window width and
// truncated at another — the 2026-07-24 truncation bug, three times over. Retune by
// changing a share here; nothing else needs to know a width.
const COLUMNS = [
  // Tuned 2026-07-24 on the user's read: Model was taking more than it needed (its prose
  // wraps happily, so a narrower share just means another line), and Bench held a two-digit
  // number in a column sized for far more. Bench's floor is its own HEADER — the word
  // "Bench" plus the sort caret — not the data, which is why it can't go below ~5%.
  { key: "name", label: "Model", defDir: "asc", w: "29%" },
  { key: "type", label: "Type", defDir: "asc", w: "11%" },
  { key: "license", label: "License", defDir: "asc", w: "11%" },
  { key: "quality", label: "Bench", num: true, defDir: "asc", w: "5%" },
  { key: "fit", label: "Fit", defDir: "asc", w: "7%" },
  { key: "status", label: "Status", defDir: "asc", w: "17%" },
];
// The un-sortable Actions column takes the remainder. Shares total 100%.
const ACTIONS_W = "20%";
// The shared UiTable's column config, derived from COLUMNS above so the shares stay declared
// ONCE. UiTable owns the header markup, the sort state and the sort arrow; this component
// keeps the ORDERING, because the list is grouped (sections + a doesn't-fit divider) and
// sorted within each group — a plain row-model sort would flatten the sections away. That is
// what `manual-sorting` means on the table below.
const TABLE_COLUMNS = computed(() => [
  ...COLUMNS.map((c) => ({
    id: c.key,
    // An accessor is REQUIRED for a sortable column even though nothing here sorts by it:
    // TanStack's getCanSort() is `enableSorting && !!accessorFn`, so an id-only column
    // silently renders as unsortable — the header stops responding to clicks. The value it
    // reads is never used (every cell comes from a slot, and the ORDER comes from
    // sortModels() under `manual-sorting`).
    accessorKey: c.key,
    header: c.label,
    sortable: true,
    headerStyle: { width: c.w },
    meta: { headerClass: c.num ? "lu-th-num" : "" },
  })),
  { id: "actions", header: "Actions", sortable: false, headerStyle: { width: ACTIONS_W }, meta: { headerClass: "lu-th-act" } },
]);
// UiTable emits { id, desc }; the two refs above stay the source of truth for sortModels().
// A header click that CLEARS the sort (null) is impossible here — the table is mounted with
// `disable-sort-removal`, since an unsorted catalog has no meaningful order.
function onSortChange(s) {
  if (!s) return;
  sortKey.value = s.id;
  sortDir.value = s.desc ? "desc" : "asc";
}
// Section headers and the doesn't-fit divider span the whole grid instead of rendering cells;
// the returned class is what keeps the accent-edged section band and the quiet divider apart.
function isFullWidthRow(m) {
  if (m.__section) return "lu-msection";
  if (m.__divider) return "lu-mgroup";
  return false;
}
// Mixed list: model rows key on their id, sentinels on their own __key.
function rowKeyOf(m) {
  return m.__key || m.id;
}
function paramsNum(p) {
  const n = Number.parseFloat(String(p || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 999;
}
function matchesQuery(m) {
  const q = query.value.trim().toLowerCase();
  if (!q) return true;
  return (m.name || "").toLowerCase().includes(q) || (m.id || "").toLowerCase().includes(q);
}
// Sort value per column — strings compare with localeCompare, numbers ascend (lower first).
const FIT_SORT = { ok: 0, tight: 1, cpu: 2, no: 3, unknown: 4 };
const STATUS_SORT = { loaded: 0, loading: 1, stopping: 2, disk: 3, error: 4, available: 5 };
function sortVal(m, key) {
  if (key === "name") return (m.name || "").toLowerCase();
  if (key === "type") return typeOf(m) === "moe" ? 1 : 0;             // Dense before MoE
  if (key === "license") return (licenseOf(m) || "~~~").toLowerCase(); // blank sorts last
  if (key === "quality") return qualityOf(m);                          // lower rank = better
  if (key === "size") return sizeBytesById.value[m.id] || paramsNum(m.params) * 1e9;
  if (key === "fit") return FIT_SORT[m.fit] ?? 9;
  if (key === "status") return STATUS_SORT[m.status] ?? 9;
  return 0;
}
function sortModels(list) {
  const key = sortKey.value;
  const dir = sortDir.value === "desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = sortVal(a, key);
    const vb = sortVal(b, key);
    let c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    if (c === 0) c = (a.name || "").localeCompare(b.name || ""); // stable name tiebreak
    return c * dir;
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
    rows.push({ __section: CC.chatSectionLabel, hint: CC.chatSectionHint, __key: "sec-chat" });
    rows.push(...chatFit);
  }
  if (CC.showEmbedding && embedFit.length) {
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
    // first use. Through retryLoad (ONE workflow, 2026-07-21): the engine check +
    // install-if-missing run first, so a no-engine box installs then loads (this
    // also covers the General dropdown, which routes here via pickSlot).
    await retryLoad(m.id);
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
    // Chat leg through retryLoad → the engine check runs first (ONE workflow, 2026-07-21).
    // Embed stays lazy on its own ensure-embedding endpoint (untouched — the user's ruling).
    if (isEmbed) await request("/v1/llm-runner/ensure-embedding", { method: "POST" });
    else await retryLoad(m.id);
    refresh();
  } catch (e) { error.value = e.message || "Couldn't load."; }
  finally { applyingId.value = ""; }
}

const busy = ref(""); // CATALOG-op id in flight (delete) — distinct from the shared loadingId

// ── Fit + size display ─
// Sub-10 GB keeps one decimal for a genuine half (4.5), but the unary + drops a trailing
// ".0" so a real 8 GB floor reads "8", not "8.0" (2026-07-27, same ruling that snapped the
// seed floors to binary MB: "vram and ram usually only come in even sizes").
const gb = (mb) => (mb >= 10240 ? `${Math.round(mb / 1024)}` : `${+(mb / 1024).toFixed(1)}`);
function fitLabel(m) {
  // Embedding rows show WHERE THE POLICY PUTS THEM, not a raw-card VRAM grade
  // (2026-07-25, the user's catch: the old chip said "Fits · needs ~6.8 GB VRAM"
  // for a model the loader forces onto the CPU). The field comes from the server's
  // own placement rule, so chip and load can never disagree. `m.fit` itself is
  // untouched underneath — section grouping / FIT_RUNNABLE still read it.
  if (m.embedPlacement) return m.embedPlacement === "gpu" ? "GPU" : "CPU";
  return FIT_LABEL[m.fit] || "—";
}
function fitTitle(m) {
  if (m.embedPlacement === "cpu")
    return "Runs on the CPU on this PC — the GPU stays with your writing model. Needs "
      + (m.minRamMb ? `~${gb(m.minRamMb)} GB RAM.` : "system RAM, not VRAM.");
  if (m.embedPlacement === "gpu")
    return `Runs on your GPU here — it fits the ~${gb(m.embedLeftoverMb || 0)} GB left beside your writing model.`;
  if (m.fit === "cpu") return "No GPU detected — runs on CPU (slower).";
  if (m.fit === "unknown") return "VRAM requirement unknown for this model.";
  if (!m.minVramMb) return "";
  // The fit grade is a CURATED FLOOR compared against this card — never a measurement on
  // your box, so it says "Estimated" (2026-07-26, the user: "long as we present user with
  // correct info"). An untuned row adds the second honest fact: nobody has actually run it
  // at your class yet. ONLY this branch takes the prefix/suffix — the cpu / unknown /
  // no-floor / embed-placement returns above are already whole sentences, and appending a
  // fragment to them would splice (Ruling 6).
  const have = vramMb.value ? ` · you have ${gb(vramMb.value)} GB` : "";
  // isUntunedHere, NOT `=== ""` — "" now means only "the state fetch failed", and the
  // untuned case became two named states (2026-07-26). The old equality check would
  // have gone permanently false here and silently dropped this sentence.
  const untested = !embeddingOf(m) && isUntunedHere(tuneBadgeIdOf(tuneState.value, m.id, otherClassCount(m.id)))
    ? " · not yet tested on your PC class" : "";
  return `Estimated — needs ~${gb(m.minVramMb)} GB VRAM${have}${untested}`;
}
// Grid TYPE tags (Plan B — the Params column is REPLACED: the params count already
// rides the name/description, the user wants the space for architecture/role).
function typeOf(m) { return typeById.value[m.id] || "dense"; }
function mtpOf(m) { return mtpById.value[m.id] === true; }

// Model catalog meta (license / use-limited / description — the fit-shaped /models view
// doesn't carry them). Shared with QuickSetup through the useCatalogMeta singleton (one
// source, no drift); loadCatalogMeta (its refresh) re-pulls after a catalog edit.
const { qualityById, typeById, mtpById, embeddingById, licenseById, useLimitedById, descriptionById, poolingById, hfRepoById, notesById, sizeBytesById, minVramById, tierById, classTuneRefs, myClassKey, refresh: loadCatalogMeta } = useCatalogMeta();
function licenseOf(m) { return licenseById.value[m.id] || ""; }
function descriptionOf(m) { return descriptionById.value[m.id] || ""; }
function notesOf(m) { return notesById.value[m.id] || ""; }
// The sort fields, VISIBLE on the rows (#146 — sorting by an invisible column is
// opaque): the benchmark rank (100 = unranked) + the size (file size when known,
// else the params label riding the fit view).
// The benchmark rank moved to its own sortable Bench column (2026-07-22), so it no longer
// rides this line; the line carries the download SIZE plus, since 2026-07-26, the row's
// hardware story.
// 2026-07-26, the user's final shape after a full day of iterations: the row answers
// "what hardware does this run on" with the model's PC CLASSES — "for the models we
// ship we put them in hardware class so the user at least has an idea of what hardware
// they need" — NOT raw floor numbers (those read as engineer-speak, nearly duplicated
// the Fit hover, and once sat beside a class badge as two contradictory-looking
// figures). Size gets its OWN labelled line ("the 16gb should be size on disk its own
// row"). The raw floors survive in the Runs-on line's hover.
function rowSize(m) {
  const sz = sizeBytesById.value[m.id];
  return sz ? fmtBytes(sz) : (m.params || "");
}
/** The model's member PC classes, display-ordered (kit classTunes.js — the SAME
 *  membership rule the PC-class-configs library uses, so the two surfaces can never
 *  disagree). [] for embedding rows (placement story, not classes) and for rows with
 *  unknown floors (claim nothing rather than guess). */
function rowClasses(m) {
  if (embeddingOf(m)) return [];
  return memberClassesOf(m.minVramMb, m.minRamMb, hwClasses.value);
}
/** The hover over the row's "Needs …" line: the shipped PC classes this model covers.
 *  The floors are NOT repeated here — as of 2026-07-27 the row states them in plain
 *  words, and the hover carries the thing the row deliberately stopped enumerating.
 *  Empty when no shipped class clears the floors, so the hover never claims coverage
 *  that isn't there. */
function runsOnTitle(m) {
  // The "Needs" line's hover (fit-redesign §5.6): the row shows snapped TIERS,
  // the hover keeps the RAW computed numbers — plus the class list when the
  // model belongs to any. A model in NO shipped class (GLM after the user's
  // 2026-08-13 ruling) previously returned "" here and lost its tooltip
  // entirely; it now states the raw needs and says no class holds it.
  const raw = (m.minVramMb && m.minRamMb)
    ? `Computed from the model file: ${m.minVramMb.toLocaleString()} MB VRAM · ${m.minRamMb.toLocaleString()} MB RAM.`
    : "";
  const names = rowClasses(m).map((c) => classKeyLabel(c.classKey, c.name)).join(" · ");
  const classes = names
    ? `PC classes this model runs on: ${names}`
    : "No shipped PC class holds it — bigger machines than the class list covers.";
  return [raw, classes].filter(Boolean).join(" ");
}
// The Bench column cell: the published benchmark rank, or "—" when unranked (100).
function benchLabel(m) { const q = qualityOf(m); return q >= 100 ? "—" : String(q); }
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
// TOTAL card VRAM — feeds the embed-leftover pick below (leftover = the card minus
// the chat pick's floor). NOT useRunnerModels' vramMb: that is the budget-aware
// REMAINING VRAM (the /models endpoint subtracts the resident set) — with a model
// loaded it would shrink the leftover math.
// (The model recommendation itself no longer takes VRAM — §9, 2026-07-22: it keys
// on this box's CLASS via the catalog response's classTuneRefs + myClassKey.)
// The box's card, from the SHARED probe (2026-07-27). This used to be a private fetch
// reading `gpus[0].vramMb`, which is the wrong GPU on a laptop that enumerates its iGPU
// first — the composable applies the server's own largest-GPU rule (hardware.py:45).
// No hardware read → 0 → leftover 0 → CPU-band embeds only, as before.
const { maxVramMb: totalVramMb, hardwareLabel, refresh: refreshHardware } = useHardware();
refreshHardware();
const recommendedId = computed(() => recommendedModelId(models.value, {
  classTuneRefs: classTuneRefs.value,
  myClassKey: myClassKey.value,
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
// The hardware-class list, for the per-row "Runs on:" membership line (2026-07-26).
// One fetch at mount; classes change only through the PC-class-configs library, and
// its editors reload the whole panel — a stale minute here costs a label, not data.
// [] on failure: rows then render no Runs-on line rather than a wrong one.
const hwClasses = ref([]);
listClassTunes().then((res) => { hwClasses.value = res.classes || []; }).catch(() => {});
// How many OTHER classes carry switches for this model — the fact that separates
// "nobody has ever tuned this" from "tuned, just not for your box". Derived from the
// classTuneRefs already on the catalog response (no extra fetch); this box's own class
// is excluded, because that case is the stronger `class` state above it.
function otherClassCount(modelId) {
  const mine = tuneState.value?.classKey || "";
  return new Set(
    (classTuneRefs.value || [])
      .filter((r) => r.modelId === modelId && r.classKey && r.classKey !== mine)
      .map((r) => r.classKey),
  ).size;
}
// Every tag a row carries, in one list, so the template renders them as ONE group on
// their own line (2026-07-26, the user: "have both recommended and tuned by on same
// line but underneath the name"). They used to be inline siblings of the model name,
// so a row with two tags wrapped mid-flow and the second one landed under the first —
// ragged, and it read as if the tags belonged to different things. Built here rather
// than as four v-ifs in the markup so the row is also computed once, not per tag.
function rowTags(m) {
  const tags = [];
  if (m.id === currentEmbeddingId.value) {
    tags.push({ key: "embed", intent: "info", label: "Embedding" });
  }
  if (m.id === recommendedId.value) {
    tags.push({
      key: "rec", intent: "accent2", label: "Recommended for this PC",
      title: "What Quick Setup would pick for this machine — a model with a PC class config for your class first, then the speed-floor rule",
    });
  }
  const tune = tuneBadge(m);
  if (tune) tags.push({ key: "tune", ...tune });
  return tags;
}
function tuneBadge(m) {
  const others = otherClassCount(m.id);
  const id = tuneBadgeIdOf(tuneState.value, m.id, others);
  if (!id) return null; // state unavailable (fetch failed) — a tag would be a guess
  // An embedding row's story is PLACEMENT (CPU by policy), not tuning, so it does not
  // get told it is "Not tuned" — the same exclusion the fit hover already makes
  // (fitTitle's `!embeddingOf(m)`). It DOES keep a tag when genuinely tuned, because
  // then the fact is real and worth showing.
  if (embeddingOf(m) && isUntunedHere(id)) return null;
  const classRange = classKeyLabel(tuneState.value?.classKey || "");
  const titles = {
    auto: "This PC runs your applied config — produced by the auto-tune sweep",
    hand: "This PC runs your applied config — hand-set in Tune & measure",
    // The range is dropped, not printed empty, when the box's class is unknown:
    // classKeyLabel("") returns "" (classTunes.js:134-138) and "for your class ()"
    // would read as a bug.
    class: `No applied config on this PC — launches start from the PC class config for your class${classRange ? ` (${classRange})` : ""}`,
    elsewhere: `Nothing tuned for your PC class${classRange ? ` (${classRange})` : ""} — but this model has a PC class config on ${others} other ${others === 1 ? "class" : "classes"}. Launches use the layered defaults.`,
    untuned: "Nobody has tuned this model on any PC class yet — launches use the layered defaults.",
  };
  const badge = { ...TUNE_BADGES[id], title: titles[id] };
  // The COUNT is what makes "not tuned here" worth saying — bare, it is the absence
  // this change exists to kill. The class NAME is deliberately NOT appended any more
  // (2026-07-26, the user: "as a user i see 'PC class config · 8 GB VRAM · 32 GB RAM'
  // and i think that is what hardware it runs under"): rendering your machine's spec
  // inside a tuning tag, one line from the model's OWN hardware requirement, made the
  // two read as contradictory numbers about the same thing. Your class is now stated
  // once above the table instead of on every row.
  if (id === "elsewhere") {
    badge.label = `${badge.label} — ${others} other PC ${others === 1 ? "class" : "classes"}`;
  }
  return badge;
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
  // An OWN draft (same repo) the built-in engine can load — auto-picked → CERTAIN, MTP on.
  if (e.mtpDraftFile && !e.mtpDraftRepo) return "separate — external draft file (separate download)";
  // Own drafts present but NONE the built-in engine can load (e.g. dspark) → the model IS
  // MTP-capable, just not for our engine. Conservative (the user's rule, 2026-07-21): MTP stays
  // OFF, its own drafts stay in the dropdown (labeled), the user can check MTP + paste a
  // compatible one. NO borrow substitution (it ships its own).
  if (allDraftsUnloadable(listing.value?.drafts))
    return "this model ships an MTP draft, but none the built-in engine can load — check MTP below to paste a compatible draft";
  // A draft from ANOTHER repo: applied by the user → describe it; the PRE-FILLED tier-C guess
  // (MTP off) → say it may work and point at the opt-in.
  if (e.mtpDraftFile && e.mtpDraftRepo)
    return e.mtp
      ? "separate — external draft from another repo (separate download)"
      : "the base family may support MTP — a drafter is pre-filled; check MTP below to try it or paste your own";
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
    // An unloadable draft (arch the engine can't load) stays selectable — a forced pick
    // hits the load-time "unknown model architecture" fail-fast — but its label says so,
    // so it never reads as a normal option (UiSelect has no per-option disable).
    label: `${d.path}${d.quant ? ` · ${d.quant}` : ""}${d.sizeMb ? ` · ${gb(d.sizeMb)} GB` : ""}${d.loadable === false ? ` — ${d.unsupportedArch || "arch"} not supported by your engine` : ""}`,
  })),
]);
// The repo ships draft(s) but the engine can load NONE — the form leaves MTP off and says
// why (a model whose card advertises MTP must not show a silent unexplained gap).
const onlyUnsupportedDrafts = computed(() => allDraftsUnloadable(listing.value?.drafts));
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
    // recommended-for-box default when no quant chosen yet (v1 heuristic: largest
    // quant whose file size fits the detected VRAM; nothing fits → smallest ≥4-bit,
    // only then truly smallest — the shared helper, fit-redesign §4 0.4: the old
    // bare-smallest fallback handed an 8 GB box a 1-bit IQ1_M).
    if (!e.quant && r.quants.length) {
      e.quant = pickDefaultQuant(r.quants, vramMb.value);
    }
    // detect pre-select (D9): a repo shipping an MTP draft pre-picks the smallest one AT
    // THE FLOOR when the model has none configured — but ONLY among drafts the engine can
    // load. Loadability is the floor BELOW the 4-bit floor: a draft whose arch our engine
    // can't load (e.g. dspark; server-side `loadable` flag) can only fail at spawn, so it
    // is never a candidate and MTP is not auto-armed on it. Among loadable drafts, small
    // wins (a draft only affects SPEED — the main model verifies every token — while its
    // weights+KV re-read each cycle and take VRAM from main layers), and `q4OrBetter` is
    // the bit-width floor under that. The rule (filter + rank) is the shared pure helper so
    // JW's vitest can exercise it; bigger-is-better across drafter sizes is machine-
    // dependent, timed by Tune & measure (docs/plans/2026-07-19-draft-fit-floor-and-lab-measure.md).
    if (r.drafts.length && !e.mtpDraftFile) {
      const pick = pickDefaultDraftPath(r.drafts);
      if (pick) onDraftPick(pick);
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
  // stale — clear it; the auto re-inspect below refreshes it live.
  editing.value.sizeBytes = null;
  // The quant IS the file (fit-redesign §4 0.3, the IQ1-ghost fix): changing it
  // changes every derived fact, so selecting one re-reads the header — decree #143
  // ("read from link updates all fields") applied to the one input that decides
  // WHICH file the row describes. Snapshot-compare inside inspectLink keeps a
  // user-typed Name/Description safe on this auto path.
  if (editing.value.hfRepo?.trim()) inspectLink({ auto: true });
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

// Last-write-wins guard for inspect responses: a user flipping quants faster than
// the header range-reads resolve must never get an older read's fields written over
// a newer pick (fit-redesign §4 0.3 — the awaits complete in finish order).
let inspectSeq = 0;
// What composedName()/composedDescription() last produced — the snapshot the auto
// path compares against so it regenerates ONLY untouched fields (a user-typed Name
// is never clobbered by a quant flip; an EXPLICIT Read-from-link still regenerates
// everything, decree #143).
const lastComposed = { name: null, description: null };
async function inspectLink({ auto = false } = {}) {
  const e = editing.value;
  if (!e?.hfRepo?.trim()) { inspectErr.value = "Enter the Hugging Face repo first."; return; }
  const seq = ++inspectSeq;
  inspecting.value = true; inspectErr.value = ""; inspected.value = null;
  try {
    // ONE click fills everything: the repo listing (quant options + draft
    // detect + a recommended quant when blank) THEN the header inspect, which
    // needs the chosen quant. Listing failure is non-fatal (free-type remains).
    await loadRepoFiles();
    const params = new URLSearchParams({ repo: e.hfRepo.trim(), quant: e.quant || "" });
    const r = await request(`/v1/ai/model-catalog/inspect?${params}`, { method: "POST" });
    if (seq !== inspectSeq) return;  // a newer pick's read superseded this one
    // File-derived scalar facts flow into the draft (persisted by the Save PUT);
    // the sampler set persists from the local file at download (identify → set_derived).
    e.type = r.type || "dense";
    // MTP split (2026-07-13): identity reads the header BUILT-IN truth (`mtpBuiltin`),
    // never the enable flag — so the download read can no longer clobber the box.
    e.mtpBuiltin = !!r.mtpBuiltin;
    // Enable MTP only when CERTAIN (the user's rule, 2026-07-21) — built-in heads, or an OWN
    // draft the built-in engine can LOAD. "Own" means IN THIS REPO'S LISTING — a bare
    // "e.mtpDraftFile is set" check mistook the BORROWED base-family drafter (pre-filled
    // by an earlier read, a guess that must never auto-enable) for an own draft on every
    // RE-read, silently checking MTP on a model whose header has none (caught live
    // 2026-08-13: the 35B's quant flip armed MTP off its own borrow).
    const ownLoadableDraft = !!e.mtpDraftFile && (listing.value?.drafts || []).some(
      (d) => d.path === e.mtpDraftFile && d.loadable !== false,
    );
    // PRE-FILL a discovered base-family drafter (the tier-C "borrow") ONLY when the model ships
    // NO draft of its own — a model with own drafts (even ones this engine can't load, e.g.
    // dspark) is MTP-capable just not for our machine: never substitute a guessed borrow. With
    // no own drafts, the borrow pre-fills (repo/file) so the fields are READY if the user
    // enables MTP — but it is a GUESS, so it never auto-enables; the user opts in and can
    // paste a different repo per normal.
    const hasOwnDrafts = (listing.value?.drafts || []).length > 0;
    if (!e.mtpDraftFile && r.mtpInheritedFile && !hasOwnDrafts) {
      e.mtpDraftRepo = r.mtpInheritedRepo || "";
      e.mtpDraftFile = r.mtpInheritedFile || "";
      e.mtpDraftQuant = r.mtpInheritedQuant || "";
    }
    // Auto-CHECK only the CERTAIN cases: built-in, or an own LOADABLE draft already picked.
    e.mtp = !!r.mtpBuiltin || ownLoadableDraft;
    e.trainedCtx = r.trainedCtx ?? null;
    if (r.totalParams) e.totalParams = r.totalParams; // file-derived (dense); MoE stays curated
    // Chat floors are COMPUTED server-side from the physics facts now (§13.11) —
    // the form no longer fills or edits them; only EMBED rows keep curated floors.
    if (e.embedding) {
      if (!e.minVramMb && r.estVramMb) e.minVramMb = r.estVramMb;
      if (!e.minRamMb && r.estRamMb) e.minRamMb = r.estRamMb;
    }
    // Identity facts persist on the row (#141 — Edit-open == Read-from-link):
    // …and the §13.11 physics facts ride along (the PUT persists them; the
    // server computes floors/est FRESH from them on every read).
    e.physicsFacts = r.physicsFacts || e.physicsFacts || null;
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
    // Auto path (quant flip): regenerate ONLY fields still equal to what we last
    // composed (or blank) — the user's own text survives. Explicit path: decree #143.
    if (!auto || !e.description || e.description === lastComposed.description) {
      e.description = composedDescription();
      lastComposed.description = e.description;
    }
    // The Name is model-owned the same way: Load-from-HF regenerates it from the
    // just-read repo + quant so it can't stay stale (it stays editable afterward).
    if (!auto || !e.name || e.name === lastComposed.name) {
      e.name = composedName();
      lastComposed.name = e.name;
    }
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

// Free a model's downloaded weights while KEEPING its catalog entry (the disk-reclaim
// counterpart to Delete, which also removes the row, and to Re-download, which re-fetches
// after). models-cache/delete KEEPS the catalog row, so the model returns to "not downloaded"
// and re-downloads on demand. A RESIDENT model is unloaded FIRST (its GGUF is mmap-locked),
// exactly as redownload does; on unload failure the error surfaces and nothing is deleted.
async function freeDownload(m) {
  const ok = await confirmDialog({
    title: `Delete the downloaded model "${m.name || m.id}"?`,
    message: "Deletes its downloaded weights from disk. The model stays in your catalog and re-downloads on demand. A loaded model is unloaded first.",
    confirmLabel: "Delete downloaded model",
  });
  if (!ok) return;
  busy.value = `free:${m.id}`; // own namespace so its spinner ≠ Delete's / Re-download's / the row load spinner
  error.value = "";
  try {
    if (m.status === "loaded") await stopModel(m);
    await request("/v1/llm-runner/models-cache/delete", { method: "POST", body: { modelId: m.id } });
    await refresh(); // re-pull so the row flips to "Not downloaded" and this button hides
  } catch (e) { error.value = e.message || "Couldn't free the download."; } finally { busy.value = ""; }
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
              ? `${CC.generalUse} — every task uses it unless you override a task. Changing it swaps the loaded model.`
              : recommendedId
                ? `${CC.generalUse} — we recommend ${nameOf(recommendedId)} for this PC.`
                : `${CC.generalUse} — pick one to get started.` }}
        </div>
        <div v-if="defaultModel && !defaultGone" class="lu-setup-live">
          <span v-if="slotState(defaultModel) === 'loaded'" class="lu-pill lu-pill--run">● loaded</span>
          <!-- Unload isn't a download — a plain "Unloading…" indicator, not the bar. -->
          <span v-else-if="slotState(defaultModel) === 'stopping'" class="lu-muted">Unloading…</span>
          <!-- THE shared control (QuickSetup's bar — same createDownloadTask, phases, Cancel). -->
          <DownloadBar v-else-if="slotState(defaultModel) === 'working'"
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
      <div v-if="CC.showEmbedding" class="lu-setup-card" :class="{ 'lu-setup-card--empty': !embeddingName || embeddingGone }">
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
          <span v-else-if="slotState(embeddingModel) === 'stopping'" class="lu-muted">Unloading…</span>
          <DownloadBar v-else-if="slotState(embeddingModel) === 'working'"
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
    <p class="lu-setup-cap lu-muted">{{ CC.slotsFootnote }}</p>

    <!-- #10 (user, 2026-07-08): a real section heading over the catalog. -->
    <div class="lu-mcat-title">Model Catalog</div>
    <!-- THIS PC, stated ONCE (2026-07-26). It used to be appended to every class
         badge, where it sat beside each model's own VRAM/RAM requirement and read as
         a second, contradictory requirement. It is the same for every row — so it
         belongs above the table, not in it.
         It states the MACHINE, not its class (2026-07-27 — the user's ruling, applied
         here on its third instance): this printed `classKeyLabel(tuneState.classKey)`,
         i.e. the class FLOOR under a "This PC" heading. On a box whose hardware happens
         to equal its floor that is invisible; on a 10 GB / 48 GB machine it stated
         "8 GB VRAM · 32 GB RAM" and was wrong on both numbers. The class still shows,
         after the hardware, because it is what every row's Runs-on hover is keyed to. -->
    <div v-if="hardwareLabel || tuneState?.classKey" class="lu-mcat-thispc lu-muted">
      This PC · <b>{{ hardwareLabel || classKeyLabel(tuneState.classKey) }}</b>
      <span v-if="hardwareLabel && tuneState?.classKey">
        — PC class {{ classKeyLabel(tuneState.classKey) }}</span>
    </div>
    <div class="lu-mcat-bar">
      <UiInput v-model="query" class="lu-mcat-search" placeholder="Search models…" />
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
      <!-- The shared UiTable (2026-07-24) — this grid used to be one of six hand-rolled
           copies of "a table with sortable headers and hand-guessed widths". UiTable owns the
           header markup, the sort state and the sort arrow; the ORDERING stays here because
           the list is grouped into sections and sorted within each, which a plain row-model
           sort would flatten (hence `manual-sorting`). The three look modifiers are the kit's
           opt-in classes: shares-not-content widths, a pinned header, top-aligned cells. -->
      <UiTable
        class="lu-mgrid ui-table-fixed ui-table-sticky ui-table-top"
        :data="groupedRows"
        :columns="TABLE_COLUMNS"
        :data-key="rowKeyOf"
        :full-width-row="isFullWidthRow"
        :default-sort="{ id: sortKey, desc: sortDir === 'desc' }"
        manual-sorting
        disable-sort-removal
        @update:sort="onSortChange"
      >
        <template #full-row="{ row: m }">
          <template v-if="m.__section"><b>{{ m.__section }}</b><span class="lu-muted"> — {{ m.hint }}</span></template>
          <template v-else>Doesn't fit this machine — {{ m.count }} more</template>
        </template>

        <template #name="{ row: m }">
              <div class="lu-mn">
                <span class="lu-mn-name">{{ m.name }}</span>
                <!-- The row's tags on their OWN line, all together (see rowTags): the
                     Embedding marker, the Quick-Setup recommendation, and the §7.6
                     tune-provenance tag (five named states since 2026-07-26 — a blank
                     row could not distinguish "tuned on five other classes" from "never
                     tuned anywhere"). The DEFAULT indicator is NOT here: it is the
                     right-aligned green "Default ✓" button, one place, aligned with the
                     provider rows (2026-07-17). `:empty` hides the line on a row with no
                     tags, so it costs no space rather than needing a v-if. -->
                <div class="lu-mtags">
                  <UiTag v-for="t in rowTags(m)" :key="t.key" :intent="t.intent"
                    class="lu-mbadge" :title="t.title">{{ t.label }}</UiTag>
                </div>
                <!-- The catalog id line was REMOVED 2026-07-26 (the user: "Qwen3.6 27B
                     (MTP) / qwen3.6-27b diplicate name"). On a chooser row the id restates
                     the name in slug form; it is still shown and editable in the model's
                     Edit form, which is where you need it to match a config or a repo. -->
                <!-- Two labelled facts, each on its own line (the user's final shape,
                     2026-07-26): the download size, then the model's PC classes — the
                     answer to "what hardware does this run on" (see rowClasses). -->
                <div v-if="rowSize(m)" class="lu-mrowmeta lu-muted" title="Download size on disk">
                  Size on disk · {{ rowSize(m) }}
                </div>
                <!-- WHAT HARDWARE THIS NEEDS, in plain words on the row; the enumeration
                     of PC classes moved to the hover (2026-07-27, the user's call after
                     seeing both). The floors answer the question actually being asked —
                     "will this run on my PC" — and compare directly against the VRAM/RAM
                     the AI page header states for this box. The class LIST answers a
                     different, maintainer-shaped question ("which of the shipped classes
                     cover it"), and enumerating it on the row cost either readability
                     (eight full labels) or plain English (the cryptic "8|32" form).
                     Keyed on the FLOORS, not on rowClasses(): a model whose floors clear
                     no shipped class still has known requirements and must state them
                     rather than fall through to "unknown". -->
                <div v-if="!embeddingOf(m) && m.minVramMb && m.minRamMb"
                  class="lu-mrowmeta lu-muted" :title="runsOnTitle(m)">
                  <!-- Display snaps UP real hardware sizes (§5.6/§8.15); the floors
                       themselves stay RAW (stored+compared) — the hover keeps raw. -->
                  Needs {{ displayVramGb(m.minVramMb) }} GB VRAM · {{ displayRamGb(m.minRamMb) }} GB RAM
                </div>
                <div v-else-if="!embeddingOf(m)" class="lu-mrowmeta lu-muted">
                  Hardware needs unknown — edit the model to set its requirements
                </div>
                <div v-if="descriptionOf(m)" class="lu-mdesc">{{ descriptionOf(m) }}</div>
                <div v-if="notesOf(m)" class="lu-mnotes">Your notes: {{ notesOf(m) }}</div>
                <a v-if="cardUrlOf(m)" class="lu-mlink lu-mcardlink" :href="cardUrlOf(m)"
                  target="_blank" rel="noopener" title="Open the model's Hugging Face page — full details, files, license"
                  @click.prevent="openExternal(cardUrlOf(m))">Model card ↗</a>
              </div>
        </template>

        <template #type="{ row: m }">
              <div class="lu-mm lu-mtype">
                <!-- Params column REPLACED (Plan B — the count already rides name/description).
                     Architecture + capabilities: Dense/MoE is the type; MTP/Embed are flags. -->
                <LuModelTypeTag :type="typeOf(m)" class="lu-typetag" />
                <UiTag v-if="mtpOf(m)" intent="info" class="lu-typetag" title="Multi-token prediction — speculative decode enables by default">MTP</UiTag>
                <UiTag v-if="embeddingOf(m)" intent="accent2" class="lu-typetag" title="Embedding model — powers semantic search + grounded chat">Embed</UiTag>
              </div>
        </template>

        <template #license="{ row: m }">
                <span v-if="licenseOf(m)" class="lu-lic" :class="{ 'lu-lic--warn': useLimitedOf(m) }" :title="licenseTitle(m)">
                  <template v-if="useLimitedOf(m)">⚠ </template>{{ licenseOf(m) }}
                </span>
                <span v-else class="lu-muted">—</span>
        </template>

        <template #quality="{ row: m }">
              <div class="lu-mnum">
                <span :class="['lu-bench', { 'lu-bench-none': qualityOf(m) >= 100 }]"
                  title="Published general-purpose benchmark rank (lower = better); “—” = unranked">{{ benchLabel(m) }}</span>
              </div>
        </template>

        <template #fit="{ row: m }">
                <span class="lu-fit" :class="`lu-fit--${m.fit}`" :title="fitTitle(m)">{{ fitLabel(m) }}</span>
        </template>

        <template #status="{ row: m }">
                <span v-if="m.status === 'loaded'" class="lu-pill lu-pill--run">● loaded</span>
                <span v-else-if="m.status === 'stopping'" class="lu-mstat">Unloading…</span>
                <!-- THE one shared DownloadBar for every in-flight / failed row — the SAME
                     control + SAME createDownloadTask as the panels + cards (ONE mechanism,
                     2026-07-21), Cancel/Retry built into the bar; a load error renders in the
                     bar's error line with its Retry running the engine-check workflow. -->
                <DownloadBar v-else-if="m.status === 'loading' || m.status === 'error'"
                  class="lu-mgrid-dlbar" :title="m.name" :task="taskFor(m.id)" />
                <span v-else-if="m.status === 'disk'" class="lu-pill lu-pill--disk">Downloaded</span>
                <span v-else class="lu-mstat">Not downloaded</span>
        </template>

        <template #actions="{ row: m }">
                <div class="lu-macts">
                  <UiButton intent="ghost" size="small" title="Edit catalog fields" @click="startEdit(m)">Edit</UiButton>
                <!-- Cancel lives IN the status-cell DownloadBar now (task.cancel — one control,
                     both channels: a spawn-LOAD aborts via /stop, a download via /download/cancel).
                     So the load/download CTAs simply HIDE while loading; no per-row Cancel button. -->
                <template v-if="m.status !== 'loading'">
                  <UiButton v-if="m.status === 'available'" intent="primary" size="small"
                    :loading="loadingId === m.id" @click="download(m.id)">Download</UiButton>
                  <!-- Green when it IS the default (2026-07-17, user: "make it green when default
                       is true"); disabled greys out, so the default stays ENABLED + clickable
                       (re-apply is idempotent). Embed vs general differ only in the TARGET. -->
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
                </template>
                  <!-- ⋯ overflow — the secondary actions, portaled so the menu escapes the
                       list's overflow:auto clip (Reka DropdownMenu: focus/Esc/click-outside built in).
                       "Load into memory" is NOT here — loading a model IS setting it default
                       (makeDefault), which is the inline toggle above (user, 2026-07-22). -->
                  <DropdownMenuRoot>
                    <DropdownMenuTrigger class="lu-mkebab" aria-label="More actions" title="More actions">⋯</DropdownMenuTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuContent class="lu-mmenu" align="end" :side-offset="4" :collision-padding="8">
                        <DropdownMenuItem v-if="m.status === 'loaded' || m.status === 'disk'" class="lu-mmi" @select="tuning = m">Tune &amp; measure</DropdownMenuItem>
                        <DropdownMenuItem v-if="m.status === 'loaded'" class="lu-mmi" @select="unloadModel(m)">Unload from memory</DropdownMenuItem>
                        <DropdownMenuItem v-if="m.status === 'error' || m.status === 'disk' || m.status === 'loaded'" class="lu-mmi" @select="redownload(m)">Re-download</DropdownMenuItem>
                        <DropdownMenuSeparator v-if="m.status === 'loaded' || m.status === 'disk' || m.status === 'error'" class="lu-mmsep" />
                        <DropdownMenuItem v-if="m.downloaded && m.status !== 'loading' && m.status !== 'stopping'" class="lu-mmi lu-mmi-danger" @select="freeDownload(m)">Delete downloaded model</DropdownMenuItem>
                        <DropdownMenuItem class="lu-mmi lu-mmi-danger" @select="deleteModel(m)">Delete from catalog</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenuPortal>
                  </DropdownMenuRoot>
                </div>
        </template>
      </UiTable>
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
        <!-- Honest gap (2026-07-21): a repo whose only draft uses an arch the engine can't
             load (e.g. dspark) leaves MTP off — say WHY, so a model whose card advertises
             MTP doesn't read as a silent unexplained blank. Built-in MTP needs no draft. -->
        <div v-if="onlyUnsupportedDrafts && !editing.mtpBuiltin" class="lu-mm-note"><span class="lu-muted">MTP left off — this repo's draft uses an architecture your engine can't load<template v-if="listing?.drafts?.[0]?.unsupportedArch"> ({{ listing.drafts[0].unsupportedArch }})</template>.</span></div>

        <!-- Consistency (2026-07-13, decision A): each capability checkbox REVEALS +
             owns its config below, in checkbox order (MoE · MTP · Embedding); uncheck
             hides it. MoE/MTP change resolved switches via switch_resolve; Embedding
             drives placement + pooling (its own plane) — same interaction, uniform. -->
        <template v-if="editing.type === 'moe'">
          <div class="lu-mm-note"><b>MoE</b> <span class="lu-muted">— experts offload to system RAM; the launch pins layers on GPU and frees VRAM via CPU MoE layers (adds <code>no_mmap</code> at load). Tune <code>n_cpu_moe</code> per box in Tune &amp; measure.</span></div>
        </template>

        <template v-if="editing.mtp">
          <div class="lu-mm-note"><b>MTP config</b> <span class="lu-muted">—
            <template v-if="editing.mtpBuiltin">built-in prediction heads; no external draft needed. </template>
            <template v-else>runs via an external speculative-decode draft file (a separate download). </template>
            Enabling adds <code>spec_type=draft-mtp</code> at load; uncheck to turn MTP off.</span></div>
          <label class="lu-mm-l">Draft file <span class="lu-muted">{{ editing.mtpBuiltin ? "optional — built-in MTP" : "the speculative-decode model (feeds --model-draft)" }}</span>
            <!-- Dropdown = THIS repo's own drafts. When a DIFFERENT draft repo is set (a pre-filled
                 base-family guess, or one the user pasted), its file lives in that other repo — not
                 in this repo's listing — so it's a free-type field the user can edit. -->
            <UiSelect v-if="listing?.drafts?.length && !editing.mtpDraftRepo" :model-value="editing.mtpDraftFile"
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

        <div class="lu-mm-note"><b>Fit estimate</b> — computed from the model file itself (read the link once and the app knows what the file needs); nothing here for you to figure out. Embedding models keep hand-set floors — they steer the wizard, not the badge.</div>
        <div class="lu-mm-row">
          <label class="lu-mm-l">Total params<UiInput v-model="editing.totalParams" placeholder="14B" /></label>
          <label class="lu-mm-l">Active params <span class="lu-muted">MoE only</span><UiInput v-model="editing.activeParams" placeholder="3.6B" /></label>
        </div>
        <!-- Fit-redesign §13.17: the floor INPUTS retired for chat rows — the user
             never types a memory number; the server computes floors fresh from the
             file's stored facts on every read. Embeds keep the curated inputs
             (§8.6 — wizard-steering values embed_placement gates on). -->
        <div v-if="editing.embedding" class="lu-mm-row">
          <label class="lu-mm-l">Min VRAM (MB)<UiInput v-model.number="editing.minVramMb" type="number" placeholder="11000" /></label>
          <label class="lu-mm-l">Min RAM (MB)<UiInput v-model.number="editing.minRamMb" type="number" placeholder="14000" /></label>
        </div>
        <div v-else-if="editing.minVramMb && editing.minRamMb" class="lu-mm-note lu-muted">
          Needs {{ displayVramGb(editing.minVramMb) }} GB VRAM · {{ displayRamGb(editing.minRamMb) }} GB RAM — computed from the file, updates on read.
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
/* The list scroller. 260px showed barely one-and-a-half of the tall (description +
   notes) rows — the "cramped" read (user, 2026-07-24). Sized to the window with a cap,
   the AppModal.vue:221 precedent for a vh-bounded scroller. */
/* Viewport-relative, not a pixel guess: the list gets a share of the window height and
   scrolls past it (the old fixed 260px showed barely one-and-a-half of the taller rows). */
.lu-mcat-wrap { max-height: 58vh; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-sm, 8px); background: var(--surface); }
/* Fit-to-data (user, 2026-07-22 — "too wide, fit the data"): the table sizes to its
   CONTENT, not a forced width:100% stretch. Narrow columns shrink (nowrap); only the
   Model column grows, wrapping its description within a cap. */
/* PROPORTIONAL, not hand-measured (user, 2026-07-24: "hardcoding px width height is bad
   coding" — and they were right; this table had accumulated max-width 320px, 46ch,
   min-width 160px, min-width 210px and a 260px scroller, each a guess that held at one
   window size and truncated at another).
   `table-layout: fixed` + `width: 100%` + the per-column SHARES in COLUMNS: the browser
   divides the container, so the grid can never exceed its panel (the old `width: auto`
   grew to 1238px inside a 1106px wrap and pushed Status/Actions out of sight) and every
   cell's text wraps inside its own column with no cap to maintain. */
/* `table-layout: fixed`, the pinned header and the top-aligned cells now come from the kit's
   opt-in classes on the component (`ui-table-fixed ui-table-sticky ui-table-top`) — the three
   behaviours this table needed are ones any data grid eventually wants, so they live in
   common/styles.css rather than being re-declared per component. What stays here is what is
   genuinely this catalog's own: its slightly smaller type and its cell contents. */
.lu-mgrid :deep(.ui-table) { font-size: 12.5px; }
.lu-mgrid :deep(.ui-table thead th) { border-bottom: 1px solid var(--border); }
/* TOP-aligned, not middle (user, 2026-07-24 — the columns "read misaligned"): the Model
   cell runs 5-7 lines (name · id · size · description · notes · card link) while Type /
   License / Bench / Fit / Status / Actions are one line each, so centering floated every
   badge in the middle of a tall row, level with nothing. Top-aligned, each cell lines up
   with the model NAME — the row's anchor. */
/* Cells WRAP. `nowrap` here is what forced the table wider than its panel: every column
   demanded its full single-line width and the grid grew past the container, clipping the
   right-hand end. Top-aligned so one-line cells sit level with the model NAME instead of
   floating mid-row against a 5-7 line Model cell. Chips keep their own `nowrap` below, so
   a badge still never breaks mid-word. */
/* Cells WRAP: `nowrap` is what once forced the grid wider than its panel, every column
   demanding its full single-line width until the right-hand end clipped. Chips keep their own
   nowrap below, so a badge still never breaks mid-word. */
.lu-mgrid :deep(.ui-table tbody td) { padding: 9px 11px; border-bottom: 1px solid var(--border); white-space: normal; overflow-wrap: anywhere; }
.lu-mgrid :deep(.ui-table tbody tr:last-child td) { border-bottom: 0; }
/* The numeric + actions headers align right; the kit's header handles the rest (click to
   sort, the caret on the active column, the hover and active colours). */
.lu-mgrid :deep(th.lu-th-num) .ui-table-th-inner,
.lu-mgrid :deep(th.lu-th-act) .ui-table-th-inner { justify-content: flex-end; }
.lu-mgrid :deep(th.lu-th-num), .lu-mgrid :deep(th.lu-th-act) { text-align: right; }
/* Bench column — right-aligned, tabular. */
.lu-mnum { text-align: right; font-variant-numeric: tabular-nums; }
.lu-bench { font-weight: 600; color: var(--ink-2); }
.lu-bench-none { color: var(--muted); font-weight: 400; }
/* Model is the ONE column that grows; its text wraps within a cap so the table stays tidy. */
/* No width here at all — the Model column's share is declared once in COLUMNS. */
.lu-mn { font-weight: 600; color: var(--ink); }
.lu-mrowmeta { font-size: 10.5px; font-weight: 400; margin-top: 1px; }
/* The row's hardware line needs no rules of its own — it is one short sentence in the
   shared .lu-mrowmeta/.lu-muted treatment, like "Size on disk · …" above it. The chip
   styling that briefly lived here (2026-07-26) went with the class enumeration when that
   moved to the hover; recover it from git if a chip list is ever wanted again. */
/* No max-width: the description and notes simply fill the Model column and wrap in it.
   Under `table-layout: fixed` the column owns the width, so these need no cap of their
   own — the previous attempts put one on the <td> (ignored under `table-layout: auto`)
   and then on these children (a number to keep in sync forever). */
.lu-mdesc { font-size: 11px; color: var(--ink-2); font-weight: 400; margin-top: 3px; line-height: 1.4; }
.lu-mnotes { font-size: 10.5px; color: var(--muted); font-weight: 400; font-style: italic; margin-top: 2px; line-height: 1.4; }
.lu-setup-pick { margin-top: 7px; }
/* Default / Embedding badges sit inline after the model name; the fit-group divider row. */
.lu-mbadge { margin-left: 6px; vertical-align: middle; }
/* The tag line sits UNDER the model name and keeps every tag together (2026-07-26).
   flex + wrap so two long tags wrap as a GROUP instead of the second one drifting up
   beside the name; `gap` owns the spacing, so the inline margin above is cancelled
   here. `:empty` collapses the line entirely on a row that has no tags. */
.lu-mtags { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 3px; }
.lu-mtags:empty { display: none; }
.lu-mtags .lu-mbadge { margin-left: 0; }
.lu-mgrid :deep(.lu-mgroup td) { background: var(--surface-2); color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; padding: 5px 11px; }
/* The Type cell holds chips: let them WRAP onto a second line when the column is narrow
   (each chip stays intact via its own nowrap) rather than widening the table. */
.lu-mm { color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px; }
.lu-typetag, .lu-mm :deep(.ui-tag) { white-space: nowrap; }
/* WRAPS. Measured at the app's minimum window (1000px, tauri.conf.json): the button
   cluster needed +31px more than its cell and overran it on 14 rows. Wrapping lets the
   buttons stack on a narrow window instead of spilling out of the column — no width to
   maintain, and it stays a single row at every wider size. */
.lu-macts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; justify-content: flex-end; }
/* ⋯ overflow trigger — NOT portaled (it lives in the row), so it stays scoped. The
   portaled menu CONTENT (.lu-mmenu / .lu-mmi / .lu-mmsep) moved to common/styles.css
   beside .ui-select-content: Reka teleports the content to <body>, where a component's
   <style scoped> hash doesn't reach — the background/border silently dropped and the
   menu rendered see-through (user, 2026-07-24). UiSelect learned this same lesson (its
   content styles are global, not scoped); this restores the parity. */
.lu-mkebab { all: unset; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 7px; border-radius: 6px; color: var(--muted); }
.lu-mkebab:hover, .lu-mkebab[data-state="open"] { background: var(--surface-2); color: var(--ink); }

/* License badge — neutral for permissive (Apache/MIT), a gold warning chip for
   use-limited licenses (Llama-Community, *-Research, Gemma terms). */
/* The badge WRAPS rather than forcing its column wider: the longest license name
   ("Llama-Community") needed +28px past its cell at the 1000px minimum window. Two lines
   inside the pill is better than a clipped column. */
.lu-lic { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); background: var(--surface); text-align: center; }
.lu-lic--warn { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }

/* .lu-pill* moved to shared common/styles.css (used by the grid too). */
.lu-mstat { font-size: 11px; color: var(--muted); }
/* The SAME shared DownloadBar inside a grid STATUS cell — drop the card top-margin, give it
   room, and re-allow wrapping (the grid td is nowrap). BOUNDED 2026-07-24: a failed download
   renders the server's message, which for an HF error carries a ~120-character UNBROKEN url;
   with a min-width that string forced the Status column far past it and swamped the row
   (user screenshot, the StyleTune 429). The bar now simply FILLS its column — the column's
   share governs, so there is no width here to keep in sync — and break-anywhere keeps a
   long error URL readable inside it. */
.lu-mgrid-dlbar { margin-top: 0; width: 100%; white-space: normal; }
.lu-mgrid-dlbar :deep(*) { overflow-wrap: anywhere; }

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
.lu-mgrid :deep(.lu-msection td) {
  padding: 9px 11px 8px;
  font-size: 12.5px;
  background: var(--surface-2, #f0f0f0);
  border-left: 3px solid var(--accent, #3a7d63);
  border-bottom: 1px solid var(--lu-border, var(--border, #e2e2e2));
}
.lu-mgrid :deep(.lu-msection b) { color: var(--ink); }

/* Manager: heading (#10) + header bar (search → sort → spacer → actions) + the add/edit
   modal form (#30). The heading's margin-top keeps the 2026-07-07 breathing room between
   the "Your setup" strip cards and this block. */
.lu-mcat-title { font-weight: 700; font-size: 14px; color: var(--ink); margin-top: 14px; }
.lu-mcat-thispc { font-size: 11.5px; margin-top: 2px; }
.lu-mcat-bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; margin-bottom: 8px; }
.lu-mcat-search { flex: 0 1 220px; }
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
