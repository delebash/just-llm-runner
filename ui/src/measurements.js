// SPDX-License-Identifier: GPL-3.0-or-later
// Shared client for the measurement history (/v1/ai/model-measurements — #142
// rows 5+6, 2026-07-07). ONE source for the endpoint paths, used by the Tune
// modal's "Load & measure" recorder and its history drawer (the classTunes.js
// precedent: a small shared module instead of fetch copies).
import { request } from "./client.js";

// History, newest first — the whole ledger, or one model's with `modelId`:
// { machineKey, measurements: [{ id, modelId, machineKey, source, label,
//   tokensPerSec, vramTotalMb, at, switches: [{flagName, flagValue}] }] }
export async function listMeasurements(modelId = "") {
  const q = modelId ? `?modelId=${encodeURIComponent(modelId)}` : "";
  return request(`/v1/ai/model-measurements${q}`);
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
