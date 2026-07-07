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
