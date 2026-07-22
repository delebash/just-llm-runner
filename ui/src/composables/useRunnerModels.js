// SPDX-License-Identifier: GPL-3.0-or-later
// Shared runner-models state: ONE source of the /v1/llm-runner/models catalog list + its
// LIVE load/download status, consumed by the model catalog so there is ONE poller and ONE
// status truth (no double-fetch, no drift). A module singleton — the modelDefaults.js /
// dialog.js precedent — NOT a per-component ref.
//
// ONE mechanism (2026-07-21, the user's ruling: "same mech, same function — delete the two
// mechanisms"): every per-model progress bar is a REAL createDownloadTask — the SAME machine
// QuickSetup's bars use — not a hand-rolled projection. QuickSetup DRIVES its tasks (start()
// self-polls). The catalog can't: a model may be loading because a feature run, a warm-boot or
// another surface asked (server-driven), with no local start() to own a loop. So this singleton
// FEEDS the same tasks from its ONE /models poll via task.arm()/task.apply(): same state
// machine, same words, same Cancel/Retry — one truth. A user Cancel/Retry rides the task's own
// cancel()/retry(); cancel() flips state first, so apply() (a no-op unless running) freezes the
// bar the instant you cancel (the old projection had no cancelled/done state — the "bar keeps
// moving after Cancelled" bug).
//
// TWO server channels stay distinct because the server HAS two: a spawn-LOAD reports on the
// single-model /status (one load at a time → one loadTask), a standalone DOWNLOAD on the
// per-model /download/status map (concurrent → a downloadTask each). The /models `_status_for`
// collapses both to "loading"; we disambiguate with the download map (a "loading" model present
// in the map is a standalone download, else a spawn-load).
import { computed, reactive, ref } from "vue";

import { request } from "../client.js";
import { fmtBytes } from "../common/services/downloadRate.js";
import { FIT_LABEL } from "../common/services/modelPick.js";
import {
  createDownloadTask, engineInstallChannel, modelDownloadChannel, modelLoadChannel,
  readDownloadStatus, readLoadStatus,
} from "./useDownloadTask.js";
import { useProviderModels } from "./useProviderModels.js";

const data = ref(null); // the raw /v1/llm-runner/models response
const loading = ref(true); // first-load spinner
const error = ref("");
// The engine INSTALL task in flight when a load found the engine missing (ONE workflow,
// 2026-07-21 — every model load runs the same engine check QuickSetup does). Exposed so the
// boot splash can render its bar; the catalog's engine panel shows the same install via the
// useEngine poller (both read /engine/status), so no extra bar is needed there.
const engineGateTask = ref(null);
const loadingId = ref(""); // model id whose Download-button POST is in flight (button feedback)

// #305: the model dropdown (useProviderModels) caches per-provider lists and never refetches
// once populated — so a model downloaded here never appears in a picker until a full reload.
// Track the built-in catalog's model-id SET and invalidate that cache when it changes.
const BUILTIN_PROVIDER_ID = "local-llamacpp";
let _lastBuiltinIds = null; // sorted-joined catalog model ids seen last refresh (null = not yet populated)

export const models = computed(() => data.value?.models || []);
export const vramMb = computed(() => data.value?.vramMb || 0);
const anyLoading = computed(() => models.value.some((m) => m.status === "loading"));

// fmtBytes lives in downloadRate.js; re-exported so existing consumers keep their import surface.
export { fmtBytes };

// ── ONE mechanism: the per-model tasks (real createDownloadTask), FED by this singleton ──
// The single spawn-load task (/status is single-model — one load at a time). `activeLoadId` is
// the model it currently follows.
const activeLoadId = ref("");
const loadTask = createDownloadTask(modelLoadChannel(() => activeLoadId.value));
// Retry re-runs the ONE workflow (engine check → install → load), re-arming the task; the
// singleton then feeds it. (createDownloadTask's NATIVE retry() would self-poll AND skip the
// engine check — wrong on the catalog's server-fed path, so we override it.)
loadTask.retry = () => {
  loadTask.arm("Getting ready");
  return retryLoad(activeLoadId.value);
};
// A cancel keeps Retry DISABLED until the teardown truly completes — set the flag the instant
// the user clicks (no enabled-Retry window to race). It clears when _syncTasks resets the task
// (the model has left loading/stopping, i.e. the teardown finished).
const _loadCancel = loadTask.cancel;
loadTask.cancel = () => {
  if (loadTask.state === "running") loadTask.finalizing = true;
  return _loadCancel();
};

// A standalone-download task per model (downloads are concurrent). Created on demand; reaped
// when the model stops downloading. `reactive` so the templates re-render as entries come/go.
const downloadTasks = reactive({});
function _downloadTaskFor(modelId) {
  if (!downloadTasks[modelId]) {
    const t = createDownloadTask(modelDownloadChannel(() => modelId));
    // Retry re-arms + re-POSTs through the singleton's download() (no self-poll).
    t.retry = () => {
      t.arm("Getting ready");
      return download(modelId);
    };
    // Same cancel→finalizing rule as the load task: Retry disabled until the cancel is confirmed
    // (the follower is reaped once the model leaves the download map).
    const _dlCancel = t.cancel;
    t.cancel = () => {
      if (t.state === "running") t.finalizing = true;
      return _dlCancel();
    };
    downloadTasks[modelId] = t;
  }
  return downloadTasks[modelId];
}

// The idle placeholder taskFor returns when a model isn't doing anything. The row/card gates on
// the model's status, so this is never actually rendered as a bar — it just gives taskFor a
// stable shape (DownloadBar reads task.state/label; state "" renders nothing meaningful).
const IDLE = Object.freeze({ state: "", phase: "", done: 0, total: 0, rateText: "", error: "", label: "" });

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

// Feed the per-model tasks from the live status channels — the ONE poll that drives every bar.
async function _syncTasks() {
  let st = null;
  let downloads = {};
  // Pull the progress channels only when something could be advancing: a load/download in flight
  // (status "loading"), an errored download to surface (status "error"), or a task still running.
  const followersRunning = Object.values(downloadTasks).some((t) => t.state === "running");
  const needStatus = anyLoading.value
    || loadTask.state === "running"
    || followersRunning
    || models.value.some((m) => m.status === "error");
  if (needStatus) {
    try {
      const [s, d] = await Promise.all([
        request("/v1/llm-runner/status"),
        request("/v1/llm-runner/download/status").catch(() => ({ downloads: {} })),
      ]);
      st = s;
      downloads = d.downloads || {};
    } catch {
      /* transient — leave the bars where they were this tick */
    }
  }
  // A "loading" model present in the download map is a standalone download; else a spawn-load.
  const downloadingSet = new Set(
    Object.entries(downloads)
      .filter(([, e]) => e.status === "downloading" || e.status === "error")
      .map(([id]) => id),
  );

  // ── spawn-load (single): the one model that's loading and isn't a standalone download ──
  const spawn = models.value.find((m) => m.status === "loading" && !downloadingSet.has(m.id));
  if (spawn) {
    if (activeLoadId.value !== spawn.id) {
      // A load we weren't tracking (a different model, or server-driven) — follow it fresh.
      activeLoadId.value = spawn.id;
      loadTask.arm("Getting ready");
    } else if (loadTask.state === "") {
      loadTask.arm("Getting ready"); // tracked but never armed (first sight) — safety
    }
    if (st) loadTask.apply(readLoadStatus(st)); // no-op unless running — freezes on cancel
  } else if (loadTask.state !== "") {
    loadTask.reset(); // nothing spawn-loading → clear the follower so the next load re-arms cleanly
  }

  // ── standalone downloads (concurrent): a fed follower per downloading model ──
  for (const id of downloadingSet) {
    const t = _downloadTaskFor(id);
    if (t.state === "") t.arm("Getting ready"); // first sight (download() usually armed it already)
    t.apply(readDownloadStatus(downloads[id])); // no-op unless running
  }
  // Reap followers no longer downloading (finished/absent → the row flips to disk/available).
  for (const id of Object.keys(downloadTasks)) {
    if (!downloadingSet.has(id)) delete downloadTasks[id];
  }
}

export async function refresh() {
  try {
    data.value = await request("/v1/llm-runner/models");
    error.value = "";
    // #305: when the built-in catalog gains/loses a model, refresh the picker cache so open
    // dropdowns show it without a full reload. Compare the id SET only (not status).
    const builtinIds = (data.value?.models || []).map((m) => m.id).sort().join(",");
    if (_lastBuiltinIds !== null && builtinIds !== _lastBuiltinIds) {
      useProviderModels().refreshModels(BUILTIN_PROVIDER_ID);
    }
    _lastBuiltinIds = builtinIds;
    await _syncTasks();
    if (anyLoading.value) _startPoll();
    else _stopPoll();
  } catch (e) {
    error.value = e.message || "Couldn't load the model catalog.";
  } finally {
    loading.value = false;
  }
}

// Download the weights ONLY (no spawn) — the catalog's "Download" action. The model then
// reports on-disk ('disk'); loading happens on use, never from the catalog.
export async function download(modelId) {
  loadingId.value = modelId;
  _downloadTaskFor(modelId).arm("Getting ready"); // arm now → the bar shows at once; the poll feeds it
  try {
    await request("/v1/llm-runner/download", { method: "POST", body: { modelId } });
    await refresh();
  } catch (e) {
    error.value = e.message || "Download failed.";
    _downloadTaskFor(modelId).fail(e.message || "Download failed.");
  } finally {
    loadingId.value = "";
  }
}

// Load a model — the ONE workflow (2026-07-21): engine check → install-if-missing → load. Every
// load trigger (Make default, Load now, the General dropdown, the boot warm, and the task's own
// Retry) routes here, so no surface dead-ends on 'engine-not-installed'. The install reuses the
// SAME createDownloadTask QuickSetup uses (engineGateTask), awaited to completion before loading.
export async function retryLoad(modelId) {
  try {
    const es = await request("/v1/llm-runner/engine/status").catch(() => ({ installed: true }));
    if (!es.installed) {
      const gate = createDownloadTask(engineInstallChannel());
      engineGateTask.value = gate;
      try {
        await gate.start(); // resolves when the install reaches a terminal state
        if (gate.state !== "done") {
          error.value = gate.error || "The engine didn't install.";
          return;
        }
      } finally {
        engineGateTask.value = null;
      }
    }
    activeLoadId.value = modelId;
    loadTask.arm("Getting ready"); // show the bar immediately; the poll feeds the live bytes
    await request("/v1/llm-runner/load", { method: "POST", body: { modelId } });
    await refresh();
  } catch (e) {
    error.value = e.message || "Couldn't load the model.";
    loadTask.fail(e.message || "Couldn't load the model.");
  }
}

// The per-model task DownloadBar renders — the SAME createDownloadTask machine everywhere, fed
// by _syncTasks: loadTask for the active spawn-load, a downloadTask for a standalone download,
// IDLE otherwise (the row/card gates on the model's status, so IDLE is never shown as a bar).
export function taskFor(modelId) {
  if (activeLoadId.value === modelId && loadTask.state) return loadTask;
  const dt = downloadTasks[modelId];
  if (dt && dt.state) return dt;
  return IDLE;
}

let kicked = false;

/** The shared runner-models state. Every consumer gets the SAME refs; the first consumer
 *  kicks the initial fetch. `refresh`/`download`/`retryLoad` mutate the shared state. */
export function useRunnerModels() {
  if (!kicked) {
    kicked = true;
    refresh();
  }
  return {
    models, vramMb, loading, error, loadingId,
    engineGateTask, anyLoading, fmtBytes, FIT_LABEL,
    refresh, download, retryLoad, taskFor,
  };
}
