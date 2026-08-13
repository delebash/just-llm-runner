// SPDX-License-Identifier: MIT
// Shared client for the measurement history (/v1/ai/model-measurements — #142
// rows 5+6, 2026-07-07). ONE source for the endpoint paths, used by the Tune
// modal's "Load & measure" recorder and its history drawer (the classTunes.js
// precedent: a small shared module instead of fetch copies).
import { request } from "./client.js";

// History, newest first — the whole ledger, or one model's with `modelId`:
// { machineKey, measurements: [{ id, modelId, machineKey, source, label,
//   tokensPerSec, vramTotalMb, at, switches: [{flagName, flagValue}] }] }
//
// SPEED surfaces (the Tune modal's history drawer, Lab compare) must show only
// source tune|autotune (fit-redesign §6.3): since Phase 5 the ledger also holds
// source='load' footprint rows and 'probe' machine rows (tokensPerSec 0 or a
// GB/s figure) — real data, but not decode-speed history. Filter here, once.
export async function listMeasurements(modelId = "") {
  const q = modelId ? `?modelId=${encodeURIComponent(modelId)}` : "";
  const res = await request(`/v1/ai/model-measurements${q}`);
  return {
    ...res,
    measurements: (res.measurements || []).filter(
      (m) => m.source === "tune" || m.source === "autotune",
    ),
  };
}

// Record one measurement. The server stamps machineKey + the timestamp;
// `switches` = { name: value } (what the launch actually ran with).
export async function recordMeasurement(modelId, tokensPerSec, {
  vramTotalMb = 0, switches = {}, source = "tune", label = "",
} = {}) {
  return request("/v1/ai/model-measurements", {
    method: "POST",
    body: {
      modelId, tokensPerSec, vramTotalMb, source, label,
      switches: Object.entries(switches || {}).map(([flagName, flagValue]) => ({
        flagName, flagValue: String(flagValue ?? ""),
      })),
    },
  });
}

// The Clear-history button — one model's history with `modelId`, everything without.
export async function clearMeasurements(modelId = "") {
  const q = modelId ? `?modelId=${encodeURIComponent(modelId)}` : "";
  return request(`/v1/ai/model-measurements${q}`, { method: "DELETE" });
}
