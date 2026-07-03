# SPDX-License-Identifier: GPL-3.0-or-later
"""GGUF header reader — built against synthetic GGUF blobs (no real model)."""

from __future__ import annotations

import io
import struct

import pytest

from llm_runner.runner.gguf import read_gguf_metadata, read_gguf_metadata_from_stream


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


def _kv_f32(key: str, val: float) -> bytes:
    return _gstr(key) + struct.pack("<I", 6) + struct.pack("<f", val)  # type 6 = FLOAT32


def _kv_str_array(key: str, vals: list[str]) -> bytes:
    # type 9 = ARRAY; subtype 8 = STRING (the big tokenizer-token/merge shape).
    body = struct.pack("<I", 8) + struct.pack("<Q", len(vals))
    body += b"".join(_gstr(v) for v in vals)
    return _gstr(key) + struct.pack("<I", 9) + body


def test_stream_parse_all_new_fields_incl_sampling():
    """Phase-1 fields from the REMOTE stream path (BytesIO), with a big STRING
    array (tokenizer-like) sitting between the keys we want — verifies the
    skip-arrays advance is correct for variable-width string arrays too."""
    blob = _build_gguf([
        _kv_str("general.architecture", "qwen35"),
        _kv_u32("general.file_type", 15),
        _kv_str("general.base_model.0.repo_url", "https://huggingface.co/Qwen/Qwen3.6-27B"),
        _kv_f32("general.sampling.temp", 1.0),
        _kv_u32("general.sampling.top_k", 20),
        _kv_f32("general.sampling.top_p", 0.95),
        _kv_str_array("tokenizer.ggml.tokens", ["a", "bb", "ccc"] * 200),   # skipped
        _kv_u32("qwen35.block_count", 65),
        _kv_u32("qwen35.embedding_length", 5120),
        _kv_u32("qwen35.context_length", 262144),
        _kv_u32("qwen35.nextn_predict_layers", 1),
        _kv_u32("qwen35.attention.head_count", 24),
        _kv_u32("qwen35.attention.head_count_kv", 4),
    ])
    m = read_gguf_metadata_from_stream(io.BytesIO(blob))
    assert m.architecture == "qwen35"
    assert m.context_length == 262144
    assert m.nextn_predict_layers == 1 and m.is_mtp
    assert not m.is_moe                       # dense — no expert_count
    assert m.file_type == 15
    assert m.head_count == 24 and m.head_count_kv == 4
    assert m.base_repo_url == "https://huggingface.co/Qwen/Qwen3.6-27B"
    # sampling extracted with llama.cpp key names (temp/top_k/top_p), NOT knob names
    assert m.sampling["temp"] == pytest.approx(1.0)
    assert m.sampling["top_k"] == 20
    assert m.sampling["top_p"] == pytest.approx(0.95, abs=1e-6)


def test_stream_moe_mtp_and_absent_sampling():
    blob = _build_gguf([
        _kv_str("general.architecture", "glm4moe"),
        _kv_u32("glm4moe.expert_count", 128),
        _kv_u32("glm4moe.expert_used_count", 8),
        _kv_u32("glm4moe.nextn_predict_layers", 1),
        _kv_u32("glm4moe.block_count", 47),
    ])
    m = read_gguf_metadata_from_stream(io.BytesIO(blob))
    assert m.is_moe and m.expert_count == 128 and m.expert_used_count == 8
    assert m.is_mtp                            # GLM-4.5-Air is MoE+MTP
    assert m.sampling == {}                    # no general.sampling.* → generation_config fallback
    assert m.base_repo_url == ""


def test_truncated_header_raises_valueerror():
    blob = _build_gguf([
        _kv_str("general.architecture", "llama"),
        _kv_u32("llama.block_count", 32),
    ])
    with pytest.raises(ValueError):           # a range-read that cut the header short
        read_gguf_metadata_from_stream(io.BytesIO(blob[:-6]))


def test_fetch_gguf_meta_sums_shards_and_parses(monkeypatch):
    """gguf_remote.fetch_gguf_meta with the network stubbed: picks shard 00001
    for the header, sums ALL shard sizes for the weight total."""
    from llm_runner.runner import gguf_remote

    blob = _build_gguf([
        _kv_str("general.architecture", "qwen35"),
        _kv_u32("qwen35.context_length", 262144),
        _kv_u32("qwen35.nextn_predict_layers", 1),
        _kv_f32("general.sampling.temp", 1.0),
    ])
    entries = [
        {"path": "Model-Q4_K_M-00001-of-00002.gguf", "lfs": {"size": 1000}},
        {"path": "Model-Q4_K_M-00002-of-00002.gguf", "lfs": {"size": 2000}},
    ]
    monkeypatch.setattr(gguf_remote, "select_files",
                        lambda repo, quant, mmproj, revision: ("sha", entries))
    monkeypatch.setattr(gguf_remote, "_range_read", lambda url, n, timeout=60: blob)
    meta, total = gguf_remote.fetch_gguf_meta("some/repo-GGUF", "Q4_K_M")
    assert meta.architecture == "qwen35" and meta.is_mtp
    assert meta.sampling["temp"] == pytest.approx(1.0)
    assert total == 3000                       # summed shard sizes (real weight bytes)


def test_repo_from_url():
    from llm_runner.runner.gguf_remote import _repo_from_url
    assert _repo_from_url("https://huggingface.co/Qwen/Qwen3.6-27B") == "Qwen/Qwen3.6-27B"
    assert _repo_from_url("https://huggingface.co/Qwen/Qwen3.6-27B/tree/main") == "Qwen/Qwen3.6-27B"
    assert _repo_from_url("zai-org/GLM-4.5-Air") == "zai-org/GLM-4.5-Air"
    assert _repo_from_url("") == "" and _repo_from_url("nope") == ""


def test_generation_config_samplers_maps_keys(monkeypatch):
    from llm_runner.runner import gguf_remote

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"temperature": 0.7, "top_p": 0.8, "top_k": 20,
                    "repetition_penalty": 1.05, "do_sample": True}

    monkeypatch.setattr(gguf_remote.requests, "get", lambda url, timeout=60: _Resp())
    out = gguf_remote.fetch_generation_config_samplers("Qwen/Qwen3.6-27B")
    # HF names mapped to the llama.cpp namespace; non-numeric (do_sample) dropped.
    assert out == {"temp": 0.7, "top_p": 0.8, "top_k": 20.0, "penalty_repeat": 1.05}


def test_generation_config_samplers_best_effort(monkeypatch):
    from llm_runner.runner import gguf_remote

    def _boom(url, timeout=60):
        raise RuntimeError("404 gated repo")

    monkeypatch.setattr(gguf_remote.requests, "get", _boom)
    assert gguf_remote.fetch_generation_config_samplers("Qwen/Qwen3.6-27B") == {}
    assert gguf_remote.fetch_generation_config_samplers("") == {}  # no repo → no fetch


def test_bool_sampling_key_excluded():
    # a general.sampling.* with a BOOL value must be DROPPED (not coerced to 0/1).
    blob = _build_gguf([
        _kv_str("general.architecture", "llama"),
        _gstr("general.sampling.some_bool") + struct.pack("<I", 7) + struct.pack("<?", True),  # 7 = BOOL
        _kv_f32("general.sampling.temp", 0.8),
    ])
    m = read_gguf_metadata_from_stream(io.BytesIO(blob))
    assert m.sampling == {"temp": pytest.approx(0.8)}


def test_nested_array_value_is_skipped():
    # an ARRAY-of-ARRAY between two wanted keys must be skipped without misparsing.
    inner = struct.pack("<I", 4) + struct.pack("<Q", 2) + struct.pack("<I", 1) + struct.pack("<I", 2)  # u32[2]
    outer_body = struct.pack("<I", 9) + struct.pack("<Q", 2) + inner + inner                            # array[2] of arrays
    blob = _build_gguf([
        _kv_str("general.architecture", "llama"),
        _gstr("llama.nested") + struct.pack("<I", 9) + outer_body,
        _kv_u32("llama.block_count", 40),
    ])
    m = read_gguf_metadata_from_stream(io.BytesIO(blob))
    assert m.architecture == "llama" and m.block_count == 40


def test_fetch_gguf_meta_retries_on_truncated_first_read(monkeypatch):
    from llm_runner.runner import gguf_remote
    full = _build_gguf([
        _kv_str("general.architecture", "qwen35"),
        _kv_u32("qwen35.context_length", 4096),
    ])
    calls = {"n": 0}

    def fake_range_read(url, n, timeout=60):
        calls["n"] += 1
        return full[:8] if calls["n"] == 1 else full   # first read cut short → retry gets the full header

    monkeypatch.setattr(gguf_remote, "select_files",
                        lambda repo, quant, mmproj, revision: ("sha", [{"path": "m-00001-of-00001.gguf", "lfs": {"size": 100}}]))
    monkeypatch.setattr(gguf_remote, "_range_read", fake_range_read)
    meta, total = gguf_remote.fetch_gguf_meta("r/x-GGUF", "Q4_K_M")
    assert meta.architecture == "qwen35" and calls["n"] == 2 and total == 100


def test_range_read_stops_at_n_even_if_cdn_ignores_range(monkeypatch):
    from llm_runner.runner import gguf_remote

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=0):
            yield b"x" * 5_000_000   # CDN streams the whole file despite the Range header
            yield b"y" * 5_000_000

    monkeypatch.setattr(gguf_remote.requests, "get", lambda *a, **k: _Resp())
    assert len(gguf_remote._range_read("http://x", 1000)) == 1000


def test_reads_size_label():
    # _meta_from_kv reads the documented general.size_label key (dense param scale).
    blob = _build_gguf([
        _kv_str("general.architecture", "llama"),
        _kv_str("general.size_label", "27B"),
        _kv_u32("llama.block_count", 32),
    ])
    m = read_gguf_metadata_from_stream(io.BytesIO(blob))
    assert m.size_label == "27B" and m.block_count == 32
