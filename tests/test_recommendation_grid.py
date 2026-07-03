# SPDX-License-Identifier: GPL-3.0-or-later
"""The per-hardware recommendation grid (Phase 4) — the unified 'Models' surface's
data. Pure: `build_recommendation_grid` over CatalogRow-/RecommendationRow-/TaskKindRow-
like stubs, so it tests the exact fit filtering + quality/faster + column logic with no
DB and no GPU. Uses the REAL seed data (catalog/recs/tiers/function map) so the assertions
guard the ACTUAL grid the app ships — incl. the chat-default convergence (floor chat quality
== the JW p_chat default) the rules panel required."""

from types import SimpleNamespace

from llm_runner.llm import seed
from llm_runner.llm.recommendation_grid import build_recommendation_grid


# ── adapters: the seed dicts (snake_case) → the camelCase wire objects the stores return ──
def _cat(d: dict) -> SimpleNamespace:
    return SimpleNamespace(
        id=d["id"], name=d.get("name", ""), totalParams=d.get("total_params", ""),
        quant=d.get("quant", ""), minVramMb=d.get("min_vram_mb"), minRamMb=d.get("min_ram_mb"),
    )


def _rec(d: dict) -> SimpleNamespace:
    return SimpleNamespace(modelId=d["model_id"], taskKind=d["task_kind"],
                           rank=int(d.get("rank", 100)), why=d.get("why", ""))


def _tk(d: dict) -> SimpleNamespace:
    return SimpleNamespace(id=d["id"])


def _grid(catalog=None, recs=None, tasks=None, margin_mb=1024) -> dict:
    return build_recommendation_grid(
        catalog_rows=[_cat(d) for d in (catalog if catalog is not None else seed.DEFAULT_CATALOG)],
        recommendations=[_rec(d) for d in (recs if recs is not None else seed.DEFAULT_RECOMMENDATIONS)],
        task_kinds=[_tk(d) for d in (tasks if tasks is not None else seed.DEFAULT_TASK_KINDS)],
        tiers=seed.DEFAULT_HARDWARE_TIERS,
        function_of=seed.function_of,
        function_order=seed.FUNCTION_ORDER,
        function_labels=seed.FUNCTION_LABELS,
        margin_mb=margin_mb,
    )


def _cell(grid: dict, tier: str, function: str) -> dict:
    for c in grid["cells"]:
        if c["tier"] == tier and c["function"] == function:
            return c
    raise AssertionError(f"no cell {tier}/{function}")


# ── columns / shape ──────────────────────────────────────────────────────────
def test_columns_are_the_apps_functions_plus_embed_no_other():
    # The 9 built-in tasks map to chat/prose/extract/analysis; +embed always; no `other`
    # because every built-in task maps somewhere.
    g = _grid()
    assert g["functions"] == ["chat", "prose", "extract", "analysis", "embed"]
    assert g["functionLabels"]["embed"] == "Embed"
    # one cell per tier × function
    assert len(g["cells"]) == len(seed.DEFAULT_HARDWARE_TIERS) * len(g["functions"])
    assert [t["key"] for t in g["tiers"]] == [t["key"] for t in seed.DEFAULT_HARDWARE_TIERS]


def test_unmapped_taskkind_lands_in_the_other_bucket_never_dropped():
    # A custom task + a rec for it → an `other` column appears (nothing vanishes).
    tasks = seed.DEFAULT_TASK_KINDS + [{"id": "custom.thing"}]
    recs = seed.DEFAULT_RECOMMENDATIONS + [
        {"model_id": "qwen3.5-9b-q4_k_m", "task_kind": "custom.thing", "rank": 5, "why": "x"},
    ]
    g = _grid(recs=recs, tasks=tasks)
    assert "other" in g["functions"]
    assert g["functions"].index("other") < g["functions"].index("embed")  # canonical order
    assert _cell(g, "vram24", "other")["quality"]["modelId"] == "qwen3.5-9b-q4_k_m"


# ── the chat-default convergence (rules-panel requirement) ───────────────────
def test_floor_chat_quality_is_the_35b_a3b_default_faster_is_the_9b():
    # 27B doesn't fit at the 8 GB floor; the 35B-A3B MoE does (via offload) and is the
    # floor chat QUALITY pick == the JW p_chat default (seen == run). 9B is the faster pick.
    g = _grid()
    floor = _cell(g, "vram8", "chat")
    assert floor["quality"]["modelId"] == "qwen3.6-35b-a3b-mtp"
    assert floor["faster"]["modelId"] == "qwen3.5-9b-q4_k_m"


def test_chat_ceiling_27b_wins_once_it_fits():
    g = _grid()
    assert _cell(g, "vram24", "chat")["quality"]["modelId"] == "qwen3.6-27b-mtp-q4_k_m"
    assert _cell(g, "vram16", "chat")["quality"]["modelId"] == "qwen3.6-27b-mtp-q4_k_m"


# ── fit gating (the RAM-gate for MoEs) ───────────────────────────────────────
def test_high_ram_moes_unlock_only_at_their_ram_tier():
    g = _grid()
    # GLM-4.5-Air (min_ram 64000) is the top extract pick, but only from the 64 GB-RAM tier.
    assert _cell(g, "vram24", "extract")["quality"]["modelId"] != "glm-4.5-air"   # 32 GB RAM → gated
    assert _cell(g, "ram64", "extract")["quality"]["modelId"] == "glm-4.5-air"    # 64 GB RAM → unlocked
    # Qwen3-235B (min_ram 96000) is the top prose pick only from 96 GB-RAM.
    assert _cell(g, "ram64", "prose")["quality"]["modelId"] != "qwen3-235b-a22b"
    assert _cell(g, "ram96", "prose")["quality"]["modelId"] == "qwen3-235b-a22b"


def test_embed_column_recommends_nomic_at_every_tier():
    g = _grid()
    for tier in ("cpu", "vram8", "ram128"):
        assert _cell(g, tier, "embed")["quality"]["modelId"] == "nomic-embed-text"
        assert _cell(g, tier, "embed")["faster"] is None  # only one embed rec


# ── robustness ───────────────────────────────────────────────────────────────
def test_rec_for_a_model_not_in_the_catalog_is_skipped_never_fabricated():
    recs = [{"model_id": "ghost-model", "task_kind": "chat.grounded", "rank": 1, "why": "x"}]
    g = _grid(recs=recs)
    assert _cell(g, "vram24", "chat")["quality"] is None  # no catalog row → no pick


def test_faster_is_lighter_than_quality_or_absent():
    g = _grid()
    from llm_runner.runner import fit
    by_id = {d["id"]: d for d in seed.DEFAULT_CATALOG}

    def w(mid: str):
        d = by_id[mid]
        return fit.weights_mb(d.get("total_params"), d.get("quant", "")) or float("inf")

    for c in g["cells"]:
        if c["quality"] and c["faster"]:
            assert w(c["faster"]["modelId"]) < w(c["quality"]["modelId"])


def test_cpu_tier_fits_via_cpu_band():
    # On a CPU-only box the 35B-A3B (min_ram 32000 == the tier RAM) still fits ("cpu" band).
    g = _grid()
    q = _cell(g, "cpu", "chat")["quality"]
    assert q is not None and q["fit"] == "cpu"
