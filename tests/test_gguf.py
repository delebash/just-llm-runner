# SPDX-License-Identifier: GPL-3.0-or-later
"""GGUF header reader — built against synthetic GGUF blobs (no real model)."""

from __future__ import annotations

import struct

import pytest

from llm_runner.gguf import read_gguf_metadata


def _gstr(s: str) -> bytes:
    b = s.encode()
    return struct.pack("<Q", len(b)) + b


def _kv_u32(key: str, val: int) -> bytes:
    return _gstr(key) + struct.pack("<I", 4) + struct.pack("<I", val)  # type 4 = UINT32


def _kv_str(key: str, val: str) -> bytes:
    return _gstr(key) + struct.pack("<I", 8) + _gstr(val)  # type 8 = STRING


def _kv_u32_array(key: str, vals: list[int]) -> bytes:
    # type 9 = ARRAY; subtype 4 = UINT32; then count + elements.
    body = struct.pack("<I", 4) + struct.pack("<Q", len(vals))
    body += b"".join(struct.pack("<I", v) for v in vals)
    return _gstr(key) + struct.pack("<I", 9) + body


def _build_gguf(kvs: list[bytes]) -> bytes:
    header = b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", 0) + struct.pack("<Q", len(kvs))
    return header + b"".join(kvs)


def test_read_dense_model(tmp_path):
    p = tmp_path / "dense.gguf"
    p.write_bytes(_build_gguf([
        _kv_str("general.architecture", "llama"),
        _kv_u32("llama.block_count", 32),
        _kv_u32("llama.embedding_length", 4096),
    ]))
    m = read_gguf_metadata(p)
    assert m.architecture == "llama"
    assert m.block_count == 32
    assert m.embedding_length == 4096
    assert m.expert_count == 0
    assert not m.is_moe


def test_read_moe_model_skipping_an_array_kv(tmp_path):
    # The ARRAY sits BETWEEN the keys we want — if array-skipping is wrong,
    # embedding_length/expert_count would misparse and the asserts fail.
    p = tmp_path / "moe.gguf"
    p.write_bytes(_build_gguf([
        _kv_str("general.architecture", "qwen3moe"),
        _kv_u32("qwen3moe.block_count", 48),
        _kv_u32_array("qwen3moe.some_array", [10, 20, 30, 40]),
        _kv_u32("qwen3moe.embedding_length", 2048),
        _kv_u32("qwen3moe.expert_count", 128),
    ]))
    m = read_gguf_metadata(p)
    assert m.architecture == "qwen3moe"
    assert m.block_count == 48
    assert m.embedding_length == 2048
    assert m.expert_count == 128
    assert m.is_moe


def test_bad_magic_raises(tmp_path):
    p = tmp_path / "notgguf.bin"
    p.write_bytes(b"NOPE" + b"\x00" * 32)
    with pytest.raises(ValueError):
        read_gguf_metadata(p)
