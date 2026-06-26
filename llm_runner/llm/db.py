# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared LLM storage — the SINGLE home for every LLM table, on its own
SQLAlchemy declarative base (`LlmBase`). Any host app drops the shared LLM stack
in and gets these tables; the host owns only its session factory (it has its own
domain tables on its own Base) and hands it to `configure_storage`. `install_llm`
calls `create_all(engine)` + `configure_storage(SessionLocal)` for the host — no
app re-declares an LLM table.

Job-native (2026-06-26): `routing_configs` has NO quick/accuracy columns and
`routing_pins` has NO role column — routing is default + per-job (`job_routes`) +
explicit per-feature pins. `feature_presets` has no role column either.
"""

from __future__ import annotations

from sqlalchemy import Boolean, Column, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import declarative_base, sessionmaker

LlmBase = declarative_base()


# ── provider registry + usage ledger ─────────────────────────────────────────
class LlmProvider(LlmBase):
    """A configured LLM provider — the shared `LLMProviderConfig` shape as real
    columns. `local` is the Local/Online choice; `built_in` marks a seeded row."""

    __tablename__ = "llm_providers"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, default="")
    kind = Column(String, nullable=False, default="llm")
    built_in = Column(Boolean, nullable=False, default=False)
    position = Column(Integer, nullable=False, default=0)
    provider_type = Column(String, nullable=False, default="openai-compat")
    base_url = Column(String, nullable=False, default="")
    api_key = Column(String, nullable=True)
    default_model = Column(String, nullable=False, default="")
    embedding_model = Column(String, nullable=False, default="")
    timeout_seconds = Column(Integer, nullable=False, default=60)
    local = Column(Boolean, nullable=False, default=True)


class LlmUsage(LlmBase):
    """One recorded LLM call — the cost/token ledger (the DB usage sink writes
    these; the shared /v1/ai-usage snapshot aggregates them)."""

    __tablename__ = "llm_usage"

    id = Column(String, primary_key=True)
    at = Column(Integer, nullable=False, default=0)  # epoch ms
    feature = Column(String, nullable=False, default="unknown")
    provider_id = Column(String, nullable=True)
    model = Column(String, nullable=True)
    prompt_tokens = Column(Integer, nullable=False, default=0)
    completion_tokens = Column(Integer, nullable=False, default=0)
    cost = Column(Float, nullable=False, default=0.0)
    meta = Column(Text, nullable=False, default="{}")  # JSON


# ── downloadable model catalog + per-model spawn-flag switches ────────────────
class ModelCatalog(LlmBase):
    """One downloadable llama.cpp model — catalog fields only (switches live in
    the `model_switches` child). `built_in` marks a seeded row."""

    __tablename__ = "model_catalog"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, default="")
    hf_repo = Column(String, nullable=False, default="")
    quant = Column(String, nullable=False, default="")
    mmproj = Column(String, nullable=True)
    total_params = Column(String, nullable=False, default="")
    active_params = Column(String, nullable=False, default="")
    mtp = Column(Boolean, nullable=False, default=False)
    min_vram_mb = Column(Integer, nullable=True)
    min_ram_mb = Column(Integer, nullable=True)
    tier = Column(String, nullable=False, default="mid")
    built_in = Column(Boolean, nullable=False, default=False)
    position = Column(Integer, nullable=False, default=0)


class ModelSwitch(LlmBase):
    """Per-model llama.cpp spawn-flag override (variable-cardinality child of
    `model_catalog`). PK (model_id, flag_name); maps 1:1 to `process.Overrides`."""

    __tablename__ = "model_switches"

    model_id = Column(
        String, ForeignKey("model_catalog.id", ondelete="CASCADE"), primary_key=True
    )
    flag_name = Column(String, primary_key=True)
    flag_value = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


class ModelRecommendation(LlmBase):
    """One curated 'model X is good for job Y' record (QuickSetup pre-fill). PK
    (model_id, job); `rank` orders candidates within a job."""

    __tablename__ = "model_recommendations"

    model_id = Column(String, primary_key=True)
    job = Column(String, primary_key=True)
    rank = Column(Integer, nullable=False, default=100)
    why = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


# ── routing: default + per-job routes + explicit pins (live row + presets) ────
class RoutingConfigRow(LlmBase):
    """A routing config — the live config (id='active') AND named presets share
    this table (`is_active` + `name` distinguish). Default LLM/embedding are
    columns; the per-job map is `job_routes`, explicit overrides are
    `routing_pins`. NO quick/accuracy columns (job-native)."""

    __tablename__ = "routing_configs"

    id = Column(String, primary_key=True)  # 'active' for the live config; else a preset id
    name = Column(String, nullable=False, default="")
    is_active = Column(Boolean, nullable=False, default=False)
    position = Column(Integer, nullable=False, default=0)
    default_llm_id = Column(String, nullable=False, default="")
    default_model = Column(String, nullable=False, default="")
    default_embedding_id = Column(String, nullable=False, default="")
    default_embedding_model = Column(String, nullable=False, default="")


class RoutingPin(LlmBase):
    """One feature → explicit provider/model override within a routing config. A
    row exists only for a feature pinned to something explicit; inheriting the
    feature's job is the absence of a row. NO role column (job-native)."""

    __tablename__ = "routing_pins"

    config_id = Column(
        String, ForeignKey("routing_configs.id", ondelete="CASCADE"), primary_key=True
    )
    feature = Column(String, primary_key=True)
    provider_id = Column(String, nullable=False, default="")
    model = Column(String, nullable=False, default="")


class JobRoute(LlmBase):
    """The per-config job→model map: which provider+model serves each job (what
    QuickSetup / Routing-by-job sets). `job_id` is a soft ref to `jobs.id` (a
    deleted job's routes are harmless dangling rows resolved to the default job)."""

    __tablename__ = "job_routes"

    config_id = Column(
        String, ForeignKey("routing_configs.id", ondelete="CASCADE"), primary_key=True
    )
    job_id = Column(String, primary_key=True)
    provider_id = Column(String, nullable=False, default="")
    model = Column(String, nullable=False, default="")


# ── jobs (the editable routing unit) + the feature→job map ────────────────────
class Job(LlmBase):
    """One job — the routing unit that replaced quick/accuracy roles. A small,
    user-editable list (seeded chat/prose/extraction/analysis). `id` is an
    IMMUTABLE slug so a rename (edits only `label`) never orphans references."""

    __tablename__ = "jobs"

    id = Column(String, primary_key=True)
    label = Column(String, nullable=False, default="")
    description = Column(Text, nullable=False, default="")
    position = Column(Integer, nullable=False, default=0)
    built_in = Column(Boolean, nullable=False, default=False)


class FeatureJob(LlmBase):
    """One feature's job classification (the per-feature dropdown). `feature_key`
    matches the host's feature catalog; `job_id` is a `Job.id` (soft ref —
    a missing job resolves to the default job at dispatch)."""

    __tablename__ = "feature_jobs"

    feature_key = Column(String, primary_key=True)
    job_id = Column(String, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


# ── feature presets (Feature Workbench) + feature prompts ─────────────────────
class FeaturePreset(LlmBase):
    """A named saved AI config for one ACTION; `is_active` marks the production
    one. NO role column (job-native — model is an explicit provider+model)."""

    __tablename__ = "feature_presets"

    id = Column(String, primary_key=True)
    action = Column(String, nullable=False, default="")
    name = Column(String, nullable=False, default="")
    is_active = Column(Boolean, nullable=False, default=False)
    position = Column(Integer, nullable=False, default=0)
    provider_id = Column(String, nullable=False, default="")
    model = Column(String, nullable=False, default="")
    system = Column(Text, nullable=False, default="")
    user_template = Column(Text, nullable=False, default="")
    temperature = Column(Float, nullable=True)
    think = Column(Boolean, nullable=False, default=False)


class FeaturePrompt(LlmBase):
    """One feature's prompt — seeded from the host's registered feature-prompt
    DATA, editable in the Lab; the DB is the source of truth. `key` is the action
    id; `feature` is the routing key (several actions can share one)."""

    __tablename__ = "feature_prompts"

    key = Column(String, primary_key=True)
    feature = Column(String, nullable=False, default="")
    system = Column(Text, nullable=False, default="")
    user_template = Column(Text, nullable=False, default="")
    temperature = Column(Float, nullable=False, default=0.7)
    think = Column(Boolean, nullable=False, default=False)
    max_tokens = Column(Integer, nullable=False, default=0)  # 0 → no cap
    built_in = Column(Boolean, nullable=False, default=True)
    label = Column(String, nullable=False, default="")
    description = Column(Text, nullable=False, default="")
    subgroup = Column(String, nullable=False, default="")  # wire field `group` (GROUP reserved)


# ── storage wiring (host hands its session factory; install_llm calls these) ──
_SessionLocal: sessionmaker | None = None


def configure_storage(session_factory: sessionmaker) -> None:
    """The host hands its SQLAlchemy sessionmaker; every shared store uses it."""
    global _SessionLocal
    _SessionLocal = session_factory


def session():
    """A new session from the host's factory."""
    if _SessionLocal is None:
        raise RuntimeError("LLM storage not configured — call configure_storage() during boot")
    return _SessionLocal()


def create_all(engine) -> None:
    """Create every LLM table on the host's engine (idempotent)."""
    LlmBase.metadata.create_all(bind=engine)


metadata = LlmBase.metadata
