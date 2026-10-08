// SPDX-License-Identifier: MIT
// VRAM-fit math for the local runner — pure functions, no I/O (the port of
// llm_runner/runner/fit.py). Every number matches Python's: the same IEEE operations in the
// same order, `//` as floorDiv, `math.floor` as Math.floor.
//
// Two estimates, for two moments:
//   * `coarseFit()` — a PRE-download band (ok/tight/no/cpu) from the manifest's params +
//     quant alone (no GGUF needed), for the catalog badge.
//   * `estimateVramMb()` / `maxGpuLayers()` — the PRECISE post-download estimate from real
//     GGUF metadata, used to choose `--n-gpu-layers` at spawn.
//
// `estimateVramMb` re-implements oobabooga's empirically-fitted GGUF VRAM formula — a
// regression over ~19,500 real VRAM measurements:
//     https://oobabooga.github.io/blog/posts/gguf-vram-formula/
// The formula and its fitted constants are a mathematical model (facts); this is our own
// implementation, not a copy of any source file. The spawn loop's OOM probe-and-back-off
// (process.js) stays the safety net for residual error, so this only needs to be an
// accurate first guess.
//
// Python's keyword-only arguments are one options object here (camelCase keys); tuples are
// arrays; `engineGpuBlocks` returns the index array its `range` held.

import { floorDiv, pyFloatParse, pyInt } from "../platform/py.js";

// ── Coarse pre-download estimate: params × effective bytes/weight ─────────────────────

// Effective bytes per weight for common GGUF quants, from public bits-per-weight tables /
// file-size measurements (a 7B Q4_K_M GGUF ≈ 4 GB ⇒ ≈ 0.6 B/param). Approximate — it only
// drives the COARSE catalog badge; the precise path uses the real GGUF file size.
const BYTES_PER_PARAM = {
  f32: 4.0,
  f16: 2.0,
  bf16: 2.0,
  q8_0: 1.06,
  q6_k: 0.82,
  q5_k_m: 0.71,
  q5_k_s: 0.69,
  q5_0: 0.71,
  q5_1: 0.77,
  q5_k: 0.7,
  q4_k_m: 0.6,
  q4_k_s: 0.57,
  q4_0: 0.59,
  q4_1: 0.65,
  q4_k: 0.6,
  iq4_xs: 0.53,
  iq4_nl: 0.56,
  q3_k_l: 0.53,
  q3_k_m: 0.49,
  q3_k_s: 0.44,
  q3_k: 0.49,
  iq3_xxs: 0.39,
  q2_k: 0.42,
  iq2_xxs: 0.26,
};

/** Effective bytes/weight for a quant string ('Q4_K_M', 'UD-Q4_K_XL', …). Falls back to a
 * known key prefix, then the leading Q<n> bit-width, then 0.6 (≈ a 4-bit K-quant). */
export function bytesPerParam(quant) {
  let q = (quant || "").trim().toLowerCase();
  if (q.startsWith("ud-")) q = q.slice(3);
  if (Object.hasOwn(BYTES_PER_PARAM, q)) return BYTES_PER_PARAM[q];
  for (const [key, val] of Object.entries(BYTES_PER_PARAM)) {
    if (q.startsWith(key)) return val; // e.g. unsloth 'q4_k_xl' → q4_k_* family
  }
  const m = /^q(\d+)/.exec(q);
  if (m) return Math.max(0.3, Number(m[1]) / 8 + 0.08); // bits/8 + a little K-quant overhead
  return 0.6;
}

/** '35B' → 35e9, '3.6B' → 3.6e9, '500M' → 5e8. null if unparseable. (A malformed number such
 * as '3.6.1B' throws ValueError, as Python's float() did.) */
export function parseParams(s) {
  if (!s) return null;
  const m = /^\s*([\d.]+)\s*([bBmM])/.exec(String(s));
  if (!m) return null;
  return pyFloatParse(m[1]) * ("bB".includes(m[2]) ? 1e9 : 1e6);
}

/** Estimated weight size in MiB from total params × effective bytes/weight (MiB — it is
 * compared against hardware MiB; vram-truth plan 2026-09-19 §6.4). */
export function weightsMb(totalParams, quant) {
  const p = parseParams(totalParams);
  return p === null ? null : (p * bytesPerParam(quant)) / MIB;
}

/**
 * Pre-download band: 'ok' | 'tight' | 'no' | 'cpu' | 'unknown'.
 *
 * Uses an explicit min-VRAM hint when the manifest sets one (it can encode MoE CPU-offload
 * that a raw weights estimate misses); otherwise computes params × bytes/weight — so a model
 * needs no hand-tuned number to get a badge.
 */
export function coarseFit({
  totalParams,
  quant,
  vramMb,
  ramMb,
  marginMb,
  minVramOverride = null,
  minRamOverride = null,
}) {
  // RAW-TO-RAW (fit-redesign §13.5, Phase 2): floors arrive RAW (computed fresh from the
  // physics facts — file + headroom, never a nominal rung), so detected RAM compares
  // directly and the rung-vs-detected bug class (32,690 vs a 32,768 rung — fails forever,
  // 0.24% short) is unrepresentable. Snapping detected RAM against a raw floor would
  // FALSE-FAIL carve-out boxes (13.7 GB usable snaps DOWN to 12 and misses a 13 GB floor the
  // box holds). Legacy rung floors in a pre-reset DB may misread until the reset — the
  // accepted pre-release cost (no migrations; the user resets).
  if (vramMb <= 0) {
    // CPU-only box: runs on CPU unless RAM can't even hold the model.
    const floor = minRamOverride || weightsMb(totalParams, quant);
    if (floor && ramMb && ramMb < floor) return "no";
    return "cpu";
  }
  // A GPU box still needs enough system RAM: a MoE offloads its experts to RAM
  // (`--n-cpu-moe`), so an 8 GB-VRAM / 16 GB-RAM box cannot run a 32–64 GB-RAM MoE no matter
  // how the active path fits VRAM. Gate on the DECLARED RAM floor only; absent → no RAM gate.
  if (minRamOverride && ramMb && ramMb < minRamOverride) return "no";
  const need = minVramOverride ? Number(minVramOverride) : weightsMb(totalParams, quant);
  if (!need) return "unknown";
  const ratio = need / Math.max(vramMb - marginMb, 1);
  if (ratio <= 1.0) return "ok";
  if (ratio <= 1.5) return "tight";
  return "no";
}

// ── Precise post-download estimate: oobabooga's fitted GGUF VRAM formula ───────────────

/** KV-cache element bit-width the formula expects: q4_0→4, q8_0→8, else 16. */
export function cacheTypeBits(cacheTypeK) {
  const k = (cacheTypeK || "").trim().toLowerCase();
  const bits = { q4_0: 4, q8_0: 8 };
  return Object.hasOwn(bits, k) ? bits[k] : 16;
}

// Fitted constants from oobabooga's GGUF VRAM regression (see the header).
export const _C0 = 17.99552795246051;
export const _C1 = 3.148552680382576e-5;
export const _C2 = 0.9690636483914102;
export const _C3 = 50.77817218646521;
export const _C4 = 9.987899908205632;
export const _C5 = 1516.522943869404;

/** The regression's per-layer, per-context-token KV factor (`n_kv_heads × cache-type
 * bit-width`) — the ONE source of the KV term (model-per-hardware plan, 1b-F3). `slopeOffset`
 * consumes it inside the fitted slope and `kvAffordable` consumes it to bound the computed
 * ctx; extracting it keeps the two from ever drifting. */
export function kvBytesPerToken(nKvHeads, cacheType) {
  return Math.max(1, nKvHeads) * Math.max(1, cacheType);
}

/** [A, B, C] for the linear-in-gpu_layers model  vram = A·(gpu_layers + B) + C.
 *
 * `kvMb` (2026-07-24, the iSWA-honest KV): when the caller computed the model's REAL
 * whole-model KV size from per-layer header facts (`GgufMeta.kvMbAtCtx` — interleaved
 * sliding-window models, where the regression's uniform full-ctx KV projection overbooks by
 * GBs), it replaces the fitted `_C1` KV term with `kvMb / nLayers` per layer. null (every
 * non-iSWA model) → the fitted term, byte-identical to before. */
function slopeOffset(sizeMb, nLayers, nKvHeads, embeddingDim, ctxSize, cacheType, kvMb = null) {
  nLayers = Math.max(1, nLayers);
  ctxSize = Math.max(1, ctxSize);
  const sizePerLayer = sizeMb / nLayers;
  const kvPerLayer = kvMb !== null && kvMb !== undefined ? kvMb / nLayers : _C1 * kvBytesPerToken(nKvHeads, cacheType) * ctxSize;
  const embeddingPerContext = embeddingDim / ctxSize;
  const a = sizePerLayer - _C0 + kvPerLayer;
  const b = Math.max(_C2, cacheType - (Math.floor(_C3 * embeddingPerContext) + _C4));
  return [a, b, _C5];
}

// The ladder the computed-ctx knob walks — power-of-two context sizes models actually
// train/serve at; the smallest rung is the floor every model is granted.
const CTX_LADDER = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
// Share of the VRAM budget the KV cache may claim when WE pick the context for an UNTUNED
// model (the rest stays for weights + compute). A first-principles split, BOX-GATED: the §G
// check "computed ctx == 32768 on the 2070S" calibrates it against the one machine with a
// measured optimum; a tune's explicit ctx always wins over this.
const KV_CTX_SHARE = 0.5;

/** Largest ladder ctx whose PROJECTED whole-model KV cost fits `KV_CTX_SHARE` of the VRAM
 * budget — the ctx-POLICY half of the 1b division (we pick ctx as a product decision;
 * upstream `--fit` places tensors at it). Per-ctx-token MB ≈ `_C1 × factor × nLayers`. A
 * zero/CPU budget returns the ladder floor. */
export function kvAffordable({ vramBudgetMb, nLayers, nKvHeads, cacheType }) {
  const budget = Math.max(0.0, vramBudgetMb) * KV_CTX_SHARE;
  const perCtxMb = _C1 * kvBytesPerToken(nKvHeads, cacheType) * Math.max(1, nLayers);
  let best = CTX_LADDER[0];
  for (const ctx of CTX_LADDER) {
    if (perCtxMb * ctx <= budget) best = ctx;
    else break;
  }
  return best;
}

/** Predicted VRAM (MiB) to offload `gpuLayers` of this GGUF at `ctxSize`. `kvMb`: the
 * precise whole-model KV size when the header supports it (iSWA models — see slopeOffset);
 * null → the fitted KV term as ever. */
export function estimateVramMb({ sizeMb, nLayers, nKvHeads, embeddingDim, ctxSize, cacheType, gpuLayers, kvMb = null }) {
  const [a, b, c] = slopeOffset(sizeMb, nLayers, nKvHeads, embeddingDim, ctxSize, cacheType, kvMb);
  if (a <= 0) {
    // Degenerate slope — the regression run OUT OF ITS DOMAIN (a max-offload MoE strips
    // 94-98% of each layer's bytes and the fitted −18 MB/layer credit flips the slope: the
    // real Qwen3.6-35B header gives a = −1.24 MB/layer, fit-redesign §1.2). A negative slope
    // claims each extra GPU layer FREES VRAM — garbage. Mirror `maxGpuLayers`' guard: the
    // estimate is the base offset, independent of gpuLayers.
    return Math.max(0.0, c);
  }
  return a * (gpuLayers + b) + c;
}

/** Predicted VRAM for a SECOND model sharing an already-in-use GPU — the same regression
 * MINUS its base offset `_C5` (≈1.5 GB), floored at 0.
 *
 * `_C5` is the fitted per-in-use-GPU constant (CUDA context, scratch/compute buffers): it is
 * paid ONCE, by the model that puts the GPU to work. Charging it again to a co-resident
 * model would double-count ~1.5 GB and needlessly shed main-model layers. The co-resident's
 * own weights AND its KV cache DO ride in the slope. THE consumer is computeFit's
 * speculative-decode draft term (2026-07-19). */
export function marginalVramMb({ sizeMb, nLayers, nKvHeads, embeddingDim, ctxSize, cacheType, gpuLayers }) {
  return Math.max(0.0, estimateVramMb({ sizeMb, nLayers, nKvHeads, embeddingDim, ctxSize, cacheType, gpuLayers }) - _C5);
}

/** Multiplier on the WHOLE-FILE weight size so the regression's per-layer size term reflects
 * what `--n-cpu-moe` actually leaves on the GPU (2026-07-24; the arbiter over-booking defect:
 * Gemma 26B at ngl 30 / ncmoe 21 booked 20.6 GB against a measured ~6.5 GB).
 *
 * Of the `gpuLayers` offloaded layers, the first `nCpuMoe` keep only their non-expert bytes
 * on the GPU (share `1 - expertShare`); the rest carry full layers. Overlap =
 * min(nCpuMoe, gpuLayers) — the box-measured semantics. `expertShare` from the GGUF header
 * (`GgufMeta.expertByteShare`); 0 (dense / unknown dims / ncmoe 0) → 1.0, the exact
 * pre-2026-07-24 estimate. The KV term rides the layer count, deliberately untouched. */
export function moeGpuSizeShare({ nLayers, gpuLayers, nCpuMoe, expertShare }) {
  const g = Math.min(Math.max(0, gpuLayers), Math.max(1, nLayers));
  if (g <= 0 || expertShare <= 0) return 1.0;
  const stripped = Math.min(Math.max(0, nCpuMoe), g); // GPU layers whose experts sit in RAM
  const share = (g - stripped * expertShare) / g;
  return Math.max(0.0, Math.min(1.0, share));
}

// ── The physics decomposition (fit-redesign Phase 1, §5.1) ───────────────────────────
// Compute what physics determines; the fitted regression above stays as the CI oracle on its
// dense-CUDA domain (§7.1) and as the inverse-split chooser until the joint solve. Terms:
// device-resident weights (placement share) + exact KV + a per-backend overhead seed.
// Scratch/compute buffers ride inside the overhead seed until Phase 5 learns their
// coefficient per machine (§13.6).

// ONE unit for the VRAM path (vram-truth plan 2026-09-19 §6.4): every budget and measurement
// is MiB (hardware's // 1024²), so every weight / KV / draft figure compared against them is
// MiB too. The SPEED path stays decimal MB against decimal GB/s.
export const MIB = 1024 * 1024;
// Bump when the byte model changes: `__overhead__` rows carry it in their label so a new
// model re-learns its overhead instead of reading one learned under the old.
export const PHYSICS_VERSION = "p2";

/** Block indices llama.cpp puts on the GPU for an EMITTED `-ngl` value (b9993/b10437
 * `llama-model.cpp`: `i_gpu_start = n_layer + 1 - ngl`, `act = min(ngl, n_layer + 1)`): the
 * output layer goes first, then the LAST ngl - 1 blocks — `-ngl n` leaves block 0 on the CPU;
 * n + 1 is full offload. (An array; Python returned the `range`.) */
export function engineGpuBlocks(blockCount, nglFlag) {
  if (nglFlag <= 0 || blockCount <= 0) return [];
  const start = Math.max(blockCount + 1 - nglFlag, 0);
  const out = [];
  for (let i = Math.min(start, blockCount); i < blockCount; i++) out.push(i);
  return out;
}

/** EXACT device-resident weight MiB for a launch, from the tensor table: the output side
 * (any ngl >= 1 — incl. a tied head's duplicated vocab table) + every GPU block's non-expert
 * bytes + the expert bytes of GPU blocks >= nCpuMoe (`--n-cpu-moe N` keeps the FIRST N
 * blocks' experts in RAM). Validated against llama.cpp's own estimator on 11 configs to
 * < 1 MiB (plan §10.2). */
export function placedWeightMib({ layerNonexp, layerExps, outputBytes, blockCount, nglFlag, nCpuMoe }) {
  if (nglFlag <= 0) return 0.0;
  let total = pyInt(outputBytes);
  for (const i of engineGpuBlocks(blockCount, nglFlag)) {
    total += i < layerNonexp.length ? layerNonexp[i] : 0;
    if (i >= nCpuMoe && i < layerExps.length) total += layerExps[i];
  }
  return total / MIB;
}

// Per-backend overhead seeds (MiB): CUDA context + scratch at typical ubatch — cuda inherits
// the regression's fitted per-in-use-GPU offset `_C5` (the value Appendix A's first-principles
// floors validated); vulkan/rocm = cuda + a DOCUMENTED margin (no fitted data — provenance
// 'seed-guess', self-corrected by Phase 5's persisted true-ups); metal = a conservative
// one-pool constant (same provenance). NOT operator knobs — seed values, not tunables.
export const PHYSICS_OVERHEAD_MB = {
  cuda: _C5,
  vulkan: _C5 + 512.0,
  rocm: _C5 + 512.0,
  metal: 1024.0,
  cpu: 0.0,
};

/** Exact whole-model KV size (MiB by default; `unit=1e6` for the decimal-MB SPEED path) for
 * a UNIFORM-attention model — the §5.1 generalization of `GgufMeta.kvMbAtCtx` (which stays
 * the source for iSWA models). Per layer, per token: kv_heads × (key_dim + value_dim) ×
 * cache_bytes. Missing per-head dims fall back to embeddingDim / headCount, then 128 (the
 * typical head_dim). */
export function kvExactMb({
  nLayers,
  nKvHeads,
  ctxSize,
  cacheType,
  keyLength = 0,
  valueLength = 0,
  embeddingDim = 0,
  headCount = 0,
  unit = 0.0,
}) {
  if (nLayers <= 0 || nKvHeads <= 0 || ctxSize <= 0) return 0.0;
  let headDim = 0;
  if (headCount > 0 && embeddingDim > 0) headDim = floorDiv(embeddingDim, headCount);
  const k = keyLength || headDim || 128;
  const v = valueLength || headDim || 128;
  const bytesPerElem = Math.max(1, cacheType) / 8.0;
  return (nLayers * nKvHeads * (k + v) * ctxSize * bytesPerElem) / (unit || MIB);
}

/** float(x) / int(x) of a stored fact (a number, or a numeric string). */
const factFloat = (v) => pyFloatParse(v || 0.0);
const factInt = (v) => pyInt(v || 0);

/** KV size at `ctx` from the STORED physics facts (snake keys, as stored) — MiB by default
 * (the VRAM path compares it with hardware MiB); the SPEED path passes `{unit: 1e6}` because
 * its bandwidths are decimal GB/s (vram-truth plan §6.4). The facts — the §13.11 scalar
 * formula `KV(ctx,bits) = [Wb × min(ctx,window) + Gb × ctx] × bits/8`, byte-identical to
 * `GgufMeta.kvMbAtCtx`'s per-layer loop. Lives HERE because the runner's badge speed model
 * reads the same facts pre-download; identity delegates — one source. Scalars absent (legacy
 * row) → `kvExactMb`'s dim heuristics. */
export function kvMbFromFacts(facts, ctx, cacheBits = 16, { unit = 0.0 } = {}) {
  const wb = factFloat(facts.kv_windowed_bytes_per_token);
  const gb = factFloat(facts.kv_global_bytes_per_token);
  const window = factInt(facts.sliding_window);
  if (wb || gb) {
    return ((wb * Math.min(ctx, window > 0 ? window : ctx) + gb * ctx) * (cacheBits / 8.0)) / (unit || MIB);
  }
  return kvExactMb({
    nLayers: factInt(facts.block_count),
    nKvHeads: factInt(facts.n_kv_heads),
    ctxSize: ctx,
    cacheType: cacheBits,
    embeddingDim: factInt(facts.embedding_length),
    headCount: factInt(facts.head_count),
    unit,
  });
}

// ── The decode-speed model (fit-redesign Phase 3, §5.5 as corrected 2026-08-13) ────────
// decode ceiling ≈ bytes touched per forward pass ÷ effective bandwidth of the pool those
// bytes live in. Bytes/pass: dense = the whole file; MoE = non-expert bytes + the ACTIVE
// expert share (file × expert_byte_share × used/total) — plus a KV-read term at the live
// context (iSWA-aware). Pools are priced separately (streamed device reads vs scattered host
// expert gather are DIFFERENT physical processes — never one shared constant) and the
// per-pool times ADD: the serial sum is what Appendix B's host-constant derivation solved,
// and it is the conservative end of "slowest pool wins" (err-slow, §8.17). Speed predicts
// UN-SPED (§13.7 — no seeded acceptance constant); a real measurement outranks every
// prediction at display time.

/** [nonExpertMb, activeExpertMb] touched per forward pass. Dense (no expert dims) → [whole
 * file, 0]. Appendix B pins: 26B = 871 + 836 MB; 12B dense = 6716 + 0 MB. */
export function activeBytesPerPassMb({ sizeMb, expertByteShare, expertsTotal, expertUsed }) {
  sizeMb = Math.max(0.0, sizeMb);
  const share = Math.max(0.0, Math.min(1.0, expertByteShare));
  if (share <= 0 || expertsTotal <= 0 || expertUsed <= 0) return [sizeMb, 0.0];
  const used = Math.min(expertUsed, expertsTotal);
  return [sizeMb * (1.0 - share), sizeMb * share * (used / expertsTotal)];
}

/** [deviceMb, hostMb] read per pass under the CANONICAL placement the verdict prices
 * (max-offload: experts in host RAM, everything else device). `weightBudgetMb` = VRAM budget
 * already net of margin + backend overhead. Dense that fits → all device; dense/attention
 * overflow spills to host by byte fraction (the partial-offload trap honestly reads slow); no
 * budget → everything host; one-pool boxes put every byte in the ONE pool (device slot — the
 * caller prices it at the pool's bandwidth). */
export function speedBytesSplit({ nonExpertMb, activeExpertMb, kvMb, onePool, weightBudgetMb }) {
  const deviceWant = Math.max(0.0, nonExpertMb) + Math.max(0.0, kvMb);
  if (onePool) return [deviceWant + Math.max(0.0, activeExpertMb), 0.0];
  const budget = Math.max(0.0, weightBudgetMb);
  const frac = deviceWant <= budget ? 1.0 : deviceWant > 0 ? budget / deviceWant : 0.0;
  const device = deviceWant * frac;
  const host = Math.max(0.0, activeExpertMb) + deviceWant * (1.0 - frac);
  return [device, host];
}

/** Predicted UN-SPED decode tok/s from the per-pool byte split and the EFFECTIVE per-pool
 * bandwidths (raw × efficiency family, or measurement-derived — the caller resolves the
 * ladder). Per-token time = Σ pool_bytes / pool_bw, pools serial. A pool with bytes but no
 * usable bandwidth → null: an unknown may never become a number (§8.17's spirit). */
export function predictDecodeTokS({ deviceMb, hostMb, deviceBwGbps, hostBwGbps }) {
  let totalS = 0.0;
  for (const [mb, bw] of [
    [deviceMb, deviceBwGbps],
    [hostMb, hostBwGbps],
  ]) {
    if (mb <= 0) continue;
    if (!bw || bw <= 0) return null;
    totalS += mb / 1000.0 / bw;
  }
  if (totalS <= 0) return null;
  return 1.0 / totalS;
}

/** tok/s → band label (§8.14: fast/fine/slow/painful; the ~`fine` line is reading speed).
 * null/non-positive → "" — never a fabricated band. */
export function speedBand(tokS, { fast, fine, slow }) {
  if (!tokS || tokS <= 0) return "";
  if (tokS >= fast) return "fast";
  if (tokS >= fine) return "fine";
  if (tokS >= slow) return "slow";
  return "painful";
}

/** true when a PREDICTED tok/s sits within `frac` of any band threshold (speed-truth plan
 * 2026-09-19 §5). The caller then ships band "" and the chip shows the number, because a
 * word there is a coin flip: the flagship on the author's box predicts 7.9 against a
 * fine-line of 8.0, and a ±2 % RAM-probe wobble crosses it. Callers apply this to
 * predictions only. frac ≤ 0 disables; a threshold ≤ 0 never matches. */
export function inBandDeadzone(tokS, { fast, fine, slow, frac }) {
  if (!tokS || tokS <= 0 || !frac || frac <= 0) return false;
  return [fast, fine, slow].some((t) => t > 0 && Math.abs(tokS - t) / t <= frac);
}

/** Predicted device-resident VRAM (MiB) from first principles: the weight bytes placement
 * leaves on the device (`moeShare` from `moeGpuSizeShare`, prorated by offloaded layers) +
 * the KV share riding those layers + the backend overhead. gpuLayers == 0 → 0 (no
 * CUDA/Metal context is created). This replaces the fitted regression for FORWARD booking
 * (§5.1); the regression survives as the CI oracle (§7.1) and the inverse chooser. */
export function physicsVramMb({ sizeMb, nLayers, gpuLayers, moeShare, kvMb, overheadMb }) {
  nLayers = Math.max(1, nLayers);
  const g = Math.max(0, Math.min(gpuLayers, nLayers));
  if (g <= 0) return 0.0;
  const weights = Math.max(0.0, sizeMb) * Math.max(0.0, Math.min(1.0, moeShare)) * (g / nLayers);
  const kv = Math.max(0.0, kvMb) * (g / nLayers);
  return weights + kv + Math.max(0.0, overheadMb);
}

/** [nGpuLayers, nCpuMoe] for an UNTUNED MoE on a two-pool box — the Phase 6 joint solve
 * (fit-redesign §5.7): pin ngl = nLayers and walk the SMALLEST ncmoe whose forward physics
 * estimate fits `budgetMb` (the caller passes it draft-charged). Expert offload is the cheap
 * knob — each step frees `size × expertShare / nLayers` (≈0.45 GB/layer on the 26B, the
 * §13.9-measured 0.41) while keeping attention + KV on the device; shedding a layer moves
 * those too, which is why the old inverse (ngl 8-9 on the 26B) never agreed with any measured
 * tune (ngl=all, ncmoe 21). Nothing fits even at ncmoe = nLayers → keep all experts in RAM and
 * walk ngl DOWN through the same physics (the spawn back-off nets residual error). Both walks
 * are monotone; a tiny loop, never a solver. `needFn(g, nc)` = the caller's EXACT booking
 * (tensor-table bytes placed by llama.cpp's rules — vram-truth §6.3); absent → the share
 * approximation. */
export function moeJointSplit({ sizeMb, nLayers, expertShare, kvMb, overheadMb, budgetMb, needFn = null }) {
  nLayers = Math.max(1, nLayers);
  const need = (g, nc) => {
    if (needFn !== null && needFn !== undefined) return needFn(g, nc);
    const share = moeGpuSizeShare({ nLayers, gpuLayers: g, nCpuMoe: nc, expertShare });
    return physicsVramMb({ sizeMb, nLayers, gpuLayers: g, moeShare: share, kvMb, overheadMb });
  };
  for (let nc = 0; nc <= nLayers; nc++) {
    if (need(nLayers, nc) <= budgetMb) return [nLayers, nc];
    if (expertShare <= 0 && (needFn === null || needFn === undefined)) break; // the walk is flat — go shed layers
  }
  for (let g = nLayers - 1; g >= 0; g--) {
    if (need(g, nLayers) <= budgetMb) return [g, nLayers];
  }
  return [0, nLayers];
}

/** Largest gpuLayers whose predicted VRAM fits the budget, clamped to [0, nLayers].
 * Closed-form inverse of `estimateVramMb` (linear in gpuLayers). */
export function maxGpuLayers({ sizeMb, nLayers, nKvHeads, embeddingDim, ctxSize, cacheType, vramBudgetMb }) {
  nLayers = Math.max(1, nLayers);
  if (vramBudgetMb <= 0 || sizeMb <= 0) return 0;
  const [a, b, c] = slopeOffset(sizeMb, nLayers, nKvHeads, embeddingDim, ctxSize, cacheType);
  if (a <= 0) return c <= vramBudgetMb ? nLayers : 0; // degenerate tiny per-layer cost: all layers fit if base overhead does
  return Math.max(0, Math.min(nLayers, Math.floor((vramBudgetMb - c) / a - b)));
}

// Exported under its Python name for test_runner.py`s kv_term_single_source_no_drift.
export { slopeOffset as _slopeOffset };
