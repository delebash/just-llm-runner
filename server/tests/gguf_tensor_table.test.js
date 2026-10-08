// SPDX-License-Identifier: MIT
// Port of tests/test_gguf_tensor_table.py — the GGUF tensor table (vram-truth plan
// docs/plans/2026-09-19-vram-truth-exact-bytes-units-offload.md §6.1): exact per-tensor bytes
// by OFFSET DELTA, sorted by llama.cpp's own placement rules. A tiny in-memory GGUF builder
// drives every case; the real files were checked against the engine in the plan's §10.2.
// All 11 Python tests are ported.
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { ValueError } from "../src/platform/py.js";
import {
  EXPS_REGEX,
  GgufMeta,
  ggufTotalBytes,
  readGgufMetadata,
  readGgufMetadataFromStream,
} from "../src/runner/gguf.js";

const ALIGN = 32;

let tmpPath;
beforeEach(() => {
  tmpPath = mkdtempSync(join(tmpdir(), "kit-gguf-tt-"));
});

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
const cat = (...bs) => Buffer.concat(bs);
const s = (text) => {
  const b = Buffer.from(text, "utf8");
  return cat(u64(b.length), b);
};
const kvU32 = (key, v) => cat(s(key), u32(4), u32(v));
const kvStr = (key, v) => cat(s(key), u32(8), s(v));
const padTo = (n) => (((-n % ALIGN) + ALIGN) % ALIGN); // -n % ALIGN, Python's sign

/** A minimal GGUF v3: KVs, tensor infos (offsets aligned), zero-filled data. */
function build(tensors, { arch = "llama", blocks = 2, experts = 4, extraKv = null } = {}) {
  const kvs = [
    kvStr("general.architecture", arch),
    kvU32(`${arch}.block_count`, blocks),
    kvU32(`${arch}.embedding_length`, 64),
    kvU32(`${arch}.expert_count`, experts),
    ...(extraKv || []),
  ];
  let head = cat(Buffer.from("GGUF"), u32(3), u64(tensors.length), u64(kvs.length), ...kvs);
  const offsets = [];
  let off = 0;
  for (const [, n] of tensors) {
    offsets.push(off);
    off += n + padTo(n);
  }
  tensors.forEach(([name, n], i) => {
    head = cat(head, s(name), u32(1), u64(n), u32(0), u64(offsets[i]));
  });
  head = cat(head, Buffer.alloc(padTo(head.length)));
  return cat(head, Buffer.alloc(off));
}

const read = (raw) => readGgufMetadataFromStream(raw, { fileSize: raw.length });

test("offset_delta_sizing_and_the_tied_head", () => {
  const raw = build([
    ["token_embd.weight", 512],
    ["blk.0.attn_q.weight", 128],
    ["blk.0.ffn_up_exps.weight", 1024],
    ["blk.1.attn_q.weight", 128],
    ["blk.1.ffn_up_exps.weight", 1024],
    ["output_norm.weight", 32],
  ]);
  const m = read(raw);
  expect(m.tensorBytesKnown).toBe(true);
  expect(m.layerNonexpBytes).toEqual([128, 128]);
  expect(m.layerExpsBytes).toEqual([1024, 1024]);
  // No output.weight → the vocab table is DUPLICATED onto the output device (gemma4.cpp:47)
  // — it counts on the output side AND stays on the input side.
  expect(m.outputBytes).toBe(32 + 512);
  expect(m.inputBytes).toBe(512);
});

test("untied_head_is_not_duplicated", () => {
  const raw = build([
    ["token_embd.weight", 512],
    ["blk.0.attn_q.weight", 64],
    ["blk.1.attn_q.weight", 64],
    ["output.weight", 256],
    ["output_norm.weight", 32],
  ]);
  const m = read(raw);
  expect(m.outputBytes).toBe(256 + 32);
  expect(m.inputBytes).toBe(512);
});

test("the_last_tensor_runs_to_the_end_of_the_file", () => {
  const raw = build([
    ["blk.0.attn_q.weight", 64],
    ["blk.1.attn_q.weight", 96],
  ]);
  expect(read(raw).layerNonexpBytes).toEqual([64, 96]);
});

test("expert_names_follow_llama_cpps_own_pattern", () => {
  // b10437 common/common.h:1113 — `gate_up` and `chexps` are experts; the router
  // (`ffn_gate_inp`) and shared experts (`_shexp`) are not.
  for (const name of [
    "blk.3.ffn_up_exps.weight",
    "blk.3.ffn_gate_up_exps.weight",
    "blk.3.ffn_down_chexps.weight",
    "blk.3.ffn_gate_exps.weight",
  ]) {
    expect(EXPS_REGEX.test(name), name).toBe(true);
  }
  for (const name of ["blk.3.ffn_gate_inp.weight", "blk.3.ffn_up_shexp.weight", "blk.3.ffn_up.weight"]) {
    expect(EXPS_REGEX.test(name), name).toBe(false);
  }
});

test("a_leading_dense_block_has_no_expert_bytes", () => {
  const raw = build([
    ["blk.0.ffn_up.weight", 256],
    ["blk.1.ffn_up_exps.weight", 1024],
    ["blk.1.attn_q.weight", 64],
  ]);
  const m = read(raw);
  expect(m.layerExpsBytes).toEqual([0, 1024]);
  expect(m.layerNonexpBytes).toEqual([256, 64]);
});

test("split_model_tables_merge_across_shards", () => {
  const a = build(
    [
      ["token_embd.weight", 512],
      ["blk.0.attn_q.weight", 128],
    ],
    { blocks: 2 },
  );
  const b = build(
    [
      ["blk.1.attn_q.weight", 128],
      ["blk.1.ffn_up_exps.weight", 1024],
    ],
    { blocks: 2 },
  );
  const p1 = join(tmpPath, "m-00001-of-00002.gguf");
  const p2 = join(tmpPath, "m-00002-of-00002.gguf");
  writeFileSync(p1, a);
  writeFileSync(p2, b);
  const m = readGgufMetadata(p1);
  expect(m.tensorBytesKnown).toBe(true);
  expect(m.layerNonexpBytes).toEqual([128, 128]);
  expect(m.layerExpsBytes).toEqual([0, 1024]);
  expect(ggufTotalBytes(p1)).toBe(a.length + b.length); // the model's real size, all parts
});

test("a_missing_shard_falls_back_instead_of_a_partial_table", () => {
  const p1 = join(tmpPath, "m-00001-of-00002.gguf");
  writeFileSync(p1, build([["blk.0.attn_q.weight", 128]], { blocks: 2 }));
  const m = readGgufMetadata(p1);
  // Shard 2 absent → the exact bytes are UNKNOWN (plan §6.1: never a partial table — shard 1
  // alone would under-count the model); the formula fallback applies.
  expect(m.tensorBytesKnown).toBe(false);
  expect(m.blockCount).toBe(2); // the KV facts still read
  expect(ggufTotalBytes(p1)).toBe(statSync(p1).size); // best effort for an incomplete download
});

test("a_truncated_tensor_table_raises_or_keeps_the_kv_facts", () => {
  const raw = build([
    ["blk.0.attn_q.weight", 128],
    ["blk.1.attn_q.weight", 128],
  ]);
  const cut = raw.subarray(0, raw.length - 128 - 128 - 40); // stops inside the tensor infos
  expect(() => readGgufMetadataFromStream(cut, { fileSize: raw.length })).toThrow(ValueError);
  expect(() => readGgufMetadataFromStream(cut, { fileSize: raw.length })).toThrow(/truncated/);
  const m = readGgufMetadataFromStream(cut, { fileSize: raw.length, strictTensors: false });
  expect(m.tensorBytesKnown).toBe(false);
  expect(m.blockCount).toBe(2); // KV facts survive
});

test("no_file_size_means_kv_only", () => {
  const m = readGgufMetadataFromStream(build([["blk.0.attn_q.weight", 64]]));
  expect(m.tensorBytesKnown).toBe(false);
});

test("a_header_with_no_tensors_stays_unknown_never_zero_bytes", () => {
  const raw = build([], { blocks: 2 });
  expect(read(raw).tensorBytesKnown).toBe(false);
});

test("the_fallback_formula_reads_mixtral_style_headers", () => {
  // Granite 1B-A400M's real header (plan §2.5): experts in `feed_forward_length`, NO
  // `expert_feed_forward_length` — this returned 0 (priced as dense) before.
  const granite = new GgufMeta({
    architecture: "granitemoe",
    blockCount: 24,
    embeddingLength: 1024,
    expertCount: 32,
    headCount: 16,
    headCountKv: 8,
    feedForwardLength: 512,
  });
  expect(granite.expertByteShare()).toBeGreaterThan(0.9);
  expect(granite.expertByteShare()).toBeLessThan(0.95);
  // A header WITH the expert key is unchanged by the fallback rule.
  const qwenStyle = new GgufMeta({
    architecture: "qwen2moe",
    blockCount: 24,
    embeddingLength: 1024,
    expertCount: 32,
    headCount: 16,
    headCountKv: 8,
    feedForwardLength: 4096,
    expertFeedForwardLength: 512,
  });
  expect(qwenStyle.expertByteShare()).toBeGreaterThan(0.0);
  expect(qwenStyle.expertByteShare()).toBeLessThan(granite.expertByteShare());
});
