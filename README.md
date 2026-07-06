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

## How a model's launch config derives (the 4-tier doctrine, 2026-07-06)

**Which model QuickSetup picks (Phase 3):** the wizard first consults the seeded
**class→model map** (`model_class_picks`, served as `classPicks` on
`GET /v1/ai/model-catalog`) — the row with the largest `min_vram_mb ≤` the detected
VRAM whose model exists and fits wins; with no matching row it falls back to the §10
speed-floor rule (most capable model that still streams fast). The map's contents are
research-refreshed seed data (ledger C9), never logic.

Every local llama-server launch resolves its flags in four tiers, strongest last:

1. **Our estimate — admission only, never emitted.** `compute_fit` projects VRAM for the
   arbiter's reservation and the Fit badges; when a placement knob is not explicit, the
   estimate is NOT written into the launch (see tier 3).
2. **Upstream engine fit — placement by omission.** An UNTUNED model's section/argv omits
   `n-gpu-layers`/`n-cpu-moe`, so llama-server's own `--fit` (default-on at the pinned
   build) places tensors dense-priority at our pinned context. `ctx-size` is ALWAYS
   emitted — context is a product decision (`min(trained ctx, kv_affordable)` when no one
   set it): the engine's fit would reduce context before offloading experts, the wrong
   preference for a writing app.
3. **User-set values — presets / per-request overrides.** Anything set explicitly renders
   exactly, which per upstream semantics disables engine fitting for that arg.
4. **Measured tunes — per (model, machine), always win.** Saved by the Tune modal or the
   auto-tune sweep. The sweep compares explicit candidates against the model's CURRENT
   launch (baseline) and saves only a STRICT winner beyond the 5% tie band — a tie never
   overwrites the baseline, so an untuned box keeps the engine's fit and a tuned box
   keeps its tune. If a fit-placed launch fails for any reason, the runner retries once
   with the explicit computed placement before the ordinary failure handling.

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
- `scripts/seed-facts-audit.py` — standalone stdlib tripwire for the seeded
  model catalogs (runner `DEFAULT_CATALOG` + JustWrite's extra rows): per row
  the HF repo must exist, the seeded license must match the repo's tag AND its
  declared `base_model`'s tag (de-circularized — a repackager mislabel flags
  instead of self-confirming), and the quant / MTP-draft files must be in the
  tree. Network — run it at any seed change and in sessions; not CI-gated.

The shared Vue GUI lives here too: **`ui/` (`@delebash/llm-ui`)** — plain-JS Vue
SFCs both apps consume via a Vite source alias (peer deps: vue, pinia, reka-ui,
marked, vue-sonner; see `ui/package.json`). It ships the LLM views (providers /
models / prompts / usage), the `Ui*` primitive + shell layer (`ui/src/common/`),
and the shared AI task queue — the `useAiTasksStore` in-flight registry (Pinia),
the `runAiFeature`/`runAiFeatureStream` wrappers over `/v1/ai/run`+`/v1/ai/stream`,
`friendlyAiError`, and the `AiTaskStrip`/`AiStatusPanel`/`AiStatusButton` surfaces.
The model-picker family (C5) adds `useProviderModels` (THE per-provider model-list
cache — one cache + one endpoint accessor kit-wide), the presentational
`LuFeatureChip` routing chip (host owns state), and the embeddings client
`embedTexts`/`ensureEmbeddingReady`.

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
