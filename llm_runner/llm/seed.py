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

DEFAULT_CATALOG: list[dict] = [
    {"id": "qwen3.6-35b-a3b-mtp", "name": "Qwen3.6 35B-A3B (MTP)",
     "hf_repo": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF", "quant": "UD-Q4_K_XL",
     "total_params": "35B", "active_params": "3.6B", "mtp": True, "type": "moe",
     "min_vram_mb": 6000, "min_ram_mb": 24000, "tier": "low-vram-moe", "position": 0},
    {"id": "qwen3.5-9b-q4_k_s", "name": "Qwen3.5 9B · Q4_K_S",
     "hf_repo": "unsloth/Qwen3.5-9B-GGUF", "quant": "Q4_K_S",
     "total_params": "9B", "min_ram_mb": 9500, "min_vram_mb": 7000, "tier": "mid", "position": 1},
    {"id": "qwen3.5-9b-q4_k_m", "name": "Qwen3.5 9B · Q4_K_M",
     "hf_repo": "unsloth/Qwen3.5-9B-GGUF", "quant": "Q4_K_M",
     "total_params": "9B", "min_ram_mb": 10000, "min_vram_mb": 7500, "tier": "mid", "position": 2},
    {"id": "qwen3-14b-q3_k_m", "name": "Qwen3 14B · Q3_K_M",
     "hf_repo": "unsloth/Qwen3-14B-GGUF", "quant": "Q3_K_M",
     "total_params": "14B", "min_ram_mb": 12000, "min_vram_mb": 9000, "tier": "mid", "position": 3},
    {"id": "qwen3-14b-q4_k_m", "name": "Qwen3 14B · Q4_K_M",
     "hf_repo": "unsloth/Qwen3-14B-GGUF", "quant": "Q4_K_M",
     "total_params": "14B", "min_ram_mb": 14000, "min_vram_mb": 11000, "tier": "mid", "position": 4},
    {"id": "qwen3.6-27b-mtp-q4_k_m", "name": "Qwen3.6 27B (MTP) · Q4_K_M",
     "hf_repo": "unsloth/Qwen3.6-27B-MTP-GGUF", "quant": "Q4_K_M",
     "total_params": "27B", "mtp": True,
     "min_ram_mb": 26000, "min_vram_mb": 20000, "tier": "high", "position": 5},
]

# Per-model switch overrides — EMPTY by default now: the MoE (spec:none/no_mmap)
# and MTP (draft-mtp) rules moved to the capability/type presets below (§6.5), so
# they live ONCE and any new MoE/MTP model inherits them via its `type`/`mtp`.
# `model_switches` remains the RARE per-model exception (user-added).
DEFAULT_SWITCHES: list[dict] = []

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

# Job tags use the seeded job ids (chat/prose/extraction/analysis). Editable (#25).
DEFAULT_RECOMMENDATIONS: list[dict] = [
    {"model_id": "qwen3.5-9b-q4_k_s", "job": "chat", "rank": 10, "why": "Smallest dense — snappy interactive chat."},
    {"model_id": "qwen3.5-9b-q4_k_m", "job": "chat", "rank": 20, "why": "Same 9B, higher quant — still quick on most cards."},
    {"model_id": "qwen3.5-9b-q4_k_s", "job": "prose", "rank": 10, "why": "Fast dense — fluent drafting and rewrites."},
    {"model_id": "qwen3-14b-q4_k_m", "job": "prose", "rank": 20, "why": "14B dense — richer prose when VRAM allows."},
    {"model_id": "qwen3-14b-q4_k_m", "job": "analysis", "rank": 10, "why": "14B dense — best accuracy that fits ≥11 GB VRAM."},
    {"model_id": "qwen3-14b-q3_k_m", "job": "analysis", "rank": 20, "why": "14B dense, lower quant — fits ≥9 GB."},
    {"model_id": "qwen3.6-27b-mtp-q4_k_m", "job": "analysis", "rank": 5, "why": "27B (MTP) — best accuracy at the high tier (~20 GB+ VRAM)."},
    {"model_id": "qwen3.6-35b-a3b-mtp", "job": "analysis", "rank": 15, "why": "35B-A3B MoE — runs on 6 GB VRAM via CPU expert offload (needs 24 GB RAM)."},
    {"model_id": "qwen3.6-35b-a3b-mtp", "job": "extraction", "rank": 10, "why": "MoE 35B-A3B — strong at structured extraction; CPU-offload friendly."},
    {"model_id": "qwen3-14b-q4_k_m", "job": "extraction", "rank": 20, "why": "14B dense — reliable structured extraction."},
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
            tier=str(c.get("tier") or "mid"), built_in=True, position=int(c.get("position") or 0),
        ))
        added += 1
    return added


def seed_default_switches(s) -> int:
    existing = {(r.model_id, r.flag_name) for r in s.query(db.ModelSwitch.model_id, db.ModelSwitch.flag_name).all()}
    added = 0
    for x in DEFAULT_SWITCHES:
        if (x["model_id"], x["flag_name"]) in existing:
            continue
        s.add(db.ModelSwitch(model_id=x["model_id"], flag_name=x["flag_name"],
                             flag_value=str(x.get("flag_value") or ""), built_in=True))
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
        seed_default_switches(s)
        seed_default_switch_presets(s)
        seed_default_recommendations(s)
        seed_default_jobs(s)
        seed_default_feature_jobs(s)
        seed_default_feature_prompts(s)
        s.commit()
    finally:
        if own:
            s.close()
