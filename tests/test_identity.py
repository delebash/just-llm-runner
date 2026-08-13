# SPDX-License-Identifier: MIT
"""GGUF identity auto-detect → model_catalog.type (design S3 / D17). Pure logic +
the catalog write; the GGUF read is injected, so no real GGUF bytes are needed.

Since decision ④ (2026-08-05) the shared DEFAULT_CATALOG ships EMPTY — the JW
content these tests used to ride moved to justwrite_server/seed_presets.py — so
the fixture monkeypatches a compact TEST catalog into the seed module and every
seeding MECHANISM (fill-empty facts, stale-value heals, the inherited-drafter
borrow, the embedding flag, samplers-on-seed) runs its real code path over it.
The rows keep the old exhibits' SHAPES (a use-limited dense, a drafted row, a
borrow-only row, a built-in-MTP MoE, two embeds) so nothing under test thinned.
"""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db, identity, seed, stores
from llm_runner.runner.gguf import GgufMeta

# The compact test catalog — shapes lifted from the moved JW rows.
TEST_CATALOG: list[dict] = [
    # a plain dense chat row (the old llama-3.3-70b exhibit's shape)
    {"id": "dense-a", "name": "Dense A", "hf_repo": "x/dense-a-GGUF", "quant": "Q4_K_M",
     "total_params": "70B", "trained_ctx": 131072, "min_ram_mb": 49152, "min_vram_mb": 49152,
     "tier": "high-ram", "license": "Llama-Community", "position": 0, "quality_rank": 11,
     "architecture": "llama", "experts": 0, "size_label": "70B", "size_bytes": 42520398432},
    # a drafted dense row with seeded samplers + size facts (the 12B QAT shape)
    {"id": "drafted-b", "name": "Drafted B", "hf_repo": "x/drafted-b-GGUF", "quant": "UD-Q4_K_XL",
     "total_params": "12B", "mtp": True, "mtp_draft_file": "MTP/mtp-drafted-b-Q4_0.gguf",
     "mtp_draft_quant": "Q4_0", "trained_ctx": 262144,
     "samplers": {"top_k": "64", "top_p": "0.95", "temperature": "1"},
     "min_ram_mb": 12288, "min_vram_mb": 8192, "tier": "mid", "license": "Apache-2.0",
     "position": 1, "quality_rank": 22, "architecture": "gemma4", "experts": 0,
     "size_label": "12B", "size_bytes": 6716355328},
    # a borrow-only MoE row: no built-in MTP, drafter BORROWED from the base family
    # (the StyleTune shape — mtp enabled via the borrow)
    {"id": "borrow-c", "name": "Borrow C", "hf_repo": "x/borrow-c-GGUF", "quant": "Q4_K_M",
     "total_params": "26B", "active_params": "4B", "type": "moe", "mtp": True,
     "mtp_draft_repo": "base/family-qat-GGUF", "mtp_draft_file": "MTP/mtp-base-Q4_0.gguf",
     "mtp_draft_quant": "Q4_0", "trained_ctx": 262144,
     "min_vram_mb": 4096, "min_ram_mb": 24576, "tier": "low-vram-moe", "license": "Apache-2.0",
     "position": 2, "quality_rank": 12, "architecture": "gemma4", "experts": 128},
    # a built-in-MTP MoE (the GLM shape)
    {"id": "moe-d", "name": "MoE D", "hf_repo": "x/moe-d-GGUF", "quant": "UD-Q4_K_XL",
     "total_params": "106B", "active_params": "12B", "type": "moe", "mtp": True,
     "mtp_builtin": True, "trained_ctx": 131072, "min_vram_mb": 12288, "min_ram_mb": 65536,
     "tier": "high-ram", "license": "MIT", "position": 3, "quality_rank": 10,
     "architecture": "glm4moe", "experts": 128, "size_label": "128x9.4B", "size_bytes": 67721071872},
    # two embed rows (the Qwen3-4B + KaLM shapes)
    {"id": "embed-e", "name": "Embed E", "hf_repo": "x/embed-e-GGUF", "quant": "Q4_K_M",
     "total_params": "4B", "trained_ctx": 40960, "min_vram_mb": 4500, "min_ram_mb": 8000,
     "tier": "cpu", "license": "Apache-2.0", "position": 10, "embedding": True,
     "pooling": "last", "quality_rank": 55, "architecture": "qwen3", "experts": 0,
     "size_label": "4B", "size_bytes": 2496703776},
    {"id": "embed-f", "name": "Embed F", "hf_repo": "x/embed-f-GGUF", "quant": "Q4_K_M",
     "total_params": "12B", "trained_ctx": 131072, "min_vram_mb": 10000, "min_ram_mb": 12000,
     "tier": "high", "license": "Gemma", "position": 12, "embedding": True,
     "pooling": "last", "quality_rank": 52, "architecture": "gemma-embedding", "experts": 0,
     "size_label": "12B", "size_bytes": 7300777920},
]

# The heal mechanism's test data (QC-43a): borrow-c once seeded a fatal drafter trio.
STALE_TEST = {
    ("borrow-c", "mtp_draft_repo"): ("Old/stale-assistant-GGUF",),
    ("borrow-c", "mtp_draft_file"): ("stale-assistant-Q8_0.gguf",),
    ("borrow-c", "mtp_draft_quant"): ("Q8_0",),
}


@pytest.fixture
def configured(monkeypatch):
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    monkeypatch.setattr(seed, "DEFAULT_CATALOG", TEST_CATALOG)
    monkeypatch.setattr(seed, "STALE_SEED_VALUES", STALE_TEST)
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
    mid = "dense-a"  # seeded type=dense, built_in=True
    assert _row(mid).type == "dense"
    assert _row(mid).builtIn is True
    out = identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta(128))
    assert out == "moe"
    after = _row(mid)
    assert after.type == "moe"
    assert after.builtIn is True  # set_type preserves built_in (upsert would not)


def test_detect_dense_is_noop_when_already_dense(configured):
    mid = "dense-a"
    out = identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta(0))
    assert out == "dense"
    assert _row(mid).type == "dense"


def test_physics_facts_reproduce_kv_mb_at_ctx():
    """§13.11's core claim, pinned: the two stored KV scalars + sliding_window
    reproduce `kv_mb_at_ctx` BYTE-IDENTICALLY — [Wb×min(ctx,window) + Gb×ctx] ×
    bits/8 — including per-layer head counts, the swa-dim fallback, and the
    uniform case (Wb=0). If this drifts, stored facts stop being able to compute
    KV and floors go silently low."""
    iswa = GgufMeta(
        architecture="gemma4", block_count=6, embedding_length=2816,
        expert_count=128, head_count=16, head_count_kv=8,
        key_length=256, value_length=256, key_length_swa=128, value_length_swa=128,
        sliding_window=1024,
        sliding_window_pattern=[True, True, False, True, True, False],
        head_count_kv_per_layer=[8, 8, 4, 8, 8, 4],
    )
    facts = identity.physics_facts_from_meta(iswa)
    for ctx in (512, 1024, 4096, 32768):
        for bits in (8, 16):
            exact = iswa.kv_mb_at_ctx(ctx, bits)
            from_facts = (
                facts["kv_windowed_bytes_per_token"] * min(ctx, facts["sliding_window"])
                + facts["kv_global_bytes_per_token"] * ctx
            ) * (bits / 8.0) / 1e6
            assert exact is not None
            assert abs(from_facts - exact) < 1e-9, (ctx, bits, from_facts, exact)
    # Uniform model: no window pattern → Wb 0, every layer global.
    uni = GgufMeta(architecture="llama", block_count=4, embedding_length=1024,
                   expert_count=0, head_count=8, head_count_kv=8,
                   key_length=128, value_length=128)
    ufacts = identity.physics_facts_from_meta(uni)
    assert ufacts["kv_windowed_bytes_per_token"] == 0.0
    assert ufacts["sliding_window"] == 0
    assert ufacts["kv_global_bytes_per_token"] == 4 * 8 * 256
    # Facts mirror the meta's own share (0.0 for dense AND for a MoE header whose
    # expert dims are absent — expert_byte_share's honest no-discount fallback).
    assert ufacts["expert_byte_share"] == 0.0
    assert facts["expert_byte_share"] == iswa.expert_byte_share()


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
    """#12b (2026-07-08): every seeded catalog row ships its pinned quant's
    size_label + size_bytes, and a RE-seed on an existing DB fills the fields only
    when EMPTY — a download-derived value is never clobbered."""
    from llm_runner.llm import db as _db

    # seeded rows carry the facts (a dense, a MoE, and an embed)
    assert _row("drafted-b").sizeLabel == "12B"
    assert _row("drafted-b").sizeBytes == 6716355328
    assert _row("moe-d").sizeLabel == "128x9.4B"
    assert _row("embed-e").sizeBytes == 2496703776

    s = _db.session()
    try:
        # simulate a pre-#12b row (empty facts) + a download-derived row (real file)
        blank = s.query(_db.ModelCatalog).get("embed-f")
        blank.size_label, blank.size_bytes = "", None
        derived = s.query(_db.ModelCatalog).get("drafted-b")
        derived.size_bytes = 12345  # "the local file said so" — must survive reseed
        s.commit()

        assert seed.seed_default_catalog(s) == 0  # nothing inserted…
        s.commit()
    finally:
        s.close()
    assert _row("embed-f").sizeBytes == 7300777920  # …the empty row was filled
    assert _row("embed-f").sizeLabel == "12B"
    assert _row("drafted-b").sizeBytes == 12345  # the derived value was preserved


def test_seed_heals_known_stale_value_only(configured):
    """QC-43a (2026-07-10): a seeded FACT that later proved wrong can't self-heal
    through fill-empty (the wrong value isn't empty), so `STALE_SEED_VALUES` records
    the exact historically-seeded value and the seeder swaps it for the CURRENT seed
    value — but ONLY on an exact stale match; a user/inspect value or None is left be.

    (The mechanism's real 2026-07-25 exhibit — StyleTune's fatal drafter trio — moved
    to JW's seed with the row; the trio's SHAPE is preserved in STALE_TEST above.)"""
    from llm_runner.llm import db as _db

    mid = "borrow-c"
    stale = "stale-assistant-Q8_0.gguf"
    stale_repo = "Old/stale-assistant-GGUF"
    current = "MTP/mtp-base-Q4_0.gguf"

    s = _db.session()
    try:
        # 1) the exact historically-seeded stale trio → healed to the current facts
        row = s.query(_db.ModelCatalog).get(mid)
        row.mtp_draft_repo, row.mtp_draft_file, row.mtp_draft_quant = stale_repo, stale, "Q8_0"
        s.commit()
        seed.seed_default_catalog(s)
        s.commit()
        row = s.query(_db.ModelCatalog).get(mid)
        assert row.mtp_draft_file == current
        assert row.mtp_draft_repo == "base/family-qat-GGUF"
        assert row.mtp_draft_quant == "Q4_0"

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
    """A row with NO built-in MTP and NO own draft in-file must ship the BORROWED
    base-family drafter + mtp enabled — so the opened Edit form reads identically
    to Read-from-link (the recurring seed≠HF complaint, 2026-07-13)."""
    row = _row("borrow-c")
    assert row.mtpBuiltin is False           # header carries no in-file MTP
    assert row.mtp is True                    # …yet MTP is enabled via the borrow
    # The exact repo is pinned so a silent re-point is caught.
    assert row.mtpDraftRepo == "base/family-qat-GGUF"
    assert row.mtpDraftFile == "MTP/mtp-base-Q4_0.gguf"
    # A model that ships its OWN draft is untouched by the borrow (own, not borrowed).
    assert _row("drafted-b").mtpDraftRepo == ""
    assert _row("drafted-b").mtpDraftFile == "MTP/mtp-drafted-b-Q4_0.gguf"


def test_fill_inherited_draft_backfills_existing_draftless_row(configured):
    """The boot backfill (`_fill_inherited_draft`) gives an EXISTING draftless borrow-only
    row the inherited drafter without a reset — empty-only, so a user's own/edited draft
    (or mtp choice on a drafted row) is never clobbered."""
    from llm_runner.llm import db as _db

    s = _db.session()
    try:
        # Simulate a pre-fix existing row: no draft, mtp off (as the old seed shipped it).
        stale = s.query(_db.ModelCatalog).get("borrow-c")
        stale.mtp, stale.mtp_draft_repo, stale.mtp_draft_file, stale.mtp_draft_quant = False, "", "", ""
        # And a row that already carries a user draft — must be LEFT ALONE.
        drafted = s.query(_db.ModelCatalog).get("drafted-b")
        drafted.mtp_draft_file, drafted.mtp = "my/own-draft.gguf", True
        s.commit()

        seed.seed_default_catalog(s)  # re-seed → fill-empty backfill runs
        s.commit()
    finally:
        s.close()

    healed = _row("borrow-c")
    assert healed.mtp is True
    assert healed.mtpDraftFile == "MTP/mtp-base-Q4_0.gguf"
    assert healed.mtpDraftRepo == "base/family-qat-GGUF"
    # the user's own draft survived (empty-only never overwrites an existing draft)
    assert _row("drafted-b").mtpDraftFile == "my/own-draft.gguf"


def test_detect_writes_total_params_for_dense_only(configured):
    mid = "dense-a"   # seeded total_params "70B"
    identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta_full(size_label="27B"))
    assert _row(mid).totalParams == "27B"   # dense size_label overwrote the seed
    # a MoE-style label must NOT clobber the stored value (size_label isn't the total)
    identity.detect_and_store_model_type(
        mid, "x.gguf", read_meta=lambda _p: _meta_full(expert_count=128, size_label="128x9.4B"))
    assert _row(mid).totalParams == "27B"   # unchanged


def test_detect_stores_mtp_ctx_and_samplers(configured):
    mid = "dense-a"  # seeded dense / built_in, no mtp / samplers
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
    mid = "dense-a"
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
    # fragile /embed/i name guess (the historical exhibit was bge-m3, whose id carried
    # no "embed" substring; embed-e/f here carry the flag, not a name pattern).
    by_id = {r.id: r for r in stores.get_model_catalog_store().list()}
    for embed in ("embed-e", "embed-f"):
        assert by_id[embed].embedding is True, embed
    for llm in ("dense-a", "drafted-b", "moe-d"):
        assert by_id[llm].embedding is False, llm


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
    # The Min-RAM floor's pre-download guess rides the SAME payload (2026-07-27) —
    # 17 GB file + 4 GB headroom snaps to the 24 GB rung.
    assert out["estRamMb"] == 24 * 1024


def test_est_ram_mb_from_bytes_snaps_to_real_ram_rungs():
    """The size-only RAM rule (dense = weights + overhead, MoE = the whole file in
    RAM) — file MB + 4096, snapped UP to a rung a real PC ships."""
    assert identity.est_ram_mb_from_bytes(None) is None
    assert identity.est_ram_mb_from_bytes(0) is None
    assert identity.est_ram_mb_from_bytes(1_500_000_000) == 8 * 1024  # small file → floor rung
    # Exact-rung boundary: 4.096 GB + 4096 MB headroom == 8192 MB, must NOT climb.
    assert identity.est_ram_mb_from_bytes(4_096_000_000) == 8 * 1024
    assert identity.est_ram_mb_from_bytes(4_096_000_001) == 10 * 1024  # one byte over → next rung
    # The calibration exhibits (2026-07-27): the 12B and the 26B-A4B flagship files.
    assert identity.est_ram_mb_from_bytes(6_716_355_328) == 12 * 1024
    assert identity.est_ram_mb_from_bytes(17_211_252_288) == 24 * 1024
    # Past the top rung (128 GB) the ladder ends → round up to the next 32 GB.
    assert identity.est_ram_mb_from_bytes(200_000_000_000) == 224 * 1024


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
    # The parity principle: the seed ships the FILE's recommended samplers — a
    # seeded row carries its set out of the box (the 2026-07-07 live reads).
    row = _row("drafted-b")
    assert row.samplers == {"top_k": "64", "top_p": "0.95", "temperature": "1"}
    # and a built-in-MTP header fact rides the seed too.
    assert _row("moe-d").mtp is True
