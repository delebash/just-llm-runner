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

    `asset_url` (a direct GitHub-release zip — official Windows CUDA builds
    bundle cudart; macOS Metal builds) OR `source="docker"` + `image`
    (Linux CUDA). The CUDA RUNTIME is bundled inside the asset — there is
    NO CUDA-toolkit install; we only detect + pick the right build.
    """

    platform: str
    gpu: str                 # "cuda12" | "cuda13" | "metal" | "cpu" | "vulkan" | "rocm"
    source: str = "github"   # "github" | "docker"
    asset_url: str | None = None
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
    min_ram_mb: int | None = None
    recommended_for: RecommendedFor = RecommendedFor()


# ─── Flag presets + VRAM-fit ────────────────────────────────────────────


class TurboquantPreset(CamelModel):
    experimental: bool = True
    fork: str | None = None
    flags: list[str] = []


class FlagPresets(CamelModel):
    base: list[str] = []
    mtp: list[str] = []
    turboquant: TurboquantPreset = TurboquantPreset()


class VramFit(CamelModel):
    safety_margin_mb: int = 1024
    tiers: dict[str, int] = {}


class RunnerManifest(CamelModel):
    schema_version: int = 1
    llamacpp: LlamacppSpec
    models: list[ModelEntry] = []
    flag_presets: FlagPresets = FlagPresets()
    vram_fit: VramFit = VramFit()


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


# ─── Load request (POST /v1/llm-runner/load) ────────────────────────────


class LoadRequest(CamelModel):
    """Body for POST /v1/llm-runner/load. `modelId` is the only required field;
    the rest are optional Plane-1 engine overrides for tuning/testing a load (see
    docs/plans/2026-06-24-llamacpp-switches.md). Any omitted field falls back to
    the computed Fit / the manifest's base flag preset. camelCase on the wire
    (modelId, nGpuLayers, cacheTypeK, …); maps 1:1 to runner.process.Overrides."""

    model_id: str
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
    cache_reuse: int | None = None
    spec_type: str | None = None
    spec_n_max: int | None = None
    extra_flags: list[str] = []
