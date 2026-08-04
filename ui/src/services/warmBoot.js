// SPDX-License-Identifier: MIT
// Warm-on-boot, kit-owned (2026-08-04 ruling: the loading-model surface is SHARED —
// both consumers carried private copies of this file and they had already drifted).
// On startup run the SAME workflow every load button runs, nothing bespoke (JW's
// 2026-07-21 ruling: "run existing function 1 2 3, no new fancy warm boot function"):
//   1. read the warmDefaultOnStartup toggle (GET /v1/ai/engine-config),
//   2. resolve the default LOCAL chat model (empty ⇒ the default isn't a local model
//      ⇒ no-op — a cloud-default user never triggers a load OR an engine install),
//   3. useRunnerModels().retryLoad — engine check → install-if-missing → load.
// `warmModelId` is the ONE signal a host splash renders on; <BootModelLoad /> shows
// the shared engine + load DownloadBars for it and clears it when the model goes
// resident (or the user continues). Call this BEFORE app.mount() so the host splash
// is up on the first Vue paint — the seamless hand-off from the static index.html
// plate (JW main.js:194-199, the donor).

import { ref } from "vue";
import { request } from "../client.js";
import { useRunnerModels } from "../composables/useRunnerModels.js";
import { useModelApply } from "./modelApply.js";

// The model being warmed ("" = none). The host splash overlay v-ifs on this.
export const warmModelId = ref("");

export async function startWarmOnBoot({ skip } = {}) {
  // `skip` — a host predicate for boots that must never warm (JW's bench harness
  // drives the renderer headless and loads its leg models itself; a warm co-load
  // rode along every leg — defect F, 2026-07-22).
  if (skip && skip()) return;
  try {
    const cfg = await request("/v1/ai/engine-config");
    if (!cfg?.warmDefaultOnStartup) return; // 1. toggle off → nothing to do

    // 2. The default LOCAL chat model — the SAME resolution the catalog's Default
    //    badge uses. Empty ⇒ the default provider isn't the local runner ⇒ no-op.
    const { refreshApplied, currentDefaultId } = useModelApply();
    await refreshApplied();
    const modelId = currentDefaultId.value;
    if (!modelId) return;

    // 3. Show it on the host splash + run the SAME load a button runs — engine
    //    check + install-if-missing + load all live inside retryLoad. Fire-and-
    //    forget: the runner-models singleton drives the bars from here.
    warmModelId.value = modelId;
    useRunnerModels().retryLoad(modelId);
  } catch {
    // best-effort — the on-demand load on first use still covers a miss
    warmModelId.value = "";
  }
}
