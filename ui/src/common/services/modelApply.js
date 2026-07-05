// SPDX-License-Identifier: GPL-3.0-or-later
// Shared model-apply service — the ONE place that (a) reads the current default LLM + the
// current embedding (the catalog's Default / Embedding badges) and (b) applies a model as the
// default (written onto the task presets, non-clobber) or as the embedding (routing.default).
//
// A module-singleton (the useRunnerModels / useCatalogMeta precedent) because QuickSetup AND
// LuModelCatalog both mount on the Providers tab: after a QuickSetup Apply the catalog's Default
// badge must update without its own re-fetch, so the applied state is ONE shared source.
//
// Reuse (RULE #7): the embedding write goes through useRouting (the one routing-doc writer — no
// second PUT); the preset-write for defaults is genuinely new (it is NOT in useRouting) and is
// lifted verbatim from QuickSetup's Apply so the two surfaces share one implementation.
import { computed, ref } from "vue";

import { request } from "../../client.js";
import { useRouting } from "../composables/useRouting.js";

export const LOCAL_RUNNER_ID = "local-llamacpp";

const defaultModelId = ref("");   // the dominant model across the task presets (Default badge)
const embeddingModelId = ref(""); // routing.default.embeddingModel, only when it is a LOCAL embed

export const currentDefaultId = computed(() => defaultModelId.value);
export const currentEmbeddingId = computed(() => embeddingModelId.value);

// The dominant model across the task presets = the current shared default: the mode of `.model`
// across the presets the taskKinds point at (+ defaultPresetId), stable order. Returns the mode
// + the resolved taskPresets. This is the EXACT logic QuickSetup's Apply shipped, extracted here.
function dominantOf(assignments, presets) {
  const byId = Object.fromEntries((presets || []).map((p) => [p.id, p]));
  const ids = new Set(Object.values(assignments?.taskKinds || {}).filter(Boolean));
  if (assignments?.defaultPresetId) ids.add(assignments.defaultPresetId);
  const taskPresets = [...ids]
    .map((id) => byId[id])
    .filter(Boolean)
    .sort((a, b) => (a.position - b.position) || (a.id < b.id ? -1 : 1)); // stable → deterministic ties
  const counts = {};
  for (const p of taskPresets) counts[p.model] = (counts[p.model] || 0) + 1;
  let dominant = "";
  let dominantProviderId = ""; // the provider the dominant model's presets point at (for the badge gate)
  let best = -1;
  for (const p of taskPresets) {
    if (counts[p.model] > best) { best = counts[p.model]; dominant = p.model; dominantProviderId = p.providerId || ""; }
  }
  return { dominant, dominantProviderId, taskPresets };
}

// (Re)load the current default + embedding into the shared refs (badges). Call on open + after
// any apply. The Embedding badge is gated on the local runner so a same-named cloud embed can't
// false-match a catalog id.
export async function refreshApplied() {
  try {
    const [asg, pr, r] = await Promise.all([
      request("/v1/ai/preset-assignments"),
      request("/v1/ai/engine-presets"),
      request("/v1/ai/routing"),
    ]);
    const dom = dominantOf(asg, pr.presets || []);
    // Default badge only for a LOCAL dominant — an external default must not false-match a
    // same-id local catalog row (mirrors the embedding-badge gate below).
    defaultModelId.value = dom.dominantProviderId === LOCAL_RUNNER_ID ? (dom.dominant || "") : "";
    embeddingModelId.value = r.default?.embeddingId === LOCAL_RUNNER_ID ? (r.default?.embeddingModel || "") : "";
  } catch {
    defaultModelId.value = "";
    embeddingModelId.value = "";
  }
}

// Set `providerId`/`modelId` as the default on every task preset that still shares the PREVIOUS
// dominant model (non-clobber: a preset the user re-pointed keeps its own model). Each preset
// keeps ALL its per-task settings — the PUT sends `{...p, providerId, model}`, so only the
// routing changes. The catalog + the local QuickSetup path pass LOCAL_RUNNER_ID (a no-op on
// providerId — presets already point at the bundled runner); the QuickSetup other-provider path
// passes the connected provider's id, so a task's routing flips to it.
export async function setAsDefault(providerId, modelId) {
  const [asg, pr] = await Promise.all([
    request("/v1/ai/preset-assignments"),
    request("/v1/ai/engine-presets"),
  ]);
  const { dominant, taskPresets } = dominantOf(asg, pr.presets || []);
  for (const p of taskPresets) {
    if (p.model !== dominant) continue; // overridden by the user — non-clobber
    if (p.providerId === providerId && p.model === modelId) continue; // already the target
    await request(`/v1/ai/engine-presets/${p.id}`, { method: "PUT", body: { ...p, providerId, model: modelId } });
  }
  await refreshApplied();
}

// Set `providerId`/`modelId` as the default embedding — REUSES useRouting (one routing-doc
// writer; preserves the default llmId/model + the per-feature pins). The catalog passes
// (LOCAL_RUNNER_ID, id); QuickSetup passes the user's saved (possibly non-local) embedding
// provider, so its choice is never silently clobbered to the local runner.
export async function setAsEmbedding(providerId, modelId) {
  const routing = useRouting();
  await routing.loadRouting();
  await routing.setDefaultEmbedding({ providerId, model: modelId }); // awaitable → persisted before refresh
  await refreshApplied();
}

// Shared applied-state + actions. Every consumer gets the SAME refs; call refreshApplied() on
// open (or after a catalog edit) to (re)populate the badges.
export function useModelApply() {
  return { currentDefaultId, currentEmbeddingId, refreshApplied, setAsDefault, setAsEmbedding, LOCAL_RUNNER_ID };
}
