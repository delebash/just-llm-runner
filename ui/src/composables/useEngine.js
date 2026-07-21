// SPDX-License-Identifier: GPL-3.0-or-later
// The ONE engine install/update/uninstall state + actions — module singleton shared by
// the Built-in provider LIST ROW (AiModelsArea) and the Local-engine panel
// (LuRunnerEngine), so the row buttons and the panel can never disagree (user,
// 2026-07-06: "providers on built in move the install unistall update button to right
// of edit" — the actions MOVED to the row; the panel keeps status + Details).
//
// POLLING IS OWNED HERE, not by a component: an install started from the list row must
// keep reporting progress even when the panel is unmounted, and both surfaces render
// the SAME progress state (user, 2026-07-06: "no progress bar on install engine please
// be consistant").
import { computed, ref } from "vue";

import { request } from "../client.js";
import { confirmDialog } from "../common/services/dialog.js";
import { createRateTracker, progressCaption, rateSuffix } from "../common/services/downloadRate.js";
import { applyBuildToUrl } from "../common/services/engineUrl.js";

const st = ref(null); // engine_status() payload
const busy = ref(false); // an install/uninstall POST in flight
const error = ref("");
let pollTimer = null;
let retryTimer = null;

// DL-1: speed + ETA from the byte deltas the 800 ms poll already sees.
const rate = createRateTracker();
const rateText = ref("");

// QC-13 (2026-07-09): `st` starts null, so `installed` computes FALSE before the
// first status fetch resolves — and surfaces that keyed on `!installed` claimed
// "Not installed" (and offered Install) during that window, indefinitely when the
// first fetch failed. `statusKnown` lets them render an honest "Checking…" state
// instead; a claim about install state needs a FETCHED answer.
const statusKnown = computed(() => st.value !== null);
const installed = computed(() => !!st.value?.installed);
const installing = computed(() => st.value?.status === "installing");
// The engine install's raw `detail` is engineer-speak / empty during the main download;
// map it to a user phrase. Exported so QuickSetup's engineTask reads the SAME wording (one
// source — the ONE-DOWNLOADER consolidation, 2026-07-15).
export function friendlyEnginePhase(detail) {
  const d = String(detail || "").trim();
  if (!d || d === "llama.cpp engine" || /engine build/i.test(d)) return "Downloading the engine";
  if (d === "removing old builds" || d === "carrying models.ini over" || /^removing old build/.test(d))
    return "Setting it up";
  if (d === "cancelling…") return "Cancelling";
  return d;
}
const progressLabel = computed(() => {
  const s = st.value || {};
  return progressCaption(friendlyEnginePhase(s.detail), s.downloaded, s.total, rateText.value);
});

function _syncPoll() {
  if (st.value?.status === "installing") {
    if (!pollTimer) pollTimer = setInterval(refreshEngine, 800);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    // The install just reached a terminal state (#138, 2026-07-07): the backend
    // clears stale "Install the engine first" model errors on success — re-pull
    // the models list so the grid drops its red "install engine ↑" rows without
    // waiting for a manual refresh. Lazy import avoids a module cycle.
    import("./useRunnerModels.js")
      .then((m) => m.useRunnerModels().refresh())
      .catch(() => {});
  }
}

async function refreshEngine() {
  try {
    st.value = await request("/v1/llm-runner/engine/status");
    error.value = st.value?.status === "error" ? st.value?.error || "" : "";
    if (st.value?.status === "installing") {
      const dl = Number(st.value.downloaded) || 0;
      rateText.value = rateSuffix(rate.update(dl), dl, Number(st.value.total) || 0);
    } else {
      rate.reset();
      rateText.value = "";
    }
  } catch (e) {
    error.value = e.message || "Couldn't read engine status.";
    // QC-13: with NO snapshot at all (the first fetch failed — server still
    // booting, transient net) retry until one lands, so the UI never sits on
    // "Checking…" forever. Quieter than the panel's existing 2.5 s resident
    // poll; stops for good after the first successful read.
    if (st.value === null && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; refreshEngine(); }, 5000);
    }
  } finally {
    _syncPoll(); // starts the poll when a load finds an install in flight; stops it when done
  }
}

async function install(force) {
  busy.value = true;
  error.value = "";
  try {
    await request("/v1/llm-runner/engine/install", { method: "POST", body: { force: !!force } });
    await refreshEngine();
  } catch (e) {
    error.value = e.message || "Install failed.";
  } finally {
    busy.value = false;
  }
}

async function cancel() {
  // Cancel an in-flight engine install (the same shape as the model /download/cancel).
  // The install poll (_syncPoll) keeps running while status is "installing", so it picks
  // up the "cancelling…" detail immediately and then the terminal not-installed idle.
  error.value = "";
  try {
    await request("/v1/llm-runner/engine/install/cancel", { method: "POST" });
    await refreshEngine();
  } catch (e) {
    error.value = e.message || "Couldn't cancel the install.";
  }
}

async function uninstall() {
  const ok = await confirmDialog({
    title: "Remove the engine?",
    message: "Deletes the installed llama.cpp binaries. Your downloaded models are kept — reinstall the engine any time to use them again.",
    confirmLabel: "Uninstall",
  });
  if (!ok) return;
  busy.value = true;
  error.value = "";
  try {
    const r = await request("/v1/llm-runner/engine/uninstall", { method: "POST" });
    if (r?.error) error.value = r.error;
    await refreshEngine();
  } catch (e) {
    error.value = e.message || "Uninstall failed.";
  } finally {
    busy.value = false;
  }
}

// ── Acceleration backend (2026-07-14): the user chooses which GPU backend the engine
// runs on (Auto | CUDA | Vulkan | …). The choice is a loose config pin (`preferred_gpu`,
// a family); the runner fronts it in its build-preference order and downloads the variant
// on demand. Flow: install the variant (EXPLICIT) → pin the preference → offer a MANUAL
// restart so a running generation is never yanked mid-stream.
function _familyOf(gpu) {
  return gpu && gpu.startsWith("cuda") ? "cuda" : gpu || "";
}

async function _awaitInstall() {
  // Resolve once the shared install poll leaves the "installing" state.
  while (st.value?.status === "installing") {
    await new Promise((r) => setTimeout(r, 500));
    await refreshEngine();
  }
}

async function setBackend(family) {
  error.value = "";
  const fam = (family || "").trim().toLowerCase();
  // 1. Ensure the variant is on disk (explicit download) — skip for Auto / already-installed.
  const installedFamilies = new Set((st.value?.installedGpus || []).map(_familyOf));
  if (fam && !installedFamilies.has(fam)) {
    busy.value = true;
    try {
      await request("/v1/llm-runner/engine/install", { method: "POST", body: { gpu: fam } });
      await refreshEngine();
      await _awaitInstall();
    } catch (e) {
      error.value = e.message || "Couldn't install that backend.";
      busy.value = false;
      return;
    }
    busy.value = false;
    if (st.value?.status === "error") return; // the variant download failed — don't switch
  }
  // 2. Pin the preference.
  try {
    await request("/v1/ai/engine-config", { method: "PUT", body: { preferredGpu: fam } });
  } catch (e) {
    error.value = e.message || "Couldn't save the backend choice.";
    return;
  }
  await refreshEngine();
  // 3. MANUAL apply: the change takes effect on the next engine spawn. Offer to restart
  // now (a full teardown — a loaded model unloads, a running generation stops), or leave
  // it to apply lazily at the next model load.
  const restart = await confirmDialog({
    title: "Restart the engine to apply?",
    message: "The new acceleration backend takes effect the next time the engine starts. Restart now to switch immediately — any loaded model unloads and a running generation stops — or leave it and it applies on the next model load.",
    confirmLabel: "Restart engine",
  });
  if (restart) {
    try {
      await request("/v1/llm-runner/stop", { method: "POST" });
    } catch { /* best-effort — the next load spawns fresh regardless */ }
    await refreshEngine();
  }
}

// ── A5: update detection (user "do", 2026-07-06) — notify-only, never auto-applied.
// The pin is a VERIFIED pin (flag semantics move between llama.cpp builds), so the
// surface is a line + a deliberate click; policy Off silences the check entirely.
const updateInfo = ref(null); // {current, latest, updateAvailable, error} | null
const updatePolicy = ref("notify");

async function checkForUpdate() {
  try {
    const cfg = await request("/v1/ai/engine-config");
    updatePolicy.value = cfg?.updatePolicy || "notify";
    if (updatePolicy.value === "off") {
      updateInfo.value = null;
      return;
    }
    updateInfo.value = await request("/v1/llm-runner/engine/update-check");
  } catch {
    updateInfo.value = null; // an unreachable check is silence, never a false "update available"
  }
}

async function setUpdatePolicy(v) {
  updatePolicy.value = v;
  try {
    await request("/v1/ai/engine-config", { method: "PUT", body: { updatePolicy: v } });
  } catch (e) {
    error.value = e.message || "Couldn't save the update policy.";
  }
  if (v === "off") updateInfo.value = null;
  else checkForUpdate();
}

async function updateToLatest() {
  const latest = updateInfo.value?.latest;
  if (!latest) return;
  busy.value = true;
  error.value = "";
  try {
    // The deliberate click: write the new pin, then force-reinstall for it. The
    // acquire path verifies the release's asset names (the pin-bump discipline).
    // An update REPLACES (user, 2026-07-07: "the engine update should delete the
    // old folder"): the superseded build rides along so the backend deletes its
    // folder once the new install lands (a hand-maintained models.ini inside it
    // is carried over first).
    const previous = updateInfo.value?.current || st.value?.build || "";
    // The pin drives the URLs: bump the pin AND re-point every stored download URL to the
    // new build (the SAME applyBuildToUrl the Binaries panel uses), so the DB holds the real
    // URL for `latest` and the install folder (named for the pin) matches the binary.
    const cfg = await request("/v1/ai/engine-config");
    const binaries = (cfg.binaries || []).map((b) => ({
      ...b,
      assetUrl: applyBuildToUrl(b.assetUrl, latest),
      runtimeUrl: applyBuildToUrl(b.runtimeUrl, latest),
    }));
    await request("/v1/ai/engine-config", { method: "PUT", body: { pinnedBuild: latest, binaries } });
    await request("/v1/llm-runner/engine/install", {
      method: "POST", body: { force: true, replaceBuild: previous },
    });
    updateInfo.value = null;
    await refreshEngine();
  } catch (e) {
    error.value = e.message || "Update failed.";
  } finally {
    busy.value = false;
  }
}

export function useEngine() {
  return {
    engineState: st, busy, error, statusKnown, installed, installing, progressLabel,
    updateInfo, updatePolicy, checkForUpdate, setUpdatePolicy, updateToLatest,
    refreshEngine, install, cancel, uninstall, setBackend,
  };
}
