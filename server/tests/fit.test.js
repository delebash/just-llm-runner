// SPDX-License-Identifier: MIT
// Port of tests/test_fit.py — the runner VRAM-fit math: the coarse pre-download band, the
// oobabooga VRAM formula (magnitude + monotonicity), the closed-form max-gpu-layers
// inversion, the physics decomposition, the joint MoE solve, the decode-speed model and the
// exact placement pinned to the engine. All 33 Python tests are ported.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as fit from "../src/runner/fit.js";

const VT = JSON.parse(readFileSync(new URL("./fixtures/vram_truth_tensor_bytes.json", import.meta.url), "utf8"));

const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
const isSorted = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);

test("parse_params", () => {
  expect(fit.parseParams("35B")).toBe(35e9);
  expect(fit.parseParams("3.6B")).toBe(3.6e9);
  expect(fit.parseParams("500M")).toBe(5e8);
  expect(fit.parseParams(null)).toBeNull();
  expect(fit.parseParams("weird")).toBeNull();
});

test("bytes_per_param", () => {
  expect(fit.bytesPerParam("Q4_K_M")).toBe(0.6);
  expect(fit.bytesPerParam("q8_0")).toBe(1.06);
  expect(fit.bytesPerParam("UD-Q4_K_XL")).toBe(0.6); // unsloth dynamic → q4_k family
  expect(fit.bytesPerParam("Q3_K_M")).toBe(0.49);
  expect(fit.bytesPerParam("F16")).toBe(2.0);
  expect(fit.bytesPerParam("")).toBe(0.6); // fallback
});

test("coarse_fit_bands", () => {
  const common = { totalParams: "7B", quant: "Q4_K_M", ramMb: 32000, marginMb: 1024 };
  // 7B Q4_K_M ≈ 7e9 * 0.6 / 1e6 = 4200 MB of weights.
  expect(fit.coarseFit({ vramMb: 24000, ...common })).toBe("ok");
  expect(fit.coarseFit({ vramMb: 6000, ...common })).toBe("ok"); // 4200 / 4976 < 1
  expect(fit.coarseFit({ vramMb: 5000, ...common })).toBe("tight"); // 4200 / 3976 ≈ 1.06
  expect(fit.coarseFit({ vramMb: 3000, ...common })).toBe("no"); // 4200 / 1976 ≈ 2.1
  expect(fit.coarseFit({ vramMb: 0, ...common })).toBe("cpu"); // CPU box, RAM ample
});

test("coarse_fit_cpu_no_when_ram_short", () => {
  // 70B Q4_K_M ≈ 42 GB of weights; 16 GB RAM can't hold it.
  expect(fit.coarseFit({ totalParams: "70B", quant: "Q4_K_M", vramMb: 0, ramMb: 16000, marginMb: 1024 })).toBe("no");
});

test("coarse_fit_override_and_unknown", () => {
  // Explicit minVram override wins (it can encode MoE CPU-offload).
  expect(
    fit.coarseFit({ totalParams: "35B", quant: "Q4_K_M", vramMb: 8000, ramMb: 64000, marginMb: 1024, minVramOverride: 6000 }),
  ).toBe("ok");
  // No params and no override (with a GPU) → unknown.
  expect(fit.coarseFit({ totalParams: null, quant: "Q4_K_M", vramMb: 8000, ramMb: 64000, marginMb: 1024 })).toBe("unknown");
});

test("coarse_fit_gpu_ram_gate", () => {
  // A GPU box must ALSO clear the model's RAM floor (MoE experts live in RAM).
  // 35B-A3B: 8 GB VRAM fits the active path, but it needs 32 GB RAM.
  const a3b = {
    totalParams: "35B",
    quant: "UD-Q4_K_XL",
    vramMb: 8000,
    marginMb: 1024,
    minVramOverride: 6000,
    minRamOverride: 32000,
  };
  expect(fit.coarseFit({ ramMb: 16000, ...a3b })).toBe("no"); // 8 GB VRAM + 16 GB RAM → not offered
  expect(fit.coarseFit({ ramMb: 32000, ...a3b })).toBe("ok"); // 8 GB VRAM + 32 GB RAM → offered
  // GLM-4.5-Air needs 64 GB RAM — a 32 GB box is gated out even with VRAM to spare.
  expect(
    fit.coarseFit({
      totalParams: "106B",
      quant: "UD-Q4_K_XL",
      vramMb: 16000,
      ramMb: 32000,
      marginMb: 1024,
      minVramOverride: 12000,
      minRamOverride: 64000,
    }),
  ).toBe("no");
  // A dense model with no large RAM floor is unaffected by the gate.
  expect(
    fit.coarseFit({ totalParams: "12B", quant: "Q4_K_M", vramMb: 12000, ramMb: 16000, marginMb: 1024, minRamOverride: 13000 }),
  ).toBe("ok");
});

test("coarse_fit_ram_gate_raw_to_raw", () => {
  // §13.5 end state (Phase 2): floors arrive RAW, detected RAM compares directly, and the
  // rung-vs-detected bug class is unrepresentable.
  const box = { totalParams: "35B", quant: "UD-Q4_K_XL", vramMb: 8192, marginMb: 1024, minVramOverride: 6000 };
  // The author's box vs the 21 GB file's RAW floor (25,096 = file + headroom):
  expect(fit.coarseFit({ ramMb: 32690, minRamOverride: 25096, ...box })).toBe("ok");
  // The carve-out laptop (~13.7 GB usable) HOLDS a raw 13 GB floor.
  expect(fit.coarseFit({ ramMb: 14000, minRamOverride: 13000, ...box })).toBe("ok");
  // …and honestly fails a floor it genuinely can't hold.
  expect(fit.coarseFit({ ramMb: 14000, minRamOverride: 16000, ...box })).toBe("no");
  // CPU branch, raw the same way.
  expect(
    fit.coarseFit({ totalParams: "55B", quant: "Q4_K_M", vramMb: 0, ramMb: 32690, minRamOverride: 25096, marginMb: 1024 }),
  ).toBe("cpu");
  // A LEGACY rung floor (pre-reset DB) misreads until the user resets — the accepted
  // pre-release cost (§13.5), pinned so the trade-off stays visible:
  expect(fit.coarseFit({ ramMb: 32690, minRamOverride: 32768, ...box })).toBe("no");
});

const cfg = (kw = {}) => ({
  sizeMb: 4400,
  nLayers: 32,
  nKvHeads: 8,
  embeddingDim: 4096,
  ctxSize: 4096,
  cacheType: 16,
  ...kw,
});

test("estimate_vram_magnitude", () => {
  // 7B Q4_K_M fully offloaded at 4k ctx ≈ ~6 GB — catches a coefficient typo.
  const vram = fit.estimateVramMb({ gpuLayers: 32, ...cfg() });
  expect(vram).toBeGreaterThan(5000);
  expect(vram).toBeLessThan(7000);
});

test("estimate_vram_monotonic", () => {
  const c = cfg();
  const vrams = range(0, 33).map((g) => fit.estimateVramMb({ gpuLayers: g, ...c }));
  expect(isSorted(vrams)).toBe(true); // more layers on GPU ⇒ more VRAM
});

test("moe_gpu_size_share", () => {
  // No discount cases: dense/unknown share, no GPU layers, ncmoe 0 — all 1.0.
  expect(fit.moeGpuSizeShare({ nLayers: 48, gpuLayers: 30, nCpuMoe: 21, expertShare: 0.0 })).toBe(1.0);
  expect(fit.moeGpuSizeShare({ nLayers: 48, gpuLayers: 0, nCpuMoe: 21, expertShare: 0.9 })).toBe(1.0);
  expect(fit.moeGpuSizeShare({ nLayers: 48, gpuLayers: 30, nCpuMoe: 0, expertShare: 0.9 })).toBe(1.0);
  // The incident shape (Gemma 26B, ngl 30 / ncmoe 21): 21 of the 30 GPU layers keep only
  // their non-expert bytes → (30 − 21·e)/30.
  const share = fit.moeGpuSizeShare({ nLayers: 48, gpuLayers: 30, nCpuMoe: 21, expertShare: 0.9 });
  expect(Math.abs(share - (30 - 21 * 0.9) / 30)).toBeLessThan(1e-9);
  // ncmoe beyond the GPU layer count clamps to the GPU layers.
  const clamped = fit.moeGpuSizeShare({ nLayers: 48, gpuLayers: 10, nCpuMoe: 99, expertShare: 0.9 });
  expect(Math.abs(clamped - (10 - 10 * 0.9) / 10)).toBeLessThan(1e-9);
  // Always a sane multiplier.
  expect(clamped >= 0.0 && clamped <= 1.0).toBe(true);
});

test("estimate_kv_override", () => {
  // kvMb=null → byte-identical to the fitted KV term; a small REAL KV (iSWA models)
  // undercuts the projection.
  const c = cfg();
  const base = fit.estimateVramMb({ gpuLayers: 16, ...c });
  expect(fit.estimateVramMb({ gpuLayers: 16, kvMb: null, ...c })).toBe(base);
  expect(fit.estimateVramMb({ gpuLayers: 16, kvMb: 450.0, ...c })).toBeLessThan(base);
});

test("max_gpu_layers_inverts_estimate", () => {
  const c = cfg();
  const budget = 4000.0;
  const n = fit.maxGpuLayers({ vramBudgetMb: budget, ...c });
  expect(n >= 0 && n <= 32).toBe(true);
  expect(fit.estimateVramMb({ gpuLayers: n, ...c })).toBeLessThanOrEqual(budget);
  if (n < 32) expect(fit.estimateVramMb({ gpuLayers: n + 1, ...c })).toBeGreaterThan(budget);
});

test("max_gpu_layers_clamps", () => {
  const c = cfg();
  expect(fit.maxGpuLayers({ vramBudgetMb: 1_000_000, ...c })).toBe(32); // huge → all layers
  expect(fit.maxGpuLayers({ vramBudgetMb: 0, ...c })).toBe(0);
  expect(fit.maxGpuLayers({ vramBudgetMb: 500, ...c })).toBe(0); // below base overhead
});

test("marginal_drops_exactly_the_base_offset", () => {
  // A co-resident model (the speculative-decode draft) pays the slope but NOT the
  // per-in-use-GPU base constant, which the first model already paid.
  const c = cfg();
  const full = fit.estimateVramMb({ gpuLayers: 32, ...c });
  const marginal = fit.marginalVramMb({ gpuLayers: 32, ...c });
  expect(marginal).toBe(full - fit._C5);
  expect(marginal).toBeGreaterThan(0);
});

test("marginal_floors_at_zero_for_a_tiny_model", () => {
  // A draft small enough that the slope can't cover the base offset must not return a
  // NEGATIVE budget credit.
  const tiny = fit.marginalVramMb({ gpuLayers: 1, ...cfg({ sizeMb: 1, nLayers: 1, ctxSize: 512 }) });
  expect(tiny).toBe(0.0);
});

test("gqa_reduces_kv_cost", () => {
  // More KV heads (MHA) ⇒ more VRAM/layer ⇒ no more layers fit than GQA.
  const mha = fit.maxGpuLayers({ vramBudgetMb: 4000, ...cfg({ nKvHeads: 32 }) });
  const gqa = fit.maxGpuLayers({ vramBudgetMb: 4000, ...cfg({ nKvHeads: 8 }) });
  expect(gqa).toBeGreaterThanOrEqual(mha);
});

// ── The physics decomposition + the regression-as-oracle (fit-redesign Phase 1) ──────

test("regression_oracle_dense_domain", () => {
  // §7.1 — THE oracle: on the regression's OWN fitted domain (dense models, full offload,
  // CUDA), the physics decomposition must agree with it. Band measured 2026-08-13 at
  // 1.016–1.088 (physics a few % conservative — the safe direction); pinned at [0.95, 1.15].
  const denseCases = [
    [4400, 32, 8, 4096, 4096],
    [6700, 48, 16, 3840, 8192],
    [6700, 48, 16, 3840, 32768],
    [13000, 40, 8, 5120, 8192],
    [24000, 80, 8, 8192, 4096],
    [42000, 80, 64, 8192, 8192],
    [2000, 24, 4, 2048, 16384],
  ];
  for (const [size, layers, kvh, emb, ctx] of denseCases) {
    const reg = fit.estimateVramMb({
      sizeMb: size,
      nLayers: layers,
      nKvHeads: kvh,
      embeddingDim: emb,
      ctxSize: ctx,
      cacheType: 16,
      gpuLayers: layers,
    });
    const kv = fit.kvExactMb({
      nLayers: layers,
      nKvHeads: kvh,
      ctxSize: ctx,
      cacheType: 16,
      embeddingDim: emb,
      headCount: Math.max(1, Math.floor(emb / 128)),
    });
    const phy = fit.physicsVramMb({
      sizeMb: size,
      nLayers: layers,
      gpuLayers: layers,
      moeShare: 1.0,
      kvMb: kv,
      overheadMb: fit.PHYSICS_OVERHEAD_MB.cuda,
    });
    expect(phy / reg, String([size, layers, kvh, emb, ctx, phy, reg])).toBeGreaterThanOrEqual(0.95);
    expect(phy / reg, String([size, layers, kvh, emb, ctx, phy, reg])).toBeLessThanOrEqual(1.15);
  }
});

test("physics_gold_check_flagship_config", () => {
  // §7.5 — the 2026-07-24 gold check, physics edition: the real Gemma-4 26B header at the
  // incident config (ngl 30 / ncmoe 21 / ctx 32k iSWA-KV 881 MB) measured 6.5–7.9 GB.
  const share = fit.moeGpuSizeShare({ nLayers: 30, gpuLayers: 30, nCpuMoe: 21, expertShare: 0.9389 });
  const booked = fit.physicsVramMb({
    sizeMb: 14249,
    nLayers: 30,
    gpuLayers: 30,
    moeShare: share,
    kvMb: 881,
    overheadMb: fit.PHYSICS_OVERHEAD_MB.cuda,
  });
  expect(booked).toBeGreaterThanOrEqual(6500);
  expect(booked).toBeLessThanOrEqual(7900);
});

test("physics_term_behaviors", () => {
  const common = { sizeMb: 10000, nLayers: 40, moeShare: 1.0, kvMb: 400, overheadMb: fit.PHYSICS_OVERHEAD_MB.cuda };
  // zero GPU layers → zero (no device context is created)
  expect(fit.physicsVramMb({ gpuLayers: 0, ...common })).toBe(0.0);
  // monotone in gpuLayers; full offload = weights + kv + overhead exactly
  const half = fit.physicsVramMb({ gpuLayers: 20, ...common });
  const full = fit.physicsVramMb({ gpuLayers: 40, ...common });
  expect(half > 0 && half < full).toBe(true);
  expect(full).toBe(10000 + 400 + fit.PHYSICS_OVERHEAD_MB.cuda);
  // expert stripping shrinks the device share
  const stripped = fit.moeGpuSizeShare({ nLayers: 40, gpuLayers: 40, nCpuMoe: 40, expertShare: 0.94 });
  expect(fit.physicsVramMb({ gpuLayers: 40, ...common, moeShare: stripped })).toBeLessThan(full);
});

test("kv_exact_uniform_math", () => {
  // 30 layers × 16 kv-heads × (128+128) dims × 4096 tokens × 2 B (f16)
  const kv = fit.kvExactMb({ nLayers: 30, nKvHeads: 16, ctxSize: 4096, cacheType: 16, keyLength: 128, valueLength: 128 });
  expect(Math.abs(kv - (30 * 16 * 256 * 4096 * 2) / (1024 * 1024))).toBeLessThan(0.01); // MiB since 2026-09-19
  // q8_0 cache halves it; missing dims fall back to embedding/headCount
  expect(fit.kvExactMb({ nLayers: 30, nKvHeads: 16, ctxSize: 4096, cacheType: 8, keyLength: 128, valueLength: 128 })).toBe(
    kv / 2,
  );
  const fb = fit.kvExactMb({ nLayers: 30, nKvHeads: 16, ctxSize: 4096, cacheType: 16, embeddingDim: 2048, headCount: 16 });
  expect(Math.abs(fb - kv)).toBeLessThan(0.01); // 2048/16 = 128 → same dims
  expect(fit.kvExactMb({ nLayers: 0, nKvHeads: 16, ctxSize: 4096, cacheType: 16 })).toBe(0.0);
});

test("estimate_guards_degenerate_negative_slope", () => {
  // Out-of-domain guard (fit-redesign §1.2/§4 0.2): a max-offload MoE strips ~94-98% of
  // layer bytes, the fitted −18 MB/layer credit flips the slope negative, and the unguarded
  // regression claimed each extra GPU layer FREES VRAM. Qwen-shaped inputs.
  const qwenShaped = cfg({ sizeMb: 350, nLayers: 41, nKvHeads: 2, embeddingDim: 2048 });
  const lo = fit.estimateVramMb({ gpuLayers: 0, ...qwenShaped });
  const hi = fit.estimateVramMb({ gpuLayers: 41, ...qwenShaped });
  expect(hi).toBeGreaterThanOrEqual(0);
  expect(hi).toBeGreaterThanOrEqual(lo); // never decreasing in gpuLayers
  // Mirrors maxGpuLayers' degenerate branch: the estimate is the base offset.
  expect(hi).toBe(lo);
});

// ── Phase 6: the joint MoE solve + the §13.9 measured-marginal pin ──────────────────

test("expert_layer_marginal_matches_measured", () => {
  // §13.9 — ≈0.41 GB VRAM freed per expert layer moved to RAM (the 26B ncmoe sweep). The
  // physics' central term must agree within ~15%. Derived through the real functions.
  const [sizeMb, layers, share] = [14249.047104, 30, 0.9388753056];
  const at = (nc) =>
    fit.physicsVramMb({
      sizeMb,
      nLayers: layers,
      gpuLayers: layers,
      moeShare: fit.moeGpuSizeShare({ nLayers: layers, gpuLayers: layers, nCpuMoe: nc, expertShare: share }),
      kvMb: 0.0,
      overheadMb: 0.0,
    });
  const perLayerGb = (at(20) - at(21)) / 1000.0;
  expect(Math.abs(perLayerGb - 0.446)).toBeLessThan(0.002); // the physics number itself
  expect(Math.abs(perLayerGb - 0.41) / 0.41).toBeLessThanOrEqual(0.15); // vs the measured 0.41
});

test("moe_joint_split_walks_the_smallest_fitting_ncmoe", () => {
  // The 26B shape on the margined 8 GB budget (draft already charged by the caller): all 30
  // layers stay on the GPU and just enough experts leave.
  const args = { sizeMb: 14249.0, nLayers: 30, expertShare: 0.9389, kvMb: 440.4, overheadMb: fit.PHYSICS_OVERHEAD_MB.cuda };
  const [ngl, nc] = fit.moeJointSplit({ budgetMb: 6782.0, ...args });
  expect(ngl).toBe(30);
  expect(nc >= 21 && nc <= 23).toBe(true);
  // A roomier budget needs fewer experts off; a 24 GB card needs none.
  const [, ncRoomy] = fit.moeJointSplit({ budgetMb: 10000.0, ...args });
  expect(ncRoomy).toBeLessThan(nc);
  expect(fit.moeJointSplit({ budgetMb: 23000.0, ...args })).toEqual([30, 0]);
});

test("moe_joint_split_falls_back_to_layer_shed", () => {
  // Non-expert bytes + KV alone exceed the budget → all experts to RAM AND layers walk down
  // through the same physics (never a stuck full pin).
  const [ngl, nc] = fit.moeJointSplit({
    sizeMb: 14249.0,
    nLayers: 30,
    expertShare: 0.9389,
    kvMb: 440.4,
    overheadMb: fit.PHYSICS_OVERHEAD_MB.cuda,
    budgetMb: 2200.0,
  });
  expect(nc).toBe(30);
  expect(ngl >= 0 && ngl < 30).toBe(true);
  // A dims-less MoE header (expertShare 0) has nothing to strip: the walk is flat, so the
  // fallback sheds layers directly.
  const res = fit.moeJointSplit({
    sizeMb: 10000.0,
    nLayers: 10,
    expertShare: 0.0,
    kvMb: 73.4,
    overheadMb: fit.PHYSICS_OVERHEAD_MB.cuda,
    budgetMb: 7168.0,
  });
  expect(res).toEqual([5, 10]);
});

// ── Phase 3: the decode-speed model (fit-redesign §5.5 corrected + §13.8) ───────────

test("active_bytes_per_pass_appendix_b_pins", () => {
  // The byte model's two Appendix-B pins: 26B MoE = 871 (non-expert) + 836 (active experts)
  // MB/pass; 12B dense = the whole file, no expert leg.
  let [ne, ae] = fit.activeBytesPerPassMb({ sizeMb: 14249, expertByteShare: 0.9389, expertsTotal: 128, expertUsed: 8 });
  expect(Math.abs(ne - 871)).toBeLessThan(5);
  expect(Math.abs(ae - 836)).toBeLessThan(5);
  [ne, ae] = fit.activeBytesPerPassMb({ sizeMb: 6716, expertByteShare: 0.0, expertsTotal: 0, expertUsed: 0 });
  expect([ne, ae]).toEqual([6716, 0.0]);
});

test("kv_mb_from_facts_scalars_and_fallback", () => {
  // Scalar path: Wb=0 (uniform) → Gb × ctx × bits/8; windowed term clamps at window.
  const facts = { kv_windowed_bytes_per_token: 0.0, kv_global_bytes_per_token: 8192.0, sliding_window: 0 };
  expect(Math.abs(fit.kvMbFromFacts(facts, 4096) - (8192 * 4096 * 2) / (1024 * 1024))).toBeLessThan(0.01); // MiB since 2026-09-19
  const windowed = { kv_windowed_bytes_per_token: 8192.0, kv_global_bytes_per_token: 0.0, sliding_window: 1024 };
  expect(Math.abs(fit.kvMbFromFacts(windowed, 32768) - (8192 * 1024 * 2) / (1024 * 1024))).toBeLessThan(0.01);
  // …and the SPEED path asks for decimal MB explicitly (decimal GB/s bandwidths).
  expect(Math.abs(fit.kvMbFromFacts(facts, 4096, 16, { unit: 1e6 }) - (8192 * 4096 * 2) / 1e6)).toBeLessThan(0.01);
  // No scalars → the kvExactMb dim heuristics (same fields identity used).
  const legacy = { block_count: 30, n_kv_heads: 16, embedding_length: 2048, head_count: 16 };
  expect(
    Math.abs(
      fit.kvMbFromFacts(legacy, 4096) -
        fit.kvExactMb({ nLayers: 30, nKvHeads: 16, ctxSize: 4096, cacheType: 16, embeddingDim: 2048, headCount: 16 }),
    ),
  ).toBeLessThan(0.01);
});

test("speed_bytes_split_placements", () => {
  // MoE on a discrete box with room: non-expert + KV device, active experts host.
  let [dev, host] = fit.speedBytesSplit({ nonExpertMb: 871, activeExpertMb: 836, kvMb: 545, onePool: false, weightBudgetMb: 6000 });
  expect([dev, host]).toEqual([871 + 545, 836]);
  // Dense that fits → all device; dense over budget → spills the overflow to host.
  [dev, host] = fit.speedBytesSplit({ nonExpertMb: 6716, activeExpertMb: 0, kvMb: 400, onePool: false, weightBudgetMb: 8000 });
  expect([dev, host]).toEqual([7116, 0]);
  [dev, host] = fit.speedBytesSplit({ nonExpertMb: 6716, activeExpertMb: 0, kvMb: 400, onePool: false, weightBudgetMb: 3558 });
  expect(Math.abs(dev - 3558) < 0.01 && Math.abs(host - 3558) < 0.01).toBe(true);
  // No budget → everything host. One pool → everything in the one (device) slot.
  [dev, host] = fit.speedBytesSplit({ nonExpertMb: 871, activeExpertMb: 836, kvMb: 545, onePool: false, weightBudgetMb: 0 });
  expect(dev === 0 && Math.abs(host - (871 + 545 + 836)) < 0.01).toBe(true);
  [dev, host] = fit.speedBytesSplit({ nonExpertMb: 871, activeExpertMb: 836, kvMb: 545, onePool: true, weightBudgetMb: 0 });
  expect(host === 0 && Math.abs(dev - (871 + 545 + 836)) < 0.01).toBe(true);
});

test("predict_decode_tok_s_serial_pools_and_honesty", () => {
  // 12B dense fully on the author's card: 6.716 GB / (448 × 0.6 = 268.8 GB/s effective) ≈ 40
  // tok/s — brackets the measured 39.1 (llama-bench, §5.5).
  const t = fit.predictDecodeTokS({ deviceMb: 6716, hostMb: 0, deviceBwGbps: 268.8, hostBwGbps: null });
  expect(t >= 35 && t <= 45).toBe(true);
  // The serial sum: adding a host leg SLOWS the total (err-slow shape).
  const both = fit.predictDecodeTokS({ deviceMb: 1416, hostMb: 836, deviceBwGbps: 268.8, hostBwGbps: 7.7 });
  const onlyHost = fit.predictDecodeTokS({ deviceMb: 0, hostMb: 836, deviceBwGbps: null, hostBwGbps: 7.7 });
  expect(both).toBeLessThan(onlyHost);
  // 26B at the app-leg shape → ~8.8 tok/s — same order as the measured un-sped leg (§5.5).
  expect(both >= 6 && both <= 12).toBe(true);
  // A pool with bytes but NO bandwidth → null, never a guess (§8.17's spirit).
  expect(fit.predictDecodeTokS({ deviceMb: 100, hostMb: 50, deviceBwGbps: 268.8, hostBwGbps: null })).toBeNull();
  expect(fit.predictDecodeTokS({ deviceMb: 0, hostMb: 0, deviceBwGbps: 268.8, hostBwGbps: 7.7 })).toBeNull();
});

test("speed_band_thresholds", () => {
  const kw = { fast: 20.0, fine: 8.0, slow: 2.0 };
  expect(fit.speedBand(39.0, kw)).toBe("fast");
  expect(fit.speedBand(8.0, kw)).toBe("fine");
  expect(fit.speedBand(7.9, kw)).toBe("slow");
  expect(fit.speedBand(1.5, kw)).toBe("painful");
  expect(fit.speedBand(null, kw)).toBe("");
  expect(fit.speedBand(0.0, kw)).toBe("");
});

test("band_deadzone_brackets_every_threshold", () => {
  // Speed-truth plan 2026-09-19 §5 — the author's-box case is the pin: 7.9 against the 8.0
  // fine-line is a coin flip, so no word.
  const kw = { fast: 20.0, fine: 8.0, slow: 2.0, frac: 0.1 };
  expect(fit.inBandDeadzone(7.9, kw)).toBe(true); // 1.25 % under fine
  expect(fit.inBandDeadzone(8.7, kw)).toBe(true); // 8.75 % over fine
  expect(fit.inBandDeadzone(19.0, kw)).toBe(true); // 5 % under fast
  expect(fit.inBandDeadzone(2.1, kw)).toBe(true); // 5 % over slow
  expect(fit.inBandDeadzone(7.1, kw)).toBe(false); // 11.25 % under fine → "slow" stands
  expect(fit.inBandDeadzone(12.0, kw)).toBe(false); // clear of every line
  expect(fit.inBandDeadzone(null, kw)).toBe(false); // unknown is not "near"
  expect(fit.inBandDeadzone(0.0, kw)).toBe(false);
  expect(fit.inBandDeadzone(7.9, { fast: 20.0, fine: 8.0, slow: 2.0, frac: 0.0 })).toBe(false); // 0 = off
  // A zeroed threshold never matches (a user may blank one out).
  expect(fit.inBandDeadzone(0.05, { fast: 20.0, fine: 8.0, slow: 0.0, frac: 0.1 })).toBe(false);
});

// ── vram-truth plan 2026-09-19 §6.3: exact placement, pinned to the ENGINE ────────────
// Fixture = the real files' per-block bytes (Appendix A reader) + llama.cpp b10437's own
// `llama-fit-params -fitp on` model-MiB per (ngl flag, n-cpu-moe) (plan §10.2). These pins
// are the engine's numbers, never this module's own arithmetic.

test("engine_gpu_blocks_follows_llama_cpp_i_gpu_start", () => {
  // llama-model.cpp: i_gpu_start = n + 1 − ngl; the output layer takes the first slot.
  expect(fit.engineGpuBlocks(30, 30)).toEqual(range(1, 30)); // block 0 on the CPU
  expect(fit.engineGpuBlocks(30, 31)).toEqual(range(0, 30)); // full offload
  expect(fit.engineGpuBlocks(30, 99)).toEqual(range(0, 30)); // clamps
  expect(fit.engineGpuBlocks(30, 1)).toEqual([]); // output layer only
  expect(fit.engineGpuBlocks(30, 0)).toEqual([]); // nothing on the GPU
  expect(fit.engineGpuBlocks(30, 10)).toEqual(range(21, 30)); // the LAST ngl−1 blocks
});

test("placed_weight_mib_matches_the_engine_on_every_config", () => {
  for (const [name, m] of Object.entries(VT)) {
    if (name.startsWith("_")) continue;
    for (const [c, engineMib] of Object.entries(m.engine_model_mib)) {
      const [flag, ncmoe] = c.split(",").map(Number);
      const got = fit.placedWeightMib({
        layerNonexp: m.layer_nonexp,
        layerExps: m.layer_exps,
        outputBytes: m.output_bytes,
        blockCount: m.block_count,
        nglFlag: flag,
        nCpuMoe: ncmoe,
      });
      expect(Math.abs(got - engineMib), String([name, c, got, engineMib])).toBeLessThan(1.0);
    }
  }
});

test("placed_weight_mib_is_zero_off_the_gpu", () => {
  const m = VT["gemma-4-26b-a4b-qat UD-Q4_K_XL"];
  expect(
    fit.placedWeightMib({
      layerNonexp: m.layer_nonexp,
      layerExps: m.layer_exps,
      outputBytes: m.output_bytes,
      blockCount: 30,
      nglFlag: 0,
      nCpuMoe: 0,
    }),
  ).toBe(0.0);
});
