# SPDX-License-Identifier: MIT
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

import math

from ..runner.fit import parse_params
from ..runner.gguf import GgufMeta, read_gguf_metadata
from . import stores

# The GGUF header + generation_config publish samplers in llama.cpp's OWN param
# namespace (temp, penalty_repeat, penalty_last_n, …); our knob catalog (seed.py
# Plane-2) + the run path (`_plane2_extra`, which passes flagName VERBATIM into the
# request — prompts.py) use different names for exactly three of them. Normalize
# file → catalog names at THIS read boundary so a seeded sampler actually applies at
# /v1/ai/run (seen = run) instead of landing as an unlabelled "Other keys" no-op.
# Only these three diverge — top_p/top_k/min_p/typical_p/xtc_*/mirostat*/dry_* already
# match the catalog (verified vs seed.py + gguf.py + gguf_remote._GEN_CFG_TO_LLAMA).
_SAMPLER_FILE_TO_CATALOG = {
    "temp": "temperature",
    "penalty_repeat": "repeat_penalty",
    "penalty_last_n": "repeat_last_n",
}


def _fmt_value(v) -> str:
    """A file-derived sampler value as a CLEAN string: GGUF floats arrive as float32
    artifacts ("0.949999988079071" for 0.95 — the user's Edit-form screenshot,
    2026-07-07); round to 4 places and drop trailing zeros so what the form, the
    seeds, and the Lab grid show is the number the file MEANS ("0.95", "1", "64").
    Non-numeric values pass through verbatim."""
    try:
        return f"{round(float(v), 4):g}"
    except (TypeError, ValueError):
        return str(v)


def canonicalize_sampler_names(samplers: dict | None) -> dict:
    """Map a file-derived sampler dict from llama.cpp's param names to our knob-catalog
    names (+ clean float32 noise), so stored + Lab-seeded samplers match the names AND
    the numbers the run path sends. The ONE choke point every derive path flows through."""
    return {_SAMPLER_FILE_TO_CATALOG.get(k, k): _fmt_value(v) for k, v in (samplers or {}).items()}


def model_type_from_meta(meta: GgufMeta) -> str:
    """Capability type from GGUF metadata: a model is MoE iff it has experts."""
    return "moe" if meta.expert_count > 0 else "dense"


def physics_facts_from_meta(meta: GgufMeta) -> dict:
    """The PHYSICS FACTS (fit-redesign §13.11, Phase 2): immutable, config-
    independent properties of the file, persisted so floors/est/badge compute
    FRESH at read instead of being cached values that go stale. A stored fact may
    be DERIVED (`expert_byte_share`, the KV scalars) but never config-dependent.

    The two KV scalars + `sliding_window` collapse `kv_mb_at_ctx`'s per-layer
    arrays into `KV(ctx,bits) = [Wb × min(ctx,window) + Gb × ctx] × bits/8` —
    verified byte-identical to the loop (gguf.py:179-187), including the
    `key_length_swa or key_length` fallback (baked into Wb here) and the uniform
    case (no window pattern → Wb=0, every layer global)."""
    n_layers = max(0, meta.block_count)
    heads = meta.head_count_kv_per_layer
    if len(heads) != n_layers:
        heads = [meta.n_kv_heads] * n_layers
    # Per-head dims, with the same fallbacks kv_exact_mb uses: header dims, else
    # embedding/head_count, else 128 (the typical head_dim).
    head_dim = (meta.embedding_length // meta.head_count) if (meta.head_count and meta.embedding_length) else 0
    k_g = meta.key_length or head_dim or 128
    v_g = meta.value_length or head_dim or 128
    k_w = meta.key_length_swa or k_g
    v_w = meta.value_length_swa or v_g
    pattern = meta.sliding_window_pattern if (
        meta.sliding_window > 0 and len(meta.sliding_window_pattern) == n_layers
    ) else [False] * n_layers
    wb = sum(heads[i] * (k_w + v_w) for i in range(n_layers) if pattern[i])
    gb = sum(heads[i] * (k_g + v_g) for i in range(n_layers) if not pattern[i])
    return {
        "block_count": n_layers,
        "n_kv_heads": int(meta.n_kv_heads or 0),
        "head_count": int(meta.head_count or 0),
        "embedding_length": int(meta.embedding_length or 0),
        "expert_used_count": int(meta.expert_used_count or 0),
        "expert_byte_share": float(meta.expert_byte_share()),
        "kv_windowed_bytes_per_token": float(wb),
        "kv_global_bytes_per_token": float(gb),
        "sliding_window": int(meta.sliding_window or 0),
    }


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
        # HEADER truth only (`nextn_predict_layers>0`) → the `mtp_builtin` column.
        # NEVER the user-facing `mtp` ENABLE flag (2026-07-13 split — see set_derived).
        "mtp_builtin": meta.is_mtp,
        "trained_ctx": meta.context_length or None,
        "total_params": total_params,
        "size_label": meta.size_label,
        "architecture": meta.architecture or "",
        "experts": int(meta.expert_count or 0),
        "samplers": canonicalize_sampler_names({k: str(v) for k, v in (meta.sampling or {}).items()}),
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
            fields["samplers"] = canonicalize_sampler_names(
                {k: str(v) for k, v in (samplers_fallback(meta) or {}).items()}
            )
        except Exception:  # noqa: BLE001 — the sampler fallback is advisory only
            fields["samplers"] = {}
    # The quant-specific file size (#141): from the local file when it exists —
    # best-effort (an injected fake path in tests simply yields None).
    try:
        from pathlib import Path

        size_bytes = Path(gguf_path).stat().st_size
    except OSError:
        size_bytes = None
    # Confirm the VRAM estimate from the real downloaded file (the panel's "confirmed
    # at download" promise) — same helper as the pre-download inspect, so the number
    # never drifts between the two reads.
    est_vram_mb = est_vram_mb_from_meta(meta, size_bytes)
    (store or stores.get_model_catalog_store()).set_derived(
        model_id, model_type=fields["type"], mtp_builtin=fields["mtp_builtin"],
        trained_ctx=fields["trained_ctx"], total_params=fields["total_params"],
        samplers=fields["samplers"],
        architecture=fields["architecture"], experts=fields["experts"],
        size_label=fields["size_label"], size_bytes=size_bytes, est_vram_mb=est_vram_mb,
    )
    return fields["type"]


def backfill_derived_from_cache(rows, cached_path_fn, identify_one) -> int:
    """The seed-vs-file self-heal (2026-07-07, the read-from-link parity item): a DB
    reset re-seeds catalog rows WITHOUT their file-derived facts (samplers/type/mtp/
    trained_ctx are written by identify at DOWNLOAD time only), so a model whose GGUF
    was already on disk shows "Recommended samplers —" forever. For every row whose
    sampler set is EMPTY (the never-derived marker) and whose GGUF is cached, re-run
    identify from the local file. Pure loop — `rows` are catalog rows (`.id`,
    `.samplers`, `.architecture`), `cached_path_fn(id) -> path|None`,
    `identify_one(id, path)` does the store write; install.py wires the real ones
    (on a daemon thread, local-file reads only). Needs-backfill marker: samplers
    empty OR architecture empty (#141 added the identity facts — a row seeded
    before them lacks architecture even when its samplers landed). A model whose
    file truly carries neither re-checks each boot — a local header read,
    milliseconds, accepted over a staleness marker column."""
    done = 0
    for r in rows:
        if getattr(r, "samplers", None) and getattr(r, "architecture", ""):
            continue
        path = cached_path_fn(r.id)
        if not path:
            continue
        try:
            identify_one(r.id, path)
            done += 1
        except Exception:  # noqa: BLE001 — a broken file must not stop the sweep
            continue
    return done


# ctx the pre-download VRAM estimate is quoted at — a realistic working window, not
# the (often huge) trained max; capped by the model's own trained ctx. The spawn
# path recomputes fit precisely, so this is only the Add-form's "will it fit?" guess.
_ESTIMATE_CTX = 8192


def est_vram_mb_from_meta(meta, total_bytes) -> int | None:
    """The Add-form VRAM estimate (full-GPU offload at a realistic 8K ctx), from the
    header inputs + the real download size. ONE source for the pre-download inspect,
    the post-download identify, and the seed-facts refresh — so a seeded row, a live
    Read-from-link, and a downloaded file all show the SAME number (#141 parity).
    None when the header lacks the layer count needed to estimate."""
    from ..runner.fit import estimate_vram_mb

    if not (total_bytes and meta.block_count):
        return None
    return round(estimate_vram_mb(
        size_mb=total_bytes / 1e6, n_layers=meta.block_count, n_kv_heads=meta.n_kv_heads,
        embedding_dim=meta.embedding_length,
        ctx_size=min(meta.context_length or _ESTIMATE_CTX, _ESTIMATE_CTX),
        cache_type=16, gpu_layers=meta.block_count,
    ))


# The real-RAM ladder a PC actually ships (GB) — the rungs the Add form's Min RAM
# floor is allowed to land on, so a hand-added model names a REAL machine size
# rather than an odd number no class ever matches.
_RAM_RUNGS_GB = (8, 10, 12, 16, 24, 32, 48, 64, 96, 128)
# OS + engine + KV + working set on top of the weights (the seeded rows' "overhead").
_RAM_HEADROOM_MB = 4096


def est_ram_mb_from_bytes(total_bytes) -> int | None:
    """The Add-form Min-RAM estimate, from the download size ALONE (hence
    `from_bytes`, not `from_meta`: nothing in the GGUF header enters the rule, so no
    unused parameter pretends otherwise).

    The rule, transcribed from the seeded catalog's own documented basis
    (`llm_runner/llm/seed.py:151-154` — dense: weights-in-RAM + overhead; MoE: the
    FULL model in RAM because experts offload to RAM): ONE formula covers both,
    because both end up holding the whole file. So: file size in MB (decimal, the
    same 1e6 convention `est_vram_mb_from_meta` uses) + 4096 MB headroom, snapped UP
    to the first rung of `_RAM_RUNGS_GB` (returned in MB). Past the top rung there is
    no ladder left, so the computed need is rounded up to the next 32 GB. Falsy size
    (unknown/unread) → None: the form leaves the field blank rather than guess.

    CALIBRATION (re-checked 2026-07-27 AFTER the floors were snapped to binary MB,
    against all ten seeded rows that carry both `min_ram_mb` and `size_bytes`): 8/10
    land on the seeded RUNG. Five of those eight — every CHAT row that matches:
    `gemma-4-12b-qat` 12288, `llama-3.3-70b-q4_k_m` 49152, `qwen3.6-27b`,
    `gryphe-styletune-v2` and `gemma-4-26b-a4b-uncensored-ez` 24576 — are now
    BYTE-equal to the rule's output, because the snap put the chat floors on the same
    binary rungs this ladder returns. The other three (the embed rows: 8000/10000/12000
    against 8192/10240/12288) match at the rung but not to the byte, deliberately: embed
    floors were left decimal in the 2026-07-27 snap (never displayed on a row, and they
    steer wizard placement). `gemma-4-e4b-qat` is the one genuine miss: seeded 8 GB where
    the rule says 10, erring toward MORE RAM, which is the safe direction for a floor.

    KNOWN BLIND SPOT — `glm-4.5-air`, and it is THIS FUNCTION that is wrong there, not the
    seed (user's call, 2026-07-27, after the two-pool arithmetic was put to them). The rule
    reads the file size ALONE, so it charges the WHOLE model to RAM. That holds on a
    CPU-only box and breaks on any row that also carries a VRAM floor, where part of the
    weights live on the card. GLM declares 12 GB VRAM beside its 64 GB RAM (seed.py:258):
    12 + 64 = 76 GB of memory for a 67.7 GB model, so ~56 GB plus overhead in RAM is
    coherent and 64 GB stands. The rule says 96 only because it ignores the 12 GB on the
    GPU. GLM is the only seeded row big enough for that gap to cross a rung, which is why
    it is the one that exposes this.

    The blind spot is left IN PLACE deliberately: a hand-added model has no VRAM floor yet
    when this runs (the user types that field, or it arrives from `est_vram_mb_from_meta`
    in the same read), and over-stating a floor is the safe error for a number whose job is
    to say "this will not fit". Fixing it means deciding how much of a file to charge to
    VRAM — a real design call, not a tweak. NOT proven by anyone running GLM on a 64 GB
    box; nobody here owns one. This is arithmetic across two pools plus the seed author's
    original judgement, which the user declined to overturn.

    The seeded rows are NOT re-derived from this function — it only fills a BLANK field on
    the Add/Edit form.
    """
    if not total_bytes:
        return None
    need_mb = math.ceil(total_bytes / 1e6) + _RAM_HEADROOM_MB
    for rung_gb in _RAM_RUNGS_GB:
        if need_mb <= rung_gb * 1024:
            return rung_gb * 1024
    step = 32 * 1024
    return math.ceil(need_mb / step) * step


def inspect_model_from_link(repo: str, quant: str, revision: str = "main") -> dict:
    """PRE-download: range-read the GGUF header from the HF link (no weights) and
    return the file-derived catalog facts + the real download size + a VRAM estimate,
    so the Add-a-model form fills `type`/`mtp`/`trained_ctx`/`samplers`/size BEFORE a
    multi-GB download. The pre-download sibling of `detect_and_store_model_type`
    (post-download); both share `derived_fields_from_meta` + the generation_config
    sampler fallback (the plan's header -> generation_config -> generic precedence).

    Feeds `estimate_vram_mb` the REAL header inputs + real size (carry-forward #1):
    the fit estimate is grounded in the file, not the hand-typed `min_vram` guess."""
    from ..runner.gguf_remote import fetch_generation_config_samplers, fetch_gguf_meta

    meta, total = fetch_gguf_meta(repo, quant, revision)
    fields = derived_fields_from_meta(meta)
    if not fields["samplers"] and meta.base_repo_url:
        fields["samplers"] = canonicalize_sampler_names(
            {k: str(v) for k, v in fetch_generation_config_samplers(meta.base_repo_url).items()}
        )
    est_vram_mb = est_vram_mb_from_meta(meta, total)
    # Tier-C inherited drafter (2026-07-13): built-in MTP models need none, and the
    # repo's OWN drafts are pre-picked from the list-files listing — so only probe the
    # official base family when the header carries no built-in MTP. Best-effort; a
    # miss (or any network hiccup) simply yields no suggestion.
    inherited: dict | None = None
    if not fields["mtp_builtin"]:
        from ..runner.models import find_inherited_mtp_drafter

        try:
            inherited = find_inherited_mtp_drafter(
                repo, meta.architecture or "", meta.base_repo_url or "", revision
            )
        except Exception:  # noqa: BLE001 — discovery is advisory, never fails inspect
            inherited = None
    return {
        "architecture": meta.architecture, "type": fields["type"],
        # HEADER truth → the read-only "auto-detected" panel + the mtp_builtin column.
        # The user-facing MTP ENABLE flag is computed UI-side (builtin OR draft OR the
        # inherited drafter below), never overwritten by this read.
        "mtpBuiltin": fields["mtp_builtin"],
        "trainedCtx": fields["trained_ctx"], "experts": meta.expert_count,
        "sizeLabel": meta.size_label, "totalParams": fields["total_params"] or "",
        "samplers": fields["samplers"], "sizeBytes": int(total), "estVramMb": est_vram_mb,
        # The Min-RAM floor's pre-download guess (size-only rule — see
        # est_ram_mb_from_bytes); the VRAM estimate's mirror, so BOTH class floors
        # arrive filled and a hand-added model can belong to a PC class at all.
        "estRamMb": est_ram_mb_from_bytes(total),
        # Tier-C: a borrowable OFFICIAL drafter when the model has no MTP of its own.
        "mtpInheritedRepo": (inherited or {}).get("repo", ""),
        "mtpInheritedFile": (inherited or {}).get("file", ""),
        "mtpInheritedQuant": (inherited or {}).get("quant", ""),
    }
