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
// TWO SEPARATE progress channels (2026-07-15, the ONE-DOWNLOADER consolidation — user:
// "stop repeating code, reuse stuff"): a model LOAD (spawn-into-VRAM, /status) and the
// standalone DOWNLOAD (/download/status) can overlap, so each keeps its OWN progress object
// (`loadProgress` / `downloadProgress`). This kills the old merge ("the active download's
// progress wins") that made a loading row and a downloading row share ONE lying label. Both
// captions come from the SHARED progressCaption formatter (downloadRate.js) — one source.
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
const loadingId = ref(""); // model id whose download is in flight (button feedback)
const downloadingId = ref(""); // model id on the standalone Download channel — its row shows Cancel
const cancelling = ref(false); // true from the download-cancel click until the channel returns to idle

// #305: the model dropdown (useProviderModels) caches per-provider lists and never refetches
// once populated — so a model downloaded here never appears in a picker until a full reload.
// Track the built-in catalog's model-id SET and invalidate that cache when it changes (a
// download adds one, a delete removes one), so open pickers refresh in place. `local-llamacpp`
// is the seeded built-in provider id (api.py:92,114; registry.py).
const BUILTIN_PROVIDER_ID = "local-llamacpp";
let _lastBuiltinIds = null; // sorted-joined catalog model ids seen last refresh (null = not yet populated)

export const models = computed(() => data.value?.models || []);
export const vramMb = computed(() => data.value?.vramMb || 0);
const anyLoading = computed(() => models.value.some((m) => m.status === "loading"));
const anyError = computed(() => models.value.some((m) => m.status === "error"));
// A model load now REQUIRES the engine installed (it no longer auto-downloads it);
// surface that as a CTA pointing at the Local engine panel, not a raw error code.
export const needsEngine = computed(() => loadErr.value === "engine-not-installed");

// fmtBytes lives in downloadRate.js; re-exported so existing consumers keep their import surface.
export { fmtBytes };

// ── the two per-channel progress objects (each its own rate tracker + the shared label) ──
const loadRate = createRateTracker();
const dlRate = createRateTracker();
export const loadProgress = reactive({
  detail: "", downloaded: 0, total: 0, rateText: "",
  label: computed(() => progressCaption(
    loadProgress.detail || "loading…", loadProgress.downloaded, loadProgress.total, loadProgress.rateText,
  )),
});
export const downloadProgress = reactive({
  detail: "", downloaded: 0, total: 0, rateText: "",
  label: computed(() => progressCaption(
    downloadProgress.detail || "downloading…", downloadProgress.downloaded, downloadProgress.total, downloadProgress.rateText,
  )),
});
function _resetLoad() {
  loadProgress.detail = ""; loadProgress.downloaded = 0; loadProgress.total = 0;
  loadProgress.rateText = ""; loadRate.reset();
}
function _resetDownload() {
  downloadProgress.detail = ""; downloadProgress.downloaded = 0; downloadProgress.total = 0;
  downloadProgress.rateText = ""; dlRate.reset();
}
function _feedLoad(st) {
  loadProgress.detail = st.detail || (st.status === "downloading" ? "downloading…" : "starting…");
  loadProgress.downloaded = Number(st.downloaded) || 0;
  loadProgress.total = Number(st.total) || 0;
  loadProgress.rateText = rateSuffix(loadRate.update(loadProgress.downloaded), loadProgress.downloaded, loadProgress.total);
}
function _feedDownload(dl) {
  if (dl.status !== "downloading") { _resetDownload(); return; }
  downloadProgress.detail = dl.detail || "downloading…";
  downloadProgress.downloaded = Number(dl.downloaded) || 0;
  downloadProgress.total = Number(dl.total) || 0;
  downloadProgress.rateText = rateSuffix(dlRate.update(downloadProgress.downloaded), downloadProgress.downloaded, downloadProgress.total);
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
          request("/v1/llm-runner/download/status").catch(() => ({ status: "idle" })),
        ]);
        _feedLoad(st);
        _feedDownload(dl);
        loadErr.value = st.error || dl.error || "";
        // Only the standalone Download channel is cancellable via /download/cancel — remember
        // its row; the LOAD row cancels via /stop (a true abort now, server S2).
        downloadingId.value = dl.status === "downloading" ? dl.modelId || "" : "";
        if (dl.status !== "downloading") cancelling.value = false;
      } catch {
        _resetLoad();
      }
      if (anyLoading.value) _startPoll();
      else _stopPoll();
    } else {
      _resetLoad();
      _resetDownload();
      loadErr.value = "";
      downloadingId.value = "";
      cancelling.value = false;
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

// Cancel the in-flight standalone Download — the backend stops at the next chunk boundary and
// returns the channel to idle (the row falls back to 'available'; the partial blob stays
// cached so a re-download resumes past it). No-op server-side when nothing is downloading.
export async function cancelDownload() {
  cancelling.value = true;
  try {
    await request("/v1/llm-runner/download/cancel", { method: "POST" });
    await refresh();
  } catch (e) {
    error.value = e.message || "Couldn't cancel the download.";
    cancelling.value = false;
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
// concerns the model (the absorbed barFor logic: standalone download ↔ downloadProgress,
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
    const isDl = modelId === downloadingId.value;
    const p = isDl ? downloadProgress : loadProgress;
    return {
      state: "running", phase: p.detail, done: p.downloaded, total: p.total,
      rateText: p.rateText, error: "",
      label: progressCaption(friendlyPhase(p.detail, "downloading"), p.downloaded, p.total, p.rateText),
      cancel: () => (isDl ? cancelDownload() : cancelLoad(modelId)),
    };
  }
  if (status === "error") {
    return { state: "error", phase: "", done: 0, total: 0, rateText: "",
             error: loadErr.value || "Load failed", label: "",
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
    models, vramMb, loading, error, loadErr, loadingId, downloadingId, cancelling,
    loadProgress, downloadProgress,
    anyLoading, anyError, needsEngine, fmtBytes, FIT_LABEL,
    refresh, download, cancelDownload, cancelLoad, retryLoad, taskFor,
  };
}
