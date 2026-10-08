// SPDX-License-Identifier: MIT
// Port of tests/test_gguf.py — the GGUF header reader, built against synthetic GGUF blobs
// (no real model). All 17 Python tests are ported.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import * as http from "../src/platform/http.js";
import { ValueError } from "../src/platform/py.js";
import { GgufMeta, readGgufMetadata, readGgufMetadataFromStream } from "../src/runner/gguf.js";
import * as ggufRemote from "../src/runner/gguf_remote.js";
import * as models from "../src/runner/models.js";

let tmpPath;
beforeEach(() => {
  tmpPath = mkdtempSync(join(tmpdir(), "kit-gguf-"));
});

// ── struct.pack("<…") for the few codes the builders use ─────────────────────────────
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const f32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return b;
};
const bool8 = (v) => Buffer.from([v ? 1 : 0]);
const cat = (...bs) => Buffer.concat(bs);

function gstr(s) {
  const b = Buffer.from(s, "utf8");
  return cat(u64(b.length), b);
}
const kvU32 = (key, val) => cat(gstr(key), u32(4), u32(val)); // type 4 = UINT32
const kvStr = (key, val) => cat(gstr(key), u32(8), gstr(val)); // type 8 = STRING
// type 9 = ARRAY; subtype 4 = UINT32; then count + elements.
const kvU32Array = (key, vals) => cat(gstr(key), u32(9), u32(4), u64(vals.length), ...vals.map(u32));
// type 9 = ARRAY; subtype 7 = BOOL (1 byte each).
const kvBoolArray = (key, vals) => cat(gstr(key), u32(9), u32(7), u64(vals.length), ...vals.map(bool8));
const kvF32 = (key, val) => cat(gstr(key), u32(6), f32(val)); // type 6 = FLOAT32
// type 9 = ARRAY; subtype 8 = STRING (the big tokenizer-token/merge shape).
const kvStrArray = (key, vals) => cat(gstr(key), u32(9), u32(8), u64(vals.length), ...vals.map(gstr));

function buildGguf(kvs) {
  return cat(Buffer.from("GGUF"), u32(3), u64(0), u64(kvs.length), ...kvs);
}

const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test("read_dense_model", () => {
  const p = join(tmpPath, "dense.gguf");
  writeFileSync(
    p,
    buildGguf([kvStr("general.architecture", "llama"), kvU32("llama.block_count", 32), kvU32("llama.embedding_length", 4096)]),
  );
  const m = readGgufMetadata(p);
  expect(m.architecture).toBe("llama");
  expect(m.blockCount).toBe(32);
  expect(m.embeddingLength).toBe(4096);
  expect(m.expertCount).toBe(0);
  expect(m.isMoe).toBe(false);
});

test("read_moe_model_skipping_an_array_kv", () => {
  // The ARRAY sits BETWEEN the keys we want — if array-skipping is wrong,
  // embeddingLength/expertCount would misparse and the asserts fail.
  const p = join(tmpPath, "moe.gguf");
  writeFileSync(
    p,
    buildGguf([
      kvStr("general.architecture", "qwen3moe"),
      kvU32("qwen3moe.block_count", 48),
      kvU32Array("qwen3moe.some_array", [10, 20, 30, 40]),
      kvU32("qwen3moe.embedding_length", 2048),
      kvU32("qwen3moe.expert_count", 128),
      // The FFN dims the ncmoe-aware fit reads (2026-07-24).
      kvU32("qwen3moe.feed_forward_length", 6144),
      kvU32("qwen3moe.expert_feed_forward_length", 768),
      kvU32("qwen3moe.expert_shared_feed_forward_length", 768),
    ]),
  );
  const m = readGgufMetadata(p);
  expect(m.architecture).toBe("qwen3moe");
  expect(m.blockCount).toBe(48);
  expect(m.embeddingLength).toBe(2048);
  expect(m.expertCount).toBe(128);
  expect(m.isMoe).toBe(true);
  expect(m.feedForwardLength).toBe(6144);
  expect(m.expertFeedForwardLength).toBe(768);
  expect(m.expertSharedFeedForwardLength).toBe(768);
});

test("read_iswa_per_layer_facts", () => {
  // The two allowlisted per-layer arrays are MATERIALISED (everything else still skips);
  // the per-layer head_count_kv array must not corrupt the scalar field. Mirrors the real
  // Gemma-4 26B header shape (2026-07-24).
  const p = join(tmpPath, "iswa.gguf");
  writeFileSync(
    p,
    buildGguf([
      kvStr("general.architecture", "gemma4"),
      kvU32("gemma4.block_count", 6),
      kvU32("gemma4.embedding_length", 2816),
      kvU32Array("gemma4.attention.head_count_kv", [8, 8, 2, 8, 8, 2]),
      kvU32("gemma4.attention.sliding_window", 1024),
      kvBoolArray("gemma4.attention.sliding_window_pattern", [true, true, false, true, true, false]),
      kvU32("gemma4.attention.key_length", 512),
      kvU32("gemma4.attention.value_length", 512),
      kvU32("gemma4.attention.key_length_swa", 256),
      kvU32("gemma4.attention.value_length_swa", 256),
      kvU32Array("gemma4.unrelated_array", [1, 2, 3]), // still skipped
    ]),
  );
  const m = readGgufMetadata(p);
  expect(m.headCountKvPerLayer).toEqual([8, 8, 2, 8, 8, 2]);
  expect(m.headCountKv).toBe(0); // the array never poses as the scalar
  expect(m.slidingWindow).toBe(1024);
  expect(m.slidingWindowPattern).toEqual([true, true, false, true, true, false]);
  expect([m.keyLength, m.valueLength, m.keyLengthSwa, m.valueLengthSwa]).toEqual([512, 512, 256, 256]);

  // kvMbAtCtx: windowed layers hold min(ctx, window) tokens at the swa dims; global layers
  // the full ctx at the full dims — hand-summed.
  const [ctx, bits] = [32768, 8];
  const windowed = 4 * (8 * (256 + 256) * 1024 * 1.0); // 4 layers × heads×(k+v)×tokens×1B
  const global = 2 * (2 * (512 + 512) * ctx * 1.0);
  expect(Math.abs(m.kvMbAtCtx(ctx, bits) - (windowed + global) / (1024 * 1024))).toBeLessThan(1e-6); // MiB since 2026-09-19

  // Guards: no pattern / mismatched pattern → null (the regression term stays).
  expect(new GgufMeta({ ...m, slidingWindow: 0 }).kvMbAtCtx(ctx, bits)).toBeNull();
  expect(new GgufMeta({ ...m, slidingWindowPattern: [true] }).kvMbAtCtx(ctx, bits)).toBeNull();
  expect(new GgufMeta({ ...m, keyLength: 0 }).kvMbAtCtx(ctx, bits)).toBeNull();
});

test("expert_byte_share", () => {
  // Dense → 0; MoE WITHOUT expert dims in the header → honest 0 (no guessing).
  const dense = new GgufMeta({ architecture: "x", blockCount: 48, embeddingLength: 4096, expertCount: 0 });
  expect(dense.expertByteShare()).toBe(0.0);
  const nodims = new GgufMeta({ architecture: "x", blockCount: 48, embeddingLength: 4096, expertCount: 128 });
  expect(nodims.expertByteShare()).toBe(0.0);

  // Expert-dominated MoE (GQA 4/16): experts = 3·n_embd·ff_exp·E,
  // attention = n_embd²·(2 + 2·kv_ratio) — the structural formula, verbatim.
  const moe = new GgufMeta({
    architecture: "x",
    blockCount: 48,
    embeddingLength: 2048,
    expertCount: 128,
    headCount: 16,
    headCountKv: 4,
    expertFeedForwardLength: 1024,
  });
  const experts = 3 * 2048 * 1024 * 128;
  const attention = 2048 * 2048 * (2 + 2 * (4 / 16));
  expect(Math.abs(moe.expertByteShare() - experts / (experts + attention))).toBeLessThan(1e-9);
  expect(moe.expertByteShare()).toBeGreaterThan(0.9); // experts dominate the bytes

  // A shared-expert FFN sits in the NON-discounted bucket → the share drops.
  const shared = new GgufMeta({
    architecture: "x",
    blockCount: 48,
    embeddingLength: 2048,
    expertCount: 128,
    headCount: 16,
    headCountKv: 4,
    expertFeedForwardLength: 1024,
    expertSharedFeedForwardLength: 1024,
  });
  expect(shared.expertByteShare()).toBeGreaterThan(0.0);
  expect(shared.expertByteShare()).toBeLessThan(moe.expertByteShare());

  // Missing head counts → MHA fallback (kv_ratio 1) — MORE attention bytes, SMALLER share.
  const nohc = new GgufMeta({
    architecture: "x",
    blockCount: 48,
    embeddingLength: 2048,
    expertCount: 128,
    expertFeedForwardLength: 1024,
  });
  expect(nohc.expertByteShare()).toBeGreaterThan(0.0);
  expect(nohc.expertByteShare()).toBeLessThan(moe.expertByteShare());
});

test("bad_magic_raises", () => {
  const p = join(tmpPath, "notgguf.bin");
  writeFileSync(p, cat(Buffer.from("NOPE"), Buffer.alloc(32)));
  expect(() => readGgufMetadata(p)).toThrow(ValueError);
});

test("stream_parse_all_new_fields_incl_sampling", () => {
  // Phase-1 fields from the REMOTE stream path, with a big STRING array (tokenizer-like)
  // between the keys we want — the skip-arrays advance must be right for variable-width
  // string arrays too.
  const tokens = [];
  for (let i = 0; i < 200; i++) tokens.push("a", "bb", "ccc");
  const blob = buildGguf([
    kvStr("general.architecture", "qwen35"),
    kvU32("general.file_type", 15),
    kvStr("general.base_model.0.repo_url", "https://huggingface.co/Qwen/Qwen3.6-27B"),
    kvF32("general.sampling.temp", 1.0),
    kvU32("general.sampling.top_k", 20),
    kvF32("general.sampling.top_p", 0.95),
    kvStrArray("tokenizer.ggml.tokens", tokens), // skipped
    kvU32("qwen35.block_count", 65),
    kvU32("qwen35.embedding_length", 5120),
    kvU32("qwen35.context_length", 262144),
    kvU32("qwen35.nextn_predict_layers", 1),
    kvU32("qwen35.attention.head_count", 24),
    kvU32("qwen35.attention.head_count_kv", 4),
  ]);
  const m = readGgufMetadataFromStream(blob);
  expect(m.architecture).toBe("qwen35");
  expect(m.contextLength).toBe(262144);
  expect(m.nextnPredictLayers).toBe(1);
  expect(m.isMtp).toBe(true);
  expect(m.isMoe).toBe(false); // dense — no expert_count
  expect(m.fileType).toBe(15);
  expect(m.headCount).toBe(24);
  expect(m.headCountKv).toBe(4);
  expect(m.baseRepoUrl).toBe("https://huggingface.co/Qwen/Qwen3.6-27B");
  // sampling extracted with llama.cpp key names (temp/top_k/top_p), NOT knob names
  expect(approx(m.sampling.temp, 1.0)).toBe(true);
  expect(m.sampling.top_k).toBe(20);
  expect(Math.abs(m.sampling.top_p - 0.95)).toBeLessThanOrEqual(1e-6);
});

test("stream_moe_mtp_and_absent_sampling", () => {
  const blob = buildGguf([
    kvStr("general.architecture", "glm4moe"),
    kvU32("glm4moe.expert_count", 128),
    kvU32("glm4moe.expert_used_count", 8),
    kvU32("glm4moe.nextn_predict_layers", 1),
    kvU32("glm4moe.block_count", 47),
  ]);
  const m = readGgufMetadataFromStream(blob);
  expect(m.isMoe && m.expertCount === 128 && m.expertUsedCount === 8).toBe(true);
  expect(m.isMtp).toBe(true); // GLM-4.5-Air is MoE+MTP
  expect(m.sampling).toEqual({}); // no general.sampling.* → generation_config fallback
  expect(m.baseRepoUrl).toBe("");
});

test("truncated_header_raises_valueerror", () => {
  const blob = buildGguf([kvStr("general.architecture", "llama"), kvU32("llama.block_count", 32)]);
  // a range-read that cut the header short
  expect(() => readGgufMetadataFromStream(blob.subarray(0, blob.length - 6))).toThrow(ValueError);
});

test("fetch_gguf_meta_sums_shards_and_parses", async () => {
  // fetchGgufMeta with the network stubbed: picks shard 00001 for the header, sums ALL
  // shard sizes for the weight total.
  const blob = buildGguf([
    kvStr("general.architecture", "qwen35"),
    kvU32("qwen35.context_length", 262144),
    kvU32("qwen35.nextn_predict_layers", 1),
    kvF32("general.sampling.temp", 1.0),
  ]);
  const entries = [
    { path: "Model-Q4_K_M-00001-of-00002.gguf", lfs: { size: 1000 } },
    { path: "Model-Q4_K_M-00002-of-00002.gguf", lfs: { size: 2000 } },
  ];
  vi.spyOn(models, "selectFiles").mockImplementation(async () => ["sha", entries]);
  vi.spyOn(ggufRemote, "_rangeRead").mockImplementation(async () => blob);
  const [meta, total] = await ggufRemote.fetchGgufMeta("some/repo-GGUF", "Q4_K_M");
  expect(meta.architecture === "qwen35" && meta.isMtp).toBe(true);
  expect(approx(meta.sampling.temp, 1.0)).toBe(true);
  expect(total).toBe(3000); // summed shard sizes (real weight bytes)
});

test("repo_from_url", () => {
  expect(ggufRemote._repoFromUrl("https://huggingface.co/Qwen/Qwen3.6-27B")).toBe("Qwen/Qwen3.6-27B");
  expect(ggufRemote._repoFromUrl("https://huggingface.co/Qwen/Qwen3.6-27B/tree/main")).toBe("Qwen/Qwen3.6-27B");
  expect(ggufRemote._repoFromUrl("zai-org/GLM-4.5-Air")).toBe("zai-org/GLM-4.5-Air");
  expect(ggufRemote._repoFromUrl("")).toBe("");
  expect(ggufRemote._repoFromUrl("nope")).toBe("");
});

test("generation_config_samplers_maps_keys", async () => {
  vi.spyOn(http, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05, do_sample: true }),
        { status: 200 },
      ),
  );
  const out = await ggufRemote.fetchGenerationConfigSamplers("Qwen/Qwen3.6-27B");
  // HF names mapped to the llama.cpp namespace; non-numeric (do_sample) dropped. (Every value
  // is a Python float — `top_k` 20.0; JS numbers don't carry that.)
  expect(out).toEqual({ temp: 0.7, top_p: 0.8, top_k: 20.0, penalty_repeat: 1.05 });
});

test("generation_config_samplers_best_effort", async () => {
  vi.spyOn(http, "fetch").mockImplementation(async () => {
    throw new Error("404 gated repo");
  });
  expect(await ggufRemote.fetchGenerationConfigSamplers("Qwen/Qwen3.6-27B")).toEqual({});
  expect(await ggufRemote.fetchGenerationConfigSamplers("")).toEqual({}); // no repo → no fetch
});

test("bool_sampling_key_excluded", () => {
  // a general.sampling.* with a BOOL value must be DROPPED (not coerced to 0/1).
  const blob = buildGguf([
    kvStr("general.architecture", "llama"),
    cat(gstr("general.sampling.some_bool"), u32(7), bool8(true)), // 7 = BOOL
    kvF32("general.sampling.temp", 0.8),
  ]);
  const m = readGgufMetadataFromStream(blob);
  expect(Object.keys(m.sampling)).toEqual(["temp"]);
  expect(approx(m.sampling.temp, 0.8)).toBe(true);
});

test("nested_array_value_is_skipped", () => {
  // an ARRAY-of-ARRAY between two wanted keys must be skipped without misparsing.
  const inner = cat(u32(4), u64(2), u32(1), u32(2)); // u32[2]
  const outerBody = cat(u32(9), u64(2), inner, inner); // array[2] of arrays
  const blob = buildGguf([
    kvStr("general.architecture", "llama"),
    cat(gstr("llama.nested"), u32(9), outerBody),
    kvU32("llama.block_count", 40),
  ]);
  const m = readGgufMetadataFromStream(blob);
  expect(m.architecture === "llama" && m.blockCount === 40).toBe(true);
});

test("fetch_gguf_meta_retries_on_truncated_first_read", async () => {
  const full = buildGguf([kvStr("general.architecture", "qwen35"), kvU32("qwen35.context_length", 4096)]);
  const calls = { n: 0 };
  vi.spyOn(models, "selectFiles").mockImplementation(async () => [
    "sha",
    [{ path: "m-00001-of-00001.gguf", lfs: { size: 100 } }],
  ]);
  vi.spyOn(ggufRemote, "_rangeRead").mockImplementation(async () => {
    calls.n += 1;
    return calls.n === 1 ? full.subarray(0, 8) : full; // first read cut short → retry gets the full header
  });
  const [meta, total] = await ggufRemote.fetchGgufMeta("r/x-GGUF", "Q4_K_M");
  expect(meta.architecture === "qwen35" && calls.n === 2 && total === 100).toBe(true);
});

test("range_read_stops_at_n_even_if_cdn_ignores_range", async () => {
  // The CDN streams the whole file despite the Range header.
  vi.spyOn(http, "fetch").mockImplementation(async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(5_000_000).fill(120));
        c.enqueue(new Uint8Array(5_000_000).fill(121));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  });
  expect((await ggufRemote._rangeRead("http://x", 1000)).length).toBe(1000);
});

test("reads_size_label", () => {
  // metaFromKv reads the documented general.size_label key (dense param scale).
  const blob = buildGguf([
    kvStr("general.architecture", "llama"),
    kvStr("general.size_label", "27B"),
    kvU32("llama.block_count", 32),
  ]);
  const m = readGgufMetadataFromStream(blob);
  expect(m.sizeLabel === "27B" && m.blockCount === 32).toBe(true);
});
