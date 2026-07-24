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
    # FFN dims (2026-07-24, the ncmoe-aware fit): the dense FFN width, the PER-EXPERT
    # FFN width, and the shared-expert FFN width — standard GGUF keys
    # (<arch>.feed_forward_length / .expert_feed_forward_length /
    # .expert_shared_feed_forward_length). 0 = absent; `expert_byte_share` then
    # honestly returns 0 (no discount) rather than guessing.
    feed_forward_length: int = 0
    expert_feed_forward_length: int = 0
    expert_shared_feed_forward_length: int = 0
    # iSWA facts (2026-07-24, the honest-KV term): interleaved sliding-window models
    # (Gemma 3/4) keep only a small window of KV on most layers, so the uniform
    # full-ctx KV projection overbooks by GBs (the real Gemma-4 26B header: 25/30
    # layers windowed at 1024 → real KV ~450 MB at 32k ctx vs ~5.4 GB projected).
    # `sliding_window_pattern`: per-layer, True = windowed layer; `head_count_kv`
    # arrives PER-LAYER as an array on these arches (read into
    # head_count_kv_per_layer; the scalar `head_count_kv` stays 0 then, and
    # `n_kv_heads` keeps its scalar semantics). key/value_length are PER-HEAD dims
    # (the _swa variants apply on windowed layers). All default-empty — absent
    # facts → `kv_mb_at_ctx` returns None → the fitted-regression KV term as ever.
    head_count_kv_per_layer: list[int] = field(default_factory=list)
    sliding_window: int = 0
    sliding_window_pattern: list[bool] = field(default_factory=list)
    key_length: int = 0
    value_length: int = 0
    key_length_swa: int = 0
    value_length_swa: int = 0
    # general.size_label — the param-scale label. Dense = the param count ("27B");
    # MoE = an expert-config label ("128x9.4B") that does NOT decompose into
    # total/active params (spec docs/gguf.md: "number of weights and experts").
    size_label: str = ""
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

    def expert_byte_share(self) -> float:
        """Fraction of a repeating layer's weight BYTES held by the routed-expert FFN
        tensors (`ffn_*_exps`) — the tensors `--n-cpu-moe` keeps in system RAM.
        Structural, from header dims only (uniform-quant assumption; bytes ∝ params):

            experts   ≈ 3 · n_embd · expert_ff · expert_count      (gate/up/down × E)
            attention ≈ n_embd² · (2 + 2·kv_ratio)                 (q,o + GQA-scaled k,v)
            dense FFN ≈ 3 · n_embd · ff                            (when the arch has one)
            shared    ≈ 3 · n_embd · shared_ff                     (NOT moved by n-cpu-moe:
                                                                    its tensors are *_shexp,
                                                                    outside the exps pattern)

        Returns 0 for dense models or when the expert dims are absent from the header —
        no guessed constants, the caller then applies no discount (the pre-2026-07-24
        behavior). Attention uses head_dim·n_head ≈ n_embd; when head counts are absent
        it falls back to MHA (kv_ratio 1), which OVERSTATES attention and therefore
        UNDERSTATES the share — the conservative direction (books more VRAM, never less)."""
        if self.expert_count <= 0 or self.expert_feed_forward_length <= 0 or self.embedding_length <= 0:
            return 0.0
        n_embd = float(self.embedding_length)
        kv_ratio = (
            self.head_count_kv / self.head_count
            if self.head_count > 0 and self.head_count_kv > 0 else 1.0
        )
        attention = n_embd * n_embd * (2.0 + 2.0 * kv_ratio)
        dense_ffn = 3.0 * n_embd * float(self.feed_forward_length)
        shared = 3.0 * n_embd * float(self.expert_shared_feed_forward_length)
        experts = 3.0 * n_embd * float(self.expert_feed_forward_length) * self.expert_count
        total = attention + dense_ffn + shared + experts
        return experts / total if total > 0 else 0.0

    def kv_mb_at_ctx(self, ctx: int, cache_bits: int) -> float | None:
        """The PRECISE whole-model KV-cache size (MiB) at `ctx`, from the header's
        per-layer facts — for iSWA models ONLY (2026-07-24): a windowed layer holds
        `min(ctx, sliding_window)` tokens, a global layer the full ctx, each at its
        own KV-head count and (per-head) K/V dims. Returns None unless the header
        carries the full iSWA picture (a window, a per-layer pattern matching
        block_count, per-head dims) — the caller then keeps the fitted regression's
        uniform KV term, so non-iSWA models are byte-identical to before. Uniform
        full-attention models stay on the regression ON PURPOSE: its KV factor is
        part of the fitted calibration; only the model class it fundamentally
        mismodels (windowed layers) earns the precise path."""
        if (
            self.sliding_window <= 0
            or len(self.sliding_window_pattern) != self.block_count
            or self.block_count <= 0
            or self.key_length <= 0
            or self.value_length <= 0
            or ctx <= 0
        ):
            return None
        heads = self.head_count_kv_per_layer
        if len(heads) != self.block_count:
            h = self.n_kv_heads
            if h <= 0:
                return None
            heads = [h] * self.block_count
        bytes_per_elem = max(1, cache_bits) / 8.0
        total_bytes = 0.0
        for i, windowed in enumerate(self.sliding_window_pattern):
            if windowed:
                tokens = min(ctx, self.sliding_window)
                k, v = (self.key_length_swa or self.key_length), (self.value_length_swa or self.value_length)
            else:
                tokens = ctx
                k, v = self.key_length, self.value_length
            total_bytes += heads[i] * (k + v) * tokens * bytes_per_elem
        return total_bytes / 1e6


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


# The ONLY array keys we materialise (2026-07-24, the iSWA KV term) — per-layer
# facts, one element per transformer layer, so tiny. Everything else (tokenizer
# tokens/merges — hundreds of thousands of entries) stays skipped, which is what
# keeps the remote range-read small.
_WANTED_ARRAY_SUFFIXES = (".attention.head_count_kv", ".attention.sliding_window_pattern")
_ARRAY_CAP = 512  # layers, generously; a bigger array is not a per-layer fact


def _read_array_capped(f: BinaryIO) -> list | None:
    """Read one array value IF it is a small scalar/bool array (≤ _ARRAY_CAP);
    otherwise consume-and-skip it (returns None). The stream is left positioned
    after the array either way."""
    subtype = _read(f, "I")
    count = _read(f, "Q")
    scalar = _SCALAR.get(subtype)
    if scalar is not None and count <= _ARRAY_CAP:
        return [_read(f, scalar[0]) for _ in range(count)]
    if scalar is not None:
        f.seek(count * scalar[1], 1)
    elif subtype == _TYPE_STRING:
        for _ in range(count):
            f.seek(_read(f, "Q"), 1)
    elif subtype == _TYPE_ARRAY:
        for _ in range(count):
            _skip_array(f)
    else:
        raise ValueError(f"unknown GGUF array subtype {subtype}")
    return None


def _meta_from_kv(kv: dict[str, object]) -> GgufMeta:
    arch = str(kv.get("general.architecture", ""))

    def _int(suffix: str, default: int = 0) -> int:
        v = kv.get(f"{arch}.{suffix}")
        # A per-layer ARRAY under a scalar key (Gemma-4 ships attention.head_count_kv
        # per layer) is NOT the scalar — the caller reads it via _int_list instead.
        return int(v) if v is not None and not isinstance(v, list) else default

    def _int_list(suffix: str) -> list[int]:
        v = kv.get(f"{arch}.{suffix}")
        return [int(x) for x in v] if isinstance(v, list) else []

    def _bool_list(suffix: str) -> list[bool]:
        v = kv.get(f"{arch}.{suffix}")
        return [bool(x) for x in v] if isinstance(v, list) else []

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
        feed_forward_length=_int("feed_forward_length", 0),
        expert_feed_forward_length=_int("expert_feed_forward_length", 0),
        expert_shared_feed_forward_length=_int("expert_shared_feed_forward_length", 0),
        head_count_kv_per_layer=_int_list("attention.head_count_kv"),
        sliding_window=_int("attention.sliding_window", 0),
        sliding_window_pattern=_bool_list("attention.sliding_window_pattern"),
        key_length=_int("attention.key_length", 0),
        value_length=_int("attention.value_length", 0),
        key_length_swa=_int("attention.key_length_swa", 0),
        value_length_swa=_int("attention.value_length_swa", 0),
        file_type=int(kv.get("general.file_type") or 0),
        size_label=str(kv.get("general.size_label") or ""),
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
            vtype = _read(f, "I")
            if vtype == _TYPE_ARRAY and key.endswith(_WANTED_ARRAY_SUFFIXES):
                kv[key] = _read_array_capped(f)  # per-layer fact — materialised
            else:
                kv[key] = _read_value(f, vtype)
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
