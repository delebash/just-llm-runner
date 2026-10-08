// SPDX-License-Identifier: MIT
// Port of tests/test_runner.py — VRAM-fit, flag composition, and spawn + probe-and-back-off.
// The subprocess and health probe are injected, so this runs anywhere (no GPU, no
// llama-server binary, no model).
//
// Post-A7: there is no runner-manifest. `computeFit` takes the VRAM safety margin directly
// (default), and `composeFlags` renders PURELY from the resolved `Overrides` (the base + type
// (moe|dense) flag defaults arrive in `Overrides`, resolved from the DB `switch_presets` by
// the runner's switches_fn) + the computed fit knobs.
//
// JS shape: the fakes are ChildProcess-shaped (`exitCode` null = running, `kill()`,
// `capturedOutput` = what the pipe path would have read); `monkeypatch(proc_mod.sys,
// "platform")` → `processMod.cfg.platform`; patched module functions → `vi.spyOn(processMod, …)`.
// A pytest parametrized test is one `test.each` with the same name (`name[param]`).
//
// All 69 Python tests are ported (the last two — `switches_to_overrides_routes_unknown_to_extra_flags`,
// lifecycle's `_switchesToOverrides`, and `kv_term_single_source_no_drift`, fit's
// `_slopeOffset` — landed with runner/lifecycle.js).
// JS-only tests at the end (marked) cover what Python had no unit test for: a real child's
// output wiring and a real missing binary, and startRouter.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { model } from "../src/platform/models.js";
import * as fit from "../src/runner/fit.js";
import { GgufMeta } from "../src/runner/gguf.js";
import * as lifecycle from "../src/runner/lifecycle.js";
import * as processMod from "../src/runner/process.js";
import {
  _tailFile,
  _VALUE_FLAGS,
  composeFlags,
  composeRouterArgv,
  computeFit,
  DEFAULT_HOST,
  DEFAULT_PORT,
  emitModelsIni,
  engineNglFlag,
  FitPlan,
  loadModeValue,
  ModelIniEntry,
  Overrides,
  overridesToPairs,
  probeArgvs,
  renderArgv,
  renderIni,
  Runner,
  RunnerStartError,
  startRouter,
  startRunner,
} from "../src/runner/process.js";
import { GpuInfo, HardwareInfo } from "../src/runner/schema.js";

const realPlatform = processMod.cfg.platform;
beforeEach(() => {
  processMod.cfg.platform = realPlatform;
});
afterEach(() => {
  processMod.cfg.platform = realPlatform;
});

const tmp = () => mkdtempSync(join(tmpdir(), "kit-runner-"));
const dictOf = (pairs) => new Map(pairs);
const countOf = (xs, x) => xs.filter((y) => y === x).length;

// layer_bytes = 10 GB / 10 layers = 1 GB/layer → clean fit arithmetic.
const TEN_GB = 10_000_000_000;

function hw(vramMb = null) {
  const gpus = vramMb ? [model(GpuInfo, { vendor: "NVIDIA", name: "test", vramMb })] : [];
  return model(HardwareInfo, {
    os: "Linux",
    platform: "linux",
    cpuCores: 8,
    ramMb: 32000,
    gpus,
    runtimes: vramMb ? { cuda: true } : {},
  });
}

function meta(blockCount = 10, dim = 1000, expertCount = 0) {
  return new GgufMeta({
    architecture: expertCount ? "qwen3moe" : "llama",
    blockCount,
    embeddingLength: dim,
    expertCount,
  });
}

// ── computeFit ────────────────────────────────────────────────────────────────

test("fit_cpu_only_no_gpu", () => {
  const plan = computeFit(meta(), TEN_GB, hw(null));
  expect(plan.nGpuLayers).toBe(0);
  expect(plan.nCpuMoe).toBe(0);
});

test("fit_large_gpu_all_layers", () => {
  const plan = computeFit(meta(10), TEN_GB, hw(24000));
  expect(plan.nGpuLayers).toBe(10); // everything fits
});

test("fit_small_gpu_moe_offloads_rest", () => {
  // 10 GB MoE on an 8 GB GPU, header without expert dims (share unknown → the physics can't
  // credit expert stripping): the Phase 6 joint solve sends ALL experts to RAM and walks
  // layers through the physics — expert offload before layer shed, never the old inverse's
  // both-at-once.
  const plan = computeFit(meta(10, 1000, 128), TEN_GB, hw(8192));
  expect(plan.isMoe).toBe(true);
  expect(plan.nGpuLayers > 0 && plan.nGpuLayers < 10).toBe(true); // partial fit
  expect(plan.nCpuMoe).toBe(10); // every expert layer offloads to CPU
});

test("fit_ncmoe_discounts_the_reservation", () => {
  // The ncmoe-aware reservation (2026-07-24): an ncmoe'd MoE reserves what actually lands on
  // the GPU, not the whole file. Same explicit split with vs without the expert dims in the
  // header — the discounted reservation must be a small fraction; a header without expert
  // dims keeps the exact old (undiscounted) number, and an ncmoe-0 MoE is untouched.
  const ov = new Overrides({ nGpuLayers: 30, nCpuMoe: 21, ctxLen: 4096 });
  const expertMeta = new GgufMeta({
    architecture: "g",
    blockCount: 48,
    embeddingLength: 2048,
    expertCount: 128,
    headCount: 16,
    headCountKv: 4,
    expertFeedForwardLength: 1024,
  });
  const nodimsMeta = new GgufMeta({
    architecture: "g",
    blockCount: 48,
    embeddingLength: 2048,
    expertCount: 128,
    headCount: 16,
    headCountKv: 4,
  });
  const discounted = computeFit(expertMeta, 13_300_000_000, hw(8192), ov);
  const undiscounted = computeFit(nodimsMeta, 13_300_000_000, hw(8192), ov);
  expect(discounted.nGpuLayers).toBe(30);
  expect(undiscounted.nGpuLayers).toBe(30);
  // e > 0.9 and 21/30 layers stripped → the weight term collapses to ~1/3; the old number is
  // the full-file booking (the 20.6-GB class of estimate).
  expect(discounted.vramMb < undiscounted.vramMb * 0.55).toBe(true);
  expect(undiscounted.vramMb > 8000).toBe(true); // the old fiction: far over an 8 GB card
  // ncmoe 0 → byte-identical to the undiscounted estimate (no behavior change).
  const ov0 = new Overrides({ nGpuLayers: 30, nCpuMoe: 0, ctxLen: 4096 });
  expect(computeFit(expertMeta, 13_300_000_000, hw(8192), ov0).vramMb).toBe(
    computeFit(nodimsMeta, 13_300_000_000, hw(8192), ov0).vramMb,
  );
});

test("fit_overrides_win", () => {
  const plan = computeFit(
    meta(40, 1000, 8),
    TEN_GB,
    hw(24000),
    new Overrides({ nGpuLayers: 5, nCpuMoe: 2, ctxLen: 8192 }),
  );
  expect(plan.nGpuLayers).toBe(5);
  expect(plan.nCpuMoe).toBe(2);
  expect(plan.ctxLen).toBe(8192);
});

test("fit_safety_margin_shrinks_budget", () => {
  // A larger margin reserves more VRAM → no more layers fit than a small margin.
  const tight = computeFit(meta(10), TEN_GB, hw(8192), null, { safetyMarginMb: 6000 });
  const loose = computeFit(meta(10), TEN_GB, hw(8192), null, { safetyMarginMb: 512 });
  expect(tight.nGpuLayers <= loose.nGpuLayers).toBe(true);
});

// ── the speculative-decode draft's share of the budget (2026-07-19) ───────────

const ONE_GB = 1_000_000_000; // a Gemma-class external MTP draft file

test("fit_draft_takes_layers_from_the_main_split", () => {
  // llama.cpp fully offloads a `--model-draft` GGUF (we emit no draft-layers flag), so its
  // weights + KV must come off the budget BEFORE the main split — otherwise the draft
  // silently steals layers the fit already promised to the main model.
  const args = [meta(10), TEN_GB, hw(8192)];
  const without = computeFit(...args);
  const withDraft = computeFit(...args, null, { draftMeta: meta(4), draftBytes: ONE_GB });
  expect(withDraft.nGpuLayers > 0 && withDraft.nGpuLayers < without.nGpuLayers).toBe(true);
});

test("fit_reservation_counts_the_draft", () => {
  // fit.vramMb is what the VRAM arbiter reserves. With the split PINNED identical, the only
  // delta is the draft — if it were missing, a co-resident admission would over-book by
  // exactly the draft's size (the #274 co-load defect).
  const args = [meta(10), TEN_GB, hw(24000)];
  const pinned = new Overrides({ nGpuLayers: 4 });
  const bare = computeFit(...args, pinned);
  const withDraft = computeFit(...args, pinned, { draftMeta: meta(4), draftBytes: ONE_GB });
  expect(withDraft.nGpuLayers).toBe(4); // same split…
  expect(bare.nGpuLayers).toBe(4);
  expect(withDraft.vramMb > bare.vramMb).toBe(true); // …more VRAM held
});

test("fit_without_a_draft_is_byte_identical", () => {
  // Regression pin with LITERAL values — a 10 GB MoE on an 8 GB card. Re-pinned three times,
  // each an intended change (2026-08-13 Phase 1 physics booking; Phase 6 joint solve;
  // 2026-09-19 MiB units): 6319 = (6553 − 1517 overhead) ÷ 1.048576 + 1517. Same split.
  // (history: test_runner.py)
  const args = [meta(10, 1000, 128), TEN_GB, hw(8192)];
  const plan = computeFit(...args);
  expect([plan.nGpuLayers, plan.nCpuMoe, plan.ctxLen, plan.vramMb]).toEqual([5, 10, 4096, 6319]);
  // …and a draft SIZE with no draft meta is inert (the meta is what arms the term).
  expect(computeFit(...args, null, { draftBytes: ONE_GB })).toEqual(plan);
});

test("fit_draft_is_a_no_op_on_a_cpu_only_box", () => {
  // No GPU → no VRAM budget to charge, so a declared draft changes nothing (it rides in RAM
  // there, inside the coarse band's error bars — deliberately not modelled).
  const args = [meta(10), TEN_GB, hw(null)];
  expect(computeFit(...args)).toEqual(computeFit(...args, null, { draftMeta: meta(4), draftBytes: ONE_GB }));
});

// ── composeFlags (renders from Overrides + fit knobs; no manifest preset) ─────

test("compose_flags_sets_ngl_and_moe", () => {
  const flags = composeFlags(join(tmp(), "model.gguf"), { nGpuLayers: 20, nCpuMoe: 4, ctxLen: 4096, port: 9999 });
  expect(countOf(flags, "-ngl")).toBe(1);
  expect(flags[flags.indexOf("-ngl") + 1]).toBe("20");
  expect(flags[flags.indexOf("--n-cpu-moe") + 1]).toBe("4");
  expect(flags[flags.indexOf("-m") + 1].endsWith("model.gguf")).toBe(true);
  expect(flags[flags.indexOf("--port") + 1]).toBe("9999");
  expect(flags[flags.indexOf("--ctx-size") + 1]).toBe("4096");
});

test("compose_flags_omits_moe_when_zero", () => {
  const flags = composeFlags(join(tmp(), "m.gguf"), { nGpuLayers: 0, nCpuMoe: 0, ctxLen: 2048 });
  expect(flags).not.toContain("--n-cpu-moe"); // omitted when 0
  expect(flags[flags.indexOf("-ngl") + 1]).toBe("0");
});

test("compose_flags_base_preset_via_overrides", () => {
  // The DB `base` preset reaches the spawn as Overrides → rendered onto empty.
  const flags = composeFlags(join(tmp(), "m.gguf"), {
    nGpuLayers: 10,
    nCpuMoe: 0,
    ctxLen: 2048,
    overrides: new Overrides({ cacheTypeK: "q8_0", cacheTypeV: "q8_0", flashAttn: "on", mlock: true, threads: 8, batchSize: 1024 }),
  });
  expect(countOf(flags, "--cache-type-k")).toBe(1);
  expect(flags[flags.indexOf("--cache-type-k") + 1]).toBe("q8_0");
  expect(flags[flags.indexOf("--cache-type-v") + 1]).toBe("q8_0");
  expect(flags[flags.indexOf("--flash-attn") + 1]).toBe("on");
  expect(flags).toContain("--mlock");
  expect(flags[flags.indexOf("--threads") + 1]).toBe("8");
  expect(flags[flags.indexOf("--batch-size") + 1]).toBe("1024");
});

test("compose_flags_presence_overrides", () => {
  // Presence flags add/remove cleanly (no value-eating).
  const flags = composeFlags(join(tmp(), "m.gguf"), {
    nGpuLayers: 10,
    nCpuMoe: 0,
    ctxLen: 2048,
    overrides: new Overrides({ mlock: false, noMmap: true, noKvOffload: true, contBatching: false }),
  });
  expect(flags).not.toContain("--mlock"); // mlock=false → not present
  expect(flags).toContain("--no-mmap"); // added
  expect(flags).toContain("--no-kv-offload"); // added
  expect(flags).toContain("--no-cont-batching"); // cont-batching disabled
  expect(flags[flags.indexOf("-ngl") + 1]).toBe("10");
});

test("compose_flags_spec_draft_mtp", () => {
  // A user's MTP opt-in arrives as Overrides(specType=draft-mtp) for MTP models (Phase 3).
  const flags = composeFlags(join(tmp(), "m.gguf"), {
    nGpuLayers: 10,
    nCpuMoe: 0,
    ctxLen: 2048,
    overrides: new Overrides({ specType: "draft-mtp", specNMax: 3 }),
  });
  expect(flags[flags.indexOf("--spec-type") + 1]).toBe("draft-mtp");
  expect(flags[flags.indexOf("--spec-draft-n-max") + 1]).toBe("3");
});

test("compose_flags_spec_none_clears", () => {
  // specType="none" (the MoE preset) emits no spec flags.
  const flags = composeFlags(join(tmp(), "m.gguf"), {
    nGpuLayers: 10,
    nCpuMoe: 0,
    ctxLen: 2048,
    overrides: new Overrides({ specType: "none" }),
  });
  expect(flags).not.toContain("--spec-type");
  expect(flags).not.toContain("--spec-draft-n-max");
});

test("compose_flags_spec_ngram", () => {
  const flags = composeFlags(join(tmp(), "m.gguf"), {
    nGpuLayers: 10,
    nCpuMoe: 0,
    ctxLen: 2048,
    overrides: new Overrides({ specType: "ngram-mod", specNMax: 64 }),
  });
  expect(flags[flags.indexOf("--spec-type") + 1]).toBe("ngram-mod");
  expect(flags[flags.indexOf("--spec-ngram-mod-n-max") + 1]).toBe("64");
});

test("switches_to_overrides_routes_unknown_to_extra_flags", () => {
  // Known keys → typed Overrides fields; any other key → a raw passthrough flag in extraFlags
  // (the "new llama.cpp flag, no code" escape the KnobGrid uses).
  const ov = lifecycle._switchesToOverrides({
    n_cpu_moe: "8", // known → typed int field
    flash_attn: "on", // known → typed value field
    "--top-n-sigma": "0.05", // unknown → raw flag + value
    "--some-bool-flag": "", // unknown valueless → just the flag token
  });
  expect(ov.nCpuMoe).toBe(8);
  expect(ov.flashAttn).toBe("on");
  expect(ov.extraFlags).toEqual(["--top-n-sigma", "0.05", "--some-bool-flag"]);
});

test("compose_flags_extra_flags_passthrough", () => {
  // extraFlags reach the spawned argv verbatim (after the typed overrides).
  const flags = composeFlags(join(tmp(), "m.gguf"), {
    nGpuLayers: 10,
    nCpuMoe: 0,
    ctxLen: 2048,
    overrides: new Overrides({ extraFlags: ["--top-n-sigma", "0.05"] }),
  });
  expect(flags[flags.indexOf("--top-n-sigma") + 1]).toBe("0.05");
});

// ── the shared flag intermediate (overridesToPairs → renderArgv / renderIni) ──
// One normalized [flag, value] list feeds BOTH the spawn argv and the router .ini, so they can
// never drift. These pin: the fit knobs + engine flags + presence + inversions; that
// renderArgv of the pairs is exactly the argv prefix composeFlags emits; and the ini rendering
// (`key = value` / `key = true`).

test("overrides_to_pairs_fit_engine_presence_and_inversions", () => {
  const ov = new Overrides({
    flashAttn: "on",
    threads: 8,
    mlock: true,
    noMmap: true,
    contBatching: false,
    contextShift: true,
    specType: "draft-mtp",
    specNMax: 3,
  });
  const d = dictOf(overridesToPairs(ov, { nGpuLayers: 20, nCpuMoe: 4, ctxLen: 4096 }));
  expect(d.get("n-gpu-layers")).toBe("20");
  expect(d.get("n-cpu-moe")).toBe("4");
  expect(d.get("ctx-size")).toBe("4096");
  expect(d.get("flash-attn")).toBe("on");
  expect(d.get("threads")).toBe("8");
  expect(d.has("mlock") && d.get("mlock") === null).toBe(true); // presence flags
  expect(d.has("no-mmap") && d.get("no-mmap") === null).toBe(true);
  expect(d.has("no-cont-batching") && d.get("no-cont-batching") === null).toBe(true); // contBatching=false → the OFF switch
  expect(d.has("context-shift") && d.get("context-shift") === null).toBe(true); // contextShift=true → the ON flag
  expect(d.has("no-context-shift")).toBe(false);
  expect(d.get("spec-type")).toBe("draft-mtp");
  expect(d.get("spec-draft-n-max")).toBe("3");
});

test("overrides_to_pairs_omits_moe_when_zero_and_spec_none_clears", () => {
  const d = dictOf(overridesToPairs(new Overrides({ specType: "none" }), { nGpuLayers: 0, nCpuMoe: 0, ctxLen: 2048 }));
  expect(d.has("n-cpu-moe")).toBe(false); // 0 → omitted
  expect(d.has("spec-type")).toBe(false); // "none" → cleared
  expect(d.get("n-gpu-layers")).toBe("0");
});

test("render_argv_is_exact_argv_prefix_of_compose_flags", () => {
  // The .ini path and the spawn path share ONE renderer: renderArgv(pairs) must be exactly
  // the leading argv composeFlags emits for the same overrides + fit.
  const ov = new Overrides({ flashAttn: "on", cacheTypeK: "q8_0", mlock: true, contBatching: false });
  const argv = renderArgv(overridesToPairs(ov, { nGpuLayers: 10, nCpuMoe: 2, ctxLen: 4096 }));
  const gguf = join(tmp(), "m.gguf");
  const composed = composeFlags(gguf, { nGpuLayers: 10, nCpuMoe: 2, ctxLen: 4096, overrides: ov });
  expect(composed.slice(0, argv.length)).toEqual(argv); // renderArgv output IS the prefix
  expect(composed.slice(argv.length)).toEqual(["-m", gguf, "--host", DEFAULT_HOST, "--port", String(DEFAULT_PORT)]);
});

// ── The LOADING pair's spelling follows the engine build (2026-09-19, plan
//    docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md §3.3). llama.cpp b10875
//    DELETED --mlock/--no-mmap; from b10145 the one --load-mode value says it all. MEASURED on
//    b10437: our emitted `--mlock --no-mmap` pair resolved to `load_mode = none` — no mmap and
//    NO LOCK — because the legacy flags assign, and the last one wins. ──

test("load_mode_value_table", () => {
  expect(loadModeValue(true, null)).toBe("mmap+mlock"); // mlock's PRE-refactor meaning
  expect(loadModeValue(null, true)).toBe("none"); // exactly what --no-mmap set
  expect(loadModeValue(true, true)).toBe("mlock"); // no mmap + lock (non-Windows only)
  expect(loadModeValue(null, null)).toBeNull(); // emit nothing → the engine default
  expect(loadModeValue(false, false)).toBeNull(); // falsey is not "set"
});

test.each(["", "b9993", "b10144"])("overrides_to_pairs_keeps_legacy_flags_below_the_threshold[%s]", (build) => {
  const d = dictOf(
    overridesToPairs(new Overrides({ mlock: true, noMmap: true }), {
      nGpuLayers: null,
      nCpuMoe: null,
      ctxLen: 4096,
      engineBuild: build,
    }),
  );
  expect(d.has("mlock") && d.get("mlock") === null).toBe(true);
  expect(d.has("no-mmap") && d.get("no-mmap") === null).toBe(true);
  expect(d.has("load-mode")).toBe(false);
});

const LOAD_MODE_CASES = [];
for (const [mlock, noMmap, want] of [
  [true, null, "mmap+mlock"],
  [null, true, "none"],
  [true, true, "mlock"],
  [null, null, null],
]) {
  for (const build of ["b10145", "b10437", "b10964", "b11056"]) LOAD_MODE_CASES.push([build, mlock, noMmap, want]);
}

test.each(LOAD_MODE_CASES)("overrides_to_pairs_load_mode_by_engine_build[%s-%s-%s-%s]", (build, mlock, noMmap, want) => {
  const d = dictOf(
    overridesToPairs(new Overrides({ mlock, noMmap }), { nGpuLayers: null, nCpuMoe: null, ctxLen: 4096, engineBuild: build }),
  );
  expect(d.get("load-mode") ?? null).toBe(want);
  expect(d.has("mlock") || d.has("no-mmap")).toBe(false); // the removed flags, never emitted
});

test("emit_models_ini_renders_load_mode_for_new_engines", () => {
  const e = new ModelIniEntry({
    modelId: "m",
    ggufPath: join(tmp(), "m.gguf"),
    nGpuLayers: null,
    nCpuMoe: null,
    ctxLen: 4096,
    overrides: new Overrides({ noMmap: true }),
  });
  expect(emitModelsIni([e], { engineBuild: "b10964" })).toContain("load-mode = none");
  expect(emitModelsIni([e])).toContain("no-mmap = true"); // no build known → legacy, as before
});

test("compose_flags_load_mode_parity", () => {
  // The .ini and the spawn argv share ONE renderer — including this spelling.
  const ov = new Overrides({ mlock: true });
  const argv = renderArgv(overridesToPairs(ov, { nGpuLayers: 10, nCpuMoe: 0, ctxLen: 4096, engineBuild: "b10964" }));
  const composed = composeFlags(join(tmp(), "m.gguf"), {
    nGpuLayers: 10,
    nCpuMoe: 0,
    ctxLen: 4096,
    overrides: ov,
    engineBuild: "b10964",
  });
  expect(composed.slice(0, argv.length)).toEqual(argv);
  expect(argv).toContain("--load-mode");
  expect(argv).toContain("mmap+mlock");
  expect(argv).not.toContain("--mlock");
});

test("probe_argvs_cover_every_emitted_key", () => {
  // The install-time acceptance check is only as good as its coverage: every key
  // overridesToPairs can emit for that build must appear in some probe, and every probe must
  // END with --version (args parse in order; --version exits on sight).
  const fixed = [
    "-ngl", "--n-cpu-moe", "--ctx-size", "--no-kv-offload", "--no-cont-batching",
    "--context-shift", "--no-context-shift", "--spec-type", "--spec-draft-n-max",
    "--spec-ngram-mod-n-max",
  ];
  const valueFlags = _VALUE_FLAGS.map(([, flag]) => flag).filter((f) => f !== "--model-draft"); // a path, not a spelling
  for (const [build, loading] of [
    ["b9993", ["--mlock", "--no-mmap"]],
    ["b10964", ["--load-mode"]],
  ]) {
    const argvs = probeArgvs(build);
    expect(argvs.every((a) => a[a.length - 1] === "--version")).toBe(true);
    const seen = new Set(argvs.flat().filter((tok) => tok.startsWith("-")));
    const missing = [...fixed, ...valueFlags, ...loading].filter((f) => !seen.has(f));
    expect(missing).toEqual([]);
    // and never the spelling the OTHER era uses
    expect(seen.has("--load-mode")).toBe(build === "b10964");
  }
});

test("render_ini_emits_key_value_and_bare_true", () => {
  const ov = new Overrides({ flashAttn: "on", mlock: true, contBatching: false });
  const lines = new Set(renderIni(overridesToPairs(ov, { nGpuLayers: 20, nCpuMoe: 0, ctxLen: 4096 })).split("\n"));
  for (const l of ["n-gpu-layers = 20", "ctx-size = 4096", "flash-attn = on"]) expect(lines.has(l)).toBe(true);
  expect(lines.has("mlock = true")).toBe(true); // presence → `= true`
  expect(lines.has("no-cont-batching = true")).toBe(true);
  expect([...lines].some((line) => line.startsWith("n-cpu-moe"))).toBe(false); // omitted when 0
});

test("overrides_to_pairs_new_flags_render_in_both_paths", () => {
  // model-draft (Gemma-style external MTP) rides the ONE shared pairs list, so the spawn argv
  // and the router .ini get it from the same source. The reasoning-budget flags are RETIRED
  // from the launch profile (U2-T4, 2026-07-14): even set on Overrides they no longer render.
  const msg = "Taking user constraints into account, I will now output the solution.";
  const ov = new Overrides({
    specType: "draft-mtp",
    specNMax: 2,
    modelDraft: "/models/MTP/g-Q4_0-MTP.gguf",
    reasoningBudget: 1024,
    reasoningBudgetMessage: msg,
  });
  const pairs = overridesToPairs(ov, { nGpuLayers: 99, nCpuMoe: 37, ctxLen: 32768 });
  const d = dictOf(pairs);
  expect(d.get("model-draft")).toBe("/models/MTP/g-Q4_0-MTP.gguf");
  expect(d.get("spec-type")).toBe("draft-mtp");
  expect(d.get("spec-draft-n-max")).toBe("2");
  // reasoning-budget + its message RETIRED as launch flags — not emitted even when set.
  expect(d.has("reasoning-budget") || d.has("reasoning-budget-message")).toBe(false);
  const argv = renderArgv(pairs);
  expect(argv[argv.indexOf("--model-draft") + 1]).toBe("/models/MTP/g-Q4_0-MTP.gguf");
  expect(argv).not.toContain("--reasoning-budget");
  expect(argv).not.toContain("--reasoning-budget-message");
  const iniLines = renderIni(pairs).split("\n");
  expect(iniLines.some((line) => line.startsWith("reasoning-budget"))).toBe(false);
});

test("new_flags_absent_when_unset", () => {
  const d = dictOf(overridesToPairs(new Overrides(), { nGpuLayers: 1, nCpuMoe: 0, ctxLen: 2048 }));
  expect(d.has("model-draft")).toBe(false);
  expect(d.has("reasoning-budget") || d.has("reasoning-budget-message")).toBe(false);
});

// ── the EMITTED -ngl (vram-truth plan 2026-09-19 §5) ────────────────────────────
// llama.cpp counts the OUTPUT layer: `-ngl k` = output + the LAST k-1 blocks, so "every block"
// must render as blockCount + 1 (b9993/b10437 llama-model.cpp `i_gpu_start = n_layer_all + 1 -
// n_gpu_layers`). Measured: +5.94 % tok/s on the 26B (§10.4). Partial values were measured
// under today's rendering — unchanged.

test("engine_ngl_flag_renders_full_offload_as_n_plus_one", () => {
  expect(engineNglFlag(30, 30)).toBe(31); // every block → output + 30 blocks
  expect(engineNglFlag(29, 30)).toBe(29); // partial → unchanged (measured that way)
  expect(engineNglFlag(0, 30)).toBe(0); // CPU-only stays CPU-only
  expect(engineNglFlag(null, 30)).toBeNull(); // fit-by-omission: still omitted
  expect(engineNglFlag(30, 0)).toBe(30); // unknown block count → unchanged
});

test("ini_and_argv_render_the_same_full_offload_flag", () => {
  const ini = emitModelsIni([
    new ModelIniEntry({ modelId: "m", ggufPath: "/m.gguf", nGpuLayers: 30, nCpuMoe: 21, ctxLen: 4096, blockCount: 30 }),
  ]);
  expect(ini).toContain("n-gpu-layers = 31");
  const argv = composeFlags(join(tmp(), "m.gguf"), { nGpuLayers: 30, nCpuMoe: 21, ctxLen: 4096, blockCount: 30 });
  expect(argv[argv.indexOf("-ngl") + 1]).toBe("31");
  // No block count (embeds, legacy callers) → the kit's value, verbatim.
  expect(
    emitModelsIni([new ModelIniEntry({ modelId: "e", ggufPath: "/e.gguf", nGpuLayers: 99, nCpuMoe: 0, ctxLen: 2048 })]),
  ).toContain("n-gpu-layers = 99");
});

// ── router mode: emitModelsIni + composeRouterArgv ─────────────────────────────

test("emit_models_ini_chat_and_embed_sections", () => {
  const ini = emitModelsIni([
    new ModelIniEntry({
      modelId: "chat",
      ggufPath: "/m/chat.gguf",
      nGpuLayers: 20,
      nCpuMoe: 4,
      ctxLen: 4096,
      overrides: new Overrides({ flashAttn: "on", mlock: true }),
    }),
    new ModelIniEntry({
      modelId: "embed",
      ggufPath: "/m/embed.gguf",
      nGpuLayers: 99,
      nCpuMoe: 0,
      ctxLen: 2048,
      embeddings: true,
      pooling: "last",
      loadOnStartup: true,
    }),
  ]);
  expect(ini).toContain("[chat]");
  expect(ini).toContain("[embed]");
  expect(ini).toContain("model = /m/chat.gguf");
  expect(ini).toContain("n-gpu-layers = 20");
  expect(ini).toContain("n-cpu-moe = 4");
  expect(ini).toContain("flash-attn = on");
  expect(ini).toContain("mlock = true");
  const embedBlock = ini.split("[embed]")[1];
  // pooling is per-model now (#119): the entry carries it explicitly (here "last" for a
  // decoder-based embed like qwen3), NOT a hardcoded "mean".
  expect(embedBlock).toContain("embeddings = true");
  expect(embedBlock).toContain("pooling = last");
  expect(embedBlock).toContain("load-on-startup = true");
  const chatBlock = ini.split("[chat]")[1].split("[embed]")[0];
  expect(chatBlock).not.toContain("embeddings = true");
  expect(chatBlock).not.toContain("load-on-startup");
});

test("emit_models_ini_omits_pooling_when_unset", () => {
  // pooling="" (the default) → NO `pooling =` line, so llama.cpp reads the GGUF's
  // pooling_type (#119). The runner sets it per-model from the catalog; unset = omit.
  const ini = emitModelsIni([
    new ModelIniEntry({ modelId: "embed", ggufPath: "/m/embed.gguf", nGpuLayers: 99, nCpuMoe: 0, ctxLen: 2048, embeddings: true }),
  ]);
  const embedBlock = ini.split("[embed]")[1];
  expect(embedBlock).toContain("embeddings = true");
  expect(embedBlock).not.toContain("pooling"); // unset → omitted, not forced to mean
});

test("emit_models_ini_renders_extra_flags", () => {
  const ini = emitModelsIni([
    new ModelIniEntry({
      modelId: "m",
      ggufPath: "/m.gguf",
      nGpuLayers: 10,
      nCpuMoe: 0,
      ctxLen: 2048,
      overrides: new Overrides({ extraFlags: ["--top-n-sigma", "0.05", "--some-toggle"] }),
    }),
  ]);
  expect(ini).toContain("top-n-sigma = 0.05"); // value flag parsed
  expect(ini).toContain("some-toggle = true"); // bare toggle → = true
});

test("emit_models_ini_empty_is_empty_string", () => {
  expect(emitModelsIni([])).toBe("");
});

test("compose_router_argv_no_model_flag", () => {
  const argv = composeRouterArgv({
    modelsDir: "/hf",
    modelsPreset: "/x/models.ini",
    modelsMax: 2,
    sleepIdleSeconds: 900,
    port: 8080,
  });
  expect(argv).not.toContain("-m"); // ROUTER mode: no single model
  expect(argv[argv.indexOf("--models-preset") + 1]).toBe("/x/models.ini");
  expect(argv[argv.indexOf("--models-max") + 1]).toBe("2");
  expect(argv[argv.indexOf("--sleep-idle-seconds") + 1]).toBe("900");
  expect(argv[argv.indexOf("--models-dir") + 1]).toBe("/hf");
});

test("compose_router_argv_omits_ttl_when_unset", () => {
  const argv = composeRouterArgv({ modelsDir: "/hf", modelsPreset: "/x.ini" });
  expect(argv).not.toContain("--sleep-idle-seconds"); // null → omitted (upstream default -1 = off)
});

test("overrides_to_pairs_context_shift_false_and_none", () => {
  // The old dual-flag emitted exactly ONE of --context-shift / --no-context-shift when set,
  // and NEITHER when null. Pin both to lock the refactor's equivalence.
  const falsePairs = overridesToPairs(new Overrides({ contextShift: false }), { nGpuLayers: 1, nCpuMoe: 0, ctxLen: 2048 });
  const dFalse = dictOf(falsePairs);
  expect(dFalse.has("no-context-shift") && dFalse.get("no-context-shift") === null).toBe(true);
  expect(dFalse.has("context-shift")).toBe(false);
  const argvFalse = renderArgv(falsePairs);
  expect(argvFalse).toContain("--no-context-shift");
  expect(argvFalse).not.toContain("--context-shift");
  expect(renderIni(falsePairs)).toContain("no-context-shift = true");
  const dNone = dictOf(overridesToPairs(new Overrides(), { nGpuLayers: 1, nCpuMoe: 0, ctxLen: 2048 }));
  expect(dNone.has("context-shift") || dNone.has("no-context-shift")).toBe(false); // null → NEITHER
});

test("overrides_to_pairs_spec_type_without_n_max", () => {
  const d = dictOf(overridesToPairs(new Overrides({ specType: "draft-mtp" }), { nGpuLayers: 1, nCpuMoe: 0, ctxLen: 2048 }));
  expect(d.get("spec-type")).toBe("draft-mtp");
  expect(d.has("spec-draft-n-max") || d.has("spec-ngram-mod-n-max")).toBe(false);
});

test("emit_models_ini_extra_flag_negative_value", () => {
  // A negative-number VALUE must be consumed as the flag's value, not split as a flag.
  const ini = emitModelsIni([
    new ModelIniEntry({
      modelId: "m",
      ggufPath: "/m.gguf",
      nGpuLayers: 1,
      nCpuMoe: 0,
      ctxLen: 2048,
      overrides: new Overrides({ extraFlags: ["--dry-multiplier", "-0.5", "--bare"] }),
    }),
  ]);
  expect(ini).toContain("dry-multiplier = -0.5"); // negative value kept with its flag
  expect(ini).toContain("bare = true"); // trailing bare toggle
  expect(ini).not.toContain("-0.5 = true"); // NOT misparsed as its own flag
});

// ── startRunner (probe + OOM back-off; subprocess injected) ───────────────────

/** A ChildProcess-shaped fake: `exitCode` null = still running; `capturedOutput` is what the
 * pipe path drains. */
class FakeProc {
  constructor(exitCode = null, output = "") {
    this.exitCode = exitCode;
    this.capturedOutput = output;
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

const fitPlan = () => new FitPlan({ nGpuLayers: 20, nCpuMoe: 0, ctxLen: 4096, blockCount: 48, isMoe: true });
const noSleep = () => {};

test("start_runner_healthy_first_try", async () => {
  const spawned = [];
  const popen = (argv) => {
    spawned.push(argv);
    return new FakeProc(null); // alive
  };
  const r = await startRunner("llama-server", "m.gguf", fitPlan(), { _popen: popen, _health: () => true, _sleep: noSleep });
  expect(r).toBeInstanceOf(Runner);
  expect(r.isAlive()).toBe(true);
  expect(r.nGpuLayers).toBe(20);
  expect(spawned.length).toBe(1);
});

test("start_runner_backs_off_on_oom", async () => {
  const procs = [
    new FakeProc(1, "ggml_cuda: CUDA error: out of memory"), // OOM exit
    new FakeProc(null), // then healthy
  ];
  const state = { n: 0 };
  const popen = () => procs[state.n++];
  const r = await startRunner("llama-server", "m.gguf", fitPlan(), {
    backoffStep: 4,
    _popen: popen,
    _health: () => state.n >= 2,
    _sleep: noSleep,
  });
  expect(state.n).toBe(2); // spawned twice
  // Shed direction (fit-redesign §5.7): a MoE OOM raises nCpuMoe first — expert bytes leave
  // the GPU, the layers (attention + KV) STAY.
  expect(r.nGpuLayers).toBe(20); // unchanged
  expect(r.nCpuMoe).toBe(4); // 0 + the back-off step
  expect(procs[0].killed).toBe(true); // first attempt cleaned up
});

test("start_runner_sheds_ngl_once_ncmoe_is_maxed", async () => {
  // A MoE that still OOMs with EVERY expert in RAM finally sheds layers — and a dense model
  // (nothing to raise) sheds layers immediately.
  const plan = new FitPlan({ nGpuLayers: 20, nCpuMoe: 46, ctxLen: 4096, blockCount: 48, isMoe: true });
  const procs = [
    new FakeProc(1, "ggml_cuda: CUDA error: out of memory"), // → ncmoe 46→48
    new FakeProc(1, "ggml_cuda: CUDA error: out of memory"), // maxed → ngl 20→16
    new FakeProc(null),
  ];
  const state = { n: 0 };
  const r = await startRunner("llama-server", "m.gguf", plan, {
    backoffStep: 4,
    _popen: () => procs[state.n++],
    _health: () => state.n >= 3,
    _sleep: noSleep,
  });
  expect([r.nGpuLayers, r.nCpuMoe]).toEqual([16, 48]);
});

test("start_runner_first_attempt_honors_the_plans_ncmoe", async () => {
  // §1.7 hygiene: the old per-attempt `blockCount - ngl` formula silently replaced the
  // computed ncmoe on the very first spawn (fit says 21 → it ran 18).
  const plan = new FitPlan({ nGpuLayers: 30, nCpuMoe: 21, ctxLen: 4096, blockCount: 30, isMoe: true });
  const r = await startRunner("llama-server", "m.gguf", plan, {
    _popen: () => new FakeProc(null),
    _health: () => true,
    _sleep: noSleep,
  });
  expect([r.nGpuLayers, r.nCpuMoe]).toEqual([30, 21]);
});

test("start_runner_raises_on_non_oom", async () => {
  await expect(
    startRunner("llama-server", "m.gguf", fitPlan(), {
      _popen: () => new FakeProc(1, "fatal: model file not found"),
      _health: () => false,
      _sleep: noSleep,
    }),
  ).rejects.toBeInstanceOf(RunnerStartError);
});

// ── spawn diagnostics (log file + exit code + tail) ────────────────────────────

test("tail_file_returns_last_lines", () => {
  const dir = tmp();
  const p = join(dir, "runner.log");
  writeFileSync(p, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
  expect(_tailFile(p, 3).split("\n")).toEqual(["line 97", "line 98", "line 99"]);
  expect(_tailFile(join(dir, "nope.log"))).toBe(""); // missing → empty, not a crash
});

test("start_runner_error_reports_exit_code", async () => {
  // A self-exited llama-server (e.g. a missing DLL on Windows) surfaces its exit code +
  // captured output, not a bare "failed".
  const err = await startRunner("llama-server", "m.gguf", fitPlan(), {
    _popen: () => new FakeProc(3221225781, "error while loading shared libraries"),
    _health: () => false,
    _sleep: noSleep,
  }).catch((e) => e);
  expect(err).toBeInstanceOf(RunnerStartError);
  expect(err.message).toContain("exit 3221225781");
  expect(err.message).toContain("error while loading shared libraries");
});

test("start_runner_hang_reports_still_running", async () => {
  // A hang (never healthy, never exits) reports "still running" — the case the old empty-tail
  // message could not distinguish from a crash.
  const times = [0.0, 0.0, 1000.0][Symbol.iterator](); // deadline calc, first check, then past deadline
  const err = await startRunner("llama-server", "m.gguf", fitPlan(), {
    _popen: () => new FakeProc(null, ""), // alive the whole time
    _health: () => false,
    _sleep: noSleep,
    _now: () => times.next().value,
  }).catch((e) => e);
  expect(err).toBeInstanceOf(RunnerStartError);
  expect(err.message).toContain("still running");
});

test("start_runner_redirects_to_log_and_cites_path", async () => {
  // With logPath set, output goes to that file and the failure cites the log path so the user
  // can open it. (Python checked `stdout=` reached Popen; here: the child's stdio is piped —
  // never an inherited fd — and the seam copies it into the file.)
  const logPath = join(tmp(), "logs", "runner.log");
  const popen = (argv, opts) => {
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    return new FakeProc(1, "");
  };
  const err = await startRunner("llama-server", "m.gguf", fitPlan(), {
    logPath,
    _popen: popen,
    _health: () => false,
    _sleep: noSleep,
  }).catch((e) => e);
  expect(err).toBeInstanceOf(RunnerStartError);
  expect(err.message).toContain(`[log: ${logPath}]`);
  expect(existsSync(logPath)).toBe(true); // startRunner created the dir + the file
});

test("start_runner_backs_off_on_oom_via_log", async () => {
  // On the file path (the one _run_load actually uses), the OOM signal is read from the
  // LOG-FILE tail, not a pipe. The first attempt's child writes an OOM line, which the seam
  // copies into the log → back-off → second attempt healthy.
  const logPath = join(tmp(), "logs", "runner.log");
  const first = new FakeProc(1);
  first.stdout = Readable.from([Buffer.from("ggml_cuda: CUDA error: out of memory")]);
  const procs = [first, new FakeProc(null)]; // OOM exit, then alive
  const state = { n: 0 };
  const r = await startRunner("llama-server", "m.gguf", fitPlan(), {
    backoffStep: 4,
    logPath,
    _popen: () => procs[state.n++],
    _health: () => state.n >= 2,
    _sleep: noSleep,
  });
  expect(state.n).toBe(2); // spawned twice: the log-tail OOM drove the retry
  expect(r.nGpuLayers).toBe(20); // a MoE raises ncmoe first — layers stay
  expect(r.nCpuMoe).toBe(4);
});

// ── 1b fit-by-omission: null fit knobs render nothing; ctx policy stays ours ──

test("overrides_to_pairs_omits_none_fit_knobs", () => {
  // An untuned model emits NO placement flags — the engine's default `--fit` (in-pin since
  // b9870) places tensors; ctx-size is ALWAYS ours to pin.
  const d = dictOf(overridesToPairs(new Overrides(), { nGpuLayers: null, nCpuMoe: null, ctxLen: 8192 }));
  expect(d.has("n-gpu-layers") || d.has("n-cpu-moe")).toBe(false);
  expect(d.get("ctx-size")).toBe("8192");
});

test("overrides_to_pairs_explicit_zero_ngl_still_renders", () => {
  // ngl=0 (explicit CPU-only) is a VALUE, not an omission.
  const d = dictOf(overridesToPairs(new Overrides(), { nGpuLayers: 0, nCpuMoe: null, ctxLen: 4096 }));
  expect(d.get("n-gpu-layers")).toBe("0");
});

test("compute_fit_explicit_flags_follow_overrides", () => {
  const explicit = computeFit(
    meta(30, 1000, 128),
    TEN_GB,
    hw(8192),
    new Overrides({ nGpuLayers: 99, nCpuMoe: 21, ctxLen: 32768 }),
  );
  expect(explicit.nglExplicit && explicit.ncmoeExplicit && explicit.ctxExplicit).toBe(true);
  expect(explicit.ctxLen).toBe(32768);
  const computed = computeFit(meta(30, 1000, 128), TEN_GB, hw(8192));
  expect(computed.nglExplicit || computed.ncmoeExplicit || computed.ctxExplicit).toBe(false);
});

test("computed_ctx_caps_at_trained_window", () => {
  // A huge card cannot push ctx past the model's trained window.
  const m = meta(10);
  m.contextLength = 8192;
  const plan = computeFit(m, TEN_GB, hw(96000));
  expect(plan.ctxLen <= 8192).toBe(true);
});

/** A one-pool box: iGPU (Windows/Linux, weak GPU row, no cuda) or Apple unified (macOS, NO
 * GPU row at all — detection never fabricates a VRAM number). */
function hwOnePool({ platform = "windows", ramMb = 32000, gpus = null, runtimes = null } = {}) {
  return model(HardwareInfo, { os: platform, platform, cpuCores: 8, ramMb, gpus: gpus ?? [], runtimes: runtimes ?? {} });
}

// ── The architecture arm (fit-redesign Phase 1, §5.2 + §13.10 matrix) ────────

test("arch_arm_unified_mac_is_not_a_cpu_box", () => {
  // The Mac bug: no GPU row → maxVram 0 → budget 0 → ctx clamped to the ladder floor (4096)
  // while Metal ran the model fine. The one-pool arm budgets ctx from the POOL, so a 32 GB
  // Mac affords real context (capped by the ctx cap) — and since the 2026-08-13 one-pool
  // ruling the BOOKING is real pool occupancy too.
  const m = new GgufMeta({ architecture: "llama", blockCount: 10, embeddingLength: 1000, expertCount: 0, contextLength: 262144 });
  const mac = hwOnePool({ platform: "macos", ramMb: 32768 });
  const plan = computeFit(m, TEN_GB, mac);
  expect(plan.ctxLen > 4096).toBe(true); // unclamped — the pool affords it
  expect(plan.ctxLen <= 32768).toBe(true); // the ctx cap still governs
  expect(plan.vramMb >= TEN_GB / 1e6).toBe(true); // full offload: at least the weights' bytes
  expect(plan.vramMb <= 32768).toBe(true); // never more than the pool itself
});

test("arch_arm_one_pool_moe_never_offloads_experts", () => {
  // igpu-mem32's measured truth (Core Ultra 7 ncmoe sweep: 0 fastest, every offload level
  // slower): expert 'offload' on one pool moves bytes nowhere and costs speed. The computed
  // default is ncmoe 0 — matching the seeded tune — while an explicit override still wins.
  const moe = new GgufMeta({ architecture: "qwen3moe", blockCount: 30, embeddingLength: 2816, expertCount: 128, contextLength: 32768 });
  const igpu = hwOnePool({
    platform: "windows",
    ramMb: 32000,
    gpus: [model(GpuInfo, { vendor: "Intel", name: "Intel(R) Graphics", vramMb: 128 })],
  });
  const plan = computeFit(moe, 14_000_000_000, igpu);
  expect(plan.isMoe).toBe(true);
  expect(plan.nCpuMoe).toBe(0);
  const explicit = computeFit(moe, 14_000_000_000, igpu, new Overrides({ nCpuMoe: 16 }));
  expect(explicit.nCpuMoe).toBe(16);
  // discrete keeps the two-pool default — since Phase 6's joint solve, a dims-less MoE that
  // can't fit whole sends ALL experts to RAM (offload is the cheap knob) and walks layers by
  // physics.
  const discrete = computeFit(moe, 14_000_000_000, hw(8192));
  expect(discrete.nCpuMoe).toBe(30);
  expect(discrete.nGpuLayers > 0 && discrete.nGpuLayers < 30).toBe(true);
});

test("arch_arm_one_pool_booking_never_exceeds_ledger", () => {
  // The 2026-08-13 one-pool ruling: the ledger tracks POOL occupancy, so the booking's ceiling
  // is `budgetTotalMb` (the pool) — the same denominator the arbiter got in Phase 4. A booking
  // of 0–128 MB here meant admission never engaged and the claim line read 0 on every
  // one-pool box.
  const m = new GgufMeta({ architecture: "llama", blockCount: 10, embeddingLength: 1000, expertCount: 0, contextLength: 8192 });
  const igpu = hwOnePool({ platform: "windows", ramMb: 16000, gpus: [model(GpuInfo, { vendor: "Intel", name: "Iris Xe", vramMb: 2048 })] });
  const plan = computeFit(m, TEN_GB, igpu);
  expect(plan.vramMb > 2048).toBe(true); // a real booking, not the carve-out clamp
  expect(plan.vramMb >= TEN_GB / 1e6).toBe(true); // full offload: at least the weights' bytes
  expect(plan.vramMb <= 16000).toBe(true); // never more than the pool itself
});

test("arch_arm_one_pool_booking_is_real_pool_occupancy", () => {
  // The new pin the ruling ordered: on a one-pool box the booking is the same physics number
  // a discrete card of pool size would book — weights + KV + the backend overhead seed —
  // because the pool IS the device memory there. Guards the exact failure the clamp caused:
  // E4B on igpu-mem16 booked 0–128 MB against a 16384 MB budget.
  const m = new GgufMeta({ architecture: "llama", blockCount: 10, embeddingLength: 1000, expertCount: 0, contextLength: 8192 });
  const igpu = hwOnePool({ platform: "windows", ramMb: 16000, gpus: [model(GpuInfo, { vendor: "Intel", name: "Iris Xe", vramMb: 2048 })] });
  const poolPlan = computeFit(m, TEN_GB, igpu);
  // The same box as a discrete card with VRAM = the pool: identical placement (full offload)
  // and the same physics terms except the backend overhead seed (vulkan on the iGPU vs cuda on
  // the discrete fake) — so compare weights+KV by subtracting each backend's seed.
  const discretePlan = computeFit(m, TEN_GB, hw(16000));
  expect(poolPlan.nGpuLayers).toBe(10);
  expect(discretePlan.nGpuLayers).toBe(10);
  const poolCore = poolPlan.vramMb - fit.PHYSICS_OVERHEAD_MB.vulkan;
  const discreteCore = discretePlan.vramMb - fit.PHYSICS_OVERHEAD_MB.cuda;
  expect(Math.abs(poolCore - discreteCore) <= 1).toBe(true); // same weights+KV, int rounding apart
});

test("ctx_cap_bounds_computed_ctx_only", () => {
  // The ctx cap (fit-redesign §8.1/§1.5): computed ctx = min(trained, affordable, cap) — the
  // uncapped policy handed a cheap-KV MoE 131,072 (~2.7 GB of KV before any weights). A CAP,
  // never a pin: explicit ctx is untouched; 0 disables.
  const m = new GgufMeta({ architecture: "llama", blockCount: 10, embeddingLength: 1000, expertCount: 0, contextLength: 262144 });
  const big = hw(98304); // affordability is not the binding constraint here
  expect(computeFit(m, TEN_GB, big).ctxLen).toBe(32768); // the seeded default cap
  expect(computeFit(m, TEN_GB, big, null, { ctxCapTokens: 0 }).ctxLen > 32768).toBe(true); // trained/affordable rule
  expect(computeFit(m, TEN_GB, big, new Overrides({ ctxLen: 131072 })).ctxLen).toBe(131072); // "a tune's explicit context always overrides"
  const smallTrained = new GgufMeta({ architecture: "llama", blockCount: 10, embeddingLength: 1000, expertCount: 0, contextLength: 8192 });
  expect(computeFit(smallTrained, TEN_GB, big).ctxLen).toBe(8192); // cap never raises
});

test("kv_affordable_bounds_and_monotonic", () => {
  const floor = fit.kvAffordable({ vramBudgetMb: 0, nLayers: 30, nKvHeads: 8, cacheType: 8 });
  const roof = fit.kvAffordable({ vramBudgetMb: 1e9, nLayers: 30, nKvHeads: 8, cacheType: 8 });
  expect(floor).toBe(4096);
  expect(roof).toBe(262144);
  let prev = 0;
  for (const budget of [0, 1000, 4000, 16000, 64000]) {
    const ctx = fit.kvAffordable({ vramBudgetMb: budget, nLayers: 30, nKvHeads: 8, cacheType: 8 });
    expect(ctx >= prev).toBe(true);
    prev = ctx;
  }
});

test("kv_term_single_source_no_drift", () => {
  // 1b-F3: `_slopeOffset`'s KV term must BE `_C1 × kvBytesPerToken × ctx` — the slope delta
  // across two ctx values equals the helper-derived delta exactly, pinning both consumers to
  // the ONE extracted factor.
  const a1 = fit._slopeOffset(1000, 10, 8, 2048, 4096, 8)[0];
  const a2 = fit._slopeOffset(1000, 10, 8, 2048, 8192, 8)[0];
  const expected = fit._C1 * fit.kvBytesPerToken(8, 8) * (8192 - 4096);
  expect(Math.abs(a2 - a1 - expected)).toBeLessThan(1e-9);
});

// ── Phase 4: the ONE spawn seam + the Windows kill-on-close Job Object (A3) ──

test("spawn_child_seam_wiring_and_no_job_off_windows", async () => {
  // The seam builds the spawn with the shared stdout/stderr wiring; off-Windows the job handle
  // is null (the orphan fix is win32-only by construction). JS wiring: both pipes, never an
  // inherited fd; copied into the log when there is one, else into `capturedOutput`.
  processMod.cfg.platform = "linux";
  const calls = {};
  const fakePopen = (argv, opts) => {
    calls.argv = argv;
    calls.opts = opts;
    return {};
  };
  const [, job] = await processMod._spawnChild(fakePopen, ["exe", "--flag"], null);
  expect(job).toBeNull();
  expect(calls.argv).toEqual(["exe", "--flag"]);
  expect(calls.opts.stdio).toEqual(["ignore", "pipe", "pipe"]);

  // No log → the pipes' text lands on the process object (Python's PIPE + text=True).
  // (The two pipes merge in arrival order — the OS no longer merges them, see process.js.)
  const piped = { exitCode: 0, stdout: Readable.from([Buffer.from("out|")]), stderr: Readable.from([Buffer.from("err|")]) };
  const [p1] = await processMod._spawnChild(() => piped, ["exe"], null);
  expect((await processMod._drain(p1)).split("|").filter(Boolean).sort()).toEqual(["err", "out"]);
  // A log → the same bytes are appended to the file.
  const logPath = join(tmp(), "child.log");
  writeFileSync(logPath, "before\n");
  const logged = { exitCode: null, stdout: Readable.from([Buffer.from("into the log")]) };
  await processMod._spawnChild(() => logged, ["exe"], logPath);
  await new Promise((r) => setTimeout(r, 100));
  expect(readFileSync(logPath, "utf8")).toBe("before\ninto the log");
});

test("win_job_degrades_gracefully_without_windll", () => {
  // The job is a SAFETY NET: on a (faked) win32 platform where the native calls fail, the
  // spawn must still succeed with job=null — never block a spawn. The real
  // kill-on-parent-death is the gated real-spawn test below.
  processMod.cfg.platform = "win32";
  vi.spyOn(processMod, "_kernel32").mockImplementation(() => {
    throw new Error("no kernel32 here");
  });
  expect(processMod._winJobForChild({ pid: 4242 })).toBeNull();
});

test("stop_closes_the_retained_job_handle", () => {
  // stop() must close the retained handle (under KILL_ON_JOB_CLOSE that is what guarantees the
  // child tree dies with us) — recorded via a spied closer.
  const closed = [];
  vi.spyOn(processMod, "_closeJob").mockImplementation((j) => closed.push(j));
  const sentinel = {};
  const h = new Runner({ process: new FakeProc(null), url: "http://x", nGpuLayers: 1, nCpuMoe: 0, jobHandle: sentinel });
  h.stop();
  expect(closed).toEqual([sentinel]);
});

// ── the spawn seam's retry (2026-08-03) ────────────────────────────────────────
// Measured on the i18n app: Quick Setup installed the engine, the load fired, and
// CreateProcess raised WinError 2 for a path that existed and whose exe ran by hand — a virus
// scanner still holding a freshly installed binary. The spawn retries a transient Windows
// error and, when it truly cannot start, raises RunnerStartError so
// `_spawn_router_with_fallback` can chain to another installed backend (it catches
// RunnerStartError only, so a bare OS error skipped the chain AND reached the user as a raw
// "[WinError 2] The system cannot find the file specified").

function winerr(code) {
  return Object.assign(new Error("The system cannot find the file specified"), { winerror: code, errno: code });
}

test("spawn_retries_a_transient_windows_error_then_succeeds", async () => {
  processMod.cfg.platform = "win32";
  vi.spyOn(processMod, "_winJobForChild").mockReturnValue(null);
  const calls = { n: 0 };
  const flakyPopen = () => {
    calls.n += 1;
    if (calls.n < 3) throw winerr(2);
    return "the-process";
  };
  const [proc] = await processMod._spawnChild(flakyPopen, ["llama-server.exe"], null, { _sleep: noSleep });
  expect(proc).toBe("the-process");
  expect(calls.n).toBe(3); // it must actually retry, not swallow the first failure
});

test("a_spawn_that_never_starts_raises_RunnerStartError_not_OSError", async () => {
  processMod.cfg.platform = "win32";
  const alwaysFails = () => {
    throw winerr(2);
  };
  const err = await processMod._spawnChild(alwaysFails, ["C:\\nope\\llama-server.exe"], null, { _sleep: noSleep }).catch((e) => e);
  expect(err).toBeInstanceOf(RunnerStartError);
  // The message must name the binary and say which of the two cases this is.
  expect(err.message).toContain("llama-server.exe");
  expect(err.message).toContain("missing"); // an absent binary must say so, not blame the scanner
});

test("a_non_transient_spawn_error_is_not_retried", async () => {
  // A bad argv (WinError 87) is a bug, not a scanner — report it at once.
  processMod.cfg.platform = "win32";
  const calls = { n: 0 };
  const bad = () => {
    calls.n += 1;
    throw winerr(87);
  };
  await expect(processMod._spawnChild(bad, ["llama-server.exe"], null, { _sleep: noSleep })).rejects.toBeInstanceOf(RunnerStartError);
  expect(calls.n).toBe(1); // only a transient (not-found / access-denied) error retries
});

// ── JS-only (no Python counterpart) ────────────────────────────────────────────

test("js_only: a real child's merged output reaches the log, and the job is held on Windows", async () => {
  // A tiny real child (this runtime as plain Node) through the default door: stdout + stderr
  // both land in the log; on Windows it gets a job handle; stop() + exit leave nothing behind.
  const logPath = join(tmp(), "real.log");
  writeFileSync(logPath, "");
  const [proc, job] = await processMod.spawnChild(
    null,
    [process.execPath, "-e", "process.stdout.write('to-stdout\\n'); process.stderr.write('to-stderr\\n')"],
    logPath,
  );
  expect(typeof proc.pid).toBe("number");
  if (process.platform === "win32") expect(job).not.toBeNull();
  else expect(job).toBeNull();
  expect(await processMod.waitExit(proc, 20)).toBe(0);
  await new Promise((r) => setTimeout(r, 200));
  const text = readFileSync(logPath, "utf8");
  expect(text).toContain("to-stdout");
  expect(text).toContain("to-stderr");
  processMod.closeJob(job);
  processMod.closeJob(job); // a second close is a no-op, never a stray CloseHandle
});

test("js_only: a real missing binary rejects RunnerStartError, never an unhandled 'error'", async () => {
  const exe = join(tmp(), "no-such-llama-server.exe");
  const err = await processMod.spawnChild(null, [exe, "--version"], null, { _sleep: noSleep }).catch((e) => e);
  expect(err).toBeInstanceOf(RunnerStartError);
  expect(err.message).toContain("missing");
});

test("js_only: start_router waits for health and reports a failed router", async () => {
  const r = await startRouter("llama-server", {
    modelsDir: "/hf",
    modelsPreset: "/x.ini",
    port: 8137,
    _popen: () => new FakeProc(null),
    _health: () => true,
    _sleep: noSleep,
  });
  expect(r.url).toBe("http://127.0.0.1:8137");
  expect(r.isAlive()).toBe(true);
  const err = await startRouter("llama-server", {
    modelsDir: "/hf",
    modelsPreset: "/x.ini",
    _popen: () => new FakeProc(1, "error: invalid argument: --nope"),
    _health: () => false,
    _sleep: noSleep,
  }).catch((e) => e);
  expect(err).toBeInstanceOf(RunnerStartError);
  expect(err.message).toBe("llama-server router failed to become healthy (exit 1): error: invalid argument: --nope");
});
