// SPDX-License-Identifier: MIT
// Port of tests/test_gpu_processes.py — the "Other apps" breakdown: who is holding GPU memory.
//
// Every probe is spied with REAL captured output, so this runs on a box with no GPU. The
// samples were taken from an RTX 2070 SUPER on Windows 2026-08-15 and are trimmed, not
// invented — the parsers are the whole risk here (typeperf emits a wide quoted-CSV header
// plus trailing prose, and the pid lives inside a counter instance name).
//
// The property these tests defend is the counter CHOICE. Windows offers `Dedicated Usage`
// and `Local Usage` per process, and the obvious one is wrong: measured against a deliberate
// 2.0 GB allocation, both named that process at 2,139 MB, but `Dedicated Usage` summed to
// 9,325 MB on a card holding 2,851 MB (it charges a shared surface to every process
// referencing it, so `dwm.exe` alone read 6,671 MB) while `Local Usage` summed to 2,567 MB.
//
// The two `_processLabel` tests: Python skipped them without psutil (`importorskip`) and
// patched `psutil.Process`; here the command line comes from `hardware.processCmdline`
// (the OS), which they spy instead. Row maps are Maps (pid keys).
import { beforeEach, expect, test, vi } from "vitest";
import * as procs from "../src/platform/procs.js";
import * as hw from "../src/runner/hardware.js";

// Two adapters (two luids), one pid appearing on both, trailing typeperf prose.
const TYPEPERF_SAMPLE =
  '"(PDH-CSV 4.0)"' +
  ',"\\\\PC\\GPU Process Memory(pid_1792_luid_0x00000000_0x0000F0A6_phys_0)\\Local Usage"' +
  ',"\\\\PC\\GPU Process Memory(pid_1792_luid_0x00000000_0x0001060A_phys_0)\\Local Usage"' +
  ',"\\\\PC\\GPU Process Memory(pid_17028_luid_0x00000000_0x0000F0A6_phys_0)\\Local Usage"' +
  ',"\\\\PC\\GPU Process Memory(pid_4_luid_0x00000000_0x0000F0A6_phys_0)\\Local Usage"\n' +
  '"08/15/2026 04:54:45.227","6971219968.000000","1048576.000000","6796083200.000000","0.000000"\n' +
  "\n" +
  "Exiting, please wait...                         \n" +
  "The command completed successfully.\n";

const NVIDIA_SAMPLE = "1792, 512\n17028, 6481\n";
// What an NVIDIA card under Windows-WDDM actually prints: process rows, no numbers.
const NVIDIA_WDDM_SAMPLE = "1792, [N/A]\n8124, [N/A]\n";

function windows({ typeperfOut, argvSink = null }) {
  vi.spyOn(hw, "platformKey").mockReturnValue("windows");
  vi.spyOn(hw, "which").mockImplementation((c) => `/x/${c}`);
  vi.spyOn(procs, "run").mockImplementation(async (argv) => {
    if (argvSink !== null) argvSink.push([...argv]);
    return { stdout: typeperfOut };
  });
}

// the `_no_cache` fixture, for every test
beforeEach(() => {
  hw.cache.gpuProcs = null;
});

test("windows_arm_reads_local_usage_not_dedicated", async () => {
  // THE regression guard. `Dedicated Usage` names an individual process correctly but
  // charges shared surfaces to every referencing process, so the column sums past the card.
  // `Local Usage` gave the identical figure for the real consumer and a coherent total. Do
  // not "unify" this with the single-pid probe.
  const seen = [];
  windows({ typeperfOut: TYPEPERF_SAMPLE, argvSink: seen });
  await hw._windowsGpuProcessRows();
  const counter = seen[0].find((a) => a.includes("GPU Process Memory"));
  expect(counter.endsWith("\\Local Usage"), counter).toBe(true);
  expect(counter.includes("Dedicated")).toBe(false);
});

// ── The Windows counter arm ───────────────────────────────────────────────

test("windows_rows_sum_per_pid_across_adapters", async () => {
  // A pid appears once per adapter; the reduction must match the single-pid door so a
  // process's number is the same wherever it is shown.
  windows({ typeperfOut: TYPEPERF_SAMPLE });
  const rows = await hw._windowsGpuProcessRows();
  expect(rows).not.toBeNull();
  // 6971219968 + 1048576 bytes → 6648 + 1 MiB
  expect(rows.get(1792)).toBe(Math.floor(6971219968 / (1024 * 1024)) + 1);
  expect(rows.get(17028)).toBe(Math.floor(6796083200 / (1024 * 1024)));
  // A zero-holding pid is dropped by gpuProcesses, but the row parser keeps it.
  expect(rows.get(4)).toBe(0);
});

test("trailing_prose_does_not_break_the_parse", async () => {
  // typeperf appends unquoted status lines after the CSV. Matching the data row on WIDTH
  // (not position) is what keeps them out.
  windows({ typeperfOut: TYPEPERF_SAMPLE });
  expect((await hw._windowsGpuProcessRows())?.size).toBeGreaterThan(0);
});

test("localized_windows_reads_as_unmeasurable_not_empty", async () => {
  // Localized Windows localizes counter names — typeperf errors and nothing parses. That
  // must be null (unknown), never an empty map (nothing is using the GPU).
  windows({ typeperfOut: "Error: The specified counter path is invalid.\n" });
  expect(await hw._windowsGpuProcessRows()).toBeNull();
});

test("non_windows_declines_the_counter_arm", async () => {
  vi.spyOn(hw, "platformKey").mockReturnValue("linux");
  expect(await hw._windowsGpuProcessRows()).toBeNull();
});

// ── The nvidia-smi arm ────────────────────────────────────────────────────

test("nvidia_rows_parse", async () => {
  vi.spyOn(hw, "which").mockReturnValue("/x/nvidia-smi");
  vi.spyOn(procs, "run").mockResolvedValue({ stdout: NVIDIA_SAMPLE });
  expect(await hw._nvidiaGpuProcessRows()).toEqual(
    new Map([
      [1792, 512],
      [17028, 6481],
    ]),
  );
});

test("nvidia_na_under_wddm_falls_through", async () => {
  // THE reason the Windows arm exists. nvidia-smi lists the processes but prints [N/A] for
  // memory on a consumer WDDM card; returning null is what hands over to the counter arm
  // instead of reporting a GPU with no users.
  vi.spyOn(hw, "which").mockReturnValue("/x/nvidia-smi");
  vi.spyOn(procs, "run").mockResolvedValue({ stdout: NVIDIA_WDDM_SAMPLE });
  expect(await hw._nvidiaGpuProcessRows()).toBeNull();
});

// ── The assembled answer ──────────────────────────────────────────────────

test("windows_answer_is_additive", async () => {
  // true only because the arm reads `Local Usage` — pinned by
  // `windows_arm_reads_local_usage_not_dedicated` above.
  vi.spyOn(hw, "_nvidiaGpuProcessRows").mockResolvedValue(null);
  windows({ typeperfOut: TYPEPERF_SAMPLE });
  vi.spyOn(hw, "_pidNameMap").mockResolvedValue(
    new Map([
      [1792, "dwm.exe"],
      [17028, "llama-server.exe"],
    ]),
  );
  vi.spyOn(hw, "processTreePids").mockImplementation(async (pid) => [pid, 17028]);

  const out = await hw.gpuProcesses({ fresh: true });
  expect(out).not.toBeNull();
  expect(out.source).toBe("windows-counters");
  expect(out.additive).toBe(true);
  expect(out.processes.map((p) => p.name), "biggest first").toEqual(["dwm.exe", "llama-server.exe"]);
  // pid 4 held zero and must not appear.
  expect(out.processes.every((p) => p.pid !== 4)).toBe(true);
  // Our own tree is attributable so the reader can separate it out.
  expect(out.processes.map((p) => p.own)).toEqual([false, true]);
});

test("nvidia_answer_is_additive", async () => {
  vi.spyOn(hw, "which").mockReturnValue("/x/nvidia-smi");
  vi.spyOn(procs, "run").mockResolvedValue({ stdout: NVIDIA_SAMPLE });
  vi.spyOn(hw, "_pidNameMap").mockResolvedValue(new Map());
  vi.spyOn(hw, "processTreePids").mockImplementation(async (pid) => [pid]);

  const out = await hw.gpuProcesses({ fresh: true });
  expect(out.source).toBe("nvidia-smi");
  expect(out.additive).toBe(true);
  // No name available → the UI falls back to the pid, so an empty string here is the
  // contract, not a bug.
  expect(out.processes[0].name).toBe("");
});

test("no_arm_available_is_none_not_empty", async () => {
  // AMD boxes have no per-process arm at all. null means 'cannot know'; an empty list would
  // claim the GPU is idle.
  vi.spyOn(hw, "_nvidiaGpuProcessRows").mockResolvedValue(null);
  vi.spyOn(hw, "_windowsGpuProcessRows").mockResolvedValue(null);
  expect(await hw.gpuProcesses({ fresh: true })).toBeNull();
});

test("result_is_ttl_cached", async () => {
  // The panel can be reopened or double-clicked; two ~1 s probes for one question is
  // exactly what the cache is for.
  let n = 0;
  vi.spyOn(hw, "_nvidiaGpuProcessRows").mockImplementation(async () => {
    n += 1;
    return new Map([[4242, 64]]);
  });
  vi.spyOn(hw, "_pidNameMap").mockResolvedValue(new Map([[4242, "x.exe"]]));
  vi.spyOn(hw, "processTreePids").mockImplementation(async (pid) => [pid]);

  await hw.gpuProcesses({ fresh: true });
  await hw.gpuProcesses();
  await hw.gpuProcesses();
  expect(n).toBe(1);

  await hw.gpuProcesses({ fresh: true });
  expect(n, "fresh: true must bypass the cache").toBe(2);
});

// ── otherGpuHolders: what a failed model load names (2026-09-29) ─────────

test("other_gpu_holders_names_only_others_above_the_floor", async () => {
  // Never this server's own tree (the model that failed to load is in it), never the
  // desktop's small change (`dwm.exe` held 162 MB idle, measured). The two python rows are
  // the 2026-09-29 case: speech engines a hard-killed server had left behind, 1,295 + 286 MB.
  vi.spyOn(hw, "_nvidiaGpuProcessRows").mockResolvedValue(
    new Map([
      [10, 1295],
      [11, 286],
      [12, 162],
      [13, 900],
    ]),
  );
  vi.spyOn(hw, "_pidNameMap").mockResolvedValue(
    new Map([
      [10, "python.exe"],
      [11, "python.exe"],
      [12, "dwm.exe"],
      [13, "llama-server.exe"],
    ]),
  );
  vi.spyOn(hw, "processTreePids").mockImplementation(async (pid) => [pid, 13]);
  vi.spyOn(hw, "_processLabel").mockImplementation((pid, name) => `${name}#${pid}`);

  const rows = await hw.otherGpuHolders();
  expect(rows.map((r) => [r.pid, r.memMb, r.label])).toEqual([
    [10, 1295, "python.exe#10"],
    [11, 286, "python.exe#11"],
  ]);
});

test("other_gpu_holders_unmeasurable_is_none", async () => {
  vi.spyOn(hw, "_nvidiaGpuProcessRows").mockResolvedValue(null);
  vi.spyOn(hw, "_windowsGpuProcessRows").mockResolvedValue(null);
  expect(await hw.otherGpuHolders()).toBeNull();
});

test("process_label_names_the_script", async () => {
  // Two python.exe rows are indistinguishable by name; the script says which is which.
  vi.spyOn(hw, "processCmdline").mockResolvedValue(["C:\\py\\python.exe", "E:\\app\\engines\\whisper\\engine.py", "serve"]);
  expect(await hw._processLabel(5, "python.exe")).toBe("python.exe · whisper/engine.py");
});

test("process_label_falls_back_to_the_name", async () => {
  vi.spyOn(hw, "processCmdline").mockRejectedValue(new Error("no such process (pid=5)"));
  expect(await hw._processLabel(5, "game.exe")).toBe("game.exe");
  expect(await hw._processLabel(5, "")).toBe("pid 5");
});
