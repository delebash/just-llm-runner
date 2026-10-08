// SPDX-License-Identifier: MIT
// Resolve a model's effective spawn-flag switches by LAYERING the data-driven switch tables
// (design §6 + Plan B 2026-07-05) — the port of llm/switch_resolve.py. A pure read over the
// shared database; returns a `{flag_name: flag_value}` object the runner turns into its
// Overrides at load — so it flows through the EXISTING, already-tested Override path and
// never touches the spawn / compose-flags logic.
//
// Layer order (later wins):
//     base preset  →  the model's TYPE preset (moe | dense)  →  the gated auto-MTP preset
//     (`mtp`)  →  the seeded/editable per-(model, hardware-CLASS) tune (`class_tunes` — a
//     config portable across boxes of the same class)  →  the per-(model, machine) MEASURED
//     tune (`model_tunes` — Quick tune's Save; always wins over the class default).
//
// (The per-machine `hardware_switches` layer was RETIRED 2026-07-07: no writer, no seeder,
// no UI. `class_tunes` (portable) + `model_tunes` (this machine) cover its uses.)
//
// PROVENANCE: `resolveModelSwitchesWithOrigins` also returns WHICH layer last wrote each
// key — the UI's per-row provenance tags ride it. Origin ids: `base` · `type` · `mtp` ·
// `class` · `tune`.
//
// AUTO-MTP (user decision 2026-07-05, Plan B D3): the `mtp` preset applies when the model's
// `mtp` ENABLE flag is set (2026-07-13 split — availability is the separate `mtpCapable`
// fact). Everything auto-enabled stays user-visible + changeable: unchecking MTP in Quick
// tune saves `spec_type=none` into the model-tune layer, which WINS. A hand-checked `mtp`
// on a model that can't run it fails at load with llama-server's own error.
//
// There is no per-job/per-feature switch layer — engine config is owned by the action →
// preset refs (`engine_presets` own every tunable, 2026-07-15).

import { pyStr, strip } from "../platform/py.js";
import * as db from "./db.js";

// ── Active engine backend (Pass 2, 2026-07-22) ───────────────────────────────
// llm/ must not import runner/ (install.js is the one coupling point), so the ACTIVE engine
// family reaches the tune layers through this injected hook — the setEnsureLocalModel
// pattern. null (standalone, tests, pre-boot) → no backend context → legacy behavior.
let activeBackendFn = null;

/** Host wiring at boot: a SYNCHRONOUS callable returning the active engine FAMILY
 * ("cuda" | "rocm" | "vulkan" | "metal" | "cpu"; "" unknown). null unsets it. */
export function setActiveBackendFn(fn) {
  activeBackendFn = fn;
}

/** The active engine family, or "" when unknown/unwired (best-effort). */
export function activeBackend() {
  try {
    return activeBackendFn ? pyStr(activeBackendFn() || "") : "";
  } catch {
    return ""; // a status probe must never break resolution
  }
}

/**
 * Does a stored tune/measurement row apply under the active backend? Rows are STAMPED with
 * the backend they were measured on; "" = legacy (cuda-era, before the column existed) and
 * is read as "cuda". No active context ("" — unwired/unknown) → true, preserving pre-Pass-2
 * behavior.
 */
export function tuneRowApplies(rowBackend, active = null) {
  const act = active ?? activeBackend();
  if (!act) return true;
  const row = strip(rowBackend || "") || "cuda";
  return row === act;
}

/** {flag_name: flag_value} of one switch preset (Python's query has no ORDER BY — so none
 * here: SQLite answers the same way for both). */
function presetSwitches(h, presetId) {
  const out = {};
  for (const r of h.all("select * from preset_switches where preset_id = ?", [presetId], "preset_switches")) {
    out[r.flag_name] = r.flag_value;
  }
  return out;
}

/**
 * The merged model-level switch object for `modelId` PLUS the provenance map (flag_name →
 * the layer that last wrote it: base|type|mtp|class|tune) — `[merged, origins]`. Empty
 * when nothing is configured.
 */
export function resolveModelSwitchesWithOrigins(modelId, hwKey = "", classKey = "") {
  const h = db.session();
  const model = h.get("model_catalog", modelId);
  const mtype = model ? model.type || "dense" : "dense";

  const presets = h.all("select * from switch_presets order by position, id", [], "switch_presets");
  const byApplies = new Map();
  for (const p of presets) {
    if (!byApplies.has(p.applies_to)) byApplies.set(p.applies_to, []);
    byApplies.get(p.applies_to).push(p);
  }

  const merged = {};
  const origins = {};

  const apply = (appliesTo, origin) => {
    for (const p of byApplies.get(appliesTo) || []) {
      for (const [k, v] of Object.entries(presetSwitches(h, p.id))) {
        merged[k] = v;
        origins[k] = origin;
      }
    }
  };

  apply("all", "base"); // base — every model
  apply(mtype, "type"); // the model's type preset (moe | dense)
  // gated auto-MTP: apply the mtp preset when MTP is ENABLED (2026-07-13 split). `model.mtp`
  // is the single user-facing enable flag — checking the box (or the seed default) turns it
  // on, UNCHECKING turns it off even with a draft file still configured.
  if (model != null && model.mtp) apply("mtp", "mtp");
  // seeded/editable per-(model, HARDWARE-CLASS) tune: a config measured on one box, portable
  // to every box of the same class. BELOW the machine's own tune, ABOVE base/type/mtp.
  if (classKey) {
    for (const r of h.all(
      "select * from class_tunes where model_id = ? and class_key = ?",
      [modelId, classKey],
      "class_tunes",
    )) {
      merged[r.flag_name] = r.flag_value;
      origins[r.flag_name] = "class";
    }
  }
  if (hwKey) {
    // per-(model, machine) MEASURED tune — LAST so the user's saved tune (incl. an MTP
    // opt-OUT of the auto layer) always wins. Pass 2: a tune measured on ONE engine family
    // must not follow the model onto another (the qwen ctx-131072 CUDA tune applied on the
    // cpu engine) — rows are backend-stamped at save; legacy "" reads as cuda; no active
    // context → everything applies.
    const act = activeBackend();
    for (const r of h.all(
      "select * from model_tunes where model_id = ? and hw_key = ?",
      [modelId, hwKey],
      "model_tunes",
    )) {
      if (!tuneRowApplies(r.backend ?? "", act)) continue;
      merged[r.flag_name] = r.flag_value;
      origins[r.flag_name] = "tune";
    }
  }
  return [merged, origins];
}

/** The merged model-level switch object for `modelId` (and optionally the detected machine
 * `hwKey` + hardware `classKey`) — the values-only view of
 * `resolveModelSwitchesWithOrigins`. Empty when nothing is configured. */
export function resolveModelSwitches(modelId, hwKey = "", classKey = "") {
  return resolveModelSwitchesWithOrigins(modelId, hwKey, classKey)[0];
}
