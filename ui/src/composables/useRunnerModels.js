// SPDX-License-Identifier: GPL-3.0-or-later
// Shared runner-models state: ONE source of the /v1/llm-runner/models catalog list + its
// LIVE load/download status, consumed by the model catalog so there is ONE poller and ONE
// status truth (no double-fetch, no drift). A module singleton — the modelDefaults.js /
// dialog.js precedent — NOT a per-component ref.
//
// Deliberately NOT built on usePoll: usePoll registers onUnmounted, which cannot bind at
// module scope. The interval here self-manages — it starts only while a load is in flight
// and stops when idle (a faithful move of LuModelCatalog's own refresh gating).
//
// TWO SEPARATE progress channels (2026-07-15 consolidation; per-model downloads 2026-07-20):
// a model LOAD (spawn-into-VRAM, /status — single-model byte channel) and the standalone
// DOWNLOAD (/download/status — now a {modelId: {...}} map, CONCURRENT) can overlap, so LOAD
// keeps one `loadProgress` object and DOWNLOAD keeps a per-model `downloadMap`. This kills the
// old merge ("the active download's progress wins") that made a loading row and a downloading
// row share ONE lying label. All captions come from the SHARED progressCaption (downloadRate.js).
import { computed, reactive, ref } from "vue";

import { request } from "../client.js";
import { createRateTracker, fmtBytes, progressCaption, rateSuffix } from "../common/services/downloadRate.js";
import { friendlyPhase } from "../common/services/loadPhases.js";
import { FIT_LABEL } from "../common/services/modelPick.js";
import { useProviderModels } from "./useProviderModels.js";

const data = ref(null); // the raw /v1/llm-runner/models response
const loading = ref(true); // first-load spinner
const error = ref("");
const loadErr = ref(""); // the actual server error message when a load fails
const loadingId = ref(""); // model id whose Download-button POST is in flight (button feedback)
// CONCURRENT downloads (2026-07-20): a per-model progress map keyed by model id, created/removed
// as the /download/status map changes — several models download at once, each its own row + bar.
// `downloadingIds` derives the live download SET from it; `cancellingIds` is the mid-cancel set
// (a row stays "cancelling" until the channel drops its entry). Replaces the old single
// downloadingId/cancelling/downloadProgress trio (one download at a time).
const downloadMap = reactive({}); // modelId → { status, detail, downloaded, total, rateText, error }
const dlRates = new Map(); // modelId → its OWN rate tracker (non-reactive; cleaned up with the entry)
const cancellingIds = reactive(new Set()); // model ids whose cancel is in flight

// #305: the model dropdown (useProviderModels) caches per-provider lists and never refetches
// once populated — so a model downloaded here never appears in a picker until a full reload.
// Track the built-in catalog's model-id SET and invalidate that cache when it changes (a
// download adds one, a delete removes one), so open pickers refresh in place. `local-llamacpp`
// is the seeded built-in provider id (api.py:92,114; registry.py).
const BUILTIN_PROVIDER_ID = "local-llamacpp";
let _lastBuiltinIds = null; // sorted-joined catalog model ids seen last refresh (null = not yet populated)

export const models = computed(() => data.value?.models || []);
export const vramMb = computed(() => data.value?.vramMb || 0);
// The live download SET derived from the per-model map (status "downloading"; an "error" entry is
// NOT in it). Consumers use `downloadingIds.has(id)` — the row's Cancel gates on it.
export const downloadingIds = computed(() => {
  const s = new Set();
  for (const [id, e] of Object.entries(downloadMap)) if (e.status === "downloading") s.add(id);
  return s;
});
const anyLoading = computed(() => models.value.some((m) => m.status === "loading"));
const anyError = computed(() => models.value.some((m) => m.status === "error"));
// A model load now REQUIRES the engine installed (it no longer auto-downloads it);
// surface that as a CTA pointing at the Local engine panel, not a raw error code.
export const needsEngine = computed(() => loadErr.value === "engine-not-installed");

// fmtBytes lives in downloadRate.js; re-exported so existing consumers keep their import surface.
export { fmtBytes };

// ── the LOAD channel's single progress object (the /status byte channel is single-model) ──
const loadRate = createRateTracker();
export const loadProgress = reactive({
  detail: "", downloaded: 0, total: 0, rateText: "",
  label: computed(() => progressCaption(
    loadProgress.detail || "loading…", loadProgress.downloaded, loadProgress.total, loadProgress.rateText,
  )),
});
function _resetLoad() {
  loadProgress.detail = ""; loadProgress.downloaded = 0; loadProgress.total = 0;
  loadProgress.rateText = ""; loadRate.reset();
}
function _feedLoad(st) {
  loadProgress.detail = st.detail || (st.status === "downloading" ? "downloading…" : "starting…");
  loadProgress.downloaded = Number(st.downloaded) || 0;
  loadProgress.total = Number(st.total) || 0;
  loadProgress.rateText = rateSuffix(loadRate.update(loadProgress.downloaded), loadProgress.downloaded, loadProgress.total);
}
// ── the DOWNLOAD channel's per-model map (concurrent): feed each entry from the server's
//    {modelId: {...}} snapshot, and DROP entries that left it (absent == that model finished —
//    its weights are on disk; the /models row flips to "disk"). One rate tracker per model. ──
function _resetDownloads() {
  for (const id of Object.keys(downloadMap)) delete downloadMap[id];
  dlRates.clear();
  cancellingIds.clear();
}
function _feedDownloads(map) {
  for (const [mid, dl] of Object.entries(map)) {
    let tracker = dlRates.get(mid);
    if (!tracker) { tracker = createRateTracker(); dlRates.set(mid, tracker); }
    const downloaded = Number(dl.downloaded) || 0;
    const total = Number(dl.total) || 0;
    downloadMap[mid] = {
      status: dl.status || "downloading",
      detail: dl.detail || "downloading…",
      downloaded, total,
      error: dl.error || "",
      // No rate on a terminal (error) entry — it isn't advancing.
      rateText: dl.status === "downloading" ? rateSuffix(tracker.update(downloaded), downloaded, total) : "",
    };
    if (dl.status !== "downloading") cancellingIds.delete(mid); // terminal → the cancel flag retires
  }
  // Reap entries the server no longer reports (finished/cancelled → back to idle/on-disk).
  for (const mid of Object.keys(downloadMap)) {
    if (!(mid in map)) {
      delete downloadMap[mid];
      dlRates.delete(mid);
      cancellingIds.delete(mid);
    }
  }
}

let timer = null;
function _startPoll() {
  if (!timer) timer = setInterval(refresh, 1500);
}
function _stopPoll() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function refresh() {
  try {
    data.value = await request("/v1/llm-runner/models");
    error.value = "";
    // #305: when the built-in catalog gains/loses a model, refresh the picker cache so open
    // dropdowns show it without a full reload. Compare the id SET only (not status) so a mere
    // load→disk flip doesn't refetch. Skip the first population (pickers fetch lazily anyway).
    const builtinIds = (data.value?.models || []).map((m) => m.id).sort().join(",");
    if (_lastBuiltinIds !== null && builtinIds !== _lastBuiltinIds) {
      useProviderModels().refreshModels(BUILTIN_PROVIDER_ID);
    }
    _lastBuiltinIds = builtinIds;
    // Pull live status while a load is in flight (progress) OR after one failed (so we can
    // surface the real error, not a bare "failed").
    if (anyLoading.value || anyError.value) {
      try {
        // The LOAD channel and the standalone DOWNLOAD channel run independently (a download
        // can overlap a load); poll BOTH and feed each its OWN progress object — no merge.
        const [st, dl] = await Promise.all([
          request("/v1/llm-runner/status"),
          request("/v1/llm-runner/download/status").catch(() => ({ downloads: {} })),
        ]);
        _feedLoad(st);
        _feedDownloads(dl.downloads || {});
        // loadErr is the LOAD-channel error ONLY now — per-model DOWNLOAD errors live in the
        // map and surface per row via taskFor(id).error, so a failed download of one model no
        // longer masquerades as the (single) load error.
        loadErr.value = st.error || "";
      } catch {
        _resetLoad();
      }
      if (anyLoading.value) _startPoll();
      else _stopPoll();
    } else {
      _resetLoad();
      _resetDownloads();
      loadErr.value = "";
      _stopPoll();
    }
  } catch (e) {
    error.value = e.message || "Couldn't load the model catalog.";
  } finally {
    loading.value = false;
  }
}

// Download the weights ONLY (no spawn) — the catalog's "Download" action. The model then
// reports on-disk ('disk'); loading happens on use (a feature run, or QuickSetup's apply
// driving /v1/llm-runner/load itself), never from the catalog.
export async function download(modelId) {
  loadingId.value = modelId;
  try {
    await request("/v1/llm-runner/download", { method: "POST", body: { modelId } });
    await refresh();
  } catch (e) {
    error.value = e.message || "Download failed.";
  } finally {
    loadingId.value = "";
  }
}

// Cancel ONE model's in-flight download — the backend stops it (or aborts it while queued) at the
// next chunk boundary and drops it from the map (the row falls back to 'available'; the partial
// part-files stay cached so a re-download resumes past them). Other models keep downloading.
// No-op server-side when that model isn't downloading.
export async function cancelDownload(modelId) {
  cancellingIds.add(modelId);
  try {
    await request("/v1/llm-runner/download/cancel", { method: "POST", body: { modelId } });
    await refresh();
  } catch (e) {
    error.value = e.message || "Couldn't cancel the download.";
    cancellingIds.delete(modelId);
  }
}

// Cancel an in-flight model LOAD — a TRUE abort in EVERY phase (T2, 2026-07-17): /stop
// sets the load's cancel token and returns at once; the load thread honors it at its
// checkpoints (a download aborts at the next chunk; a child that spawned after the
// cancel is silently unloaded; the model never stays loaded). The row flips off
// 'loading' on the next refresh, so its Cancel button retires itself.
export async function cancelLoad(modelId) {
  try {
    await request("/v1/llm-runner/stop", { method: "POST", body: { modelId } });
    await refresh();
  } catch (e) {
    error.value = e.message || "Couldn't cancel the load.";
  }
}

// Re-issue the load a row/card errored on — the task adapter's Retry. (A standalone
// DOWNLOAD error's retry is the same download() the row button already offers; the
// adapter defaults to the LOAD channel, the common card/row case.)
export async function retryLoad(modelId) {
  try {
    await request("/v1/llm-runner/load", { method: "POST", body: { modelId } });
    await refresh();
  } catch (e) {
    error.value = e.message || "Couldn't retry the load.";
  }
}

// ── T3 (2026-07-17 approved plan): the per-model task-shaped adapter ─────────────────
// DownloadBar renders "any object with the same shape" (its own contract) — this is a
// PROJECTION over this singleton, not a second task implementation: no new poller, no
// new truth; per-model gating comes from the model's OWN row status (never the
// single-channel loadingId — the first plan's gating bug), bytes from the channel that
// concerns the model (the absorbed barFor logic: standalone download ↔ downloadMap[id],
// spawn-load ↔ loadProgress; the /status byte channel is single-model — a pre-existing
// limitation with two CONCURRENT loads, documented in the plan, not worsened here).
// A plain function returning a plain object: templates re-run it reactively through the
// refs it reads (a per-call computed() would leak one per render).
export function taskFor(modelId) {
  const m = models.value.find((x) => x.id === modelId);
  const status = m?.status || "";
  if (status === "stopping") {
    // Teardown/cancel resolving. NO cancel member — an unload isn't cancellable, and
    // DownloadBar's Cancel renders only when `task.cancel` exists (the null-guard).
    return { state: "running", phase: "stopping", done: 0, total: 0, rateText: "",
             error: "", label: friendlyPhase("", "stopping") };
  }
  if (status === "loading") {
    // A standalone download for THIS model reads its own map entry; a spawn-load reads the
    // single load channel. isDl comes from the per-model download set (not a single id).
    const isDl = downloadingIds.value.has(modelId);
    const p = isDl ? (downloadMap[modelId] || { detail: "", downloaded: 0, total: 0, rateText: "" }) : loadProgress;
    return {
      state: "running", phase: p.detail, done: p.downloaded, total: p.total,
      rateText: p.rateText, error: "",
      label: progressCaption(friendlyPhase(p.detail, "downloading"), p.downloaded, p.total, p.rateText),
      cancel: () => (isDl ? cancelDownload(modelId) : cancelLoad(modelId)),
    };
  }
  if (status === "error") {
    // A per-model DOWNLOAD error lives in the map; a LOAD error is the single loadErr.
    const dlErr = downloadMap[modelId]?.error;
    return { state: "error", phase: "", done: 0, total: 0, rateText: "",
             error: dlErr || loadErr.value || "Load failed", label: "",
             retry: () => retryLoad(modelId) };
  }
  return { state: "", phase: "", done: 0, total: 0, rateText: "", error: "", label: "" };
}

let kicked = false;

/** The shared runner-models state. Every consumer gets the SAME refs; the first consumer
 *  kicks the initial fetch. `refresh`/`download` mutate the shared state. */
export function useRunnerModels() {
  if (!kicked) {
    kicked = true;
    refresh();
  }
  return {
    models, vramMb, loading, error, loadErr, loadingId, downloadingIds, cancellingIds,
    loadProgress,
    anyLoading, anyError, needsEngine, fmtBytes, FIT_LABEL,
    refresh, download, cancelDownload, cancelLoad, retryLoad, taskFor,
  };
}
