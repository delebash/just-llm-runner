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
    mid = "llama-3.3-70b-q4_k_m"  # seeded type=dense, built_in=True
    assert _row(mid).type == "dense"
    assert _row(mid).builtIn is True
    out = identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta(128))
    assert out == "moe"
    after = _row(mid)
    assert after.type == "moe"
    assert after.builtIn is True  # set_type preserves built_in (upsert would not)


def test_detect_dense_is_noop_when_already_dense(configured):
    mid = "llama-3.3-70b-q4_k_m"
    out = identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta(0))
    assert out == "dense"
    assert _row(mid).type == "dense"


def test_derived_fields_from_meta():
    f = identity.derived_fields_from_meta(
        _meta_full(nextn=1, ctx=262144, sampling={"temp": 1.0, "top_k": 20, "penalty_repeat": 1.05})
    )
    assert f["type"] == "dense" and f["mtp_builtin"] is True and f["trained_ctx"] == 262144
    # samplers are canonicalized to OUR catalog namespace (temp→temperature,
    # penalty_repeat→repeat_penalty); unchanged keys (top_k) pass through, and values
    # render as the number the file MEANS (float32-noise cleanup: 1.0 → "1").
    assert f["samplers"] == {"temperature": "1", "top_k": "20", "repeat_penalty": "1.05"}
    # dense / no-mtp / no-ctx / no-sampling -> falsy fields (None trained_ctx, {} samplers)
    g = identity.derived_fields_from_meta(_meta_full())
    assert g["type"] == "dense" and g["mtp_builtin"] is False
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


def test_seed_ships_size_facts_and_reseed_fills_empty_only(configured):
    """#12b (2026-07-08): every built-in catalog row seeds its pinned quant's
    size_label + size_bytes (harvested via the Read-from-link inspector, so
    seed == detection), and a RE-seed on an existing DB fills the fields only
    when EMPTY — a download-derived value is never clobbered."""
    from llm_runner.llm import db as _db

    # seeded rows carry the facts (spot-check a dense, a MoE, and an embed)
    assert _row("gemma-4-12b-qat").sizeLabel == "12B"
    assert _row("gemma-4-12b-qat").sizeBytes == 6716355328
    assert _row("glm-4.5-air").sizeLabel == "128x9.4B"
    assert _row("qwen3-embedding-0.6b").sizeBytes == 639150592

    s = _db.session()
    try:
        # simulate a pre-#12b row (empty facts) + a download-derived row (real file)
        blank = s.query(_db.ModelCatalog).get("bge-m3")
        blank.size_label, blank.size_bytes = "", None
        derived = s.query(_db.ModelCatalog).get("gemma-4-31b-qat")
        derived.size_bytes = 12345  # "the local file said so" — must survive reseed
        s.commit()

        assert seed.seed_default_catalog(s) == 0  # nothing inserted…
        s.commit()
    finally:
        s.close()
    assert _row("bge-m3").sizeBytes == 437778496       # …but the empty row was filled
    assert _row("bge-m3").sizeLabel == "567M"
    assert _row("gemma-4-31b-qat").sizeBytes == 12345  # the derived value was preserved


def test_seed_heals_known_stale_value_only(configured):
    """QC-43a (2026-07-10): a seeded FACT that later proved wrong can't self-heal
    through fill-empty (the wrong value isn't empty), so `STALE_SEED_VALUES` records
    the exact historically-seeded path and the seeder swaps it for the CURRENT seed
    value — but ONLY on an exact stale match; a user/inspect value or None is left be."""
    from llm_runner.llm import db as _db

    mid = "gemma-4-26b-a4b-uncensored"
    stale = "MTP/gemma-4-26B-A4B-it-Q4_0-MTP.gguf"
    current = "mtp-gemma-4-26B-A4B-it.gguf"

    s = _db.session()
    try:
        # 1) the exact historically-seeded stale path → healed to the current fact
        s.query(_db.ModelCatalog).get(mid).mtp_draft_file = stale
        s.commit()
        seed.seed_default_catalog(s)
        s.commit()
        assert s.query(_db.ModelCatalog).get(mid).mtp_draft_file == current

        # 2) a user/inspect value that is NOT the stale one → left untouched
        s.query(_db.ModelCatalog).get(mid).mtp_draft_file = "my/custom-draft.gguf"
        s.commit()
        seed.seed_default_catalog(s)
        s.commit()
        assert s.query(_db.ModelCatalog).get(mid).mtp_draft_file == "my/custom-draft.gguf"

        # 3) None never matches the stale tuple → no heal, no crash (guarded getattr);
        #    set in-memory only (autoflush=False keeps it un-flushed) since the column
        #    is NOT NULL, then discard it — the point is the heal path survives None.
        row = s.query(_db.ModelCatalog).get(mid)
        row.mtp_draft_file = None
        seed.seed_default_catalog(s)  # must not raise
        assert row.mtp_draft_file != stale
    finally:
        s.close()


def test_borrow_only_row_seeds_inherited_drafter(configured):
    """A Gemma-style row with NO built-in MTP and NO own draft (gryphe-styletune-v2)
    must ship the BORROWED official assistant drafter + mtp enabled — so the opened
    Edit form reads identically to Read-from-link (the recurring seed≠HF complaint,
    2026-07-13). The seed is generated by `refresh-seed-facts.py` via the SAME
    `inspect_model_from_link` method HF-load uses, so it cannot drift."""
    row = _row("gryphe-styletune-v2")
    assert row.mtpBuiltin is False           # header carries no in-file MTP
    assert row.mtp is True                    # …yet MTP is enabled via the borrow
    assert row.mtpDraftRepo == "Radamanthys11/Gemma-4-26B-A4B-it-assistant-GGUF"
    assert row.mtpDraftFile == "gemma-4-26B-A4B-it-assistant-Q8_0.gguf"
    # A model that ships its OWN draft is untouched by the borrow (own, not borrowed).
    assert _row("gemma-4-26b-a4b-uncensored").mtpDraftRepo == ""
    assert _row("gemma-4-26b-a4b-uncensored").mtpDraftFile == "mtp-gemma-4-26B-A4B-it.gguf"


def test_fill_inherited_draft_backfills_existing_draftless_row(configured):
    """The boot backfill (`_fill_inherited_draft`) gives an EXISTING draftless borrow-only
    row the inherited drafter without a reset — empty-only, so a user's own/edited draft
    (or mtp choice on a drafted row) is never clobbered."""
    from llm_runner.llm import db as _db

    s = _db.session()
    try:
        # Simulate a pre-fix existing row: no draft, mtp off (as the old seed shipped it).
        stale = s.query(_db.ModelCatalog).get("gryphe-styletune-v2")
        stale.mtp, stale.mtp_draft_repo, stale.mtp_draft_file, stale.mtp_draft_quant = False, "", "", ""
        # And a row that already carries a user draft — must be LEFT ALONE.
        drafted = s.query(_db.ModelCatalog).get("gemma-4-12b-qat")
        drafted.mtp_draft_file, drafted.mtp = "my/own-draft.gguf", True
        s.commit()

        seed.seed_default_catalog(s)  # re-seed → fill-empty backfill runs
        s.commit()
    finally:
        s.close()

    healed = _row("gryphe-styletune-v2")
    assert healed.mtp is True
    assert healed.mtpDraftFile == "gemma-4-26B-A4B-it-assistant-Q8_0.gguf"
    assert healed.mtpDraftRepo == "Radamanthys11/Gemma-4-26B-A4B-it-assistant-GGUF"
    # the user's own draft survived (empty-only never overwrites an existing draft)
    assert _row("gemma-4-12b-qat").mtpDraftFile == "my/own-draft.gguf"


def test_detect_writes_total_params_for_dense_only(configured):
    mid = "llama-3.3-70b-q4_k_m"   # seeded total_params "70B"
    identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta_full(size_label="27B"))
    assert _row(mid).totalParams == "27B"   # dense size_label overwrote the seed
    # a MoE-style label must NOT clobber the stored value (size_label isn't the total)
    identity.detect_and_store_model_type(
        mid, "x.gguf", read_meta=lambda _p: _meta_full(expert_count=128, size_label="128x9.4B"))
    assert _row(mid).totalParams == "27B"   # unchanged


def test_detect_stores_mtp_ctx_and_samplers(configured):
    mid = "llama-3.3-70b-q4_k_m"  # seeded dense / built_in, no mtp / ctx / samplers
    out = identity.detect_and_store_model_type(
        mid, "x.gguf",
        read_meta=lambda _p: _meta_full(nextn=1, ctx=262144, sampling={"temp": 1.0, "top_k": 20}),
    )
    assert out == "dense"
    row = _row(mid)
    # set_derived writes the HEADER truth into mtp_builtin (never the enable flag mtp)
    assert row.mtpBuiltin is True and row.mtp is False and row.trainedCtx == 262144
    assert row.samplers == {"temperature": "1", "top_k": "20"}  # canonicalized + number-cleaned
    assert row.builtIn is True  # set_derived preserves built_in (unlike upsert)


def test_detect_replaces_samplers_and_uses_fallback(configured):
    mid = "llama-3.3-70b-q4_k_m"
    # 1) header ships samplers -> stored (canonicalized: temp→temperature)
    identity.detect_and_store_model_type(
        mid, "x.gguf", read_meta=lambda _p: _meta_full(sampling={"temp": 0.7}))
    assert _row(mid).samplers == {"temperature": "0.7"}
    # 2) header EMPTY + a fallback -> fallback fills, and it REPLACES the prior set
    identity.detect_and_store_model_type(
        mid, "x.gguf", read_meta=lambda _p: _meta_full(sampling={}),
        samplers_fallback=lambda _m: {"top_p": 0.8})
    assert _row(mid).samplers == {"top_p": "0.8"}
    # 3) header EMPTY + no fallback -> the sampler set is cleared
    identity.detect_and_store_model_type(
        mid, "x.gguf", read_meta=lambda _p: _meta_full(sampling={}))
    assert _row(mid).samplers == {}


def test_embedding_flag_seeded_on_embeds_not_llms(configured):
    # model-surface: the catalog `embedding` flag is seeded True on every embed model and
    # False on chat LLMs, and it threads through the store wire (_catalog_to_wire). The UI
    # reads it for the Set-as-embedding action + the QuickSetup embed picker — replacing the
    # fragile /embed/i name guess (bge-m3's id has no "embed" substring).
    by_id = {r.id: r for r in stores.get_model_catalog_store().list()}
    for embed in ("nomic-embed-text", "qwen3-embedding-0.6b", "bge-m3", "qwen3-embedding-8b"):
        assert by_id[embed].embedding is True, embed
    for llm in ("gemma-4-12b-qat", "gemma-4-31b-qat", "qwen3.6-35b-a3b-mtp", "glm-4.5-air"):
        assert by_id[llm].embedding is False, llm
    assert "embed" not in "bge-m3"  # classified by the flag, not the name regex


def test_inspect_model_from_link(monkeypatch):
    from llm_runner.runner import gguf_remote
    meta = _meta_full(nextn=1, ctx=262144, sampling={"temp": 1.0, "top_k": 20}, size_label="27B")
    monkeypatch.setattr(gguf_remote, "fetch_gguf_meta",
                        lambda repo, quant, revision="main": (meta, 17_000_000_000))
    out = identity.inspect_model_from_link("unsloth/Qwen3.6-27B-MTP-GGUF", "Q4_K_M")
    assert out["type"] == "dense" and out["mtpBuiltin"] is True and out["trainedCtx"] == 262144
    assert out["experts"] == 0 and out["architecture"] == "qwen35"
    assert out["sizeLabel"] == "27B" and out["totalParams"] == "27B"  # dense param count from size_label
    assert out["samplers"] == {"temperature": "1", "top_k": "20"}  # canonicalized + number-cleaned
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
    assert out["type"] == "moe" and out["experts"] == 128 and out["mtpBuiltin"] is True
    # from generation_config.json fallback, canonicalized (temp→temperature)
    assert out["samplers"] == {"temperature": "0.6", "top_p": "0.95"}


# ── the derive-boundary number cleanup + the boot backfill (2026-07-07, the
# read-from-link parity item — the user's screenshots + live strict-diff) ──

def test_canonicalize_cleans_float32_noise():
    # GGUF floats arrive as float32 artifacts — the user's Edit form showed
    # "top_p 0.949999988079071"; the derive boundary renders the number the file
    # MEANS. Ints and non-numerics pass through.
    out = identity.canonicalize_sampler_names(
        {"top_p": "0.949999988079071", "temp": "1.0", "top_k": "64", "note": "abc"})
    assert out == {"top_p": "0.95", "temperature": "1", "top_k": "64", "note": "abc"}


class _R:
    def __init__(self, rid, samplers):
        self.id = rid
        self.samplers = samplers


def test_backfill_rederives_only_cached_samplerless_rows():
    # rows: a (no samplers, cached) → derived; b (has samplers) → skipped;
    # c (no samplers, NOT cached) → skipped; d (derive raises) → skipped, loop survives.
    rows = [_R("a", {}), _R("b", {"top_k": "64"}), _R("c", {}), _R("d", {})]
    cached = {"a": "/x/a.gguf", "d": "/x/d.gguf"}
    derived = []

    def identify_one(mid, path):
        if mid == "d":
            raise RuntimeError("broken file")
        derived.append((mid, path))

    n = identity.backfill_derived_from_cache(rows, lambda mid: cached.get(mid), identify_one)
    assert n == 1
    assert derived == [("a", "/x/a.gguf")]


def test_seeded_samplers_ride_the_catalog_seed(configured):
    # The parity principle: the seed ships the FILE's recommended samplers (the
    # 2026-07-07 live reads) — the Gemma rows carry the file's set out of the box.
    row = _row("gemma-4-12b-qat")
    assert row.samplers == {"top_k": "64", "top_p": "0.95", "temperature": "1"}
    # and the diff-found fact fix: GLM's header carries built-in MTP.
    assert _row("glm-4.5-air").mtp is True
