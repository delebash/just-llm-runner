# SPDX-License-Identifier: MIT
"""Shared LLM storage — the SINGLE home for every LLM table, on its own
SQLAlchemy declarative base (`LlmBase`). Any host app drops the shared LLM stack
in and gets these tables; the host owns only its session factory (it has its own
domain tables on its own Base) and hands it to `configure_storage`. `install_llm`
calls `create_all(engine)` + `configure_storage(SessionLocal)` for the host — no
app re-declares an LLM table.

Routing is the default LLM/embedding. Engine config is one-source (2026-07-15):
each action's `feature_preset_refs` row points at an `engine_presets` row, which
owns the model + every tunable; the action's prompt row keeps only its text and
its JSON contract.
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
    # MTP ENABLED/intent (2026-07-13): the user-facing "use MTP" flag — seed- and
    # user-owned, bound to the edit-form checkbox, read by the grid badge AND
    # `switch_resolve`'s auto-mtp layer. IDENTITY NEVER writes this (unlike the old
    # single `mtp` column, which the download header-read clobbered to False for
    # Gemma-style external-draft models — grid showed MTP, checkbox went unchecked).
    mtp = Column(Boolean, nullable=False, default=False)
    # MTP BUILT-IN (header truth): `<arch>.nextn_predict_layers > 0` — Qwen/GLM-style
    # in-file multi-token heads. Written ONLY by the GGUF identity read (set_derived /
    # inspect); display + auto-detect provenance, never the enable switch. A Gemma
    # external-draft model reads False here yet is still MTP-ENABLED via its draft.
    mtp_builtin = Column(Boolean, nullable=False, default=False)
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
    # Pre-download VRAM estimate (full-GPU offload at a realistic 8K ctx), from the
    # header inputs + real download size — the number shown next to the download size
    # in the Add-form. Persisted (like size_bytes) so Edit-open == Read-from-link
    # (#141 parity); written by identity (inspect + download) + the seed; null until
    # a header read supplies the layer count.
    est_vram_mb = Column(Integer, nullable=True)
    # ── the physics FACTS (fit-redesign §13.11, Phase 2): immutable, config-
    #    independent properties of the FILE, stored so every derived number
    #    (floors, est, badge) can be computed FRESH at read — never cached.
    #    Written by the same three writers as est_vram_mb (inspect, download
    #    identify, seed refresh). 0 = header never read (fidelity falls back to
    #    params×quant). The two `kv_*_bytes_per_token` scalars + `sliding_window`
    #    reproduce `kv_mb_at_ctx` exactly:
    #    KV(ctx,bits) = [Wb × min(ctx, window) + Gb × ctx] × bits/8  (§13.11). ──
    block_count = Column(Integer, nullable=False, default=0)
    n_kv_heads = Column(Integer, nullable=False, default=0)
    head_count = Column(Integer, nullable=False, default=0)
    embedding_length = Column(Integer, nullable=False, default=0)
    expert_used_count = Column(Integer, nullable=False, default=0)
    expert_byte_share = Column(Float, nullable=False, default=0.0)
    kv_windowed_bytes_per_token = Column(Float, nullable=False, default=0.0)
    kv_global_bytes_per_token = Column(Float, nullable=False, default=0.0)
    sliding_window = Column(Integer, nullable=False, default=0)
    built_in = Column(Boolean, nullable=False, default=False)
    position = Column(Integer, nullable=False, default=0)


# ── per-model recommended samplers — a FILE-derived fact (the GGUF `general.sampling.*`
#    header keys, else the origin repo's generation_config.json), NOT hand-typed. Read
#    from the model, shown read-only ("auto-detected from the file"); it SEEDS the Lab
#    sampler grid (seen = run). Variable-cardinality child so a new sampler key needs no
#    schema change (mirrors engine_preset_samplers). ────────────────────────────────────
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


# ── per-model embedding task templates (Move 0, RAG build 2026-07-11) ─────────
class ModelEmbedTemplate(LlmBase):
    """The task-instruction templates an EMBEDDING model requires around its
    input (nomic: `search_document:`/`search_query:` both sides; Qwen3-Embedding:
    a query-side `Instruct: …\\nQuery:` only; BGE-M3: none → no row). Template
    strings carry a `{text}` slot; an empty string = pass-through for that side.
    A 1:1 child of `model_catalog` (soft ref, like `model_samplers`) rather than
    catalog columns so existing DBs pick it up additively via create_all — no
    reset, no column migration. Seeded + user-editable via
    /v1/ai/embed-templates; applied server-side by /v1/ai/embeddings."""

    __tablename__ = "model_embed_templates"

    model_id = Column(String, primary_key=True)
    document_template = Column(Text, nullable=False, default="")
    query_template = Column(Text, nullable=False, default="")
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


# ── per-provider reasoning-level map (U2-T2, 2026-07-14): the level→value table the
#    ONE resolver (`llm/reasoning.py`) reads. Generation-aware — TWO value columns per
#    row: `word` (effort-word adapters: OpenAI `reasoning_effort`, Ollama native level,
#    new-Anthropic `output_config.effort`) and `tokens` (budget-number paths: the local
#    llama.cpp per-request budget, old-Anthropic `budget_tokens`, Gemini thinkingBudget).
#    The resolver picks whichever column the resolved backend/model-generation speaks —
#    ALL values, words AND numbers, are editable DATA, so NO adapter keeps its own level
#    table any more (`anthropic.py:80` + `gemini.py:131` die in U2-T5). Seeded per provider
#    TYPE, fill-if-missing per instance. CRUD GET/PUT /v1/ai/reasoning-map/{provider}
#    (the model_pricing precedent, #75). ──
class ReasoningMap(LlmBase):
    """One (provider_id, level) → value row. `word` "" = the provider speaks no effort
    word at this level; `tokens` NULL = no number form (for a LOCAL row, NULL = unlimited
    ⇒ the run falls to the hardware cap). PK (provider_id, level)."""

    __tablename__ = "reasoning_map"

    provider_id = Column(String, primary_key=True)
    level = Column(String, primary_key=True)            # low | medium | high | xhigh | max
    word = Column(String, nullable=False, default="")   # "" = n/a
    tokens = Column(Integer, nullable=True)             # NULL = n/a / unlimited
    built_in = Column(Boolean, nullable=False, default=False)


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
    only columns; the JW-path per-feature pin child (`routing_pins`) was removed
    2026-07-15 (the preset is the one source of routing — presets carry the
    provider/model; the pin tier never fired in JW)."""

    __tablename__ = "routing_configs"

    id = Column(String, primary_key=True)  # 'active' for the live config; else a preset id
    name = Column(String, nullable=False, default="")
    is_active = Column(Boolean, nullable=False, default=False)
    position = Column(Integer, nullable=False, default=0)
    default_llm_id = Column(String, nullable=False, default="")
    default_model = Column(String, nullable=False, default="")
    default_embedding_id = Column(String, nullable=False, default="")
    default_embedding_model = Column(String, nullable=False, default="")


# (The per-hardware `hardware_switches` layer/table was RETIRED 2026-07-07 — the
# user's switch-provenance review: it had NO writer, NO seeder, and NO UI anywhere,
# so it existed only as mental-model weight in the resolution ladder; `class_tunes`
# (portable per-class) + `model_tunes` (this machine) cover its use cases. An
# existing dev DB simply keeps the orphaned empty table until the next reset —
# create_all never drops. The per-MACHINE `hw_key` lives on under `model_tunes`.)


# (The hidden class→model pick table `model_class_picks` was DELETED 2026-07-22 —
# the §9 final ruled shape: the recommendation IS the visible class-tunes library
# (`ClassTune` rows); a model with a config for YOUR class is the recommendation,
# no match → the §10 speed-floor rule. A second invisible table answering "which
# model for this hardware" duplicated what the user sees + shares in the class
# panel. An existing dev DB keeps the orphaned table until the next reset —
# create_all never drops, same as the retired `hardware_switches` above.)


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
    # Pass 2 (2026-07-22): the engine FAMILY this tune was measured on ("cuda"…);
    # "" = legacy (cuda-era, pre-column) and reads as "cuda" (switch_resolve.
    # tune_row_applies). NON-PK deliberately: the PK stays (model, hw, flag), so a
    # re-tune under a different backend REPLACES the set (wholesale `replace`
    # semantics unchanged) — per-backend CO-EXISTING tunes would widen the PK,
    # which is a reset (deferred; additive columns can't change a PK).
    backend = Column(String, nullable=False, default="")


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


class TestSample(LlmBase):
    """One canned Lab test sample (§7.3, 2026-07-08 — the user's #30 "sample
    button with some sample data we have in database"): per-ACTION starting
    material for the Lab's Test input. SEEDED by the host app (synthesized text,
    never real user content — the test-data decision) via configure_app_seed,
    fill-if-empty per (action_key, label) so an edited row survives reseeds.
    Variables live in TestSampleVar rows (relational — the no-JSON-blobs rule).
    Additive table: create_all picks it up on existing DBs, NO reset."""

    __tablename__ = "test_samples"

    id = Column(Integer, primary_key=True, autoincrement=True)
    action_key = Column(String, nullable=False, default="")
    label = Column(String, nullable=False, default="")
    position = Column(Integer, nullable=False, default=0)


class TestSampleVar(LlmBase):
    """One {{variable}} of a test sample — the name → the text it fills."""

    __tablename__ = "test_sample_vars"

    sample_id = Column(Integer, primary_key=True)
    name = Column(String, primary_key=True)
    value = Column(Text, nullable=False, default="")


class HardwareClass(LlmBase):
    """A NAMED hardware class (2026-07-22, user redesign) — the sidecar that gives a
    class its human NAME + its editable whole-GB VRAM/RAM fields. The `class_key`
    (`vram<GB>|ram<GB>` / `cpu|ram<GB>`) stays the identity + the join to `class_tunes`
    and is DERIVED from `vram_gb`/`ram_gb` on save ("i reverse that vram and ram is
    key"), so `switch_resolve` + matching + the Pass-4 override are unchanged; this row
    only adds the label + the integer fields the add/edit form binds to. `name` is a
    free label ("but name can be anything"), NOT the identity and never matched on;
    blank → the UI shows the plain-words VRAM/RAM. `built_in` marks the seeded class so
    a reseed refreshes it while user-added classes are kept. One row per (VRAM, RAM)."""

    __tablename__ = "hardware_classes"

    class_key = Column(String, primary_key=True)
    # discrete | integrated | unified (2026-07-22 type-first redesign). Discrete uses
    # vram_gb + ram_gb; integrated/unified use ram_gb as the one memory pool (vram_gb 0).
    mem_type = Column(String, nullable=False, default="discrete")
    vram_gb = Column(Integer, nullable=False, default=0)
    ram_gb = Column(Integer, nullable=False, default=0)
    name = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=False)


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
    while user-added / Lab-measured rows are kept. Its class_key joins to
    HardwareClass (the name + VRAM/RAM sidecar, 2026-07-22)."""

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
    # Pass 2 (2026-07-22): the engine family the number was measured on; "" = legacy
    # (cuda-era). History is append-only, so the stamp makes cross-backend numbers
    # distinguishable instead of silently comparable.
    backend = Column(String, nullable=False, default="")


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
#    KnobGrid input (type/default/help/plane). DATA, no code per param
#    (design C1). `flag_name` maps to an Overrides field (Plane-1) or a sampler
#    `extra` key (Plane-2). Enum options live in the child `knob_option`. The UI
#    shows the EXACT switch name only — no friendly `label` (user ruling 2026-07-16;
#    the physical `label` column was dropped — create_all never drops it from an
#    existing DB, a harmless orphan under the pre-release drop+reseed policy, same
#    as the reasoning_cap_default orphan). ──────────
class KnobCatalog(LlmBase):
    __tablename__ = "knob_catalog"

    flag_name = Column(String, primary_key=True)
    kind = Column(String, nullable=False, default="string")  # bool|int|float|enum|string
    default_value = Column(String, nullable=False, default="")
    help = Column(Text, nullable=False, default="")
    plane = Column(Integer, nullable=False, default=1)        # 1 = load switch, 2 = sampler
    applies_to = Column(String, nullable=False, default="all")  # all|moe|dense
    tier = Column(String, nullable=False, default="common")    # common|advanced (UI checklist split)
    # A plane-1 switch that is NOT a launch flag: it is resolved + sent per REQUEST (JSON),
    # applies immediately with no reload (reasoning_budget). Additive column — create_all
    # picks it up on an existing DB, no reset. Default False = a normal launch switch.
    per_request = Column(Boolean, nullable=False, default=False)
    # Backend applicability (Pass 2, 2026-07-22): comma-list of engine FAMILIES this
    # knob is meaningful on ("cuda,rocm,vulkan,metal"); "" = every backend. The runner
    # drops inapplicable flags at section construction (the 2026-07-22 incident: the
    # CUDA-tuned no_mmap/placement knobs followed the models onto the cpu engine —
    # no_mmap alone forced qwen's full 22.8 GB resident for zero offload benefit).
    # Additive column (see _ADDED_COLUMNS); the knob seeder syncs it on boot.
    backends = Column(String, nullable=False, default="")
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


# ── feature prompts (DB-seeded, Lab-editable) ─────────────────────────────────
class FeaturePrompt(LlmBase):
    """One feature's prompt — seeded from the host's registered feature-prompt
    DATA, editable in the Lab; the DB is the source of truth. `key` is the action
    id; `feature` is the routing key (several actions can share one)."""

    __tablename__ = "feature_prompts"

    key = Column(String, primary_key=True)
    feature = Column(String, nullable=False, default="")
    system = Column(Text, nullable=False, default="")
    user_template = Column(Text, nullable=False, default="")
    # The JSON CONTRACT stays on the action (the app's parsers are per-action;
    # routing must never break a parser). Every tunable (temperature/top_p/think/
    # reasoning_effort/max_tokens) moved to the engine preset 2026-07-15 — one source.
    json_mode = Column(Boolean, nullable=False, default=False)  # response_format=json_object (#18)
    # C1: optional JSON Schema (text; "" = none). With json_mode on, a valid schema
    # upgrades the weak json_object to schema-ENFORCED output (llama.cpp converts it
    # to grammar; OpenAI json_schema; Ollama format=<schema>; Gemini responseSchema).
    # Action-grain by design: the SHAPE is the feature's contract — presets stay
    # shape-free so they remain reusable across actions.
    json_schema = Column(Text, nullable=False, default="")
    built_in = Column(Boolean, nullable=False, default=True)
    label = Column(String, nullable=False, default="")
    description = Column(Text, nullable=False, default="")
    subgroup = Column(String, nullable=False, default="")  # wire field `group` (GROUP reserved)
    # Display order within the list (2026-08-06, the attribution restore —
    # "Guided, Direct" beats key-alphabetical). 0 = unordered; ties fall
    # back to key order, so hosts that never set it render as before.
    position = Column(Integer, nullable=False, default=0)


# ── engine presets (the Lab's output; the SOURCE OF TRUTH for what runs — the
# 2026-06-29 lab+preset model). A preset = model + frozen switches + params. It is
# assigned to actions by their `feature_preset_refs` row, with the `default_preset_id`
# global default for unassigned actions (2026-07-15 one-source: the task tier is gone). The
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
    reasoning_effort = Column(String, nullable=False, default="")  # "" | low | medium | high | xhigh | max
    # Thinking on/off is a STORED field (U2-T3, 2026-07-14: the old
    # `think = bool(reasoning_effort)` DERIVATION dies). A preset owns whether its task
    # reasons; `reasoning_effort` above is the LEVEL ("ask"), resolved against the
    # per-provider `reasoning_map` + the local hardware cap by `llm/reasoning.py`. Seeded
    # True on p_chat (the one thinking task).
    think = Column(Boolean, nullable=False, default=False)
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


class FeaturePresetRef(LlmBase):
    """A per-ACTION preset assignment — the action's `preset_id` pointer, THE one
    source of what an action runs (2026-07-15: the task tier is gone). Resolution:
    this ref → the global default (`default_preset_id` RunnerSetting). Absent → the
    action falls to the default. `key` is the ACTION id, so writerAI.continue and
    writerAI.tighten point independently. Every seeded action ships a ref."""

    __tablename__ = "feature_preset_refs"

    key = Column(String, primary_key=True)
    preset_id = Column(String, ForeignKey("engine_presets.id", ondelete="CASCADE"), nullable=False)


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


# Additive column migrations (SQLite): `create_all` creates missing TABLES but not
# missing COLUMNS, so a schema field added after a DB already exists never lands
# without a reset. Each entry is `(table, column, "SQL type + default")`; applied
# idempotently (skipped when the column is already present). Additive only — never
# a drop/rename (those still go through a reset, the pre-production schema path).
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("model_catalog", "mtp_builtin", "BOOLEAN NOT NULL DEFAULT 0"),
    ("model_catalog", "est_vram_mb", "INTEGER"),
    # Fit-redesign Phase 2 (§13.11) — the physics facts, additive:
    ("model_catalog", "block_count", "INTEGER NOT NULL DEFAULT 0"),
    ("model_catalog", "n_kv_heads", "INTEGER NOT NULL DEFAULT 0"),
    ("model_catalog", "head_count", "INTEGER NOT NULL DEFAULT 0"),
    ("model_catalog", "embedding_length", "INTEGER NOT NULL DEFAULT 0"),
    ("model_catalog", "expert_used_count", "INTEGER NOT NULL DEFAULT 0"),
    ("model_catalog", "expert_byte_share", "REAL NOT NULL DEFAULT 0"),
    ("model_catalog", "kv_windowed_bytes_per_token", "REAL NOT NULL DEFAULT 0"),
    ("model_catalog", "kv_global_bytes_per_token", "REAL NOT NULL DEFAULT 0"),
    ("model_catalog", "sliding_window", "INTEGER NOT NULL DEFAULT 0"),
    # U2-T2 (2026-07-14; the model_catalog `thinking` column died with the
    # tier system 2026-08-07 — an old DB's leftover column is unmapped, inert):
    ("engine_presets", "think", "BOOLEAN NOT NULL DEFAULT 0"),
    # Pass 2 (2026-07-22, backend-honest resolution):
    ("knob_catalog", "backends", "VARCHAR NOT NULL DEFAULT ''"),
    ("model_tunes", "backend", "VARCHAR NOT NULL DEFAULT ''"),
    ("model_measurements", "backend", "VARCHAR NOT NULL DEFAULT ''"),
    ("feature_prompts", "position", "INTEGER NOT NULL DEFAULT 0"),
)


def _migrate_add_columns(engine) -> None:
    """Idempotently `ALTER TABLE ADD COLUMN` for every `_ADDED_COLUMNS` entry whose
    column is missing — so an existing DB gains a new field on boot without a reset."""
    from sqlalchemy import inspect as sa_inspect, text

    insp = sa_inspect(engine)
    existing_tables = set(insp.get_table_names())
    with engine.begin() as conn:
        for table, column, decl in _ADDED_COLUMNS:
            if table not in existing_tables:
                continue  # create_all just made it with the column already present
            cols = {c["name"] for c in insp.get_columns(table)}
            if column in cols:
                continue
            conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {column} {decl}'))


def create_all(engine) -> None:
    """Create every LLM table on the host's engine (idempotent) + apply additive
    column migrations so an existing DB gains new fields without a reset."""
    LlmBase.metadata.create_all(bind=engine)
    _migrate_add_columns(engine)


metadata = LlmBase.metadata
