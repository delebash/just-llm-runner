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

const st = ref(null); // engine_status() payload
const busy = ref(false); // an install/uninstall POST in flight
const error = ref("");
let pollTimer = null;

const installed = computed(() => !!st.value?.installed);
const installing = computed(() => st.value?.status === "installing");
const progressLabel = computed(() => {
  const s = st.value || {};
  return s.total ? `${fmtBytes(s.downloaded)} / ${fmtBytes(s.total)}` : "Downloading…";
});

function fmtBytes(n) {
  if (!n) return "";
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function _syncPoll() {
  if (st.value?.status === "installing") {
    if (!pollTimer) pollTimer = setInterval(refreshEngine, 800);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshEngine() {
  try {
    st.value = await request("/v1/llm-runner/engine/status");
    error.value = st.value?.status === "error" ? st.value?.error || "" : "";
  } catch (e) {
    error.value = e.message || "Couldn't read engine status.";
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

export function useEngine() {
  return { engineState: st, busy, error, installed, installing, progressLabel, refreshEngine, install, uninstall };
}
