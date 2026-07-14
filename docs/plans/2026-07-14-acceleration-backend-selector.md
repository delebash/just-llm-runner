# Acceleration-backend selector (user-choosable CUDA / Vulkan / Auto)

**Date:** 2026-07-14 · **Status:** implemented (this session) · **Scope:** `just-llm-runner` (runner + kit), consumed by JustWrite + JustVoice.

## Problem

The AI page showed a hardware readout — `CUDA (in use) · VULKAN available` — that
**read as a picker but had no control behind it.** Backend selection was derived
purely from detected hardware (`binary._gpu_preference`, order metal→cuda→rocm→
vulkan→cpu), with:

- **No user override** anywhere (no config field, no load param, no API param).
- On an **NVIDIA box only the CUDA variant is installed** (`_run_install` plants
  Vulkan only on a ROCm pick; CPU builds retired) — so the A3 spawn fallback chain
  is length 1 and Vulkan can never actually run, by preference *or* by fallback.
- `engine_status` reported a single selected gpu — no notion of installed vs active
  vs merely driver-supported.

So a user whose CUDA is broken (or who simply prefers Vulkan) had no path.

## Design

A **backend override** the user pins as a GPU *family* (`cuda`/`vulkan`/`rocm`/
`metal`; `""` = Auto). Variants already coexist on disk (`<build>/<gpu>/`) and
`acquire_binary(gpu=…)` can install one specifically — so a switch is:

1. **Install the chosen variant on demand** (explicit — it's a multi-hundred-MB
   download) via the existing engine-install endpoint given a `gpu` family.
2. **Pin `preferred_gpu`** (a new `runner_setting`), which `_gpu_preference` moves
   to the FRONT of the order — so `select_binary`, the spawn chain, and status all
   prefer it. A pin whose runtime isn't present degrades silently to Auto.
3. **Manual restart** (`POST /v1/llm-runner/stop`) applies it — the next model
   load spawns on the new backend. Manual so a running generation isn't yanked.

### Decisions (user took the recommendations)

- **Explicit variant download** on select (not silent auto-fetch).
- **Manual apply-&-restart** (confirm dialog), not auto-restart.
- **Per-variant uninstall deferred** — engine uninstall stays whole-build.

## What shipped

**Runner:**
- `runner/schema.py` — `RunnerConfig.preferred_gpu: str = ""`.
- `runner/binary.py` — `gpu_family()` + `concrete_gpu()` helpers; `_gpu_preference(hardware, preferred="")` fronts the pinned family; `select_binary` / `acquired_server_exes` thread `config.preferred_gpu`.
- `runner/lifecycle.py` — `engine_status()` now reports `installedGpus`, `activeGpu`, `preferredGpu`, `offerBackends`; `install_engine`/`_run_install` accept a `gpu` family → targeted variant ADD (no force-wipe, no stale-build sweep).
- `runner/api.py` — `engine/install` reads `gpu` from the body.
- `llm/stores.py` — `build_runner_config` reads `preferred_gpu`; `get_config` returns `preferredGpu`; `reset_to_defaults` clears it.
- `llm/runner_config_api.py` — `EngineConfig`/`EngineConfigUpdate` carry `preferredGpu`; PUT validates (`""|cuda|vulkan|rocm|metal`).

**Kit UI:**
- `ui/src/composables/useEngine.js` — `setBackend(family)`: install variant if missing → pin → confirm restart; exported.
- `ui/src/components/LuRunnerEngine.vue` — an "Acceleration backend" `UiSelect` (Auto + offerable families, "— will download" when a variant isn't installed) + a "running on …" active indicator; shown only when >1 backend is offerable.
- `ui/src/views/AiModelsArea.vue` — interim readout reword `… available` → `… (supported)` so the hardware strip stops implying a phantom choice (the real switch lives in the engine panel).

## Verification

- Runner: `ruff` clean; **200 tests pass** (binary/config/lifecycle/runner_config_store/runner); functional check confirms `preferred=vulkan` → vulkan selected, undetected pin → degrades to auto.
- Kit: `build:vite` clean; headless render check on `#/ai` — selector renders (Auto default, "running on NVIDIA CUDA"), zero JS errors.
- **Not yet confirmed live:** the full CUDA→Vulkan switch (download + restart + spawn on Vulkan) needs the Python server restarted to load these changes, plus a real Vulkan download on a Vulkan-capable box. Flagged for the user to confirm in the real app.
