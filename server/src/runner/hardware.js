// SPDX-License-Identifier: MIT
// Self-contained hardware detection → HardwareInfo (the port of llm_runner/runner/hardware.py).
//
// Drives binary + model selection. No CUDA toolkit is ever required — we only DETECT what
// the user has (platform, GPU vendor, NVIDIA compute capability + driver, AMD/ROCm, Intel,
// Vulkan) and pick the matching prebuilt build. For NVIDIA the `computeCap` chooses the
// CUDA build (Blackwell needs 13.x, older cards 12.x); for AMD we prefer ROCm/HIP when its
// runtime is present, else Vulkan (user decision 2026-07-01); any detected Intel GPU routes
// to the Vulkan build when the loader is present (A2 widened 2026-07-23 — the old Arc-name
// gate left Core Ultra iGPUs CPU-only with a working Vulkan device idle). The only
// prerequisite is the GPU's own driver, which the user already has if the GPU works.
//
// AMD/Intel rows come from a per-platform scan (only run when no NVIDIA GPU was found, so
// the NVIDIA fast-path pays nothing): on Linux the kernel's own sysfs
// (`/sys/class/drm/cardN/device/vendor`, and for amdgpu the byte-exact
// `mem_info_vram_total` — kernel-documented ABI); on Windows the display-class registry
// (`DriverDesc` + `HardwareInformation.qwMemorySize` — the 64-bit value;
// `Win32_VideoController.AdapterRAM` is uint32 and caps at 4 GB, so it is never used).
// Intel-on-Linux VRAM stays null: there is no stable merged sysfs ABI for discrete-Intel
// local memory (`lmem_total_bytes` never left RFC), so the row exists (vendor/name/routing
// work) and Fit honestly reads unknown.
//
// ── Sync / async (the JS port's one structural change) ──────────────────────
// Python ran every probe synchronously. Here every function that starts a program (all
// through platform/procs.js — kit register §5) is ASYNC: detect, usedVramMb,
// usedDeviceMemMb, usedPoolMb, gpuProcesses, otherGpuHolders, processDeviceMemMb,
// processRssMb, processTreePids, processTreeDeviceMemMb, processTreeRssMb and their
// private arms. Pure functions stay sync (maxVramMb, activeBackend, platformKey,
// machineKey, formatClassKey, parseClassKey, memArch, snapRamGb, bandedClassKey, classKey,
// budgetTotalMb, _qwToMb, _treeFromPairs, _amdSysfsUsedVramMb, _rocmAvailable,
// _vulkanAvailable, _ramMb, which).
//
// Python's `@cache`d `current_machine_key()` / `current_class_key()` are called from
// synchronous llm code (install, switch_resolve, reasoning). They stay SYNC here and read
// a memo: `await ensureDetected()` (boot) runs `detect()` once and keeps its HardwareInfo;
// `currentMachineKey()` / `currentClassKey()` / `detected()` read it. Reading a key before
// the memo is filled throws (Python would have detected on the spot; JS can't block).
// `setDetected(hw)` fills or replaces the memo (hosts that detected already, and tests).
// `detect()` itself is NOT memoized — like Python's, every call probes afresh.
//
// psutil: Python uses it when a host ships it (JustVoice's venv does, the kit's doesn't)
// and falls back to OS tools. This port follows the NO-psutil arms throughout (node:os for
// cores / total / free memory, which read the same OS sources as the ctypes / sysconf arms),
// except `_processLabel`, whose only Python source was psutil's cmdline — here
// `processCmdline` reads it from the OS (see there).

import { readdirSync, readFileSync, realpathSync, statSync, accessSync, constants as fsc } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mutex } from "../platform/asyncutil.js";
import { getLogger } from "../platform/log.js";
import { model } from "../platform/models.js";
import * as procs from "../platform/procs.js";
import { pyFloatParse, pyInt, pyMax, pyMin, pyRound, pySorted, splitWs, strip } from "../platform/py.js";
import * as self from "./hardware.js";
import { GpuInfo, HardwareInfo } from "./schema.js";

const log = getLogger("llm_runner.runner.hardware");

const MIB = 1024 * 1024;

// ─── Small Python-semantics helpers (candidates for platform/) ───────────────────

/** str.splitlines(): every Python line boundary, no trailing empty line. Candidate for platform/. */
export function splitlines(s) {
  const parts = String(s ?? "").split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** What `subprocess.run(…, text=True)` hands back: universal newlines (\r\n, \r → \n). */
function textOut(r) {
  const s = r?.stdout;
  if (s == null) return "";
  return (Buffer.isBuffer(s) ? s.toString("utf8") : String(s)).replace(/\r\n?/g, "\n");
}

/** str.isdigit() for the ASCII digits tool output carries. */
const isDigit = (s) => /^[0-9]+$/.test(s);

/**
 * csv.reader (the default excel dialect, strict off) over a text: rows of fields; a blank
 * line is an empty row, as Python yields it. Candidate for platform/.
 */
export function parseCsv(text) {
  const rows = [];
  const s = String(text ?? "");
  let i = 0;
  const n = s.length;
  while (i < n) {
    const row = [];
    let field = "";
    let state = "start"; // start | field | quoted | quoteInQuoted
    let ended = false;
    while (i < n) {
      const c = s[i];
      const nl = c === "\n" || c === "\r";
      if (state === "start" || state === "field") {
        if (nl) {
          if (state === "field" || row.length) row.push(field);
          i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
          ended = true;
          break;
        }
        if (c === ",") {
          row.push(field);
          field = "";
          state = "start";
        } else if (c === '"' && state === "start") {
          state = "quoted";
        } else {
          field += c;
          state = "field";
        }
        i++;
      } else if (state === "quoted") {
        if (c === '"') state = "quoteInQuoted";
        else field += c;
        i++;
      } else {
        // a quote inside a quoted field: "" is a literal quote; a delimiter / newline ends it
        if (c === '"') {
          field += '"';
          state = "quoted";
          i++;
        } else if (c === ",") {
          row.push(field);
          field = "";
          state = "start";
          i++;
        } else if (nl) {
          row.push(field);
          i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
          ended = true;
          break;
        } else {
          field += c;
          state = "field";
          i++;
        }
      }
    }
    if (!ended && (state !== "start" || row.length || field)) row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * shutil.which(cmd): the first PATH hit (on Windows the current directory first, then
 * PATH, trying each PATHEXT extension unless `cmd` already carries one), or null.
 * Candidate for platform/.
 */
export function which(cmd) {
  const win = process.platform === "win32";
  const isExe = (fn) => {
    try {
      const st = statSync(fn);
      if (st.isDirectory()) return false;
      if (!win) accessSync(fn, fsc.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  // os.path.dirname(cmd) non-empty → no PATH search
  if (win ? /[\\/:]/.test(cmd) : cmd.includes("/")) return isExe(cmd) ? cmd : null;
  const envPath = process.env.PATH;
  const dirs = (envPath == null ? (win ? "" : "/bin:/usr/bin") : envPath).split(path.delimiter);
  let files = [cmd];
  if (win) {
    if (!process.env.NoDefaultCurrentDirectoryInExePath) dirs.unshift(".");
    const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC").split(";").filter(Boolean);
    if (!exts.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase()))) files = exts.map((e) => cmd + e);
  }
  const seen = new Set();
  for (const dir of dirs) {
    const norm = win ? dir.toLowerCase() : dir;
    if (seen.has(norm)) continue;
    seen.add(norm);
    for (const f of files) {
      const full = dir ? path.join(dir, f) : f;
      if (isExe(full)) return full;
    }
  }
  return null;
}

/** int(float(s)), or null where Python's `except ValueError` caught it. */
function intOfFloat(s) {
  try {
    return pyInt(pyFloatParse(s));
  } catch {
    return null;
  }
}

/** One program, the probe way: its stdout as text, or an exception the caller catches. */
async function runText(argv, timeout) {
  return textOut(await procs.run(argv, { timeout }));
}

// ─── Reductions over a HardwareInfo ──────────────────────────────────────────

/**
 * The largest single-GPU VRAM (MiB) in `hw`, or 0 if no GPU — the ONE reduction the Fit
 * math (`process.computeFit`) and the VRAM arbiter both use, so "max detected VRAM" has a
 * single source (the arbiter's 'one VRAM authority' principle) with no per-call-site drift.
 */
export function maxVramMb(hw) {
  let best = 0;
  for (const g of hw.gpus || []) best = Math.max(best, g.vramMb || 0);
  return best;
}

/**
 * Which engine backend this box runs — `cuda | rocm | metal | vulkan | cpu` — for the
 * physics overhead seed (`fit.PHYSICS_OVERHEAD_MB`, fit-redesign §5.1). Mirrors the
 * binary-preference order's spirit without importing it: the detected runtime wins; macOS
 * is Metal by construction; any other GPU means the Vulkan build; no GPU at all runs on
 * CPU (overhead 0 — no device context).
 */
export function activeBackend(hw) {
  const rt = hw.runtimes || {};
  if (rt.cuda) return "cuda";
  if (hw.platform === "macos") return "metal";
  if (rt.rocm) return "rocm";
  if ((hw.gpus || []).length || rt.vulkan) return "vulkan";
  return "cpu";
}

/** platform.system(): "Windows" | "Darwin" | "Linux" (… os.type() elsewhere). */
export function systemName() {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "Darwin";
  if (process.platform === "linux") return "Linux";
  return os.type();
}

export function platformKey() {
  const sysname = systemName().toLowerCase();
  if (sysname.startsWith("win")) return "windows";
  if (sysname === "darwin") return "macos";
  return "linux";
}

/**
 * The per-MACHINE tuning key the `model_tunes` layer is stored under —
 * `gpu|vram|cores|ramGB` (or `cpu|cores|ramGB` with no GPU). WHOLE machine, not GPU-only
 * (Plan B, D2): `threads` is CPU-core-driven and `batch`/`ubatch` are RAM/bandwidth-bound,
 * so two boxes sharing a GPU model must not collide. RAM rounds down to whole GB (absorbs
 * MB-level reporting jitter); the driver version is deliberately EXCLUDED — a driver
 * update would orphan every saved tune. ONE source, beside `maxVramMb`.
 */
export function machineKey(hw) {
  const ramGb = Math.floor((hw.ramMb || 0) / 1024);
  const gpus = hw.gpus || [];
  const gpu = gpus.length ? pyMax(gpus, (g) => g.vramMb || 0) : null;
  if (gpu === null) return `cpu|${hw.cpuCores}c|${ramGb}g`;
  return `${gpu.name}|${gpu.vramMb || 0}|${hw.cpuCores}c|${ramGb}g`;
}

// The hardware memory-architecture classes (2026-07-22 redesign, user). The offload
// story — what makes the launch config differ — splits three ways:
//   discrete   — dedicated VRAM + system RAM; tune the GPU/CPU layer split.
//   integrated — an iGPU sharing ONE system-RAM pool; nothing to offload to.
//   unified    — an SoC ONE high-bandwidth pool (Apple Silicon / DGX Spark).
export const MEM_TYPES = ["discrete", "integrated", "unified"];

/**
 * The class_key string convention — ONE source, type-first (2026-07-22):
 * `dgpu-vram<V>|ram<R>` (discrete) · `unified-mem<M>` · `igpu-mem<M>` (integrated / the
 * GPU-less fallback). For the one-pool types `ramGb` IS the pool. BOTH detection
 * (`classKey(hw)`) and the llm-side hardware-class store derive through this, so the
 * format can never drift.
 */
export function formatClassKey(memType, vramGb, ramGb) {
  if (memType === "discrete") return `dgpu-vram${vramGb}|ram${ramGb}`;
  if (memType === "unified") return `unified-mem${ramGb}`;
  return `igpu-mem${ramGb}`;
}

/**
 * Inverse of `formatClassKey` → [memType, vramGb, ramGb]. For the one-pool types vramGb is
 * 0 and ramGb is the pool; an unrecognized shape → ["integrated", 0, 0]. Used by the
 * hardware-class store's `ensure` (the Tune-modal 'Save for hardware class' path knows
 * only the class_key).
 */
export function parseClassKey(key) {
  const k = key || "";
  let m = /^dgpu-vram(\d+)\|ram(\d+)$/.exec(k);
  if (m) return ["discrete", Number(m[1]), Number(m[2])];
  m = /^unified-mem(\d+)$/.exec(k);
  if (m) return ["unified", 0, Number(m[1])];
  m = /^igpu-mem(\d+)$/.exec(k);
  if (m) return ["integrated", 0, Number(m[1])];
  return ["integrated", 0, 0];
}

/**
 * Is this scanned AMD/Intel GPU a DISCRETE card, not an iGPU? The PHYSICAL signal only —
 * dedicated VRAM >= 4 GB reported (a discrete card reports its full board memory; an iGPU
 * reports little or NOTHING — the Core Ultra 7 laptop's registry had no
 * `qwMemorySize` for its "Intel(R) Graphics", detect-facts 2026-07-23). NO name matching:
 * Intel reuses "Arc" for integrated graphics, so a name is marketing, not architecture.
 * Discrete Arc cards (A770, B580) still classify correctly via their real board VRAM. The
 * 'Use for this PC' override corrects any residual miss.
 */
function isDiscreteGpu(g) {
  return (g.vramMb || 0) >= 4096;
}

/**
 * This box's memory architecture — `discrete` | `integrated` | `unified`. Platform +
 * vendor, NO heavy deps (2026-07-22; no single CUDA attribute cleanly flags unified, so a
 * unified-NVIDIA superchip (DGX Spark) falls to discrete and is corrected by the override):
 *     macOS                    → unified   (Apple Silicon; fixes the Mac-as-CPU bug)
 *     NVIDIA (cuda runtime)    → discrete
 *     a >=4 GB-dedicated GPU   → discrete  (the physical signal — no name matching)
 *     any other GPU / no GPU   → integrated (iGPU or the GPU-less one-pool fallback)
 */
export function memArch(hw) {
  if (hw.platform === "macos") return "unified";
  if ((hw.runtimes || {}).cuda) return "discrete";
  if ((hw.gpus || []).some(isDiscreteGpu)) return "discrete";
  return "integrated";
}

// The standard RAM capacities machines actually ship with. Detection SNAPS system RAM to
// the nearest rung (2026-07-23, user's rec): OEMs reserve different slivers (firmware/iGPU
// carve), so raw rounding fragmented identical nominal hardware — the Core Ultra laptop
// reported 31.5 GB (→31) while the desktop's 31.9 GB →32. (This fine ladder is the
// FIRST-stage RAM snap. The discrete CLASS key then down-snaps to the coarse
// _DGPU_RAM_RUNGS, and VRAM — jitter-rounded to the nearest GB — down-snaps the
// _VRAM_BANDS ladder: the 2026-07-25 band ruling, see classKey below.)
export const _RAM_LADDER = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];

/**
 * System RAM (MiB) → the nearest standard capacity in GB (ties take the lower rung — never
 * overstate a box's memory). Above the ladder → plain rounding.
 */
export function snapRamGb(ramMb) {
  const gb = (ramMb || 0) / 1024;
  if (gb > _RAM_LADDER[_RAM_LADDER.length - 1]) return pyRound(gb);
  return pyMin(_RAM_LADDER, (v) => [Math.abs(v - gb), v]);
}

// The discrete BANDS (2026-07-25, the user's ruling — "I never thought exact matches should
// be used"): the class key IS the band, so plain exact-match lookup covers every real card
// without any fallback machinery. VRAM snaps DOWN this ladder after the nearest-GB jitter
// round (10/11 GB cards → the 8 band; 20 → 16; everything ≥ 24 IS the 24+ band). Discrete
// system RAM snaps DOWN the coarse rungs after snapRamGb's fine jitter snap (24 → 16,
// 48 → 32, 96 → 64): down-snap on both dimensions because it can never overstate a box — a
// config keyed at the band floor fits every box above it, never the reverse. Below the
// ladder floor the (jitter-snapped) value passes through unchanged — those boxes are
// honestly sub-band and match no band seed. Integrated/unified keys are untouched: the pool
// is the identity. Per-machine measurement fidelity lives in the machineKey → model_tunes
// layer; this key's own charter says COARSE. (ui/src/classTunes.js copies the two ladders —
// tests/class_label_ladders.test.js pins them.)
export const _VRAM_BANDS = [4, 6, 8, 12, 16, 24];
export const _DGPU_RAM_RUNGS = [16, 32, 64, 128];

/** Largest ladder value ≤ `gb`; below the floor the value passes through. */
function band(gb, ladder) {
  const fits = ladder.filter((v) => v <= gb);
  return fits.length ? Math.max(...fits) : gb;
}

/**
 * `formatClassKey` with the discrete BAND snap applied — THE key builder for anything that
 * creates or matches a class identity (detection below, and the panel's create-class derive
 * via install), so a hand-typed vram 10 lands in the 8 band instead of minting an
 * unmatchable micro-class. One-pool types pass straight through to the raw formatter.
 */
export function bandedClassKey(memType, vramGb, ramGb) {
  if (memType === "discrete") {
    return formatClassKey("discrete", band(pyInt(vramGb || 0), _VRAM_BANDS), band(pyInt(ramGb || 0), _DGPU_RAM_RUNGS));
  }
  return formatClassKey(memType, 0, ramGb);
}

/**
 * The COARSE hardware-CLASS key the seeded/editable class library is matched on —
 * memory-architecture-first (2026-07-22), BAND-grained on the discrete side (2026-07-25).
 * Discrete keys on VRAM band + RAM rung (the offload split); integrated/unified key on the
 * single memory pool. VRAM first rounds to the NEAREST GB (absorbs the just-under a card
 * reports, e.g. 8188 MB → 8 GB) and then down-snaps the band ladder; system RAM snaps the
 * fine standard-capacity ladder (snapRamGb) and then down-snaps the coarse rungs. GPU NAME
 * + CPU CORES are EXCLUDED (placement is memory-fit-bound, not compute-bound).
 */
export function classKey(hw) {
  const arch = memArch(hw);
  const ramGb = snapRamGb(hw.ramMb || 0);
  if (arch === "discrete") {
    const gpus = hw.gpus || [];
    const gpu = gpus.length ? pyMax(gpus, (g) => g.vramMb || 0) : null;
    const vramGb = gpu ? pyRound((gpu.vramMb || 0) / 1024) : 0;
    return bandedClassKey("discrete", vramGb, ramGb);
  }
  return formatClassKey(arch, 0, ramGb); // integrated / unified — one pool
}

// ─── The detection memo (Python's @cache on the two current_* keys) ──────────

/** The memoized HardwareInfo — filled by `ensureDetected()` / `setDetected()`. */
export const memo = { hw: null };
let detecting = null;

/** Run `detect()` once and keep its answer (boot); later calls return the memo. */
export async function ensureDetected() {
  if (memo.hw) return memo.hw;
  detecting ??= Promise.resolve()
    .then(() => self.detect())
    .then((hw) => {
      memo.hw ??= hw;
      return memo.hw;
    })
    .finally(() => {
      detecting = null;
    });
  return detecting;
}

/** Fill / replace the memo with a HardwareInfo a host already has (or a test's). */
export function setDetected(hw) {
  memo.hw = hw;
}

/** The memoized HardwareInfo, or null before `ensureDetected()` ran. */
export function detected() {
  return memo.hw;
}

function memoOrThrow() {
  if (!memo.hw) {
    throw new Error("hardware not detected yet — await hardware.ensureDetected() at boot before reading a key");
  }
  return memo.hw;
}

/** `classKey(detect())`, memoized (hardware is fixed within a process). SYNC — reads the memo. */
export function currentClassKey() {
  return classKey(memoOrThrow());
}

/**
 * `machineKey(detect())`, memoized — hardware doesn't change within a process, so the
 * per-load switches wire and the model-tunes API never pay a second `nvidia-smi`
 * round-trip. SYNC — reads the memo.
 */
export function currentMachineKey() {
  return machineKey(memoOrThrow());
}

// ─── Used device memory ──────────────────────────────────────────────────────

/**
 * Total CURRENTLY-used VRAM across NVIDIA GPUs (MiB), or null when it cannot be measured
 * (no nvidia-smi; a probe failure). The NVIDIA arm of the Phase-4 probe family —
 * `usedDeviceMemMb` below is the backend-aware door.
 *
 * WHY this exists (measure-don't-assume, box-verified 2026-07-06): the lifecycle trues-up
 * an arbiter reservation with the load's REAL footprint right after the load confirms. The
 * fit formula books an `n-gpu-layers = 0` child as 0 MB, but a CUDA-build llama-server
 * child still initializes a CUDA context and holds ~0.5 GB (measured 549 MB for the
 * Qwen3-Embedding-0.6B child on an RTX 2070 SUPER). The measured number comes from the
 * machine, not from a constant.
 */
export async function usedVramMb() {
  const out = await self._nvidiaQuery("memory.used");
  if (out == null) return null;
  let total = 0;
  let seen = false;
  for (const line of splitlines(out)) {
    const tok = line.trim().split(",")[0].trim();
    if (isDigit(tok)) {
      total += Number(tok);
      seen = true;
    }
  }
  return seen ? total : null;
}

// ── Phase 4 (fit-redesign §11): per-backend used-memory probes, best-effort ──
// Every arm returns null when it cannot measure, and null degrades to exactly the
// pre-Phase-4 behavior (the true-up keeps the estimate) — an unverified probe can never
// make a box WORSE, only fail to improve it. Each parse targets a DOCUMENTED interface (a
// kernel ABI file, a vendor CLI, an OS counter) and is pinned by fixture tests.

/**
 * AMD via `rocm-smi --showmeminfo vram --csv` — used-bytes column summed across devices.
 * The column header varies by ROCm release ("VRAM Total Used Memory (B)" and
 * near-variants), so the parse finds the header containing both "vram" and "used" instead
 * of pinning one wording.
 */
export async function _rocmUsedVramMb() {
  if (!self.which("rocm-smi")) return null;
  let out;
  try {
    out = await runText(["rocm-smi", "--showmeminfo", "vram", "--csv"], 8);
  } catch (e) {
    log.debug(`rocm-smi probe failed: ${e?.message ?? e}`);
    return null;
  }
  const lines = splitlines(out).filter((ln) => ln.trim());
  const header = lines.find((ln) => ln.toLowerCase().includes("used")) ?? "";
  if (!header) return null;
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  const idx = cols.findIndex((c) => c.includes("vram") && c.includes("used"));
  if (idx < 0) return null;
  let total = 0;
  let seen = false;
  for (const ln of lines.slice(lines.indexOf(header) + 1)) {
    const parts = ln.split(",").map((p) => p.trim());
    if (parts.length <= idx) continue;
    const v = intOfFloat(parts[idx]);
    if (v === null) continue;
    total += v;
    seen = true;
  }
  return seen ? Math.floor(total / MIB) : null;
}

/** The `cardN` entries of a /sys/class/drm-shaped folder, sorted; null when unreadable. */
function drmCards(root) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  return pySorted(names.filter((n) => /^card\p{Nd}+$/u.test(n))).map((n) => path.join(root, n));
}

/**
 * AMD on Linux via the kernel's own `mem_info_vram_used` (bytes) — the documented amdgpu
 * sysfs ABI, sibling of the `mem_info_vram_total` the GPU scan already reads. Summed across
 * cards; null when no card exposes it. (Sync: a few tiny sysfs reads, no program.)
 */
export function _amdSysfsUsedVramMb(root = "/sys/class/drm") {
  const cards = drmCards(root);
  if (cards === null) return null;
  let total = 0;
  let seen = false;
  for (const card of cards) {
    try {
      total += pyInt(readFileSync(path.join(card, "device", "mem_info_vram_used"), "utf8").trim());
      seen = true;
    } catch {}
  }
  return seen ? Math.floor(total / MIB) : null;
}

/** typeperf's one sample row, summed: every numeric field after the timestamp (bytes → MiB). */
function sumTypeperfSample(out) {
  const rows = splitlines(out).filter((ln) => ln.trim().startsWith('"'));
  if (rows.length < 2) return null;
  let total = 0.0;
  let seen = false;
  for (const cell of rows[rows.length - 1].split('","').slice(1)) {
    try {
      total += pyFloatParse(strip(strip(cell), '"'));
      seen = true;
    } catch {}
  }
  return seen ? pyInt(Math.floor(total / MIB)) : null;
}

/**
 * Windows non-NVIDIA dGPUs via the OS's own GPU performance counters:
 * `typeperf "\GPU Adapter Memory(*)\Dedicated Usage" -sc 1` — one sample, bytes per
 * adapter instance, summed. typeperf ships with Windows; the counter set exists on any
 * WDDM 2.x driver. ~1 s — only reached when nvidia-smi is absent, and only at load true-up
 * time, never on a poll.
 */
export async function _windowsGpuDedicatedUsedMb() {
  if (self.platformKey() !== "windows" || !self.which("typeperf")) return null;
  let out;
  try {
    out = await runText(["typeperf", "\\GPU Adapter Memory(*)\\Dedicated Usage", "-sc", "1"], 10);
  } catch (e) {
    log.debug(`typeperf GPU probe failed: ${e?.message ?? e}`);
    return null;
  }
  // Output: a quoted-CSV header row naming each instance, then one sample row of values;
  // sum every numeric field of the sample row (field 0 is the timestamp). No sample row /
  // no numbers → null.
  return sumTypeperfSample(out);
}

/**
 * Used SYSTEM memory (MiB) — the probe for one-pool boxes (iGPU / Apple / CPU-only), where
 * the pool IS what models load into and a before/after delta across a load captures the
 * footprint ONCE (mmap'd weights and the "GPU" allocation are the same physical bytes on
 * UMA — §5.2). Arms: Windows total − available (node:os reads GlobalMemoryStatusEx, the
 * Python ctypes arm) → Linux /proc/meminfo (MemTotal − MemAvailable) → macOS vm_stat
 * (active + wired + compressor pages × page size — the standard delta-stable accounting).
 */
export async function _usedPoolMb() {
  const plat = self.platformKey();
  if (plat === "windows") {
    try {
      return Math.floor((os.totalmem() - os.freemem()) / MIB);
    } catch {
      return null;
    }
  }
  if (plat === "linux") {
    try {
      const fields = {};
      for (const ln of splitlines(readFileSync("/proc/meminfo", "utf8"))) {
        const parts = splitWs(ln);
        const key = parts.length >= 2 ? parts[0].replace(/:+$/, "") : "";
        if (key === "MemTotal" || key === "MemAvailable") fields[key] = pyInt(parts[1]); // kB
      }
      if ("MemTotal" in fields && "MemAvailable" in fields) {
        return Math.floor((fields.MemTotal - fields.MemAvailable) / 1024);
      }
    } catch {}
    return null;
  }
  // macOS: vm_stat prints a page size line + "Pages active/wired down/occupied by
  // compressor" counts; their sum × page size is the used-memory figure whose LOAD DELTA
  // is stable (free-page accounting alone is not).
  try {
    const out = await runText(["vm_stat"], 5);
    const m = /page size of (\d+) bytes/.exec(out);
    const page = m ? Number(m[1]) : 4096;
    let usedPages = 0;
    for (const name of ["Pages active", "Pages wired down", "Pages occupied by compressor"]) {
      const pm = new RegExp(`${name}:\\s+(\\d+)`).exec(out);
      if (pm) usedPages += Number(pm[1]);
    }
    return usedPages ? Math.floor((usedPages * page) / MIB) : null;
  } catch (e) {
    log.debug(`vm_stat probe failed: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Used memory (MiB) of the pool models load into on THIS box — the Phase-4 backend-aware
 * door the load true-up consumes (`lifecycle._probeUsedVram`). Discrete: NVIDIA → ROCm CLI
 * → amdgpu sysfs → Windows GPU counters (first non-null wins; on an NVIDIA box the later
 * arms are never reached). One-pool (integrated/unified — iGPU, Apple, CPU-only): the used
 * SYSTEM pool, so the before/after delta counts a model's bytes ONCE. null = unmeasurable —
 * the true-up keeps the estimate.
 */
export async function usedDeviceMemMb() {
  const hw = await self.detect();
  if (memArch(hw) !== "discrete") return self._usedPoolMb();
  for (const probe of [self.usedVramMb, self._rocmUsedVramMb, self._amdSysfsUsedVramMb, self._windowsGpuDedicatedUsedMb]) {
    const v = await probe();
    if (v != null) return v;
  }
  return null;
}

// THE cached used-memory door (2026-08-14). `usedDeviceMemMb` shells out to
// nvidia-smi/typeperf, so nothing that polls may call it raw — but a LOAD must see a fresh
// number (admitting against a 2-second-old reading admits into memory that is already
// gone). One TTL cache, two speeds, in ONE place: two caches over one probe could disagree
// at the same instant — the two-truths defect the strip redesign exists to kill.
export const _USED_TTL_S = 2.0;
export const _GPU_PROCS_TTL_S = 2.0;
/** The two TTL caches as [monotonic seconds, value] (tests reset them: `cache.gpuProcs = null`). */
export const cache = { used: null, gpuProcs: null };
const usedLock = new Mutex();
const gpuProcsLock = new Mutex();
const monotonic = () => performance.now() / 1000;

/**
 * `usedDeviceMemMb`, TTL-cached. `fresh: true` bypasses the cache (the load door); the
 * default serves display polls. null = unmeasurable, and every caller must degrade to
 * ledger-only behaviour rather than guess.
 */
export async function usedPoolMb({ fresh = false } = {}) {
  const now = monotonic();
  if (!fresh) {
    const hit = cache.used;
    if (hit != null && now - hit[0] < _USED_TTL_S) return hit[1];
  }
  return usedLock.run(async () => {
    const val = await self.usedDeviceMemMb();
    cache.used = [monotonic(), val];
    return val;
  });
}

/**
 * The last cached `usedPoolMb` reading whatever its age, or undefined — for a SYNC caller
 * that may not await (JS-only; Python's sync callers could probe inline).
 */
export function peekUsedPoolMb() {
  return cache.used ? cache.used[1] : undefined;
}

/**
 * The memory-budget DENOMINATOR for this box (fit-redesign §5.2, Phase 4): discrete → the
 * largest single card's VRAM (the standing multi-GPU rule); one-pool (integrated / unified
 * / CPU-only) → the pool itself (`ramMb`). THE one reduction the arbiter's ledger and the
 * true-up cap both use — before this, a Mac/iGPU box had total 0, so remaining was always
 * 0, every admission tried to evict, and the budget line was fiction.
 */
export function budgetTotalMb(hw) {
  if (memArch(hw) === "discrete") return maxVramMb(hw);
  return pyInt(hw.ramMb || 0);
}

// ── Per-PROCESS memory probes (2026-08-13, the speech measured true-up) ──────
// The device-wide before/after delta is only attributable when loads serialize (the
// runner's own loads do) — an engine subprocess loading concurrently with a runner load
// would cross-charge. These probe ONE pid instead, so attribution is exact by
// construction. Same contract as the Phase-4 family: never throw, null = unmeasurable (the
// caller degrades to the serialized-delta arm, honestly labeled "computed").

/**
 * Per-process GPU memory via `nvidia-smi --query-compute-apps` (MiB, summed across GPUs
 * and across every pid in the set — ONE query lists all compute processes, so a whole
 * process tree costs the same shell-out as one pid). Works on Linux and Windows-TCC; under
 * Windows WDDM the column prints "[N/A]" or "Insufficient Permissions" — non-numeric parses
 * fall through to null and the Windows counter arm takes over.
 */
export async function _nvidiaProcsMemMb(pids) {
  if (!self.which("nvidia-smi")) return null;
  let out;
  try {
    out = await runText(["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"], 8);
  } catch (e) {
    log.debug(`nvidia-smi compute-apps probe failed: ${e?.message ?? e}`);
    return null;
  }
  const want = new Set([...pids].map((p) => String(p)));
  let total = 0;
  let seen = false;
  for (const ln of splitlines(out)) {
    const parts = ln.split(",").map((p) => p.trim());
    if (parts.length >= 2 && want.has(parts[0]) && isDigit(parts[1])) {
      total += Number(parts[1]);
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * One-pid door over `_nvidiaProcsMemMb` (kept for callers that really mean one process —
 * measuring a SPAWNED child should use the tree doors below, because venv launchers can
 * be trampolines).
 */
export async function _nvidiaProcessMemMb(pid) {
  return self._nvidiaProcsMemMb(new Set([pid]));
}

/**
 * Per-PID dedicated GPU memory on Windows via the OS's own `GPU Process Memory` counter
 * set — the per-PID sibling of the `GPU Adapter Memory` counter, and what Task Manager's
 * per-process GPU column shows. Instance names embed the pid (`pid_1234_luid_..._phys_0`),
 * so the wildcard selects one process; values are bytes, summed across instances. This is
 * the arm that works under WDDM, where nvidia-smi reports per-process memory as N/A.
 * Localized Windows localizes counter NAMES — typeperf then errors, no sample row parses,
 * and the honest answer is null.
 */
export async function _windowsGpuProcessDedicatedMb(pid) {
  if (self.platformKey() !== "windows" || !self.which("typeperf")) return null;
  let out;
  try {
    out = await runText(["typeperf", `\\GPU Process Memory(pid_${pid}*)\\Dedicated Usage`, "-sc", "1"], 10);
  } catch (e) {
    log.debug(`typeperf GPU process probe failed: ${e?.message ?? e}`);
    return null;
  }
  return sumTypeperfSample(out);
}

/**
 * Dedicated DEVICE memory (MiB) held by ONE process, or null when it cannot be measured.
 * nvidia-smi's per-process query first (Linux, Windows-TCC), then the Windows per-PID GPU
 * Process Memory counters (the WDDM path). No AMD per-process arm exists — vendor tooling
 * exposes only device-wide use — so AMD boxes answer null and the caller falls back to its
 * delta arm.
 */
export async function processDeviceMemMb(pid) {
  for (const probe of [self._nvidiaProcessMemMb, self._windowsGpuProcessDedicatedMb]) {
    const v = await probe(pid);
    if (v != null) return v;
  }
  return null;
}

/**
 * Resident set size (MiB) of ONE process — the one-pool-box arm of the per-process family:
 * on UMA the pool a model loads into IS system memory, so a process's resident bytes are
 * its pool take. Arms (Python's no-psutil ones): Windows `tasklist` CSV → Linux
 * `/proc/<pid>/status` VmRSS → `ps -o rss=` elsewhere.
 */
export async function processRssMb(pid) {
  const plat = self.platformKey();
  if (plat === "windows") {
    try {
      const out = await runText(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], 8);
      for (const ln of splitlines(out)) {
        if (!ln.trim().startsWith('"')) continue;
        const cells = ln.split('","').map((c) => strip(strip(c), '"'));
        if (cells.length >= 5 && cells[1] === String(pid)) {
          const digits = cells[4].replace(/[^0-9]/g, ""); // "123,456 K", localized separators
          if (digits) return Math.floor(Number(digits) / 1024);
        }
      }
    } catch (e) {
      log.debug(`tasklist RSS probe failed: ${e?.message ?? e}`);
    }
    return null;
  }
  if (plat === "linux") {
    try {
      for (const ln of splitlines(readFileSync(`/proc/${pid}/status`, "utf8"))) {
        if (ln.startsWith("VmRSS:")) return Math.floor(pyInt(splitWs(ln)[1]) / 1024); // kB
      }
    } catch {}
    return null;
  }
  try {
    const tok = (await runText(["ps", "-o", "rss=", "-p", String(pid)], 5)).trim();
    return isDigit(tok) ? Math.floor(Number(tok) / 1024) : null; // kB
  } catch {
    return null;
  }
}

// ── Process-TREE probes (2026-08-14, the launcher-shim fix) ──────────────────
// A spawned pid is not necessarily the process that holds the memory: a Windows uv-venv
// `Scripts\python.exe` is a ~4 MB TRAMPOLINE whose CHILD is the real interpreter (proven
// live: a 1 GiB CUDA child read device=None / RSS=4 MB at the Popen pid, device=1131 MB /
// RSS=509 MB at its child). Measuring a spawned process therefore means measuring its whole
// descendant tree, summed. POSIX venvs symlink their python, so the tree is usually [pid].

/**
 * [pid, ppid] for every live process — one pid/ppid table. Windows: `wmic` (present
 * through Win10, deprecated on 11) → PowerShell CIM. POSIX: one `ps -e`. null ⇒ no table.
 */
export async function _pidPpidPairs() {
  const run = async (cmd, timeout) => {
    try {
      return await runText(cmd, timeout);
    } catch (e) {
      log.debug(`pid-table probe ${cmd[0]} failed: ${e?.message ?? e}`);
      return "";
    }
  };
  const parse = (out, flip) => {
    const pairs = [];
    for (const ln of splitlines(out)) {
      const toks = splitWs(ln);
      if (toks.length === 2 && isDigit(toks[0]) && isDigit(toks[1])) {
        const a = Number(toks[0]);
        const b = Number(toks[1]);
        pairs.push(flip ? [b, a] : [a, b]);
      }
    }
    return pairs;
  };
  if (self.platformKey() === "windows") {
    // wmic prints requested columns ALPHABETICALLY: ParentProcessId first.
    if (self.which("wmic")) {
      const pairs = parse(await run(["wmic", "process", "get", "ProcessId,ParentProcessId"], 10), true);
      if (pairs.length) return pairs;
    }
    if (self.which("powershell")) {
      const psCmd = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
      const pairs = parse(await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd], 15), false);
      return pairs.length ? pairs : null;
    }
    return null;
  }
  const pairs = parse(await run(["ps", "-e", "-o", "pid=,ppid="], 8), false);
  return pairs.length ? pairs : null;
}

/**
 * Walk a [pid, ppid] table into [pid, ...descendants], root first. A seen-set guards the
 * walk — Windows pid reuse can fabricate parent cycles.
 */
export function _treeFromPairs(pid, pairs) {
  const kids = new Map();
  for (const [cpid, ppid] of pairs) {
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(cpid);
  }
  const out = [];
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    stack.push(...(kids.get(cur) ?? []));
  }
  return out;
}

/** The pid plus every live descendant, root first. Never throws; unknowable ⇒ [pid]. */
export async function processTreePids(pid) {
  const pairs = await self._pidPpidPairs();
  if (!pairs || !pairs.length) return [pid];
  return _treeFromPairs(pid, pairs);
}

/**
 * Dedicated device memory (MiB) held by a process TREE — THE door for measuring a spawned
 * child: the launcher-shim fact above makes single-pid probes read the wrong process on
 * Windows venvs. One nvidia-smi query covers the whole set; the WDDM counter arm runs per
 * pid (each typeperf instance wildcard is pid-prefixed). null = no per-pid arm worked — the
 * caller falls back to its device-delta arm.
 */
export async function processTreeDeviceMemMb(pid) {
  const pids = await self.processTreePids(pid);
  const v = await self._nvidiaProcsMemMb(new Set(pids));
  if (v != null) return v;
  let total = 0;
  let seen = false;
  for (const p of pids) {
    const w = await self._windowsGpuProcessDedicatedMb(p);
    if (w != null) {
      total += w;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * Resident set (MiB) summed over a process TREE — the one-pool sibling of
 * `processTreeDeviceMemMb` (a shim's 4 MB rides along with its child's real footprint;
 * both belong to the spawned engine).
 */
export async function processTreeRssMb(pid) {
  let total = 0;
  let seen = false;
  for (const p of await self.processTreePids(pid)) {
    const v = await self.processRssMb(p);
    if (v != null) {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

// ── Who is holding the GPU (the "Other apps" breakdown, 2026-08-15) ─────────
// The memory strip shows measured occupancy and, next to it, the slice our ledger cannot
// attribute — "Other apps". This answers "which ones?". ONE shell-out for the WHOLE
// machine, not one per process (both arms enumerate every GPU process in a single call).
// Still ~1 s on the Windows counter arm, so it is deliberately NOT wired into any poll —
// the endpoint over it is fetched when a user opens the list.

/** typeperf instance names embed the pid: `pid_1234_luid_0x0..._phys_0`. */
const PID_INSTANCE_RE = /pid_(\d+)_/i;

/**
 * pid → executable name (a Map) for every live process, from ONE table shell-out.
 * Unknowable ⇒ an empty Map and the caller shows the bare pid.
 */
export async function _pidNameMap() {
  const run = async (cmd, timeout) => {
    try {
      return await runText(cmd, timeout);
    } catch (e) {
      log.debug(`pid-name probe ${cmd[0]} failed: ${e?.message ?? e}`);
      return "";
    }
  };
  const names = new Map();
  if (self.platformKey() === "windows") {
    // CSV, no header: "image","pid","session","#","mem"
    for (const row of parseCsv(await run(["tasklist", "/FO", "CSV", "/NH"], 15))) {
      if (row.length >= 2 && isDigit(row[1].trim())) names.set(Number(row[1].trim()), row[0].trim());
    }
    return names;
  }
  for (const ln of splitlines(await run(["ps", "-e", "-o", "pid=,comm="], 8))) {
    const m = /^(\S+)\s+(\S[\s\S]*)$/.exec(ln.replace(/^\s+/, "")); // ln.split(None, 1)
    if (m && isDigit(m[1])) names.set(Number(m[1]), m[2].trim());
  }
  return names;
}

/**
 * pid → MiB (a Map) for every CUDA compute process, from ONE nvidia-smi call. null when
 * nvidia-smi is absent or reports no numeric memory — exactly what Windows-WDDM does
 * ("[N/A]"), handing over to the counter arm.
 *
 * Compute contexts only: a browser or a game rendering through D3D/OpenGL holds GPU memory
 * and does NOT appear here — the honest limit of this arm, and the reason the Windows arm
 * is preferred where it works.
 */
export async function _nvidiaGpuProcessRows() {
  if (!self.which("nvidia-smi")) return null;
  let out;
  try {
    out = await runText(["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"], 8);
  } catch (e) {
    log.debug(`nvidia-smi compute-apps listing failed: ${e?.message ?? e}`);
    return null;
  }
  const rows = new Map();
  for (const ln of splitlines(out)) {
    const parts = ln.split(",").map((p) => p.trim());
    if (parts.length >= 2 && isDigit(parts[0]) && isDigit(parts[1])) {
      const pid = Number(parts[0]);
      rows.set(pid, (rows.get(pid) ?? 0) + Number(parts[1]));
    }
  }
  return rows.size ? rows : null;
}

/**
 * `Local Usage`, NOT `Dedicated Usage`, and the difference is the whole credibility of this
 * list. MEASURED on an RTX 2070 SUPER, 2026-08-15, with a deliberate 2.0 GB torch
 * allocation held in a known pid:
 *
 *                      that pid    all processes   card actually held
 *   Dedicated Usage     2139 MB        9325 MB          2851 MB
 *   Local Usage         2139 MB        2567 MB          2851 MB
 *   Total Committed     2215 MB        3447 MB          2851 MB
 *
 * Both name the real consumer correctly. But `Dedicated Usage` charges a SHARED surface to
 * every process that references it, so the desktop compositor is credited with every window
 * on screen — `dwm.exe` alone read 6,671 MB — and the column sums to more than three times
 * the card. `Local Usage` counts only memory local to the adapter, lands under the device
 * total, and leaves exactly the unattributed driver/desktop remainder you would expect. A
 * list that sums past the hardware is not believable, however correct each row is.
 */
export const _GPU_PROC_COUNTER = "\\GPU Process Memory(*)\\Local Usage";

/**
 * pid → MiB (a Map) from the OS's own `GPU Process Memory` counter set, wildcarded across
 * every instance. ONE call returns every process on every adapter. A pid appears once per
 * adapter (the instance name carries a distinct luid); the values are summed per pid.
 *
 * Localized Windows localizes counter NAMES: typeperf then errors, nothing parses, and the
 * honest answer is null (never an empty map, which would read as "nothing is using the GPU").
 */
export async function _windowsGpuProcessRows() {
  if (self.platformKey() !== "windows" || !self.which("typeperf")) return null;
  let out;
  try {
    out = await runText(["typeperf", _GPU_PROC_COUNTER, "-sc", "1"], 20);
  } catch (e) {
    log.debug(`typeperf GPU process listing failed: ${e?.message ?? e}`);
    return null;
  }
  // typeperf trails the CSV with plain status lines ("Exiting, please wait…"), so rows are
  // matched on WIDTH against the header rather than by position.
  const parsed = parseCsv(out).filter((r) => r.length);
  if (parsed.length < 2) return null;
  const header = parsed[0];
  let data = null;
  for (let i = parsed.length - 1; i >= 1; i--) {
    if (parsed[i].length === header.length) {
      data = parsed[i];
      break;
    }
  }
  if (data === null || header.length < 2) return null;
  const rows = new Map();
  for (let col = 1; col < header.length; col++) {
    const m = PID_INSTANCE_RE.exec(header[col]);
    if (!m) continue;
    let by;
    try {
      by = pyFloatParse(data[col]);
    } catch {
      continue;
    }
    const pid = Number(m[1]);
    rows.set(pid, (rows.get(pid) ?? 0) + pyInt(Math.floor(by / MIB)));
  }
  return rows.size ? rows : null;
}

/**
 * Every process currently holding GPU memory, biggest first.
 *
 * Returns `{source, additive, processes: [...]}` where each row is
 * `{pid, name, memMb, own}`. `own` marks this server's own process tree, so a reader can
 * tell our engines and model runners apart from everything else on the box.
 *
 * `additive` says whether the rows may be compared to the device total. Both arms set it
 * true, but only because the Windows arm reads `Local Usage` (see `_GPU_PROC_COUNTER`).
 * Even then the rows sum to slightly LESS than the device holds: driver and desktop
 * overhead is not charged to any process. So a UI may rank them and may say "of the N GB
 * in use, this process holds M" — it must not present them as a partition.
 *
 * The arms differ in COVERAGE: nvidia-smi sees CUDA compute contexts only (and reports
 * "[N/A]" under Windows-WDDM), the Windows counters see anything touching the adapter.
 *
 * null = UNMEASURABLE, and callers must say so rather than render an empty list: an AMD box
 * has no per-process arm at all, and localized Windows breaks the counter names. An empty
 * list is a different claim — "measured, nothing is holding memory".
 *
 * TTL-cached like `usedPoolMb`, so a double-click or two open panels cannot spawn two probes.
 */
export async function gpuProcesses({ fresh = false } = {}) {
  const now = monotonic();
  if (!fresh) {
    const hit = cache.gpuProcs;
    if (hit != null && now - hit[0] < _GPU_PROCS_TTL_S) return hit[1];
  }
  return gpuProcsLock.run(async () => {
    let rows = null;
    let source = "";
    let additive = true;
    for (const [probe, label, add] of [
      [self._nvidiaGpuProcessRows, "nvidia-smi", true],
      [self._windowsGpuProcessRows, "windows-counters", true],
    ]) {
      rows = await probe();
      if (rows != null) {
        source = label;
        additive = add;
        break;
      }
    }
    if (rows == null) {
      cache.gpuProcs = [monotonic(), null];
      return null;
    }
    const names = await self._pidNameMap();
    let own;
    try {
      own = new Set(await self.processTreePids(process.pid));
    } catch {
      own = new Set(); // attribution is a nicety, not a gate
    }
    const list = [];
    for (const [pid, mb] of rows) {
      // Zero-holding processes are noise: the counter set lists every process that has
      // ever touched the adapter this boot.
      if (mb > 0) list.push({ pid, name: names.get(pid) ?? "", memMb: mb, own: own.has(pid) });
    }
    const out = { source, additive, processes: pySorted(list, (r) => [-r.memMb, r.pid]) };
    cache.gpuProcs = [monotonic(), out];
    return out;
  });
}

/**
 * Split a Windows command line the way CommandLineToArgvW does (backslashes before a quote
 * escape it; quotes group). Candidate for platform/.
 */
export function splitWindowsCommandLine(s) {
  const args = [];
  let cur = "";
  let inQ = false;
  let has = false;
  let i = 0;
  const str = String(s ?? "");
  while (i < str.length) {
    const c = str[i];
    if (c === "\\") {
      let n = 0;
      while (str[i] === "\\") {
        n++;
        i++;
      }
      if (str[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2) {
          cur += '"';
          i++;
        }
      } else {
        cur += "\\".repeat(n);
      }
      has = true;
      continue;
    }
    if (c === '"') {
      if (inQ && str[i + 1] === '"') {
        cur += '"';
        i += 2;
        continue;
      }
      inQ = !inQ;
      has = true;
      i++;
      continue;
    }
    if (!inQ && (c === " " || c === "\t")) {
      if (has) args.push(cur);
      cur = "";
      has = false;
      i++;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  if (has) args.push(cur);
  return args;
}

/**
 * A process's argv, from the OS (JS-only: Python read psutil's `cmdline()`, which only
 * hosts that ship psutil had). Windows: Win32_Process.CommandLine via PowerShell CIM, split
 * like CommandLineToArgvW; Linux: /proc/<pid>/cmdline; elsewhere `ps -o args=` (split on
 * whitespace — approximate). null when the process is gone or unreadable.
 */
export async function processCmdline(pid) {
  const plat = self.platformKey();
  if (plat === "linux") {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const parts = raw.split("\0");
    if (parts.length && parts[parts.length - 1] === "") parts.pop();
    return parts.length ? parts : null;
  }
  if (plat === "windows") {
    const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pyInt(pid)}").CommandLine`;
    const out = (await runText(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], 15)).trim();
    return out ? splitWindowsCommandLine(out) : null;
  }
  const out = (await runText(["ps", "-o", "args=", "-p", String(pyInt(pid))], 5)).trim();
  return out ? splitWs(out) : null;
}

/**
 * The executable, plus the script an interpreter runs (`python.exe · whisper/engine.py`),
 * so two Python processes can be told apart. Without a command line (the process is gone,
 * or unreadable), the bare name.
 */
export async function _processLabel(pid, name) {
  let cmd;
  try {
    cmd = await self.processCmdline(pid);
  } catch {
    cmd = null; // a label is a nicety
  }
  if (!cmd) return name || `pid ${pid}`;
  const script = cmd.slice(1).find((a) => a.toLowerCase().endsWith(".py"));
  if (!script) return name || `pid ${pid}`;
  return `${name || "python"} · ${script.split(/[\\/]/).slice(-2).join("/")}`;
}

/**
 * Processes OUTSIDE this server's own tree holding at least `minMb` of GPU memory, biggest
 * first — what a failed model load names as taking the room (2026-09-29). Rows are
 * `gpuProcesses` rows plus `label`.
 *
 * The floor keeps the desktop out of the answer: the compositor alone holds ~160 MB on an
 * idle Windows box (measured 2026-09-29, `dwm.exe` 162 MB). The case this exists for
 * measured 1,295 and 286 MB per process — speech engines a hard-killed JustVoice server
 * had left running, 1.6 GB of an 8 GB card.
 *
 * null = unmeasurable (see `gpuProcesses`); [] = measured, nobody else.
 */
export async function otherGpuHolders({ minMb = 200 } = {}) {
  const snap = await self.gpuProcesses({ fresh: true });
  if (snap == null) return null;
  const out = [];
  for (const r of snap.processes) {
    if (!r.own && r.memMb >= minMb) out.push({ ...r, label: await self._processLabel(r.pid, r.name) });
  }
  return out;
}

// ─── GPU detection ───────────────────────────────────────────────────────────

/** Run one `nvidia-smi --query-gpu` call; null on any failure (never throws). */
export async function _nvidiaQuery(fields) {
  try {
    const r = await procs.run(["nvidia-smi", `--query-gpu=${fields}`, "--format=csv,noheader,nounits"], { timeout: 5 });
    if (r.returncode) throw new procs.CalledProcessError(r.returncode, "nvidia-smi", r.stdout, r.stderr); // check=True
    return textOut(r);
  } catch (e) {
    log.debug(`nvidia-smi query '${fields}' failed: ${e?.message ?? e}`);
    return null;
  }
}

export async function _nvidiaGpus() {
  if (!self.which("nvidia-smi")) return [];
  // `compute_cap` (added ~CUDA 11) drives the CUDA build choice; fall back to the base
  // fields on an old driver that rejects it (don't lose the GPU).
  let fields = "name,memory.total,driver_version,compute_cap";
  let out = await self._nvidiaQuery(fields);
  if (out == null) {
    fields = "name,memory.total,driver_version";
    out = await self._nvidiaQuery(fields);
  }
  if (out == null) return [];
  const ncols = fields.split(",").length;
  const gpus = [];
  for (const line of splitlines(out)) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length !== ncols) continue;
    const [name, mem, driver] = parts;
    const cap = ncols === 4 ? parts[3] : null;
    gpus.push(
      model(GpuInfo, { vendor: "NVIDIA", name, vramMb: intOfFloat(mem), driver: driver || null, computeCap: cap || null }),
    );
  }
  return gpus;
}

// PCI vendor ids we build rows for. NVIDIA (0x10de) is deliberately absent — nvidia-smi
// stays the single NVIDIA authority (no smi = no usable CUDA anyway). (The Intel-Arc NAME
// regex was deleted 2026-07-23: classification keys on dedicated VRAM, isDiscreteGpu.)
const PCI_VENDOR_TO_NAME = { "0x1002": "AMD", "0x8086": "Intel" };

/**
 * One `lspci -mm` pass → Map {pci address (no domain): device name}; empty when lspci is
 * unavailable. Only used to give scanned rows their marketing name — a miss falls back to
 * a generic vendor label, never an error.
 */
export async function _lspciNames() {
  const names = new Map();
  if (!self.which("lspci")) return names;
  let out;
  try {
    out = await runText(["lspci", "-mm"], 5);
  } catch (e) {
    log.debug(`lspci -mm failed: ${e?.message ?? e}`);
    return names;
  }
  for (const line of splitlines(out)) {
    // `03:00.0 "VGA compatible controller" "<vendor>" "<device name>" …`
    const m = /^(\S+)\s+"[^"]*"\s+"[^"]*"\s+"([^"]*)"/.exec(line);
    if (m) names.set(m[1], m[2]);
  }
  return names;
}

/**
 * AMD/Intel GPU rows from the kernel's sysfs (Linux). Never throws.
 *
 * Top-level `cardN` entries only (connector nodes like `card0-DP-1` and `renderD*` are
 * skipped); vendor from the standard PCI `device/vendor` attribute. AMD VRAM from amdgpu's
 * `mem_info_vram_total` (bytes → MiB, kernel-documented sysfs ABI); Intel VRAM stays null
 * (no stable merged ABI for discrete local memory — the lmem sysfs never left RFC).
 */
export async function _pciGpusLinux(root = "/sys/class/drm") {
  const cards = drmCards(root);
  if (cards === null) return [];
  const names = await self._lspciNames();
  const gpus = [];
  for (const card of cards) {
    const dev = path.join(card, "device");
    let vendorId;
    try {
      vendorId = readFileSync(path.join(dev, "vendor"), "utf8").trim().toLowerCase();
    } catch {
      continue;
    }
    const vendor = Object.hasOwn(PCI_VENDOR_TO_NAME, vendorId) ? PCI_VENDOR_TO_NAME[vendorId] : null;
    if (vendor === null) continue;
    let vramMb = null;
    if (vendor === "AMD") {
      try {
        vramMb = Math.floor(pyInt(readFileSync(path.join(dev, "mem_info_vram_total"), "utf8").trim()) / MIB);
      } catch {
        vramMb = null;
      }
    }
    let pciAddr;
    try {
      pciAddr = path.basename(realpathSync(dev)); // the device symlink target, e.g. 0000:03:00.0
    } catch {
      pciAddr = "";
    }
    const short = pciAddr.replace(/^[0-9a-fA-F]{4}:/, ""); // lspci prints no domain
    const name = names.get(short) || names.get(pciAddr) || `${vendor} GPU`;
    gpus.push(model(GpuInfo, { vendor, name, vramMb, driver: null, computeCap: null }));
  }
  return gpus;
}

/**
 * Decode a registry `HardwareInformation.qwMemorySize` value → MiB. Accepts REG_QWORD (a
 * number / bigint) or REG_BINARY (bytes, little-endian, the first 8); null on junk.
 */
export function _qwToMb(value) {
  let n;
  try {
    if (value instanceof Uint8Array) {
      n = 0n;
      const b = value.subarray(0, 8);
      for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
    } else if (typeof value === "bigint") {
      n = value;
    } else {
      n = BigInt(pyInt(value));
    }
  } catch {
    return null;
  }
  return n > 0n ? Number(n / BigInt(MIB)) : null;
}

const WIN_DISPLAY_CLASS = "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";

/**
 * `reg query <key> /s /v <name>` output → Map {subkey (4 digits) → the value as Python's
 * winreg would hand it: a string (REG_SZ…), a number (REG_DWORD/REG_QWORD) or bytes
 * (REG_BINARY)}. Only direct `NNNN` subkeys of the class key count, as Python's EnumKey loop.
 */
export function _parseRegValues(out) {
  const found = new Map();
  let sub = null;
  for (const line of splitlines(out)) {
    if (/^HKEY_/i.test(line)) {
      const m = /\\\{4d36e968-e325-11ce-bfc1-08002be10318\}\\(\d{4})$/i.exec(line.trim());
      sub = m ? m[1] : null;
      continue;
    }
    const v = /^\s+(.+?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/.exec(line);
    if (!v || sub === null) continue;
    const [, , type, data = ""] = v;
    let value = data;
    if (type === "REG_DWORD" || type === "REG_QWORD") {
      try {
        value = BigInt(data.trim());
      } catch {
        value = data;
      }
    } else if (type === "REG_BINARY") {
      value = Buffer.from(data.trim(), "hex");
    }
    if (!found.has(sub)) found.set(sub, value);
  }
  return found;
}

/**
 * AMD/Intel GPU rows from the Windows display-class registry. Never throws.
 *
 * `DriverDesc` = adapter name; `HardwareInformation.qwMemorySize` = the 64-bit VRAM byte
 * count (`Win32_VideoController.AdapterRAM` is uint32 → caps at 4 GB, so it is NOT used).
 * Python read the registry in-process (winreg); Node has no registry API, so this reads the
 * same two values with `reg query` (two calls, through the no-console door).
 */
export async function _registryGpusWindows() {
  if (self.platformKey() !== "windows") return [];
  const key = `HKLM\\${WIN_DISPLAY_CLASS}`;
  let descs;
  let sizes;
  try {
    descs = _parseRegValues(await runText(["reg", "query", key, "/s", "/v", "DriverDesc"], 10));
    sizes = _parseRegValues(await runText(["reg", "query", key, "/s", "/v", "HardwareInformation.qwMemorySize"], 10));
  } catch (e) {
    log.debug(`display-class registry scan failed: ${e?.message ?? e}`);
    return [];
  }
  const gpus = [];
  for (const sub of pySorted([...descs.keys()])) {
    const nameVal = descs.get(sub);
    const name = Buffer.isBuffer(nameVal) ? nameVal.toString("hex") : String(nameVal);
    const low = name.toLowerCase();
    if (low.includes("nvidia") || low.includes("geforce")) continue; // nvidia-smi stays the NVIDIA authority
    let vendor;
    if (low.includes("amd") || low.includes("radeon")) vendor = "AMD";
    else if (low.includes("intel")) vendor = "Intel";
    else continue;
    const vramMb = sizes.has(sub) ? _qwToMb(sizes.get(sub)) : null;
    gpus.push(model(GpuInfo, { vendor, name, vramMb, driver: null, computeCap: null }));
  }
  return gpus;
}

/** AMD/Intel rows for this platform — only called when no NVIDIA GPU was found. */
export async function _gpuScan() {
  const plat = self.platformKey();
  if (plat === "linux") return self._pciGpusLinux();
  if (plat === "windows") return self._registryGpusWindows();
  return [];
}

/**
 * Best-effort: is an AMD/Radeon GPU present? Never throws. Only probed when no NVIDIA GPU
 * was found, so the NVIDIA fast-path pays nothing.
 */
export async function _amdGpuPresent() {
  const plat = self.platformKey();
  try {
    if (plat === "linux" && self.which("lspci")) {
      const out = (await runText(["lspci"], 5)).toLowerCase();
      return ["amd/ati", "advanced micro devices", "radeon"].some((k) => out.includes(k));
    }
    if (plat === "windows") {
      if (process.env.HIP_PATH) return true; // AMD HIP SDK installed
      if (self.which("wmic")) {
        const out = (await runText(["wmic", "path", "win32_VideoController", "get", "name"], 8)).toLowerCase();
        return out.includes("amd") || out.includes("radeon");
      }
    }
  } catch (e) {
    log.debug(`amd detection failed: ${e?.message ?? e}`);
  }
  return false;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** ROCm/HIP runtime present (rocminfo / HIP SDK / /opt/rocm). */
export function _rocmAvailable() {
  return Boolean(self.which("rocminfo") || self.which("hipInfo") || process.env.HIP_PATH || isDir("/opt/rocm"));
}

/** A Vulkan loader/tool is present (the universal GPU fallback). */
export function _vulkanAvailable() {
  if (self.which("vulkaninfo")) return true;
  const plat = self.platformKey();
  if (plat === "windows") {
    const sysroot = process.env.SystemRoot ?? "C:\\Windows";
    return exists(path.join(sysroot, "System32", "vulkan-1.dll"));
  }
  if (plat === "linux") {
    return ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib/libvulkan.so.1", "/usr/lib64/libvulkan.so.1"].some(exists);
  }
  return false;
}

/**
 * Total physical RAM (MiB). node:os reads what Python's arms read: Windows
 * GlobalMemoryStatusEx (ullTotalPhys), Linux MemTotal, macOS hw.memsize. (Python's
 * Windows arm was MISSING until 2026-07-22: every Windows box detected ram=0 for its
 * entire life, so the seeded class config never matched the very PC it was measured on.)
 */
export function _ramMb() {
  try {
    return Math.floor(os.totalmem() / MIB);
  } catch {
    return 0;
  }
}

/** os.cpu_count() — logical processors; 0 when unknown. */
function cpuCount() {
  try {
    return os.cpus().length || 0;
  } catch {
    return 0;
  }
}

/** Detect this box's hardware, afresh (every call probes — see `ensureDetected` for the memo). */
export async function detect() {
  const plat = self.platformKey();
  let gpus = await self._nvidiaGpus();
  const runtimes = {};
  if (gpus.length && self.which("nvidia-smi")) {
    runtimes.cuda = true;
    // Record the Vulkan capability FACT too (gpu-gated, like the AMD arm): on Linux the
    // pinned build has no installable CUDA archive (docker-only, and no pin-faithful image
    // exists upstream — A4), so selection falls to the REAL pinned vulkan build there; on
    // Windows cuda archives exist and stay preferred — the extra fact only widens the A3
    // chain.
    if (await self._vulkanAvailable()) runtimes.vulkan = true;
  } else if (plat === "windows" || plat === "linux") {
    // No NVIDIA → scan for AMD/Intel rows (A1: real name + VRAM where the platform exposes
    // it, so Fit and machineKey work on those boxes).
    const scanned = await self._gpuScan();
    gpus = scanned;
    const amd = scanned.filter((g) => g.vendor === "AMD");
    const intel = scanned.filter((g) => g.vendor === "Intel");
    if (amd.length || (!scanned.length && (await self._amdGpuPresent()))) {
      // Record BOTH capability facts when present — `runtimes` states what the box can do;
      // SELECTION prefers ROCm via `_gpuPreference` order (the 2026-07-01 "ROCm first,
      // else Vulkan" decision). Both facts must exist so the A3 spawn chain can fall from
      // a broken rocm build to an installed vulkan one. The empty-scan arm keeps the legacy
      // name-sniff as a last resort (runtime-only, no row) so no environment detects LESS
      // than before the scan existed.
      if (await self._rocmAvailable()) runtimes.rocm = true;
      if (await self._vulkanAvailable()) runtimes.vulkan = true;
    } else if (intel.length) {
      // A2 WIDENED (2026-07-23): ANY detected Intel GPU gets the Vulkan runtime when the
      // loader is present — the old gate required "Arc" in the name, but the Core Ultra 7's
      // registry says plain "Intel(R) Graphics" while its Vulkan device serves an 18 GB
      // shared pool. The loader check still gates (no vulkan-1.dll → no vulkan runtime →
      // the online-provider path), and the A3 spawn chain falls back if the build won't
      // run on a weak iGPU.
      if (await self._vulkanAvailable()) runtimes.vulkan = true;
    }
  }
  if (plat === "macos") runtimes.metal = true;
  return model(HardwareInfo, {
    os: systemName(),
    platform: plat,
    cpuCores: cpuCount(),
    ramMb: self._ramMb(),
    gpus,
    runtimes,
  });
}
