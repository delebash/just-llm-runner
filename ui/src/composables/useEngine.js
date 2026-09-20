// SPDX-License-Identifier: MIT
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
import { applyBuildToUrl, planBinaries, shouldRollback } from "../common/services/engineUrl.js";

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
    // An update wrote the new pin BEFORE the install ran. The install has now reached a
    // terminal state: keep the pin if the target is what landed on disk, put the old one
    // back if anything else did (a renamed asset, a build that refused our launch flags).
    if (pendingUpdate) {
      if (shouldRollback(pendingUpdate, st.value)) rollbackPendingUpdate().catch(() => {});
      else pendingUpdate = null;
    }
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
const updateInfo = ref(null); // {current, latest, latestStable, updateAvailable, error} | null
const updatePolicy = ref("notify");
// An update in flight that ALREADY wrote the new pin + URLs. If the install then fails (a
// renamed asset, a build that refuses our launch flags), the DB would be left pointing at an
// engine this box does not have — so we keep what to put back. Cleared once the install
// reaches a terminal state on the target build. Lost if the app closes mid-update: the pin
// stays at the target, the old engine stays on disk, and the update is simply offered again.
let pendingUpdate = null; // { target, previous: { pinnedBuild, binaries } }

// Warm-on-startup (2026-07-21): warm the default local chat model into VRAM at launch.
// A RunnerSetting on the engine config (like preferred_gpu / update_policy). Hoisted into
// this singleton so the main Local page and any panel bind ONE reactive value — never a
// per-surface copy that could disagree (the singleton's whole reason for being). Moved out
// of LuRunnerEngine's local state when the toggle left the Edit panel for the main page
// (user, 2026-07-21: "its buried in edit put it on main local").
const warmDefaultOnStartup = ref(null); // null = not yet fetched
async function refreshWarm() {
  try {
    const cfg = await request("/v1/ai/engine-config");
    warmDefaultOnStartup.value = !!cfg.warmDefaultOnStartup;
  } catch {
    // leave null on a transient read — the toggle reads as off until a fetch lands
  }
}
async function setWarmDefaultOnStartup(v) {
  warmDefaultOnStartup.value = v; // apply on flip (the updatePolicy select precedent)
  try {
    await request("/v1/ai/engine-config", { method: "PUT", body: { warmDefaultOnStartup: !!v } });
  } catch (e) {
    error.value = e.message || "Couldn't save the warm-on-startup setting.";
  }
}

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

// Put the pin + URLs back after an update that wrote them and then failed. Best-effort and
// never throwing: it runs from the status poll, which must not die.
async function rollbackPendingUpdate() {
  const previous = pendingUpdate?.previous;
  pendingUpdate = null;
  if (!previous) return;
  try {
    await request("/v1/ai/engine-config", {
      method: "PUT",
      body: { pinnedBuild: previous.pinnedBuild, binaries: previous.binaries },
    });
    error.value = `${error.value || "The engine update didn't complete."} Your engine was left on ${previous.pinnedBuild}.`;
  } catch {
    // the PUT itself failed — the message above would be a lie, so say nothing more
  }
}

async function updateToLatest() {
  const latest = updateInfo.value?.latest;
  if (!latest) return;
  busy.value = true;
  error.value = "";
  try {
    // The deliberate click: write the new pin, then force-reinstall for it.
    // An update REPLACES (user, 2026-07-07: "the engine update should delete the
    // old folder"): the superseded build rides along so the backend deletes its
    // folder once the new install lands (a hand-maintained models.ini inside it
    // is carried over first).
    const previous = updateInfo.value?.current || st.value?.build || "";
    // Ask the SERVER what that release really publishes — upstream renames these files
    // between builds, so substituting the tag can 404 (plan §3.4). A failed lookup is not
    // fatal: planBinaries then substitutes, which is what this always did.
    let plan = null;
    try {
      plan = await request(`/v1/llm-runner/engine/resolve-assets?build=${encodeURIComponent(latest)}`);
      if (plan?.error) plan = null;
    } catch {
      plan = null;
    }
    // Nothing for THIS machine's graphics type at that build → refuse before writing anything.
    if (plan?.selected && plan.selected.resolved === false) {
      error.value = `${latest} has no download for this computer's graphics type (${plan.selected.gpu}). Nothing was changed.`;
      return;
    }
    const cfg = await request("/v1/ai/engine-config");
    pendingUpdate = { target: latest, previous: { pinnedBuild: cfg.pinnedBuild, binaries: cfg.binaries } };
    await request("/v1/ai/engine-config", {
      method: "PUT", body: { pinnedBuild: latest, binaries: planBinaries(cfg.binaries, plan, latest) },
    });
    await request("/v1/llm-runner/engine/install", {
      method: "POST", body: { force: true, replaceBuild: previous },
    });
    updateInfo.value = null;
    await refreshEngine();
    // An install that dies inside the first poll interval never sets status=installing, so
    // _syncPoll's terminal branch would never run — decide here too.
    if (pendingUpdate && st.value?.status !== "installing") {
      if (shouldRollback(pendingUpdate, st.value)) await rollbackPendingUpdate();
      else pendingUpdate = null;
    }
  } catch (e) {
    const msg = e.message || "Update failed.";
    error.value = msg;
    if (pendingUpdate) await rollbackPendingUpdate();
  } finally {
    busy.value = false;
  }
}

export function useEngine() {
  return {
    engineState: st, busy, error, statusKnown, installed, installing, progressLabel,
    updateInfo, updatePolicy, checkForUpdate, setUpdatePolicy, updateToLatest,
    warmDefaultOnStartup, refreshWarm, setWarmDefaultOnStartup,
    refreshEngine, install, cancel, uninstall, setBackend,
  };
}
