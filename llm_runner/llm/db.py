# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared LLM storage — the SINGLE home for every LLM table, on its own
SQLAlchemy declarative base (`LlmBase`). Any host app drops the shared LLM stack
in and gets these tables; the host owns only its session factory (it has its own
domain tables on its own Base) and hands it to `configure_storage`. `install_llm`
calls `create_all(engine)` + `configure_storage(SessionLocal)` for the host — no
app re-declares an LLM table.

Routing is the default LLM/embedding + explicit per-feature pins (no
quick/accuracy/role/job columns). Engine config is owned by the taskKind → preset
cascade (`engine_presets`), overlaid at dispatch.
"""

from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Column,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
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


# ── downloadable model catalog ────────────────────────────────────────────────
class ModelCatalog(LlmBase):
    """One downloadable llama.cpp model — catalog fields only. `built_in` marks a
    seeded row. (There is no per-model switch column; engine switches come from the
    type presets, merged in `switch_resolve`.)"""

    __tablename__ = "model_catalog"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, default="")
    hf_repo = Column(String, nullable=False, default="")
    quant = Column(String, nullable=False, default="")
    mmproj = Column(String, nullable=True)
    total_params = Column(String, nullable=False, default="")
    active_params = Column(String, nullable=False, default="")
    mtp = Column(Boolean, nullable=False, default=False)
    # Editable capability type (dense | moe). Drives which `switch_presets` row
    # applies (the `moe` preset's spec:none/no_mmap lives ONCE here, not copied
    # per MoE model). Seeded from arch; `mtp` stays its own bool. (design §6.5)
    type = Column(String, nullable=False, default="dense")
    # Trained context length (`<arch>.context_length` in the GGUF header), file-
    # derived — null until the header is read (on Add via /inspect, or at download).
    trained_ctx = Column(Integer, nullable=True)
    min_vram_mb = Column(Integer, nullable=True)
    min_ram_mb = Column(Integer, nullable=True)
    tier = Column(String, nullable=False, default="mid")
    # SPDX license id of the model weights (e.g. "Apache-2.0", "MIT",
    # "Llama-Community"). Drives the license badge/flag in the model UI and the
    # ship-license gate — a use-limited license (Llama, Mistral-Research) is
    # listed but never a default. Empty = unknown.
    license = Column(String, nullable=False, default="")
    # Use-limited flag (Llama-Community, *-Research, non-commercial, …): DB-stored so
    # it is editable per-model; seeded from `license` at seed time (no hardcoded
    # runtime license rule — the keyword match is a one-time seed helper).
    use_limited = Column(Boolean, nullable=False, default=False)
    built_in = Column(Boolean, nullable=False, default=False)
    position = Column(Integer, nullable=False, default=0)


# ── per-model recommended samplers — a FILE-derived fact (the GGUF `general.sampling.*`
#    header keys, else the origin repo's generation_config.json), NOT hand-typed. Read
#    from the model, shown read-only ("auto-detected from the file"); it SEEDS the Lab
#    sampler grid (seen = run). Variable-cardinality child so a new sampler key needs no
#    schema change (mirrors engine_preset_samplers / feature_sampler_params). ──────────
class ModelSampler(LlmBase):
    """One model's recommended sampler value, keyed by the llama.cpp param name
    (temp/top_k/top_p/min_p/…). PK (model_id, param_name); no FK — `model_id` is a
    soft ref to the catalog (like ModelRecommendation). Written ONLY by GGUF identity
    detect (`ModelCatalogStore.set_derived`), never by the user-edit `upsert`."""

    __tablename__ = "model_samplers"

    model_id = Column(String, primary_key=True)
    param_name = Column(String, primary_key=True)
    value = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


# ── cloud pricing (the usage-ledger cost source; replaces the hardcoded
#    pricing.py MODEL_PRICING dict — seeded + editable) ──────────────────────────
class ModelPricing(LlmBase):
    """Per-1M-token USD price for a cloud model id (input, output). Seeded from
    `pricing.DEFAULT_PRICING`, edited via `/v1/ai/pricing`, read by
    `pricing.price_for`. Local models have no row → cost 0."""

    __tablename__ = "model_pricing"

    model_id = Column(String, primary_key=True)  # lowercased cloud model id
    input_per_m = Column(Float, nullable=False, default=0.0)
    output_per_m = Column(Float, nullable=False, default=0.0)


# ── capability/type switch presets (the switch BASE layer; replaces the
#    hardcoded runner-manifest `flagPresets`) — design §6.5 ──────────────────────
class SwitchPreset(LlmBase):
    """A capability/type switch bundle (`base` / `moe` / `dense` / …). `applies_to`
    is the trigger matched against a model: `all` (every model) or `moe`/`dense`
    (matches `model_catalog.type`). The flag rows live in the `preset_switches`
    child. Seeded + user-editable; replaces `runner-manifest.json` `flagPresets`.
    (An `mtp` applies-to existed pre-2026-07-03 but was dropped in Phase 3 — MTP is
    opt-in/measurable via the `spec_type` knob, never an auto-applied preset.)"""

    __tablename__ = "switch_presets"

    id = Column(String, primary_key=True)  # base | moe | dense | <user id>
    label = Column(String, nullable=False, default="")
    applies_to = Column(String, nullable=False, default="all")  # all | moe | dense
    position = Column(Integer, nullable=False, default=0)
    built_in = Column(Boolean, nullable=False, default=False)


class PresetSwitch(LlmBase):
    """One flag in a `switch_presets` bundle (variable-cardinality child). PK
    (preset_id, flag_name); each maps 1:1 to a `process.Overrides` field."""

    __tablename__ = "preset_switches"

    preset_id = Column(
        String, ForeignKey("switch_presets.id", ondelete="CASCADE"), primary_key=True
    )
    flag_name = Column(String, primary_key=True)
    flag_value = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


class ModelRecommendation(LlmBase):
    """One curated 'model X is good for taskKind Y' record (QuickSetup pre-fill).
    PK (model_id, task_kind); `rank` orders candidates within a taskKind."""

    __tablename__ = "model_recommendations"

    model_id = Column(String, primary_key=True)
    task_kind = Column(String, primary_key=True)
    rank = Column(Integer, nullable=False, default=100)
    why = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


# ── routing: default LLM + explicit per-feature pins (live row + presets) ─────
class RoutingConfigRow(LlmBase):
    """A routing config — the live config (id='active') AND named presets share
    this table (`is_active` + `name` distinguish). Default LLM/embedding are
    columns; explicit per-feature overrides are `routing_pins`."""

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
    row exists only for a feature pinned to something explicit; no override is the
    absence of a row."""

    __tablename__ = "routing_pins"

    config_id = Column(
        String, ForeignKey("routing_configs.id", ondelete="CASCADE"), primary_key=True
    )
    feature = Column(String, primary_key=True)
    provider_id = Column(String, nullable=False, default="")
    model = Column(String, nullable=False, default="")


# ── per-hardware switch override layer (design §6.4) ──────────────────────────
# The persistent per-machine switch tune, merged after the base→type presets
# in `switch_resolve.py` and applied via the runner's existing `_merge_overrides`.
class HardwareSwitch(LlmBase):
    """A per-machine spawn-flag override keyed by GPU (`hw_key`) — the persistent
    form of #20 tuning (auto-fit finds *a* working value; this saves the *fast*
    one). No FK: `hw_key` is a free-form hardware identifier."""

    __tablename__ = "hardware_switches"

    hw_key = Column(String, primary_key=True)
    flag_name = Column(String, primary_key=True)
    flag_value = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


# ── runner config (was runner-manifest.json — now DB, seeded built_in) ────────
class RunnerBinary(LlmBase):
    """One prebuilt llama-server distribution, selected by (platform, gpu).
    Replaces `runner-manifest.json` `llamacpp.binaries` — config is data, it
    lives in the DB (user decree 2026-06-27), seeded `built_in`. `runtime_url` is
    an optional companion archive (the Windows CUDA cudart DLLs) unpacked
    alongside the exe; this only records which build to fetch."""

    __tablename__ = "runner_binary"

    platform = Column(String, primary_key=True)   # windows | macos | linux
    gpu = Column(String, primary_key=True)        # cuda12 | cuda13 | metal | cpu | …
    source = Column(String, nullable=False, default="github")  # github | docker
    asset_url = Column(String, nullable=True)
    runtime_url = Column(String, nullable=True)   # companion (cudart DLLs) unpacked alongside
    image = Column(String, nullable=True)
    sha256 = Column(String, nullable=True)
    server_exe = Column(String, nullable=False, default="llama-server")
    built_in = Column(Boolean, nullable=False, default=False)
    position = Column(Integer, nullable=False, default=0)


class RunnerSetting(LlmBase):
    """A scalar runner config value (key/value) — `pinned_build`, `safety_margin_mb`.
    Replaces the `runner-manifest.json` scalars; genuinely scalar config, not a
    JSON blob. Seeded `built_in`."""

    __tablename__ = "runner_setting"

    key = Column(String, primary_key=True)
    value = Column(String, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


# ── knob catalog — metadata that turns a raw switch/sampler key into a friendly
#    KnobGrid input (label/type/default/help/plane). DATA, no code per param
#    (design C1). `flag_name` maps to an Overrides field (Plane-1) or a sampler
#    `extra` key (Plane-2). Enum options live in the child `knob_option`. ──────────
class KnobCatalog(LlmBase):
    __tablename__ = "knob_catalog"

    flag_name = Column(String, primary_key=True)
    label = Column(String, nullable=False, default="")
    kind = Column(String, nullable=False, default="string")  # bool|int|float|enum|string
    default_value = Column(String, nullable=False, default="")
    help = Column(Text, nullable=False, default="")
    plane = Column(Integer, nullable=False, default=1)        # 1 = load switch, 2 = sampler
    applies_to = Column(String, nullable=False, default="all")  # all|moe|dense
    tier = Column(String, nullable=False, default="common")    # common|advanced (UI checklist split)
    position = Column(Integer, nullable=False, default=0)
    built_in = Column(Boolean, nullable=False, default=False)


class KnobOption(LlmBase):
    """One choice for an enum knob (e.g. flash_attn → on|off|auto). Relational, not
    a JSON list on the parent."""

    __tablename__ = "knob_option"

    flag_name = Column(
        String, ForeignKey("knob_catalog.flag_name", ondelete="CASCADE"), primary_key=True
    )
    value = Column(String, primary_key=True)
    label = Column(String, nullable=False, default="")
    position = Column(Integer, nullable=False, default=0)
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
    max_tokens = Column(Integer, nullable=False, default=0)  # 0 → no cap (#18 round-trip)
    json_mode = Column(Boolean, nullable=False, default=False)  # response_format=json_object (#18)
    top_p = Column(Float, nullable=True)  # nucleus sampling (#22)
    reasoning_effort = Column(String, nullable=False, default="")  # "" | low | medium | high (a1/E2)


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
    # Plane-2 per-request params (sent in the chat call, no model reload):
    json_mode = Column(Boolean, nullable=False, default=False)  # response_format=json_object (#18)
    top_p = Column(Float, nullable=True)  # nucleus sampling (#22); null → provider default
    reasoning_effort = Column(String, nullable=False, default="")  # "" | low | medium | high (a1/E2)
    built_in = Column(Boolean, nullable=False, default=True)
    label = Column(String, nullable=False, default="")
    description = Column(Text, nullable=False, default="")
    subgroup = Column(String, nullable=False, default="")  # wire field `group` (GROUP reserved)


class FeatureSamplerParam(LlmBase):
    """One per-action sampler knob BEYOND the built-in temp/top_p/json/think/max
    columns above — the long tail (top_k, min_p, typical_p, mirostat*, dry_*, xtc_*,
    samplers-order, …). Variable-cardinality key/value rows so a NEW sampler needs
    no schema change (design D14 / §8). PK (key, param_name); `key` is the action id
    (FeaturePrompt.key). Merged into the per-call `extra` at dispatch + filtered per
    adapter. No FK — `key` is an app-catalog action id, not a DB row."""

    __tablename__ = "feature_sampler_params"

    key = Column(String, primary_key=True)         # action id, e.g. "writerAI.tighten"
    param_name = Column(String, primary_key=True)  # e.g. "top_k", "min_p", "mirostat"
    value = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


# ── engine presets (the Lab's output; the SOURCE OF TRUTH for what runs — the
# 2026-06-29 lab+preset model). A preset = model + frozen switches + params. It is
# assigned to features by TASKKIND (TaskKindPreset), with TaskKindPreset[""] as the
# global default (2026-07-02: a feature's preset IS its task's — no per-feature tier). The
# PROMPT is NOT here — it stays on the feature (FeaturePrompt). Frozen (stored = run)
# EXCEPT ngl / n_cpu_moe, which auto-compute at load when their override is null. ──
class EnginePreset(LlmBase):
    """A reusable engine config built + saved in the Lab: a model + per-request
    params + a frozen Plane-1 switch child + optional hardware-fit-knob overrides."""

    __tablename__ = "engine_presets"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, default="")
    provider_id = Column(String, nullable=False, default="")
    model = Column(String, nullable=False, default="")
    # Plane-2 per-request params (sent in the chat call, no reload):
    temperature = Column(Float, nullable=True)
    top_p = Column(Float, nullable=True)
    max_tokens = Column(Integer, nullable=False, default=0)        # 0 → no cap
    json_mode = Column(Boolean, nullable=False, default=False)
    reasoning_effort = Column(String, nullable=False, default="")  # "" | low | medium | high
    # Hardware-fit knobs: null → auto-compute at load; set → frozen override that wins.
    ngl_override = Column(Integer, nullable=True)
    n_cpu_moe_override = Column(Integer, nullable=True)
    position = Column(Integer, nullable=False, default=0)
    built_in = Column(Boolean, nullable=False, default=False)


class EnginePresetSwitch(LlmBase):
    """One FROZEN Plane-1 switch in a preset (flash-attn, cache types, mlock,
    no-mmap, moe spec-off, …) — variable-cardinality child, PK (preset_id, flag_name).
    NOT the auto fit knobs (ngl / n_cpu_moe are columns on EnginePreset)."""

    __tablename__ = "engine_preset_switches"

    preset_id = Column(String, ForeignKey("engine_presets.id", ondelete="CASCADE"), primary_key=True)
    flag_name = Column(String, primary_key=True)
    flag_value = Column(String, nullable=False, default="")


class EnginePresetSampler(LlmBase):
    """One long-tail sampler in a preset (top_k, min_p, mirostat*, dry_*, xtc_*, …)
    beyond the typed param columns. PK (preset_id, param_name); merged into the
    per-call `extra` at dispatch."""

    __tablename__ = "engine_preset_samplers"

    preset_id = Column(String, ForeignKey("engine_presets.id", ondelete="CASCADE"), primary_key=True)
    param_name = Column(String, primary_key=True)
    value = Column(Text, nullable=False, default="")


class TaskKindPreset(LlmBase):
    """taskKind → preset assignment — the bulk handle. Every action whose LLM-work
    taskKind matches this key inherits this preset (and a NEW action of that taskKind
    auto-joins). `task_kind` "" is the global-default row. (2026-07-02: a feature's
    preset IS its task's — there is no per-feature override tier.)"""

    __tablename__ = "task_kind_presets"

    task_kind = Column(String, primary_key=True)
    preset_id = Column(String, ForeignKey("engine_presets.id", ondelete="CASCADE"), nullable=False)


class TaskKind(LlmBase):
    """A user-editable LLM-work TASK — the routing bucket features are assigned to.
    Seeded with the shared defaults (`seed.DEFAULT_TASK_KINDS`); users create / rename /
    delete CUSTOM tasks (built-ins are protected). `id` is the routing key — it matches
    `FeatureTaskKind.task_kind`, `TaskKindPreset.task_kind`, and `ModelRecommendation.task_kind`
    (all plain-String SOFT references, no FK: the "" global-default preset row survives, and a
    task delete cascades cleanup across those tables in `TaskKindStore.delete`)."""

    __tablename__ = "task_kinds"

    id = Column(String, primary_key=True)
    label = Column(String, nullable=False, default="")
    description = Column(Text, nullable=False, default="")
    position = Column(Integer, nullable=False, default=0)
    built_in = Column(Boolean, nullable=False, default=False)


class FeatureTaskKind(LlmBase):
    """A feature/action key → its LLM-work task (the user-editable reassignment layer).
    Absent → `install._task_kind_of` falls back to the in-memory seed map, then the
    `writerAI.rule.*` prefix, then "". Seeded from the host's action→task map."""

    __tablename__ = "feature_task_kinds"

    key = Column(String, primary_key=True)
    task_kind = Column(String, nullable=False, default="")


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
