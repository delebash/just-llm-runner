// SPDX-License-Identifier: MIT
// Effective memory bandwidth per pool — the fit-redesign Phase 3 ladder (§5.5). The port of
// llm_runner/runner/bandwidth.py.
//
// Bandwidth is a MACHINE property; models are interchangeable lenses on it. Three sources,
// best first, each pool resolved independently:
//
//   1. DERIVED from stored measurements — `BW_eff = tok/s × bytes/token`, pool-matched, and
//      ONLY from rows whose launch config is KNOWN (switches recorded with the placement +
//      ctx) and un-sped (no draft/spec flags, model not MTP — §13.14: flagless rows never
//      qualify; token-level acceptance is not the speculation multiplier, so speculative
//      rows are excluded outright). Already EFFECTIVE — no efficiency factor applies.
//   2. DEVICE-REPORTED — NVIDIA: `nvidia-smi` bus width × mem clock × 2 (DDR), the device's
//      own registers (2070 SUPER: 256 bit × 7001 MHz × 2 = 448 GB/s, matching the vendor
//      spec). Apple: chip name → the published-spec table below. RAM (all platforms): a
//      one-time copy probe, persisted as a machine measurement row so it runs once per box,
//      self-healing after a Clear-history (§8.22). AMD/Intel dGPU: no reliable register path
//      → source 3. RAW numbers — the seeded efficiency family (device ~0.6 · host ~0.15,
//      err-slow low end) converts them to effective.
//   3. SEEDED class-typical fallback — the `hardware_classes` bw columns (JEDEC arithmetic +
//      vendor spec sheets), GUI-editable in the class editor, superseded by any higher
//      source. RAW.
//
// A pool that resolves NOWHERE stays null and the badge shows no band — an unknown never
// becomes a number (§8.17's spirit).
//
// Async: the probes that run a program or copy memory (nvidiaMemBwGbps, applePoolBwGbps,
// _copyPassGbps, probeRamCopyGbps) and resolveEffectiveBw (it calls the device probe) are
// async; the derivations are pure and sync. Python's keyword-only arguments are an options
// object; resolveEffectiveBw returns [deviceEffGbps, hostEffGbps].

import os from "node:os";
import { getLogger } from "../platform/log.js";
import * as procs from "../platform/procs.js";
import { pyFloatParse, pyInt, pyRound, pySorted, splitlines, truthy } from "../platform/py.js";
import * as self from "./bandwidth.js";
import * as fit from "./fit.js";
import * as hardware from "./hardware.js";

const log = getLogger("llm_runner.runner.bandwidth");

// The pseudo-model id the RAM copy probe's result is persisted under in the measurement
// history (the plan's "machine measurement row"): `tokensPerSec` carries GB/s — the label
// says so. Filtered from per-model views by never being a catalog id; deleted by
// Clear-history → the probe simply re-runs.
export const RAM_PROBE_MODEL_ID = "__machine_ram_bw__";
export const RAM_PROBE_LABEL = "RAM copy bandwidth probe (GB/s in tokensPerSec)";

// The ONE-MINUTE SPEED CHECK's result (speed-truth plan 2026-09-19 §6): the host pool's
// effective MoE-expert streaming rate, measured by llama.cpp itself on the calibration
// model — GB/s in `tokensPerSec`, like the RAM probe. The label is BUILD-STAMPED (the
// `__overhead__` convention): a row from another engine build is not this build's truth and
// reads as absent, so an engine upgrade simply re-offers the check. Never auto-run (a
// download + two engine launches) — only Quick setup starts it, and only on the user's click.
export const MOE_PROBE_MODEL_ID = "__machine_moe_bw__";
export const MOE_PROBE_LABEL_PREFIX = "moe-stream probe";

export function moeProbeLabel(build) {
  return `${MOE_PROBE_LABEL_PREFIX} ${build}`;
}

// Apple-silicon UNIFIED-pool bandwidth, GB/s — Apple's own published specs (apple.com
// newsroom/tech-spec pages per chip). Facts like the JEDEC numbers, not tunables; a wrong
// entry is overridable via the class editor. Longest name wins the match (an "M1 Ultra"
// must not read as "M1"). Where one chip ships two memory configs the LOW one is seeded
// (err-slow, §8.17).
export const _APPLE_CHIP_BW_GBPS = [
  ["M1 Ultra", 800.0],
  ["M1 Max", 400.0],
  ["M1 Pro", 200.0],
  ["M1", 68.25],
  ["M2 Ultra", 800.0],
  ["M2 Max", 400.0],
  ["M2 Pro", 200.0],
  ["M2", 100.0],
  ["M3 Ultra", 800.0],
  ["M3 Max", 300.0],
  ["M3 Pro", 150.0],
  ["M3", 102.4],
  ["M4 Max", 410.0],
  ["M4 Pro", 273.0],
  ["M4", 120.0],
];

/**
 * Memory bandwidth of the largest-BW NVIDIA card from its own registers: bus width (bits) ×
 * memory clock (MHz) × 2 (DDR — nvidia-smi reports the half-rate clock for GDDR6/6X alike)
 * ÷ 8 bits. null when nvidia-smi is absent or the fields are unreadable (old drivers).
 */
export async function nvidiaMemBwGbps() {
  const out = await hardware._nvidiaQuery("memory.bus.width,clocks.max.memory");
  if (out == null) return null;
  let best = null;
  for (const line of splitlines(out)) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length !== 2) continue;
    let busBits;
    let clockMhz;
    try {
      busBits = pyFloatParse(parts[0]);
      clockMhz = pyFloatParse(parts[1]);
    } catch {
      continue;
    }
    if (busBits <= 0 || clockMhz <= 0) continue;
    const gbps = (((busBits / 8.0) * clockMhz * 2.0) / 1000.0);
    best = Math.max(best || 0.0, gbps);
  }
  return best;
}

/**
 * The unified pool's bandwidth from the chip name (macOS only) — the published-spec table
 * above. null off-macOS or for an unlisted chip.
 */
export async function applePoolBwGbps() {
  if (!hardware.systemName().toLowerCase().startsWith("darwin")) return null;
  let brand;
  try {
    const r = await procs.run(["sysctl", "-n", "machdep.cpu.brand_string"], { timeout: 5 });
    brand = String(r.stdout ?? "").trim();
  } catch (e) {
    log.debug(`sysctl brand_string failed: ${e?.message ?? e}`);
    return null;
  }
  for (const [chip, gbps] of _APPLE_CHIP_BW_GBPS) {
    if (brand.includes(chip)) return gbps;
  }
  return null;
}

/**
 * A probe buffer of `sizeMb` MiB, every byte really written (a bare allocation may be
 * lazily zero-mapped and would measure the page-fault path). Plain memory, NOT a
 * SharedArrayBuffer: V8 copies shared memory with a word-wise relaxed-atomic loop instead
 * of memcpy — measured 2026-10-07 on the author's box, 14.5–15.3 GB/s from shared memory
 * against 18.4–18.8 from plain (Python's `bytes(buf)`: 17.8–19.0), and the 0.40 host factor
 * is calibrated against Python's reading.
 */
export function _probeBuf(sizeMb) {
  const buf = new Uint8Array(Math.max(1, sizeMb) * (1 << 20));
  buf.fill(0xa5);
  return buf;
}

/** One copy the way Python's `bytes(buf)` makes it: a fresh allocation, then one memcpy. */
function copyOnce(view) {
  const ab = new ArrayBuffer(view.length);
  new Uint8Array(ab).set(view);
  return ab;
}

/** Let the event loop run between timed rounds (Python ran the probe on its own thread). */
const breathe = () => new Promise((r) => setImmediate(r));

/**
 * One probe PASS: copy every buffer and report bytes TOUCHED per second (read + write =
 * 2 × total ÷ wall). Best-of-`repeats` rejects scheduler noise without overstating hardware.
 *
 * Several buffers: Python starts one thread per buffer, believing `bytes(buf)` releases the
 * GIL during its memcpy so the streams run in parallel. It does NOT (CPython 3.12.9,
 * measured 2026-10-07: a spinning thread stalls for the whole copy), so Python's threaded
 * pass is the copies ONE AFTER ANOTHER, each freed inside the timed window ("del c" in the
 * thread) — and the seeded probe factor (`bwEffHostProbe`) was calibrated on that. This
 * port measures exactly that, serially (author's box: single 18.0–18.8, 4× 12.7–13.4, 16×
 * 13.3 GB/s; Python 18.9–19.0, 13.9–14.2, 13.4–13.7). Genuinely parallel streams read
 * 20–22 GB/s there — a change of answer that would need the factor re-calibrated, so it is
 * not made here.
 */
export async function _copyPassGbps(bufs, repeats = 3) {
  const total = bufs.reduce((s, b) => s + b.length, 0);
  if (!total) return null;
  let bestS = null;
  for (let r = 0; r < Math.max(1, repeats); r++) {
    await breathe();
    let dt;
    if (bufs.length === 1) {
      const t0 = performance.now();
      const copy = copyOnce(bufs[0]);
      dt = (performance.now() - t0) / 1000;
      copy.transfer(0); // "del copy" — after the clock, as Python's inline arm
    } else {
      const t0 = performance.now();
      for (const b of bufs) copyOnce(b).transfer(0); // each "thread": copy, then "del c"
      dt = (performance.now() - t0) / 1000;
    }
    if (dt > 0) bestS = bestS === null ? dt : Math.min(bestS, dt);
  }
  if (!bestS) return null;
  return (2.0 * total) / bestS / 1e9;
}

/**
 * One-shot system-RAM streaming probe, TOPOLOGY-AWARE (2026-08-13): a single stream reads a
 * controller-bound machine's ceiling exactly (dual-channel desktop, measured: 2/4/8 threads
 * ADD NOTHING — 18.9 single vs ~14 threaded), but a WIDE memory system (8-channel
 * workstation, Apple Max/Ultra) is single-CORE-bound — one stream can't keep enough
 * requests in flight and under-reads it badly. So the probe runs the single pass PLUS small
 * threaded passes (4 streams, and cores-capped-16 streams) and reports the BEST: every box
 * reads ITS OWN achievable parallel rate on its own topology, and the gather discount
 * (`bwEffHostProbe`, the §5.5-calibrated factor) stays a property of the ACCESS PATTERN,
 * not of any one machine. The threaded passes split the same total footprint across their
 * streams (no memory blow-up). ~2 s once per box, persisted; null on any failure.
 * (The "threaded" passes never ran in parallel — see `_copyPassGbps`; that 18.9-vs-14
 * measurement was the GIL, not the memory controller. Kept as Python measures it.)
 */
export async function probeRamCopyGbps(sizeMb = 256, repeats = 3) {
  try {
    const results = [await _copyPassGbps([_probeBuf(sizeMb)], repeats)];
    const cores = os.cpus().length || 1;
    for (const n of pySorted(new Set([4, Math.min(16, cores)]))) {
      if (n <= 1 || n > cores) continue;
      const bufs = Array.from({ length: n }, () => _probeBuf(Math.max(32, Math.floor(sizeMb / n))));
      results.push(await _copyPassGbps(bufs, repeats));
    }
    const vals = results.filter((r) => r);
    return vals.length ? pyRound(Math.max(...vals), 2) : null;
  } catch (e) {
    log.debug(`RAM copy probe failed: ${e?.message ?? e}`); // a probe failure must never throw
    return null;
  }
}

// ── Source 1: derivation from stored, config-known measurements ──────────────
// Rows arrive as plain objects {model_id, machine_key, backend, tokens_per_sec,
// switches: {flag: value}}; per-model speed facts as
// {model_id: {n_layers, mtp, size_mb, non_expert_mb, active_expert_mb, kv_facts}}.
// The caller adapts its wire shapes — this stays pure (and keeps Python's snake keys).

const SPEC_FLAGS = ["model_draft", "spec_type", "spec_draft_n_max", "spec_ngram_mod_n_max"];

/**
 * Normalize a row's switch keys to the UNDERSCORE knob vocabulary. The tune layers store
 * knob_catalog names (`n_cpu_moe`, `ctx_len`), while launch argv speaks dashed tokens
 * (`n-cpu-moe`, `ctx-size`). Phase 3's first cut matched only the dashed form, so the
 * derivation NEVER matched a real row — caught at Phase 5's fingerprint work. One canon,
 * both spellings accepted.
 */
export function _normSwitches(switches) {
  return Object.fromEntries(Object.entries(switches || {}).map(([k, v]) => [String(k).replaceAll("-", "_"), v]));
}

/** Python's `float(x)` → int, null where it raised TypeError/ValueError. */
function intOfFloat(raw) {
  try {
    if (raw === null || raw === undefined || typeof raw === "object") return null;
    return pyInt(pyFloatParse(raw));
  } catch {
    return null;
  }
}

/**
 * [ctx, cacheBits] from a row's NORMALIZED switches; ctx 0 = unknown. `ctx_len` is the knob
 * name; `ctx_size`/`ctx` tolerate rows recorded from launch-pair vocabulary.
 */
export function _rowCtxBits(switches) {
  const raw = switches.ctx_len || switches.ctx_size || switches.ctx || 0;
  const ctx = intOfFloat(raw) ?? 0;
  return [ctx, fit.cacheTypeBits(String(switches.cache_type_k || ""))];
}

export function _intFlag(switches, name) {
  const raw = Object.hasOwn(switches, name) ? switches[name] : null;
  if (raw == null) return null;
  return intOfFloat(raw);
}

/**
 * The shared derivation-rule filter (§13.8): this box, this backend (a legacy ""-backend
 * row never qualifies — cross-backend numbers are not comparable), a real number, recorded
 * switches (flagless never qualifies), un-sped (no draft/spec flags; MTP models excluded
 * outright — built-in heads may have been armed outside the recorded switches), known ctx.
 */
function* qualifying(rows, factsById, machineKey, backend) {
  for (const row of rows) {
    if (row.machine_key !== machineKey || row.backend !== backend) continue;
    const tokS = pyFloatParse(row.tokens_per_sec || 0);
    const sw = _normSwitches(row.switches);
    if (tokS <= 0 || !truthy(sw)) continue;
    if (SPEC_FLAGS.some((f) => Object.hasOwn(sw, f))) continue;
    const sf = Object.hasOwn(factsById, row.model_id) ? factsById[row.model_id] : null;
    if (!truthy(sf) || sf.mtp) continue;
    const [ctx, bits] = _rowCtxBits(sw);
    if (ctx <= 0) continue;
    yield [tokS, sw, sf, ctx, bits];
  }
}

const kvMb = (sf, ctx, bits) => fit.kvMbFromFacts(sf.kv_facts || {}, ctx, bits, { unit: 1e6 });

/**
 * Device-pool effective bandwidth from FULL-OFFLOAD DENSE rows (every byte the pass touches
 * lives on the device, so tok/s × bytes/pass IS the pool's effective rate). Max over
 * qualifying rows — each run is a lower bound on the machine (something else may have
 * bottlenecked it).
 */
export function deriveDeviceBwGbps(rows, factsById, { machineKey, backend }) {
  let best = null;
  for (const [tokS, sw, sf, ctx, bits] of qualifying(rows, factsById, machineKey, backend)) {
    if (sf.active_expert_mb) continue; // MoE rows are host evidence, handled below
    const ngl = _intFlag(sw, "n_gpu_layers");
    if (ngl === null || ngl < pyInt(sf.n_layers || 0) || (_intFlag(sw, "n_cpu_moe") || 0) > 0) continue;
    const bytesMb = pyFloatParse(sf.size_mb || 0) + kvMb(sf, ctx, bits);
    if (bytesMb <= 0) continue;
    best = Math.max(best || 0.0, (tokS * bytesMb) / 1000.0);
  }
  return best;
}

/**
 * Host-pool effective bandwidth from ALL-EXPERTS-IN-RAM MoE rows: price the device leg at
 * the resolved device bandwidth and attribute the remaining per-token time to the expert
 * gather (the Appendix-B derivation — the device side was measured 'insensitive' there, so a
 * seeded device number is fine). Needs a device estimate; rows whose device leg can't be
 * priced are skipped.
 */
export function deriveHostBwGbps(rows, factsById, { machineKey, backend, deviceEffGbps }) {
  if (!deviceEffGbps || deviceEffGbps <= 0) return null;
  let best = null;
  for (const [tokS, sw, sf, ctx, bits] of qualifying(rows, factsById, machineKey, backend)) {
    const hostMb = pyFloatParse(sf.active_expert_mb || 0);
    if (hostMb <= 0) continue;
    const nLayers = pyInt(sf.n_layers || 0);
    const ngl = _intFlag(sw, "n_gpu_layers");
    const ncmoe = _intFlag(sw, "n_cpu_moe");
    if (ngl === null || ncmoe === null || nLayers <= 0 || ngl < nLayers || ncmoe < nLayers) continue; // placement not the clean all-experts-host shape
    const devMb = pyFloatParse(sf.non_expert_mb || 0) + kvMb(sf, ctx, bits);
    const remainingS = 1.0 / tokS - devMb / 1000.0 / deviceEffGbps;
    if (remainingS <= 0) continue; // device pricing ate the whole budget — not solvable from this row
    best = Math.max(best || 0.0, hostMb / 1000.0 / remainingS);
  }
  return best;
}

/**
 * [deviceEffGbps, hostEffGbps] down the ladder. Source-1 numbers are already effective;
 * sources 2/3 are raw × their efficiency factor. The RAM probe carries its OWN factor
 * (`effHostProbe` — §5.5's probe calibration, live-calibrated 2026-08-13): its copy
 * underruns multi-channel streaming, so pricing it with the generic host factor
 * under-banded every MoE on the author's box.
 *
 * `moeProbeGbps` — the one-minute speed check's result (speed-truth plan 2026-09-19 §6) —
 * sits between real-model derivation and the memcpy probe: it is llama.cpp's own expert
 * streaming on this box, already effective, no factor. On the author's box it read 27.5 GB/s
 * and predicted the flagship's measured un-sped speed within 5 % (25.3 vs 26.6 tok/s), where
 * probe × 0.40 said 8.4 (plan §11.4). A real model measured here (source 1) still outranks it.
 */
export async function resolveEffectiveBw({
  rows,
  factsById,
  machineKey,
  backend,
  isMacos,
  classVramBwGbps,
  classRamBwGbps,
  probeGbps,
  effDevice,
  effHost,
  effHostProbe = 0.4,
  moeProbeGbps = null,
}) {
  const deviceRaw = (isMacos ? await self.applePoolBwGbps() : await self.nvidiaMemBwGbps()) || classVramBwGbps || null;
  const device =
    deriveDeviceBwGbps(rows, factsById, { machineKey, backend }) || (deviceRaw ? deviceRaw * effDevice : null);
  let host = deriveHostBwGbps(rows, factsById, { machineKey, backend, deviceEffGbps: device });
  if (host === null) {
    if (moeProbeGbps) host = moeProbeGbps;
    else if (probeGbps) host = probeGbps * effHostProbe;
    else if (classRamBwGbps) host = classRamBwGbps * effHost;
  }
  return [device, host];
}
