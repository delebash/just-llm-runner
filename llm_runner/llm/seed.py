# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared LLM seed data + seeders + the per-app registration hook.

SHARED seed data (identical for every app, shipped here): default providers, the
downloadable model catalog, the type switch presets, recommendations, and the live
routing row. PER-APP seed data (the only thing that differs between apps) is
registered by the host via `configure_app_seed`: its feature catalog and its
feature prompts. `seed_llm` runs every seeder; stores'
`reset_to_factory` re-run individual seeders. All seeders merge-by-key and never
clobber user edits (the `seed_default_providers` pattern).
"""

from __future__ import annotations

from . import db
from ..runner.config import (
    DEFAULT_BINARIES,
    DEFAULT_DOWNLOAD_SEGMENT_COUNT,
    DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES,
    DEFAULT_DOWNLOAD_SEGMENT_RETRIES,
    DEFAULT_DOWNLOAD_SEGMENTS_ENABLED,
    DEFAULT_MODELS_MAX,
    DEFAULT_PINNED_BUILD,
    DEFAULT_SAFETY_MARGIN_MB,
    DEFAULT_SLEEP_IDLE_SECONDS,
)

# ── per-app registration (the ONLY per-app inputs) ────────────────────────────
_APP: dict = {"feature_catalog": [], "feature_prompts": {},
              "engine_presets": [], "taskkind_presets": [], "feature_task_kinds": {}}


def configure_app_seed(*, feature_catalog=None, feature_prompts=None,
                       engine_presets=None, taskkind_presets=None,
                       feature_task_kinds=None, model_catalog_extra=None,
                       model_tunes_seed=None, hw_key_fn=None,
                       test_samples=None, feature_prompt_heals=None) -> None:
    """The host registers its feature DATA once at boot (install_llm does this):
    `feature_catalog` (list of FeatureCatalogEntry), `feature_prompts` (dict
    key→spec), and the ROUTING seed — `engine_presets` (the built-in preset library),
    `taskkind_presets` (taskKind→preset assignments), and `feature_task_kinds` (the
    action→taskKind map). The routing seed is optional; an app that registers none
    simply seeds no presets and falls back to legacy routing."""
    if feature_catalog is not None:
        _APP["feature_catalog"] = list(feature_catalog)
    if feature_prompts is not None:
        _APP["feature_prompts"] = dict(feature_prompts)
    if engine_presets is not None:
        _APP["engine_presets"] = list(engine_presets)
    if taskkind_presets is not None:
        _APP["taskkind_presets"] = list(taskkind_presets)
    if feature_task_kinds is not None:
        _APP["feature_task_kinds"] = dict(feature_task_kinds)
    # Per-app extra catalog rows + the box tune seed are REGISTERED (not one-shot
    # seeded) so `seed_llm` carries them on BOTH paths — boot AND the data-reset
    # endpoint. (Found 2026-07-06: the old install-time-only seeding meant a
    # POST /v1/data/reset silently LOST the app's extra rows + tunes while the
    # presets kept pointing at the vanished ids — the "reset-proof seed data"
    # promise only held for fresh-DB boots.)
    if model_catalog_extra is not None:
        _APP["model_catalog_extra"] = list(model_catalog_extra)
    if model_tunes_seed is not None:
        _APP["model_tunes_seed"] = list(model_tunes_seed)
    if hw_key_fn is not None:
        _APP["hw_key_fn"] = hw_key_fn
    # §7.3 Lab test samples (2026-07-08): synthesized per-taskKind rows for the
    # Lab's Sample button — registered so seed_llm carries them on both paths.
    if test_samples is not None:
        _APP["test_samples"] = list(test_samples)
    # Prompt stale-heals (RAG build 2026-07-11, the QC-43a pattern applied to
    # feature prompts): prompt seeding is insert-if-missing, so a seed-text
    # REVISION can never reach an existing DB by itself. The host registers
    # `{key: [old exact system texts]}` — HOST data, like the prompts
    # themselves (the old JW strings never enter this shared module); the
    # generic heal loop in seed_default_feature_prompts refreshes a row from
    # the current spec ONLY when its system text byte-equals a listed old
    # value, so a user-edited prompt is never touched.
    if feature_prompt_heals is not None:
        _APP["feature_prompt_heals"] = {k: list(v) for k, v in dict(feature_prompt_heals).items()}


def app_feature_catalog() -> list:
    """The host's feature catalog (FeatureCatalogEntry list) — get_catalog for the routing router."""
    return _APP["feature_catalog"]


def app_feature_prompts() -> dict:
    return _APP["feature_prompts"]


def app_engine_presets() -> list:
    """The host's built-in engine presets (list of dicts) — the factory preset library."""
    return _APP["engine_presets"]


def app_taskkind_presets() -> list:
    """The host's taskKind→preset assignments (list of {task_kind, preset_id} dicts)."""
    return _APP["taskkind_presets"]


def app_feature_task_kinds() -> dict:
    """The host's action→taskKind map — the routing key `_task_kind_of` reads."""
    return _APP["feature_task_kinds"]


# ── SHARED seed data ──────────────────────────────────────────────────────────
# NO seeded default_model on any provider (user, 2026-07-06: "no default chat model
# like gpt-4o-mini, we pull model from provider once connected" — providers-surface
# redesign item 5). The rows are connect-ready endpoints only; the user fetches the
# provider's LIVE model list (probe-models / {id}/models) and picks after connecting.
# Dispatch's `adapter.default_model` fallback stays — it now simply stays empty until
# the user's pick writes it.
DEFAULT_PROVIDERS: list[dict] = [
    {"id": "local-llamacpp", "name": "Built-in provider — llama.cpp",
     "provider_type": "local-llamacpp", "base_url": "http://127.0.0.1:8080/v1", "local": True},
    {"id": "openai-compat-local", "name": "OpenAI-compatible (local)",
     "provider_type": "openai-compat", "base_url": "http://localhost:11434/v1", "local": True},
    {"id": "openai", "name": "OpenAI",
     "provider_type": "openai", "base_url": "https://api.openai.com/v1", "local": False},
    {"id": "claude", "name": "Claude (Anthropic)",
     "provider_type": "openai-compat", "base_url": "https://api.anthropic.com/v1", "local": False},
    {"id": "gemini", "name": "Gemini (Google)",
     "provider_type": "openai-compat",
     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "local": False},
    {"id": "deepseek", "name": "DeepSeek",
     "provider_type": "deepseek", "base_url": "https://api.deepseek.com/v1", "local": False},
    {"id": "openrouter", "name": "OpenRouter (aggregator)",
     "provider_type": "openrouter", "base_url": "https://openrouter.ai/api/v1", "local": False},
]

# The downloadable catalog — a SMALL curated hardware ladder (reconciled 2026-07-05 for the
# model-surface build; see the inline section comments below). Every repo + quant + license
# web-verified via the HF API. `min_ram_mb` = the RAM floor (dense: weights-in-RAM +
# overhead, e.g. 8B→~10 GB / 14B→14 GB; MoE: the FULL model in RAM since experts offload to
# RAM). `min_vram_mb` = the load-time VRAM band (MoE = active-path + KV, much smaller than
# total). The tuning UI (#20) measures real. `use_limited` is auto-derived from `license`
# (a use-limited model — e.g. the Llama Community license — is carried as a FLAG, never an
# auto-default). `embedding` marks an embed model; `pooling` is intrinsic per embed model.
DEFAULT_CATALOG: list[dict] = [
    # ── Curated hardware ladder — GEMMA-FIRST for writing (user decision 2026-07-06 night:
    # "make the gemma lineup instead of qwen" + "add gryphe and ye" + "add auhauCS/Gemma4-26B",
    # research + decision trail in docs/plans/2026-07-06-providers-surface-redesign.md).
    # Basis: the user's MEASURED on-box result (Gemma 4 better prose in the actual app at the
    # same speed class) outranks a 0.4-point published tie; Qwen3.6-35B-A3B stays as the one
    # alternative MoE. A SMALL verified set — the Smart Add flow lets a user add ANY HF GGUF
    # repo, so this is a starting ladder, not a lock. Every repo + quant + license re-verified
    # via the HF API 2026-07-06 (the seed-facts audit runs on every seed change).
    # Dense (VRAM, fully on GPU) → MoE (system RAM, expert offload) → embeddings. use_limited is
    # auto-derived from `license`; pooling is intrinsic per embed; quality_rank LOWER = better
    # (curated-for-writing order, owner-tested basis — community tunes deliberately rank BELOW
    # the trusted auto-pick set until a Lab A/B earns them a real rank).
    # `size_label`/`size_bytes` (#12b, harvested 2026-07-08): read from each pinned quant's live
    # GGUF header via identity.inspect_model_from_link — the SAME path Read-from-link uses, so
    # seed == detection (size_bytes = summed-shard download size; size_label = the file's
    # general.size_label). QUANT-SPECIFIC: changing a row's quant clears them for re-inspect.
    # ── Dense (runs fully on the GPU — fast) ──────────────────────────────────────────────
    {"id": "gemma-4-12b-qat", "name": "Gemma 4 12B (QAT)",
     "hf_repo": "unsloth/gemma-4-12B-it-qat-GGUF", "quant": "UD-Q4_K_XL", "total_params": "12B",
     "mtp": True, "mtp_draft_file": "MTP/mtp-gemma-4-12B-it-Q4_0.gguf", "mtp_draft_quant": "Q4_0",
     "trained_ctx": 262144, "samplers": {"top_k": "64", "top_p": "0.95", "temperature": "1"},
     "min_ram_mb": 12000, "min_vram_mb": 8500, "tier": "mid", "license": "Apache-2.0", "position": 0,
     "quality_rank": 22, "architecture": "gemma4", "experts": 0,
     "size_label": "12B", "size_bytes": 6716355328,
     "description": "12B model · 256k context · MTP draft for faster generation · UD-Q4_K_XL (QAT)",
     "notes": "The small-card rung of the writing-first ladder; runs fully on a 10-12 GB GPU (tight on 8)."},
    {"id": "gemma-4-31b-qat", "name": "Gemma 4 31B (QAT)",
     "hf_repo": "unsloth/gemma-4-31B-it-qat-GGUF", "quant": "UD-Q4_K_XL", "total_params": "31B",
     "mtp": True, "mtp_draft_file": "MTP/mtp-gemma-4-31B-it-Q4_0.gguf", "mtp_draft_quant": "Q4_0",
     "trained_ctx": 262144, "samplers": {"top_k": "64", "top_p": "0.95", "temperature": "1"},
     "min_ram_mb": 24000, "min_vram_mb": 20000, "tier": "high", "license": "Apache-2.0", "position": 1,
     "quality_rank": 7, "architecture": "gemma4", "experts": 0,
     "size_label": "31B", "size_bytes": 17287668064,
     "description": "31B model · 256k context · MTP draft for faster generation · UD-Q4_K_XL (QAT)",
     "notes": "The 24 GB-card rung; the family's strongest, with vision. Writing rank pending a Lab A/B against the 26B-A4B."},
    {"id": "llama-3.3-70b-q4_k_m", "name": "Llama 3.3 70B Instruct · Q4_K_M",
     "hf_repo": "unsloth/Llama-3.3-70B-Instruct-GGUF", "quant": "Q4_K_M", "total_params": "70B",
     "trained_ctx": 131072,
     "min_ram_mb": 48000, "min_vram_mb": 46000, "tier": "high-ram", "license": "Llama-Community", "position": 2,
     "quality_rank": 11, "architecture": "llama", "experts": 0,
     "size_label": "70B", "size_bytes": 42520398432,
     "description": "70B model · 128k context · Q4_K_M",
     "notes": "~42 GB split GGUF — the best all-round local creative-writing model for a ~48 GB rig; use-limited Llama license (never an auto-default)."},
    # ── MoE (experts offload to system RAM — higher quality, slower, needs RAM) ────────────
    {"id": "qwen3.6-35b-a3b-mtp", "name": "Qwen3.6 35B-A3B (MTP)",
     "hf_repo": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF", "quant": "UD-Q4_K_XL",
     "total_params": "35B", "active_params": "3.6B", "mtp": True, "mtp_builtin": True, "type": "moe",
     "trained_ctx": 262144, "samplers": {"top_k": "20", "top_p": "0.95", "temperature": "1"},
     "min_vram_mb": 6000, "min_ram_mb": 32000, "tier": "low-vram-moe", "license": "Apache-2.0", "position": 3,
     "quality_rank": 8, "architecture": "qwen35moe", "experts": 256,
     "size_label": "35B-A3B", "size_bytes": 22853663008,
     "description": "35B mixture-of-experts model · 256k context · MTP for faster generation · UD-Q4_K_XL",
     "notes": "~32B-class quality on a small GPU + system RAM via CPU expert offload; the smart all-round alternative."},
    # quality_rank swap (2026-07-06 benchmark re-grounding, C2): Qwen3.6-35B-A3B
    # publishes higher scores than GLM-4.5-Air on every shared instrument
    # (MMLU-Pro 85.2 vs 81.4, IFEval 88.2 vs 86.3 — each vendor's own card) and
    # the INDEPENDENT Artificial Analysis harness agrees (GPQA-Diamond 84.1 vs
    # 73.3), so the ladder now puts Qwen3.6 (8) above GLM-4.5-Air (10).
    # Evidence table + URLs: docs/plans/2026-07-06-a-to-e-execution.md §C2.
    {"id": "glm-4.5-air", "name": "GLM-4.5-Air (106B-A12B MoE)",
     "hf_repo": "unsloth/GLM-4.5-Air-GGUF", "quant": "UD-Q4_K_XL",
     "total_params": "106B", "active_params": "12B", "type": "moe",
     # mtp True: the GGUF header carries nextn_predict_layers (live header read 2026-07-07
     # — the seed said False; the strict-diff caught it). Built-in MTP, no external draft.
     "mtp": True, "mtp_builtin": True, "trained_ctx": 131072,
     "min_vram_mb": 12000, "min_ram_mb": 64000, "tier": "high-ram", "license": "MIT", "position": 4,
     "quality_rank": 10, "architecture": "glm4moe", "experts": 128,
     "size_label": "128x9.4B", "size_bytes": 67721071872,
     "description": "106B mixture-of-experts model · 128k context · MTP for faster generation · UD-Q4_K_XL",
     "notes": "Heavyweight structured extraction + reasoning on a high-RAM rig (64 GB+ RAM); published evals now trail Qwen3.6-35B-A3B."},
    # ── Community writing tunes (user-added 2026-07-06; NEVER auto-picked — ranked below the
    # trusted set until a Lab A/B; each row license-verified through its base_model chain) ──
    {"id": "gryphe-styletune-v2", "name": "Gemma 4 26B-A4B StyleTune V2 (Gryphe)",
     "hf_repo": "mradermacher/Gemma-4-26B-A4B-StyleTune-V2-GGUF", "quant": "Q4_K_M",
     "total_params": "26B", "active_params": "4B", "type": "moe",
     "trained_ctx": 262144, "samplers": {"top_k": "64", "top_p": "0.95", "temperature": "1"},
     "min_vram_mb": 4000, "min_ram_mb": 24000, "tier": "low-vram-moe", "license": "Apache-2.0", "position": 5,
     "quality_rank": 12, "architecture": "gemma4", "experts": 128,
     "size_label": "26B-A4B", "size_bytes": 17211252288,
     "description": "26B mixture-of-experts model · 256k context · Q4_K_M",
     "notes": "Gryphe's prose style-tune of Gemma 4 26B-A4B — same hardware class as the default. Community tune (reputable maker), quantized by mradermacher; no MTP draft in the quant repo. Pick it deliberately; a Lab A/B decides its real rank."},
    # The user's use-policy word, verbatim (2026-07-06): "i want uncensored as option for
    # fiction i dont want writers blocked when they have gory or fantasy sex scenes" — an
    # OPTION, chosen deliberately; never a default. The repo declares license:gemma while its
    # Google base is apache-2.0 — the repackager's own terms are honored (use-limited flag),
    # and `license_reviewed` records the ruled-on discrepancy for the seed-facts audit.
    {"id": "gemma-4-26b-a4b-uncensored", "name": "Gemma 4 26B-A4B Uncensored (HauhauCS)",
     "hf_repo": "HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP", "quant": "Q4_K_M",
     "total_params": "26B", "active_params": "4B", "type": "moe",
     "mtp": True, "mtp_draft_file": "mtp-gemma-4-26B-A4B-it.gguf",
     "trained_ctx": 262144,
     "min_vram_mb": 4000, "min_ram_mb": 24000, "tier": "low-vram-moe", "license": "Gemma", "position": 6,
     "license_reviewed": "repo declares license:gemma over an apache-2.0 Google base — checked 2026-07-06; the repackager's own terms are honored (use-limited)",
     "quality_rank": 13, "architecture": "gemma4", "experts": 128,
     "size_label": "26B-A4B", "size_bytes": 16796015520,
     "description": "26B mixture-of-experts model · 256k context · MTP draft for faster generation · Q4_K_M",
     "notes": "Refusal-ablated Gemma 4 26B-A4B QAT — the option for fiction whose dark, gory, or adult scenes hit stock refusals. Never auto-picked; you choose it. Carries the repo's own Gemma-terms tag (its Google base is Apache-2.0)."},
    # ── Embeddings (build the RAG / semantic-search index — CPU-fine) ──────────────────────
    # (The tiny CPU pipeline-test model is deliberately NOT in this seed — user, 2026-07-06:
    # "real seed should not have it". Dev containers/CI add it via the user-facing catalog
    # CRUD with scripts/dev-seed-test-model.py.)
    {"id": "nomic-embed-text", "name": "Nomic Embed Text v1.5",
     "hf_repo": "nomic-ai/nomic-embed-text-v1.5-GGUF", "quant": "Q4_K_M", "total_params": "137M",
     "trained_ctx": 2048,
     "min_vram_mb": 1000, "min_ram_mb": 4000, "tier": "cpu", "license": "Apache-2.0", "position": 7,
     "embedding": True, "pooling": "mean",
     "quality_rank": 70, "architecture": "nomic-bert", "experts": 0,
     # no size_label: this file's header carries no general.size_label (inspected 2026-07-08)
     "size_bytes": 84106624,
     "description": "137M embedding model · 2k context · Q4_K_M",
     "notes": "The English CPU embedding floor; mean pooling."},
    {"id": "qwen3-embedding-0.6b", "name": "Qwen3 Embedding 0.6B",
     "hf_repo": "Qwen/Qwen3-Embedding-0.6B-GGUF", "quant": "Q8_0", "total_params": "0.6B",
     "trained_ctx": 32768,
     "min_vram_mb": 1500, "min_ram_mb": 4000, "tier": "cpu", "license": "Apache-2.0", "position": 8,
     "embedding": True, "pooling": "last",
     # rank 58 (was 65 — #274): the CPU band's best. MTEB retrieval puts the 0.6B above
     # bge-m3 and this row's own note calls it "The default local embed", but at 65 it
     # LOST to bge (60) — under the #274 leftover rule that inversion would have quietly
     # made bge the small-card default. Reaches existing DBs only via reset
     # (insert-if-missing seeder).
     "quality_rank": 58, "architecture": "qwen3", "experts": 0,
     "size_label": "0.6B", "size_bytes": 639150592,
     "description": "0.6B embedding model · 32k context · Q8_0",
     "notes": "The default local embed (stronger multilingual / MTEB than nomic, still tiny ~0.6 GB); last-token pooling."},
    {"id": "bge-m3", "name": "BGE-M3 (multilingual)",
     "hf_repo": "gpustack/bge-m3-GGUF", "quant": "Q4_K_M", "total_params": "567M",
     "trained_ctx": 8192,
     "min_vram_mb": 1500, "min_ram_mb": 4000, "tier": "cpu", "license": "MIT", "position": 9,
     "embedding": True, "pooling": "cls",
     "quality_rank": 60, "architecture": "bert", "experts": 0,
     "size_label": "567M", "size_bytes": 437778496,
     "description": "567M embedding model · 8k context · Q4_K_M",
     "notes": "Multilingual embeddings across 100+ languages; CLS pooling; CPU-fine."},
    # The DEFAULT local embed for a capable box (2026-07-12, reversing #274's "should be
    # 0.6B"): near-8B retrieval quality at ~2.5 GB, on-box A/B beats the 0.6B on thematic
    # retrieval. tier "cpu" — an embed runs on CPU by policy (the GPU stays for the chat
    # model), so it is judged on RAM (8 GB floor), NOT the VRAM leftover; that makes it
    # ALWAYS-eligible in the embed pick and, being higher quality than the 0.6B (rank 55 <
    # 58), it wins Quick Setup on any box that clears its RAM floor. A box below 8 GB RAM
    # gets coarse_fit "no" and falls back to the 0.6B automatically (the ladder self-sorts:
    # <8 GB RAM → 0.6B; ≥8 GB RAM → 4B on CPU; a big GPU whose leftover covers the 8B → 8B).
    # min_vram 4500 stays the honest GPU-fit figure (the FIT badge only — eligibility comes
    # from the tier, placement forces CPU via lifecycle._apply_embed_placement).
    {"id": "qwen3-embedding-4b", "name": "Qwen3 Embedding 4B",
     "hf_repo": "Qwen/Qwen3-Embedding-4B-GGUF", "quant": "Q4_K_M", "total_params": "4B",
     "trained_ctx": 40960,
     "min_vram_mb": 4500, "min_ram_mb": 8000, "tier": "cpu", "license": "Apache-2.0", "position": 10,
     "embedding": True, "pooling": "last",
     "quality_rank": 55, "architecture": "qwen3", "experts": 0,
     "size_label": "4B", "size_bytes": 2496703776,
     "description": "4B embedding model · 40k context · Q4_K_M",
     "notes": "The default local embed on a capable box (≥8 GB RAM) — near-8B retrieval quality at ~2.5 GB, runs on CPU; last-token pooling."},
    {"id": "qwen3-embedding-8b", "name": "Qwen3 Embedding 8B",
     "hf_repo": "Qwen/Qwen3-Embedding-8B-GGUF", "quant": "Q4_K_M", "total_params": "8B",
     "trained_ctx": 40960,
     "min_vram_mb": 7000, "min_ram_mb": 10000, "tier": "high", "license": "Apache-2.0", "position": 11,
     "embedding": True, "pooling": "last",
     "quality_rank": 50, "architecture": "qwen3", "experts": 0,
     "size_label": "8B", "size_bytes": 4676804928,
     "description": "8B embedding model · 40k context · Q4_K_M",
     "notes": "The #1 multilingual MTEB embed (~4.7 GB, ~7 GB VRAM) for a big card; last-token pooling."},
]

# ── Embedding task templates (Move 0, RAG build 2026-07-11) ────────────────────
# The task instruction each embed model REQUIRES around its input — a model
# FACT, per its card (all verified on the web, cites in
# justwrite-app/docs/plans/2026-07-10-rag-story-bible-research.md §9.1/§11.1):
#   * nomic-embed-text v1.5 — REQUIRES `search_document:` / `search_query:`
#     prefixes on both sides ("without prefixes, embedding quality degrades").
#   * Qwen3-Embedding (0.6B + 4B + 8B) — instruction-aware on the QUERY side only
#     ("Instruct: {task}\nQuery: {q}"; ~+22% retrieval relevance); documents
#     encode plain. The task sentence is seed wording, user-editable (flag F2).
#   * BGE-M3 — needs none → no row.
# `{text}` is the input slot; a model with no row (or an empty side) passes
# through unchanged — online/BYO embed models are automatically untouched.
_QWEN3_EMBED_QUERY = (
    "Instruct: Given a question about a novel, retrieve passages and story "
    "bible entries that answer it\nQuery: {text}"
)
DEFAULT_EMBED_TEMPLATES: list[dict] = [
    {"id": "nomic-embed-text",
     "document": "search_document: {text}", "query": "search_query: {text}"},
    {"id": "qwen3-embedding-0.6b", "document": "", "query": _QWEN3_EMBED_QUERY},
    {"id": "qwen3-embedding-4b", "document": "", "query": _QWEN3_EMBED_QUERY},
    {"id": "qwen3-embedding-8b", "document": "", "query": _QWEN3_EMBED_QUERY},
]


# (Historical: an old per-model `model_switches` table was DROPPED — it seeded
# per-model COPIES of the dense/moe TYPE rules (a one-source violation). The NEW
# `model_tunes` table (Plan B, 2026-07-05) is a DIFFERENT thing: user-MEASURED
# per-(model, machine) tunes, never seeded — no overlap with these presets.)

# Capability/type switch presets — the switch BASE layer (design §6.5 + Plan B),
# the seeded-editable replacement for the hardcoded runner-manifest `flagPresets`,
# translated into `Overrides` field names. `applies_to`: `all` (every model) |
# `moe`/`dense` (matches `model_catalog.type`) | `mtp` (GATED auto-enable — only
# a model with built-in MTP or a configured external draft file; user decision
# 2026-07-05, reversing the Phase-3 never-auto rule: auto-on, visible, and
# uncheckable — an opt-out persists in `model_tunes` and wins).
# Resolved + layered by `switch_resolve.resolve_model_switches`. (`-ngl` is NOT
# here — it's a computed fit knob, not a constant.)
DEFAULT_SWITCH_PRESETS: list[dict] = [
    {"id": "base", "label": "Base (every model)", "applies_to": "all", "position": 0,
     # reasoning_budget was REMOVED from this bundle (user, 2026-07-06 after the full
     # walk-through: it is a per-taste bound on thinking-ENABLED tasks, not a rule —
     # thinking on/off is the per-request toggle our dispatch already sends per task,
     # a different mechanism entirely; the 1024 originated as the author's own
     # box/latency preference and the mainstream pattern ships no launch budget). The
     # knob stays in knob_catalog (default -1 = unlimited) — set it per-model in the
     # switches editor if a model's template ignores the toggle or you want capped
     # deep-think chat.
     # context_shift + cache_reuse REMOVED from the base (user, 2026-07-07, on-box tested):
     # Gemma 4's iSWA context supports neither KV shifting nor prefix reuse (llama.cpp
     # auto-disables both with a warning), and context_shift measured as a net loss; the Qwen
     # config omits both too. Neither is a safe UNIVERSAL default → they stay per-model knobs
     # in knob_catalog, enable per model where they actually help.
     "switches": {"flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0", "mlock": "true"}},
    {"id": "moe", "label": "MoE (mixture-of-experts)", "applies_to": "moe", "position": 1,
     # ONLY no_mmap is genuinely MoE-specific; the spec_type default (none) lives ONCE in
     # knob_catalog — no duplicate here (the phase's own "one source" rule, 2026-07-03 Phase 3).
     "switches": {"no_mmap": "true"}},
    {"id": "mtp", "label": "MTP (multi-token prediction)", "applies_to": "mtp", "position": 2,
     # spec_n_max=2 is the USER-MEASURED sweet spot (2026-07-05, gemma-4-26B) and
     # DIFFERS from the knob default (3) — a value equal to the knob default must
     # NOT be seeded here (it would duplicate the one-source knob default).
     "switches": {"spec_type": "draft-mtp", "spec_n_max": "2"}},
]

# The class→model map (model-per-hardware plan Phase 3) — the row with the largest
# `min_vram_mb <= detected VRAM` whose model exists + fits wins QuickSetup's pick;
# no matching row → the §10 speed-floor rule. PLACEHOLDER CONTENTS, deliberately
# EQUAL to what §10 already picks (the C2-cited global best at ≥6 GB): the map is
# the EXPRESSION POINT the model research (ledger C9) refills with evidence-backed
# per-class picks — rows are data, never code.
DEFAULT_MODEL_CLASS_PICKS: list[dict] = [
    # 2026-07-06 lineup decision: the ≥6 GB pick = the user-tested Gemma 26B-A4B
    # (JustWrite seeds that row as its app extra; a host WITHOUT it — JustVoice —
    # fails pickByClassMap's exists() check and falls through to the §10 rule,
    # which lands on qwen3.6-35b-a3b-mtp there. Graceful by construction.)
    {"min_vram_mb": 6000, "model_id": "gemma-4-26b-a4b-qat"},
]

# The seeded + EDITABLE hardware-CLASS tune library (2026-07-07) — a measured launch
# config keyed by (model_id, class_key = `vram<GB>|ram<GB>`), portable to every box of
# that class (the user's argument: re-tune is only needed on hardware change, so the
# tune is a function of the hardware). Seeded rows carry the DELTA over the base/type/mtp
# bundles — the fit + measured knobs the bundles don't provide (ngl / n_cpu_moe / ctx /
# batch / threads / reasoning cap); the bundles still supply flash_attn / KV type / mlock /
# no_mmap / spec_*. Row #1 = the author's on-box-measured Gemma 26B-A4B config for the
# 8 GB / 32 GB class (n_cpu_moe 21 — the tested floor; 20 OOMs on a 2070S; the sweep's 23
# is safer/slower). NO context_shift / cache_reuse (Gemma iSWA supports neither).
DEFAULT_CLASS_TUNES: list[dict] = [
    {"model_id": "gemma-4-26b-a4b-qat", "class_key": "vram8|ram32", "switches": {
        "n_gpu_layers": "99", "n_cpu_moe": "21", "ctx_len": "32768",
        "batch_size": "512", "ubatch_size": "512", "threads": "8",
        "reasoning_budget": "1024",  # cont_batching dropped: equals llama's default (on)
    }},
]


def seed_default_class_tunes(s) -> int:
    """Seed the built-in class-tune rows (merge-by-(model, class): a user-edited or
    Lab-measured row for the same (model, class) is never clobbered — only a class
    that has NO rows yet is inserted)."""
    added = 0
    for row in DEFAULT_CLASS_TUNES:
        mid, ckey = row["model_id"], row["class_key"]
        if s.query(db.ClassTune).filter(
            db.ClassTune.model_id == mid, db.ClassTune.class_key == ckey
        ).first():
            continue
        for fname, fval in row["switches"].items():
            s.add(db.ClassTune(model_id=mid, class_key=ckey,
                               flag_name=fname, flag_value=str(fval), built_in=True))
        added += 1
    return added


def seed_default_class_picks(s) -> int:
    """Seed the class→model map rows (merge-by-key; a user-edited row is never clobbered)."""
    existing = {r.min_vram_mb for r in s.query(db.ModelClassPick.min_vram_mb).all()}
    added = 0
    for row in DEFAULT_MODEL_CLASS_PICKS:
        if int(row["min_vram_mb"]) in existing:
            continue
        s.add(db.ModelClassPick(min_vram_mb=int(row["min_vram_mb"]),
                                model_id=str(row["model_id"]), built_in=True))
        added += 1
    return added


# The nine canonical LLM-work TASKS — the seed defaults for the user-editable
# `task_kinds` table. App-agnostic (both apps share the same nine), so they live here
# in the SHARED block, NOT in per-app seed data (moved out of task_kinds_api.TASK_KINDS,
# 2026-07-02). Users create / rename / delete CUSTOM tasks; these built-ins are
# protected (TaskKindStore.delete blocks them) and re-seed on boot. `id` is the routing
# key — it matches feature_task_kinds.task_kind + task_kind_presets.
# Only the feature→task MAP + the task→preset assignments are per-app. Ordered prose →
# structured → chat.
DEFAULT_TASK_KINDS: list[dict] = [
    {"id": "prose.generate", "label": "Generate prose", "description": "Write new voiced narrative prose."},
    {"id": "prose.edit", "label": "Edit prose", "description": "Faithful line-level revision of existing prose."},
    {"id": "ideation", "label": "Ideation", "description": "Open-ended brainstorming of names, titles, and plot moves."},
    {"id": "creative.structured", "label": "Structured creative", "description": "Creative output emitted as structured JSON."},
    {"id": "summary.grounded", "label": "Grounded summary", "description": "A faithful digest grounded in the source text."},
    {"id": "extract.structured", "label": "Structured extraction", "description": "Extract facts / entities as structured JSON."},
    {"id": "judge.scored", "label": "Judgment & scoring", "description": "Careful analysis and scored critique, emitted as JSON."},
    {"id": "chat.grounded", "label": "Grounded chat", "description": "Q&A grounded in retrieved excerpts (RAG)."},
    {"id": "chat.inVoice", "label": "In-character chat", "description": "First-person, in-voice answers from a character."},
]


# Runner config (was runner-manifest.json). The binary list + scalars are
# imported from the runner package (ONE source of truth; the standalone runner
# also reads them via runner.config.default_config) and seeded built_in.
DEFAULT_RUNNER_SETTINGS: list[dict] = [
    {"key": "pinned_build", "value": DEFAULT_PINNED_BUILD},
    {"key": "safety_margin_mb", "value": str(DEFAULT_SAFETY_MARGIN_MB)},
    # Router mode (P1e): DB-editable co-resident cap + idle-unload TTL.
    {"key": "models_max", "value": str(DEFAULT_MODELS_MAX)},
    {"key": "sleep_idle_seconds", "value": str(DEFAULT_SLEEP_IDLE_SECONDS)},
    # Segmented downloads (DL-2): additive rows — an existing DB gains them at
    # the next boot (the fill-empty seeder never clobbers user edits).
    {"key": "download_segments_enabled", "value": "1" if DEFAULT_DOWNLOAD_SEGMENTS_ENABLED else "0"},
    {"key": "download_segment_count", "value": str(DEFAULT_DOWNLOAD_SEGMENT_COUNT)},
    {"key": "download_segment_min_bytes", "value": str(DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES)},
    {"key": "download_segment_retries", "value": str(DEFAULT_DOWNLOAD_SEGMENT_RETRIES)},
]

# Knob catalog — metadata that turns a raw switch/sampler key into a friendly
# KnobGrid input. Plane 1 = load-time engine switch (maps to a process.Overrides
# field); Plane 2 = per-request sampler (maps to the dispatch `extra`). `options`
# (inline) become enum rows in knob_option. C1: data only, no code per param.
# QC-17 + QC-18 (user, 2026-07-09): plane-1 rows carry NO default_value (the app
# stops storing/claiming the engine's own defaults — an unset switch simply isn't
# sent, the engine does its own thing) and NO options (switch values are plain
# text/number boxes; the HELP names the accepted values — accepted-value lists
# verified against llama.cpp tools/server/README.md, fetched 2026-07-09). Plane-2
# sampler rows keep default_value (OUR enable-prefills — samplers untouched).
# `tier` = common|advanced drives the sampler checklist split. Order within each
# plane is common-first (the seeder sets position=i).
DEFAULT_KNOBS: list[dict] = [
    # ── Plane 1 — load switches: COMMON (fit & memory) ──
    {"flag_name": "ctx_len", "label": "Context size", "kind": "int", "plane": 1, "tier": "common",
     "help": "Maximum tokens the model can read + write at once. Bigger = more memory (the KV cache grows with it). Set it to fit your longest task; unset, the engine reads the model's own limit."},
    {"flag_name": "flash_attn", "label": "Flash attention", "kind": "string", "plane": 1, "tier": "common",
     "help": "Faster attention using less memory. Values: on, off, auto."},
    {"flag_name": "cache_type_k", "label": "KV cache type (K)", "kind": "string", "plane": 1, "tier": "common",
     "help": "Compress the K side of the KV cache to save VRAM. q8_0 is near-lossless; q4_0 saves more but can cost quality. Accepts f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1."},
    {"flag_name": "cache_type_v", "label": "KV cache type (V)", "kind": "string", "plane": 1, "tier": "common",
     "help": "Compress the V side of the KV cache to save VRAM. q8_0 is near-lossless. Accepts f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1."},
    {"flag_name": "n_cpu_moe", "label": "CPU MoE layers", "kind": "int", "plane": 1, "applies_to": "moe", "tier": "common",
     "help": "Expert layers to run on CPU — frees VRAM (MoE only). Auto-fit sets it; pin the fast value here."},
    # ── Plane 1 — load switches: ADVANCED ──
    # n_gpu_layers ADDED 2026-07-07 (user bug report): it was always a valid Overrides
    # field (lifecycle._parse_switch int_fields) but had no catalog row because fit
    # normally derives it — then the class-tune seed started writing n_gpu_layers=99
    # (the MoE pattern: all layers on GPU, offload via n_cpu_moe) and the Tune grid
    # badged the resolved row "unrecognized". The knob row makes it a first-class,
    # labelled switch; the seeder merges by flag_name so existing DBs gain it on boot.
    {"flag_name": "n_gpu_layers", "label": "GPU layers", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "How many model layers run on the GPU (the rest run on CPU). Auto-fit sets it when unset; MoE tunes pin every layer on GPU (99) and free VRAM with CPU MoE layers instead."},
    {"flag_name": "mlock", "label": "Lock in RAM", "kind": "bool", "plane": 1, "tier": "advanced",
     "help": "Keep the model locked in RAM so the OS can't swap it out (steadier speed). Turn off if RAM is tight. Values: true or false."},
    {"flag_name": "no_mmap", "label": "Load into RAM", "kind": "bool", "plane": 1, "applies_to": "moe", "tier": "advanced",
     "help": "Read the whole model into RAM instead of memory-mapping it. Needed for MoE CPU-offload; otherwise leave off. Values: true or false."},
    {"flag_name": "no_kv_offload", "label": "KV in system RAM", "kind": "bool", "plane": 1, "tier": "advanced",
     "help": "Keep the KV cache in system RAM instead of VRAM — frees VRAM but is slower. Values: true or false."},
    {"flag_name": "batch_size", "label": "Batch size", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "How many prompt tokens are processed together (throughput vs memory)."},
    {"flag_name": "ubatch_size", "label": "Micro-batch size", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "Physical batch — the chunk actually run per step. Lower it if prompt processing runs out of memory."},
    {"flag_name": "threads", "label": "CPU threads", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "CPU threads for generation (drive MoE CPU experts). Unset, the engine uses your physical cores."},
    {"flag_name": "threads_batch", "label": "CPU threads (prompt)", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "CPU threads for prompt processing. Unset, the engine matches CPU threads."},
    {"flag_name": "parallel", "label": "Parallel slots", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "Concurrent server slots (used by batch sweeps / Compare)."},
    {"flag_name": "cont_batching", "label": "Continuous batching", "kind": "bool", "plane": 1, "tier": "advanced",
     "help": "Overlap requests for throughput; only turn it off to debug. Values: true or false."},
    # context_shift + cache_reuse REMOVED from the catalog (QC-11, user 2026-07-09
    # "remove from catalog" — they were also pulled from the shipped bundles
    # 2026-07-07 as a measured net loss). Still typeable as custom switches.
    {"flag_name": "spec_type", "label": "Speculative decode", "kind": "string", "plane": 1, "tier": "advanced",
     "help": "Draft-model speculative decode. MTP GGUF only; gains are machine-dependent — measure. Values: none, draft-mtp, ngram-mod."},
    {"flag_name": "spec_n_max", "label": "Spec draft tokens", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "How many tokens the draft proposes per step."},
    {"flag_name": "reasoning_budget", "label": "Thinking budget", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "Token budget for the model's thinking phase: -1 = unlimited, 0 = no thinking, a positive number caps it (the budget message is injected when it runs out)."},
    {"flag_name": "reasoning_budget_message", "label": "Budget-exhausted message", "kind": "string", "plane": 1, "tier": "advanced",
     "help": "Text injected before the end-of-thinking tag when the thinking budget runs out. Avoid '#' — it starts a comment in the engine preset file."},
    # ── Plane 2 — per-request samplers: COMMON ──
    # temperature + top_p stay in the catalog but are edited in the per-call params
    # row (excluded from the checklist by ConfigColumn) — tier is harmless here.
    {"flag_name": "temperature", "label": "Temperature", "kind": "float", "plane": 2, "default_value": "0.7", "tier": "common",
     "help": "Randomness. Low (≈0) for extraction/JSON; higher (0.8–1.0) for prose."},
    {"flag_name": "top_p", "label": "Top-p", "kind": "float", "plane": 2, "default_value": "0.95", "tier": "common",
     "help": "Nucleus sampling — keep the smallest set of tokens summing to this probability. The cloud-API truncation knob."},
    {"flag_name": "top_k", "label": "Top-k", "kind": "int", "plane": 2, "tier": "common",
     "help": "Keep only the k most-likely tokens (0 = off)."},
    {"flag_name": "min_p", "label": "Min-p", "kind": "float", "plane": 2, "tier": "common",
     "help": "Drop tokens below this fraction of the top token's probability. For local models this is the truncation knob to reach for first (try 0.05–0.1)."},
    {"flag_name": "repeat_penalty", "label": "Repeat penalty", "kind": "float", "plane": 2, "tier": "common",
     "help": "Penalize recently-used tokens (>1 reduces repetition)."},
    {"flag_name": "repeat_last_n", "label": "Repeat range", "kind": "int", "plane": 2, "default_value": "64", "tier": "common",
     "help": "How many recent tokens Repeat penalty looks back over (llama.cpp default 64; -1 = whole context, 0 = off)."},
    {"flag_name": "seed", "label": "Seed", "kind": "int", "plane": 2, "tier": "common",
     "help": "Fixed RNG seed for reproducible output (-1 = random)."},
    # ── Plane 2 — per-request samplers: ADVANCED ──
    {"flag_name": "presence_penalty", "label": "Presence penalty", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Penalize tokens that already appeared at all (OpenAI-style; 0 = off)."},
    {"flag_name": "frequency_penalty", "label": "Frequency penalty", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Penalize tokens by how often they've appeared (OpenAI-style; 0 = off)."},
    {"flag_name": "typical_p", "label": "Typical-p", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Locally-typical sampling — keep tokens near the expected information content (1.0 = off)."},
    {"flag_name": "dry_multiplier", "label": "DRY penalty", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Don't-Repeat-Yourself: penalize repeated sequences (0 = off). A stronger anti-repetition than Repeat penalty."},
    {"flag_name": "dry_base", "label": "DRY base", "kind": "float", "plane": 2, "default_value": "1.75", "tier": "advanced",
     "help": "How steeply DRY penalizes longer repeats (llama.cpp default 1.75). Used with DRY penalty."},
    {"flag_name": "dry_allowed_length", "label": "DRY allowed length", "kind": "int", "plane": 2, "default_value": "2", "tier": "advanced",
     "help": "Repeats up to this length are free; longer ones get penalized (llama.cpp default 2)."},
    {"flag_name": "dry_penalty_last_n", "label": "DRY range", "kind": "int", "plane": 2, "default_value": "-1", "tier": "advanced",
     "help": "How many recent tokens DRY scans (-1 = whole context, 0 = off)."},
    {"flag_name": "xtc_probability", "label": "XTC probability", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Exclude-Top-Choices: chance to drop the most-likely tokens for variety (0 = off)."},
    {"flag_name": "xtc_threshold", "label": "XTC threshold", "kind": "float", "plane": 2, "default_value": "0.1", "tier": "advanced",
     "help": "XTC only removes tokens above this probability (llama.cpp default 0.1; 1.0 = off). Used with XTC probability."},
    {"flag_name": "mirostat", "label": "Mirostat", "kind": "int", "plane": 2, "tier": "advanced",
     "help": "Adaptive perplexity sampler: 0 = off, 1 = v1, 2 = v2."},
    {"flag_name": "mirostat_tau", "label": "Mirostat tau", "kind": "float", "plane": 2, "default_value": "5.0", "tier": "advanced",
     "help": "Mirostat target 'surprise' (entropy) — higher = more varied (llama.cpp default 5.0). Used only when Mirostat is on."},
    {"flag_name": "mirostat_eta", "label": "Mirostat eta", "kind": "float", "plane": 2, "default_value": "0.1", "tier": "advanced",
     "help": "Mirostat learning rate — how fast it adapts (llama.cpp default 0.1). Used only when Mirostat is on."},
    {"flag_name": "dynatemp_range", "label": "Dynamic temp range", "kind": "float", "plane": 2, "default_value": "0.0", "tier": "advanced",
     "help": "Dynamic temperature: how far temperature can swing per token (0 = off)."},
    {"flag_name": "dynatemp_exponent", "label": "Dynamic temp exponent", "kind": "float", "plane": 2, "default_value": "1.0", "tier": "advanced",
     "help": "Shape of the dynamic-temperature curve (llama.cpp default 1.0). Used with Dynamic temp range."},
    {"flag_name": "top_n_sigma", "label": "Top-n-sigma", "kind": "float", "plane": 2, "default_value": "-1.0", "tier": "advanced",
     "help": "Keep tokens within N standard deviations of the top logit (-1 = off). A newer, simple truncation."},
    {"flag_name": "min_keep", "label": "Min keep", "kind": "int", "plane": 2, "default_value": "0", "tier": "advanced",
     "help": "Always keep at least this many candidate tokens through the filters (0 = no minimum)."},
]


# Prior seeded names, per provider id (#3, 2026-07-08 "Built-in server" →
# "Built-in provider"): existing DBs keep their rows on reseed, so a pure rename in
# DEFAULT_PROVIDERS never reaches them. The seeder refreshes a present row's name
# ONLY while it still reads exactly one of these old seeded strings — a user's own
# rename is a different fact and is never touched (the B1-4 fill-empty precedent,
# applied to a rename).
_RENAMED_PROVIDER_NAMES: dict[str, tuple[str, ...]] = {
    "local-llamacpp": ("Built-in server — llama.cpp",),
}


# ── seeders (operate on a passed session, no commit) ──────────────────────────
def seed_default_providers(s) -> int:
    existing = {r.id: r for r in s.query(db.LlmProvider).all()}
    pos = len(existing)
    added = 0
    for p in DEFAULT_PROVIDERS:
        if p["id"] in existing:
            row = existing[p["id"]]
            if row.name in _RENAMED_PROVIDER_NAMES.get(p["id"], ()):
                row.name = str(p.get("name") or "")
            continue
        s.add(db.LlmProvider(
            id=p["id"], name=str(p.get("name") or ""), kind="llm", built_in=True, position=pos,
            provider_type=str(p["provider_type"]), base_url=str(p.get("base_url") or ""), api_key=None,
            default_model=str(p.get("default_model") or ""), embedding_model=str(p.get("embedding_model") or ""),
            timeout_seconds=int(p.get("timeout_seconds") or 60), local=bool(p["local"]),
        ))
        pos += 1
        added += 1
    return added


# Use-limited licenses (not free for unrestricted/commercial use) → the ⚠ badge.
# This keyword match runs ONCE at seed time to populate the per-model `use_limited`
# flag, which is then DB-stored + editable per-model — so there is NO hardcoded
# runtime license rule (the old client-side regex is gone).
_USE_LIMITED_TERMS = ("community", "research", "non-commercial", "noncommercial", "llama", "gemma", "cc-by-nc")


def _use_limited(license_id: str) -> bool:
    lic = (license_id or "").lower()
    return any(t in lic for t in _USE_LIMITED_TERMS)


def _catalog_row(c: dict, *, built_in: bool) -> "db.ModelCatalog":
    """One catalog seed dict → a ModelCatalog row. Shared by the built-in seed and
    the per-APP extra rows (`seed_extra_catalog`) so the field mapping — including
    the Gemma-style external MTP draft facts — has a single source."""
    return db.ModelCatalog(
        id=c["id"], name=str(c.get("name") or ""), hf_repo=str(c.get("hf_repo") or ""),
        quant=str(c.get("quant") or ""), mmproj=c.get("mmproj"),
        total_params=str(c.get("total_params") or ""), active_params=str(c.get("active_params") or ""),
        mtp=bool(c.get("mtp") or False), mtp_builtin=bool(c.get("mtp_builtin") or False),
        type=str(c.get("type") or "dense"),
        mtp_draft_repo=str(c.get("mtp_draft_repo") or ""),
        mtp_draft_file=str(c.get("mtp_draft_file") or ""),
        mtp_draft_quant=str(c.get("mtp_draft_quant") or ""),
        trained_ctx=c.get("trained_ctx"),
        min_vram_mb=c.get("min_vram_mb"), min_ram_mb=c.get("min_ram_mb"),
        tier=str(c.get("tier") or "mid"), license=str(c.get("license") or ""),
        use_limited=_use_limited(str(c.get("license") or "")), embedding=bool(c.get("embedding") or False),
        pooling=str(c.get("pooling") or ""),
        quality_rank=int(c.get("quality_rank") or 100), description=str(c.get("description") or ""),
        notes=str(c.get("notes") or ""),
        architecture=str(c.get("architecture") or ""), experts=int(c.get("experts") or 0),
        size_label=str(c.get("size_label") or ""), size_bytes=c.get("size_bytes"),
        built_in=built_in, position=int(c.get("position") or 0),
    )


def _seed_samplers(s, model_id: str, samplers: dict | None) -> None:
    """Seed a NEW catalog row's recommended-sampler rows (2026-07-07, the read-from-link
    parity item: the seed ships what the FILE says — these values come from the live
    header/generation_config reads recorded in the design doc ROUND 16). Written with
    built_in=False to be byte-identical with what the download-time identify pass
    (`set_derived`) produces — seed == file, one shape. Only called when the catalog
    row itself was just inserted, so a user's own sampler edits are never touched."""
    for name, val in (samplers or {}).items():
        nm = (name or "").strip()
        if nm:
            s.add(db.ModelSampler(model_id=model_id, param_name=nm, value=str(val), built_in=False))


# Known-stale seeded values, healed at boot (QC-43a, 2026-07-10): a seeded
# FACT that later proved wrong can never self-heal through fill-empty (the
# wrong value isn't empty), so each corrected fact records the exact old
# value(s) it once seeded and the catalog seeder swaps them for the CURRENT
# seed value — only when the row still carries an exact stale value, so a
# user- or inspect-written value never matches and is never touched.
STALE_SEED_VALUES = {
    # The Gemma-26B ablated row's draft path: upstream's real file is the
    # root-level `mtp-gemma-4-26B-A4B-it.gguf` (HF tree verified 2026-07-10).
    ("gemma-4-26b-a4b-uncensored", "mtp_draft_file"):
        ("MTP/gemma-4-26B-A4B-it-Q4_0-MTP.gguf",),
    # The 12B/31B QAT rows seeded a WRONG draft path (`gemma-…-Q4_0-MTP.gguf`); the
    # repos ship `MTP/mtp-gemma-…-it-Q4_0.gguf` (HF tree verified 2026-07-13, caught by
    # the extended seed-facts audit's draft-in-tree check). Heal the exact old value.
    ("gemma-4-12b-qat", "mtp_draft_file"):
        ("MTP/gemma-4-12B-it-Q4_0-MTP.gguf",),
    ("gemma-4-31b-qat", "mtp_draft_file"):
        ("MTP/gemma-4-31B-it-Q4_0-MTP.gguf",),
}


def seed_default_catalog(s) -> int:
    existing = {r.id: r for r in s.query(db.ModelCatalog).all()}
    added = 0
    for c in DEFAULT_CATALOG:
        row = existing.get(c["id"])
        if row is not None:
            # Fill-empty-only touch-up (#12b, 2026-07-08): existing DBs get the
            # harvested size FACTS without a reset. Auto-detected fields only,
            # and only when EMPTY — a value written at download time (the real
            # local file) or by a fresh inspect always wins; user-editable
            # fields are never touched here.
            if row.size_bytes is None and c.get("size_bytes") is not None:
                row.size_bytes = int(c["size_bytes"])
            if not row.size_label and c.get("size_label"):
                row.size_label = str(c["size_label"])
            # Known-stale heal (QC-43a): swap an exact historically-seeded
            # wrong value for the current seed fact; anything else is a
            # user/inspect value and stays.
            for (rid, field), stale in STALE_SEED_VALUES.items():
                if rid == c["id"] and getattr(row, field, None) in stale and c.get(field):
                    setattr(row, field, c[field])
            continue
        s.add(_catalog_row(c, built_in=True))
        _seed_samplers(s, c["id"], c.get("samplers"))
        added += 1
    return added


def seed_extra_catalog(s, rows) -> int:
    """Per-APP extra model-catalog rows (host input via `install_llm`, e.g. JW's
    tuned Gemma daily drivers). Insert-if-missing by id — a reset re-creates them,
    a user edit is never clobbered. Seeded `built_in=False`: they are the app's
    seed data, not the shared stack's, so the catalog UI treats them as user rows."""
    existing = {r.id for r in s.query(db.ModelCatalog.id).all()}
    added = 0
    for c in rows or ():
        if c["id"] in existing:
            continue
        s.add(_catalog_row(c, built_in=False))
        _seed_samplers(s, c["id"], c.get("samplers"))
        added += 1
    return added


def seed_model_tunes_if_missing(s, hw_key: str, entries) -> int:
    """Per-APP tune seed for THIS machine (host input via `install_llm`): entries =
    [{"model_id": id, "flags": {flag_name: value}}], keyed under the CURRENT box's
    `hw_key`. The model_tunes design decree ("user-written only, never seeded")
    survives in spirit: strictly insert-if-missing per (model, hw, flag), so a
    user's Quick-tune Save is NEVER clobbered — this only re-creates the app's
    known-good starting tune after a dev-DB reset (pre-production, resets are the
    schema-upgrade path; without this the tuned values would vanish on every reset)."""
    if not hw_key:
        return 0
    existing = {
        (r.model_id, r.flag_name)
        for r in s.query(db.ModelTune).filter(db.ModelTune.hw_key == hw_key).all()
    }
    added = 0
    for e in entries or ():
        mid = e.get("model_id") or ""
        for fname, fval in (e.get("flags") or {}).items():
            if not mid or (mid, fname) in existing:
                continue
            s.add(db.ModelTune(model_id=mid, hw_key=hw_key, flag_name=fname, flag_value=str(fval)))
            added += 1
    return added


def seed_default_pricing(s) -> int:
    """Seed the cloud pricing table from DEFAULT_PRICING (merge-by-id — never
    clobber user edits). Runtime pricing reads the DB (editable), not this dict."""
    from .pricing import DEFAULT_PRICING
    existing = {r.model_id for r in s.query(db.ModelPricing.model_id).all()}
    added = 0
    for mid, (inp, out) in DEFAULT_PRICING.items():
        if mid in existing:
            continue
        s.add(db.ModelPricing(model_id=mid, input_per_m=float(inp), output_per_m=float(out)))
        added += 1
    return added


def seed_default_embed_templates(s) -> int:
    """Seed the per-model embedding task templates from DEFAULT_EMBED_TEMPLATES
    (merge-by-id — never clobber user edits). /v1/ai/embeddings applies these;
    editable via /v1/ai/embed-templates."""
    existing = {r.model_id for r in s.query(db.ModelEmbedTemplate.model_id).all()}
    added = 0
    for t in DEFAULT_EMBED_TEMPLATES:
        if t["id"] in existing:
            continue
        s.add(db.ModelEmbedTemplate(
            model_id=t["id"], document_template=t.get("document") or "",
            query_template=t.get("query") or "", built_in=True,
        ))
        added += 1
    return added


def seed_default_switch_presets(s) -> int:
    """Seed the capability/type switch presets (base + moe + the gated mtp) + their flag rows.
    Flushes each preset before its FK child rows (host session is autoflush=False
    with FK enforcement on — see the routing FK gotcha)."""
    existing = {r.id for r in s.query(db.SwitchPreset.id).all()}
    added = 0
    for p in DEFAULT_SWITCH_PRESETS:
        if p["id"] in existing:
            continue
        s.add(db.SwitchPreset(id=p["id"], label=str(p.get("label") or ""),
                              applies_to=str(p.get("applies_to") or "all"),
                              position=int(p.get("position") or 0), built_in=True))
        s.flush()  # parent in the DB before its FK children
        for fname, fval in (p.get("switches") or {}).items():
            s.add(db.PresetSwitch(preset_id=p["id"], flag_name=fname, flag_value=str(fval), built_in=True))
        added += 1
    return added


def seed_default_engine_presets(s) -> int:
    """Seed the host's built-in engine presets (the factory preset library, the
    2026-06-29 lab+preset model — §7.1: request params + samplers only, NO launch
    switches) + their FK sampler children. Flush each parent before its children
    (host session: autoflush off + FK on — the switch-preset seeder gotcha).
    Per-app data via `app_engine_presets()`."""
    existing = {r.id for r in s.query(db.EnginePreset.id).all()}
    added = 0
    for p in app_engine_presets():
        if p["id"] in existing:
            continue
        s.add(db.EnginePreset(
            id=p["id"], name=str(p.get("name") or ""), provider_id=str(p.get("provider_id") or ""),
            model=str(p.get("model") or ""), temperature=p.get("temperature"), top_p=p.get("top_p"),
            max_tokens=int(p.get("max_tokens") or 0), json_mode=bool(p.get("json_mode") or False),
            reasoning_effort=str(p.get("reasoning_effort") or ""),
            position=int(p.get("position") or 0), built_in=True))
        s.flush()  # parent in the DB before its FK children
        for pname, pval in (p.get("samplers") or {}).items():
            s.add(db.EnginePresetSampler(preset_id=p["id"], param_name=pname, value=str(pval)))
        added += 1
    return added


def seed_default_taskkind_presets(s) -> int:
    """Seed the built-in taskKind→preset assignments (the routing defaults, the
    `TaskKindPreset` bulk handle). FK-safe: skip any assignment whose preset_id
    isn't a known EnginePreset (seeded above or already in the DB). Per-app data via
    `app_taskkind_presets()` (list of {task_kind, preset_id})."""
    existing = {r.task_kind for r in s.query(db.TaskKindPreset.task_kind).all()}
    valid = {p["id"] for p in app_engine_presets()} | {r.id for r in s.query(db.EnginePreset.id).all()}
    added = 0
    for c in app_taskkind_presets():
        if c["task_kind"] in existing or c["preset_id"] not in valid:
            continue
        s.add(db.TaskKindPreset(task_kind=c["task_kind"], preset_id=c["preset_id"]))
        added += 1
    return added


def seed_default_task_kinds(s) -> int:
    """Seed the shared built-in TASKS (the LLM-work buckets) into the user-editable
    `task_kinds` table. App-agnostic — from the shared DEFAULT_TASK_KINDS, not per-app
    data. Merge-by-id (skips existing), so a user's custom/renamed rows survive a
    re-seed; built_in=True marks the defaults un-deletable in TaskKindStore."""
    existing = {r.id for r in s.query(db.TaskKind.id).all()}
    added = 0
    for i, t in enumerate(DEFAULT_TASK_KINDS):
        if t["id"] in existing:
            continue
        s.add(db.TaskKind(id=t["id"], label=str(t.get("label") or ""),
                          description=str(t.get("description") or ""),
                          position=int(t.get("position", i)), built_in=True))
        added += 1
    return added


def seed_default_feature_task_kinds(s) -> int:
    """Seed the host's action→task MAP into the user-editable `feature_task_kinds`
    table (per-app data via `app_feature_task_kinds()`). Merge-by-key so a user's
    reassignments survive a re-seed; an absent row falls back to the in-memory map in
    `install._task_kind_of`, so routing is correct even if this seed is empty."""
    existing = {r.key for r in s.query(db.FeatureTaskKind.key).all()}
    added = 0
    for key, tk in app_feature_task_kinds().items():
        if key in existing or not tk:
            continue
        s.add(db.FeatureTaskKind(key=key, task_kind=tk))
        added += 1
    return added


def restore_built_in_engine_presets(s) -> None:
    """Restore the built-in engine presets to factory: delete the seeded (built_in)
    presets + their FK children, then re-seed. CUSTOM presets are untouched. The
    `s.flush()` is MANDATORY — the host session is autoflush-OFF (see `seed_llm`), so
    without it `seed_default_engine_presets`' existence query (it skips ids already in
    the DB) would still see the pending-deleted rows and refuse to re-add them → the
    built-ins would be permanently gone. Mirrors `SwitchPresetStore.reset_to_factory`."""
    from . import stores
    ids = [r.id for r in s.query(db.EnginePreset.id).filter(db.EnginePreset.built_in.is_(True)).all()]
    stores._delete_engine_preset_rows(s, ids)
    s.flush()
    seed_default_engine_presets(s)


def restore_built_in_task_defs(s) -> None:
    """Overwrite each built-in task's label/description/position back to factory (from the
    shared DEFAULT_TASK_KINDS). CUSTOM tasks are untouched. Position is the list index —
    DEFAULT_TASK_KINDS rows carry no `position` key (`seed_default_task_kinds` derives it)."""
    by_id = {t.id: t for t in s.query(db.TaskKind).filter(db.TaskKind.built_in.is_(True)).all()}
    for i, t in enumerate(DEFAULT_TASK_KINDS):
        row = by_id.get(t["id"])
        if row is None:
            continue  # a missing built-in is (re)added by seed_default_task_kinds
        row.label = str(t.get("label") or "")
        row.description = str(t.get("description") or "")
        row.position = i


def reset_routing_to_factory() -> None:
    """Restore the AI routing config to factory (the Tasks page "Reset all to defaults"):
    clear task→preset (`task_kind_presets`) + feature→task (`feature_task_kinds`), RESTORE
    the built-in engine presets + built-in task label/desc, then re-seed the built-in tasks
    + the app's factory action→task map + task→preset assignments. CUSTOM tasks + CUSTOM
    presets are KEPT (the app's reset convention — see the model catalog / switch-preset
    resets); only the built-ins + assignments snap back to defaults."""
    s = db.session()
    try:
        s.query(db.TaskKindPreset).delete()
        s.query(db.FeatureTaskKind).delete()
        s.flush()
        restore_built_in_engine_presets(s)  # delete → flush → re-seed (custom kept)
        restore_built_in_task_defs(s)       # overwrite built-in label/desc back to factory
        seed_default_task_kinds(s)          # re-add any missing built-in tasks
        seed_default_feature_task_kinds(s)  # the app's factory action→task map
        seed_default_taskkind_presets(s)    # factory task→preset (FK-safe: presets restored first)
        s.commit()
    finally:
        s.close()


def reset_task_to_factory(task_id: str) -> None:
    """Reset ONE built-in task to factory: restore its label/description/position from
    DEFAULT_TASK_KINDS + set its task→preset to the app's factory assignment + UNDO the
    feature MOVES involving this task (QC-27, the user's "yes undo moves"): every feature
    whose FACTORY task is this one comes back, and every feature moved INTO this one
    re-floats to its own factory task — in both cases the row snaps to the app's factory
    map (a feature with no factory entry is un-overridden entirely). Features whose moves
    never touched this task are left alone. A CUSTOM task has no factory to reset to →
    ValueError (the API maps it to 400). Edges: if the task has no factory preset entry,
    or that preset was user-deleted, the task→preset row is CLEARED (falls back to the
    global default) rather than left stale / FK-violating."""
    factory = {t["id"]: (i, t) for i, t in enumerate(DEFAULT_TASK_KINDS)}
    if task_id not in factory:
        raise ValueError(f"{task_id!r} is not a built-in task")
    pos, t = factory[task_id]
    s = db.session()
    try:
        row = s.get(db.TaskKind, task_id)
        if row is None or not row.built_in:
            raise ValueError(f"{task_id!r} is not a built-in task")
        row.label = str(t.get("label") or "")
        row.description = str(t.get("description") or "")
        row.position = pos
        # QC-27: undo the moves involving THIS task, both directions.
        factory_map = app_feature_task_kinds()
        for ftk in s.query(db.FeatureTaskKind).all():
            involved = ftk.task_kind == task_id or factory_map.get(ftk.key) == task_id
            if not involved:
                continue
            factory_tk = factory_map.get(ftk.key, "")
            if factory_tk:
                ftk.task_kind = factory_tk
            else:
                s.delete(ftk)  # no factory home → un-override (prefix/"" fallback)
        factory_preset = {c["task_kind"]: c["preset_id"] for c in app_taskkind_presets()}.get(task_id, "")
        valid = {r.id for r in s.query(db.EnginePreset.id).all()}
        target = factory_preset if factory_preset in valid else ""
        tkp = s.get(db.TaskKindPreset, task_id)
        if not target:
            if tkp is not None:
                s.delete(tkp)          # no factory preset (or it was deleted) → fall back to default
        elif tkp is None:
            s.add(db.TaskKindPreset(task_kind=task_id, preset_id=target))
        else:
            tkp.preset_id = target
        s.commit()
    finally:
        s.close()


def seed_default_runner_binaries(s) -> int:
    # RETIRED built-ins are PRUNED (user, 2026-07-07: "deleet" the cpu rows — a
    # CPU-only box can't run local LLMs at usable speed, so the cpu variants left
    # DEFAULT_BINARIES entirely): a built_in row whose (platform, gpu) no longer
    # exists in the defaults is removed at seed time, so existing DBs converge on
    # boot; user-ADDED rows (built_in=False) are never touched.
    wanted = {(b["platform"], b["gpu"]) for b in DEFAULT_BINARIES}
    for r in s.query(db.RunnerBinary).filter(db.RunnerBinary.built_in.is_(True)).all():
        if (r.platform, r.gpu) not in wanted:
            s.delete(r)
    existing = {(r.platform, r.gpu) for r in s.query(db.RunnerBinary.platform, db.RunnerBinary.gpu).all()}
    added = 0
    for i, b in enumerate(DEFAULT_BINARIES):
        if (b["platform"], b["gpu"]) in existing:
            continue
        s.add(db.RunnerBinary(
            platform=b["platform"], gpu=b["gpu"], source=str(b.get("source") or "github"),
            asset_url=b.get("asset_url"), runtime_url=b.get("runtime_url"),
            image=b.get("image"), sha256=b.get("sha256"),
            server_exe=str(b.get("server_exe") or "llama-server"), built_in=True, position=i,
        ))
        added += 1
    return added


def seed_default_runner_settings(s) -> int:
    existing = {r.key for r in s.query(db.RunnerSetting.key).all()}
    added = 0
    for r in DEFAULT_RUNNER_SETTINGS:
        if r["key"] in existing:
            continue
        s.add(db.RunnerSetting(key=r["key"], value=str(r.get("value") or ""), built_in=True))
        added += 1
    return added


def seed_default_knobs(s) -> int:
    """Seed knob_catalog + its enum options (knob_option). Flush each parent before
    its FK children (host session: autoflush off + FK on).

    The catalog is APP-OWNED, read-only data (GET /v1/ai/knob-catalog is its only
    endpoint — nothing in the app edits knob rows), so built-in rows SYNC to
    DEFAULT_KNOBS on every boot: label/kind/default_value/help/plane/applies_to/
    tier/position refresh from the seed (QC-17, 2026-07-09: plane-1 rows carry NO
    default_value — the app stopped storing the engine's own defaults), built-in
    rows dropped from the seed are DELETED (QC-11: context_shift + cache_reuse;
    their KnobOption rows cascade), and built-in option rows the seed no longer
    carries are deleted too (QC-18: switch values are plain text/number boxes —
    no seeded enum lists remain on plane 1)."""
    existing = {r.flag_name: r for r in s.query(db.KnobCatalog).all()}
    seeded_names = {k["flag_name"] for k in DEFAULT_KNOBS}
    added = 0
    for name, row in existing.items():
        if row.built_in and name not in seeded_names:
            s.delete(row)  # FK ondelete=CASCADE clears its options
    for i, k in enumerate(DEFAULT_KNOBS):
        row = existing.get(k["flag_name"])
        if row is not None:
            if row.built_in:
                row.label = str(k.get("label") or "")
                row.kind = str(k.get("kind") or "string")
                row.default_value = str(k.get("default_value") or "")
                row.help = str(k.get("help") or "")
                row.plane = int(k.get("plane") or 1)
                row.applies_to = str(k.get("applies_to") or "all")
                row.tier = str(k.get("tier") or "common")
                row.position = i
                seeded_opts = {str(o["value"]) for o in (k.get("options") or [])}
                for opt in s.query(db.KnobOption).filter(db.KnobOption.flag_name == k["flag_name"]).all():
                    if opt.built_in and opt.value not in seeded_opts:
                        s.delete(opt)
            continue
        s.add(db.KnobCatalog(
            flag_name=k["flag_name"], label=str(k.get("label") or ""), kind=str(k.get("kind") or "string"),
            default_value=str(k.get("default_value") or ""), help=str(k.get("help") or ""),
            plane=int(k.get("plane") or 1), applies_to=str(k.get("applies_to") or "all"),
            tier=str(k.get("tier") or "common"),
            position=i, built_in=True,
        ))
        s.flush()
        for j, opt in enumerate(k.get("options") or []):
            s.add(db.KnobOption(flag_name=k["flag_name"], value=str(opt["value"]),
                                label=str(opt.get("label") or opt["value"]), position=j, built_in=True))
        added += 1
    return added


def seed_default_routing(s) -> bool:
    """Seed the live routing row (id='active') if missing — with NO choices made
    (user decision 2026-07-06: "we are shipping with models, just no model is
    automatically set as default, honestly not even embed should be set, this is
    all quick setup or manual"). The catalog ships FULL; the selections ship EMPTY:
    Quick Setup (or a manual Set-as-default / Set-as-embedding) fills them.
    Idempotent (fresh installs only — an existing user's routing is never touched)."""
    if s.get(db.RoutingConfigRow, "active") is not None:
        return False
    s.add(db.RoutingConfigRow(id="active", is_active=True, position=0,
                              default_llm_id="",
                              default_embedding_id="",
                              default_embedding_model=""))
    return True


def seed_default_feature_prompts(s) -> int:
    """Seed the host's registered feature prompts (per-app data; merge by key).
    Insert-if-missing, plus the registered stale-heals: when the host lists a
    key's OLD seed system texts (configure_app_seed feature_prompt_heals) and
    the existing row's system byte-equals one of them, the row is refreshed
    from the CURRENT spec — a user-edited prompt (text ≠ any old seed) is
    never touched (the QC-43a exact-stale-value pattern, applied to prompts)."""
    existing = {r.key for r in s.query(db.FeaturePrompt.key).all()}
    heals = _APP.get("feature_prompt_heals") or {}
    for key, old_texts in heals.items():
        spec = app_feature_prompts().get(key)
        if not spec or key not in existing:
            continue
        row = s.get(db.FeaturePrompt, key)
        if row is None or row.system not in old_texts:
            continue
        # Refresh ONLY the fields a seed revision carries (system + its schema
        # mirror) — a user who edited user_template while keeping the seed
        # system must not lose that edit to a heal.
        row.system = str(spec.get("system") or "")
        row.json_schema = str(spec.get("json_schema") or "")
    added = 0
    for key, spec in app_feature_prompts().items():
        if key in existing:
            continue
        s.add(db.FeaturePrompt(
            key=key, feature=str(spec.get("feature") or key), system=str(spec.get("system") or ""),
            user_template=str(spec.get("user_template") or ""), temperature=float(spec.get("temperature", 0.7)),
            think=bool(spec.get("think", False)), built_in=True, max_tokens=int(spec.get("max_tokens", 0) or 0),
            json_mode=bool(spec.get("json_mode", False)),
            json_schema=str(spec.get("json_schema") or ""), top_p=spec.get("top_p"),
            reasoning_effort=str(spec.get("reasoning_effort", "") or ""),
            label=str(spec.get("label") or ""), description=str(spec.get("description") or ""),
            subgroup=str(spec.get("group") or ""),
        ))
        added += 1
    return added


def seed_llm(s=None) -> None:
    """Run every LLM seeder + commit. Opens its own session when none is given."""
    own = s is None
    if own:
        s = db.session()
    try:
        seed_default_providers(s)
        seed_default_routing(s)
        seed_default_catalog(s)
        seed_default_pricing(s)
        seed_default_switch_presets(s)
        seed_default_engine_presets(s)
        seed_default_task_kinds(s)
        seed_default_feature_task_kinds(s)
        seed_default_taskkind_presets(s)
        seed_default_runner_binaries(s)
        seed_default_runner_settings(s)
        seed_default_knobs(s)
        seed_default_class_picks(s)
        seed_default_class_tunes(s)
        seed_default_embed_templates(s)
        seed_default_feature_prompts(s)
        # The registered per-app extras (see configure_app_seed) — insert-if-missing,
        # so user edits / Quick-tune saves are never clobbered by a reseed.
        if _APP.get("model_catalog_extra"):
            seed_extra_catalog(s, _APP["model_catalog_extra"])
        if _APP.get("model_tunes_seed") and _APP.get("hw_key_fn"):
            seed_model_tunes_if_missing(s, _APP["hw_key_fn"](), _APP["model_tunes_seed"])
        if _APP.get("test_samples"):
            # The store owns the one fill-if-empty implementation (lazy import —
            # seed is imported by stores' API-model siblings; keep boot order free).
            from . import stores as _stores
            _stores.get_test_sample_store().seed_fill(s, _APP["test_samples"])
        s.commit()
    finally:
        if own:
            s.close()
