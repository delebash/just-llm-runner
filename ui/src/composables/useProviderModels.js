// SPDX-License-Identifier: GPL-3.0-or-later
// useProviderModels — THE shared per-provider model-list cache (C5): one
// module-scoped cache over the one endpoint accessor
// (useProviderConnect.listModels → GET /v1/llm-providers/{id}/models), so
// every picker surface (LuModelPicker, the hosts' feature-pin surfaces) sees
// the same data without redundant fetches. Replaces the two parallel caches
// that existed before (JustWrite's useModelList module cache and
// LuModelPicker's per-instance one).
//
// Entries are plain model-id strings — the endpoint returns ids; presentation
// (labels, badges) is the consumer's job. In-memory only (a session cache of
// a re-fetchable list); an in-flight set coalesces concurrent ensures/
// refreshes of the same provider so a burst of pickers costs one request.
//
// NOTE (recorded in the C5 design): listModels currently lives in
// common/composables/useProviderConnect.js, which is one of the five filed
// common-layer files importing the llm client; when that filed item executes
// and listModels moves to the llm layer, this import becomes the clean
// llm→llm edge.
import { reactive } from "vue";

import { listModels } from "../common/composables/useProviderConnect.js";

// providerId → string[] of model ids. Module-scoped: shared across every
// consumer in the app for the whole session.
const modelsByProvider = reactive({});
// providerIds with a fetch in flight — concurrent callers coalesce.
const inFlight = new Set();

async function fetchInto(providerId) {
  if (inFlight.has(providerId)) return;
  inFlight.add(providerId);
  try {
    const r = await listModels(providerId);
    const models = (r?.models || []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
    modelsByProvider[providerId] = models;
  } catch {
    // Leave any previous list alone on failure — stale results beat a blank
    // list mid-pick; an explicit refresh is the user's retry path.
    if (!modelsByProvider[providerId]) modelsByProvider[providerId] = [];
  } finally {
    inFlight.delete(providerId);
  }
}

export function useProviderModels() {
  /** The cached list for a provider ([] until something fetched it). */
  function modelsFor(providerId) {
    return modelsByProvider[providerId] || [];
  }

  /** Lazy fetch: only when nothing cached and nothing in flight. */
  function ensureModels(providerId) {
    if (!providerId) return;
    if (inFlight.has(providerId)) return;
    const cached = modelsByProvider[providerId];
    if (cached && cached.length > 0) return;
    fetchInto(providerId);
  }

  /** Explicit re-fetch (the Refresh affordance); concurrent calls coalesce. */
  function refreshModels(providerId) {
    if (!providerId) return;
    fetchInto(providerId);
  }

  return { modelsFor, ensureModels, refreshModels };
}
