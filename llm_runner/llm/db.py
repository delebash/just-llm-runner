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
    BigInteger,
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
    # Gemma-style SEPARATE MTP draft file (an external speculative-decode model at
    # its own quant; Qwen-style MTP is built into the main file and needs none of
    # these). FACTS about the model (which file), not tune — the per-box
    # allocations live in `model_tunes`. `mtp_draft_repo` "" = the draft lives in
    # the SAME repo as `hf_repo`; `mtp_draft_file` "" = no external draft
    # configured. Feeds the runner's `--model-draft` at load (Plan B, D7).
    mtp_draft_repo = Column(String, nullable=False, default="")
    mtp_draft_file = Column(String, nullable=False, default="")
    mtp_draft_quant = Column(String, nullable=False, default="")
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
    # Is this an EMBEDDING model (builds the RAG / semantic-search index), not a chat LLM?
    # Explicit editable flag — replaces the fragile `/embed/i` name guess (bge-m3 has no
    # "embed" in its id). Drives the catalog Embedding badge + Set-as-embedding action + the
    # QuickSetup embed picker; a user can mark their own added embed model. (model-surface)
    embedding = Column(Boolean, nullable=False, default=False)
    # Embedding pooling type ("" | mean | cls | last | rank) — INTRINSIC per-model
    # (nomic=mean, qwen3-embedding=last). DB-stored per-model because a switch CANNOT do
    # per-model (switch_resolve layers only all/type/hardware); "" = let llama.cpp read the
    # GGUF's pooling_type. Emitted onto the embed's `.ini` section by the runner (#119).
    pooling = Column(String, nullable=False, default="")
    # Curated overall-quality order (LOWER = better) — QuickSetup picks the best-quality
    # model that FITS the box; fit gates, this ranks. 100 = unranked (a user-added model
    # sorts last until edited). Editable per-model (curation, not file-derived).
    quality_rank = Column(Integer, nullable=False, default=100)
    # Plain-language "what this model is" — FILE/LINK-OWNED since 2026-07-07 (the
    # user's decree: "if user clicks read from file all fields should be updated"):
    # an explicit Read-from-link REGENERATES it from the file facts; personal /
    # judgment text lives in `notes` below, which nothing automatic ever touches.
    description = Column(Text, nullable=False, default="")
    # The user's OWN notes on the model (measured numbers, use policy, taste) —
    # persistent and NEVER written by read/download/backfill/seed refresh (the
    # 2026-07-07 decree's second half: "a seperate notes setion for personal note
    # info that is not tied to read from link that persists").
    notes = Column(Text, nullable=False, default="")
    # ── file-derived identity facts (2026-07-07, the auto-detected-panel parity
    #    item #141): persisted so Edit-open shows exactly what Read-from-link
    #    shows. Written by identity detect (set_derived) at download, the boot
    #    backfill, and the seed — like type/mtp/trained_ctx. size_bytes is the
    #    QUANT-SPECIFIC download size (cleared when the quant changes). ──
    architecture = Column(String, nullable=False, default="")   # e.g. "gemma4"
    experts = Column(Integer, nullable=False, default=0)        # MoE expert count (0 = dense)
    size_label = Column(String, nullable=False, default="")     # e.g. "128x2.6B" / "27B"
    size_bytes = Column(BigInteger, nullable=True)              # the GGUF file size
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
    soft ref to the catalog. Written ONLY by GGUF identity
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
    is the trigger matched against a model: `all` (every model), `moe`/`dense`
    (matches `model_catalog.type`), or `mtp` (the GATED auto-enable layer —
    applied only to a model that is built-in-MTP-capable or has an external
    draft configured; re-added 2026-07-05 Plan B, reversing the Phase-3 "never
    auto-applied" — the user's auto-enable-with-visible-off decision). The flag
    rows live in the `preset_switches` child. Seeded + user-editable; replaces
    `runner-manifest.json` `flagPresets`."""

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


# (The per-hardware `hardware_switches` layer/table was RETIRED 2026-07-07 — the
# user's switch-provenance review: it had NO writer, NO seeder, and NO UI anywhere,
# so it existed only as mental-model weight in the resolution ladder; `class_tunes`
# (portable per-class) + `model_tunes` (this machine) cover its use cases. An
# existing dev DB simply keeps the orphaned empty table until the next reset —
# create_all never drops. The per-MACHINE `hw_key` lives on under `model_tunes`.)


class ModelClassPick(LlmBase):
    """One hardware-class row of the class→model map (model-per-hardware plan Phase 3):
    QuickSetup's pick consults the row with the LARGEST `min_vram_mb <= detected VRAM`
    whose model exists + fits; no matching row → the §10 speed-floor rule (the
    unchanged fallback). SEED DATA (the expression point) — the map's CONTENTS are
    replaceable rows refreshed by the model research (ledger C9), never a GUI."""

    __tablename__ = "model_class_picks"

    min_vram_mb = Column(Integer, primary_key=True)
    model_id = Column(String, nullable=False)
    built_in = Column(Boolean, nullable=False, default=False)


class ModelTune(LlmBase):
    """One flag of a user's MEASURED per-(model, MACHINE) tune — the Plan-B layer
    (2026-07-05), the persistence behind Quick tune's Save. NEVER seeded (no
    DEFAULT_*, deliberately no `built_in` column): user-written only, so
    re-seeds / re-inspects can never clobber it (the facts-vs-tune split —
    `model_catalog`/`model_samplers` are what the FILE says; this is what YOUR
    measurement found on YOUR box). Applied LAST by `switch_resolve` (wins over
    base/type/mtp/class) — including the MTP opt-OUT (`spec_type=none`) when
    the user unchecks the auto-enabled default. NOT the dropped `model_switches`
    table (that seeded per-model COPIES of type rules — a one-source violation);
    the composite (model_id, hw_key) key + never-seeded lifecycle make the
    difference structural. No FKs: soft refs, matching ModelSampler."""

    __tablename__ = "model_tunes"

    model_id = Column(String, primary_key=True)
    hw_key = Column(String, primary_key=True)
    flag_name = Column(String, primary_key=True)
    flag_value = Column(Text, nullable=False, default="")


class ModelTuneBaseline(LlmBase):
    """One flag of the LAYER-RESOLVED baseline (base→type→mtp→class, NO machine
    tune, NO fit-computed values) captured AT THE MOMENT a tune was applied —
    §7.6's drift detection (2026-07-08). The user's snapshot decision means an
    applied config stops following defaults; this table is how the Tune modal
    can honestly say "defaults have changed since you applied this" — comparing
    TODAY's layer baseline against the one that stood at apply time. A naive
    applied-vs-defaults diff can't work: every tune deliberately differs from
    the defaults, so it would flag drift forever. Fit-computed values are
    excluded on purpose — they move with free VRAM/driver state, which is not
    "the defaults changed". Written/cleared by ModelTuneStore.replace/delete in
    the same transaction as the tune rows; never seeded. Additive table: an
    existing DB gains it via create_all with NO reset; tunes applied before it
    existed simply have no baseline → no drift claim is made for them."""

    __tablename__ = "model_tune_baselines"

    model_id = Column(String, primary_key=True)
    hw_key = Column(String, primary_key=True)
    flag_name = Column(String, primary_key=True)
    flag_value = Column(Text, nullable=False, default="")


class ClassTune(LlmBase):
    """A seeded + EDITABLE per-(model, HARDWARE-CLASS) tune — the class-seed layer
    (2026-07-07). Unlike ModelTune (a machine's OWN measured tune, never seeded),
    this is keyed by a COARSE hardware CLASS (`class_key` = `vram<GB>|ram<GB>`) and IS
    seeded: the optimal layer placement is a function of the hardware (VRAM/RAM fit),
    so a config measured on one box is portable to every box of the same class — the
    user's "similar systems should already have similar defaults". GPU name + core
    count are EXCLUDED from the key (placement is memory-fit-bound, not compute-bound).
    Resolved in `switch_resolve` BELOW a machine's own ModelTune (more specific wins)
    and ABOVE base/type/mtp. `built_in` marks seeded rows so a reseed refreshes them
    while user-added / Lab-measured rows are kept."""

    __tablename__ = "class_tunes"

    model_id = Column(String, primary_key=True)
    class_key = Column(String, primary_key=True)
    flag_name = Column(String, primary_key=True)
    flag_value = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


class ModelMeasurement(LlmBase):
    """One MEASURED decode-speed result — the persistent measurement HISTORY
    (#142 rows 5+6, 2026-07-07: 'save all data, nothing temporary'). ONE table
    for both producers: the Tune modal's "Load & measure" (source='tune') and
    every successful auto-tune trial (source='autotune'). Append-only from the
    app's side; the user clears it via DELETE /v1/ai/model-measurements (the
    Clear-history button). Never seeded; `machine_key` records WHICH box
    measured (the ModelTune hw_key identity), `at` is epoch ms (the LlmUsage
    idiom). The switches that produced the number are relational child rows
    (MeasurementSwitch) — never a JSON blob."""

    __tablename__ = "model_measurements"

    id = Column(Integer, primary_key=True, autoincrement=True)
    model_id = Column(String, nullable=False)
    machine_key = Column(String, nullable=False, default="")
    source = Column(String, nullable=False, default="tune")  # tune | autotune
    label = Column(String, nullable=False, default="")       # e.g. "n-cpu-moe 21"
    tokens_per_sec = Column(Float, nullable=False, default=0.0)
    vram_total_mb = Column(Integer, nullable=False, default=0)
    at = Column(Integer, nullable=False, default=0)          # epoch ms


class MeasurementSwitch(LlmBase):
    """One launch switch of a recorded measurement — variable-cardinality child,
    PK (measurement_id, flag_name). Soft ref like the tune-family tables
    (ModelTune/ClassTune); the store deletes children explicitly on clear."""

    __tablename__ = "measurement_switches"

    measurement_id = Column(Integer, primary_key=True)
    flag_name = Column(String, primary_key=True)
    flag_value = Column(Text, nullable=False, default="")


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
    # C1: optional JSON Schema (text; "" = none). With json_mode on, a valid schema
    # upgrades the weak json_object to schema-ENFORCED output (llama.cpp converts it
    # to grammar; OpenAI json_schema; Ollama format=<schema>; Gemini responseSchema).
    # Action-grain by design: the SHAPE is the feature's contract — presets stay
    # shape-free so they remain reusable across actions.
    json_schema = Column(Text, nullable=False, default="")
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
# PROMPT is NOT here — it stays on the feature (FeaturePrompt). ──
class EnginePreset(LlmBase):
    """A reusable engine config built + saved in the Lab: a model + per-request
    params + a long-tail sampler child. HOLDS NO LAUNCH SWITCHES (§7.1, locked
    2026-07-08): launch config is owned by the MODEL × machine tune stack
    (`switch_resolve` — global bundles → class_tunes → model_tunes), because a
    loaded model is ONE process with ONE set of launch flags, shared by every
    task that points at it. The old per-preset switch child
    (`engine_preset_switches`) + the ngl/n_cpu_moe override columns were dead
    storage — written by the Lab, read by NOTHING at load — and were removed;
    an existing DB keeps the orphan table/columns inert (the
    `feature_preset_refs` precedent — no reset required)."""

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
    position = Column(Integer, nullable=False, default=0)
    built_in = Column(Boolean, nullable=False, default=False)


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
    `FeatureTaskKind.task_kind` and `TaskKindPreset.task_kind`
    (both plain-String SOFT references, no FK: the "" global-default preset row survives, and a
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
