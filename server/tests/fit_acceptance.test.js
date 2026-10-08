// SPDX-License-Identifier: MIT
// Port of tests/test_fit_acceptance.py — the §7.2 five-row measured gate (fit-redesign,
// Phase 6): the computed placement must reproduce the MEASURED class-tune rows (§1.9), within
// the plan's tolerance. Before the joint solve this failed by design: the fitted inverse
// computed ngl 8-9 on models every measured tune runs at ngl=all.
//
// The metas carry the REAL seeded physics facts (JW seed_presets.py, harvested from the live
// GGUF headers by the Phase 2 refresh; the 26B numbers match the 2026-08-13 probe: share
// 0.9389, 30 layers, window 1024), and KV comes through the same §13.11 scalar formula the app
// computes with — so a drifted constant fails HERE, not on a user's box. Rows are checked at
// the tune's own ctx (32768) — a tune's explicit context always overrides, and the measured
// knob values were measured AT it. The gryphe row (spec_type A/B verdict) and the fa/ub rows
// are excluded per §1.9: unreproducible by fit.
//
// JS shape: the duck-typed metas use GgufMeta's camelCase names (`blockCount`, `nKvHeads`,
// `kvMbAtCtx`, `expertByteShare`), which is what `computeFit` reads.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { model } from "../src/platform/models.js";
import * as fit from "../src/runner/fit.js";
import { computeFit, Overrides } from "../src/runner/process.js";
import { GpuInfo, HardwareInfo } from "../src/runner/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A meta whose KV rides the seeded §13.11 scalars (iSWA-honest). */
class FactsMeta {
  constructor({
    blockCount,
    embeddingLength,
    nKvHeads,
    headCount,
    kvWindowed,
    kvGlobal,
    slidingWindow,
    contextLength,
    expertCount = 0,
    expertShare = 0.0,
  }) {
    this.architecture = expertCount ? "gemma4moe" : "gemma4";
    this.blockCount = blockCount;
    this.embeddingLength = embeddingLength;
    this.nKvHeads = nKvHeads;
    this.headCount = headCount;
    this.contextLength = contextLength;
    this.expertCount = expertCount;
    this._share = expertShare;
    this._facts = {
      kv_windowed_bytes_per_token: kvWindowed,
      kv_global_bytes_per_token: kvGlobal,
      sliding_window: slidingWindow,
    };
  }

  get isMoe() {
    return this.expertCount > 0;
  }

  expertByteShare() {
    return this._share;
  }

  kvMbAtCtx(ctx, cacheBits) {
    return fit.kvMbFromFacts(this._facts, ctx, cacheBits);
  }
}

// The seeded facts, verbatim (seed == detection — Phase 2's refresh ran live).
const B26 = {
  blockCount: 30,
  embeddingLength: 2816,
  nKvHeads: 16,
  headCount: 16,
  kvWindowed: 102400.0,
  kvGlobal: 10240.0,
  slidingWindow: 1024,
  contextLength: 131072,
  expertCount: 128,
  expertShare: 0.9388753056,
};
const B26_BYTES = 14_249_047_104;
const B12 = {
  blockCount: 48,
  embeddingLength: 3840,
  nKvHeads: 16,
  headCount: 16,
  kvWindowed: 163840.0,
  kvGlobal: 8192.0,
  slidingWindow: 1024,
  contextLength: 131072,
};
const B12_BYTES = 6_716_356_800;
const E4B = {
  blockCount: 42,
  embeddingLength: 2560,
  nKvHeads: 2,
  headCount: 8,
  kvWindowed: 35840.0,
  kvGlobal: 14336.0,
  slidingWindow: 512,
  contextLength: 131072,
};
const E4B_BYTES = 4_215_695_776;
// The external Gemma MTP draft (251,937,728 B on disk); its KV dims are small — the [21,23]
// band below tolerates the whole plausible range of draft-KV sizes.
const DRAFT_BYTES = 251_937_728;

const draftMeta = () => ({ architecture: "gemma4", blockCount: 4, embeddingLength: 1152, nKvHeads: 4, isMoe: false });

const dgpu = (vramMb, ramMb) =>
  model(HardwareInfo, {
    os: "Windows",
    platform: "windows",
    cpuCores: 16,
    ramMb,
    gpus: [model(GpuInfo, { vendor: "NVIDIA", name: "dgpu", vramMb })],
    runtimes: { cuda: true },
  });

const igpu = (ramMb) =>
  model(HardwareInfo, {
    os: "Windows",
    platform: "windows",
    cpuCores: 16,
    ramMb,
    gpus: [model(GpuInfo, { vendor: "Intel", name: "Intel(R) Graphics", vramMb: 128 })],
    runtimes: {},
  });

test("26b_on_vram8_ram32_reproduces_the_measured_ncmoe", () => {
  // THE row (measured on the author's 2070S): ngl 99 / ncmoe 21 / ctx 32768, MTP draft on. 20
  // OOMs on that box, the sweep said 23 — so the computed ncmoe must land in [21, 23]: never
  // below the OOM line, never lazier than the sweep's safe end. ngl = all layers (the joint
  // solve pins it).
  const plan = computeFit(new FactsMeta(B26), B26_BYTES, dgpu(8192, 32768), new Overrides({ ctxLen: 32768 }), {
    draftMeta: draftMeta(),
    draftBytes: DRAFT_BYTES,
  });
  expect(plan.nGpuLayers).toBe(30);
  expect(plan.nCpuMoe >= 21 && plan.nCpuMoe <= 23).toBe(true);
  expect(plan.ctxLen).toBe(32768);
});

test("26b_on_igpu_mem32_keeps_experts_in_the_pool", () => {
  // igpu-mem32's measured truth (Core Ultra 7 ncmoe sweep): offload on one pool is pure loss
  // — ncmoe 0, all layers on the device.
  const plan = computeFit(new FactsMeta(B26), B26_BYTES, igpu(32768), new Overrides({ ctxLen: 32768 }));
  expect(plan.nGpuLayers).toBe(30);
  expect(plan.nCpuMoe).toBe(0);
});

test("12b_fully_offloads_where_physics_says_it_fits", () => {
  // The 12B tune rows pin ngl 99 on the vram12 classes; the physics agrees — 6716 MB weights
  // + 436 MB iSWA-KV(32k, q8) + the cuda overhead fit a 12 GB card with the default margin.
  // (The old fitted inverse said 37: its uniform KV projection prices this iSWA model's KV ~9×
  // over.)
  const plan = computeFit(new FactsMeta(B12), B12_BYTES, dgpu(12288, 16384), new Overrides({ ctxLen: 32768 }));
  expect(plan.nGpuLayers).toBe(48);
  expect(plan.nCpuMoe).toBe(0);
});

test("12b_on_vram8_stays_partial_and_that_is_honest", () => {
  // The vram8 row's "ngl 99 · 39.1 tok/s" was llama-bench — which has NO -c flag (§13.13), so
  // its tiny bench KV is not this server config. At the tune's ctx 32768 the card cannot hold
  // all 48 layers (weights + KV + overhead ≈ 8.7 GB > the margined 7.2 GB budget): the
  // computed plan stays partial, and the engine's own placement remains the final word.
  const plan = computeFit(new FactsMeta(B12), B12_BYTES, dgpu(8192, 16384), new Overrides({ ctxLen: 32768 }));
  expect(plan.nGpuLayers > 0 && plan.nGpuLayers < 48).toBe(true);
});

test("e4b_on_igpu_mem16_fully_offloads", () => {
  // E4B @ igpu-mem16 (Iris Xe): ngl 99 measured at 9.8 tok/s — the pool holds the whole
  // 4.2 GB file with room to spare.
  const plan = computeFit(new FactsMeta(E4B), E4B_BYTES, igpu(16384), new Overrides({ ctxLen: 32768 }));
  expect(plan.nGpuLayers).toBe(42);
  expect(plan.nCpuMoe).toBe(0);
});

test("26b_exact_bytes_still_reproduces_the_measured_ncmoe", () => {
  // vram-truth plan 2026-09-19 §6.6 / R3: the SAME measured row with the file's EXACT
  // per-block bytes (tensor table — incl. the duplicated vocab head the share formula never
  // counted, and the one-unit MiB booking) must still land in the measured band. The band is a
  // measurement and is never widened to pass.
  const fx = JSON.parse(readFileSync(join(HERE, "fixtures", "vram_truth_tensor_bytes.json"), "utf8"))[
    "gemma-4-26b-a4b-qat UD-Q4_K_XL"
  ];
  const m = new FactsMeta(B26);
  m.tensorBytesKnown = true;
  m.layerNonexpBytes = fx.layer_nonexp;
  m.layerExpsBytes = fx.layer_exps;
  m.outputBytes = fx.output_bytes;
  const plan = computeFit(m, B26_BYTES, dgpu(8192, 32768), new Overrides({ ctxLen: 32768 }), {
    draftMeta: draftMeta(),
    draftBytes: DRAFT_BYTES,
  });
  expect(plan.nGpuLayers).toBe(30);
  expect(plan.nCpuMoe >= 21 && plan.nCpuMoe <= 23).toBe(true);
  expect(plan.ctxLen).toBe(32768);
});
