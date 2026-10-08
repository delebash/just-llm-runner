// SPDX-License-Identifier: MIT
// Port of tests/test_hardware.py — hardware detection: NVIDIA compute-capability parse (+
// old-driver fallback), the AMD ROCm-first / Vulkan-fallback routing, the sysfs/registry
// AMD-Intel scan (A1: rows with VRAM where the platform exposes it), and the Intel → Vulkan
// routing (A2). Every probe is spied, so it runs on any box with no GPU.
//
// Python's `monkeypatch.setattr(hw.shutil, "which", …)` → `vi.spyOn(hw, "which")`;
// `monkeypatch.setattr(hw.subprocess, "run", …)` → `vi.spyOn(procs, "run")` (the
// no-console door every probe goes through).
//
// `pci_gpus_linux_lspci_name_match` is skipped off Linux, as in Python (it builds a real
// sysfs symlink to a folder named `0000:03:00.0`, which Windows can't even name).
// The two tests that reach `binary._gpuPreference` import binary.js lazily, so the rest of
// this file runs before runner A's download.js (binary.js's import) exists.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { model } from "../src/platform/models.js";
import * as procs from "../src/platform/procs.js";
import * as hw from "../src/runner/hardware.js";
import { GpuInfo, HardwareInfo } from "../src/runner/schema.js";

const gpu = (o) => model(GpuInfo, o);
const hwInfo = (o) => model(HardwareInfo, o);
const tmp = () => mkdtempSync(join(tmpdir(), "kit-hw-"));
const ran = (stdout) => vi.spyOn(procs, "run").mockResolvedValue({ stdout });

beforeEach(() => {
  hw.cache.used = null;
  hw.cache.gpuProcs = null;
});

test("nvidia_gpus_parses_compute_cap", async () => {
  vi.spyOn(hw, "which").mockImplementation((c) => (c === "nvidia-smi" ? "/x/nvidia-smi" : null));
  vi.spyOn(hw, "_nvidiaQuery").mockImplementation(async (fields) =>
    fields.includes("compute_cap") ? "RTX 5090, 32607, 580.00, 12.0\n" : null,
  );
  const gpus = await hw._nvidiaGpus();
  expect(gpus.length).toBe(1);
  expect(gpus[0].computeCap).toBe("12.0");
  expect(gpus[0].vramMb).toBe(32607);
  expect(gpus[0].driver).toBe("580.00");
});

test("nvidia_gpus_old_driver_fallback", async () => {
  // compute_cap query fails (old driver) → fall back to the 3-field query, keep the GPU
  // (don't lose it), computeCap stays null.
  vi.spyOn(hw, "which").mockImplementation((c) => (c === "nvidia-smi" ? "/x/nvidia-smi" : null));
  vi.spyOn(hw, "_nvidiaQuery").mockImplementation(async (fields) =>
    fields.includes("compute_cap") ? null : "RTX 2070, 8192, 550.00\n",
  );
  const gpus = await hw._nvidiaGpus();
  expect(gpus.length).toBe(1);
  expect(gpus[0].computeCap).toBeNull();
  expect(gpus[0].vramMb).toBe(8192);
});

function noNvidia(plat = "linux", scan = null) {
  vi.spyOn(hw, "_nvidiaGpus").mockResolvedValue([]);
  vi.spyOn(hw, "which").mockReturnValue(null);
  vi.spyOn(hw, "platformKey").mockReturnValue(plat);
  vi.spyOn(hw, "_gpuScan").mockImplementation(async () => [...(scan || [])]);
}

test("detect_amd_rocm_first", async () => {
  // Legacy presence-sniff arm (empty scan). Both capability FACTS are recorded (the A3
  // chain needs the truthful vulkan candidate); SELECTION still prefers rocm —
  // _gpuPreference orders it first (the 2026-07-01 preference decision).
  const { _gpuPreference } = await import("../src/runner/binary.js");
  noNvidia();
  vi.spyOn(hw, "_amdGpuPresent").mockResolvedValue(true);
  vi.spyOn(hw, "_rocmAvailable").mockReturnValue(true);
  vi.spyOn(hw, "_vulkanAvailable").mockReturnValue(true);
  const info = await hw.detect();
  expect(info.runtimes.rocm).toBe(true);
  expect(info.runtimes.vulkan).toBe(true); // a fact of the box, not a selection
  expect("cuda" in info.runtimes).toBe(false);
  expect(_gpuPreference(info)).toEqual(["rocm", "vulkan", "cpu"]); // ROCm still wins selection
});

test("detect_amd_vulkan_fallback", async () => {
  noNvidia();
  vi.spyOn(hw, "_amdGpuPresent").mockResolvedValue(true);
  vi.spyOn(hw, "_rocmAvailable").mockReturnValue(false);
  vi.spyOn(hw, "_vulkanAvailable").mockReturnValue(true);
  const info = await hw.detect();
  expect(info.runtimes.vulkan).toBe(true);
  expect("rocm" in info.runtimes).toBe(false);
});

test("detect_cpu_only", async () => {
  noNvidia();
  vi.spyOn(hw, "_amdGpuPresent").mockResolvedValue(false);
  const info = await hw.detect();
  expect(Object.values(info.runtimes).some(Boolean)).toBe(false);
});

// ── A1: the sysfs scan builds real AMD/Intel rows ──────────────────────────────

/** A /sys/class/drm-shaped tree: {name: [vendorHex|null, vramBytes|null]}. */
function fakeSysfs(base, entries) {
  const root = join(base, "drm");
  for (const [name, [vendor, vram]] of Object.entries(entries)) {
    const dev = join(root, name, "device");
    mkdirSync(dev, { recursive: true });
    if (vendor != null) writeFileSync(join(dev, "vendor"), `${vendor}\n`);
    if (vram != null) writeFileSync(join(dev, "mem_info_vram_total"), `${vram}\n`);
  }
  return root;
}

test("pci_gpus_linux_rows", async () => {
  vi.spyOn(hw, "_lspciNames").mockResolvedValue(new Map());
  const root = fakeSysfs(tmp(), {
    card0: ["0x1002", 16 * 1024 ** 3], // AMD, 16 GiB
    card1: ["0x8086", null], // Intel — no stable VRAM ABI on Linux
    card2: ["0x10de", 8 * 1024 ** 3], // NVIDIA — skipped (nvidia-smi authority)
    renderD128: ["0x1002", null], // render node — skipped by name
  });
  mkdirSync(join(root, "card0-DP-1")); // connector node — skipped by name
  const gpus = await hw._pciGpusLinux(root);
  expect(gpus.map((g) => [g.vendor, g.vramMb])).toEqual([
    ["AMD", 16384],
    ["Intel", null],
  ]);
  expect(gpus[0].name).toBe("AMD GPU"); // lspci-less fallback
  expect(gpus[1].name).toBe("Intel GPU");
});

test.skipIf(process.platform !== "linux")("pci_gpus_linux_lspci_name_match", async () => {
  // device is a SYMLINK to the PCI node (as in real sysfs); the lspci map is keyed without
  // the domain prefix — the scan must still match the name.
  const base = tmp();
  const root = join(base, "drm");
  const pci = join(base, "pci", "0000:03:00.0");
  mkdirSync(pci, { recursive: true });
  writeFileSync(join(pci, "vendor"), "0x1002\n");
  writeFileSync(join(pci, "mem_info_vram_total"), `${24 * 1024 ** 3}\n`);
  mkdirSync(join(root, "card0"), { recursive: true });
  symlinkSync(pci, join(root, "card0", "device"));
  vi.spyOn(hw, "_lspciNames").mockResolvedValue(new Map([["03:00.0", "Navi 31 [Radeon RX 7900 XTX]"]]));
  const gpus = await hw._pciGpusLinux(root);
  expect(gpus.length).toBe(1);
  expect(gpus[0].name).toBe("Navi 31 [Radeon RX 7900 XTX]");
  expect(gpus[0].vramMb).toBe(24 * 1024);
});

test("qw_to_mb_decodes_qword_and_binary", () => {
  const sixteenGb = 16 * 1024 ** 3;
  expect(hw._qwToMb(sixteenGb)).toBe(16384); // REG_QWORD int
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(sixteenGb));
  expect(hw._qwToMb(le)).toBe(16384); // REG_BINARY
  expect(hw._qwToMb(0)).toBeNull();
  expect(hw._qwToMb("junk")).toBeNull();
});

// ── A1+A2: detect() consumes scanned rows; Intel routes to Vulkan ──────────────

test("detect_amd_scan_row_feeds_gpus_and_machine_key", async () => {
  const row = gpu({ vendor: "AMD", name: "Radeon RX 7900 XTX", vramMb: 24560 });
  noNvidia("linux", [row]);
  vi.spyOn(hw, "_rocmAvailable").mockReturnValue(false);
  vi.spyOn(hw, "_vulkanAvailable").mockReturnValue(true);
  const info = await hw.detect();
  expect(info.runtimes.vulkan).toBe(true);
  expect(info.gpus.map((g) => g.name)).toEqual(["Radeon RX 7900 XTX"]);
  expect(hw.machineKey(info).startsWith("Radeon RX 7900 XTX|24560|")).toBe(true);
});

test("detect_intel_arc_routes_vulkan", async () => {
  const row = gpu({ vendor: "Intel", name: "Intel(R) Arc(TM) A770 Graphics", vramMb: 16384 });
  noNvidia("linux", [row]);
  vi.spyOn(hw, "_amdGpuPresent").mockResolvedValue(false);
  vi.spyOn(hw, "_vulkanAvailable").mockReturnValue(true);
  const info = await hw.detect();
  expect(info.runtimes.vulkan).toBe(true);
  expect("rocm" in info.runtimes).toBe(false);
  expect(info.gpus).toEqual([row]);
});

test("detect_intel_igpu_routes_vulkan", async () => {
  // A2 WIDENED (2026-07-23): ANY Intel GPU + the loader → the Vulkan runtime. The old
  // Arc-name gate left the Core Ultra 7 (registry name plain "Intel(R) Graphics",
  // qwMemorySize absent) CPU/online-only while its Vulkan device served an 18 GB pool.
  const row = gpu({ vendor: "Intel", name: "Intel(R) Graphics", vramMb: null });
  noNvidia("linux", [row]);
  vi.spyOn(hw, "_amdGpuPresent").mockResolvedValue(false);
  vi.spyOn(hw, "_vulkanAvailable").mockReturnValue(true);
  const info = await hw.detect();
  expect(info.runtimes.vulkan).toBe(true);
  expect(info.gpus).toEqual([row]);
});

test("detect_intel_igpu_no_loader_stays_cpu", async () => {
  // The loader still gates: no vulkan-1.dll → no vulkan runtime (the box takes the
  // online-provider path rather than a doomed engine install).
  const row = gpu({ vendor: "Intel", name: "Intel(R) Graphics", vramMb: null });
  noNvidia("linux", [row]);
  vi.spyOn(hw, "_amdGpuPresent").mockResolvedValue(false);
  vi.spyOn(hw, "_vulkanAvailable").mockReturnValue(false);
  const info = await hw.detect();
  expect(Object.values(info.runtimes).some(Boolean)).toBe(false);
});

test("detect_nvidia_records_vulkan_fact", async () => {
  // A4: on an NVIDIA box with a Vulkan loader, BOTH facts are recorded — on Linux the
  // pinned build has no installable CUDA archive, so selection falls to the real pinned
  // vulkan build (docker rows are never auto-selected).
  vi.spyOn(hw, "_nvidiaGpus").mockResolvedValue([gpu({ vendor: "NVIDIA", name: "RTX 4090", vramMb: 24564 })]);
  vi.spyOn(hw, "which").mockImplementation((c) => (c === "nvidia-smi" ? "/x/nvidia-smi" : null));
  vi.spyOn(hw, "platformKey").mockReturnValue("linux");
  vi.spyOn(hw, "_vulkanAvailable").mockReturnValue(true);
  const info = await hw.detect();
  expect(info.runtimes.cuda).toBe(true);
  expect(info.runtimes.vulkan).toBe(true);
});

test("detect_amd_wins_over_intel_arc", async () => {
  const { _gpuPreference } = await import("../src/runner/binary.js");
  const rows = [
    gpu({ vendor: "AMD", name: "Radeon RX 7800 XT", vramMb: 16384 }),
    gpu({ vendor: "Intel", name: "Intel(R) Arc(TM) B580 Graphics", vramMb: 12288 }),
  ];
  noNvidia("linux", rows);
  vi.spyOn(hw, "_rocmAvailable").mockReturnValue(true);
  vi.spyOn(hw, "_vulkanAvailable").mockReturnValue(true);
  const info = await hw.detect();
  // The AMD branch keeps precedence (elif chain): rocm recorded, vulkan too (both are FACTS
  // of the box — the A3 chain needs the truthful vulkan candidate) — and SELECTION still
  // puts rocm first.
  expect(info.runtimes.rocm).toBe(true);
  expect(info.runtimes.vulkan).toBe(true);
  expect(_gpuPreference(info)[0]).toBe("rocm");
});

test("ram_mb_positive_on_every_supported_platform", () => {
  // 2026-07-22: _ram_mb returned 0 on EVERY Windows box for the system's entire life, so
  // the detected class key was vram8|ram0 and the seeded class config never matched the
  // very PC it was measured on. This pins "RAM detection works HERE, wherever here is".
  const ram = hw._ramMb();
  expect(ram, `_ramMb() returned ${ram} — RAM detection is broken on this platform`).toBeGreaterThan(1024);
});

// ── Phase 4 (fit-redesign §11): the per-backend used-memory probe family ─────
// Fixture-pinned parses over DOCUMENTED interfaces. Every arm's null degrades to the
// pre-Phase-4 behavior (true-up keeps the estimate).

test("rocm_used_vram_parse", async () => {
  vi.spyOn(hw, "which").mockImplementation((n) => (n === "rocm-smi" ? "/usr/bin/rocm-smi" : null));
  const csv =
    "device,VRAM Total Memory (B),VRAM Total Used Memory (B)\n" +
    "card0,17163091968,4294967296\n" +
    "card1,17163091968,1073741824\n";
  ran(csv);
  expect(await hw._rocmUsedVramMb()).toBe(Math.floor((4294967296 + 1073741824) / (1024 * 1024)));
  // Junk output → null, never a guess.
  ran("no such counters");
  expect(await hw._rocmUsedVramMb()).toBeNull();
});

test("amd_sysfs_used_vram", () => {
  const base = tmp();
  const dev = join(base, "card0", "device");
  mkdirSync(dev, { recursive: true });
  writeFileSync(join(dev, "mem_info_vram_used"), "2147483648\n"); // 2 GiB
  expect(hw._amdSysfsUsedVramMb(base)).toBe(2048);
  expect(hw._amdSysfsUsedVramMb(join(base, "absent"))).toBeNull();
});

test("windows_gpu_counter_parse", async () => {
  vi.spyOn(hw, "platformKey").mockReturnValue("windows");
  vi.spyOn(hw, "which").mockImplementation((n) => (n === "typeperf" ? "C:/typeperf" : null));
  const out =
    '"(PDH-CSV 4.0)","\\BOX\\GPU Adapter Memory(luid_a)\\Dedicated Usage",' +
    '"\\BOX\\GPU Adapter Memory(luid_b)\\Dedicated Usage"\n' +
    '"08/13/2026 10:00:00.000","1073741824.000000","536870912.000000"\n';
  ran(out);
  expect(await hw._windowsGpuDedicatedUsedMb()).toBe(Math.floor((1073741824 + 536870912) / (1024 * 1024)));
  // The counter set absent (typeperf error text, no sample row) → null.
  ran("Error: no valid counters.\n");
  expect(await hw._windowsGpuDedicatedUsedMb()).toBeNull();
});

test("used_device_mem_routing", async () => {
  // One-pool box → the SYSTEM pool probe (bytes counted once); discrete box → the VRAM
  // arms, first non-null wins, all-null stays null (honest unknown).
  const onePool = hwInfo({
    os: "W",
    platform: "windows",
    cpuCores: 8,
    ramMb: 32768,
    gpus: [gpu({ vendor: "Intel", name: "Iris Xe", vramMb: null })],
    runtimes: { vulkan: true },
  });
  vi.spyOn(hw, "detect").mockResolvedValue(onePool);
  vi.spyOn(hw, "_usedPoolMb").mockResolvedValue(12345);
  expect(await hw.usedDeviceMemMb()).toBe(12345);

  const discrete = hwInfo({
    os: "W",
    platform: "windows",
    cpuCores: 8,
    ramMb: 32768,
    gpus: [gpu({ vendor: "AMD", name: "RX 7600", vramMb: 8192 })],
    runtimes: { vulkan: true },
  });
  vi.spyOn(hw, "detect").mockResolvedValue(discrete);
  vi.spyOn(hw, "usedVramMb").mockResolvedValue(null);
  vi.spyOn(hw, "_rocmUsedVramMb").mockResolvedValue(null);
  vi.spyOn(hw, "_amdSysfsUsedVramMb").mockReturnValue(3000);
  vi.spyOn(hw, "_windowsGpuDedicatedUsedMb").mockResolvedValue(9999);
  expect(await hw.usedDeviceMemMb()).toBe(3000); // first non-null wins
  vi.spyOn(hw, "_amdSysfsUsedVramMb").mockReturnValue(null);
  expect(await hw.usedDeviceMemMb()).toBe(9999);
  vi.spyOn(hw, "_windowsGpuDedicatedUsedMb").mockResolvedValue(null);
  expect(await hw.usedDeviceMemMb()).toBeNull();
});

test("used_pool_probe_live_sanity", async () => {
  // The pool probe on THIS box (any OS): a positive, sane MiB figure — the Windows/Linux
  // arms are pure OS reads, so this is a real live check.
  const used = await hw._usedPoolMb();
  expect(used).not.toBeNull();
  expect(used).toBeGreaterThan(100);
  expect(used).toBeLessThan(4 * 1024 * 1024);
});

// ── Per-process probes (the speech measured true-up, 2026-08-13) ─────────────

test("nvidia_process_mem_parse", async () => {
  vi.spyOn(hw, "which").mockImplementation((n) => (n === "nvidia-smi" ? "/usr/bin/nvidia-smi" : null));
  // Two GPUs → the pid appears twice; a foreign pid and a WDDM "[N/A]" row ride along.
  ran("1234, 900\n5678, 4000\n1234, 300\n1234, [N/A]\n");
  expect(await hw._nvidiaProcessMemMb(1234)).toBe(1200);
  // WDDM: every row for the pid is non-numeric → null (falls through to the counter arm).
  ran("1234, [N/A]\n");
  expect(await hw._nvidiaProcessMemMb(1234)).toBeNull();
  // nvidia-smi absent → null without running anything.
  vi.spyOn(hw, "which").mockReturnValue(null);
  expect(await hw._nvidiaProcessMemMb(1234)).toBeNull();
});

test("windows_gpu_process_counter_parse", async () => {
  vi.spyOn(hw, "platformKey").mockReturnValue("windows");
  vi.spyOn(hw, "which").mockImplementation((n) => (n === "typeperf" ? "C:/typeperf" : null));
  const out =
    '"(PDH-CSV 4.0)","\\\\BOX\\GPU Process Memory(pid_1234_luid_a_phys_0)\\Dedicated Usage",' +
    '"\\\\BOX\\GPU Process Memory(pid_1234_luid_a_phys_1)\\Dedicated Usage"\n' +
    '"08/13/2026 10:00:00.000","1073741824.000000","268435456.000000"\n';
  ran(out);
  expect(await hw._windowsGpuProcessDedicatedMb(1234)).toBe(Math.floor((1073741824 + 268435456) / (1024 * 1024)));
  // Localized/absent counter set → typeperf error text, no sample row → null.
  ran("Error: no valid counters.\n");
  expect(await hw._windowsGpuProcessDedicatedMb(1234)).toBeNull();
  // Not Windows → null without running anything.
  vi.spyOn(hw, "platformKey").mockReturnValue("linux");
  expect(await hw._windowsGpuProcessDedicatedMb(1234)).toBeNull();
});

test("process_device_mem_routing", async () => {
  vi.spyOn(hw, "_nvidiaProcessMemMb").mockResolvedValue(null);
  vi.spyOn(hw, "_windowsGpuProcessDedicatedMb").mockResolvedValue(2222);
  expect(await hw.processDeviceMemMb(42)).toBe(2222);
  vi.spyOn(hw, "_nvidiaProcessMemMb").mockResolvedValue(1111);
  expect(await hw.processDeviceMemMb(42)).toBe(1111); // first non-null wins
  vi.spyOn(hw, "_nvidiaProcessMemMb").mockResolvedValue(null);
  vi.spyOn(hw, "_windowsGpuProcessDedicatedMb").mockResolvedValue(null);
  expect(await hw.processDeviceMemMb(42)).toBeNull();
});

test("process_rss_live_sanity", async () => {
  // Our own pid: a positive, sane MiB figure on any OS (the OS arm).
  const rss = await hw.processRssMb(process.pid);
  expect(rss).not.toBeNull();
  expect(rss).toBeGreaterThan(5);
  expect(rss).toBeLessThan(1024 * 1024);
  // A pid that cannot exist → null, never a throw.
  expect(await hw.processRssMb(2 ** 31 - 7)).toBeNull();
});

test("tree_from_pairs_walk_and_cycle_guard", () => {
  // 1 → 2 → 3 plus an unrelated (9,7); root first, descendants covered.
  expect(
    hw._treeFromPairs(1, [
      [2, 1],
      [3, 2],
      [9, 7],
    ]),
  ).toEqual([1, 2, 3]);
  // Windows pid reuse can fabricate a parent cycle — must terminate.
  expect(
    new Set(
      hw._treeFromPairs(1, [
        [2, 1],
        [1, 2],
      ]),
    ),
  ).toEqual(new Set([1, 2]));
});

test("pid_ppid_pairs_wmic_columns_flip", async () => {
  vi.spyOn(hw, "platformKey").mockReturnValue("windows");
  vi.spyOn(hw, "which").mockImplementation((n) => (n === "wmic" ? "C:/wmic" : null));
  // wmic prints requested columns ALPHABETICALLY: ParentProcessId first.
  ran("ParentProcessId  ProcessId\n4                123\n123              456\n\n");
  expect(await hw._pidPpidPairs()).toEqual([
    [123, 4],
    [456, 123],
  ]);
});

test("pid_ppid_pairs_ps", async () => {
  vi.spyOn(hw, "platformKey").mockReturnValue("linux");
  ran("    1     0\n  456     1\n");
  expect(await hw._pidPpidPairs()).toEqual([
    [1, 0],
    [456, 1],
  ]);
});

test("process_tree_pids_live_includes_self", async () => {
  const pids = await hw.processTreePids(process.pid);
  expect(pids[0]).toBe(process.pid);
});

test("nvidia_procs_mem_sums_across_pid_set", async () => {
  vi.spyOn(hw, "which").mockImplementation((n) => (n === "nvidia-smi" ? "/x/nvidia-smi" : null));
  // Shim (1234) holds nothing; its child (1300) holds the memory on two GPUs.
  ran("1300, 900\n5678, 4000\n1300, 231\n1234, [N/A]\n");
  expect(await hw._nvidiaProcsMemMb(new Set([1234, 1300]))).toBe(1131);
});

test("tree_device_mem_sums_windows_counter_arm", async () => {
  // nvidia arm misses (WDDM); the per-pid counter arm answers for the child only — the
  // shim contributes nothing and must not zero the result.
  vi.spyOn(hw, "processTreePids").mockResolvedValue([1234, 1300]);
  vi.spyOn(hw, "_nvidiaProcsMemMb").mockResolvedValue(null);
  vi.spyOn(hw, "_windowsGpuProcessDedicatedMb").mockImplementation(async (pid) => (pid === 1300 ? 1131 : null));
  expect(await hw.processTreeDeviceMemMb(1234)).toBe(1131);
  vi.spyOn(hw, "_windowsGpuProcessDedicatedMb").mockResolvedValue(null);
  expect(await hw.processTreeDeviceMemMb(1234)).toBeNull();
});

test("tree_rss_sums_shim_and_child", async () => {
  vi.spyOn(hw, "processTreePids").mockResolvedValue([1234, 1300]);
  vi.spyOn(hw, "processRssMb").mockImplementation(async (pid) => ({ 1234: 4, 1300: 509 })[pid]);
  expect(await hw.processTreeRssMb(1234)).toBe(513);
});

test("budget_total_is_arch_aware", () => {
  const dgpu = hwInfo({
    os: "W",
    platform: "windows",
    cpuCores: 8,
    ramMb: 32768,
    gpus: [gpu({ vendor: "NVIDIA", name: "2070S", vramMb: 8192 })],
    runtimes: { cuda: true },
  });
  const igpu = hwInfo({
    os: "W",
    platform: "windows",
    cpuCores: 8,
    ramMb: 16384,
    gpus: [gpu({ vendor: "Intel", name: "Iris Xe", vramMb: null })],
    runtimes: { vulkan: true },
  });
  const mac = hwInfo({ os: "Darwin", platform: "macos", cpuCores: 10, ramMb: 65536, gpus: [], runtimes: { metal: true } });
  expect(hw.budgetTotalMb(dgpu)).toBe(8192); // the card (historical meaning)
  expect(hw.budgetTotalMb(igpu)).toBe(16384); // the pool
  expect(hw.budgetTotalMb(mac)).toBe(65536); // the pool
});

// ── Not in the Python file: the parts the port had to write anew ─────────────

test("the registry scan reads reg.exe's two value listings (Python used winreg)", async () => {
  vi.spyOn(hw, "platformKey").mockReturnValue("windows");
  const K = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
  const descs =
    `\r\n${K}\\0000\r\n    DriverDesc    REG_SZ    NVIDIA GeForce RTX 2070 SUPER\r\n\r\n` +
    `${K}\\0001\r\n    DriverDesc    REG_SZ    AMD Radeon RX 7900 XTX\r\n\r\n` +
    `${K}\\0002\r\n    DriverDesc    REG_SZ    Intel(R) Graphics\r\n\r\n` +
    `${K}\\0002\\Settings\r\n    DriverDesc    REG_SZ    Intel nested\r\n\r\n` +
    "End of search: 4 match(es) found.\r\n";
  const sizes =
    `\r\n${K}\\0001\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x5ff000000\r\n\r\n` +
    `${K}\\0003\r\n    HardwareInformation.qwMemorySize    REG_BINARY    0000000004000000\r\n\r\n`;
  vi.spyOn(procs, "run").mockImplementation(async (argv) => ({
    returncode: 0,
    stdout: argv.includes("DriverDesc") ? descs : sizes,
    stderr: "",
  }));
  const gpus = await hw._registryGpusWindows();
  expect(gpus).toEqual([
    gpu({ vendor: "AMD", name: "AMD Radeon RX 7900 XTX", vramMb: 24560 }),
    gpu({ vendor: "Intel", name: "Intel(R) Graphics", vramMb: null }),
  ]);
  expect(hw._qwToMb(hw._parseRegValues(sizes).get("0003"))).toBe(16384);
});

test("the memo: keys read it synchronously; ensureDetected fills it once", async () => {
  hw.setDetected(null);
  expect(() => hw.currentMachineKey()).toThrow(/ensureDetected/);
  const box = hwInfo({
    os: "Windows",
    platform: "windows",
    cpuCores: 16,
    ramMb: 32683,
    gpus: [gpu({ vendor: "NVIDIA", name: "NVIDIA GeForce RTX 2070 SUPER", vramMb: 8192, computeCap: "7.5" })],
    runtimes: { cuda: true, vulkan: true },
  });
  const spy = vi.spyOn(hw, "detect").mockResolvedValue(box);
  await Promise.all([hw.ensureDetected(), hw.ensureDetected()]);
  await hw.ensureDetected();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(hw.currentMachineKey()).toBe("NVIDIA GeForce RTX 2070 SUPER|8192|16c|31g");
  expect(hw.currentClassKey()).toBe("dgpu-vram8|ram32");
  hw.setDetected(null);
});

test("parseCsv reads like csv.reader (quotes, embedded commas, blank lines)", () => {
  expect(hw.parseCsv('"a","b,c",d\n\n"x""y",z\r\nlast')).toEqual([["a", "b,c", "d"], [], ['x"y', "z"], ["last"]]);
  expect(hw.splitlines("a\r\nb\rc\n")).toEqual(["a", "b", "c"]);
});
