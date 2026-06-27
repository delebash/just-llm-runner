# SPDX-License-Identifier: GPL-3.0-or-later
"""Model identity auto-detection — read a downloaded model's GGUF header and set
its catalog capability `type` (moe | dense) from `expert_count`, so the type
default switch preset that pre-fills a Profile is grounded in the file rather
than a hand-typed guess (design docs/plans/2026-06-27-switch-and-preset-architecture
S3 / D17, in justwrite-app).

`mtp` is deliberately NOT inferred here — the current GGUF reader exposes no
speculative-decode signal, so that stays a manual flag pending an upstream check
(do not guess a GGUF key that may not exist).
"""

from __future__ import annotations

from ..runner.gguf import GgufMeta, read_gguf_metadata
from . import stores


def model_type_from_meta(meta: GgufMeta) -> str:
    """Capability type from GGUF metadata: a model is MoE iff it has experts."""
    return "moe" if meta.expert_count > 0 else "dense"


def detect_and_store_model_type(
    model_id: str, gguf_path, *, read_meta=read_gguf_metadata, store=None
) -> str:
    """Read `gguf_path`'s GGUF header → set `model_catalog.type` for `model_id`
    from `expert_count`, and return the detected type. `read_meta` / `store` are
    injectable for tests. The write is a no-op when the stored type already
    matches (`set_type` preserves `built_in`)."""
    mtype = model_type_from_meta(read_meta(gguf_path))
    (store or stores.get_model_catalog_store()).set_type(model_id, mtype)
    return mtype
