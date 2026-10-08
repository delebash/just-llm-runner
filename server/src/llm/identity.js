// SPDX-License-Identifier: MIT
// Model identity auto-detection — the port of llm/identity.py. Read a model's GGUF header
// and ground its catalog capability fields in the FILE rather than a hand-typed guess:
// `type` (moe|dense from `expert_count`), `mtpBuiltin` (from `nextn_predict_layers`),
// `trained_ctx` (from `context_length`), and the recommended sampler baseline
// (`general.sampling.*`, else the origin repo's generation_config.json). Design
// docs/plans/2026-06-27-switch-and-preset-architecture S3 / D17 +
// docs/plans/2026-07-02-gguf-grounded-model-layer.md Phase 2 (in justwrite-app).
//
// MTP IS inferred here: a model with `nextn_predict_layers > 0` ships MTP draft layers (Qwen
// / GLM headers both carry `<arch>.nextn_predict_layers`).
//
// Port notes: `detectAndStoreModelType`, `backfillDerivedFromCache` and
// `inspectModelFromLink` are async (the sampler fallback and the inspect read the network);
// the pure helpers stay synchronous. Python's keyword-only arguments are an options object.
// The remote fetchers are called through their module namespaces (`ggufRemote.…`,
// `runnerModels.…`) so a test can spy them, as the Python tests monkeypatched them.

import { statSync } from "node:fs";
import { floorDiv, pyFloatParse, pyInt, pyRound, pyStr, truthy } from "../platform/py.js";
import { pyFormatG } from "../platform/pyjson.js";
import {
  estimateVramMb,
  kvMbFromFacts as fitKvMbFromFacts,
  MIB,
  moeGpuSizeShare,
  PHYSICS_OVERHEAD_MB,
  parseParams,
  physicsVramMb,
} from "../runner/fit.js";
import * as gguf from "../runner/gguf.js";
import * as ggufRemote from "../runner/gguf_remote.js";
import * as runnerModels from "../runner/models.js";
import * as stores from "./stores.js";

// The GGUF header + generation_config publish samplers in llama.cpp's OWN param namespace
// (temp, penalty_repeat, penalty_last_n, …); our knob catalog (seed.js Plane-2) + the run
// path (which passes flagName VERBATIM into the request) use different names for exactly
// three of them. Normalize file → catalog names at THIS read boundary so a seeded sampler
// actually applies at /v1/ai/run (seen = run) instead of landing as an unlabelled "Other
// keys" no-op. Only these three diverge — top_p/top_k/min_p/typical_p/xtc_*/mirostat*/dry_*
// already match the catalog.
const SAMPLER_FILE_TO_CATALOG = {
  temp: "temperature",
  penalty_repeat: "repeat_penalty",
  penalty_last_n: "repeat_last_n",
};

/**
 * A file-derived sampler value as a CLEAN string: GGUF floats arrive as float32 artifacts
 * ("0.949999988079071" for 0.95 — the user's Edit-form screenshot, 2026-07-07); round to 4
 * places and drop trailing zeros so what the form, the seeds, and the Lab grid show is the
 * number the file MEANS ("0.95", "1", "64"). Non-numeric values pass through verbatim.
 */
function fmtValue(v) {
  let f;
  try {
    if (v === null || v === undefined) throw new TypeError("float() argument must be a string or a real number");
    f = pyFloatParse(v);
  } catch {
    return pyStr(v);
  }
  // round(f, 4) is the identity past 1e21 (every such double is an integer) — and py.js's
  // pyRound can't take that range with nd > 0 (its toFixed turns exponential there).
  return pyFormatG(Math.abs(f) >= 1e21 ? f : pyRound(f, 4));
}

/**
 * Map a file-derived sampler dict from llama.cpp's param names to our knob-catalog names
 * (+ clean float32 noise), so stored + Lab-seeded samplers match the names AND the numbers
 * the run path sends. The ONE choke point every derive path flows through.
 */
export function canonicalizeSamplerNames(samplers) {
  const out = {};
  for (const [k, v] of Object.entries(samplers || {})) {
    out[Object.hasOwn(SAMPLER_FILE_TO_CATALOG, k) ? SAMPLER_FILE_TO_CATALOG[k] : k] = fmtValue(v);
  }
  return out;
}

/** `{k: str(v)}` over a sampler dict (the header's numbers, or generation_config's). */
const strValues = (d) => Object.fromEntries(Object.entries(d || {}).map(([k, v]) => [k, pyStr(v)]));

/** Capability type from GGUF metadata: a model is MoE iff it has experts. */
export function modelTypeFromMeta(meta) {
  return meta.expertCount > 0 ? "moe" : "dense";
}

/**
 * The PHYSICS FACTS (fit-redesign §13.11, Phase 2): immutable, config-independent
 * properties of the file, persisted so floors/est/badge compute FRESH at read instead of
 * being cached values that go stale. A stored fact may be DERIVED (`expert_byte_share`,
 * the KV scalars) but never config-dependent.
 *
 * The two KV scalars + `sliding_window` collapse `kvMbAtCtx`'s per-layer arrays into
 * `KV(ctx,bits) = [Wb × min(ctx,window) + Gb × ctx] × bits/8` — verified byte-identical to
 * the loop, including the `key_length_swa or key_length` fallback (baked into Wb here) and
 * the uniform case (no window pattern → Wb=0, every layer global). Snake keys: they mirror
 * the DB columns 1:1 through one dict.
 */
export function physicsFactsFromMeta(meta) {
  const nLayers = Math.max(0, meta.blockCount);
  let heads = meta.headCountKvPerLayer;
  if (heads.length !== nLayers) heads = new Array(nLayers).fill(meta.nKvHeads);
  // Per-head dims, with the same fallbacks kvExactMb uses: header dims, else
  // embedding/head_count, else 128 (the typical head_dim).
  const headDim = meta.headCount && meta.embeddingLength ? floorDiv(meta.embeddingLength, meta.headCount) : 0;
  const kG = meta.keyLength || headDim || 128;
  const vG = meta.valueLength || headDim || 128;
  const kW = meta.keyLengthSwa || kG;
  const vW = meta.valueLengthSwa || vG;
  const pattern =
    meta.slidingWindow > 0 && meta.slidingWindowPattern.length === nLayers
      ? meta.slidingWindowPattern
      : new Array(nLayers).fill(false);
  let wb = 0;
  let gb = 0;
  for (let i = 0; i < nLayers; i++) {
    if (pattern[i]) wb += heads[i] * (kW + vW);
    else gb += heads[i] * (kG + vG);
  }
  const known = !!meta.tensorBytesKnown;
  return {
    block_count: nLayers,
    n_kv_heads: pyInt(meta.nKvHeads || 0),
    head_count: pyInt(meta.headCount || 0),
    embedding_length: pyInt(meta.embeddingLength || 0),
    expert_used_count: pyInt(meta.expertUsedCount || 0),
    expert_byte_share: Number(meta.expertByteShare()),
    kv_windowed_bytes_per_token: Number(wb),
    kv_global_bytes_per_token: Number(gb),
    sliding_window: pyInt(meta.slidingWindow || 0),
    // Exact tensor bytes (vram-truth §6.2) — 0 when the table was not read.
    exps_bytes: known ? pyInt(meta.expsBytes) : 0,
    layers_nonexp_bytes: known ? pyInt(meta.layersNonexpBytes) : 0,
    output_bytes: known ? pyInt(meta.outputBytes) : 0,
  };
}

/**
 * KV size (MiB) at `ctx` from the STORED facts — the §13.11 scalar formula, byte-identical
 * to `kvMbAtCtx` (pinned by test). The formula lives in `runner/fit.js` (the runner's badge
 * speed model reads the same facts pre-download); this delegates — one source.
 */
export function kvMbFromFacts(facts, ctx, cacheBits = 16) {
  return fitKvMbFromFacts(facts, ctx, cacheBits);
}

// ctx the pre-download VRAM estimate is quoted at — a realistic working window, not the
// (often huge) trained max; capped by the model's own trained ctx. The spawn path
// recomputes fit precisely, so this is only the Add-form's "will it fit?" guess.
const ESTIMATE_CTX = 8192;

/**
 * [min_vram_mb, min_ram_mb, est_vram_mb] computed FRESH from the stored facts (fit-redesign
 * §13.11 — floors are never cached; improve the physics and every row's numbers improve on
 * the next read). RAW values — display snaps (§5.6).
 *
 * - min_vram: the canonical DISCRETE max-offload floor — non-expert device weights + KV at
 *   the floor ctx (§8.21) + the cuda overhead seed. "Can it run at all."
 * - min_ram: whole file + headroom (§13.13) — dense and MoE both end up holding the file.
 * - est_vram: full-residency want at a realistic 8K ctx — §8.5's frozen meaning, computed
 *   (§8.20); the embed co-load guard consumes it unchanged.
 * Returns [null, null, null] when the facts or size are absent — the caller falls back down
 * the fidelity ladder (stored/manifest values).
 */
export function computedRowNumbers(facts, sizeBytes, trainedCtx, { floorCtx = 4096, ramHeadroomMb = 4096 } = {}) {
  const nLayers = pyInt(facts.block_count || 0);
  if (!(truthy(sizeBytes) && nLayers > 0)) return [null, null, null];
  // ONE unit (vram-truth plan 2026-09-19 §6.4): these floors are compared with hardware
  // MiB, so they are MiB.
  const sizeMb = sizeBytes / MIB;
  const overhead = PHYSICS_OVERHEAD_MB.cuda;
  const estCtx = Math.min(trainedCtx || ESTIMATE_CTX, ESTIMATE_CTX);
  const minRam = sizeMb + Math.max(0, ramHeadroomMb);
  const layersNonexp = pyInt(facts.layers_nonexp_bytes || 0);
  if (layersNonexp > 0) {
    // EXACT (§6.3): every block + the output side on the card (the kit renders full
    // offload as n + 1 — vram-truth §5), experts in RAM for the floor.
    const out = pyInt(facts.output_bytes || 0);
    const exps = pyInt(facts.exps_bytes || 0);
    const minVram = (layersNonexp + out) / MIB + kvMbFromFacts(facts, floorCtx) + overhead;
    const est = (layersNonexp + exps + out) / MIB + kvMbFromFacts(facts, estCtx) + overhead;
    return [pyRound(minVram), pyRound(minRam), pyRound(est)];
  }
  const share = pyFloatParse(facts.expert_byte_share || 0.0);
  const maxOffload = moeGpuSizeShare({ nLayers, gpuLayers: nLayers, nCpuMoe: nLayers, expertShare: share });
  const minVram = physicsVramMb({
    sizeMb,
    nLayers,
    gpuLayers: nLayers,
    moeShare: maxOffload,
    kvMb: kvMbFromFacts(facts, floorCtx),
    overheadMb: overhead,
  });
  const est = physicsVramMb({
    sizeMb,
    nLayers,
    gpuLayers: nLayers,
    moeShare: 1.0,
    kvMb: kvMbFromFacts(facts, estCtx),
    overheadMb: overhead,
  });
  return [pyRound(minVram), pyRound(minRam), pyRound(est)];
}

/**
 * The catalog facts grounded in one GGUF header read: capability `type`, the `mtp_builtin`
 * flag, the trained context length, and the model's recommended sampler baseline. ONE
 * mapping, reused by the post-download identity path AND the pre-download inspect.
 */
export function derivedFieldsFromMeta(meta) {
  // general.size_label is the param count for a DENSE model ("27B"); a MoE label
  // ("128x9.4B", or an HF-style "235B-A22B") is an expert-config that does NOT decompose
  // to total/active params (GGUF spec) — so file-derive total_params ONLY for a DENSE model
  // whose label parses as a plain scale; null for every MoE (the `!isMoe` gate stops a
  // "235B-A22B" label clobbering the curated total) and for an unparseable label → the
  // curated value is preserved.
  const totalParams = !meta.isMoe && truthy(parseParams(meta.sizeLabel)) ? meta.sizeLabel : null;
  return {
    type: modelTypeFromMeta(meta),
    // HEADER truth only (`nextn_predict_layers>0`) → the `mtp_builtin` column. NEVER the
    // user-facing `mtp` ENABLE flag (2026-07-13 split — see setDerived).
    mtp_builtin: meta.isMtp,
    trained_ctx: meta.contextLength || null,
    total_params: totalParams,
    size_label: meta.sizeLabel,
    architecture: meta.architecture || "",
    experts: pyInt(meta.expertCount || 0),
    samplers: canonicalizeSamplerNames(strValues(meta.sampling || {})),
  };
}

/**
 * The Add-form VRAM estimate (full-GPU offload at a realistic 8K ctx), from the header
 * inputs + the real download size. ONE source for the pre-download inspect, the
 * post-download identify, and the seed-facts refresh — so a seeded row, a live
 * Read-from-link, and a downloaded file all show the SAME number (#141 parity). null when
 * the header lacks the layer count needed to estimate.
 */
export function estVramMbFromMeta(meta, totalBytes) {
  if (!(truthy(totalBytes) && meta.blockCount)) return null;
  return pyRound(
    estimateVramMb({
      // MiB — the regression's own unit (vram-truth §6.4; oobabooga's get_model_size_mb =
      // total_size / (1024 ** 2)).
      sizeMb: totalBytes / MIB,
      nLayers: meta.blockCount,
      nKvHeads: meta.nKvHeads,
      embeddingDim: meta.embeddingLength,
      ctxSize: Math.min(meta.contextLength || ESTIMATE_CTX, ESTIMATE_CTX),
      cacheType: 16,
      gpuLayers: meta.blockCount,
    }),
  );
}

/**
 * Read `ggufPath`'s GGUF header → set `model_catalog` `type`/`mtp_builtin`/`trained_ctx` +
 * replace `modelId`'s recommended sampler rows, and return the detected `type`.
 * `readMeta` / `store` are injectable for tests. When the header carries no
 * `general.sampling.*`, `samplersFallback(meta) → dict` (if given; may be async) supplies the
 * recommended samplers from the origin repo's generation_config.json (header →
 * generation_config → generic precedence). Preserves `built_in` (`setDerived`); never fails
 * the caller on a fallback error — sampler capture is advisory.
 */
export async function detectAndStoreModelType(
  modelId,
  ggufPath,
  { readMeta = gguf.readGgufMetadata, store = null, samplersFallback = null } = {},
) {
  const meta = await readMeta(ggufPath);
  const fields = derivedFieldsFromMeta(meta);
  if (!truthy(fields.samplers) && samplersFallback != null) {
    try {
      fields.samplers = canonicalizeSamplerNames(strValues((await samplersFallback(meta)) || {}));
    } catch {
      fields.samplers = {}; // the sampler fallback is advisory only
    }
  }
  // The quant-specific file size (#141): from the local file when it exists — best-effort
  // (an injected fake path in tests simply yields null).
  let sizeBytes;
  try {
    sizeBytes = statSync(String(ggufPath)).size;
  } catch {
    sizeBytes = null;
  }
  // Confirm the VRAM estimate from the real downloaded file (the panel's "confirmed at
  // download" promise) — same helper as the pre-download inspect, so the number never
  // drifts between the two reads.
  const estVramMb = estVramMbFromMeta(meta, sizeBytes);
  (store || stores.getModelCatalogStore()).setDerived(modelId, {
    modelType: fields.type,
    mtpBuiltin: fields.mtp_builtin,
    trainedCtx: fields.trained_ctx,
    totalParams: fields.total_params,
    samplers: fields.samplers,
    architecture: fields.architecture,
    experts: fields.experts,
    sizeLabel: fields.size_label,
    sizeBytes,
    estVramMb,
    physicsFacts: physicsFactsFromMeta(meta),
  });
  return fields.type;
}

/**
 * The seed-vs-file self-heal (2026-07-07, the read-from-link parity item): a DB reset
 * re-seeds catalog rows WITHOUT their file-derived facts (written by identify at DOWNLOAD
 * time only), so a model whose GGUF was already on disk shows "Recommended samplers —"
 * forever. For every row whose sampler set is EMPTY or whose architecture is empty (#141
 * added the identity facts — a row seeded before them lacks architecture even when its
 * samplers landed) and whose GGUF is cached, re-run identify from the local file. Pure
 * loop — `rows` are catalog rows (`.id`, `.samplers`, `.architecture`),
 * `cachedPathFn(id) → path|null`, `identifyOne(id, path)` does the store write (both may be
 * async); installLlm wires the real ones (in the background, local-file reads only). A
 * model whose file truly carries neither re-checks each boot — a local header read,
 * milliseconds, accepted over a staleness marker column.
 */
export async function backfillDerivedFromCache(rows, cachedPathFn, identifyOne) {
  let done = 0;
  for (const r of rows) {
    if (truthy(r.samplers ?? null) && truthy(r.architecture ?? "")) continue;
    const path = await cachedPathFn(r.id);
    if (!truthy(path)) continue;
    try {
      await identifyOne(r.id, path);
      done += 1;
    } catch {
      // a broken file must not stop the sweep
    }
  }
  return done;
}

// The real-RAM ladder a PC actually ships (GB) — the rungs the Add form's Min RAM floor is
// allowed to land on, so a hand-added model names a REAL machine size rather than an odd
// number no class ever matches.
const RAM_RUNGS_GB = [8, 10, 12, 16, 24, 32, 48, 64, 96, 128];
// OS + engine + KV + working set on top of the weights (the seeded rows' "overhead").
const RAM_HEADROOM_MB = 4096;

/**
 * The Add-form Min-RAM estimate, from the download size ALONE (nothing in the GGUF header
 * enters the rule). Transcribed from the seeded catalog's own documented basis (dense:
 * weights-in-RAM + overhead; MoE: the FULL model in RAM because experts offload to RAM):
 * ONE formula covers both, because both end up holding the whole file. So: file size in MB
 * (decimal) + 4096 MB headroom, snapped UP to the first rung of `RAM_RUNGS_GB` (returned in
 * MB). Past the top rung, the computed need is rounded up to the next 32 GB. Falsy size →
 * null: the form leaves the field blank rather than guess.
 *
 * KNOWN BLIND SPOT, left in place deliberately (user's call, 2026-07-27): the rule charges
 * the WHOLE model to RAM, which overstates a row that also carries a VRAM floor (GLM-4.5-Air
 * is the one seeded row where it crosses a rung). Over-stating a floor is the safe error for
 * a number whose job is to say "this will not fit"; fixing it means deciding how much of a
 * file to charge to VRAM — a design call. The seeded rows are NOT re-derived from this
 * function — it only fills a BLANK field on the Add/Edit form. (history + calibration:
 * llm/identity.py)
 */
export function estRamMbFromBytes(totalBytes) {
  if (!truthy(totalBytes)) return null;
  const needMb = Math.ceil(totalBytes / 1e6) + RAM_HEADROOM_MB;
  for (const rungGb of RAM_RUNGS_GB) if (needMb <= rungGb * 1024) return rungGb * 1024;
  const step = 32 * 1024;
  return Math.ceil(needMb / step) * step;
}

/**
 * PRE-download: range-read the GGUF header from the HF link (no weights) and return the
 * file-derived catalog facts + the real download size + a VRAM estimate, so the Add-a-model
 * form fills `type`/`mtp`/`trained_ctx`/`samplers`/size BEFORE a multi-GB download. The
 * pre-download sibling of `detectAndStoreModelType`; both share `derivedFieldsFromMeta` +
 * the generation_config sampler fallback.
 *
 * Feeds `estimateVramMb` the REAL header inputs + real size: the fit estimate is grounded in
 * the file, not the hand-typed `min_vram` guess.
 */
export async function inspectModelFromLink(repo, quant, revision = "main") {
  const [meta, total] = await ggufRemote.fetchGgufMeta(repo, quant, revision);
  const fields = derivedFieldsFromMeta(meta);
  if (!truthy(fields.samplers) && truthy(meta.baseRepoUrl)) {
    fields.samplers = canonicalizeSamplerNames(strValues(await ggufRemote.fetchGenerationConfigSamplers(meta.baseRepoUrl)));
  }
  const estVramMb = estVramMbFromMeta(meta, total);
  // Tier-C inherited drafter (2026-07-13): built-in MTP models need none, and the repo's
  // OWN drafts are pre-picked from the list-files listing — so only probe the official base
  // family when the header carries no built-in MTP. Best-effort; a miss (or any network
  // hiccup) simply yields no suggestion.
  let inherited = null;
  if (!fields.mtp_builtin) {
    try {
      inherited = await runnerModels.findInheritedMtpDrafter(repo, meta.architecture || "", meta.baseRepoUrl || "", revision);
    } catch {
      inherited = null; // discovery is advisory, never fails inspect
    }
  }
  const inh = inherited || {};
  const inhGet = (k) => (k in inh ? inh[k] : ""); // dict.get(k, "")
  return {
    architecture: meta.architecture,
    type: fields.type,
    // HEADER truth → the read-only "auto-detected" panel + the mtp_builtin column. The
    // user-facing MTP ENABLE flag is computed UI-side (builtin OR draft OR the inherited
    // drafter below), never overwritten by this read.
    mtpBuiltin: fields.mtp_builtin,
    trainedCtx: fields.trained_ctx,
    experts: meta.expertCount,
    sizeLabel: meta.sizeLabel,
    totalParams: fields.total_params || "",
    samplers: fields.samplers,
    sizeBytes: pyInt(total),
    estVramMb,
    // §13.11: the physics facts ride the inspect so the form's row PUT persists them — the
    // same facts the download identify writes (one extraction fn).
    physicsFacts: physicsFactsFromMeta(meta),
    // The Min-RAM floor's pre-download guess (size-only rule — see estRamMbFromBytes); the
    // VRAM estimate's mirror, so BOTH class floors arrive filled and a hand-added model can
    // belong to a PC class at all.
    estRamMb: estRamMbFromBytes(total),
    // Tier-C: a borrowable OFFICIAL drafter when the model has no MTP of its own.
    mtpInheritedRepo: inhGet("repo"),
    mtpInheritedFile: inhGet("file"),
    mtpInheritedQuant: inhGet("quant"),
  };
}
