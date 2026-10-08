// SPDX-License-Identifier: MIT
// Port of tests/test_binary.py — binary selection + acquisition. HardwareInfo passed
// explicitly (no real detection) and the network mocked, so tests run anywhere.
//
// `monkeypatch.setattr(binmod, "stream_download", …)` → `vi.spyOn(download,
// "streamDownload")` (binary.js calls it through the download module). The fake writes a
// real `.zip` (stored, as zipfile.writestr does) or `.tar.gz` holding the exe, so the
// extractors run for real. Python's OSError is an error carrying a system `code`.
// The parametrized `resolve_release_assets_against_four_real_builds` is one `test.each`
// (one Python def, four cases).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import { beforeEach, expect, test, vi } from "vitest";
import { model } from "../src/platform/models.js";
import * as procs from "../src/platform/procs.js";
import * as binmod from "../src/runner/binary.js";
import { DEFAULT_BINARIES, DEFAULT_PINNED_BUILD, defaultConfig } from "../src/runner/config.js";
import * as download from "../src/runner/download.js";
import { BinaryAsset, GpuInfo, HardwareInfo } from "../src/runner/schema.js";

const { selectBinary } = binmod;

// The real verifiers, captured BEFORE the per-test stubs below replace them: the acquire
// tests unpack a fake 'MZ fake' exe that cannot really run, so they bypass the real
// `<exe> --version` checks; each check's own behaviour is tested directly via these refs.
const REAL_VERIFY = binmod._verifyExeLaunches;
const REAL_ACCEPTS = binmod._verifyExeAcceptsFlags;

beforeEach(() => {
  vi.spyOn(binmod, "_verifyExeLaunches").mockResolvedValue(undefined);
  vi.spyOn(binmod, "_verifyExeAcceptsFlags").mockResolvedValue(undefined);
});

const tmp = () => mkdtempSync(join(tmpdir(), "kit-bin-"));
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const isRelativeTo = (p, dir) => {
  const rel = path.relative(dir, p);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

function hw(platformName, runtimes, gpus = null) {
  return model(HardwareInfo, {
    os: platformName,
    platform: platformName,
    cpuCores: 8,
    ramMb: 32000,
    gpus: gpus || [],
    runtimes,
  });
}
const gpu = (o) => model(GpuInfo, o);

// ── Archive writers (zipfile.writestr / tarfile.addfile, as the Python fake used) ──

/** A zip of [name, bytes] entries — stored (method 0) unless `deflate`. */
function zipBytes(entries, { deflate = false } = {}) {
  const locals = [];
  const cds = [];
  let off = 0;
  for (const [name, raw] of entries) {
    const data = Buffer.from(raw);
    const nb = Buffer.from(name, "utf8");
    const body = deflate ? deflateRawSync(data) : data;
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nb.length, 28);
    cd.writeUInt32LE(off, 42);
    locals.push(lh, nb, body);
    cds.push(cd, nb);
    off += 30 + nb.length + body.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** A gzipped ustar archive of [name, bytes, {type, mode, linkname}] members. */
function tarGzBytes(members) {
  const blocks = [];
  for (const [name, raw, opt = {}] of members) {
    const data = Buffer.from(raw);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write(`${(opt.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "ascii");
    h.write("0000000\0", 108, "ascii");
    h.write("0000000\0", 116, "ascii");
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    h.write("00000000000\0", 136, "ascii");
    h.write("        ", 148, "ascii");
    h.write(opt.type ?? "0", 156, "ascii");
    if (opt.linkname) h.write(opt.linkname, 157, 100, "utf8");
    h.write("ustar\0", 257, "ascii");
    h.write("00", 263, "ascii");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/**
 * Fake streamDownload: writes a `.zip` or `.tar.gz` (by dest suffix) containing `exeName`,
 * recording each fetched URL. The DL-2 segment options ride along unused.
 */
function makeStream(calls, exeName) {
  return vi.spyOn(download, "streamDownload").mockImplementation(async (url, dest, opts = {}) => {
    const d = String(dest).toLowerCase();
    if (d.endsWith(".tar.gz") || d.endsWith(".tgz")) writeFileSync(dest, tarGzBytes([[exeName, "MZ fake"]]));
    else writeFileSync(dest, zipBytes([[exeName, "MZ fake"]]));
    calls.push(url);
    opts.onProgress?.(7, 7); // (downloaded, total)
    return "deadbeef";
  });
}

const failingStream = (err) =>
  vi.spyOn(download, "streamDownload").mockImplementation(async () => {
    throw err;
  });

test("select_windows_cuda", () => {
  const m = defaultConfig();
  const h = hw("windows", { cuda: true }, [gpu({ vendor: "NVIDIA", name: "RTX 2070 SUPER", vramMb: 8192 })]);
  const a = selectBinary(m, h);
  expect(a && a.platform === "windows" && a.gpu === "cuda12" && Boolean(a.assetUrl)).toBe(true);
});

test("select_cuda_by_chip", () => {
  // The CUDA build is chosen by the GPU chip (compute capability): Blackwell (sm_120 ->
  // 12.0, datacenter sm_100 -> 10.0) needs 13.x; older cards + an unknown capability use
  // the broad-compat 12.4 build.
  const m = defaultConfig();
  const cap = (c) => [gpu({ vendor: "NVIDIA", name: "gpu", vramMb: 16000, computeCap: c })];
  expect(selectBinary(m, hw("windows", { cuda: true }, cap("12.0"))).gpu).toBe("cuda13");
  expect(selectBinary(m, hw("windows", { cuda: true }, cap("10.0"))).gpu).toBe("cuda13");
  expect(selectBinary(m, hw("windows", { cuda: true }, cap("7.5"))).gpu).toBe("cuda12");
  expect(selectBinary(m, hw("windows", { cuda: true }, cap("8.9"))).gpu).toBe("cuda12");
  expect(selectBinary(m, hw("windows", { cuda: true }, cap(null))).gpu).toBe("cuda12");
});

test("select_windows_no_gpu_selects_nothing", () => {
  // The cpu rows are RETIRED (user, 2026-07-07: "deleet" — a CPU-only box can't run local
  // LLMs at usable speed): no GPU runtime → NO engine offered (null).
  expect(selectBinary(defaultConfig(), hw("windows", {}))).toBeNull();
});

test("select_macos_metal", () => {
  const a = selectBinary(defaultConfig(), hw("macos", { metal: true }));
  expect(a && a.gpu === "metal" && a.serverExe === "llama-server").toBe(true);
});

test("select_linux_cuda_never_picks_docker", () => {
  // A4 (re-scoped): no pin-faithful container exists upstream, so the docker row is never
  // auto-selected. With the vulkan fact recorded selection lands on the REAL pinned vulkan
  // archive; without it, NOTHING. The docker row stays in config as the future seam.
  const m = defaultConfig();
  const a = selectBinary(m, hw("linux", { cuda: true, vulkan: true }));
  expect(a && a.source === "github" && a.gpu === "vulkan").toBe(true);
  expect(selectBinary(m, hw("linux", { cuda: true }))).toBeNull();
  expect(m.llamacpp.binaries.some((b) => b.source === "docker")).toBe(true); // seam kept
});

test("select_cross_platform_rows", () => {
  // Every (platform, gpu) the detector can route to must resolve to a real, fetchable asset
  // — not fall through to null (the "no binary configured" bug).
  const m = defaultConfig();
  const cases = [
    ["windows", { rocm: true }, "rocm"],
    ["windows", { vulkan: true }, "vulkan"],
    ["linux", { rocm: true }, "rocm"],
    ["linux", { vulkan: true }, "vulkan"],
  ];
  for (const [plat, runtimes, want] of cases) {
    const a = selectBinary(m, hw(plat, runtimes));
    expect(a && a.gpu === want && Boolean(a.assetUrl), `${plat}/${want} unresolved`).toBe(true);
  }
});

test("acquire_windows_cuda_downloads_cudart_companion", async () => {
  const root = tmp();
  const m = defaultConfig();
  const h = hw("windows", { cuda: true });
  const calls = [];
  makeStream(calls, "llama-server.exe");
  const exe = await binmod.acquireBinary(root, m, h);
  expect(isFile(exe) && basename(exe) === "llama-server.exe").toBe(true);
  // BOTH the build zip (has the exe) AND the cudart runtime companion are fetched.
  expect(calls.length).toBe(2);
  expect(calls.some((u) => u.includes("cudart"))).toBe(true);
  expect(existsSync(join(binmod.binaryDir(root, m.llamacpp.pinnedBuild), "_download.zip"))).toBe(false);
  // Idempotent — second call returns same path without downloading.
  failingStream(new Error("should not re-download"));
  expect(await binmod.acquireBinary(root, m, h)).toBe(exe);
});

test("acquire_fetches_stored_url_into_pin_folder", async () => {
  // 2026-07-21: URLs are CONCRETE in the DB; the server does NOT compose — acquire fetches
  // exactly the stored assetUrl and unpacks into the pinned build's folder.
  const root = tmp();
  const m = defaultConfig();
  const build = m.llamacpp.pinnedBuild;
  const calls = [];
  makeStream(calls, "llama-server.exe");
  const exe = await binmod.acquireBinary(root, m, hw("windows", { cuda: true }));
  expect(binmod.buildOfExe(root, exe)).toBe(build); // lands in the pin's folder
  expect(calls.length && calls.every((u) => u.includes(`/download/${build}/`))).toBeTruthy();
  expect(calls.some((u) => u.includes("{build}"))).toBe(false); // no template placeholder leaks
});

// ── the ATOMIC + launch-verified install (2026-07-21: the update-brick fix) ────────

test("verify_exe_launches_flags_a_missing_runtime_dll", async () => {
  const exe = "llama-server.exe";
  // exit 0 (or ANY app exit) → the process RAN, its libraries loaded → OK, no throw.
  await REAL_VERIFY(exe, "windows", { run: () => ({ returncode: 0 }) });
  await REAL_VERIFY(exe, "windows", { run: () => ({ returncode: 1 }) });
  await REAL_VERIFY(exe, "linux", { run: () => ({ returncode: 2 }) });
  // a Windows loader failure — 0xC0000135 (3221225781) STATUS_DLL_NOT_FOUND → throws.
  await expect(REAL_VERIFY(exe, "windows", { run: () => ({ returncode: 3221225781 }) })).rejects.toThrow(
    /runtime library is missing/,
  );
  // a Unix missing-.so (exit 127) → throws.
  await expect(REAL_VERIFY(exe, "linux", { run: () => ({ returncode: 127 }) })).rejects.toThrow(/runtime library is missing/);
  // the OS can't start the image at all → throws.
  const boom = () => {
    throw Object.assign(new Error("not a valid Win32 application"), { code: "UNKNOWN" });
  };
  await expect(REAL_VERIFY(exe, "windows", { run: boom })).rejects.toThrow(/could not start/);
});

test("verify_exe_accepts_flags_names_the_rejected_flag", async () => {
  // 2026-09-19: llama.cpp b10875 DELETED --mlock/--no-mmap. Such a build PASSES the
  // `--version` check, so this second check keeps it from replacing a working engine.
  const rejects = () => ({ returncode: 1, stdout: Buffer.from(""), stderr: Buffer.from("error: invalid argument: --no-mmap\n") });
  const p = REAL_ACCEPTS("llama-server.exe", [["--no-mmap", "--version"]], { run: rejects });
  await expect(p).rejects.toThrow(/--no-mmap/);
  await expect(p).rejects.toThrow(/left in place/); // the message says the engine was NOT replaced
});

test("verify_exe_accepts_flags_passes_on_zero_and_on_no_probes", async () => {
  const exe = "llama-server.exe";
  const seen = [];
  const ok = (argv) => {
    seen.push(argv);
    return { returncode: 0, stdout: Buffer.from("version: 0.1.0-dev\n"), stderr: Buffer.from("") };
  };
  await REAL_ACCEPTS(exe, [["--load-mode", "none", "--version"], ["--version"]], { run: ok });
  expect(seen.length).toBe(2); // every probe is run, not just the first
  await REAL_ACCEPTS(exe, null, { run: ok }); // nothing to check → no-op, no throw
  await REAL_ACCEPTS(exe, [], { run: ok });
  expect(seen.length).toBe(2);
  const hangs = () => {
    throw new procs.TimeoutExpired("x", 60);
  };
  await expect(REAL_ACCEPTS(exe, [["--version"]], { run: hangs })).rejects.toThrow(/could not run the flag check/);
});

/** A pre-existing, complete engine variant on disk — the 'working engine'. */
function seedWorkingEngine(root, m, g = "cuda12") {
  const d = binmod.variantDir(root, m.llamacpp.pinnedBuild, g);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "llama-server.exe"), "GOOD-OLD-ENGINE");
  return d;
}

function noStagingLitter(root, m) {
  const bd = binmod.binaryDir(root, m.llamacpp.pinnedBuild);
  return !readdirSync(bd).some((n) => n.startsWith(".staging-") || n.startsWith(".old-"));
}

test("acquire_atomic_a_failed_download_leaves_the_working_engine", async () => {
  // THE BRICK THIS FIXES: a force re-download that FAILS must NOT wipe the working engine.
  const root = tmp();
  const m = defaultConfig();
  const good = seedWorkingEngine(root, m);
  failingStream(new Error("network died mid-download"));
  await expect(binmod.acquireBinary(root, m, hw("windows", { cuda: true }), { force: true })).rejects.toThrow(/network died/);
  expect(readFileSync(join(good, "llama-server.exe"), "utf8")).toBe("GOOD-OLD-ENGINE"); // untouched
  expect(noStagingLitter(root, m)).toBe(true);
});

test("acquire_atomic_a_build_that_fails_launch_is_discarded", async () => {
  // A downloaded build whose exe won't launch (missing DLL) is discarded; the old one stays.
  const root = tmp();
  const m = defaultConfig();
  const good = seedWorkingEngine(root, m);
  makeStream([], "llama-server.exe");
  vi.spyOn(binmod, "_verifyExeLaunches").mockRejectedValue(new Error("a required runtime library is missing"));
  await expect(binmod.acquireBinary(root, m, hw("windows", { cuda: true }), { force: true })).rejects.toThrow(
    /runtime library is missing/,
  );
  expect(readFileSync(join(good, "llama-server.exe"), "utf8")).toBe("GOOD-OLD-ENGINE");
  expect(noStagingLitter(root, m)).toBe(true);
});

test("acquire_discards_a_build_that_rejects_our_flags", async () => {
  // The b10875 class, end to end: the download and the launch check both SUCCEED, and the
  // build is still discarded because it refuses a flag this app puts on every model.
  const root = tmp();
  const m = defaultConfig();
  const good = seedWorkingEngine(root, m);
  makeStream([], "llama-server.exe");
  vi.spyOn(binmod, "_verifyExeAcceptsFlags").mockRejectedValue(
    new Error(
      "this engine build does not accept a launch flag this app uses (error: invalid argument: --no-mmap) — the installed engine was left in place",
    ),
  );
  await expect(
    binmod.acquireBinary(root, m, hw("windows", { cuda: true }), { force: true, probeArgvs: [["--no-mmap", "--version"]] }),
  ).rejects.toThrow(/does not accept a launch flag/);
  expect(readFileSync(join(good, "llama-server.exe"), "utf8")).toBe("GOOD-OLD-ENGINE");
  expect(noStagingLitter(root, m)).toBe(true);
});

test("acquire_force_reinstalls_and_swaps_even_when_present", async () => {
  // force re-fetches over an existing variant (an update / reinstall) via the staged swap —
  // NOT the idempotent skip — and the fresh build lands in place.
  const root = tmp();
  const m = defaultConfig();
  seedWorkingEngine(root, m);
  const calls = [];
  makeStream(calls, "llama-server.exe");
  const exe = await binmod.acquireBinary(root, m, hw("windows", { cuda: true }), { force: true });
  expect(calls.length).toBeGreaterThan(0); // it DID re-download
  expect(readFileSync(exe, "utf8")).toBe("MZ fake"); // the fresh build swapped in
  expect(binmod.buildOfExe(root, exe)).toBe(m.llamacpp.pinnedBuild);
  expect(noStagingLitter(root, m)).toBe(true);
});

test("acquire_refuses_a_placeholder_url", async () => {
  // A stored URL still carrying a `{…}` placeholder (a legacy row) 404s N times then fails.
  // The fetch refuses it up front; streamDownload is stubbed to blow up so we prove the
  // guard fires BEFORE any network call.
  const root = tmp();
  const m = defaultConfig();
  const h = hw("windows", { cuda: true });
  const asset = selectBinary(m, h); // same object that lives in m.llamacpp.binaries
  asset.assetUrl =
    "https://github.com/ggml-org/llama.cpp/releases/download/{build}/llama-{build}-bin-win-cuda-12.4-x64.zip";
  failingStream(new Error("streamDownload must not be called for a placeholder URL"));
  await expect(binmod.acquireBinary(root, m, h)).rejects.toThrow(/unresolved placeholder/);
});

test("acquire_tar_gz_macos", async () => {
  // macOS/Linux assets are .tar.gz — _unpack must handle them (was zip-only).
  const root = tmp();
  const m = defaultConfig();
  const calls = [];
  makeStream(calls, "llama-server");
  const exe = await binmod.acquireBinary(root, m, hw("macos", { metal: true }));
  expect(isFile(exe) && basename(exe) === "llama-server").toBe(true);
  expect(calls.length).toBe(1); // metal has no runtime companion
  const dest = binmod.binaryDir(root, m.llamacpp.pinnedBuild);
  expect(readdirSync(dest).filter((n) => n.startsWith("_download"))).toEqual([]); // temp archive cleaned up
});

test("extract_tar_gz_closes_the_archive", async () => {
  // Stopping at the end marker must still close the archive (it stayed open for the life of
  // the process — found by JustVoice's dictionary install, 2026-10-08). Random bytes after
  // the marker keep the read stream mid-file when the extractor stops.
  const openFds = () => {
    const open = [];
    for (let fd = 3; fd < 256; fd++) {
      try {
        fstatSync(fd);
        open.push(fd);
      } catch {}
    }
    return open;
  };
  const dir = tmp();
  const archive = join(dir, "a.tar.gz");
  const tar = gunzipSync(tarGzBytes([["f.txt", "hi"]]));
  writeFileSync(archive, gzipSync(Buffer.concat([tar, randomBytes(1 << 20)])));
  const before = openFds();
  await binmod.extractTarGz(archive, join(dir, "out"));
  expect(readFileSync(join(dir, "out", "f.txt"), "utf8")).toBe("hi");
  expect(openFds()).toEqual(before);
});

test("acquire_docker_raises", async () => {
  // Auto-selection never lands on docker anymore (A4) — FORCING the variant via gpu= still
  // explains itself with the truthful pin story.
  await expect(binmod.acquireBinary(tmp(), defaultConfig(), hw("linux", { cuda: true }), { gpu: "cuda12" })).rejects.toThrow(
    binmod.NotImplementedError,
  );
  await expect(binmod.acquireBinary(tmp(), defaultConfig(), hw("linux", { cuda: true }), { gpu: "cuda12" })).rejects.toThrow(
    /pin-faithful/,
  );
});

// ── A3: per-variant layout + the installed-builds probe ───────────────────────

test("acquire_unpacks_into_variant_dir", async () => {
  // New installs land in <build>/<gpu>/ so variants coexist for the spawn chain.
  const root = tmp();
  const m = defaultConfig();
  makeStream([], "llama-server.exe");
  const exe = await binmod.acquireBinary(root, m, hw("windows", { cuda: true }));
  expect(isRelativeTo(exe, binmod.variantDir(root, m.llamacpp.pinnedBuild, "cuda12"))).toBe(true);
});

test("acquire_gpu_override_installs_specific_variant", async () => {
  // The engine install plants fallbacks via gpu=...; each lands in ITS OWN dir.
  const root = tmp();
  const m = defaultConfig();
  const h = hw("windows", { cuda: true });
  makeStream([], "llama-server.exe");
  const exe = await binmod.acquireBinary(root, m, h, { gpu: "vulkan" });
  expect(isRelativeTo(exe, binmod.variantDir(root, m.llamacpp.pinnedBuild, "vulkan"))).toBe(true);
  // and the selected build's probe still reports nothing (vulkan ≠ selected cuda12)
  expect(binmod.acquiredServerExe(root, m, h)).toBeNull();
});

test("acquired_server_exes_orders_and_single_attributes", () => {
  // Legacy pre-variant install at the BUILD ROOT counts ONLY for the selected asset; variant
  // dirs count for their own gpu key; order = _gpuPreference. A leftover on-disk cpu variant
  // is NOT offered to the chain — its config row is gone (user, 2026-07-07).
  const root = tmp();
  const m = defaultConfig();
  const h = hw("windows", { cuda: true, vulkan: true });
  const build = m.llamacpp.pinnedBuild;
  const bd = binmod.binaryDir(root, build);
  mkdirSync(bd, { recursive: true });
  writeFileSync(join(bd, "llama-server.exe"), "MZ legacy"); // legacy root install
  for (const g of ["vulkan", "cpu"]) {
    const d = binmod.variantDir(root, build, g);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "llama-server.exe"), `MZ ${g}`);
  }
  const got = binmod.acquiredServerExes(root, m, h);
  expect(got.map(([g]) => g)).toEqual(["cuda12", "vulkan"]); // preference order; no cpu
  expect(got[0][1]).toBe(join(bd, "llama-server.exe")); // legacy → selected only
  expect(got[1][1]).toBe(join(binmod.variantDir(root, build, "vulkan"), "llama-server.exe"));
});

test("legacy_root_not_attributed_to_unselected_variants", () => {
  // ONE legacy exe must not satisfy every variant — else the chain would "retry" the same
  // broken binary under three names.
  const root = tmp();
  const m = defaultConfig();
  const bd = binmod.binaryDir(root, m.llamacpp.pinnedBuild);
  mkdirSync(bd, { recursive: true });
  writeFileSync(join(bd, "llama-server.exe"), "MZ legacy");
  const got = binmod.acquiredServerExes(root, m, hw("windows", { cuda: true, vulkan: true }));
  expect(got.map(([g]) => g)).toEqual(["cuda12"]);
});

// ── QC-13: the install check follows the DISK (user's box, 2026-07-09) ────────

test("acquired_exe_follows_disk_build_when_pin_reverted", () => {
  // The Update flow installed a newer build, then a DB reset reverted the pin — and the app
  // claimed "Not installed". The user's law: "check the path and if path exe exist assume
  // engine is installed" — the newest on-disk build holding the exe wins when the pinned
  // build's folder doesn't.
  const root = tmp();
  const m = defaultConfig();
  const diskBuild = `b${binmod.buildNum(m.llamacpp.pinnedBuild) + 30}`;
  const d = binmod.variantDir(root, diskBuild, "cuda12");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "llama-server.exe"), "MZ update-installed");
  const exe = binmod.acquiredServerExe(root, m, hw("windows", { cuda: true }));
  expect(exe).toBe(join(d, "llama-server.exe"));
  expect(binmod.buildOfExe(root, exe)).toBe(diskBuild);
});

test("acquired_exe_prefers_pinned_build_when_both_on_disk", () => {
  // The pin stays authoritative when ITS folder holds the exe — disk builds only step in
  // when the pinned folder has nothing.
  const root = tmp();
  const m = defaultConfig();
  const pinned = m.llamacpp.pinnedBuild;
  const newer = `b${binmod.buildNum(pinned) + 30}`;
  for (const build of [pinned, newer]) {
    const d = binmod.variantDir(root, build, "cuda12");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "llama-server.exe"), `MZ ${build}`);
  }
  const exe = binmod.acquiredServerExe(root, m, hw("windows", { cuda: true }));
  expect(binmod.buildOfExe(root, exe)).toBe(pinned);
});

test("acquire_binary_targets_pin_not_disk_build", async () => {
  // The WRITE path stays pin-keyed: a pin-bump Update must download the new build even while
  // the superseded one is still on disk — resolving here would skip the download and the
  // stale-build sweep would then delete the only engine on disk.
  const root = tmp();
  const m = defaultConfig();
  const older = `b${binmod.buildNum(m.llamacpp.pinnedBuild) - 30}`;
  const d = binmod.variantDir(root, older, "cuda12");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "llama-server.exe"), "MZ pre-update");
  makeStream([], "llama-server.exe");
  const exe = await binmod.acquireBinary(root, m, hw("windows", { cuda: true }));
  expect(isRelativeTo(exe, binmod.variantDir(root, m.llamacpp.pinnedBuild, "cuda12"))).toBe(true);
});

// ── Download names come from the RELEASE's own asset list (2026-09-19). Upstream renames
//    these files between builds; substituting the tag into a stored name 404s. ──

function assetsFixture() {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/llamacpp_release_assets.json", import.meta.url)), "utf8"));
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => [k, v.map((n) => ({ name: n, url: "" }))]),
  );
}

/** A DEFAULT_BINARIES row (snake data keys) as a BinaryAsset. */
function asAsset(b) {
  const map = { asset_url: "assetUrl", runtime_url: "runtimeUrl", server_exe: "serverExe", runtime_sha256: "runtimeSha256" };
  return model(BinaryAsset, Object.fromEntries(Object.entries(b).map(([k, v]) => [map[k] ?? k, v])));
}

/** DEFAULT_BINARIES re-pointed at `build` the OLD way (tag substitution) — exactly the stored
 * state an update would start from. */
function rowsFor(build) {
  return DEFAULT_BINARIES.map((b) => {
    const d = { ...b };
    for (const key of ["asset_url", "runtime_url"]) {
      if (d[key]) d[key] = d[key].replaceAll(DEFAULT_PINNED_BUILD, build);
    }
    return asAsset(d);
  });
}

const byKey = (resolved) => Object.fromEntries(resolved.map((r) => [`${r.platform}/${r.gpu}`, r]));

test.each([
  [
    "b9993",
    {
      "windows/cuda12": "llama-b9993-bin-win-cuda-12.4-x64.zip",
      "windows/cuda13": "llama-b9993-bin-win-cuda-13.3-x64.zip",
      "windows/rocm": "llama-b9993-bin-win-hip-radeon-x64.zip",
      "linux/rocm": "llama-b9993-bin-ubuntu-rocm-7.2-x64.tar.gz",
    },
  ],
  [
    "b10437",
    {
      "windows/cuda12": "llama-b10437-bin-win-cuda-12.4-x64.zip",
      "windows/cuda13": "llama-b10437-bin-win-cuda-13.3-x64.zip",
      "windows/rocm": "llama-b10437-bin-win-rocm-7.14-x64.zip",
      "linux/rocm": null, // upstream published NONE for ~180 builds
    },
  ],
  [
    "b10964",
    {
      "windows/cuda12": "llama-b10964-bin-win-cuda-12.4-x64.zip",
      "windows/cuda13": "llama-b10964-bin-win-cuda-13.3-x64.zip",
      "windows/rocm": "llama-b10964-bin-win-rocm-10.0-x64.zip",
      "linux/rocm": "llama-b10964-bin-ubuntu-rocm-10.0-x64.tar.gz",
    },
  ],
  [
    "b11056",
    {
      "windows/cuda12": "llama-b11056-bin-win-cuda-12.4-x64.zip",
      "windows/cuda13": "llama-b11056-bin-win-cuda-13.4-x64.zip", // 13.3 → 13.4
      "windows/rocm": "llama-b11056-bin-win-rocm-10.0-x64.zip",
      "linux/rocm": "llama-b11056-bin-ubuntu-rocm-10.0-x64.tar.gz",
    },
  ],
])("resolve_release_assets_against_four_real_builds[%s]", (build, want) => {
  const got = byKey(binmod.resolveReleaseAssets(build, rowsFor(build), assetsFixture()[build]));
  for (const [key, name] of Object.entries(want)) {
    const row = got[key];
    if (name === null) {
      expect(row.resolved, `${build} ${key}`).toBe(false);
      expect(row.reason.includes(build) && row.reason.includes(key)).toBe(true);
    } else {
      expect(row.resolved, `${build} ${key}`).toBe(true);
      expect(row.assetUrl.endsWith(name), `${build} ${key} ${row.assetUrl}`).toBe(true);
    }
  }
  // the one-name rows resolve at EVERY build
  for (const [key, tail] of [
    ["windows/vulkan", `llama-${build}-bin-win-vulkan-x64.zip`],
    ["macos/metal", `llama-${build}-bin-macos-arm64.tar.gz`],
    ["linux/vulkan", `llama-${build}-bin-ubuntu-vulkan-x64.tar.gz`],
  ]) {
    expect(got[key].resolved === true && got[key].assetUrl.endsWith(tail)).toBe(true);
  }
  // docker is never ours to resolve
  expect(got["linux/cuda12"].resolved).toBeNull();
  // a CUDA asset always keeps a MATCHING cudart companion
  for (const key of ["windows/cuda12", "windows/cuda13"]) {
    const row = got[key];
    if (row.resolved) {
      const i = row.assetUrl.lastIndexOf("-x64.zip");
      const head = i >= 0 ? row.assetUrl.slice(0, i) : row.assetUrl;
      const version = head.slice(head.lastIndexOf("-") + 1);
      expect(row.runtimeUrl.includes(`cuda-${version}-x64.zip`), `${build} ${key}`).toBe(true);
    }
  }
  // an arm64 file never satisfies an x64 row
  expect(got["windows/cuda13"].assetUrl.includes("arm64")).toBe(false);
});

test("resolve_leaves_a_hand_edited_url_alone", () => {
  const rows = rowsFor("b10964");
  const mirror = "https://mirror.example.com/llama/custom-build.zip";
  for (const r of rows) if (r.platform === "windows" && r.gpu === "cuda12") r.assetUrl = mirror;
  const row = byKey(binmod.resolveReleaseAssets("b10964", rows, assetsFixture().b10964))["windows/cuda12"];
  expect(row.resolved).toBeNull();
  expect(row.assetUrl).toBe(mirror);
  expect(row.reason.includes("custom URL")).toBe(true);
});

test("resolve_refuses_an_asset_without_its_runtime", () => {
  // A CUDA build whose cudart companion is missing would unpack, pass --version only if the
  // DLLs happened to be there, and otherwise brick the install — refuse it up front.
  const assets = assetsFixture().b10964.filter((a) => a.name !== "cudart-llama-bin-win-cuda-13.3-x64.zip");
  const got = byKey(binmod.resolveReleaseAssets("b10964", rowsFor("b10964"), assets));
  expect(got["windows/cuda13"].resolved).toBe(false);
  expect(got["windows/cuda13"].reason.includes("runtime companion")).toBe(true);
  expect(got["windows/cuda12"].resolved).toBe(true); // its own companion is intact
});

test("resolve_picks_the_highest_version_when_several_match", () => {
  const assets = [
    { name: "llama-b10964-bin-ubuntu-rocm-7.2-x64.tar.gz", url: "" },
    { name: "llama-b10964-bin-ubuntu-rocm-10.0-x64.tar.gz", url: "" },
  ];
  const got = byKey(binmod.resolveReleaseAssets("b10964", rowsFor("b10964"), assets));
  expect(got["linux/rocm"].assetUrl.endsWith("rocm-10.0-x64.tar.gz")).toBe(true); // 10.0 > 7.2
});

// ─── acquireRuntime: any other pinned native runtime (JustVoice's audio.cpp) ───

function audiocppRows() {
  const base = "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.0";
  return [
    model(BinaryAsset, {
      platform: "windows",
      gpu: "cuda12",
      serverExe: "audiocpp_server.exe",
      assetUrl: `${base}/audio-v0.9.0-bin-windows-x64-cuda12.4.zip`,
      runtimeUrl: `${base}/audio-v0.9.0-cudart-windows-x64-cuda12.4.zip`,
    }),
    model(BinaryAsset, {
      platform: "windows",
      gpu: "vulkan",
      serverExe: "audiocpp_server.exe",
      assetUrl: `${base}/audio-v0.9.0-bin-windows-x64-vulkan.zip`,
    }),
    model(BinaryAsset, {
      platform: "windows",
      gpu: "cpu",
      serverExe: "audiocpp_server.exe",
      assetUrl: `${base}/audio-v0.9.0-bin-windows-x64-cpu.zip`,
    }),
  ];
}

test("acquire_runtime_installs_into_its_own_folder_with_the_companion", async () => {
  const root = tmp();
  const h = hw("windows", { cuda: true }, [gpu({ vendor: "NVIDIA", name: "RTX 2070 SUPER", vramMb: 8192 })]);
  const calls = [];
  makeStream(calls, "audiocpp_server.exe");
  const exe = await binmod.acquireRuntime(root, "audiocpp", "v0.9.0", audiocppRows(), h);
  expect(exe).toBe(join(root, "audiocpp", "v0.9.0", "cuda12", "audiocpp_server.exe"));
  expect(calls.length === 2 && calls.some((u) => u.includes("cudart"))).toBe(true);
  // llama.cpp's folder is untouched — the runtimes never share a dir
  expect(existsSync(join(root, "llamacpp"))).toBe(false);
  failingStream(new Error("should not re-download"));
  expect(await binmod.acquireRuntime(root, "audiocpp", "v0.9.0", audiocppRows(), h)).toBe(exe);
});

test("acquire_runtime_picks_by_gpu_preference_and_honours_an_override", async () => {
  const root = tmp();
  makeStream([], "audiocpp_server.exe");
  const rows = audiocppRows();
  expect(binmod.selectRuntimeAsset(rows, hw("windows", { vulkan: true })).gpu).toBe("vulkan");
  expect(binmod.selectRuntimeAsset(rows, hw("windows", { cuda: true })).gpu).toBe("cuda12");
  const exe = await binmod.acquireRuntime(root, "audiocpp", "v0.9.0", rows, hw("windows", { cuda: true }), { gpu: "cpu" });
  expect(basename(path.dirname(exe))).toBe("cpu");
});

test("acquire_runtime_refuses_a_platform_it_has_no_build_for", async () => {
  await expect(binmod.acquireRuntime(tmp(), "audiocpp", "v0.9.0", audiocppRows(), hw("macos", { metal: true }))).rejects.toThrow(
    /no audiocpp build for platform=macos/,
  );
});

test("acquire_runtime_a_failed_download_leaves_the_installed_runtime", async () => {
  const root = tmp();
  const h = hw("windows", { cuda: true });
  makeStream([], "audiocpp_server.exe");
  const exe = await binmod.acquireRuntime(root, "audiocpp", "v0.9.0", audiocppRows(), h);
  failingStream(new Error("network down"));
  await expect(binmod.acquireRuntime(root, "audiocpp", "v0.9.0", audiocppRows(), h, { force: true })).rejects.toThrow(
    /network down/,
  );
  expect(isFile(exe)).toBe(true); // the working runtime survived
  expect(existsSync(join(path.dirname(path.dirname(exe)), ".staging-cuda12"))).toBe(false);
});

test("build_num_is_strict", () => {
  // `releases/latest` now answers a semver tag. A digit-strip read "v0.4.1" as 41 (silently
  // "you are current" on every box) and would read "v1.10.500" as 110500.
  expect(binmod.buildNum("b9929")).toBe(9929);
  expect(binmod.buildNum(" b10437 ")).toBe(10437);
  for (const bad of ["v0.4.1", "v1.10.500", "v0.2.0", "", "latest", "b12x", "10437", null]) {
    expect(binmod.buildNum(bad), String(bad)).toBe(-1);
  }
});

// ── checksums and resumable runtime downloads (JustVoice audit 2026-10-04 §5 E6) ───────

function runtimeRow(sha = null, runtimeSha = null) {
  return model(BinaryAsset, {
    platform: "windows",
    gpu: "cuda12",
    serverExe: "audiocpp_server.exe",
    assetUrl: "https://example.invalid/rt/audio-bin.zip",
    runtimeUrl: "https://example.invalid/rt/audio-cudart.zip",
    sha256: sha,
    runtimeSha256: runtimeSha,
  });
}

test("runtime_archives_matching_their_checksums_install_and_leave_nothing", async () => {
  const root = tmp();
  const blob = zipBytes([["audiocpp_server.exe", "MZ fake"]]);
  const sha = createHash("sha256").update(blob).digest("hex");
  vi.spyOn(download, "streamDownload").mockImplementation(async (url, dest) => writeFileSync(dest, blob));
  const exe = await binmod.acquireRuntime(root, "audiocpp", "v1", [runtimeRow(sha, sha)], hw("windows", { cuda: true }));
  expect(isFile(exe)).toBe(true);
  expect(existsSync(join(root, "audiocpp", "v1", ".downloads"))).toBe(false);
});

test("a_runtime_archive_that_fails_its_checksum_is_refused_and_deleted", async () => {
  const root = tmp();
  vi.spyOn(download, "streamDownload").mockImplementation(async (url, dest) =>
    writeFileSync(dest, zipBytes([["audiocpp_server.exe", "MZ fake"]])),
  );
  await expect(
    binmod.acquireRuntime(root, "audiocpp", "v1", [runtimeRow("0".repeat(64))], hw("windows", { cuda: true })),
  ).rejects.toThrow(/published checksum/);
  const downloads = join(root, "audiocpp", "v1", ".downloads");
  expect(existsSync(join(downloads, "audio-bin.zip"))).toBe(false);
  expect(existsSync(join(root, "audiocpp", "v1", "cuda12"))).toBe(false);
});

class ConnectionError extends Error {}

test("a_stopped_runtime_download_keeps_its_partial_file_for_the_next_attempt", async () => {
  const root = tmp();
  vi.spyOn(download, "streamDownload").mockImplementation(async (url, dest) => {
    writeFileSync(`${dest}.part`, "half");
    throw new ConnectionError("dropped");
  });
  await expect(binmod.acquireRuntime(root, "audiocpp", "v1", [runtimeRow()], hw("windows", { cuda: true }))).rejects.toThrow(
    ConnectionError,
  );
  // Outside the staging folder, which every attempt wipes — the downloader resumes from it.
  expect(readFileSync(join(root, "audiocpp", "v1", ".downloads", "audio-bin.zip.part"), "utf8")).toBe("half");
});

// ── Not in the Python file: the extractors the port had to write (zipfile / tarfile) ──

test("the zip and tar.gz readers unpack nested, deflated and linked members", async () => {
  const root = tmp();
  const z = join(root, "a.zip");
  writeFileSync(
    z,
    zipBytes(
      [
        ["build/", ""],
        ["build/bin/llama-server.exe", "MZ deflated ".repeat(500)],
        ["../escape.txt", "kept inside"],
      ],
      { deflate: true },
    ),
  );
  await binmod._unpack(z, join(root, "zip-out"));
  expect(readFileSync(join(root, "zip-out", "build", "bin", "llama-server.exe"), "utf8")).toBe("MZ deflated ".repeat(500));
  expect(readFileSync(join(root, "zip-out", "escape.txt"), "utf8")).toBe("kept inside"); // '..' dropped, as zipfile does
  const bad = Buffer.from(readFileSync(z));
  bad[36 + 30 + "build/bin/llama-server.exe".length + 8] ^= 0xff; // corrupt the exe's deflated data
  writeFileSync(join(root, "bad.zip"), bad);
  await expect(binmod._unpack(join(root, "bad.zip"), join(root, "bad-out"))).rejects.toThrow(); // CRC or inflate error

  const t = join(root, "a.tar.gz");
  writeFileSync(
    t,
    tarGzBytes([
      ["bin/", "", { type: "5", mode: 0o755 }],
      ["bin/llama-server", "MZ tar", { mode: 0o755 }],
      ["bin/libx.so.1", "lib"],
      ["bin/libx.so", "", { type: "2", linkname: "libx.so.1" }],
    ]),
  );
  await binmod._unpack(t, join(root, "tar-out"));
  expect(readFileSync(join(root, "tar-out", "bin", "llama-server"), "utf8")).toBe("MZ tar");
  expect(readFileSync(join(root, "tar-out", "bin", "libx.so"), "utf8")).toBe("lib"); // a link, or its copy
  const evil = join(root, "evil.tar.gz");
  writeFileSync(evil, tarGzBytes([["../../evil", "x"]]));
  await expect(binmod._unpack(evil, join(root, "evil-out"))).rejects.toThrow(/outside the destination/);
});
