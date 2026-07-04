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
                       feature_task_kinds=None) -> None:
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
DEFAULT_PROVIDERS: list[dict] = [
    {"id": "local-llamacpp", "name": "Built-in (llama.cpp)",
     "provider_type": "local-llamacpp", "base_url": "http://127.0.0.1:8080/v1", "local": True},
    {"id": "openai-compat-local", "name": "OpenAI-compatible (local)",
     "provider_type": "openai-compat", "base_url": "http://localhost:11434/v1", "local": True},
    {"id": "openai", "name": "OpenAI",
     "provider_type": "openai", "base_url": "https://api.openai.com/v1",
     "default_model": "gpt-4o-mini", "local": False},
    {"id": "claude", "name": "Claude (Anthropic)",
     "provider_type": "openai-compat", "base_url": "https://api.anthropic.com/v1",
     "default_model": "claude-haiku-4-5", "local": False},
    {"id": "gemini", "name": "Gemini (Google)",
     "provider_type": "openai-compat",
     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
     "default_model": "gemini-2.5-flash", "local": False},
    {"id": "deepseek", "name": "DeepSeek",
     "provider_type": "deepseek", "base_url": "https://api.deepseek.com/v1",
     "default_model": "deepseek-chat", "local": False},
    {"id": "openrouter", "name": "OpenRouter (aggregator)",
     "provider_type": "openrouter", "base_url": "https://openrouter.ai/api/v1", "local": False},
]

# The downloadable catalog spans the FULL hardware range (CPU/8 GB floor → no
# upper cap) with family diversity (Qwen · Gemma · Mistral · GLM · Llama). Repo
# ids + licenses web-verified 2026-06-27 (HF + vendor announcements): Gemma 4
# ships Apache-2.0 (NOT the old Gemma Terms — only Gemma 4 is seedable);
# GLM-4.5-Air is MIT; Mistral-Small-3.2 + every Qwen3.x + nomic-embed are
# Apache-2.0; Llama-4 is the use-limited Llama Community license → carried as a
# FLAG, never a default. `min_ram_mb` = the RAM floor (dense: weights-in-RAM +
# overhead, matching the 9B→~10 GB / 14B→14 GB pattern; MoE: the FULL model in
# RAM since experts offload to RAM). `min_vram_mb` = the load-time VRAM band (MoE
# = active-path + KV, much smaller than total). The tuning UI (#20) measures real.
DEFAULT_CATALOG: list[dict] = [
    {"id": "qwen3.5-9b-q4_k_m", "name": "Qwen3.5 9B · Q4_K_M",
     "hf_repo": "unsloth/Qwen3.5-9B-GGUF", "quant": "Q4_K_M", "total_params": "9B",
     "min_ram_mb": 10000, "min_vram_mb": 7500, "tier": "mid", "license": "Apache-2.0", "position": 0,
     "quality_rank": 30, "description": "Fast 9B dense — quick, re-askable chat and drafts (~55 t/s); runs on a small GPU."},
    {"id": "gemma-4-12b-q4_k_m", "name": "Gemma 4 12B · Q4_K_M",
     "hf_repo": "unsloth/gemma-4-12b-it-GGUF", "quant": "Q4_K_M", "total_params": "12B",
     "min_ram_mb": 13000, "min_vram_mb": 7000, "tier": "mid", "license": "Apache-2.0", "position": 1,
     "quality_rank": 28, "description": "Gemma 4 12B dense — strong instruction-following; fits a ~7 GB GPU."},
    {"id": "qwen3-14b-q4_k_m", "name": "Qwen3 14B · Q4_K_M",
     "hf_repo": "unsloth/Qwen3-14B-GGUF", "quant": "Q4_K_M", "total_params": "14B",
     "min_ram_mb": 14000, "min_vram_mb": 11000, "tier": "mid", "license": "Apache-2.0", "position": 2,
     "quality_rank": 25, "description": "14B dense — reliable general + structured work when VRAM is tight."},
    {"id": "mistral-small-3.2-24b-q4_k_m", "name": "Mistral Small 3.2 24B · Q4_K_M",
     "hf_repo": "unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF", "quant": "Q4_K_M",
     "total_params": "24B", "min_ram_mb": 20000, "min_vram_mb": 14000, "tier": "high",
     "license": "Apache-2.0", "position": 3,
     "quality_rank": 22, "description": "Mistral Small 3.2 24B — excellent structured / JSON extraction (function-calling strength)."},
    {"id": "qwen3.6-27b-mtp-q4_k_m", "name": "Qwen3.6 27B (MTP) · Q4_K_M",
     "hf_repo": "unsloth/Qwen3.6-27B-MTP-GGUF", "quant": "Q4_K_M", "total_params": "27B", "mtp": True,
     "min_ram_mb": 26000, "min_vram_mb": 20000, "tier": "high", "license": "Apache-2.0", "position": 4,
     "quality_rank": 12, "description": "Qwen3.6 27B dense — the best dense model that runs FULLY on a ~20 GB+ GPU (no offload): fluent long-form prose + strong reasoning."},
    {"id": "gemma-4-31b-it", "name": "Gemma 4 31B · Q4_K_M",
     "hf_repo": "unsloth/gemma-4-31b-it-GGUF", "quant": "Q4_K_M", "total_params": "31B",
     "min_ram_mb": 26000, "min_vram_mb": 22000, "tier": "high", "license": "Apache-2.0", "position": 5,
     "quality_rank": 20, "description": "Gemma 4 31B dense — an alternative high-tier voice; needs ~22 GB VRAM."},
    {"id": "qwen3.6-35b-a3b-mtp", "name": "Qwen3.6 35B-A3B (MTP)",
     "hf_repo": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF", "quant": "UD-Q4_K_XL",
     "total_params": "35B", "active_params": "3.6B", "mtp": True, "type": "moe",
     "min_vram_mb": 6000, "min_ram_mb": 32000, "tier": "low-vram-moe", "license": "Apache-2.0", "position": 6,
     "quality_rank": 10, "description": "Qwen3.6 35B-A3B MoE — ~32B-class quality that runs on a small GPU + system RAM via CPU expert offload; the smart all-round default."},
    {"id": "glm-4.5-air", "name": "GLM-4.5-Air (106B-A12B MoE)",
     "hf_repo": "unsloth/GLM-4.5-Air-GGUF", "quant": "UD-Q4_K_XL",
     "total_params": "106B", "active_params": "12B", "type": "moe",
     "min_vram_mb": 12000, "min_ram_mb": 64000, "tier": "high-ram", "license": "MIT", "position": 7,
     "quality_rank": 8, "description": "GLM-4.5-Air (106B-A12B MoE) — top structured extraction + reasoning on a high-RAM rig (64 GB+ RAM)."},
    {"id": "llama-4-scout", "name": "Llama 4 Scout (109B-A17B MoE)",
     "hf_repo": "unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF", "quant": "Q4_K_M",
     "total_params": "109B", "active_params": "17B", "type": "moe",
     "min_vram_mb": 12000, "min_ram_mb": 64000, "tier": "high-ram", "license": "Llama-Community", "position": 8,
     "quality_rank": 40, "description": "Llama 4 Scout (109B-A17B MoE) — large MoE for high-RAM rigs; use-limited license (never an auto-default)."},
    {"id": "qwen3-235b-a22b", "name": "Qwen3 235B-A22B (2507 MoE)",
     "hf_repo": "unsloth/Qwen3-235B-A22B-Instruct-2507-GGUF", "quant": "UD-Q2_K_XL",
     "total_params": "235B", "active_params": "22B", "type": "moe",
     "min_vram_mb": 16000, "min_ram_mb": 96000, "tier": "high-ram", "license": "Apache-2.0", "position": 9,
     "quality_rank": 5, "description": "Qwen3-235B-A22B MoE — near-cloud quality on a workstation (96 GB+ RAM)."},
    {"id": "nomic-embed-text", "name": "Nomic Embed Text v1.5",
     "hf_repo": "nomic-ai/nomic-embed-text-v1.5-GGUF", "quant": "Q4_K_M", "total_params": "137M",
     "min_vram_mb": 1000, "min_ram_mb": 4000, "tier": "cpu", "license": "Apache-2.0", "position": 10,
     "pooling": "mean",
     "quality_rank": 100, "description": "Local embedding model (~137M) — builds the RAG / semantic-search index; CPU-fine. (The embed model, not an LLM pick.)"},
    # Box-tested tier ladder (2026-07-04, user's own box; feeds model-surface #104) — the DENSE
    # picks the existing high tier lacks (it is MoE-heavy): dense beats MoE on time-to-first-token
    # for prompt-heavy work. Qwen3-72B was dropped (not an official Qwen model; only community
    # upscales exist). HF repos web-verified 2026-07-04 (upstream-audit rule).
    {"id": "gemma-4-12b-q8_0", "name": "Gemma 4 12B · Q8_0",
     "hf_repo": "unsloth/gemma-4-12b-it-GGUF", "quant": "Q8_0", "total_params": "12B",
     "min_ram_mb": 16000, "min_vram_mb": 13000, "tier": "high", "license": "Apache-2.0", "position": 11,
     "quality_rank": 26, "description": "Gemma 4 12B at Q8_0 — higher-fidelity weights than the Q4; a full-GPU pick for a ~14 GB card (box-tested tier ladder)."},
    {"id": "qwen3-32b-q4_k_m", "name": "Qwen3 32B · Q4_K_M",
     "hf_repo": "Qwen/Qwen3-32B-GGUF", "quant": "Q4_K_M", "total_params": "32B",
     "min_ram_mb": 24000, "min_vram_mb": 20000, "tier": "high", "license": "Apache-2.0", "position": 12,
     "quality_rank": 14, "description": "Qwen3 32B dense — strong reasoning + prose that runs fully on a ~20 GB GPU; box-tested for prompt-heavy work (dense beats MoE on time-to-first-token)."},
    {"id": "llama-3.1-70b-q3_k_m", "name": "Llama 3.1 70B Instruct · Q3_K_M",
     "hf_repo": "bartowski/Meta-Llama-3.1-70B-Instruct-GGUF", "quant": "Q3_K_M", "total_params": "70B",
     "min_ram_mb": 40000, "min_vram_mb": 32000, "tier": "high-ram", "license": "Llama-Community", "position": 13,
     "quality_rank": 16, "description": "Llama 3.1 70B dense (Q3_K_M, ~34 GB) — a dense 70B for a ~32 GB rig (box-tested); use-limited Llama license (never an auto-default)."},
    {"id": "llama-3.1-70b-q6_k", "name": "Llama 3.1 70B Instruct · Q6_K",
     "hf_repo": "bartowski/Meta-Llama-3.1-70B-Instruct-GGUF", "quant": "Q6_K", "total_params": "70B",
     "min_ram_mb": 64000, "min_vram_mb": 58000, "tier": "high-ram", "license": "Llama-Community", "position": 14,
     "quality_rank": 13, "description": "Llama 3.1 70B dense (Q6_K, ~58 GB, split GGUF) — near-lossless dense 70B for a 64 GB rig (box-tested); use-limited Llama license."},
    {"id": "qwen3-embedding-0.6b", "name": "Qwen3 Embedding 0.6B",
     "hf_repo": "Qwen/Qwen3-Embedding-0.6B-GGUF", "quant": "Q8_0", "total_params": "0.6B",
     "min_vram_mb": 1500, "min_ram_mb": 4000, "tier": "cpu", "license": "Apache-2.0", "position": 15,
     "pooling": "last",
     "quality_rank": 100, "description": "Qwen3 Embedding 0.6B — the default local embedding model (stronger multilingual / MTEB than nomic, still tiny ~0.6 GB); LAST-token pooling. Builds the RAG / semantic-search index."},
]

# (Per-model switch overrides — the `model_switches` table — were DROPPED: the
# dense/moe TYPE rules live ONCE on the type presets below. MTP is NOT a preset — it
# is an opt-in/measurable `spec_type` knob since Phase 3, never auto-applied.)

# Capability/type switch presets — the switch BASE layer (design §6.5), the
# seeded-editable replacement for the hardcoded runner-manifest `flagPresets`,
# translated into `Overrides` field names. `applies_to`: `all` (every model) |
# `moe`/`dense` (matches `model_catalog.type`). (The `mtp` applies-to + preset were
# dropped 2026-07-03 Phase 3 — MTP is opt-in/measurable, not auto-applied.)
# Resolved + layered by `switch_resolve.resolve_model_switches`. (`-ngl` is NOT
# here — it's a computed fit knob, not a constant.)
DEFAULT_SWITCH_PRESETS: list[dict] = [
    {"id": "base", "label": "Base (every model)", "applies_to": "all", "position": 0,
     "switches": {"flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0", "mlock": "true",
                  "context_shift": "true", "cache_reuse": "256"}},
    {"id": "moe", "label": "MoE (mixture-of-experts)", "applies_to": "moe", "position": 1,
     # ONLY no_mmap is genuinely MoE-specific; the spec_type default (none) lives ONCE in
     # knob_catalog — no duplicate here (the phase's own "one source" rule, 2026-07-03 Phase 3).
     "switches": {"no_mmap": "true"}},
    # (No "mtp" switch-preset — removed 2026-07-03 Phase 3. MTP is opt-in/measurable,
    # never auto-applied; when the user enables it, spec_type=draft-mtp + spec_n_max=3
    # come from the knob_catalog defaults, so those values live in ONE place, not here.)
]

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
]

# Knob catalog — metadata that turns a raw switch/sampler key into a friendly
# KnobGrid input. Plane 1 = load-time engine switch (maps to a process.Overrides
# field); Plane 2 = per-request sampler (maps to the dispatch `extra`). `options`
# (inline) become enum rows in knob_option. C1: data only, no code per param.
_ENUM_CACHE = [{"value": "f16", "label": "f16 (full)"}, {"value": "q8_0", "label": "q8_0"}, {"value": "q4_0", "label": "q4_0"}]
# Defaults + behaviour notes are cited from llama.cpp `tools/server/README.md`
# (fetched 2026-06-29) — see docs/plans/2026-06-29-knob-catalog-expansion.md. `tier`
# = common|advanced drives the UI checklist split (common shown, advanced behind an
# expander). Order within each plane is common-first (the seeder sets position=i).
DEFAULT_KNOBS: list[dict] = [
    # ── Plane 1 — load switches: COMMON (fit & memory) ──
    {"flag_name": "ctx_len", "label": "Context size", "kind": "int", "plane": 1, "default_value": "4096", "tier": "common",
     "help": "Maximum tokens the model can read + write at once. Bigger = more memory (the KV cache grows with it). Set it to fit your longest task."},
    {"flag_name": "flash_attn", "label": "Flash attention", "kind": "enum", "plane": 1, "default_value": "on", "tier": "common",
     "help": "Faster attention using less memory. Leave On unless a specific model misbehaves with it.", "options": [{"value": "on", "label": "On"}, {"value": "off", "label": "Off"}, {"value": "auto", "label": "Auto"}]},
    {"flag_name": "cache_type_k", "label": "KV cache type (K)", "kind": "enum", "plane": 1, "default_value": "q8_0", "tier": "common",
     "help": "Compress the K side of the KV cache to save VRAM. q8_0 is near-lossless (safe default); q4_0 saves more but can cost quality.", "options": _ENUM_CACHE},
    {"flag_name": "cache_type_v", "label": "KV cache type (V)", "kind": "enum", "plane": 1, "default_value": "q8_0", "tier": "common",
     "help": "Compress the V side of the KV cache to save VRAM. q8_0 is near-lossless (safe default).", "options": _ENUM_CACHE},
    {"flag_name": "n_cpu_moe", "label": "CPU MoE layers", "kind": "int", "plane": 1, "applies_to": "moe", "tier": "common",
     "help": "Expert layers to run on CPU — frees VRAM (MoE only). Auto-fit sets it; pin the fast value here."},
    # ── Plane 1 — load switches: ADVANCED ──
    {"flag_name": "mlock", "label": "Lock in RAM", "kind": "bool", "plane": 1, "default_value": "true", "tier": "advanced",
     "help": "Keep the model locked in RAM so the OS can't swap it out (steadier speed). Turn off if RAM is tight."},
    {"flag_name": "no_mmap", "label": "Load into RAM", "kind": "bool", "plane": 1, "applies_to": "moe", "tier": "advanced",
     "help": "Read the whole model into RAM instead of memory-mapping it. Needed for MoE CPU-offload; otherwise leave off."},
    {"flag_name": "no_kv_offload", "label": "KV in system RAM", "kind": "bool", "plane": 1, "tier": "advanced",
     "help": "Keep the KV cache in system RAM instead of VRAM — frees VRAM but is slower."},
    {"flag_name": "batch_size", "label": "Batch size", "kind": "int", "plane": 1, "default_value": "2048", "tier": "advanced",
     "help": "How many prompt tokens are processed together (throughput vs memory)."},
    {"flag_name": "ubatch_size", "label": "Micro-batch size", "kind": "int", "plane": 1, "default_value": "512", "tier": "advanced",
     "help": "Physical batch — the chunk actually run per step (llama.cpp default 512). Lower it if prompt processing runs out of memory."},
    {"flag_name": "threads", "label": "CPU threads", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "CPU threads for generation (drive MoE CPU experts). Default = physical cores."},
    {"flag_name": "threads_batch", "label": "CPU threads (prompt)", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "CPU threads for prompt processing. Default = same as CPU threads."},
    {"flag_name": "parallel", "label": "Parallel slots", "kind": "int", "plane": 1, "default_value": "1", "tier": "advanced",
     "help": "Concurrent server slots (used by batch sweeps / Compare)."},
    {"flag_name": "cont_batching", "label": "Continuous batching", "kind": "bool", "plane": 1, "default_value": "true", "tier": "advanced",
     "help": "Overlap requests for throughput. On by default in llama.cpp; only turn it off to debug."},
    {"flag_name": "context_shift", "label": "Context shift", "kind": "bool", "plane": 1, "default_value": "true", "tier": "advanced",
     "help": "When the context fills, drop the oldest tokens and shift the KV cache instead of re-reading the whole prompt — keeps long generations + edits fast. On by default; llama.cpp auto-disables it for sliding-window models (e.g. Gemma)."},
    {"flag_name": "cache_reuse", "label": "KV prefix reuse", "kind": "int", "plane": 1, "default_value": "0", "tier": "advanced",
     "help": "Reuse a shared prompt prefix's KV cache across calls to skip re-processing it (0 = off)."},
    {"flag_name": "spec_type", "label": "Speculative decode", "kind": "enum", "plane": 1, "default_value": "none", "tier": "advanced",
     "help": "Draft-model speculative decode. MTP GGUF only; gains are machine-dependent — measure.",
     "options": [{"value": "none", "label": "Off"}, {"value": "draft-mtp", "label": "MTP draft"}, {"value": "ngram-mod", "label": "N-gram"}]},
    {"flag_name": "spec_n_max", "label": "Spec draft tokens", "kind": "int", "plane": 1, "default_value": "3", "tier": "advanced",
     "help": "How many tokens the draft proposes per step."},
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


# ── seeders (operate on a passed session, no commit) ──────────────────────────
def seed_default_providers(s) -> int:
    existing = {r.id for r in s.query(db.LlmProvider).all()}
    pos = s.query(db.LlmProvider).count()
    added = 0
    for p in DEFAULT_PROVIDERS:
        if p["id"] in existing:
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


def seed_default_catalog(s) -> int:
    existing = {r.id for r in s.query(db.ModelCatalog.id).all()}
    added = 0
    for c in DEFAULT_CATALOG:
        if c["id"] in existing:
            continue
        s.add(db.ModelCatalog(
            id=c["id"], name=str(c.get("name") or ""), hf_repo=str(c.get("hf_repo") or ""),
            quant=str(c.get("quant") or ""), mmproj=c.get("mmproj"),
            total_params=str(c.get("total_params") or ""), active_params=str(c.get("active_params") or ""),
            mtp=bool(c.get("mtp") or False), type=str(c.get("type") or "dense"),
            min_vram_mb=c.get("min_vram_mb"), min_ram_mb=c.get("min_ram_mb"),
            tier=str(c.get("tier") or "mid"), license=str(c.get("license") or ""),
            use_limited=_use_limited(str(c.get("license") or "")), pooling=str(c.get("pooling") or ""),
            quality_rank=int(c.get("quality_rank") or 100), description=str(c.get("description") or ""),
            built_in=True, position=int(c.get("position") or 0),
        ))
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


def seed_default_switch_presets(s) -> int:
    """Seed the capability/type switch presets (base + moe) + their flag rows.
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
    2026-06-29 lab+preset model) + their FK switch/sampler children. Flush each
    parent before its children (host session: autoflush off + FK on — the
    switch-preset seeder gotcha). Per-app data via `app_engine_presets()`."""
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
            ngl_override=p.get("ngl_override"), n_cpu_moe_override=p.get("n_cpu_moe_override"),
            position=int(p.get("position") or 0), built_in=True))
        s.flush()  # parent in the DB before its FK children
        for fname, fval in (p.get("switches") or {}).items():
            s.add(db.EnginePresetSwitch(preset_id=p["id"], flag_name=fname, flag_value=str(fval)))
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
    DEFAULT_TASK_KINDS + set its task→preset to the app's factory assignment. A CUSTOM
    task has no factory to reset to → ValueError (the API maps it to 400). Edges: if the
    task has no factory preset entry, or that preset was user-deleted, the task→preset row
    is CLEARED (falls back to the global default) rather than left stale / FK-violating."""
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
    its FK children (host session: autoflush off + FK on)."""
    existing = {r.flag_name for r in s.query(db.KnobCatalog.flag_name).all()}
    added = 0
    for i, k in enumerate(DEFAULT_KNOBS):
        if k["flag_name"] in existing:
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
    """Seed the live routing row (id='active') if missing. The default EMBEDDING points at the bundled
    llama.cpp runner (`local-llamacpp`) + the co-resident qwen3-embedding-0.6b embed (P3; #120 made it the default over nomic) so local RAG works out of
    the box — the runner pins that model resident and serves /v1/embeddings for it by id. The default
    LLM stays the local OpenAI-compatible provider (Ollama); repointing the LLM default at the bundled
    runner is model-surface #107's QuickSetup scope, not P3. Idempotent (fresh installs only — an
    existing user's routing choice is never overwritten)."""
    if s.get(db.RoutingConfigRow, "active") is not None:
        return False
    s.add(db.RoutingConfigRow(id="active", is_active=True, position=0,
                              default_llm_id="openai-compat-local",
                              default_embedding_id="local-llamacpp",
                              default_embedding_model="qwen3-embedding-0.6b"))
    return True


def seed_default_feature_prompts(s) -> int:
    """Seed the host's registered feature prompts (per-app data; merge by key)."""
    existing = {r.key for r in s.query(db.FeaturePrompt.key).all()}
    added = 0
    for key, spec in app_feature_prompts().items():
        if key in existing:
            continue
        s.add(db.FeaturePrompt(
            key=key, feature=str(spec.get("feature") or key), system=str(spec.get("system") or ""),
            user_template=str(spec.get("user_template") or ""), temperature=float(spec.get("temperature", 0.7)),
            think=bool(spec.get("think", False)), built_in=True, max_tokens=int(spec.get("max_tokens", 0) or 0),
            json_mode=bool(spec.get("json_mode", False)), top_p=spec.get("top_p"),
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
        seed_default_feature_prompts(s)
        s.commit()
    finally:
        if own:
            s.close()
