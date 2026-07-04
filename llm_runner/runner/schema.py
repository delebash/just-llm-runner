# SPDX-License-Identifier: GPL-3.0-or-later
"""camelCase schemas — the shared contract for the runner.

Two groups:
  - The `runner-manifest.json` shapes (RunnerManifest etc.) — the
    data-only, drift-prone catalog both apps read.
  - HardwareInfo — what `hardware.detect()` returns; drives binary +
    model selection.

camelCase on the wire (user decision 2026-06-16): Python attrs stay
snake_case; `CamelModel` aliases them via `to_camel` with
`populate_by_name=True`. Emit camelCase with `.model_dump(by_alias=True)`.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


# ─── Hardware ───────────────────────────────────────────────────────────


class GpuInfo(CamelModel):
    vendor: str
    name: str
    vram_mb: int | None = None
    driver: str | None = None
    compute_cap: str | None = None   # NVIDIA compute capability, e.g. "7.5" | "12.0" (Blackwell)


class HardwareInfo(CamelModel):
    os: str                      # raw platform.system(), e.g. "Windows"
    platform: str                # normalized: "windows" | "macos" | "linux"
    cpu_cores: int = 0
    ram_mb: int = 0
    gpus: list[GpuInfo] = []
    runtimes: dict[str, bool] = {}   # "cuda" | "metal" | "rocm" | "vulkan"


# ─── llama.cpp binary distribution ──────────────────────────────────────


class BinaryAsset(CamelModel):
    """One prebuilt llama-server distribution, selected by platform + gpu.

    `asset_url` is a direct archive URL (GitHub-release `.zip` on Windows,
    `.tar.gz` on macOS/Linux) that contains `server_exe`; OR `source="docker"`
    + `image` (Linux CUDA has no prebuilt archive). `runtime_url` is an OPTIONAL
    companion archive unpacked into the SAME dir — the Windows CUDA builds do
    NOT bundle the CUDA runtime DLLs (`cudart-*`); those ship as a separate
    download that must sit alongside `llama-server.exe` for it to launch. No
    CUDA-toolkit install is ever required; we only detect + pick the right build.
    """

    platform: str
    gpu: str                 # "cuda12" | "cuda13" | "metal" | "cpu" | "vulkan" | "rocm"
    source: str = "github"   # "github" | "docker"
    asset_url: str | None = None
    runtime_url: str | None = None   # companion (e.g. cudart DLLs) unpacked alongside
    image: str | None = None
    sha256: str | None = None
    server_exe: str = "llama-server"


class LlamacppSpec(CamelModel):
    pinned_build: str        # EXACT release tag (never "latest")
    binaries: list[BinaryAsset] = []


# ─── Model catalog ──────────────────────────────────────────────────────


class RecommendedFor(CamelModel):
    min_vram_mb: int | None = None


class ModelEntry(CamelModel):
    """A GGUF option. Tiered; the actual pick is benchmark-driven. All from
    HuggingFace — `hf_repo` is an HF org/repo; the runner resolves real
    filenames from the HF tree at download time using `quant`.
    """

    id: str
    name: str
    tier: str                       # "cpu" | "low-vram-moe" | "mid" | "high"
    candidate_for: list[str] = []
    hf_repo: str
    quant: str
    mmproj: str | None = None
    total_params: str | None = None
    active_params: str | None = None
    mtp: bool = False
    pooling: str = ""               # embedding pooling ("" | mean | cls | last | rank) — emitted onto the embed `.ini` section (#119)
    min_ram_mb: int | None = None
    recommended_for: RecommendedFor = RecommendedFor()


# ─── Runner config (binaries + the VRAM safety margin) ──────────────────
# Was `runner-manifest.json`; now DB-backed (seeded built_in) + injected as a
# RunnerConfig — NO config file on disk (user decree 2026-06-27: "it's just
# data, mark it built_in"). The base/moe/dense flag presets moved ENTIRELY to the DB
# `switch_presets` (resolved into `Overrides` via the runner's switches_fn), so
# compose_flags no longer carries them; the dead `vram_fit.tiers` and the always
# empty `models` are gone (the catalog is DB-backed via catalog_fn).


class RunnerConfig(CamelModel):
    """The runner's load-time config: which llama.cpp build/binaries to use and
    the VRAM safety margin. Built from the DB (host) or the seed defaults
    (standalone) — never read from a file."""

    llamacpp: LlamacppSpec
    safety_margin_mb: int = 1024
    # Router mode (P1e): count-based co-resident cap (`--models-max`) + native
    # idle-unload TTL in seconds (`--sleep-idle-seconds`; 0 disables). DB-editable;
    # the arbiter (P2) works WITHIN models_max.
    models_max: int = 2
    sleep_idle_seconds: int = 900


# ─── Model catalog view (GET /v1/llm-runner/models) ─────────────────────


class RunnerModelInfo(CamelModel):
    """One catalog model, annotated for the GUI: a coarse hardware Fit
    indicator + live load/disk status. `fit` is a coarse pre-download estimate
    (params × quant, or an explicit `minVramMb` override) vs detected VRAM — NOT
    a precise score (that needs the downloaded GGUF; see `compute_fit`)."""

    id: str
    name: str
    tier: str
    params: str | None = None       # totalParams, e.g. "35B"
    active_params: str | None = None
    min_vram_mb: int | None = None
    min_ram_mb: int | None = None
    fit: str                        # "ok" | "tight" | "no" | "cpu" | "unknown"
    status: str                     # "loaded" | "loading" | "error" | "disk" | "available"
    downloaded: bool = False


class RunnerModelsResponse(CamelModel):
    vram_mb: int = 0                # max detected GPU VRAM (0 = CPU only)
    ram_mb: int = 0
    safety_margin_mb: int = 1024
    models: list[RunnerModelInfo] = []


# ─── Resident set (GET /v1/llm-runner/resident) ─────────────────────────
# The LIVE router view: which models are actually resident/sleeping RIGHT NOW
# (router mode co-resides up to models_max), read from the router's `GET /models`.
# Distinct from the catalog view above (all downloadable models + coarse Fit) and
# from the back-compat single-model `/status` (which the existing UI polls). The
# per-model VRAM budget (committed/remaining) lands here in P2 (the arbiter).


class ResidentModel(CamelModel):
    """One model as the router currently reports it. `status` is the router's own
    lifecycle word (loaded | sleeping | loading | failed | unloaded) OR an in-flight
    service word (downloading | starting) for a load not yet visible to the router.
    The size fields come from the router's `meta` block on a LOADED child (absent
    until loaded) — the real resident footprint vs the pre-download catalog estimate."""

    id: str
    status: str
    n_params: int | None = None      # meta.n_params (real param count once loaded)
    size_bytes: int | None = None    # meta.size (resident weight bytes)
    n_ctx: int | None = None         # meta.n_ctx (the child's context window)
    vram_mb: int | None = None       # GPU-resident VRAM the arbiter reserved for this model (P2)


class RunnerResidentResponse(CamelModel):
    """The live resident set + the two operator knobs that bound it + the arbiter's VRAM budget.
    `router` is whether the long-lived router process is up (it spawns lazily on the first load).
    The VRAM fields are the in-process arbiter's ledger (P2): committed = Σ reserved, remaining =
    detected − committed (0 on a CPU-only box)."""

    router: bool = False
    models_max: int = 2
    sleep_idle_seconds: int = 900
    vram_total_mb: int = 0
    committed_mb: int = 0
    remaining_mb: int = 0
    models: list[ResidentModel] = []


# ─── Load request (POST /v1/llm-runner/load) ────────────────────────────


class LoadRequest(CamelModel):
    """Body for POST /v1/llm-runner/load. `modelId` is the only required field;
    the rest are optional Plane-1 engine overrides for tuning/testing a load (see
    docs/plans/2026-06-24-llamacpp-switches.md). Any omitted field falls back to
    the computed Fit / the manifest's base flag preset. camelCase on the wire
    (modelId, nGpuLayers, cacheTypeK, …); maps 1:1 to runner.process.Overrides."""

    model_id: str
    # Optional legacy override hook: when set, a host-supplied function may
    # replace the base switches wholesale. Unused by JustWrite, which resolves a
    # model's switches from its type baseline (resolve_model_switches) + the
    # per-Task engine_presets config. Kept for API back-compat.
    job_id: str | None = None
    # Fit knobs.
    n_gpu_layers: int | None = None
    n_cpu_moe: int | None = None
    ctx_len: int | None = None
    # Engine flags (None = keep base preset / llama default).
    cache_type_k: str | None = None
    cache_type_v: str | None = None
    flash_attn: str | None = None
    no_mmap: bool | None = None
    mlock: bool | None = None
    no_kv_offload: bool | None = None
    batch_size: int | None = None
    ubatch_size: int | None = None
    threads: int | None = None
    threads_batch: int | None = None
    parallel: int | None = None
    cont_batching: bool | None = None
    context_shift: bool | None = None
    cache_reuse: int | None = None
    spec_type: str | None = None
    spec_n_max: int | None = None
    extra_flags: list[str] = []
    # Ad-hoc Plane-1 switches for #20 "Tune & measure" (the model-card KnobGrid):
    # a {flag_name: value} map converted server-side by the SAME
    # lifecycle._switches_to_overrides used for stored switches (unknown keys →
    # extra_flags), layered LAST — over the named fields above AND the model base.
    # These are transient tuning inputs (measure-only), not saved per-model — a
    # tuned config persists per-Task in engine_presets via the Lab.
    switches: dict[str, str] | None = None
