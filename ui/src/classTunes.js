// SPDX-License-Identifier: GPL-3.0-or-later
// Shared client for the hardware-class tune library (/v1/ai/class-tunes — ROUND 8
// Task C). ONE source for the endpoint paths + the class-key display label, used by
// the Tune modal's "Save for hardware class" action, its LuClassTunes drawer, and
// QuickSetup's class-tune-matched check (the modelDefaults.js precedent: a small
// shared module instead of three fetch copies).
import { request } from "./client.js";

// The whole library + the CURRENT box's class key (server-derived, override-aware):
// { classKey, classes: [{classKey, vramGb, ramGb, name, builtIn}],
//   tunes: [{ modelId, classKey, builtIn, rows: [{flagName, flagValue}] }] }
export async function listClassTunes() {
  return request("/v1/ai/class-tunes");
}

// Add/edit a NAMED hardware class (2026-07-22, type-first). The server DERIVES the
// classKey from memType+vramGb+ramGb; `origClassKey` (edit only) lets a change relocate
// the class's configs. `memType` = discrete | integrated | unified (discrete uses
// vramGb+ramGb; the one-pool types use ramGb as the memory). Returns the whole library.
export async function saveHardwareClass({ name = "", memType = "discrete", vramGb, ramGb, origClassKey = "" }) {
  return request("/v1/ai/hardware-class", {
    method: "PUT",
    body: { name, memType, vramGb: Number(vramGb) || 0, ramGb: Number(ramGb) || 0, origClassKey },
  });
}

// Delete a hardware class AND its model-configs. Returns the updated library.
export async function deleteHardwareClass(classKey) {
  return request(`/v1/ai/hardware-class?classKey=${encodeURIComponent(classKey)}`, {
    method: "DELETE",
  });
}

// Replace one (model, class) config wholesale. `classKey` omitted/"" → the current
// box's class (the "Save for hardware class" path). `switches` = { name: value }.
export async function putClassTune(modelId, switches, classKey = "") {
  return request("/v1/ai/class-tunes", {
    method: "PUT",
    body: {
      modelId,
      classKey,
      switches: Object.entries(switches || {}).map(([flagName, flagValue]) => ({
        flagName, flagValue: String(flagValue ?? ""),
      })),
    },
  });
}

// ⚠ ONE-KEY WRITERS, READ FIRST: both tune endpoints are wholesale REPLACE, not merge
// (class-tunes deletes every row of the (model, class) pair before inserting,
// stores.py:970-975; model-tunes pinned by test_model_tunes::test_put_replaces_the_whole_set).
// A caller changing ONE key MUST GET the full set and send it all back — a partial PUT
// silently destroys the row's other switches. The shared upsert helpers that guarded this
// (upsertSwitchRows/mergeClassSwitches) were DELETED 2026-07-16 with their only consumer
// (the chip's layer-writing save — superseded by the preset tier); recover them from git
// history before hand-rolling a new partial write.

export async function deleteClassTune(modelId, classKey) {
  const q = `modelId=${encodeURIComponent(modelId)}&classKey=${encodeURIComponent(classKey)}`;
  return request(`/v1/ai/class-tunes?${q}`, { method: "DELETE" });
}

// The user-facing name for a hardware class. A non-blank `name` (the free label,
// 2026-07-22) wins; else the plain-words hardware from the type-first key —
// `dgpu-vram8|ram32` → "8 GB VRAM · 32 GB RAM", `igpu-mem16` → "Integrated GPU · 16 GB",
// `unified-mem192` → "Unified memory · 192 GB". No internal key syntax in copy; an
// unrecognized shape renders verbatim rather than lying. Callers passing only `key`
// keep the plain-words behavior (name defaults blank).
export function classKeyLabel(key, name = "") {
  if (name && name.trim()) return name.trim();
  let m = /^dgpu-vram(\d+)\|ram(\d+)$/.exec(key || "");
  if (m) return `${m[1]} GB VRAM · ${m[2]} GB RAM`;
  m = /^unified-mem(\d+)$/.exec(key || "");
  if (m) return `Unified memory · ${m[1]} GB`;
  m = /^igpu-mem(\d+)$/.exec(key || "");
  if (m) return `Integrated GPU · ${m[1]} GB`;
  return key || "";
}
