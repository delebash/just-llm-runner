# just-llm-runner

Shared **local-LLM runner core** for **JustVoice** and **JustWrite**.

Detects hardware → manages/recommends GGUF models → downloads the right
prebuilt **llama.cpp** (CUDA runtime bundled — *no toolkit install*) →
spawns **`llama-server`** (OpenAI-compatible). One implementation, used by
both apps, so detection/recommendation/flags never drift.

**Internal library — NOT published to PyPI/npm.** Consumed as a **git
dependency** (pinned tag) or via editable/path install during dev. The end
user never installs it: it's frozen into each app's bundle (PyInstaller →
Tauri sidecar). See `docs/plans/2026-06-16-builtin-llm-runner.md` in the
JustVoice repo for the full architecture + decision history.

## What's here (Python core)
- `llm_runner.router` — mountable FastAPI router (both apps `include_router`).
- `runner-manifest.json` (camelCase) — the shared, drift-prone data: pinned
  llama.cpp build, per-platform binary assets, GGUF model catalog, flag
  presets, VRAM-fit recipe.
- `schema.py` — camelCase pydantic contract (`RunnerManifest`, `HardwareInfo`).
- `hardware.py` — self-contained detection (platform, NVIDIA GPU+driver+VRAM,
  AMD/Intel rows via sysfs/registry, RAM, runtimes). No CUDA toolkit needed —
  detection only.
- `binary.py` — select + download + unpack the llama.cpp binary for the
  detected hardware (github archives, per-variant dirs + spawn fallback chain).
  Docker rows are never auto-selected: no pin-faithful container exists for the
  pinned build (upstream ships rolling tags only), so Linux+NVIDIA uses the
  pinned Vulkan build; the container route returns when a digest-pinned image
  is captured at a pin bump.
- `download.py` — streaming download (progress + cancel).
- `models.py` — GGUF acquisition: resolve real filenames from the HF tree by
  `quant` (+ `mmproj` sidecar), stream into the HF cache layout llama.cpp
  loads from (blobs/snapshots/refs). Idempotent; no `huggingface_hub` dep.
- `gguf.py` — minimal GGUF header reader (architecture, layer count, embedding
  dim, expert count) — the structural inputs to the VRAM-fit math.
- `runner.py` — VRAM-fit (`-ngl` / `--n-cpu-moe` from detected VRAM), flag
  composition from the manifest presets, and `llama-server` spawn with
  probe-and-back-off on CUDA OOM (lifecycle: start/stop/health/url).

The shared Vue GUI (`llm-ui`, npm) will live here too once built.

## Consume it
```toml
# pyproject.toml of JustVoice / JustWrite sidecar
dependencies = ["llm-runner @ git+https://github.com/delebash/just-llm-runner.git@v0.1.0"]
```
```bash
# dev: editable
pip install -e ../just-llm-runner
```

## Status
The shared stack is live in both apps (JustWrite fully; JustVoice pending
convergence). Current state + open work: the outstanding master plan in
`docs/plans/` (kept twice-verified). The test suite runs with
`python -m pytest` — several hundred tests, all green at every commit.

SPDX-License-Identifier: GPL-3.0-or-later
