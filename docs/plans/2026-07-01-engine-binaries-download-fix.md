# Engine binary download — root-cause fix, chip-aware selection, progress, editable config (2026-07-01)

## Why this change exists
A user on Windows with an RTX 2070 SUPER (CUDA) reported that clicking **Download &
load** on a model failed: the status pill went "llama.cpp binary" → "failed", with
no progress bar and no explanation. This was root-caused to a real, data-level bug in
the runner (not the environment), then broadened, at the user's direction, to make the
whole detect→download path correct cross-platform, chip-aware for CUDA, observable
(progress bar), and user-editable so a moved/renamed release asset can be fixed without
a code change ("nothing should be hardcoded"). Every asset name and CUDA/Blackwell fact
below was verified this turn against the GitHub releases API and NVIDIA documentation,
not from memory.

## Root cause — two layers
The download path is `lifecycle._run_load` (which acquires the llama.cpp binary first,
then the model weights) → `binary.acquire_binary` → `download.stream_download`.

Layer 1 was the binary asset table (`runner/config.py` `DEFAULT_BINARIES`). The Windows
CUDA rows pointed their `asset_url` at `cudart-llama-bin-win-cuda-12.4-x64.zip`. That zip
is the CUDA **runtime DLLs only** — it does not contain `llama-server.exe`. So the
download succeeded, the unzip succeeded, and then `binary._find_server_exe` returned None
and `acquire_binary` raised `RuntimeError: llama-server.exe not found` — surfacing to the
GUI as the bare word "failed". Separately, the CPU and macOS rows had filenames missing
the build token (`llama-bin-win-cpu-x64.zip` rather than the real
`llama-b9644-bin-win-cpu-x64.zip`), so they 404'd; the macOS asset is actually a `.tar.gz`
while `_unzip` only handled `.zip`; and the table had no Linux-CPU, no AMD/ROCm, and no
Vulkan rows at all, so on those systems `select_binary` returned None and the load failed
with "no llama.cpp binary configured".

Layer 2 was detection. `hardware.detect()` only ever set `runtimes["cuda"]` (when
nvidia-smi was present) and `runtimes["metal"]` (on macOS). It never detected AMD or
Vulkan, and `binary._gpu_preference` always emitted `cuda12`, never `cuda13`. So even after
the table was completed, an AMD box would silently fall back to the CPU build, and the CUDA
version was never chosen by the actual GPU. Adding table rows without adding detection would
have been hollow, so detection is part of this fix.

Two smaller gaps rode along: `_run_load` never passed an `on_progress` callback into either
acquire call and the status dict carried no byte counters, so there was nothing for a
progress bar to read; and the catalog UI rendered the bare word "failed" without ever
fetching `status.error`, so the user could not see why a load failed.

## The corrected, verified asset table (release b9644)
Every filename was confirmed present on the release via
`GET api.github.com/repos/ggml-org/llama.cpp/releases/tags/b9644`. The build tag is now
interpolated into each filename (single source of truth: bumping `DEFAULT_PINNED_BUILD`
rewrites every URL). Windows assets are `.zip`; macOS and Linux are `.tar.gz`.

- windows / cpu → `llama-{b}-bin-win-cpu-x64.zip`
- windows / cuda12 → `llama-{b}-bin-win-cuda-12.4-x64.zip` + runtime `cudart-llama-bin-win-cuda-12.4-x64.zip`
- windows / cuda13 → `llama-{b}-bin-win-cuda-13.3-x64.zip` + runtime `cudart-llama-bin-win-cuda-13.3-x64.zip`
- windows / rocm → `llama-{b}-bin-win-hip-radeon-x64.zip`
- windows / vulkan → `llama-{b}-bin-win-vulkan-x64.zip`
- macos / metal → `llama-{b}-bin-macos-arm64.tar.gz`
- linux / cpu → `llama-{b}-bin-ubuntu-x64.tar.gz`
- linux / rocm → `llama-{b}-bin-ubuntu-rocm-7.2-x64.tar.gz`
- linux / vulkan → `llama-{b}-bin-ubuntu-vulkan-x64.tar.gz`

The Windows CUDA line in the release notes is explicitly two downloads — the build zip
(which has the exe) plus the separate "CUDA X DLLs" (`cudart-*`) — and both must be
unpacked into the same directory for `llama-server.exe` to launch. That is why `BinaryAsset`
now carries an optional `runtime_url` companion (a single nullable field: there is exactly
one cudart companion, only for the two Windows CUDA rows). linux/cuda keeps its
`source="docker"` row because llama.cpp publishes no prebuilt Linux CUDA archive — that is a
pre-existing, separate gap, and `acquire_binary` still raises a clear NotImplementedError for
it. Arch edge-cases that detection does not distinguish (macOS Intel x64, Windows/Linux
arm64) are handled by the new editable engine panel, which is exactly why the user asked for
it.

## Chip-aware CUDA selection
NVIDIA's `nvidia-smi --query-gpu=compute_cap` returns the GPU's compute capability (for
example 7.5 for a Turing RTX 2070, 8.9 for Ada, 12.0 for a consumer Blackwell RTX 5090, and
10.0 for datacenter Blackwell). Blackwell (compute capability ≥ 10.0, i.e. sm_100 / sm_120)
requires CUDA ≥ 12.8 (PTX 8.7), so our 12.4 build cannot target it and must use the 13.3
build; older cards run on both, so they default to 12.4 for the broadest driver
compatibility, and an unknown capability also defaults to 12.4. `detect()` now adds
`compute_cap` to the nvidia-smi query (falling back to the base three-field query on an old
driver that rejects the field, so the GPU is never lost), and `binary._cuda_key()` chooses
`cuda13` when the maximum detected compute capability is ≥ 10.0, else `cuda12`.

## AMD / Intel: ROCm/HIP first, Vulkan fallback (user decision 2026-07-01)
On a box with no NVIDIA GPU, `detect()` now probes for an AMD GPU (lspci on Linux; HIP_PATH
or the video-controller name on Windows) and, when one is present, sets `runtimes["rocm"]`
if a ROCm/HIP runtime is installed (rocminfo, hipInfo, HIP_PATH, or /opt/rocm), otherwise
`runtimes["vulkan"]` if a Vulkan loader is present. Because `_gpu_preference` already orders
rocm before vulkan before cpu, this delivers "ROCm/HIP first when its runtime is there,
Vulkan as the universal fallback" — and, critically, it avoids downloading the Windows HIP
build (which needs the AMD HIP SDK) on a machine that could not run it. These probes only run
when no NVIDIA GPU was found, so the common NVIDIA path pays nothing. AMD VRAM detection for
the Fit estimate, Intel discrete-GPU routing, and a spawn-time backend retry chain are noted
follow-ups; the editable panel covers those cases manually today.

## Progress bar
`download.stream_download` now reads `Content-Length` and calls
`on_progress(downloaded, total)`; `acquire_model` reports cumulative bytes against the summed
grand total of all selected files, and `acquire_binary` forwards progress for both the build
and its cudart companion. `lifecycle._run_load` passes a callback into both acquire calls that
writes live `downloaded` / `total` counters into the pollable status, which the GUI renders as
a real progress bar. The catalog also now surfaces the actual `status.error` instead of the
bare word "failed".

## Editable engine config (nothing hardcoded)
`runner_binary` and `runner_setting` were already DB-backed and seeded from the module
defaults, but there was no way to edit them. A new `llm/runner_config_api.py`
(`make_runner_config_router`, following the same `make_*_router(get_store)` convention as
pricing) exposes `GET /v1/ai/engine-config` (which re-serves the same data as the read-only
`/v1/llm-runner/config`, flattened for the editor), `PUT /v1/ai/engine-config` (upsert
binaries by platform+gpu, set the pinned build and the VRAM safety margin), and
`POST /v1/ai/engine-config/reset` (restore the shipped rows and settings, preserving any
user-added custom rows). The host-side `RunnerConfigStore` in `stores.py` reads through the
existing `build_runner_config()` and writes the two tables. The runner reads the same rows
live, so an edit takes effect on the next load with no restart.

## Schema change → reset required
`RunnerBinary` gained a `runtime_url` column. Because the project drops-and-reseeds on schema
changes (no migrations pre-release), an existing install must **Reset workspace** to pick up
both the new column and the corrected seed URLs. The dev DB in this environment is rebuilt via
`POST /v1/data/reset`.

## Verification
`ruff check` and `pytest` pass (200 tests). New/updated coverage: `test_binary.py` (the CUDA
cudart companion is fetched; `.zip` and `.tar.gz` both unpack; every cross-platform row
resolves; the CUDA build is chosen by compute capability — Blackwell → cuda13, older → cuda12),
`test_models.py` (2-arg progress against the grand total), `test_hardware.py` (compute-cap
parse with old-driver fallback; AMD ROCm-first / Vulkan-fallback routing; CPU-only), and
`test_runner_config_store.py` (get / upsert / set-setting / reset, preserving custom rows).
Honest limits: the multi-gigabyte assets cannot be pulled through the dev proxy (signed-S3
401) and there is no GPU in this environment, so download correctness rests on the
API-verified asset names plus the unpack/companion/progress/detection unit tests, with live
GPU verification on the user's own machines.
