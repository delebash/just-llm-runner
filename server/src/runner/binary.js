// SPDX-License-Identifier: MIT
// llama.cpp binary acquisition — select + download + unpack (the port of
// llm_runner/runner/binary.py).
//
// Self-contained (uses this package's own hardware + download), so it runs in any app's
// server with no app coupling. No CUDA toolkit is ever installed; this only DETECTS +
// SELECTS the prebuilt build. Windows CUDA builds need the separate cudart runtime DLLs
// (`asset.runtimeUrl`) unpacked alongside the exe — those are fetched too.
//
// Sync / async: selection, paths and the on-disk probes stay SYNC (selectBinary,
// acquiredServerExe(s), buildOfExe, resolveReleaseAssets, installedRuntimeExe, … — small
// directory reads, as Python's); anything that downloads, unpacks, hashes or runs the exe
// is ASYNC (acquireBinary, acquireRuntime, _unpack, _fileSha256, _verifyExeLaunches,
// _verifyExeAcceptsFlags, _stageAndSwap). Paths are strings (Python's Path objects).
// Python's keyword arguments after the positional ones are an options object:
// `acquireBinary(cacheRoot, config, hardware, {onProgress, cancelCheck, gpu, force,
// probeArgvs})`, `acquireRuntime(cacheRoot, folder, build, binaries, hardware,
// {preferredGpu, gpu, force, dlKwargs, onProgress, cancelCheck, probeArgvs})`.
//
// Unpacking: Python used zipfile / tarfile (`filter="data"`); Node has neither. A zip is
// platform/zip.js's `extractZip`; a small tar reader over node:zlib lives below
// (`extractTarGz` — a candidate for platform/), following tarfile's "data" filter.

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { getLogger } from "../platform/log.js";
import * as procs from "../platform/procs.js";
import { FileNotFoundError, NotImplementedError, pyFloatParse, pyMax, pySorted, RuntimeError } from "../platform/py.js";
import { extractZip } from "../platform/zip.js";
import * as download from "./download.js";
import { splitlines } from "./hardware.js";
import * as self from "./binary.js";

const log = getLogger("llm_runner.runner.binary");


/**
 * Choose the CUDA build by the GPU chip (compute capability).
 *
 * Blackwell (sm_100/sm_120 → compute cap 10.0/12.0) needs CUDA ≥ 12.8, so our 12.4 build
 * can't target it → use the 13.x build. Older cards (Turing 7.5, Ampere/Ada 8.x) run on
 * both → 12.4 for broad driver compatibility. An unknown capability defaults to 12.4 (the
 * safe, widest-compat build).
 */
export function _cudaKey(hardware) {
  let maxCap = 0.0;
  for (const g of hardware.gpus || []) {
    try {
      maxCap = Math.max(maxCap, pyFloatParse(g.computeCap || 0));
    } catch {}
  }
  return maxCap >= 10.0 ? "cuda13" : "cuda12";
}

/**
 * The user-facing backend FAMILY of a concrete asset key: every chip-specific CUDA build
 * (`cuda12`/`cuda13`) collapses to `"cuda"`; the rest are their own family. The UI
 * offers/pins families; the runner resolves the concrete key.
 */
export function gpuFamily(gpu) {
  const g = (gpu || "").trim().toLowerCase();
  return g.startsWith("cuda") ? "cuda" : g;
}

/**
 * Map a backend FAMILY the user picked (`cuda`/`vulkan`/…) to the concrete asset key for
 * THIS box — `cuda` → the chip-aware `_cudaKey`; others are their own key. Empty stays
 * empty (Auto).
 */
export function concreteGpu(hardware, family) {
  const fam = (family || "").trim().toLowerCase();
  if (!fam) return "";
  return fam === "cuda" ? _cudaKey(hardware) : fam;
}

/**
 * Ordered GPU-asset preference, most-capable first, CPU last.
 *
 * NVIDIA → the chip-aware CUDA build (`_cudaKey`). AMD/Intel → ROCm/HIP first (best perf
 * when detected), Vulkan as the universal fallback. CPU is always the final fallback. A
 * non-empty `preferred` FAMILY (the user's backend override) is moved to the FRONT when
 * that runtime is actually present — otherwise it is ignored, so a pin for a backend this
 * box can't run degrades silently to the auto order (the spawn chain still honours what's
 * installed).
 */
export function _gpuPreference(hardware, preferred = "") {
  const rt = hardware.runtimes || {};
  const prefs = [];
  if (rt.metal) prefs.push("metal");
  if (rt.cuda) prefs.push(_cudaKey(hardware));
  if (rt.rocm) prefs.push("rocm");
  if (rt.vulkan) prefs.push("vulkan");
  prefs.push("cpu");
  const want = concreteGpu(hardware, preferred);
  if (want && prefs.includes(want)) {
    prefs.splice(prefs.indexOf(want), 1);
    prefs.unshift(want);
  }
  return prefs;
}

/** {gpu → row} like Python's dict comprehension (a later row with the same gpu wins). */
function byGpu(rows, keep) {
  const m = new Map();
  for (const b of rows) if (keep(b)) m.set(b.gpu, b);
  return m;
}

/**
 * Pick the best binary asset for (platform, gpu); null if none match.
 *
 * `source: "docker"` rows are NEVER auto-selected (A4, re-scoped 2026-07-06): upstream
 * discontinued per-build image tags (only rolling `server-cuda*` remain — verified against
 * ghcr manifests), so no PIN-FAITHFUL container exists for the pinned build; auto-selecting
 * one would hand out an engine that silently tracks master, breaking the b-pin every
 * switch/tune fact is grounded on. A Linux+NVIDIA box therefore falls to the real pinned
 * vulkan archive (the vulkan runtime fact is recorded by detect()), else nothing. The row
 * stays in config as the future seam. Returns the config's own row object.
 */
export function selectBinary(config, hardware) {
  const rows = byGpu(config.llamacpp.binaries || [], (b) => b.platform === hardware.platform && b.source !== "docker");
  for (const gpu of _gpuPreference(hardware, config.preferredGpu)) {
    if (rows.has(gpu)) return rows.get(gpu);
  }
  return null;
}

/** Where a build's unpacked variants live (caller supplies the cache root). */
export function binaryDir(cacheRoot, build) {
  return path.join(cacheRoot, "llamacpp", build);
}

/**
 * Where ONE gpu-variant of a build unpacks (A3): `<build>/<gpu>/`. Multiple variants
 * coexist so the spawn fallback chain has something to chain TO. Installs made before this
 * layout landed live at the BUILD root — probes treat a root-level exe as the SELECTED
 * asset's (legacy back-compat, never removed).
 */
export function variantDir(cacheRoot, build, gpu) {
  return path.join(binaryDir(cacheRoot, build), gpu);
}

/**
 * Numeric part of a llama.cpp BUILD tag ("b9929" → 9929); -1 for anything else — one parser
 * shared by the update check and the newest-on-disk ordering.
 *
 * STRICT since 2026-09-19 (plan docs/plans/2026-09-19-engine-update-safety-and-stable-
 * channel.md §3.2). Upstream began publishing semver releases ("v0.4.1") and flagging every
 * bNNNN build a prerelease, so `releases/latest` answers a `v` tag. A digit-strip read
 * "v0.4.1" as 41 (silently "you are current") and would read "v1.10.500" as 110500 — newer
 * than every build, offering an update whose download 404s.
 */
export function buildNum(tag) {
  const m = /^b(\d+)$/.exec(String(tag ?? "").trim());
  return m ? Number(m[1]) : -1;
}

const UPSTREAM_DL = "https://github.com/ggml-org/llama.cpp/releases/download";

/**
 * "platform/gpu" → [asset regex, runtime-companion regex | null]. `{b}` = the escaped build
 * tag; `{v}` = the CUDA version captured from the chosen asset (an asset on 12.4 needs the
 * cudart on 12.4). Patterns are ANCHORED and end in the arch, so `…-win-cuda-13.4-arm64.zip`
 * can never satisfy an x64 row.
 *
 * WHY THIS EXISTS (2026-09-19, plan …-engine-update-safety-and-stable-channel.md §3.4):
 * upstream RENAMES these files between builds, and substituting the tag into the stored name
 * 404s mid-update. Windows AMD went hip-radeon → rocm-7.14 → rocm-10.0, Linux AMD rocm-7.2
 * → (absent for ~180 builds) → rocm-10.0, Windows CUDA 13 13.3 → 13.4.
 */
export const ASSET_PATTERNS = {
  "windows/cuda12": ["^llama-{b}-bin-win-cuda-(12\\.\\d+)-x64\\.zip$", "^cudart-llama-bin-win-cuda-{v}-x64\\.zip$"],
  "windows/cuda13": ["^llama-{b}-bin-win-cuda-(13\\.\\d+)-x64\\.zip$", "^cudart-llama-bin-win-cuda-{v}-x64\\.zip$"],
  "windows/rocm": ["^llama-{b}-bin-win-(?:hip-radeon|rocm-([\\d.]+))-x64\\.zip$", null],
  "windows/vulkan": ["^llama-{b}-bin-win-vulkan-x64\\.zip$", null],
  "macos/metal": ["^llama-{b}-bin-macos-arm64\\.tar\\.gz$", null],
  "linux/rocm": ["^llama-{b}-bin-ubuntu-rocm-([\\d.]+)-x64\\.tar\\.gz$", null],
  "linux/vulkan": ["^llama-{b}-bin-ubuntu-vulkan-x64\\.tar\\.gz$", null],
};

/** re.escape for a value spliced into a pattern. */
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\\-/]/g, "\\$&");

/** Placeholders are substituted, never formatted — the patterns contain regex braces. */
export function _fill(pattern, build, version = "") {
  return pattern.replaceAll("{b}", reEscape(build)).replaceAll("{v}", reEscape(version));
}

/** Sort key for a captured version ('10.0' > '7.14'); no capture ranks lowest. */
export function _versionKey(captured) {
  if (!captured) return [0];
  return [
    1,
    ...captured
      .split(".")
      .filter((p) => /^[0-9]+$/.test(p))
      .map(Number),
  ];
}

const firstGroup = (m) => m.slice(1).find((g) => g) ?? null;

/**
 * Map each stored binary row to the file that BUILD actually publishes.
 *
 * Pure: `assets` is `[{name, url}]` from the release, `rows` are BinaryAssets
 * (`config.llamacpp.binaries`). Per row, `resolved` is
 *   true  — found; `assetUrl`/`runtimeUrl` are that build's real downloads,
 *   false — this build publishes nothing for that (platform, gpu),
 *   null  — not ours to resolve: a docker row, a (platform, gpu) with no pattern, or a
 *           hand-edited URL that is not an upstream release download (a mirror stays put).
 * Result rows are camelCase so the UI can merge them straight into the engine-config
 * `binaries` it PUTs. Unresolved and not-ours rows keep their stored URLs untouched.
 */
export function resolveReleaseAssets(build, rows, assets) {
  const names = new Map();
  for (const a of assets || []) names.set(String(a.name || ""), String(a.url || ""));
  const out = [];
  for (const row of rows || []) {
    const platform = row.platform ?? "";
    const gpu = row.gpu ?? "";
    const assetUrl = row.assetUrl || "";
    const runtimeUrl = row.runtimeUrl || "";
    const res = { platform, gpu, assetUrl, runtimeUrl, resolved: null, reason: "" };
    const pattern = Object.hasOwn(ASSET_PATTERNS, `${platform}/${gpu}`) ? ASSET_PATTERNS[`${platform}/${gpu}`] : null;
    const source = row.source ?? "github";
    if (source !== "github") {
      res.reason = `${source} rows are not release downloads`;
    } else if (pattern === null) {
      res.reason = `no asset pattern for ${platform}/${gpu}`;
    } else if (!assetUrl.includes("/ggml-org/llama.cpp/releases/download/")) {
      res.reason = "a custom URL — left exactly as stored";
    } else {
      const [assetRe, runtimeRe] = pattern;
      const re = new RegExp(_fill(assetRe, build));
      const matches = [];
      for (const n of names.keys()) {
        const m = re.exec(n);
        if (m) matches.push([m, n]);
      }
      const best = matches.length ? pyMax(matches, ([m]) => _versionKey(firstGroup(m))) : null;
      if (best === null) {
        res.resolved = false;
        res.reason = `no download for ${platform}/${gpu} at ${build}`;
      } else {
        const [match, name] = best;
        const version = firstGroup(match) || "";
        let newRuntime = "";
        if (runtimeRe !== null) {
          const want = new RegExp(_fill(runtimeRe, build, version));
          for (const n of names.keys()) {
            if (want.test(n)) {
              newRuntime = names.get(n) || `${UPSTREAM_DL}/${build}/${n}`;
              break;
            }
          }
          if (!newRuntime) {
            res.resolved = false;
            res.reason = `${name} has no matching runtime companion at ${build} — it would not launch`;
            out.push(res);
            continue;
          }
        }
        res.resolved = true;
        res.assetUrl = names.get(name) || `${UPSTREAM_DL}/${build}/${name}`;
        res.runtimeUrl = newRuntime;
      }
    }
    out.push(res);
  }
  return out;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build dirs actually present under `llamacpp/`, newest tag first. "logs" is the one
 * non-build sibling dir; loose files (the generated models.ini) are files, not dirs, so the
 * scan never sees them.
 */
export function _onDiskBuilds(cacheRoot) {
  const root = path.join(cacheRoot, "llamacpp");
  if (!isDir(root)) return [];
  const names = readdirSync(root).filter((n) => n !== "logs" && isDir(path.join(root, n)));
  return pySorted(names, buildNum, true);
}

/**
 * The build an installed exe IS — read from the dir it lives under (`llamacpp/<build>/…`).
 * Reliable because the install names the folder for the pin AND downloads the concrete URL
 * stored for that pin (the UI keeps every stored URL in lock-step with the pin), so the
 * folder name and the binary always agree.
 */
export function buildOfExe(cacheRoot, exe) {
  const rel = path.relative(path.join(cacheRoot, "llamacpp"), exe);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep)[0];
}

/** Path.rglob(name), files and dirs alike: pre-order, each directory's own hit first. */
function* rglob(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const hit = path.join(dir, name);
    if (existsSync(hit)) yield hit;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
}

export function _findServerExe(root, exeName) {
  const direct = path.join(root, exeName);
  if (isFile(direct)) return direct;
  for (const found of rglob(root, exeName)) {
    if (isFile(found)) return found;
  }
  return null;
}

/**
 * An asset's installed exe within ONE build (the pin unless `build` says otherwise): its
 * variant dir first; optionally the legacy build root (pre-variant-layout installs —
 * attributed ONLY to the selected asset, so one legacy exe never counts as every variant).
 * The WRITE path (`acquireBinary`) uses this pin-keyed form directly — install/update
 * always TARGET the pin.
 */
export function _findVariantExe(cacheRoot, config, asset, { legacyRoot, build = null }) {
  if (build == null) build = config.llamacpp.pinnedBuild;
  let exe = _findServerExe(variantDir(cacheRoot, build, asset.gpu), asset.serverExe);
  if (exe === null && legacyRoot) {
    const root = binaryDir(cacheRoot, build);
    const direct = path.join(root, asset.serverExe);
    if (isFile(direct)) {
      exe = direct;
    } else {
      // root-level legacy install: search WITHOUT descending into variant dirs (a variant
      // exe belongs to its own gpu key, not the legacy slot).
      const variants = new Set((config.llamacpp.binaries || []).map((b) => b.gpu));
      for (const found of rglob(root, asset.serverExe)) {
        const first = path.relative(root, found).split(path.sep)[0];
        if (isFile(found) && !variants.has(first)) {
          exe = found;
          break;
        }
      }
    }
  }
  return exe;
}

/**
 * READ-path resolution (QC-13, the user's law: "check the path and if path exe exist
 * assume engine is installed"): the pinned build when its folder holds the exe, else the
 * NEWEST on-disk build folder that does — a DB reset reverting the pin must not hide an
 * engine the Update flow already installed. Only status/spawn/uninstall resolve;
 * `acquireBinary` stays pin-keyed (resolving there would let a pin-bump Update skip its
 * download and the stale-build sweep would then delete the only engine on disk).
 */
export function _findInstalledExe(cacheRoot, config, asset, { legacyRoot }) {
  const pinned = config.llamacpp.pinnedBuild;
  for (const candidate of [pinned, ..._onDiskBuilds(cacheRoot).filter((b) => b !== pinned)]) {
    const exe = _findVariantExe(cacheRoot, config, asset, { legacyRoot, build: candidate });
    if (exe !== null) return exe;
  }
  return null;
}

export function acquiredServerExe(cacheRoot, config, hardware) {
  const asset = selectBinary(config, hardware);
  if (asset === null) return null;
  return _findInstalledExe(cacheRoot, config, asset, { legacyRoot: true });
}

/**
 * Every INSTALLED build variant as [gpuKey, exe], in `_gpuPreference` order — the spawn
 * fallback chain (A3) walks this list. It only ever REPORTS what is on disk; it never
 * downloads (a load must not install — the engine-install split). The legacy build-root
 * exe counts only for the SELECTED asset (single attribution).
 */
export function acquiredServerExes(cacheRoot, config, hardware) {
  const selected = selectBinary(config, hardware);
  const rows = byGpu(config.llamacpp.binaries || [], (b) => b.platform === hardware.platform);
  const out = [];
  for (const gpu of _gpuPreference(hardware, config.preferredGpu)) {
    const asset = rows.get(gpu);
    if (asset === undefined) continue;
    const exe = _findInstalledExe(cacheRoot, config, asset, {
      legacyRoot: selected !== null && asset.gpu === selected.gpu,
    });
    if (exe !== null) out.push([gpu, exe]);
  }
  return out;
}

// ─── Archives (tarfile, as a small reader over node:zlib) ───────────────────────

class BadArchive extends Error {
  constructor(m) {
    super(m);
    this.name = "BadArchive";
  }
}

const TAR_BLOCK = 512;

/** tarfile's nts: a NUL-terminated field. */
const tarStr = (b) => {
  const i = b.indexOf(0);
  return (i >= 0 ? b.subarray(0, i) : b).toString("utf8");
};

/** tarfile's nti: octal (or GNU base-256 when the high bit is set). */
function tarNum(b) {
  if (b[0] === 0o200 || b[0] === 0o377) {
    let n = 0n;
    for (let i = 1; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
    if (b[0] === 0o377) n -= 1n << BigInt(8 * (b.length - 1));
    return Number(n);
  }
  const s = tarStr(b).replace(/[\s\0]+/g, "");
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new BadArchive("invalid header");
  return Number.parseInt(s, 8);
}

/** Inside `root` (both already absolute and normalized)? */
function within(root, p) {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Parse pax records ("%d %s=%s\n") into an object. */
function paxRecords(buf) {
  const out = {};
  let p = 0;
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p);
    if (sp < 0) break;
    const len = Number.parseInt(buf.subarray(p, sp).toString("ascii"), 10);
    if (!len) break;
    const rec = buf.subarray(sp + 1, p + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

/**
 * tarfile.open(archive, "r:gz").extractall(dest, filter="data"), streamed: the data filter's
 * rules — leading "/" stripped, absolute names, names and links resolving outside `dest`
 * and special files refused; file modes keep the owner's exec bit, add owner read/write and
 * drop setuid/setgid/sticky and group/other write; directory and symlink modes ignored.
 * A symlink that can't be made (Windows without the privilege) gets its target's copy, as
 * tarfile falls back. Candidate for platform/.
 */
export async function extractTarGz(archive, dest) {
  mkdirSync(dest, { recursive: true });
  const root = realpathSync(dest);
  const links = []; // [kind, target, linkname] — made after every file is on disk
  const modes = []; // [target, mode]
  let buf = Buffer.alloc(0);
  let cur = null; // {fd | collect, remaining, pad}
  let pending = {}; // GNU longname/longlink and pax overrides for the next member
  let first = true;
  let ended = false;

  const member = (hdr) => {
    const sum = tarNum(hdr.subarray(148, 156));
    let s1 = 0;
    for (let i = 0; i < TAR_BLOCK; i++) s1 += i >= 148 && i < 156 ? 0x20 : hdr[i];
    if (sum !== s1) throw new BadArchive("bad checksum");
    const type = String.fromCharCode(hdr[156] || 0x30);
    let name = tarStr(hdr.subarray(0, 100));
    const magic = hdr.subarray(257, 263).toString("latin1");
    if (magic.startsWith("ustar") && !"LK".includes(type)) {
      const prefix = tarStr(hdr.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    let size = tarNum(hdr.subarray(124, 136));
    let linkname = tarStr(hdr.subarray(157, 257));
    if (pending.name != null) name = pending.name;
    if (pending.linkname != null) linkname = pending.linkname;
    if (pending.size != null) size = pending.size;
    return { type, name, size, linkname, mode: tarNum(hdr.subarray(100, 108)) };
  };

  const startMember = (m) => {
    const pad = (TAR_BLOCK - (m.size % TAR_BLOCK)) % TAR_BLOCK;
    if (m.type === "L" || m.type === "K" || m.type === "x" || m.type === "g") {
      cur = { collect: [], remaining: m.size, pad, kind: m.type };
      return;
    }
    pending = {};
    // the "data" filter
    let name = m.name.replace(/^[/\\]+/, "");
    if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) throw new BadArchive(`member '${m.name}' has an absolute path`);
    const target = path.resolve(root, name);
    if (!within(root, target)) throw new BadArchive(`'${m.name}' would be extracted to '${target}', which is outside the destination`);
    const isReg = m.type === "0" || m.type === "7" || m.type === "\0";
    if (m.type === "1" || m.type === "2") {
      if (path.isAbsolute(m.linkname)) throw new BadArchive(`'${m.name}' is a link to an absolute path`);
      const linkTarget = m.type === "2" ? path.resolve(root, path.dirname(name), m.linkname) : path.resolve(root, m.linkname);
      if (!within(root, linkTarget)) throw new BadArchive(`'${m.name}' would link to '${linkTarget}', which is outside the destination`);
      mkdirSync(path.dirname(target), { recursive: true });
      links.push([m.type, target, m.type === "2" ? m.linkname : linkTarget]);
    } else if (m.type === "5") {
      mkdirSync(target, { recursive: true });
    } else if (!isReg) {
      throw new BadArchive(`'${m.name}' is a special file`);
    }
    if (isReg) {
      mkdirSync(path.dirname(target), { recursive: true });
      let mode = m.mode & 0o755; // strip high bits & group/other write bits
      if (!(mode & 0o100)) mode &= ~0o111; // clear exec bits if not executable by the owner
      mode |= 0o600; // the owner can read & write
      modes.push([target, mode]);
      cur = { fd: openSync(target, "w"), remaining: m.size, pad };
    } else {
      cur = m.size + pad ? { remaining: m.size, pad } : null; // links/dirs carry no data
    }
    if (cur && cur.remaining === 0 && cur.pad === 0) finishData();
  };

  const finishData = () => {
    if (cur.fd != null) closeSync(cur.fd);
    if (cur.collect) {
      const data = Buffer.concat(cur.collect);
      if (cur.kind === "L") pending.name = tarStr(data);
      else if (cur.kind === "K") pending.linkname = tarStr(data);
      else if (cur.kind === "x") {
        const rec = paxRecords(data);
        if (rec.path != null) pending.name = rec.path;
        if (rec.linkpath != null) pending.linkname = rec.linkpath;
        if (rec.size != null) pending.size = Number(rec.size);
      }
    }
    cur = null;
  };

  // `raw` is closed in `finally`: stopping at the end marker otherwise leaves the archive
  // open for the life of the process.
  const raw = createReadStream(archive);
  const src = raw.pipe(createGunzip());
  try {
    for await (const chunk of src) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (!ended) {
        if (cur) {
          if (cur.remaining > 0) {
            if (!buf.length) break;
            const take = Math.min(cur.remaining, buf.length);
            const piece = buf.subarray(0, take);
            if (cur.fd != null) writeSync(cur.fd, piece);
            else if (cur.collect) cur.collect.push(Buffer.from(piece));
            cur.remaining -= take;
            buf = buf.subarray(take);
          }
          if (cur.remaining === 0) {
            if (buf.length < cur.pad) break;
            buf = buf.subarray(cur.pad);
            finishData();
          }
          continue;
        }
        if (buf.length < TAR_BLOCK) break;
        const hdr = buf.subarray(0, TAR_BLOCK);
        buf = buf.subarray(TAR_BLOCK);
        if (hdr.every((x) => x === 0)) {
          ended = true; // end of archive (tarfile stops at the first zero block)
          break;
        }
        let m;
        try {
          m = member(hdr);
        } catch (e) {
          if (first) throw e;
          ended = true; // a bad header after the first ends the archive, as tarfile reads it
          break;
        }
        first = false;
        startMember(m);
      }
      if (ended) break;
    }
  } finally {
    if (cur?.fd != null) closeSync(cur.fd);
    src.destroy();
    if (!raw.closed) await new Promise((done) => raw.once("close", done).destroy());
  }
  if (cur || (!ended && buf.length)) throw new BadArchive("unexpected end of data");
  for (const [kind, target, linkname] of links) {
    try {
      if (existsSync(target) || isSymlink(target)) unlinkSync(target);
      if (kind === "2") symlinkSync(linkname, target);
      else linkSync(linkname, target);
    } catch {
      // tarfile's fallback: extract the link's target in its place
      const from = kind === "2" ? path.resolve(path.dirname(target), linkname) : linkname;
      if (isFile(from)) copyFileSync(from, target);
    }
  }
  for (const [target, mode] of modes) {
    try {
      chmodSync(target, mode);
    } catch {}
  }
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Extract `archive` into `dest` — a `.zip` (Windows) or a `.tar.gz`/`.tgz` (macOS/Linux).
 * Assets come from the pinned llama.cpp release (trusted).
 */
export async function _unpack(archive, dest) {
  mkdirSync(dest, { recursive: true });
  const lower = path.basename(archive).toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) await extractTarGz(archive, dest);
  else await extractZip(archive, dest);
}

/** An OSError, as Python would class it: the OS refused to start / reach the program. */
function isOsError(e) {
  return e instanceof FileNotFoundError || typeof e?.code === "string" || typeof e?.errno === "number";
}

/**
 * Confirm a freshly-unpacked llama-server actually STARTS — the check a file-existence test
 * can't do. Runs `<exe> --version` (no model, ~instant): a RUNTIME-LOADER failure (a missing
 * DLL on Windows / a missing `.so` on Linux — the binary never reaches user code) throws so
 * the caller discards the staged build and leaves the working engine untouched. Born
 * 2026-07-21: an engine update landed a build whose cudart companion was absent; the exe
 * FILE was present so the install "succeeded", the old build was swept, and every launch
 * then died with exit 3221225781 (0xC0000135 STATUS_DLL_NOT_FOUND). `run` injects the
 * subprocess in tests.
 */
export async function _verifyExeLaunches(exe, platform, { run = null } = {}) {
  let rc;
  try {
    const proc = run ? await run() : await procs.run([String(exe), "--version"], { timeout: 60, text: false });
    rc = Number(proc?.returncode ?? 0) || 0;
  } catch (e) {
    if (e instanceof procs.TimeoutExpired) throw new RuntimeError(`engine binary ${exe} hung on --version: ${e.message}`);
    if (isOsError(e)) throw new RuntimeError(`engine binary ${exe} could not start: ${e.message}`);
    throw e;
  }
  // A loader failure has a distinctive exit: an NTSTATUS error on Windows (>= 0xC0000000,
  // e.g. 0xC0000135 = missing DLL) or 127 on Unix (missing shared library). ANY other code —
  // including a non-zero APP exit — means the process RAN, so its libraries loaded.
  const loaderFailed = platform === "windows" ? rc >= 0xc0000000 : rc === 127;
  if (loaderFailed) {
    const hex = platform === "windows" ? ` / 0x${(rc >>> 0).toString(16).toUpperCase().padStart(8, "0")}` : "";
    throw new RuntimeError(`engine binary ${exe} failed to launch (exit ${rc}${hex}) — a required runtime library is missing`);
  }
}

const asBuf = (x) => (x == null ? Buffer.alloc(0) : Buffer.isBuffer(x) ? x : Buffer.from(String(x), "utf8"));

/**
 * Confirm a freshly-unpacked llama-server ACCEPTS the launch flags this app emits — the
 * check `--version` alone cannot do.
 *
 * Born 2026-09-19 (plan …-engine-update-safety-and-stable-channel.md §3.3): llama.cpp b10875
 * DELETED `--mlock` and `--mmap`/`--no-mmap`. Such a build starts fine, so
 * `_verifyExeLaunches` passes it, it is swapped in, the old build is swept — and then every
 * model load dies on "error: invalid argument". A non-zero exit here throws, so the caller
 * discards the staged build and the working engine stays exactly where it was.
 *
 * Each argv is `<flags…> --version`: args parse in order and `--version` exits on sight, so
 * no model is loaded and no GPU is touched. `run` injects the subprocess in tests.
 */
export async function _verifyExeAcceptsFlags(exe, argvs, { run = null } = {}) {
  for (const argv of argvs || []) {
    let proc;
    try {
      proc = run ? await run(argv) : await procs.run([String(exe), ...argv], { timeout: 60, text: false });
    } catch (e) {
      if (e instanceof procs.TimeoutExpired || isOsError(e)) {
        throw new RuntimeError(`engine binary ${exe} could not run the flag check: ${e.message}`);
      }
      throw e;
    }
    const rc = Number(proc?.returncode ?? 0) || 0;
    if (rc !== 0) {
      const blob = Buffer.concat([asBuf(proc?.stdout), asBuf(proc?.stderr)]).toString("utf8");
      const line =
        splitlines(blob)
          .find((ln) => ln.includes("invalid argument") || ln.includes("error while handling argument"))
          ?.trim() ?? "";
      throw new RuntimeError(
        `this engine build does not accept a launch flag this app uses${line ? ` (${line})` : ` (exit ${rc})`} — the installed engine was left in place`,
      );
    }
  }
}

export async function _fileSha256(file) {
  const h = createHash("sha256");
  for await (const block of createReadStream(file, { highWaterMark: 1 << 20 })) h.update(block);
  return h.digest("hex");
}

/** shutil.rmtree(p, ignore_errors=True) */
function rmtree(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {}
}

/** Path.unlink(missing_ok=True) */
function unlinkMissingOk(p) {
  try {
    unlinkSync(p);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
}

/**
 * Atomically replace `dest` with the verified `staging` dir: retire the old dir to a sibling
 * backup, move the new one in, then delete the backup — so the working engine only ever
 * vanishes for the moment between two same-volume renames, and a mid-swap failure restores
 * it. Windows can't rename onto an existing dir, so the old one is moved aside first. Both
 * dirs are siblings under `<build>/`, so the renames stay on one volume.
 */
export function _swapIntoPlace(staging, dest) {
  const backup = path.join(path.dirname(dest), `.old-${path.basename(dest)}`);
  rmtree(backup);
  if (existsSync(dest)) renameSync(dest, backup);
  try {
    renameSync(staging, dest);
  } catch (e) {
    if (existsSync(backup) && !existsSync(dest)) renameSync(backup, dest); // roll back — the working engine is restored
    throw e;
  }
  rmtree(backup);
}

/**
 * Ensure llama-server is on disk for the detected hardware; return its path.
 *
 * ATOMIC + VERIFIED (2026-07-21): the download + unpack happen in a STAGING dir, the
 * unpacked exe is launch-verified (`_verifyExeLaunches`), and only then is it swapped into
 * the live variant dir (`_swapIntoPlace`). A failed/partial/broken download — or a build
 * missing a runtime DLL — never touches the working engine, and the caller's stale-build
 * sweep runs only AFTER a good build is in place. Since 2026-09-19 the staged exe must also
 * ACCEPT the launch flags this app emits (`probeArgvs` → `_verifyExeAcceptsFlags`) —
 * upstream removes flags. Idempotent unless `force` (an update / reinstall re-fetches even
 * when a variant is already present).
 *
 * Downloads the github asset (`.zip`/`.tar.gz`) into the asset's VARIANT dir
 * (`<build>/<gpu>/` — variants coexist for the A3 spawn fallback chain; a pre-variant install
 * at the build root still satisfies the SELECTED asset); a `runtimeUrl` companion (the
 * Windows CUDA cudart DLLs) is unpacked into the SAME dir. `gpu` overrides selection to
 * install a SPECIFIC variant. Docker sources throw (never auto-selected — see `selectBinary`).
 */
export async function acquireBinary(
  cacheRoot,
  config,
  hardware,
  { onProgress = null, cancelCheck = null, gpu = null, force = false, probeArgvs = null } = {},
) {
  let asset;
  if (gpu == null) {
    asset = selectBinary(config, hardware);
  } else {
    asset = (config.llamacpp.binaries || []).find((b) => b.platform === hardware.platform && b.gpu === gpu) ?? null;
  }
  if (asset === null) {
    throw new RuntimeError(`no llama.cpp binary configured for platform=${hardware.platform}${gpu ? ` gpu=${gpu}` : ""}`);
  }

  const selected = selectBinary(config, hardware);
  if (!force) {
    const existing = _findVariantExe(cacheRoot, config, asset, {
      legacyRoot: selected !== null && asset.gpu === selected.gpu,
    });
    if (existing !== null) return existing;
  }
  const dest = variantDir(cacheRoot, config.llamacpp.pinnedBuild, asset.gpu);

  if (asset.source === "docker" || !asset.assetUrl) {
    throw new NotImplementedError(
      `binary source '${asset.source}' for ${asset.platform}/${asset.gpu} is not ` +
        "installable: upstream publishes no pin-faithful container image for the " +
        "pinned build (rolling tags only — they track master and would break the " +
        "build pin). Linux NVIDIA boxes use the pinned Vulkan build automatically; " +
        "the container route returns when a digest-pinned image is captured at a " +
        "pin bump.",
    );
  }

  return self._stageAndSwap(asset, dest, hardware.platform, download.downloadKwargs(config), {
    onProgress,
    cancelCheck,
    probeArgvs,
    label: "llama.cpp",
  });
}

/**
 * Download `asset` (+ its `runtimeUrl` companion) into a staging dir beside `dest`,
 * launch-verify the exe, then atomically swap it into `dest` — the install core every native
 * runtime shares (llama.cpp, audio.cpp). A failed or partial download, a missing runtime DLL
 * or a rejected launch flag leaves `dest` exactly as it was.
 */
export async function _stageAndSwap(
  asset,
  dest,
  platform,
  dlKwargs,
  { onProgress = null, cancelCheck = null, probeArgvs = null, label = "runtime", dropFiles = null } = {},
) {
  // STAGE: download + unpack into a sibling temp dir, never the live variant — the working
  // engine stays intact until a verified build is ready to swap in. Clear a crashed run's
  // leftover staging first.
  const staging = path.join(path.dirname(dest), `.staging-${asset.gpu}`);
  rmtree(staging);
  mkdirSync(staging, { recursive: true });
  // The archives download OUTSIDE staging, under a name of their own, so a cancelled or
  // broken download resumes on the next attempt (the downloader keeps its `.part` and chunk
  // map beside it). Staging used to hold them and was wiped at the start of every attempt,
  // so a 2 GB CUDA download began again from zero (JustVoice audit 2026-10-04 §5 E6).
  const downloads = path.join(path.dirname(dest), ".downloads");
  mkdirSync(downloads, { recursive: true });
  const fetched = [];

  const fetchOne = async (url, sha256) => {
    // GUARD: a stored URL still carrying a `{…}` placeholder never composes to a real asset
    // — it 404s N times then fails (seen in the wild: a legacy `{build}` row). The URL is
    // meant to be the CONCRETE download (the pin drives it); refuse it up front.
    if (url.includes("{") || url.includes("}")) {
      throw new RuntimeError(
        `engine asset URL has an unresolved placeholder: ${url} — re-save the engine ` +
          "binary rows so the URL is concrete (the pinned build drives it)",
      );
    }
    const trimmed = url.replace(/\/+$/, "");
    const archive = path.join(downloads, trimmed.slice(trimmed.lastIndexOf("/") + 1));
    log.info(`downloading ${label} ${asset.platform}/${asset.gpu} from ${url}`);
    // ONE downloader, ONE config — the same chunk-queue download the models use.
    await download.streamDownload(url, archive, { onProgress, cancelCheck, ...dlKwargs });
    if (sha256) {
      const got = await self._fileSha256(archive);
      if (got.toLowerCase() !== sha256.toLowerCase()) {
        unlinkMissingOk(archive);
        throw new RuntimeError(
          `${path.basename(archive)} does not match its published checksum (${got.slice(0, 12)}… ≠ ${sha256.slice(0, 12)}…) — refusing it`,
        );
      }
    }
    try {
      await self._unpack(archive, staging);
    } catch (e) {
      unlinkMissingOk(archive); // a broken archive is never resumed into
      throw e;
    }
    fetched.push(archive);
  };

  try {
    // The stored URL is the CONCRETE download for the pinned build; the folder is named for
    // that same pin. The server does NOT compose a URL — it fetches what is stored.
    await fetchOne(asset.assetUrl, asset.sha256);
    // CUDA builds ship the cudart runtime DLLs separately — unpack alongside the exe.
    if (asset.runtimeUrl) await fetchOne(asset.runtimeUrl, asset.runtimeSha256);

    // Files the app never runs, left out before the swap (JustVoice: upstream's Python
    // reference scripts — the family keeps no Python, 2026-10-08).
    if (dropFiles) dropUnpacked(staging, dropFiles);
    const exe = _findServerExe(staging, asset.serverExe);
    if (exe === null) throw new RuntimeError(`${asset.serverExe} not found in unpacked archive at ${staging}`);
    if (platform !== "windows") chmodSync(exe, statSync(exe).mode | 0o111);
    await self._verifyExeLaunches(exe, platform); // catches a missing runtime DLL/.so
    await self._verifyExeAcceptsFlags(exe, probeArgvs); // catches a flag upstream removed
    _swapIntoPlace(staging, dest); // atomic — `dest` untouched until here
    for (const archive of fetched) unlinkMissingOk(archive); // installed: the archives have done their job
    try {
      rmdirSync(downloads); // only when empty — another's resume stays
    } catch {}
  } finally {
    // Success renamed staging → dest (this is a no-op); any failure leaves it, so clean it
    // up and let the error propagate with the live engine (`dest`) intact.
    rmtree(staging);
  }

  return _findServerExe(dest, asset.serverExe);
}

/** Delete every file under `root` whose path relative to it (forward slashes) `drop`
 * accepts, then the folders that leaves empty. Returns how many files went. */
export function dropUnpacked(root, drop) {
  let n = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        if (!readdirSync(full).length) rmSync(full, { recursive: true });
      } else if (drop(path.relative(root, full).split(path.sep).join("/"))) {
        unlinkSync(full);
        n += 1;
      }
    }
  };
  walk(root);
  return n;
}

// ─── Any other pinned native runtime (audio.cpp, …) ──────────────────────
//
// llama.cpp's rows live in the runner config and carry its history (legacy build-root
// installs, the docker seam, the router). Another runtime an app ships — JustVoice's
// audio.cpp speech server — needs only the shared core: pick the asset for this box, stage,
// verify, swap. Its rows and pin are the APP's data, passed in; the folder keeps each
// runtime's builds apart under the same cache root.

/** The best of `binaries` for this box, by the same GPU preference llama.cpp uses. */
export function selectRuntimeAsset(binaries, hardware, preferredGpu = "") {
  const rows = byGpu(binaries || [], (b) => b.platform === hardware.platform && b.source !== "docker");
  for (const gpu of _gpuPreference(hardware, preferredGpu)) {
    if (rows.has(gpu)) return rows.get(gpu);
  }
  return null;
}

/** `<cacheRoot>/<folder>/<build>/<gpu>/` — one dir per installed variant. */
export function runtimeVariantDir(cacheRoot, folder, build, gpu) {
  return path.join(cacheRoot, folder, build, gpu);
}

/** The installed exe for `asset` at `build`, or null — never downloads. */
export function installedRuntimeExe(cacheRoot, folder, build, asset) {
  return _findServerExe(runtimeVariantDir(cacheRoot, folder, build, asset.gpu), asset.serverExe);
}

/**
 * Ensure a pinned native runtime is installed for this box; return its exe.
 *
 * The same atomic, verified install as `acquireBinary` (stage → launch-verify → swap), for a
 * runtime whose rows the caller owns. `gpu` installs a specific variant; otherwise the box's
 * preference picks. Idempotent unless `force`. `dropFiles(relPath)` → true leaves that file of
 * the archive out (see `dropUnpacked`).
 */
export async function acquireRuntime(
  cacheRoot,
  folder,
  build,
  binaries,
  hardware,
  {
    preferredGpu = "",
    gpu = null,
    force = false,
    dlKwargs = null,
    onProgress = null,
    cancelCheck = null,
    probeArgvs = null,
    dropFiles = null,
  } = {},
) {
  let asset;
  if (gpu == null) asset = selectRuntimeAsset(binaries, hardware, preferredGpu);
  else asset = (binaries || []).find((b) => b.platform === hardware.platform && b.gpu === gpu) ?? null;
  if (asset === null || !asset.assetUrl) {
    throw new RuntimeError(`no ${folder} build for platform=${hardware.platform}${gpu ? ` gpu=${gpu}` : ""}`);
  }
  if (!force) {
    const existing = installedRuntimeExe(cacheRoot, folder, build, asset);
    if (existing !== null) return existing;
  }
  const dest = runtimeVariantDir(cacheRoot, folder, build, asset.gpu);
  mkdirSync(path.dirname(dest), { recursive: true });
  return self._stageAndSwap(asset, dest, hardware.platform, dlKwargs || {}, {
    onProgress,
    cancelCheck,
    probeArgvs,
    label: folder,
    dropFiles,
  });
}
