# SPDX-License-Identifier: GPL-3.0-or-later
"""GGUF identity auto-detect → model_catalog.type (design S3 / D17). Pure logic +
the catalog write; the GGUF read is injected, so no real GGUF bytes are needed."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db, identity, seed, stores
from llm_runner.runner.gguf import GgufMeta


@pytest.fixture
def configured():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    s = db.session()
    seed.seed_default_catalog(s)
    s.commit()
    s.close()
    yield


def _meta(expert_count):
    return GgufMeta(
        architecture="x", block_count=10, embedding_length=1000, expert_count=expert_count
    )


def _meta_full(*, expert_count=0, nextn=0, ctx=0, sampling=None, size_label=""):
    return GgufMeta(
        architecture="qwen35", block_count=65, embedding_length=5120,
        expert_count=expert_count, context_length=ctx, nextn_predict_layers=nextn,
        size_label=size_label, sampling=sampling or {},
    )


def _row(model_id):
    return next(r for r in stores.get_model_catalog_store().list() if r.id == model_id)


def test_type_from_meta():
    assert identity.model_type_from_meta(_meta(128)) == "moe"
    assert identity.model_type_from_meta(_meta(0)) == "dense"


def test_detect_flips_type_to_moe_and_keeps_built_in(configured):
    mid = "qwen3.5-9b-q4_k_m"  # seeded type=dense, built_in=True
    assert _row(mid).type == "dense"
    assert _row(mid).builtIn is True
    out = identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta(128))
    assert out == "moe"
    after = _row(mid)
    assert after.type == "moe"
    assert after.builtIn is True  # set_type preserves built_in (upsert would not)


def test_detect_dense_is_noop_when_already_dense(configured):
    mid = "qwen3.5-9b-q4_k_m"
    out = identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta(0))
    assert out == "dense"
    assert _row(mid).type == "dense"


def test_derived_fields_from_meta():
    f = identity.derived_fields_from_meta(
        _meta_full(nextn=1, ctx=262144, sampling={"temp": 1.0, "top_k": 20})
    )
    assert f["type"] == "dense" and f["mtp"] is True and f["trained_ctx"] == 262144
    assert f["samplers"] == {"temp": "1.0", "top_k": "20"}  # llama.cpp keys, string values
    # dense / no-mtp / no-ctx / no-sampling -> falsy fields (None trained_ctx, {} samplers)
    g = identity.derived_fields_from_meta(_meta_full())
    assert g["type"] == "dense" and g["mtp"] is False
    assert g["trained_ctx"] is None and g["samplers"] == {}


def test_derived_total_params_from_size_label():
    # dense: general.size_label "27B" parses -> file-derived total_params
    f = identity.derived_fields_from_meta(_meta_full(size_label="27B"))
    assert f["total_params"] == "27B" and f["size_label"] == "27B"
    # MoE expert-label "128x9.4B" does NOT parse -> None (the curated total is preserved)
    g = identity.derived_fields_from_meta(_meta_full(expert_count=128, size_label="128x9.4B"))
    assert g["total_params"] is None and g["size_label"] == "128x9.4B"
    # a MoE whose label DOES parse ("235B-A22B" → parse_params reads "235B") must STILL be
    # None — the is_moe gate prevents clobbering a curated MoE total.
    h = identity.derived_fields_from_meta(_meta_full(expert_count=8, size_label="235B-A22B"))
    assert h["total_params"] is None


def test_detect_writes_total_params_for_dense_only(configured):
    mid = "qwen3.5-9b-q4_k_m"   # seeded total_params "9B"
    identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta_full(size_label="27B"))
    assert _row(mid).totalParams == "27B"   # dense size_label overwrote the seed
    # a MoE-style label must NOT clobber the stored value (size_label isn't the total)
    identity.detect_and_store_model_type(
        mid, "x.gguf", read_meta=lambda _p: _meta_full(expert_count=128, size_label="128x9.4B"))
    assert _row(mid).totalParams == "27B"   # unchanged


def test_detect_stores_mtp_ctx_and_samplers(configured):
    mid = "qwen3.5-9b-q4_k_m"  # seeded dense / built_in, no mtp / ctx / samplers
    out = identity.detect_and_store_model_type(
        mid, "x.gguf",
        read_meta=lambda _p: _meta_full(nextn=1, ctx=262144, sampling={"temp": 1.0, "top_k": 20}),
    )
    assert out == "dense"
    row = _row(mid)
    assert row.mtp is True and row.trainedCtx == 262144
    assert row.samplers == {"temp": "1.0", "top_k": "20"}
    assert row.builtIn is True  # set_derived preserves built_in (unlike upsert)


def test_detect_replaces_samplers_and_uses_fallback(configured):
    mid = "qwen3.5-9b-q4_k_m"
    # 1) header ships samplers -> stored verbatim
    identity.detect_and_store_model_type(
        mid, "x.gguf", read_meta=lambda _p: _meta_full(sampling={"temp": 0.7}))
    assert _row(mid).samplers == {"temp": "0.7"}
    # 2) header EMPTY + a fallback -> fallback fills, and it REPLACES the prior set
    identity.detect_and_store_model_type(
        mid, "x.gguf", read_meta=lambda _p: _meta_full(sampling={}),
        samplers_fallback=lambda _m: {"top_p": 0.8})
    assert _row(mid).samplers == {"top_p": "0.8"}
    # 3) header EMPTY + no fallback -> the sampler set is cleared
    identity.detect_and_store_model_type(
        mid, "x.gguf", read_meta=lambda _p: _meta_full(sampling={}))
    assert _row(mid).samplers == {}


def test_inspect_model_from_link(monkeypatch):
    from llm_runner.runner import gguf_remote
    meta = _meta_full(nextn=1, ctx=262144, sampling={"temp": 1.0, "top_k": 20}, size_label="27B")
    monkeypatch.setattr(gguf_remote, "fetch_gguf_meta",
                        lambda repo, quant, revision="main": (meta, 17_000_000_000))
    out = identity.inspect_model_from_link("unsloth/Qwen3.6-27B-MTP-GGUF", "Q4_K_M")
    assert out["type"] == "dense" and out["mtp"] is True and out["trainedCtx"] == 262144
    assert out["experts"] == 0 and out["architecture"] == "qwen35"
    assert out["sizeLabel"] == "27B" and out["totalParams"] == "27B"  # dense param count from size_label
    assert out["samplers"] == {"temp": "1.0", "top_k": "20"}
    assert out["sizeBytes"] == 17_000_000_000
    assert out["estVramMb"] and out["estVramMb"] > 0  # estimate_vram_mb fed the REAL header + size


def test_inspect_uses_generation_config_fallback(monkeypatch):
    from llm_runner.runner import gguf_remote
    meta = _meta_full(expert_count=128, nextn=1, ctx=131072, sampling={})  # GLM-like: no header samplers
    meta.base_repo_url = "https://huggingface.co/zai-org/GLM-4.5-Air"
    monkeypatch.setattr(gguf_remote, "fetch_gguf_meta", lambda *a, **k: (meta, 68_000_000_000))
    monkeypatch.setattr(gguf_remote, "fetch_generation_config_samplers",
                        lambda url, revision="main": {"temp": 0.6, "top_p": 0.95})
    out = identity.inspect_model_from_link("unsloth/GLM-4.5-Air-GGUF", "UD-Q4_K_XL")
    assert out["type"] == "moe" and out["experts"] == 128 and out["mtp"] is True
    assert out["samplers"] == {"temp": "0.6", "top_p": "0.95"}  # from generation_config.json fallback
