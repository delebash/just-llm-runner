# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared LLM seed data + seeders + the per-app registration hook.

SHARED seed data (identical for every app, shipped here): default providers, the
downloadable model catalog, per-model switches, recommendations, the job set, and
the live routing row. PER-APP seed data (the only thing that differs between apps)
is registered by the host via `configure_app_seed`: its feature catalog, its
feature→job map, and its feature prompts. `seed_llm` runs every seeder; stores'
`reset_to_factory` re-run individual seeders. All seeders merge-by-key and never
clobber user edits (the `seed_default_providers` pattern).
"""

from __future__ import annotations

from . import db
from ..runner.config import DEFAULT_BINARIES, DEFAULT_PINNED_BUILD, DEFAULT_SAFETY_MARGIN_MB

# ── per-app registration (the ONLY per-app inputs) ────────────────────────────
_APP: dict = {"feature_catalog": [], "feature_jobs": [], "feature_prompts": {}}


def configure_app_seed(*, feature_catalog=None, feature_jobs=None, feature_prompts=None) -> None:
    """The host registers its feature DATA once at boot (install_llm does this):
    `feature_catalog` (list of FeatureCatalogEntry), `feature_jobs` (list of
    {feature_key, job_id}), `feature_prompts` (dict key→spec)."""
    if feature_catalog is not None:
        _APP["feature_catalog"] = list(feature_catalog)
    if feature_jobs is not None:
        _APP["feature_jobs"] = list(feature_jobs)
    if feature_prompts is not None:
        _APP["feature_prompts"] = dict(feature_prompts)


def app_feature_catalog() -> list:
    """The host's feature catalog (FeatureCatalogEntry list) — get_catalog for the routing router."""
    return _APP["feature_catalog"]


def app_feature_jobs() -> list[dict]:
    return _APP["feature_jobs"]


def app_feature_prompts() -> dict:
    return _APP["feature_prompts"]


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
     "min_ram_mb": 10000, "min_vram_mb": 7500, "tier": "mid", "license": "Apache-2.0", "position": 0},
    {"id": "gemma-4-12b-q4_k_m", "name": "Gemma 4 12B · Q4_K_M",
     "hf_repo": "unsloth/gemma-4-12b-it-GGUF", "quant": "Q4_K_M", "total_params": "12B",
     "min_ram_mb": 13000, "min_vram_mb": 7000, "tier": "mid", "license": "Apache-2.0", "position": 1},
    {"id": "qwen3-14b-q4_k_m", "name": "Qwen3 14B · Q4_K_M",
     "hf_repo": "unsloth/Qwen3-14B-GGUF", "quant": "Q4_K_M", "total_params": "14B",
     "min_ram_mb": 14000, "min_vram_mb": 11000, "tier": "mid", "license": "Apache-2.0", "position": 2},
    {"id": "mistral-small-3.2-24b-q4_k_m", "name": "Mistral Small 3.2 24B · Q4_K_M",
     "hf_repo": "unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF", "quant": "Q4_K_M",
     "total_params": "24B", "min_ram_mb": 20000, "min_vram_mb": 14000, "tier": "high",
     "license": "Apache-2.0", "position": 3},
    {"id": "qwen3.6-27b-mtp-q4_k_m", "name": "Qwen3.6 27B (MTP) · Q4_K_M",
     "hf_repo": "unsloth/Qwen3.6-27B-MTP-GGUF", "quant": "Q4_K_M", "total_params": "27B", "mtp": True,
     "min_ram_mb": 26000, "min_vram_mb": 20000, "tier": "high", "license": "Apache-2.0", "position": 4},
    {"id": "gemma-4-31b-it", "name": "Gemma 4 31B · Q4_K_M",
     "hf_repo": "unsloth/gemma-4-31b-it-GGUF", "quant": "Q4_K_M", "total_params": "31B",
     "min_ram_mb": 26000, "min_vram_mb": 22000, "tier": "high", "license": "Apache-2.0", "position": 5},
    {"id": "qwen3.6-35b-a3b-mtp", "name": "Qwen3.6 35B-A3B (MTP)",
     "hf_repo": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF", "quant": "UD-Q4_K_XL",
     "total_params": "35B", "active_params": "3.6B", "mtp": True, "type": "moe",
     "min_vram_mb": 6000, "min_ram_mb": 32000, "tier": "low-vram-moe", "license": "Apache-2.0", "position": 6},
    {"id": "glm-4.5-air", "name": "GLM-4.5-Air (106B-A12B MoE)",
     "hf_repo": "unsloth/GLM-4.5-Air-GGUF", "quant": "UD-Q4_K_XL",
     "total_params": "106B", "active_params": "12B", "type": "moe",
     "min_vram_mb": 12000, "min_ram_mb": 64000, "tier": "high-ram", "license": "MIT", "position": 7},
    {"id": "llama-4-scout", "name": "Llama 4 Scout (109B-A17B MoE)",
     "hf_repo": "unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF", "quant": "Q4_K_M",
     "total_params": "109B", "active_params": "17B", "type": "moe",
     "min_vram_mb": 12000, "min_ram_mb": 64000, "tier": "high-ram", "license": "Llama-Community", "position": 8},
    {"id": "qwen3-235b-a22b", "name": "Qwen3 235B-A22B (2507 MoE)",
     "hf_repo": "unsloth/Qwen3-235B-A22B-Instruct-2507-GGUF", "quant": "UD-Q2_K_XL",
     "total_params": "235B", "active_params": "22B", "type": "moe",
     "min_vram_mb": 16000, "min_ram_mb": 96000, "tier": "high-ram", "license": "Apache-2.0", "position": 9},
    {"id": "nomic-embed-text", "name": "Nomic Embed Text v1.5",
     "hf_repo": "nomic-ai/nomic-embed-text-v1.5-GGUF", "quant": "Q4_K_M", "total_params": "137M",
     "min_vram_mb": 1000, "min_ram_mb": 4000, "tier": "cpu", "license": "Apache-2.0", "position": 10},
]

# (Per-model switch overrides — the `model_switches` table — were DROPPED per the
# D9 ruling: switches belong to the Profile/job [`job_route_switches`], and the
# MoE/MTP rules live ONCE on the type presets below.)

# Capability/type switch presets — the switch BASE layer (design §6.5), the
# seeded-editable replacement for the hardcoded runner-manifest `flagPresets`,
# translated into `Overrides` field names. `applies_to`: `all` (every model) |
# `moe`/`dense` (matches `model_catalog.type`) | `mtp` (matches `mtp=true`).
# Resolved + layered by `switch_resolve.resolve_model_switches`. (`-ngl` is NOT
# here — it's a computed fit knob, not a constant.)
DEFAULT_SWITCH_PRESETS: list[dict] = [
    {"id": "base", "label": "Base (every model)", "applies_to": "all", "position": 0,
     "switches": {"flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0", "mlock": "true"}},
    {"id": "moe", "label": "MoE (mixture-of-experts)", "applies_to": "moe", "position": 1,
     "switches": {"spec_type": "none", "no_mmap": "true"}},
    {"id": "mtp", "label": "Speculative decode (MTP)", "applies_to": "mtp", "position": 2,
     "switches": {"spec_type": "draft-mtp", "spec_n_max": "3"}},
]

# Cited per-job picks, one row per (model, job). `rank` = priority (lower wins).
# Job ids are the seeded set (chat/prose/extraction/analysis). All model_ids must
# exist in DEFAULT_CATALOG above. Editable (#25); MEASURED tok/s still pending (#28).
DEFAULT_RECOMMENDATIONS: list[dict] = [
    # chat — fast, grounded interactive answers
    {"model_id": "qwen3.5-9b-q4_k_m", "job": "chat", "rank": 10, "why": "Smallest dense — snappy interactive chat (the Fast default)."},
    {"model_id": "gemma-4-12b-q4_k_m", "job": "chat", "rank": 15, "why": "Gemma 4 12B — a second family at ~7 GB VRAM; strong instruction-following."},
    {"model_id": "qwen3.6-27b-mtp-q4_k_m", "job": "chat", "rank": 20, "why": "27B (MTP) — richest chat when VRAM allows (~20 GB+)."},
    # prose — creative drafting and rewriting
    {"model_id": "qwen3-235b-a22b", "job": "prose", "rank": 3, "why": "Qwen3-235B — best-that-fits prose on a high-RAM rig (96 GB+); near-cloud quality."},
    {"model_id": "qwen3.6-27b-mtp-q4_k_m", "job": "prose", "rank": 10, "why": "Qwen3.6 27B — the local prose ceiling; fluent, coherent long-form."},
    {"model_id": "gemma-4-31b-it", "job": "prose", "rank": 20, "why": "Gemma 4 31B — an alternative high-tier prose voice (~22 GB VRAM)."},
    {"model_id": "qwen3.5-9b-q4_k_m", "job": "prose", "rank": 30, "why": "9B dense — fast drafts and rewrites on small cards."},
    # extraction — structured facts / JSON (think-OFF)
    {"model_id": "glm-4.5-air", "job": "extraction", "rank": 3, "why": "GLM-4.5-Air — top structured extraction on a high-RAM rig; strong JSON adherence."},
    {"model_id": "mistral-small-3.2-24b-q4_k_m", "job": "extraction", "rank": 5, "why": "Mistral Small 3.2 24B — excellent structured/JSON extraction (function-calling strength)."},
    {"model_id": "qwen3.6-35b-a3b-mtp", "job": "extraction", "rank": 10, "why": "35B-A3B MoE — strong structured extraction; runs at floor (8 GB VRAM + 32 GB RAM) via CPU expert offload."},
    {"model_id": "qwen3-14b-q4_k_m", "job": "extraction", "rank": 20, "why": "14B dense — reliable structured extraction when VRAM is tight."},
    # analysis — careful reasoning and critique (think-ON, capped)
    {"model_id": "qwen3-235b-a22b", "job": "analysis", "rank": 5, "why": "Qwen3-235B — deepest reasoning/critique on a high-RAM rig (96 GB+)."},
    {"model_id": "qwen3.6-27b-mtp-q4_k_m", "job": "analysis", "rank": 10, "why": "27B (MTP) — best local analysis accuracy at the high tier (~20 GB+ VRAM)."},
    {"model_id": "qwen3.6-35b-a3b-mtp", "job": "analysis", "rank": 15, "why": "35B-A3B MoE — capable analysis; runs at floor (8 GB VRAM + 32 GB RAM) via offload."},
    {"model_id": "qwen3-14b-q4_k_m", "job": "analysis", "rank": 20, "why": "14B dense — solid analysis that fits ≥11 GB VRAM."},
]

DEFAULT_JOBS: list[dict] = [
    {"id": "chat", "label": "Chat",
     "description": "Conversational Q&A over your content — fast, grounded answers.", "position": 0},
    {"id": "prose", "label": "Prose",
     "description": "Creative drafting and rewriting — text, descriptions, ideas, marketing copy.", "position": 1},
    {"id": "extraction", "label": "Extraction",
     "description": "Pulling structured facts out of the text — entities, beats, outlines, relationships.", "position": 2},
    {"id": "analysis", "label": "Analysis",
     "description": "Careful reasoning and critique — plot holes, structure, reactions, drift.", "position": 3},
]


# Runner config (was runner-manifest.json). The binary list + scalars are
# imported from the runner package (ONE source of truth; the standalone runner
# also reads them via runner.config.default_config) and seeded built_in.
DEFAULT_RUNNER_SETTINGS: list[dict] = [
    {"key": "pinned_build", "value": DEFAULT_PINNED_BUILD},
    {"key": "safety_margin_mb", "value": str(DEFAULT_SAFETY_MARGIN_MB)},
]

# Knob catalog — metadata that turns a raw switch/sampler key into a friendly
# KnobGrid input. Plane 1 = load-time engine switch (maps to a process.Overrides
# field); Plane 2 = per-request sampler (maps to the dispatch `extra`). `options`
# (inline) become enum rows in knob_option. C1: data only, no code per param.
_ENUM_CACHE = [{"value": "f16", "label": "f16 (full)"}, {"value": "q8_0", "label": "q8_0"}, {"value": "q4_0", "label": "q4_0"}]
DEFAULT_KNOBS: list[dict] = [
    # ── Plane 1 — load switches ──
    {"flag_name": "n_cpu_moe", "label": "CPU MoE layers", "kind": "int", "plane": 1, "applies_to": "moe",
     "help": "Expert layers to run on CPU — frees VRAM (MoE only). Auto-fit sets it; pin the fast value here."},
    {"flag_name": "ctx_len", "label": "Context size", "kind": "int", "plane": 1, "default_value": "4096",
     "help": "Max context tokens. The KV cache grows with this — bigger = more VRAM."},
    {"flag_name": "flash_attn", "label": "Flash attention", "kind": "enum", "plane": 1, "default_value": "on",
     "help": "Faster attention + less KV VRAM.", "options": [{"value": "on", "label": "On"}, {"value": "off", "label": "Off"}, {"value": "auto", "label": "Auto"}]},
    {"flag_name": "cache_type_k", "label": "KV cache type (K)", "kind": "enum", "plane": 1, "default_value": "q8_0",
     "help": "Quantize the K cache to save VRAM (q8_0 is near-lossless).", "options": _ENUM_CACHE},
    {"flag_name": "cache_type_v", "label": "KV cache type (V)", "kind": "enum", "plane": 1, "default_value": "q8_0",
     "help": "Quantize the V cache to save VRAM.", "options": _ENUM_CACHE},
    {"flag_name": "no_mmap", "label": "Load into RAM", "kind": "bool", "plane": 1, "applies_to": "moe",
     "help": "Read all weights into RAM instead of mmap — needed for MoE CPU expert offload."},
    {"flag_name": "mlock", "label": "Lock in RAM", "kind": "bool", "plane": 1, "default_value": "true",
     "help": "Stop the OS swapping weights out (steadier latency)."},
    {"flag_name": "no_kv_offload", "label": "KV in system RAM", "kind": "bool", "plane": 1,
     "help": "Keep the KV cache in system RAM to free VRAM (slower)."},
    {"flag_name": "spec_type", "label": "Speculative decode", "kind": "enum", "plane": 1, "default_value": "none",
     "help": "Draft-model speculative decode. MTP GGUF only; gains are machine-dependent — measure.",
     "options": [{"value": "none", "label": "Off"}, {"value": "draft-mtp", "label": "MTP draft"}, {"value": "ngram-mod", "label": "N-gram"}]},
    {"flag_name": "spec_n_max", "label": "Spec draft tokens", "kind": "int", "plane": 1, "default_value": "3",
     "help": "How many tokens the draft proposes per step."},
    {"flag_name": "threads", "label": "CPU threads", "kind": "int", "plane": 1,
     "help": "Generation threads (drive MoE CPU experts). Default = physical cores."},
    {"flag_name": "batch_size", "label": "Batch size", "kind": "int", "plane": 1, "default_value": "2048",
     "help": "Prompt batch size (throughput vs memory)."},
    {"flag_name": "parallel", "label": "Parallel slots", "kind": "int", "plane": 1, "default_value": "1",
     "help": "Concurrent server slots (batch sweeps / Compare)."},
    # ── Plane 2 — per-request samplers ──
    {"flag_name": "temperature", "label": "Temperature", "kind": "float", "plane": 2, "default_value": "0.7",
     "help": "Randomness. Low (≈0) for extraction/JSON; higher (0.8–1.0) for prose."},
    {"flag_name": "top_p", "label": "Top-p", "kind": "float", "plane": 2, "default_value": "0.95",
     "help": "Nucleus sampling — keep the smallest set of tokens summing to this probability."},
    {"flag_name": "top_k", "label": "Top-k", "kind": "int", "plane": 2,
     "help": "Keep only the k most-likely tokens (0 = off)."},
    {"flag_name": "min_p", "label": "Min-p", "kind": "float", "plane": 2,
     "help": "Drop tokens below this fraction of the top token's probability."},
    {"flag_name": "repeat_penalty", "label": "Repeat penalty", "kind": "float", "plane": 2,
     "help": "Penalize recently-used tokens (>1 reduces repetition)."},
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
            built_in=True, position=int(c.get("position") or 0),
        ))
        added += 1
    return added


def seed_default_switch_presets(s) -> int:
    """Seed the capability/type switch presets (base/moe/mtp) + their flag rows.
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


def seed_default_recommendations(s) -> int:
    existing = {(r.model_id, r.job) for r in s.query(db.ModelRecommendation.model_id, db.ModelRecommendation.job).all()}
    added = 0
    for r in DEFAULT_RECOMMENDATIONS:
        if (r["model_id"], r["job"]) in existing:
            continue
        s.add(db.ModelRecommendation(model_id=r["model_id"], job=r["job"],
                                     rank=int(r.get("rank") or 100), why=str(r.get("why") or ""), built_in=True))
        added += 1
    return added


def seed_default_runner_binaries(s) -> int:
    existing = {(r.platform, r.gpu) for r in s.query(db.RunnerBinary.platform, db.RunnerBinary.gpu).all()}
    added = 0
    for i, b in enumerate(DEFAULT_BINARIES):
        if (b["platform"], b["gpu"]) in existing:
            continue
        s.add(db.RunnerBinary(
            platform=b["platform"], gpu=b["gpu"], source=str(b.get("source") or "github"),
            asset_url=b.get("asset_url"), image=b.get("image"), sha256=b.get("sha256"),
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
            position=i, built_in=True,
        ))
        s.flush()
        for j, opt in enumerate(k.get("options") or []):
            s.add(db.KnobOption(flag_name=k["flag_name"], value=str(opt["value"]),
                                label=str(opt.get("label") or opt["value"]), position=j, built_in=True))
        added += 1
    return added


def seed_default_jobs(s) -> int:
    existing = {r.id for r in s.query(db.Job.id).all()}
    added = 0
    for j in DEFAULT_JOBS:
        if j["id"] in existing:
            continue
        s.add(db.Job(id=j["id"], label=str(j.get("label") or ""), description=str(j.get("description") or ""),
                     position=int(j.get("position") or 0), built_in=True))
        added += 1
    return added


def seed_default_routing(s) -> bool:
    """Seed the live routing row (id='active') if missing — default LLM + embedding
    point at the local OpenAI-compatible provider (free local inference)."""
    if s.get(db.RoutingConfigRow, "active") is not None:
        return False
    s.add(db.RoutingConfigRow(id="active", is_active=True, position=0,
                              default_llm_id="openai-compat-local", default_embedding_id="openai-compat-local"))
    return True


def seed_default_feature_jobs(s) -> int:
    """Seed the host's registered feature→job map (per-app data)."""
    existing = {r.feature_key for r in s.query(db.FeatureJob.feature_key).all()}
    added = 0
    for fj in app_feature_jobs():
        if fj["feature_key"] in existing:
            continue
        s.add(db.FeatureJob(feature_key=fj["feature_key"], job_id=str(fj.get("job_id") or ""), built_in=True))
        added += 1
    return added


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
        seed_default_switch_presets(s)
        seed_default_recommendations(s)
        seed_default_runner_binaries(s)
        seed_default_runner_settings(s)
        seed_default_knobs(s)
        seed_default_jobs(s)
        seed_default_feature_jobs(s)
        seed_default_feature_prompts(s)
        s.commit()
    finally:
        if own:
            s.close()
