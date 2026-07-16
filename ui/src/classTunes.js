// SPDX-License-Identifier: GPL-3.0-or-later
// Shared client for the hardware-class tune library (/v1/ai/class-tunes — ROUND 8
// Task C). ONE source for the endpoint paths + the class-key display label, used by
// the Tune modal's "Save for hardware class" action, its LuClassTunes drawer, and
// QuickSetup's class-tune-matched check (the modelDefaults.js precedent: a small
// shared module instead of three fetch copies).
import { request } from "./client.js";

// The whole library + the CURRENT box's class key (server-derived):
// { classKey, tunes: [{ modelId, classKey, builtIn, rows: [{flagName, flagValue}] }] }
export async function listClassTunes() {
  return request("/v1/ai/class-tunes");
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

// THE one switch-row upsert, shared by BOTH tune endpoints — because both carry the same
// hazard: they are wholesale REPLACE, not merge. class-tunes deletes every row of the
// (model, class) pair before inserting (stores.py:970-975); model-tunes does the same per
// model, pinned by tests/test_model_tunes.py::test_put_replaces_the_whole_set ("the old
// batch_size row is GONE, not merged"). So a caller changing ONE key MUST send the whole set
// back — sending `{one_key}` alone silently destroys that row's n_gpu_layers / n_cpu_moe /
// ctx_len / …. It lives here, once, so the next one-key writer cannot hand-roll a partial PUT
// against either endpoint (two private copies is how the class-tune one got shipped).
//
// Note a row can EXIST while a BROADER layer still owns the key you're writing (the row just
// doesn't carry it), so "the resolved origin isn't `class`/`tune`" NEVER implies "no row to
// preserve" — always upsert. `rows` = [{flagName, flagValue}]; absent/[] (no row yet)
// correctly yields just the new key, which is the create case.
export function upsertSwitchRows(rows, flagName, flagValue) {
  const kept = (rows || [])
    .filter((r) => r.flagName !== flagName)
    .map((r) => ({ flagName: r.flagName, flagValue: String(r.flagValue ?? "") }));
  return [...kept, { flagName, flagValue: String(flagValue) }];
}

// The same upsert in the `switches` OBJECT shape putClassTune takes (it re-converts to rows
// at :23). One implementation, two wire shapes — never a second upsert.
export function mergeClassSwitches(rows, flagName, flagValue) {
  return Object.fromEntries(upsertSwitchRows(rows, flagName, flagValue).map((r) => [r.flagName, r.flagValue]));
}

export async function deleteClassTune(modelId, classKey) {
  const q = `modelId=${encodeURIComponent(modelId)}&classKey=${encodeURIComponent(classKey)}`;
  return request(`/v1/ai/class-tunes?${q}`, { method: "DELETE" });
}

// `vram8|ram32` → "8 GB VRAM · 32 GB RAM" (the user-facing name for a hardware
// class — no internal key syntax in copy); `cpu|ram16` → "No GPU · 16 GB RAM".
// An unrecognized shape renders verbatim rather than lying.
export function classKeyLabel(key) {
  const m = /^vram(\d+)\|ram(\d+)$/.exec(key || "");
  if (m) return `${m[1]} GB VRAM · ${m[2]} GB RAM`;
  const c = /^cpu\|ram(\d+)$/.exec(key || "");
  if (c) return `No GPU · ${c[1]} GB RAM`;
  return key || "";
}
