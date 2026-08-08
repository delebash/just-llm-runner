// SPDX-License-Identifier: MIT
// Renderer UI preferences — the client half of the family /v1/prefs door
// (server: llm_runner.platform.make_prefs_router; JustVoice's client was the
// donor, target-tree P9). Server-backed, NOT localStorage — a thin client and
// a reinstalled machine read the same prefs.
//
// bootPrefs() pulls the whole prefs document into a REACTIVE in-memory cache
// before Vue mounts; views read it (often inside computeds, so it must be
// reactive) and writePref() updates the cache + queues a debounced PATCH.
//
// HTTP goes through the shared kit transport, which the host wired with the
// base (+ bearer where used) at boot — call bootPrefs() after that wiring.

import { reactive } from "vue";
import { patch, safeRequest } from "../common/services/serverApi.js";

// Reactive so computeds across views re-evaluate when a pref changes.
const _doc = reactive({});

const _timers = new Map();
const PATCH_DEBOUNCE_MS = 150;

/** Boot the prefs cache. MUST be awaited before mounting Vue so views read
 *  populated data. Resilient: boots empty (defaults) on failure. */
export async function bootPrefs() {
  const doc = await safeRequest("/v1/prefs", null);
  if (doc && typeof doc === "object") Object.assign(_doc, doc);
}

/** Read a pref's value (reactive), or `fallback` if unset. */
export function readPref(key, fallback = undefined) {
  return key in _doc ? _doc[key] : fallback;
}

function _patch(body) {
  // keepalive so a flush during pagehide/beforeunload still lands.
  return patch("/v1/prefs", body, { keepalive: true }).catch((err) =>
    console.error("prefs PATCH failed:", err),
  );
}

/** Write a pref wholesale: update the cache and queue a debounced PATCH. */
export function writePref(key, value) {
  _doc[key] = value;
  const existing = _timers.get(key);
  if (existing) clearTimeout(existing);
  _timers.set(key, setTimeout(() => { _timers.delete(key); _patch({ [key]: value }); }, PATCH_DEBOUNCE_MS));
}

/** Flush pending debounced writes immediately (e.g. before unload). */
export function flushPrefs() {
  const keys = [..._timers.keys()];
  if (!keys.length) return;
  const body = {};
  for (const k of keys) { clearTimeout(_timers.get(k)); _timers.delete(k); body[k] = _doc[k]; }
  _patch(body);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPrefs);
  window.addEventListener("beforeunload", flushPrefs);
}
