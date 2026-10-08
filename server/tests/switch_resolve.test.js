// SPDX-License-Identifier: MIT
// Port of tests/test_switch_resolve.py — the layered switch resolver (design §6 + Plan B
// 2026-07-05), the model-level merge: base → type (moe|dense) → GATED auto-mtp → per-class
// tune → per-(model, machine) tune (`model_tunes`, always wins). The auto-mtp layer is the
// 2026-07-05 USER decision reversing Phase 3's "never auto-enabled": auto-on for an ENABLED
// model, user-off persisted in the tune layer. Pure data/logic; no GPU needed.
import { beforeEach, expect, test, vi } from "vitest";
import * as seed from "../src/llm/seed.js";
import { getModelTuneStore } from "../src/llm/stores.js";
import * as switchResolve from "../src/llm/switch_resolve.js";
import { classKey } from "../src/runner/hardware.js";
import { freshDb } from "./helpers.js";

// stores.js imports identity.js (wave 2, another slice): its stand-in until the file lands
// (fixtures/wave-stubs.js). switch_resolve.js is real now — that stand-in steps aside.
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

let h;
beforeEach(() => {
  h = freshDb({ foreignKeys: false }); // Python's sqlite connection never turns them on
  h.tx(() => {
    seed.seedDefaultSwitchPresets(h);
    seed.seedDefaultCatalog(h);
  });
});

const catalogRow = (row) => h.insert("model_catalog", { name: "", ...row });
const modelTune = (model_id, hw_key, flag_name, flag_value) => h.insert("model_tunes", { model_id, hw_key, flag_name, flag_value });
const classTune = (model_id, class_key, flag_name, flag_value, built_in = false) =>
  h.insert("class_tunes", { model_id, class_key, flag_name, flag_value, built_in });

test("mtp_model_auto_enables_draft_mtp", () => {
  // A type=moe row with built-in MTP → base + moe + the GATED mtp preset: spec_type=draft-mtp
  // + the measured spec_n_max=2 auto-apply (Plan B D3).
  catalogRow({ id: "glm-4.5-air", name: "GLM", type: "moe", mtp: true, mtp_builtin: true });
  const sw = switchResolve.resolveModelSwitches("glm-4.5-air");
  expect(sw.spec_type).toBe("draft-mtp");
  expect(sw.spec_n_max).toBe("2"); // the user-measured seed (≠ knob default 3)
  expect(sw.no_mmap).toBe("true"); // the one genuinely MoE-specific flag
  expect(sw.flash_attn).toBe("on");
  expect(sw.cache_type_k).toBe("q8_0");
});

test("non_mtp_model_gets_no_spec_flags", () => {
  // 8B dense, mtp=False, no draft file → the mtp preset does NOT apply.
  const sw = switchResolve.resolveModelSwitches("qwen3-8b-q4_k_m");
  expect("spec_type" in sw).toBe(false);
  expect("spec_n_max" in sw).toBe(false);
  expect(sw.flash_attn).toBe("on");
  expect(sw.mlock).toBe("true");
});

test("mtp_enable_flag_governs_regardless_of_draft", () => {
  // 2026-07-13 split: `mtp` is the ENABLE flag; unchecking it disables the mtp preset EVEN
  // with a draft file still configured.
  catalogRow({ id: "gemma-on", name: "G", type: "moe", mtp: true, mtp_builtin: false, mtp_draft_file: "MTP/g-Q4_0-MTP.gguf" });
  catalogRow({ id: "gemma-off", name: "G", type: "moe", mtp: false, mtp_builtin: false, mtp_draft_file: "MTP/g-Q4_0-MTP.gguf" });
  const on = switchResolve.resolveModelSwitches("gemma-on");
  expect(on.spec_type).toBe("draft-mtp");
  expect(on.spec_n_max).toBe("2");
  expect(on.no_mmap).toBe("true"); // type=moe layer still applies
  const off = switchResolve.resolveModelSwitches("gemma-off");
  expect("spec_type" in off).toBe(false); // uncheck wins even though a draft is set
  expect(off.no_mmap).toBe("true"); // type=moe layer unaffected
});

test("model_tune_wins_over_every_layer", () => {
  // The per-(model, machine) MEASURED tune is LAST: it beats every bundle layer for ITS
  // model on ITS machine — including the MTP opt-OUT.
  modelTune("qwen3.6-35b-a3b-mtp", "k1", "threads", "8");
  modelTune("qwen3.6-35b-a3b-mtp", "k1", "spec_type", "none");
  modelTune("qwen3.6-35b-a3b-mtp", "k1", "n_cpu_moe", "37");
  const sw = switchResolve.resolveModelSwitches("qwen3.6-35b-a3b-mtp", "k1");
  expect(sw.threads).toBe("8"); // the tune's own value lands
  expect(sw.spec_type).toBe("none"); // the user's opt-out beats auto-mtp
  expect(sw.n_cpu_moe).toBe("37"); // the measured allocation rides along
});

test("tune_is_scoped_to_its_model_and_machine", () => {
  // A tune for (model A, machine k1) leaks to NEITHER another model on k1 NOR the same model
  // on another machine — the composite key is the point of B.
  modelTune("qwen3.6-35b-a3b-mtp", "k1", "batch_size", "64");
  expect("batch_size" in switchResolve.resolveModelSwitches("qwen3-8b-q4_k_m", "k1")).toBe(false);
  expect("batch_size" in switchResolve.resolveModelSwitches("qwen3.6-35b-a3b-mtp", "k2")).toBe(false);
  expect(switchResolve.resolveModelSwitches("qwen3.6-35b-a3b-mtp", "k1").batch_size).toBe("64");
});

test("origins_track_the_writing_layer", () => {
  // Provenance (2026-07-07): which layer last wrote each key — base for the bundle rows,
  // class for a class-tune row, tune for the machine's own saved value.
  catalogRow({ id: "glm-4.5-air", name: "GLM", type: "moe", mtp: true, mtp_builtin: true });
  classTune("glm-4.5-air", "vram8|ram32", "n_cpu_moe", "21", true);
  modelTune("glm-4.5-air", "k1", "threads", "8");
  const [sw, origins] = switchResolve.resolveModelSwitchesWithOrigins("glm-4.5-air", "k1", "vram8|ram32");
  expect(origins.flash_attn).toBe("base");
  expect(origins.spec_type).toBe("mtp"); // the gated auto-MTP layer
  expect(origins.n_cpu_moe).toBe("class");
  expect(origins.threads).toBe("tune");
  expect(sw.n_cpu_moe === "21" && sw.threads === "8").toBe(true);
  // the plain resolver stays the values-only view of the same walk
  expect(switchResolve.resolveModelSwitches("glm-4.5-air", "k1", "vram8|ram32")).toEqual(sw);
});

test("unknown_model_empty", () => {
  expect(switchResolve.resolveModelSwitches("does-not-exist")).toEqual({
    flash_attn: "on",
    cache_type_k: "q8_0",
    cache_type_v: "q8_0",
    mlock: "true",
    // reasoning_budget=1024 is the visible GLOBAL tier of the per-request thinking budget,
    // read via switch_resolve at request time — NOT a launch flag.
    reasoning_budget: "1024",
  }); // unknown model → treated as dense, base preset only (no mtp gate w/o a row)
});

test("class_tune_applies_on_matching_class", () => {
  // The seeded/editable per-(model, hardware-CLASS) layer: applies only when the box's
  // class_key matches, and to its own model.
  classTune("qwen3.6-35b-a3b-mtp", "vram8|ram32", "n_cpu_moe", "21");
  classTune("qwen3.6-35b-a3b-mtp", "vram8|ram32", "ctx_len", "32768");
  const sw = switchResolve.resolveModelSwitches("qwen3.6-35b-a3b-mtp", "", "vram8|ram32");
  expect(sw.n_cpu_moe).toBe("21");
  expect(sw.ctx_len).toBe("32768");
  expect(sw.flash_attn).toBe("on"); // base still layers underneath
  // a DIFFERENT class doesn't get it; no class_key passed → not applied
  expect("n_cpu_moe" in switchResolve.resolveModelSwitches("qwen3.6-35b-a3b-mtp", "", "vram24|ram64")).toBe(false);
  expect("n_cpu_moe" in switchResolve.resolveModelSwitches("qwen3.6-35b-a3b-mtp")).toBe(false);
});

test("model_tune_overrides_class_tune", () => {
  // A machine's OWN measured tune is MORE SPECIFIC than the class default → it wins.
  classTune("qwen3.6-35b-a3b-mtp", "vram8|ram32", "n_cpu_moe", "21");
  modelTune("qwen3.6-35b-a3b-mtp", "k1", "n_cpu_moe", "23");
  const sw = switchResolve.resolveModelSwitches("qwen3.6-35b-a3b-mtp", "k1", "vram8|ram32");
  expect(sw.n_cpu_moe).toBe("23");
});

test("seed_default_class_tunes_seeds_the_registered_app_rows", () => {
  // Since decision ④ (2026-08-05) class tunes are the APP's registration. What stays under
  // test HERE is the mechanism: registered rows seed, multi-flag rows land whole, a re-seed
  // is idempotent, and a user's existing (model, class) is never clobbered.
  seed.configureAppSeed({
    classTunesSeed: [
      {
        model_id: "m-a",
        class_key: "dgpu-vram8|ram32",
        switches: { n_gpu_layers: "99", n_cpu_moe: "21", ctx_len: "32768", batch_size: "512", reasoning_budget: "1024" },
      },
      {
        model_id: "m-a",
        class_key: "igpu-mem32",
        switches: { n_gpu_layers: "99", n_cpu_moe: "0", flash_attn: "off", ubatch_size: "512" },
      },
    ],
  });
  try {
    // A user's PRE-EXISTING config for one of the registered (model, class) pairs — the seed
    // must skip it whole.
    classTune("m-a", "igpu-mem32", "ctx_len", "8192", false);
    expect(h.tx(() => seed.seedDefaultClassTunes(h))).toBe(1); // only the un-owned pair seeds
    const flags = (ck) =>
      Object.fromEntries(
        h
          .all("select * from class_tunes where model_id = ? and class_key = ?", ["m-a", ck])
          .map((r) => [r.flag_name, r.flag_value]),
      );
    expect(flags("dgpu-vram8|ram32")).toEqual({
      n_gpu_layers: "99",
      n_cpu_moe: "21",
      ctx_len: "32768",
      batch_size: "512",
      reasoning_budget: "1024",
    });
    expect(flags("igpu-mem32")).toEqual({ ctx_len: "8192" }); // the user's config, untouched
    // idempotent (merge-by-(model, class)) — a re-seed adds nothing
    expect(h.tx(() => seed.seedDefaultClassTunes(h))).toBe(0);
  } finally {
    seed.configureAppSeed({ classTunesSeed: [] });
  }
});

test("class_key_bands_to_gb", () => {
  const G = (vramMb, name = "GPU") => ({ vramMb, name });
  const H = (ramMb, gpus, platform = "linux", runtimes = null) => ({ ramMb, gpus, platform, runtimes: runtimes || {} });
  const cuda = { cuda: true };
  // 2070 SUPER reports ~8188 MB (just under 8 GB) → the 8 GB DISCRETE class; RAM rounds to GB.
  expect(classKey(H(32768, [G(8188)], "linux", cuda))).toBe("dgpu-vram8|ram32");
  expect(classKey(H(32768, [G(8192)], "linux", cuda))).toBe("dgpu-vram8|ram32");
  // no GPU → the integrated one-pool fallback (keyed on the single memory number).
  expect(classKey(H(16384, []))).toBe("igpu-mem16");
  // macOS → unified one-pool (Apple Silicon); fixes the old Mac-as-CPU mis-key.
  expect(classKey(H(196608, [], "macos"))).toBe("unified-mem192");
});

// ── Pass 2 (2026-07-22): backend-stamped tunes ────────────────────────────────

test("tune_row_applies_matrix", () => {
  // "" row = legacy (cuda-era) → cuda-only; no active context → everything applies.
  const f = switchResolve.tuneRowApplies;
  expect(f("", "cuda")).toBe(true);
  expect(f("", "vulkan")).toBe(false);
  expect(f("vulkan", "vulkan")).toBe(true);
  expect(f("vulkan", "cuda")).toBe(false);
  expect(f("cuda", "")).toBe(true); // unknown/unwired context → legacy behavior
  expect(f("", "")).toBe(true);
});

test("backend_stamp_and_filter_roundtrip", () => {
  // A tune saved under cuda is stamped, applies under cuda, and is REFUSED (resolve, display)
  // under a different family — the qwen ctx-131072 incident's product fix.
  const store = getModelTuneStore();
  const [mid, hw] = ["qwen3.6-35b-a3b-mtp", "BOX|8192|8c|32g"];
  try {
    switchResolve.setActiveBackendFn(() => "cuda");
    store.replace(mid, hw, [{ flagName: "ctx_len", flagValue: "131072" }]);
    const rows = h.all("select * from model_tunes where model_id = ?", [mid]);
    expect(rows.length).toBe(1); // .one()
    expect(rows[0].backend).toBe("cuda");
    let [merged, origins] = switchResolve.resolveModelSwitchesWithOrigins(mid, hw);
    expect(merged.ctx_len === "131072" && origins.ctx_len === "tune").toBe(true);
    expect(store.get(mid, hw).map((r) => r.flagName)).toEqual(["ctx_len"]);

    switchResolve.setActiveBackendFn(() => "cpu");
    [merged, origins] = switchResolve.resolveModelSwitchesWithOrigins(mid, hw);
    expect("ctx_len" in merged).toBe(false); // the cuda tune does NOT follow
    expect(store.get(mid, hw)).toEqual([]); // nor display as applied

    switchResolve.setActiveBackendFn(null); // unwired → legacy behavior
    [merged] = switchResolve.resolveModelSwitchesWithOrigins(mid, hw);
    expect(merged.ctx_len).toBe("131072");
  } finally {
    switchResolve.setActiveBackendFn(null);
  }
});

test("legacy_unstamped_tune_reads_as_cuda", () => {
  // A pre-Pass-2 row (backend "") applies under cuda, not under vulkan.
  modelTune("qwen3.6-35b-a3b-mtp", "H", "threads", "8");
  try {
    switchResolve.setActiveBackendFn(() => "cuda");
    let [merged] = switchResolve.resolveModelSwitchesWithOrigins("qwen3.6-35b-a3b-mtp", "H");
    expect(merged.threads).toBe("8");
    switchResolve.setActiveBackendFn(() => "vulkan");
    [merged] = switchResolve.resolveModelSwitchesWithOrigins("qwen3.6-35b-a3b-mtp", "H");
    expect("threads" in merged).toBe(false);
  } finally {
    switchResolve.setActiveBackendFn(null);
  }
});
