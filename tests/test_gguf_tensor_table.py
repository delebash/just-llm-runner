# SPDX-License-Identifier: MIT
"""The GGUF tensor table (vram-truth plan docs/plans/2026-09-19-vram-truth-exact-bytes-units-offload.md
§6.1): exact per-tensor bytes by OFFSET DELTA, sorted by llama.cpp's own placement
rules. A tiny in-memory GGUF builder drives every case; the real files were checked
against the engine in the plan's §10.2."""
from __future__ import annotations

import struct
from io import BytesIO

import pytest

from llm_runner.runner.gguf import (
    EXPS_REGEX,
    GgufMeta,
    gguf_total_bytes,
    read_gguf_metadata,
    read_gguf_metadata_from_stream,
)

_ALIGN = 32


def _s(text: str) -> bytes:
    b = text.encode("utf-8")
    return struct.pack("<Q", len(b)) + b


def _kv_u32(key: str, v: int) -> bytes:
    return _s(key) + struct.pack("<I", 4) + struct.pack("<I", v)


def _kv_str(key: str, v: str) -> bytes:
    return _s(key) + struct.pack("<I", 8) + _s(v)


def _build(tensors: list[tuple[str, int]], *, arch="llama", blocks=2, experts=4,
           extra_kv: list[bytes] | None = None) -> bytes:
    """A minimal GGUF v3: KVs, tensor infos (offsets aligned), zero-filled data."""
    kvs = [_kv_str("general.architecture", arch), _kv_u32(f"{arch}.block_count", blocks),
           _kv_u32(f"{arch}.embedding_length", 64), _kv_u32(f"{arch}.expert_count", experts),
           *(extra_kv or [])]
    head = b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", len(tensors)) + struct.pack("<Q", len(kvs))
    head += b"".join(kvs)
    offsets, off = [], 0
    for _name, n in tensors:
        offsets.append(off)
        off += n + (-n % _ALIGN)
    for (name, n), o in zip(tensors, offsets):
        head += _s(name) + struct.pack("<I", 1) + struct.pack("<Q", n) + struct.pack("<I", 0) + struct.pack("<Q", o)
    head += b"\0" * (-len(head) % _ALIGN)
    return head + b"\0" * off


def _read(raw: bytes) -> GgufMeta:
    return read_gguf_metadata_from_stream(BytesIO(raw), file_size=len(raw))


def test_offset_delta_sizing_and_the_tied_head():
    raw = _build([("token_embd.weight", 512), ("blk.0.attn_q.weight", 128),
                  ("blk.0.ffn_up_exps.weight", 1024), ("blk.1.attn_q.weight", 128),
                  ("blk.1.ffn_up_exps.weight", 1024), ("output_norm.weight", 32)])
    m = _read(raw)
    assert m.tensor_bytes_known
    assert m.layer_nonexp_bytes == [128, 128]
    assert m.layer_exps_bytes == [1024, 1024]
    # No output.weight → the vocab table is DUPLICATED onto the output device
    # (gemma4.cpp:47) — it counts on the output side AND stays on the input side.
    assert m.output_bytes == 32 + 512
    assert m.input_bytes == 512


def test_untied_head_is_not_duplicated():
    raw = _build([("token_embd.weight", 512), ("blk.0.attn_q.weight", 64),
                  ("blk.1.attn_q.weight", 64), ("output.weight", 256), ("output_norm.weight", 32)])
    m = _read(raw)
    assert m.output_bytes == 256 + 32
    assert m.input_bytes == 512


def test_the_last_tensor_runs_to_the_end_of_the_file():
    raw = _build([("blk.0.attn_q.weight", 64), ("blk.1.attn_q.weight", 96)])
    m = _read(raw)
    assert m.layer_nonexp_bytes == [64, 96]


def test_expert_names_follow_llama_cpps_own_pattern():
    # b10437 common/common.h:1113 — `gate_up` and `chexps` are experts; the router
    # (`ffn_gate_inp`) and shared experts (`_shexp`) are not.
    for name in ("blk.3.ffn_up_exps.weight", "blk.3.ffn_gate_up_exps.weight",
                 "blk.3.ffn_down_chexps.weight", "blk.3.ffn_gate_exps.weight"):
        assert EXPS_REGEX.search(name), name
    for name in ("blk.3.ffn_gate_inp.weight", "blk.3.ffn_up_shexp.weight", "blk.3.ffn_up.weight"):
        assert not EXPS_REGEX.search(name), name


def test_a_leading_dense_block_has_no_expert_bytes():
    raw = _build([("blk.0.ffn_up.weight", 256), ("blk.1.ffn_up_exps.weight", 1024),
                  ("blk.1.attn_q.weight", 64)])
    m = _read(raw)
    assert m.layer_exps_bytes == [0, 1024]
    assert m.layer_nonexp_bytes == [256, 64]


def test_split_model_tables_merge_across_shards(tmp_path):
    a = _build([("token_embd.weight", 512), ("blk.0.attn_q.weight", 128)], blocks=2)
    b = _build([("blk.1.attn_q.weight", 128), ("blk.1.ffn_up_exps.weight", 1024)], blocks=2)
    p1 = tmp_path / "m-00001-of-00002.gguf"
    p2 = tmp_path / "m-00002-of-00002.gguf"
    p1.write_bytes(a)
    p2.write_bytes(b)
    m = read_gguf_metadata(p1)
    assert m.tensor_bytes_known
    assert m.layer_nonexp_bytes == [128, 128] and m.layer_exps_bytes == [0, 1024]
    assert gguf_total_bytes(p1) == len(a) + len(b)       # the model's real size, all parts


def test_a_missing_shard_falls_back_instead_of_a_partial_table(tmp_path):
    p1 = tmp_path / "m-00001-of-00002.gguf"
    p1.write_bytes(_build([("blk.0.attn_q.weight", 128)], blocks=2))
    m = read_gguf_metadata(p1)
    # Shard 2 absent → the exact bytes are UNKNOWN (plan §6.1: never a partial
    # table — shard 1 alone would under-count the model); the formula fallback applies.
    assert not m.tensor_bytes_known
    assert m.block_count == 2                            # the KV facts still read
    assert gguf_total_bytes(p1) == p1.stat().st_size     # best effort for an incomplete download


def test_a_truncated_tensor_table_raises_or_keeps_the_kv_facts():
    raw = _build([("blk.0.attn_q.weight", 128), ("blk.1.attn_q.weight", 128)])
    cut = raw[: len(raw) - 128 - 128 - 40]   # stops inside the tensor infos
    with pytest.raises(ValueError, match="truncated"):
        read_gguf_metadata_from_stream(BytesIO(cut), file_size=len(raw))
    m = read_gguf_metadata_from_stream(BytesIO(cut), file_size=len(raw), strict_tensors=False)
    assert not m.tensor_bytes_known and m.block_count == 2   # KV facts survive


def test_no_file_size_means_kv_only():
    m = read_gguf_metadata_from_stream(BytesIO(_build([("blk.0.attn_q.weight", 64)])))
    assert not m.tensor_bytes_known


def test_a_header_with_no_tensors_stays_unknown_never_zero_bytes():
    raw = _build([], blocks=2)
    assert not _read(raw).tensor_bytes_known


def test_the_fallback_formula_reads_mixtral_style_headers():
    # Granite 1B-A400M's real header (plan §2.5): experts in `feed_forward_length`,
    # NO `expert_feed_forward_length` — this returned 0 (priced as dense) before.
    granite = GgufMeta(architecture="granitemoe", block_count=24, embedding_length=1024,
                       expert_count=32, head_count=16, head_count_kv=8, feed_forward_length=512)
    assert 0.9 < granite.expert_byte_share() < 0.95
    # A header WITH the expert key is unchanged by the fallback rule.
    qwen_style = GgufMeta(architecture="qwen2moe", block_count=24, embedding_length=1024,
                          expert_count=32, head_count=16, head_count_kv=8,
                          feed_forward_length=4096, expert_feed_forward_length=512)
    assert 0.0 < qwen_style.expert_byte_share() < granite.expert_byte_share()
