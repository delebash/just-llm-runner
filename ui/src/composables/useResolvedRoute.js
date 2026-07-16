// SPDX-License-Identifier: GPL-3.0-or-later
// useResolvedRoute — THE shared cache over GET /v1/ai/resolved-route (B5-1,
// §7.2): what a run of a feature/action routes to RIGHT NOW (task preset →
// dispatch fallback), computed SERVER-side by the run path's own functions so
// a provenance chip can never drift from what a run actually does. Consumed
// by the hosts' read-only "runs on" chips (JustWrite's AiFeatureChip binding;
// JustVoice later) — the same one-cache-one-endpoint shape as
// useProviderModels.
//
// Entries are the wire rows ({ providerId, model, presetId, presetName,
// presetSource, think, level, reasoningWord, value, valueSource, configured,
// detail }) — `value`/`valueSource` (2026-07-16 house layering) are the reasoning
// budget a run emits and the LAYER it came from; the old ask/cap/effective/
// capSource clamp fields are GONE from the wire. Presentation (provider display
// name, the source LABEL below) is the consumer's job. In-memory session cache of
// a re-fetchable read; an in-flight map coalesces concurrent ensures of the same
// key so a page of chips costs one request per feature.
//
// OVERRIDES: ensure/refresh/routeFor take optional providerId/model — the
// endpoint's own override params (they mirror RunRequest) — so a Lab column can
// ask what ITS pinned route resolves to. An override-free call keeps the ORIGINAL
// cache key, so a pinned column's row can never overwrite a feature chip's.
//
// INVALIDATION (the 2026-07-10 chip-staleness fix — user: Quick Setup ran and
// the chips kept saying "Not set up"): this module self-subscribes to the kit
// client's post-write notification and drops the whole cache after EVERY
// successful non-GET request. The original design left invalidateRoutes() for
// the writers to call and NONE ever did (zero callers — the forgot-to-wire
// class); a first fix allow-listed three endpoint families and the checker
// caught it re-creating the same drift ("forgot to add the endpoint to the
// regex") while already missing two live route-changers (/v1/llm-providers
// PATCH/DELETE mutates the registry resolved-route reads; a preset/assignment
// write — /v1/ai/engine-presets or /v1/ai/preset-assignments — repoints what a
// run resolves to). The kit client carries only AI/provider traffic and
// this cache is a handful of lazily-refilled rows, so any-write invalidation
// is always correct at negligible cost. Mounted chips self-heal: their
// watchEffect reads the reactive cache row, so the delete re-runs ensureRoute
// and refetches.
import { reactive } from "vue";

import { onRequestWrite, request } from "../client.js";

// THE source-label map (2026-07-16): a resolved-route `valueSource` → the user
// language every thinking-budget surface says it in — the feature chip's popover
// AND the Lab column's line. ONE export so the two can never drift into two
// vocabularies for the same layer. Cloud's "map" and the no-value "" carry no
// label on purpose: the budget line is a LOCAL-route surface.
export const RESOLVED_SOURCE_LABELS = {
  preset: "this preset", // the feature's own ask (2026-07-16 preset tier)
  tune: "your applied config",
  class: "hardware class default",
  base: "global default",
  default: "built-in default",
  invalid: "invalid value",
};

/** A resolved-route `valueSource` → its user-facing label ("" when it has none). */
export function resolvedSourceLabel(source) {
  return RESOLVED_SOURCE_LABELS[source] || "";
}

const cache = reactive({}); // key → resolved-route row
const inflight = new Map(); // key → Promise

onRequestWrite(() => invalidateRoutes());

function keyOf(feature, action, providerId, model) {
  const base = `${feature || ""} ${action || ""}`;
  // An override-free call keeps the ORIGINAL key shape — the chip path's rows stay
  // byte-identical; a pinned Lab column gets its OWN row.
  return providerId || model ? `${base}|${providerId || ""}|${model || ""}` : base;
}

async function fetchRoute(feature, action, providerId, model) {
  const q = new URLSearchParams({ feature });
  if (action) q.set("action", action);
  if (providerId) q.set("providerId", providerId);
  if (model) q.set("model", model);
  return request(`/v1/ai/resolved-route?${q}`);
}

/** The cached row for (feature, action[, providerId, model]), or null before the first fetch. */
function routeFor(feature, action = "", providerId = "", model = "") {
  return cache[keyOf(feature, action, providerId, model)] || null;
}

/** Fetch-if-absent. Coalesces concurrent calls per key. */
function ensureRoute(feature, action = "", providerId = "", model = "") {
  if (!feature) return Promise.resolve(null);
  const key = keyOf(feature, action, providerId, model);
  if (cache[key]) return Promise.resolve(cache[key]);
  return refreshRoute(feature, action, providerId, model);
}

/** Force a re-fetch (a routing/preset edit elsewhere invalidates us). */
function refreshRoute(feature, action = "", providerId = "", model = "") {
  if (!feature) return Promise.resolve(null);
  const key = keyOf(feature, action, providerId, model);
  if (inflight.has(key)) return inflight.get(key);
  const p = fetchRoute(feature, action, providerId, model)
    .then((row) => {
      cache[key] = row || null;
      return cache[key];
    })
    .catch((err) => {
      console.error("useResolvedRoute: fetch failed for", feature, action, err);
      return cache[key] || null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Drop every cached row — the next ensure re-fetches. Fired automatically by
 *  the routing-write subscription above; exported for hosts with out-of-band
 *  writes (none today). */
function invalidateRoutes() {
  for (const k of Object.keys(cache)) delete cache[k];
}

export function useResolvedRoute() {
  return { routeFor, ensureRoute, refreshRoute, invalidateRoutes };
}
