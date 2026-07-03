# SPDX-License-Identifier: GPL-3.0-or-later
"""Model identity auto-detection — read a model's GGUF header and ground its
catalog capability fields in the FILE rather than a hand-typed guess: `type`
(moe|dense from `expert_count`), `mtp` (from `nextn_predict_layers`), `trained_ctx`
(from `context_length`), and the recommended sampler baseline (`general.sampling.*`,
else the origin repo's generation_config.json). Design
docs/plans/2026-06-27-switch-and-preset-architecture S3 / D17 +
docs/plans/2026-07-02-gguf-grounded-model-layer.md Phase 2 (in justwrite-app).

`mtp` IS inferred here now — the GGUF Phase-1 reader added the
`nextn_predict_layers` signal, so a model with `nextn_predict_layers > 0` is
detected as shipping MTP draft layers. This replaces the old "mtp is not
GGUF-detectable, keep it a manual flag" note, which the file disproved (Qwen /
GLM headers both carry `<arch>.nextn_predict_layers`).
"""

from __future__ import annotations

from ..runner.fit import parse_params
from ..runner.gguf import GgufMeta, read_gguf_metadata
from . import stores


def model_type_from_meta(meta: GgufMeta) -> str:
    """Capability type from GGUF metadata: a model is MoE iff it has experts."""
    return "moe" if meta.expert_count > 0 else "dense"


def derived_fields_from_meta(meta: GgufMeta) -> dict:
    """The catalog facts grounded in one GGUF header read: capability `type`, the
    `mtp` flag, the trained context length, and the model's recommended sampler
    baseline (llama.cpp param name -> string value). ONE mapping, reused by the
    post-download identity path AND the pre-download `/inspect` endpoint."""
    # general.size_label is the param count for a DENSE model ("27B"); a MoE label
    # ("128x9.4B", or an HF-style "235B-A22B") is an expert-config that does NOT
    # decompose to total/active params (GGUF spec, verified 2026-07-03) — so file-derive
    # total_params ONLY for a DENSE model whose label parses as a plain scale; None for
    # every MoE (the `not is_moe` gate stops an "235B-A22B" label clobbering the curated
    # total) and for an unparseable label → the curated value is preserved.
    total_params = meta.size_label if (not meta.is_moe and parse_params(meta.size_label)) else None
    return {
        "type": model_type_from_meta(meta),
        "mtp": meta.is_mtp,
        "trained_ctx": meta.context_length or None,
        "total_params": total_params,
        "size_label": meta.size_label,
        "samplers": {k: str(v) for k, v in (meta.sampling or {}).items()},
    }


def detect_and_store_model_type(
    model_id: str, gguf_path, *, read_meta=read_gguf_metadata, store=None,
    samplers_fallback=None,
) -> str:
    """Read `gguf_path`'s GGUF header -> set `model_catalog` `type`/`mtp`/`trained_ctx`
    + replace `model_id`'s recommended sampler rows, and return the detected `type`.
    `read_meta` / `store` are injectable for tests. When the header carries no
    `general.sampling.*`, `samplers_fallback(meta) -> dict` (if given) supplies the
    recommended samplers from the origin repo's generation_config.json (the plan's
    header -> generation_config -> generic precedence). Preserves `built_in`
    (`set_derived`, like the old `set_type`); never fails the caller on a fallback
    error — sampler capture is advisory."""
    meta = read_meta(gguf_path)
    fields = derived_fields_from_meta(meta)
    if not fields["samplers"] and samplers_fallback is not None:
        try:
            fields["samplers"] = {k: str(v) for k, v in (samplers_fallback(meta) or {}).items()}
        except Exception:  # noqa: BLE001 — the sampler fallback is advisory only
            fields["samplers"] = {}
    (store or stores.get_model_catalog_store()).set_derived(
        model_id, model_type=fields["type"], mtp=fields["mtp"],
        trained_ctx=fields["trained_ctx"], total_params=fields["total_params"],
        samplers=fields["samplers"],
    )
    return fields["type"]


# ctx the pre-download VRAM estimate is quoted at — a realistic working window, not
# the (often huge) trained max; capped by the model's own trained ctx. The spawn
# path recomputes fit precisely, so this is only the Add-form's "will it fit?" guess.
_ESTIMATE_CTX = 8192


def inspect_model_from_link(repo: str, quant: str, revision: str = "main") -> dict:
    """PRE-download: range-read the GGUF header from the HF link (no weights) and
    return the file-derived catalog facts + the real download size + a VRAM estimate,
    so the Add-a-model form fills `type`/`mtp`/`trained_ctx`/`samplers`/size BEFORE a
    multi-GB download. The pre-download sibling of `detect_and_store_model_type`
    (post-download); both share `derived_fields_from_meta` + the generation_config
    sampler fallback (the plan's header -> generation_config -> generic precedence).

    Feeds `estimate_vram_mb` the REAL header inputs + real size (carry-forward #1):
    the fit estimate is grounded in the file, not the hand-typed `min_vram` guess."""
    from ..runner.fit import estimate_vram_mb
    from ..runner.gguf_remote import fetch_generation_config_samplers, fetch_gguf_meta

    meta, total = fetch_gguf_meta(repo, quant, revision)
    fields = derived_fields_from_meta(meta)
    if not fields["samplers"] and meta.base_repo_url:
        fields["samplers"] = {
            k: str(v) for k, v in fetch_generation_config_samplers(meta.base_repo_url).items()
        }
    est_vram_mb = None
    if total and meta.block_count:
        est_vram_mb = round(estimate_vram_mb(
            size_mb=total / 1e6, n_layers=meta.block_count, n_kv_heads=meta.n_kv_heads,
            embedding_dim=meta.embedding_length,
            ctx_size=min(meta.context_length or _ESTIMATE_CTX, _ESTIMATE_CTX),
            cache_type=16, gpu_layers=meta.block_count,
        ))
    return {
        "architecture": meta.architecture, "type": fields["type"], "mtp": fields["mtp"],
        "trainedCtx": fields["trained_ctx"], "experts": meta.expert_count,
        "sizeLabel": meta.size_label, "totalParams": fields["total_params"] or "",
        "samplers": fields["samplers"], "sizeBytes": int(total), "estVramMb": est_vram_mb,
    }
