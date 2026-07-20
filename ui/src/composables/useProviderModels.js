// SPDX-License-Identifier: GPL-3.0-or-later
// useProviderModels — THE shared per-provider model-list cache (C5): one
// module-scoped cache over the one endpoint accessor
// (useProviderConnect.listModels → GET /v1/llm-providers/{id}/models), so
// every picker surface (LuModelPicker, the hosts' feature-pin surfaces) sees
// the same data without redundant fetches. Replaces the two parallel caches
// that existed before (JustWrite's useModelList module cache and
// LuModelPicker's per-instance one).
//
// Each cached entry is the server's cleaned split { models, embeddings,
// hiddenCount } (#8, 2026-07-20): the endpoint applies the provider TYPE's
// model-list rules, so `models` is already the CHAT list, `embeddings` the
// classified embedding ids, and `hiddenCount` how many raw ids were pruned
// (drops + folded snapshots) — drives the pickers' "N hidden — show all"
// affordance. modelsFor() returns the chat ids (so every picker improves for
// free); embeddingsFor()/hiddenCountFor() expose the rest. refresh with
// { all: true } refetches ?all=1 (the raw list) for the session.
// In-memory only (a session cache of a re-fetchable list); an in-flight set
// coalesces concurrent ensures/refreshes of the same provider so a burst of
// pickers costs one request.
//
// NOTE: C5 recorded this import as an llm→common edge pending the filed
// layering fix; C6 (2026-07-06) executed it — useProviderConnect now lives in
// this same llm-layer composables/ directory, so this is the clean llm→llm
// edge C5 anticipated.
import { reactive } from "vue";

import { listModels } from "./useProviderConnect.js";

// providerId → { models: string[], embeddings: string[], hiddenCount: number }.
// Module-scoped: shared across every consumer in the app for the whole session.
const recordsByProvider = reactive({});
// providerIds with a fetch in flight — concurrent callers coalesce.
const inFlight = new Set();

const EMPTY = { models: [], embeddings: [], hiddenCount: 0 };

function normalize(r) {
  const ids = (list) => (list || []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
  return {
    models: ids(r?.models),
    embeddings: ids(r?.embeddings),
    hiddenCount: Number(r?.hiddenCount) || 0,
  };
}

async function fetchInto(providerId, { all = false } = {}) {
  if (inFlight.has(providerId)) return;
  inFlight.add(providerId);
  try {
    const r = await listModels(providerId, { all });
    recordsByProvider[providerId] = normalize(r);
  } catch {
    // Leave any previous record alone on failure — stale results beat a blank
    // list mid-pick; an explicit refresh is the user's retry path.
    if (!recordsByProvider[providerId]) recordsByProvider[providerId] = { ...EMPTY };
  } finally {
    inFlight.delete(providerId);
  }
}

export function useProviderModels() {
  function recordFor(providerId) {
    return recordsByProvider[providerId] || EMPTY;
  }
  /** The cached CHAT list for a provider ([] until something fetched it). */
  function modelsFor(providerId) {
    return recordFor(providerId).models;
  }
  /** The cached EMBEDDING list (server-classified; [] for local/unruled providers). */
  function embeddingsFor(providerId) {
    return recordFor(providerId).embeddings;
  }
  /** How many raw ids the server pruned (drops + folded snapshots); 0 when nothing hidden. */
  function hiddenCountFor(providerId) {
    return recordFor(providerId).hiddenCount;
  }

  /** Lazy fetch: only when nothing cached and nothing in flight. Returns the fetch
   *  promise (or undefined when it short-circuits) so a caller can await a loading state. */
  function ensureModels(providerId) {
    if (!providerId) return;
    if (inFlight.has(providerId)) return;
    const cached = recordsByProvider[providerId];
    if (cached && cached.models.length > 0) return;
    return fetchInto(providerId);
  }

  /** Explicit re-fetch (the Refresh / "show all" affordance); concurrent calls coalesce.
   *  Pass { all: true } to refetch the raw unfiltered list. Returns the fetch promise. */
  function refreshModels(providerId, opts = {}) {
    if (!providerId) return;
    return fetchInto(providerId, opts);
  }

  return { modelsFor, embeddingsFor, hiddenCountFor, ensureModels, refreshModels };
}
