// SPDX-License-Identifier: MIT
// Minimal GGUF header reader (the port of llm_runner/runner/gguf.py) — the metadata the
// model layer needs, from the header only (never the tensor data): the KV section AND, when
// the file's size is known, the tensor-info table — exact per-tensor bytes by offset delta,
// sorted by llama.cpp's own placement (vram-truth plan 2026-09-19 §6.1).
//
// Used two ways (docs/plans/2026-07-02-gguf-grounded-model-layer.md):
//   * LOCAL  — `readGgufMetadata(path)` on a downloaded `.gguf` (fit + identity).
//   * REMOTE — `readGgufMetadataFromStream(buffer)` on a range-read of the first few MB of a
//     `.gguf` on HuggingFace, so we know a model's facts BEFORE a multi-GB download
//     (gguf_remote.js).
//
// Extracts architecture, layer/head/expert counts, context length, the MTP signal
// (`<arch>.nextn_predict_layers`), the quant `file_type`, the author-recommended sampling
// (`general.sampling.*`), and the base-model repo url (for the generation_config.json
// sampling fallback). Array values (tokenizer tokens / merges / tags / …) are SKIPPED, never
// materialised — we never use them, and skipping keeps the remote range-read small +
// tolerant of a truncated header. Little-endian (the on-disk default for the official
// prebuilt quants). Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
// Key names VERIFIED 2026-07-03 against real Qwen3.6-27B (arch `qwen35`, dense+MTP) and
// GLM-4.5-Air (arch `glm4moe`, MoE+MTP) headers. The arch prefix is dynamic (read from
// `general.architecture`); `general.sampling.*` is real but patchy (Qwen ships it, GLM does
// not → fall back to generation_config.json via `baseRepoUrl`).
//
// JS shape: `GgufMeta` keeps one camelCase name per field (`meta.blockCount`). The readers are
// SYNCHRONOUS (a header is a few MB at most, read in 1 MB blocks), so the fit/identity paths
// that call them stay synchronous as they were in Python. A u64/i64 header value that does
// not fit a double exactly stays a BigInt; counts, lengths and offsets are plain numbers.

import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pyInt, pyMod, pyStr, truthy, ValueError } from "../platform/py.js";

const MAGIC = Buffer.from("GGUF", "latin1");

// ggml metadata value type -> [reader, byte width] for fixed scalars.
const SCALAR = new Map([
  [0, ["B", 1]], // UINT8
  [1, ["b", 1]], // INT8
  [2, ["H", 2]], // UINT16
  [3, ["h", 2]], // INT16
  [4, ["I", 4]], // UINT32
  [5, ["i", 4]], // INT32
  [6, ["f", 4]], // FLOAT32
  [7, ["?", 1]], // BOOL (1 byte)
  [10, ["Q", 8]], // UINT64
  [11, ["q", 8]], // INT64
  [12, ["d", 8]], // FLOAT64
]);
const TYPE_STRING = 8;
const TYPE_ARRAY = 9;

const sumOf = (xs) => xs.reduce((a, b) => a + b, 0);

/** One GGUF file's facts (Python's GgufMeta dataclass; same defaults). */
export class GgufMeta {
  constructor(fields = {}) {
    for (const k of ["architecture", "blockCount", "embeddingLength", "expertCount"]) {
      if (fields[k] === undefined) throw new TypeError(`GgufMeta() missing required argument: '${k}'`);
    }
    this.architecture = fields.architecture;
    this.blockCount = fields.blockCount; // transformer layers (n_layers)
    this.embeddingLength = fields.embeddingLength; // hidden dim
    this.expertCount = fields.expertCount; // > 0 => MoE
    this.headCount = fields.headCount ?? 0; // attention heads (n_head)
    this.headCountKv = fields.headCountKv ?? 0; // KV heads (n_head_kv); < headCount => GQA
    this.contextLength = fields.contextLength ?? 0; // trained context window
    this.expertUsedCount = fields.expertUsedCount ?? 0; // active experts per token (MoE)
    this.nextnPredictLayers = fields.nextnPredictLayers ?? 0; // > 0 => MTP
    this.fileType = fields.fileType ?? 0; // general.file_type (quant enum)
    // FFN dims (2026-07-24, the ncmoe-aware fit): the dense FFN width, the PER-EXPERT FFN
    // width, and the shared-expert FFN width — standard GGUF keys. 0 = absent;
    // `expertByteShare` then honestly returns 0 (no discount) rather than guessing.
    this.feedForwardLength = fields.feedForwardLength ?? 0;
    this.expertFeedForwardLength = fields.expertFeedForwardLength ?? 0;
    this.expertSharedFeedForwardLength = fields.expertSharedFeedForwardLength ?? 0;
    // iSWA facts (2026-07-24, the honest-KV term): interleaved sliding-window models (Gemma
    // 3/4) keep only a small window of KV on most layers, so the uniform full-ctx KV
    // projection overbooks by GBs (the real Gemma-4 26B header: 25/30 layers windowed at 1024
    // → real KV ~450 MB at 32k ctx vs ~5.4 GB projected). `slidingWindowPattern`: per-layer,
    // true = windowed layer; `head_count_kv` arrives PER-LAYER as an array on these arches
    // (read into headCountKvPerLayer; the scalar `headCountKv` stays 0 then). key/value
    // lengths are PER-HEAD dims (the _swa variants apply on windowed layers). Absent facts →
    // `kvMbAtCtx` returns null → the fitted-regression KV term as ever.
    this.headCountKvPerLayer = fields.headCountKvPerLayer ?? [];
    this.slidingWindow = fields.slidingWindow ?? 0;
    this.slidingWindowPattern = fields.slidingWindowPattern ?? [];
    this.keyLength = fields.keyLength ?? 0;
    this.valueLength = fields.valueLength ?? 0;
    this.keyLengthSwa = fields.keyLengthSwa ?? 0;
    this.valueLengthSwa = fields.valueLengthSwa ?? 0;
    // general.size_label — the param-scale label. Dense = the param count ("27B"); MoE = an
    // expert-config label ("128x9.4B") that does NOT decompose into total/active params.
    this.sizeLabel = fields.sizeLabel ?? "";
    // Author-recommended sampling baked into the header at conversion (general.sampling.*,
    // e.g. {temp: 1.0, top_k: 20, top_p: 0.95}) — llama.cpp key names, NOT our knob names.
    // Empty when the converter did not carry it (→ generation_config.json in baseRepoUrl).
    this.sampling = fields.sampling ?? {};
    // general.base_model.0.repo_url (else general.source.repo_url) — the ORIGINAL model repo.
    this.baseRepoUrl = fields.baseRepoUrl ?? "";
    // EXACT weight bytes from the tensor table (vram-truth plan 2026-09-19 §6.1), sized by
    // OFFSET DELTA (no quant-type table), sorted the way llama.cpp places them: per repeating
    // block, routed experts (EXPS_REGEX — what --n-cpu-moe moves) vs everything else; the
    // OUTPUT side (output.weight + output_norm, or — tied models — a DUPLICATE of
    // token_embd, which llama.cpp copies onto the output device); the INPUT side (token_embd
    // etc. — always on the CPU). Validated against the engine's own estimator on 11 configs
    // to < 1 MiB (plan §10.2). `tensorBytesKnown` false → callers fall back to
    // `expertByteShare()`.
    this.tensorBytesKnown = fields.tensorBytesKnown ?? false;
    this.layerNonexpBytes = fields.layerNonexpBytes ?? [];
    this.layerExpsBytes = fields.layerExpsBytes ?? [];
    this.outputBytes = fields.outputBytes ?? 0;
    this.inputBytes = fields.inputBytes ?? 0;
  }

  get expsBytes() {
    return sumOf(this.layerExpsBytes);
  }

  get layersNonexpBytes() {
    return sumOf(this.layerNonexpBytes);
  }

  get isMoe() {
    return this.expertCount > 0;
  }

  /** Multi-token-prediction (speculative) layers present in the file. */
  get isMtp() {
    return this.nextnPredictLayers > 0;
  }

  /** KV heads for the cache-size estimate — `headCountKv` when present (GQA/MQA), else
   * `headCount` (full multi-head), else 0 (unknown). */
  get nKvHeads() {
    return this.headCountKv || this.headCount;
  }

  /**
   * Fraction of a repeating layer's weight BYTES held by the routed-expert FFN tensors
   * (`ffn_*_exps`) — the tensors `--n-cpu-moe` keeps in system RAM. Structural, from header
   * dims only (uniform-quant assumption; bytes ∝ params):
   *
   *     experts   ≈ 3 · n_embd · expert_ff · expert_count      (gate/up/down × E)
   *     attention ≈ n_embd² · (2 + 2·kv_ratio)                 (q,o + GQA-scaled k,v)
   *     dense FFN ≈ 3 · n_embd · ff                            (when the arch has one)
   *     shared    ≈ 3 · n_embd · shared_ff                     (NOT moved by n-cpu-moe: its
   *                                                             tensors are *_shexp)
   *
   * Returns 0 for dense models or when the expert dims are absent — no guessed constants,
   * the caller then applies no discount. Attention uses head_dim·n_head ≈ n_embd; when head
   * counts are absent it falls back to MHA (kv_ratio 1), which OVERSTATES attention and
   * therefore UNDERSTATES the share — the conservative direction.
   *
   * FALLBACK ONLY since 2026-09-19: when the tensor table was read (`tensorBytesKnown`)
   * every consumer uses the exact bytes instead. Mixtral-style arches (Granite, Mixtral, …)
   * carry NO `expert_feed_forward_length` — their per-expert FFN IS `feed_forward_length`
   * and there is no dense FFN (plan §2.5).
   */
  expertByteShare() {
    if (this.expertCount <= 0 || this.embeddingLength <= 0) return 0.0;
    let expertFf = this.expertFeedForwardLength;
    let denseFf = this.feedForwardLength;
    if (expertFf <= 0 && denseFf > 0) {
      expertFf = denseFf; // the Mixtral-style header convention
      denseFf = 0;
    }
    if (expertFf <= 0) return 0.0;
    const nEmbd = Number(this.embeddingLength);
    const kvRatio = this.headCount > 0 && this.headCountKv > 0 ? this.headCountKv / this.headCount : 1.0;
    const attention = nEmbd * nEmbd * (2.0 + 2.0 * kvRatio);
    const denseFfn = 3.0 * nEmbd * Number(denseFf);
    const shared = 3.0 * nEmbd * Number(this.expertSharedFeedForwardLength);
    const experts = 3.0 * nEmbd * Number(expertFf) * this.expertCount;
    const total = attention + denseFfn + shared + experts;
    return total > 0 ? experts / total : 0.0;
  }

  /**
   * The PRECISE whole-model KV-cache size (MiB) at `ctx`, from the header's per-layer facts
   * — for iSWA models ONLY (2026-07-24): a windowed layer holds `min(ctx, slidingWindow)`
   * tokens, a global layer the full ctx, each at its own KV-head count and (per-head) K/V
   * dims. null unless the header carries the full iSWA picture (a window, a per-layer
   * pattern matching blockCount, per-head dims) — the caller then keeps the fitted
   * regression's uniform KV term, so non-iSWA models are byte-identical to before. Uniform
   * full-attention models stay on the regression ON PURPOSE: its KV factor is part of the
   * fitted calibration; only the class it fundamentally mismodels earns the precise path.
   */
  kvMbAtCtx(ctx, cacheBits) {
    if (
      this.slidingWindow <= 0 ||
      this.slidingWindowPattern.length !== this.blockCount ||
      this.blockCount <= 0 ||
      this.keyLength <= 0 ||
      this.valueLength <= 0 ||
      ctx <= 0
    ) {
      return null;
    }
    let heads = this.headCountKvPerLayer;
    if (heads.length !== this.blockCount) {
      const h = this.nKvHeads;
      if (h <= 0) return null;
      heads = new Array(this.blockCount).fill(h);
    }
    const bytesPerElem = Math.max(1, cacheBits) / 8.0;
    let totalBytes = 0.0;
    this.slidingWindowPattern.forEach((windowed, i) => {
      let tokens;
      let k;
      let v;
      if (windowed) {
        tokens = Math.min(ctx, this.slidingWindow);
        k = this.keyLengthSwa || this.keyLength;
        v = this.valueLengthSwa || this.valueLength;
      } else {
        tokens = ctx;
        k = this.keyLength;
        v = this.valueLength;
      }
      totalBytes += heads[i] * (k + v) * tokens * bytesPerElem;
    });
    return totalBytes / (1024 * 1024); // MiB — the VRAM path's one unit (vram-truth §6.4)
  }
}

// ── the byte streams (Python's BinaryIO: a BytesIO or an open file) ─────────────────────

/** struct.error — the header ran out (Python's `struct.unpack` on a short read). */
export class StructError extends Error {
  constructor(m) {
    super(m);
    this.name = "StructError";
  }
}

/** BytesIO over a Buffer: read(n) may return fewer bytes; seek may pass the end. */
export class ByteStream {
  constructor(buf) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }
  read(n) {
    const start = Math.min(this.pos, this.buf.length);
    const end = Math.min(this.pos + Math.max(0, n), this.buf.length);
    this.pos = Math.max(this.pos, end);
    return this.buf.subarray(start, end);
  }
  seek(off, whence = 0) {
    this.pos = Math.max(0, whence === 1 ? this.pos + off : whence === 2 ? this.buf.length + off : off);
    return this.pos;
  }
  tell() {
    return this.pos;
  }
}

const BLOCK = 1 << 20;

/** An open file read through a 1 MB block cache — the header's thousands of tiny reads
 * (a vocab is skipped string by string) cost one `readSync` per megabyte. */
export class FileStream {
  constructor(fd) {
    this.fd = fd;
    this.size = fstatSync(fd).size; // what the open file holds now
    this.pos = 0;
    this.blockStart = -1;
    this.block = Buffer.alloc(0);
  }
  #fill(at) {
    const buf = Buffer.allocUnsafe(BLOCK);
    const n = readSync(this.fd, buf, 0, BLOCK, at);
    this.block = buf.subarray(0, n);
    this.blockStart = at;
  }
  read(n) {
    const want = Math.max(0, Math.min(n, this.size - this.pos));
    if (want <= 0) return Buffer.alloc(0);
    const parts = [];
    let got = 0;
    while (got < want) {
      const at = this.pos + got;
      if (at < this.blockStart || at >= this.blockStart + this.block.length) {
        if (want - got >= BLOCK) {
          // A big read goes straight to the file.
          const buf = Buffer.allocUnsafe(want - got);
          const r = readSync(this.fd, buf, 0, buf.length, at);
          if (r <= 0) break;
          parts.push(buf.subarray(0, r));
          got += r;
          continue;
        }
        this.#fill(at);
        if (!this.block.length) break;
      }
      const off = at - this.blockStart;
      const piece = this.block.subarray(off, Math.min(this.block.length, off + (want - got)));
      parts.push(piece);
      got += piece.length;
    }
    this.pos += got;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, got);
  }
  seek(off, whence = 0) {
    this.pos = Math.max(0, whence === 1 ? this.pos + off : whence === 2 ? this.size + off : off);
    return this.pos;
  }
  tell() {
    return this.pos;
  }
}

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** A u64/i64 as a number when it is exact, else the BigInt. */
const bigToNum = (b) => (b <= SAFE && b >= -SAFE ? Number(b) : b);

function readScalar(f, code) {
  const width = { B: 1, b: 1, H: 2, h: 2, I: 4, i: 4, f: 4, "?": 1, Q: 8, q: 8, d: 8 }[code];
  const b = f.read(width);
  if (b.length !== width) throw new StructError(`unpack requires a buffer of ${width} bytes`);
  switch (code) {
    case "B":
      return b.readUInt8(0);
    case "b":
      return b.readInt8(0);
    case "H":
      return b.readUInt16LE(0);
    case "h":
      return b.readInt16LE(0);
    case "I":
      return b.readUInt32LE(0);
    case "i":
      return b.readInt32LE(0);
    case "f":
      return b.readFloatLE(0);
    case "?":
      return b[0] !== 0;
    case "Q":
      return bigToNum(b.readBigUInt64LE(0));
    case "q":
      return bigToNum(b.readBigInt64LE(0));
    case "d":
      return b.readDoubleLE(0);
  }
  throw new Error(`bad struct code ${code}`);
}

/** A count / length / offset: a plain number even when the header is garbage (a huge value
 * then reads past the end and the next read fails, as Python's would). */
const readCount = (f) => Number(readScalar(f, "Q"));

function readString(f) {
  const n = readCount(f);
  // errors="replace" — Node's UTF-8 decoder substitutes U+FFFD the same way.
  return f.read(n).toString("utf8");
}

/** Advance past one array value without materialising it. */
function skipArray(f) {
  const subtype = readScalar(f, "I");
  const count = readCount(f);
  const scalar = SCALAR.get(subtype);
  if (scalar !== undefined) {
    f.seek(count * scalar[1], 1); // fixed-width block — one seek
  } else if (subtype === TYPE_STRING) {
    for (let i = 0; i < count; i++) f.seek(readCount(f), 1); // len-prefixed, variable width
  } else if (subtype === TYPE_ARRAY) {
    for (let i = 0; i < count; i++) skipArray(f); // nested (rare)
  } else {
    throw new ValueError(`unknown GGUF array subtype ${subtype}`);
  }
}

/** Read one metadata value; arrays are SKIPPED (null). */
function readValue(f, vtype) {
  const scalar = SCALAR.get(vtype);
  if (scalar !== undefined) return readScalar(f, scalar[0]);
  if (vtype === TYPE_STRING) return readString(f);
  if (vtype === TYPE_ARRAY) {
    skipArray(f);
    return null;
  }
  throw new ValueError(`unknown GGUF metadata value type ${vtype}`);
}

// The ONLY array keys we materialise (2026-07-24, the iSWA KV term) — per-layer facts, one
// element per transformer layer, so tiny. Everything else (tokenizer tokens/merges —
// hundreds of thousands of entries) stays skipped, which keeps the remote range-read small.
const WANTED_ARRAY_SUFFIXES = [".attention.head_count_kv", ".attention.sliding_window_pattern"];
const ARRAY_CAP = 512; // layers, generously; a bigger array is not a per-layer fact

/** One array value IF it is a small scalar/bool array (≤ ARRAY_CAP); otherwise
 * consume-and-skip it (null). The stream is left after the array either way. */
function readArrayCapped(f) {
  const subtype = readScalar(f, "I");
  const count = readCount(f);
  const scalar = SCALAR.get(subtype);
  if (scalar !== undefined && count <= ARRAY_CAP) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(readScalar(f, scalar[0]));
    return out;
  }
  if (scalar !== undefined) {
    f.seek(count * scalar[1], 1);
  } else if (subtype === TYPE_STRING) {
    for (let i = 0; i < count; i++) f.seek(readCount(f), 1);
  } else if (subtype === TYPE_ARRAY) {
    for (let i = 0; i < count; i++) skipArray(f);
  } else {
    throw new ValueError(`unknown GGUF array subtype ${subtype}`);
  }
  return null;
}

function metaFromKv(kv) {
  const arch = pyStr(kv.has("general.architecture") ? kv.get("general.architecture") : "");
  const get = (suffix) => kv.get(`${arch}.${suffix}`);

  // A per-layer ARRAY under a scalar key (Gemma-4 ships attention.head_count_kv per layer)
  // is NOT the scalar — it is read by intList instead.
  const int = (suffix, dflt = 0) => {
    const v = get(suffix);
    return v !== undefined && v !== null && !Array.isArray(v) ? pyInt(v) : dflt;
  };
  const intList = (suffix) => {
    const v = get(suffix);
    return Array.isArray(v) ? v.map((x) => pyInt(x)) : [];
  };
  const boolList = (suffix) => {
    const v = get(suffix);
    return Array.isArray(v) ? v.map((x) => truthy(x)) : [];
  };

  const prefix = "general.sampling.";
  const sampling = {};
  for (const [k, v] of kv) {
    if (k.startsWith(prefix) && (typeof v === "number" || typeof v === "bigint")) {
      sampling[k.slice(prefix.length)] = Number(v);
    }
  }
  const baseRepo = pyStr(
    kv.get("general.base_model.0.repo_url") || kv.get("general.source.repo_url") || "",
  );
  const fileType = kv.get("general.file_type");
  const sizeLabel = kv.get("general.size_label");
  return new GgufMeta({
    architecture: arch,
    blockCount: int("block_count"),
    embeddingLength: int("embedding_length"),
    expertCount: int("expert_count", 0),
    headCount: int("attention.head_count", 0),
    headCountKv: int("attention.head_count_kv", 0),
    contextLength: int("context_length", 0),
    expertUsedCount: int("expert_used_count", 0),
    nextnPredictLayers: int("nextn_predict_layers", 0),
    feedForwardLength: int("feed_forward_length", 0),
    expertFeedForwardLength: int("expert_feed_forward_length", 0),
    expertSharedFeedForwardLength: int("expert_shared_feed_forward_length", 0),
    headCountKvPerLayer: intList("attention.head_count_kv"),
    slidingWindow: int("attention.sliding_window", 0),
    slidingWindowPattern: boolList("attention.sliding_window_pattern"),
    keyLength: int("attention.key_length", 0),
    valueLength: int("attention.value_length", 0),
    keyLengthSwa: int("attention.key_length_swa", 0),
    valueLengthSwa: int("attention.value_length_swa", 0),
    fileType: pyInt(truthy(fileType) ? fileType : 0),
    sizeLabel: pyStr(truthy(sizeLabel) ? sizeLabel : ""),
    sampling,
    baseRepoUrl: baseRepo,
  });
}

// The tensors `--n-cpu-moe` keeps in system RAM — llama.cpp's OWN pattern, b10437
// `common/common.h:1113 LLM_FFN_EXPS_REGEX`. The pattern is build-dependent (older builds
// lacked `gate_up`): RE-VERIFY on every pin bump (docs/llama-cpp-watch.md).
export const EXPS_REGEX = /\.ffn_(up|down|gate|gate_up)_(ch|)exps/;
const DEFAULT_ALIGNMENT = 32; // GGUF spec default when `general.alignment` is absent
const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

/**
 * [kv (a Map), tensor infos [[name, offset]] or null, dataStart]. Throws ValueError on bad
 * magic; a StructError (the header ran out) propagates to the caller, which knows which half
 * ran out. Exported for gguf_remote.js (Python imported the private `_parse_header`).
 */
export function _parseHeader(f, { wantTensors }) {
  if (!f.read(4).equals(MAGIC)) throw new ValueError("not a GGUF stream (bad magic)");
  readScalar(f, "I"); // version
  const tensorCount = readCount(f);
  const kvCount = readCount(f);
  const kv = new Map();
  for (let i = 0; i < kvCount; i++) {
    const key = readString(f);
    const vtype = readScalar(f, "I");
    if (vtype === TYPE_ARRAY && WANTED_ARRAY_SUFFIXES.some((s) => key.endsWith(s))) {
      kv.set(key, readArrayCapped(f)); // per-layer fact — materialised
    } else {
      kv.set(key, readValue(f, vtype));
    }
  }
  if (!wantTensors) return [kv, null, 0];
  const infos = [];
  for (let i = 0; i < tensorCount; i++) {
    const name = readString(f);
    const nDims = readScalar(f, "I");
    f.seek(8 * nDims, 1); // dims (u64 each) — sizes come from offsets
    readScalar(f, "I"); // ggml type
    infos.push([name, readCount(f)]);
  }
  const al = kv.get("general.alignment");
  const alignment = pyInt(truthy(al) ? al : DEFAULT_ALIGNMENT) || DEFAULT_ALIGNMENT;
  const pos = f.tell();
  const dataStart = pos + pyMod(-pos, alignment);
  return [kv, infos, dataStart];
}

/** [[name, bytes]] by OFFSET DELTA — each tensor's size is the gap to the next one's offset
 * (alignment padding included, < alignment bytes each); the last runs to the end of the
 * file. No per-quant-type byte table to maintain. */
export function _tensorSizes(infos, dataStart, fileSize) {
  // A stable sort by offset (Python's sorted(key=offset)).
  const ordered = infos.map((t, i) => [t, i]).sort((a, b) => a[0][1] - b[0][1] || a[1] - b[1]).map((p) => p[0]);
  const dataLen = fileSize - dataStart;
  return ordered.map(([name, off], i) => {
    const end = i + 1 < ordered.length ? ordered[i + 1][1] : dataLen;
    return [name, Math.max(0, end - off)];
  });
}

/** Fill `meta`'s exact-bytes fields from [[name, bytes]] — the placement llama.cpp applies
 * (b9993/b10437 `llama-model.cpp`): per block, experts vs the rest; the output side; the
 * input side (always CPU). A tied head (no `output.weight`) is DUPLICATED onto the output
 * device (`gemma4.cpp:44-47` — the common tied idiom). */
export function _classify(meta, sized) {
  if (!sized.length || !sized.some(([, b]) => b)) return; // no tensor bytes (a synthetic header) → stays UNKNOWN, never "0 bytes"
  const blocks = new Map();
  let outB = 0;
  let inB = 0;
  let embd = 0;
  let hasOutputWeight = false;
  for (const [name, b] of sized) {
    if (name.startsWith("blk.")) {
      const il = pyInt(name.split(".")[1]);
      if (!blocks.has(il)) blocks.set(il, [0, 0]);
      blocks.get(il)[EXPS_REGEX.test(name) ? 1 : 0] += b;
    } else if (name.startsWith("output")) {
      outB += b;
      hasOutputWeight ||= name === "output.weight";
    } else {
      inB += b;
      if (name === "token_embd.weight") embd = b;
    }
  }
  if (!hasOutputWeight) outB += embd;
  const n = Math.max(meta.blockCount, blocks.size ? Math.max(...blocks.keys()) + 1 : 0);
  meta.layerNonexpBytes = Array.from({ length: n }, (_, i) => (blocks.get(i) ?? [0, 0])[0]);
  meta.layerExpsBytes = Array.from({ length: n }, (_, i) => (blocks.get(i) ?? [0, 0])[1]);
  meta.outputBytes = outB;
  meta.inputBytes = inB;
  meta.tensorBytesKnown = true;
}

const asStream = (f) => (Buffer.isBuffer(f) || f instanceof Uint8Array ? new ByteStream(f) : f);

/**
 * Parse a GGUF header from a Buffer (a range-read) or an open stream. Throws ValueError on
 * bad magic OR a truncated header (the remote caller re-fetches a larger prefix and
 * retries).
 *
 * With `fileSize` (the WHOLE file's byte size — for a range-read, the file's real size, not
 * the prefix) the tensor table is read too and the exact-bytes fields are filled (§6.1). A
 * tensor table that runs past the prefix throws the same "truncated" error when
 * `strictTensors`; with it false the KV-only meta returns (`tensorBytesKnown` false) — the
 * remote reader's last resort.
 */
export function readGgufMetadataFromStream(f, { fileSize = null, strictTensors = true } = {}) {
  f = asStream(f);
  const want = fileSize != null && fileSize > 0;
  const start = f.tell();
  let kv;
  let infos;
  let dataStart;
  try {
    [kv, infos, dataStart] = _parseHeader(f, { wantTensors: want });
  } catch (e) {
    if (!(e instanceof StructError)) throw e;
    if (want && !strictTensors) {
      f.seek(start); // the tensor half ran out — keep the KV facts
      return readGgufMetadataKvOnly(f);
    }
    throw new ValueError(`truncated GGUF header (${e.message}) — range-read a larger prefix`);
  }
  const meta = metaFromKv(kv);
  if (want && infos !== null) _classify(meta, _tensorSizes(infos, dataStart, Number(fileSize)));
  return meta;
}

/** The KV half only (no tensor table) — the pre-2026-09-19 behavior. */
export function readGgufMetadataKvOnly(f) {
  f = asStream(f);
  let kv;
  try {
    [kv] = _parseHeader(f, { wantTensors: false });
  } catch (e) {
    if (!(e instanceof StructError)) throw e;
    throw new ValueError(`truncated GGUF header (${e.message}) — range-read a larger prefix`);
  }
  return metaFromKv(kv);
}

/** For a split model's shard (`…-00001-of-00003.gguf`) the full ordered shard list, or null
 * when `path` is not a split name. Missing shards → null too (a partial table would be
 * worse than the fallback). */
export function splitSiblings(path) {
  const name = basename(path);
  const m = SPLIT_RE.exec(name);
  if (!m) return null;
  const total = Number(m[2]);
  const stem = name.slice(0, m.index);
  const pad = (i) => String(i).padStart(5, "0");
  const shards = [];
  for (let i = 1; i <= total; i++) shards.push(join(dirname(path), `${stem}-${pad(i)}-of-${pad(total)}.gguf`));
  return shards.every((p) => existsSync(p)) ? shards : null;
}

/** The model's REAL weight size: every shard of a split model summed (a split model's first
 * shard is only part of it — vram-truth plan §6.3), else the file itself. The same rule
 * oobabooga's `get_model_size_mb` applies. */
export function ggufTotalBytes(path) {
  const shards = splitSiblings(path);
  if (shards && shards.length) return sumOf(shards.map((p) => statSync(p).size));
  return statSync(path).size;
}

function withFile(path, fn) {
  const fd = openSync(path, "r");
  try {
    return fn(new FileStream(fd));
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse the GGUF header of a local `path` — KV facts AND the exact tensor bytes.
 *
 * For a sharded model pass shard 00001 (it carries the full metadata); every sibling shard's
 * tensor table is read and MERGED (each shard sized against its own file). Any shard
 * unreadable → the exact fields stay unknown (fallback). Throws ValueError on a non-GGUF
 * file (bad magic).
 */
export function readGgufMetadata(path) {
  path = String(path);
  const meta = withFile(path, (f) => readGgufMetadataFromStream(f, { fileSize: statSync(path).size }));
  const split = SPLIT_RE.exec(basename(path));
  if (split && Number(split[2]) > 1 && !splitSiblings(path)) {
    meta.tensorBytesKnown = false; // a shard is missing: never a PARTIAL table
    return meta;
  }
  const shards = splitSiblings(path);
  if (shards && shards.length > 1) {
    try {
      const sized = [];
      for (const p of shards) {
        const [, infos, dataStart] = withFile(p, (f) => _parseHeader(f, { wantTensors: true }));
        sized.push(..._tensorSizes(infos || [], dataStart, statSync(p).size));
      }
      _classify(meta, sized);
    } catch (e) {
      // (OSError, ValueError, struct.error) in Python
      if (!(e instanceof ValueError || e instanceof StructError || e?.code)) throw e;
      meta.tensorBytesKnown = false;
    }
  }
  return meta;
}
