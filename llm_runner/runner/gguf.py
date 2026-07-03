# SPDX-License-Identifier: GPL-3.0-or-later
"""Minimal GGUF header reader — the metadata the model layer needs, from the
KV header only (never the tensor data).

Used two ways (Phase 1, `docs/plans/2026-07-02-gguf-grounded-model-layer.md`):
  * LOCAL  — `read_gguf_metadata(path)` on a downloaded `.gguf` (fit + identity).
  * REMOTE — `read_gguf_metadata_from_stream(BytesIO)` on a range-read of the
    first few MB of a `.gguf` on HuggingFace, so we know a model's facts BEFORE
    a multi-GB download (see `gguf_remote.py`).

Extracts architecture, layer/head/expert counts, context length, the MTP signal
(`<arch>.nextn_predict_layers`), the quant `file_type`, the author-recommended
sampling (`general.sampling.*`), and the base-model repo url (for the
generation_config.json sampling fallback). Array values (tokenizer tokens /
merges / tags / …) are SKIPPED, never materialised — we never use them, and
skipping keeps the remote range-read small + tolerant of a truncated header.
Little-endian (the on-disk default for the official prebuilt quants).

Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
Key names VERIFIED 2026-07-03 against real Qwen3.6-27B (arch `qwen35`, dense+MTP)
and GLM-4.5-Air (arch `glm4moe`, MoE+MTP) headers — see the plan's Phase 1
"KEY NAMES VERIFIED" note. The arch prefix is dynamic (read from
`general.architecture`); `general.sampling.*` is real but patchy (Qwen ships it,
GLM does not → fall back to generation_config.json via `base_repo_url`).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO

_MAGIC = b"GGUF"

# ggml metadata value type -> (struct code, byte width) for fixed scalars.
_SCALAR: dict[int, tuple[str, int]] = {
    0: ("B", 1),   # UINT8
    1: ("b", 1),   # INT8
    2: ("H", 2),   # UINT16
    3: ("h", 2),   # INT16
    4: ("I", 4),   # UINT32
    5: ("i", 4),   # INT32
    6: ("f", 4),   # FLOAT32
    7: ("?", 1),   # BOOL (1 byte)
    10: ("Q", 8),  # UINT64
    11: ("q", 8),  # INT64
    12: ("d", 8),  # FLOAT64
}
_TYPE_STRING = 8
_TYPE_ARRAY = 9


@dataclass
class GgufMeta:
    architecture: str
    block_count: int          # transformer layers (n_layers)
    embedding_length: int     # hidden dim
    expert_count: int         # > 0 => MoE
    head_count: int = 0       # attention heads (n_head)
    head_count_kv: int = 0    # KV heads (n_head_kv); < head_count => GQA
    context_length: int = 0   # trained context window (<arch>.context_length)
    expert_used_count: int = 0        # active experts per token (MoE)
    nextn_predict_layers: int = 0     # <arch>.nextn_predict_layers; > 0 => MTP
    file_type: int = 0                # general.file_type (quant enum)
    # Author-recommended sampling baked into the GGUF header at conversion
    # (general.sampling.*, e.g. {"temp": 1.0, "top_k": 20, "top_p": 0.95}).
    # Empty when the converter did not carry it — the caller then falls back to
    # generation_config.json in `base_repo_url`. These are llama.cpp key names
    # (temp, top_k, top_p, min_p, penalty_repeat, …), NOT our knob names.
    sampling: dict[str, float] = field(default_factory=dict)
    # general.base_model.0.repo_url (else general.source.repo_url) — the ORIGINAL
    # model repo, used to fetch generation_config.json when `sampling` is empty.
    base_repo_url: str = ""

    @property
    def is_moe(self) -> bool:
        return self.expert_count > 0

    @property
    def is_mtp(self) -> bool:
        """Multi-token-prediction (speculative) layers present in the file."""
        return self.nextn_predict_layers > 0

    @property
    def n_kv_heads(self) -> int:
        """KV heads for the cache-size estimate — `head_count_kv` when present
        (GQA/MQA), else `head_count` (full multi-head), else 0 (unknown)."""
        return self.head_count_kv or self.head_count


def _read(f: BinaryIO, code: str):
    return struct.unpack("<" + code, f.read(struct.calcsize("<" + code)))[0]


def _read_string(f: BinaryIO) -> str:
    n = _read(f, "Q")
    return f.read(n).decode("utf-8", errors="replace")


def _skip_array(f: BinaryIO) -> None:
    """Advance past one array value without materialising it (we never use array
    values; skipping keeps the remote range-read small)."""
    subtype = _read(f, "I")
    count = _read(f, "Q")
    scalar = _SCALAR.get(subtype)
    if scalar is not None:
        f.seek(count * scalar[1], 1)          # fixed-width block — one seek
    elif subtype == _TYPE_STRING:
        for _ in range(count):
            f.seek(_read(f, "Q"), 1)          # len-prefixed, variable width
    elif subtype == _TYPE_ARRAY:
        for _ in range(count):
            _skip_array(f)                     # nested (rare)
    else:
        raise ValueError(f"unknown GGUF array subtype {subtype}")


def _read_value(f: BinaryIO, vtype: int):
    """Read one metadata value; arrays are SKIPPED (return None)."""
    scalar = _SCALAR.get(vtype)
    if scalar is not None:
        return _read(f, scalar[0])
    if vtype == _TYPE_STRING:
        return _read_string(f)
    if vtype == _TYPE_ARRAY:
        _skip_array(f)
        return None
    raise ValueError(f"unknown GGUF metadata value type {vtype}")


def _meta_from_kv(kv: dict[str, object]) -> GgufMeta:
    arch = str(kv.get("general.architecture", ""))

    def _int(suffix: str, default: int = 0) -> int:
        v = kv.get(f"{arch}.{suffix}")
        return int(v) if v is not None else default

    prefix = "general.sampling."
    sampling: dict[str, float] = {
        k[len(prefix):]: v
        for k, v in kv.items()
        if k.startswith(prefix) and isinstance(v, (int, float)) and not isinstance(v, bool)
    }
    base_repo = str(
        kv.get("general.base_model.0.repo_url")
        or kv.get("general.source.repo_url")
        or ""
    )
    return GgufMeta(
        architecture=arch,
        block_count=_int("block_count"),
        embedding_length=_int("embedding_length"),
        expert_count=_int("expert_count", 0),
        head_count=_int("attention.head_count", 0),
        head_count_kv=_int("attention.head_count_kv", 0),
        context_length=_int("context_length", 0),
        expert_used_count=_int("expert_used_count", 0),
        nextn_predict_layers=_int("nextn_predict_layers", 0),
        file_type=int(kv.get("general.file_type") or 0),
        sampling=sampling,
        base_repo_url=base_repo,
    )


def read_gguf_metadata_from_stream(f: BinaryIO) -> GgufMeta:
    """Parse a GGUF KV header from an open binary stream — a local file or a
    `BytesIO` of a range-read. Raises `ValueError` on bad magic OR a truncated
    header (the remote caller should re-fetch a larger prefix and retry)."""
    if f.read(4) != _MAGIC:
        raise ValueError("not a GGUF stream (bad magic)")
    try:
        _version = _read(f, "I")
        _tensor_count = _read(f, "Q")
        kv_count = _read(f, "Q")
        kv: dict[str, object] = {}
        for _ in range(kv_count):
            key = _read_string(f)
            kv[key] = _read_value(f, _read(f, "I"))
    except struct.error as e:
        raise ValueError(f"truncated GGUF header ({e}) — range-read a larger prefix") from e
    return _meta_from_kv(kv)


def read_gguf_metadata(path: Path) -> GgufMeta:
    """Parse the GGUF KV header of a local `path`.

    For a sharded model, pass shard 00001 — it carries the full metadata.
    Raises ValueError on a non-GGUF file (bad magic).
    """
    with path.open("rb") as f:
        return read_gguf_metadata_from_stream(f)
