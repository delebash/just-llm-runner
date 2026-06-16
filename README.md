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
  RAM, runtimes). No CUDA toolkit needed — detection only.
- `binary.py` — select + download + unpack the llama.cpp binary for the
  detected hardware (github-zip wired; Linux-CUDA docker is a later item).
- `download.py` — streaming download (progress + cancel).

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
P1.1 (manifest + schema + endpoint) and P1.2 (binary acquisition) done.
Next: P1.3 model download, P1.4 spawn + VRAM-fit, P1.5 provider registration.

SPDX-License-Identifier: GPL-3.0-or-later
