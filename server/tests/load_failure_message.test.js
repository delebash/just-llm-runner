// SPDX-License-Identifier: MIT
// Port of tests/test_load_failure_message.py — what a failed model load tells the user
// (2026-09-29).
//
// The case: `gemma-4-26b-a4b-qat` could not load its MTP draft even alone, and the message
// opened "Most often the tune left too little VRAM for the draft — raise n_cpu_moe". The real
// cause was 1.6 GB of GPU memory held by speech engines a hard-killed JustVoice server had left
// running. The message now leads with what is MEASURED — other processes holding GPU memory,
// then llama.cpp's own error line — and lists the causes after, unranked.
//
// The fixtures are test_lifecycle's (`_lifecycle_fakes.js`); Python's monkeypatch of
// `lifecycle._other_gpu_holders` → `vi.spyOn(lifecycle, "_otherGpuHolders")`.
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as lifecycle from "../src/runner/lifecycle.js";
import {
  draftCrashLoader,
  fakeHw,
  fakeRouter,
  GEMMA_MTP,
  mtpEntry,
  mtpFit,
  routerView,
  serviceFor,
  tmp,
  useHermeticRunner,
} from "./_lifecycle_fakes.js";

useHermeticRunner();

const WHISPER_PAIR = [
  { pid: 10, name: "python.exe", memMb: 1295, own: false, label: "python.exe · whisper/engine.py" },
  { pid: 11, name: "python.exe", memMb: 286, own: false, label: "python.exe · whisper/engine.py" },
];

const holders = (impl) => vi.spyOn(lifecycle, "_otherGpuHolders").mockImplementation(impl);

/** Drive a draft that crashes solo (and after a restart, if one happens); resolve the error
 * message. `restarts` collects one entry per engine restart. */
async function soloCrashMessage(restarts = null) {
  const t = tmp();
  const startRouter = () => {
    if (restarts != null) restarts.push(1);
    return fakeRouter();
  };
  const holder = {};
  const svc = serviceFor(t, {
    catalog: [GEMMA_MTP],
    routerModels: () => routerView([GEMMA_MTP.id, "failed"]),
    startRouter,
    routerLoad: draftCrashLoader(holder),
    hardwareFn: () => fakeHw(8192),
    sleep: () => {},
  });
  holder.svc = svc;
  svc._router = fakeRouter();
  svc._activeServerExe = join(t, "llama-server");
  const crashLog = join(t, "router.log");
  svc._lastLogPath = crashLog;
  svc._routerLogPath = () => crashLog;
  svc._resident.set(GEMMA_MTP.id, { status: "starting" });
  const err = await svc._routerLoadWithBackoff(mtpEntry(), mtpFit(), join(t, "llama-server"), svc.config()).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  return err.message;
}

test("mtp_failure_names_the_other_gpu_holders_first", async () => {
  holders(() => WHISPER_PAIR);
  const msg = await soloCrashMessage();

  expect(msg).toContain(
    "Other programs are holding 1.5 GB of GPU memory: " +
      "python.exe · whisper/engine.py (pid 10, 1.3 GB), " +
      "python.exe · whisper/engine.py (pid 11, 286 MB). " +
      "Close them, then load the model again.",
  );
  expect(msg).toContain('llama.cpp said: "error loading model: invalid vector subscript"');
  // Measured facts first; the guesses after, and none of them ranked "most often".
  expect(msg.indexOf("Other programs")).toBeLessThan(msg.indexOf("llama.cpp said"));
  expect(msg.indexOf("llama.cpp said")).toBeLessThan(msg.indexOf("n_cpu_moe"));
  expect(msg).not.toContain("Most often");
});

test("mtp_failure_with_nobody_else_on_the_gpu", async () => {
  holders(() => []);
  const msg = await soloCrashMessage();
  expect(msg).not.toContain("Other programs");
  expect(msg).toContain('llama.cpp said: "error loading model: invalid vector subscript"');
  expect(msg).toContain("If nothing else is holding GPU memory");
});

test("a_failing_probe_never_breaks_the_message", async () => {
  holders(() => {
    throw Object.assign(new Error("typeperf missing"), { code: "ENOENT" });
  });
  const msg = await soloCrashMessage();
  expect(msg).toContain("speculative-decoding (MTP) draft");
  expect(msg).not.toContain("Other programs");
});

test("holders_note_lists_four_and_counts_the_rest", async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ pid: i, name: "x.exe", memMb: 300, own: false, label: "x.exe" }));
  holders(() => rows);
  const note = await lifecycle._gpuHoldersNote();
  expect(note.startsWith("Other programs are holding 1.8 GB of GPU memory: ")).toBe(true);
  expect(note.split("(pid ").length - 1).toBe(4);
  expect(note).toContain(" and 2 more.");
});

test("holders_note_is_empty_when_unmeasurable", async () => {
  holders(() => null);
  expect(await lifecycle._gpuHoldersNote()).toBe("");
});

test("engine_error_line_drops_the_log_prefix", () => {
  const tail =
    "I llama_model_load: loading\n" +
    "E llama_model_load: error loading model: invalid vector subscript\n" +
    "E srv load_model: failed to load draft model, '/x/d.gguf'\n";
  expect(lifecycle._engineErrorLine(tail)).toBe("error loading model: invalid vector subscript");
  expect(lifecycle._engineErrorLine("nothing useful here")).toBe("");
});

// ── Before the restart, look (2026-09-30, kit TASKS: user "b go") ────────────
//
// With nothing else loaded, the only retry left was a full engine restart. When another
// program holds the memory — the 2026-09-29 cause — that can't help: the retry failed the same
// way and the restart only added time.

test("other_programs_on_the_gpu_skip_the_restart", async () => {
  holders(() => WHISPER_PAIR);
  const restarts = [];
  const msg = await soloCrashMessage(restarts);
  expect(restarts).toEqual([]);
  expect(msg).toContain("Other programs are holding 1.5 GB of GPU memory");
});

test("nobody_else_on_the_gpu_still_gets_the_one_restart", async () => {
  holders(() => []);
  const restarts = [];
  const msg = await soloCrashMessage(restarts);
  expect(restarts).toEqual([1]);
  expect(msg).toContain("If nothing else is holding GPU memory");
});

test("when_the_gpu_cant_be_read_it_restarts_as_before", async () => {
  holders(() => {
    throw Object.assign(new Error("typeperf missing"), { code: "ENOENT" });
  });
  const restarts = [];
  await soloCrashMessage(restarts);
  expect(restarts).toEqual([1]);
});

test("unmeasurable_is_not_a_holder", async () => {
  holders(() => null);
  const restarts = [];
  await soloCrashMessage(restarts);
  expect(restarts).toEqual([1]);
});
