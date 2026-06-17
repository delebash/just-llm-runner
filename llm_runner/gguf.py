# SPDX-License-Identifier: GPL-3.0-or-later
"""Minimal GGUF header reader — only the metadata VRAM-fit needs.

GGUF is llama.cpp's model container. We read just the KV-metadata header
(never the tensor data) to extract architecture, transformer-layer count,
embedding dim, and expert count — the inputs to the -ngl / --n-cpu-moe
computation in runner.py. Little-endian (the on-disk default for the
official prebuilt quants).

Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

_MAGIC = b"GGUF"

# ggml metadata value type -> (struct code, byte width) for fixed scalars.
_SCALAR: dict[int, str] = {
    0: "B",   # UINT8
    1: "b",   # INT8
    2: "H",   # UINT16
    3: "h",   # INT16
    4: "I",   # UINT32
    5: "i",   # INT32
    6: "f",   # FLOAT32
    7: "?",   # BOOL (1 byte)
    10: "Q",  # UINT64
    11: "q",  # INT64
    12: "d",  # FLOAT64
}
_TYPE_STRING = 8
_TYPE_ARRAY = 9


@dataclass
class GgufMeta:
    architecture: str
    block_count: int          # transformer layers (n_layers)
    embedding_length: int     # hidden dim
    expert_count: int         # > 0 => MoE

    @property
    def is_moe(self) -> bool:
        return self.expert_count > 0


def _read(f: BinaryIO, code: str):
    return struct.unpack("<" + code, f.read(struct.calcsize("<" + code)))[0]


def _read_string(f: BinaryIO) -> str:
    n = _read(f, "Q")
    return f.read(n).decode("utf-8", errors="replace")


def _read_value(f: BinaryIO, vtype: int):
    """Read (and thereby skip past) one metadata value of the given type."""
    code = _SCALAR.get(vtype)
    if code is not None:
        return _read(f, code)
    if vtype == _TYPE_STRING:
        return _read_string(f)
    if vtype == _TYPE_ARRAY:
        subtype = _read(f, "I")
        count = _read(f, "Q")
        return [_read_value(f, subtype) for _ in range(count)]
    raise ValueError(f"unknown GGUF metadata value type {vtype}")


def read_gguf_metadata(path: Path) -> GgufMeta:
    """Parse the GGUF KV header of `path`.

    For a sharded model, pass shard 00001 — it carries the full metadata.
    Raises ValueError on a non-GGUF file (bad magic).
    """
    with path.open("rb") as f:
        if f.read(4) != _MAGIC:
            raise ValueError(f"{path} is not a GGUF file (bad magic)")
        _version = _read(f, "I")
        _tensor_count = _read(f, "Q")
        kv_count = _read(f, "Q")
        kv: dict[str, object] = {}
        for _ in range(kv_count):
            key = _read_string(f)
            kv[key] = _read_value(f, _read(f, "I"))

    arch = str(kv.get("general.architecture", ""))

    def _int(suffix: str, default: int = 0) -> int:
        v = kv.get(f"{arch}.{suffix}")
        return int(v) if v is not None else default

    return GgufMeta(
        architecture=arch,
        block_count=_int("block_count"),
        embedding_length=_int("embedding_length"),
        expert_count=_int("expert_count", 0),
    )
