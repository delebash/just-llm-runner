// SPDX-License-Identifier: GPL-3.0-or-later
// Shared runner-models state: ONE source of the /v1/llm-runner/models catalog list + its
// LIVE load/download status, consumed by the model catalog so there is
// ONE poller and ONE status truth (no
// double-fetch, no drift). A module singleton — the modelDefaults.js / dialog.js
// precedent — NOT a per-component ref.
//
// Deliberately NOT built on usePoll: usePoll registers onUnmounted, which cannot bind
// at module scope. The interval here self-manages — it starts only while a load is in
// flight and stops when idle (a faithful move of LuModelCatalog's own refresh gating),
// so it never leaks and needs no component lifecycle to own it.
import { computed, ref } from "vue";

import { request } from "../client.js";
import { createRateTracker, fmtBytes, progressCaption, rateSuffix } from "../common/services/downloadRate.js";
import { FIT_LABEL } from "../common/services/modelPick.js";

const data = ref(null); // the raw /v1/llm-runner/models response
const loading = ref(true); // first-load spinner
const error = ref("");
const detail = ref(""); // live status phase while a model is loading
const downloaded = ref(0); // live bytes of the in-flight load (progress bar)
const total = ref(0); // total bytes of the current phase (0 = unknown → indeterminate)
const loadErr = ref(""); // the actual server error message when a load fails
const loadingId = ref(""); // model id whose download is in flight (button feedback)
const downloadingId = ref(""); // model id on the standalone Download channel — the ONE row that shows Cancel
const cancelling = ref(false); // true from the cancel click until the channel returns to idle

export const models = computed(() => data.value?.models || []);
export const vramMb = computed(() => data.value?.vramMb || 0);
const anyLoading = computed(() => models.value.some((m) => m.status === "loading"));
const anyError = computed(() => models.value.some((m) => m.status === "error"));
// A model load now REQUIRES the engine installed (it no longer auto-downloads it);
// surface that as a CTA pointing at the Local engine panel, not a raw error code.
export const needsEngine = computed(() => loadErr.value === "engine-not-installed");

// fmtBytes now lives in downloadRate.js (it had an identical twin in useEngine);
// re-exported so existing consumers (LuModelCatalog) keep their import surface.
export { fmtBytes };

// DL-1: speed + ETA from the byte deltas the poll already sees.
const rate = createRateTracker();
const rateText = ref("");

// Phase + bytes caption shown above the download progress bar.
export const progressLabel = computed(() =>
  progressCaption(detail.value || "loading…", downloaded.value, total.value, rateText.value),
);

// Coarse Fit label text (FIT_LABEL) is imported from modelPick.js — ONE source (the fit
// vocabulary lives beside FIT_RUNNABLE/FIT_RANK); re-exposed via useRunnerModels() below so
// its consumers (LuModelCatalog) are unchanged. The badge tint is the shared .lu-fit--* CSS.

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
    // Pull live status while a load is in flight (progress) OR after one failed (so we can
    // surface the real error, not a bare "failed").
    if (anyLoading.value || anyError.value) {
      try {
        // A download runs on its OWN channel (can overlap a load); poll both and let
        // the active download's progress win so the bar shows download bytes too.
        const [st, dl] = await Promise.all([
          request("/v1/llm-runner/status"),
          request("/v1/llm-runner/download/status").catch(() => ({ status: "idle" })),
        ]);
        const active = dl.status === "downloading" ? dl : st;
        detail.value = active.detail || (active.status === "downloading" ? "downloading…" : "starting…");
        downloaded.value = Number(active.downloaded) || 0;
        total.value = Number(active.total) || 0;
        loadErr.value = st.error || dl.error || "";
        rateText.value = rateSuffix(rate.update(downloaded.value), downloaded.value, total.value);
        // Only the standalone Download channel is cancellable — remember its row.
        downloadingId.value = dl.status === "downloading" ? dl.modelId || "" : "";
        if (dl.status !== "downloading") cancelling.value = false;
      } catch {
        detail.value = "";
      }
      if (anyLoading.value) _startPoll();
      else _stopPoll();
    } else {
      detail.value = "";
      downloaded.value = 0;
      total.value = 0;
      loadErr.value = "";
      downloadingId.value = "";
      cancelling.value = false;
      rate.reset();
      rateText.value = "";
      _stopPoll();
    }
  } catch (e) {
    error.value = e.message || "Couldn't load the model catalog.";
  } finally {
    loading.value = false;
  }
}

// Download the weights ONLY (no spawn) — the catalog's "Download" action. The model then
// reports as on-disk ('disk'); loading happens on use (a feature run, or QuickSetup's
// apply driving /v1/llm-runner/load itself), never from the catalog. The catalog's old
// load()/unload() exports died with their buttons (model-surface Phase 2; pruned at C7).
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

// Cancel the in-flight standalone Download — the backend stops at the next chunk boundary
// and returns the channel to idle (the row falls back to 'available'; the partial blob stays
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

let kicked = false;

/** The shared runner-models state. Every consumer gets the SAME refs; the first
 *  consumer kicks the initial fetch. `refresh`/`download` mutate the shared state. */
export function useRunnerModels() {
  if (!kicked) {
    kicked = true;
    refresh();
  }
  return {
    models, vramMb, loading, error, detail, downloaded, total, loadErr, loadingId,
    downloadingId, cancelling,
    anyLoading, anyError, needsEngine, progressLabel, fmtBytes, FIT_LABEL,
    refresh, download, cancelDownload,
  };
}
