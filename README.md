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

**Which model QuickSetup picks (§9 final ruled shape, 2026-07-22):** a model with a
**PC class config for THIS box's class** wins — the visible PC-class-config library IS the
recommendation (the distinct `(model, class)` pairs ride `GET /v1/ai/model-catalog`
as `classTuneRefs` + `myClassKey`; candidates pass the §10 guards and rank by the
shared quality comparator). No config for the class → the §10 speed-floor rule (most
capable model that still streams fast). The box's class is `vram<GB>|ram<GB>`,
detection overridable via `classKeyOverride` on `/v1/ai/engine-config` ("detection
proposes, never dictates"). The old hidden `model_class_picks` table is deleted —
one visible table answers both "which model" and "which launch config".

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
- `runner/config.py` — the engine DEFAULTS as module constants: pinned llama.cpp build,
  per-platform binary assets, VRAM safety margin, download knobs. A host seeds these into
  its DB where they become user-editable; `default_config()` serves them straight for
  standalone use. (This was `runner-manifest.json` until A7 — config is data, and data
  belongs in the DB. The file is gone; the *model catalog* half of it is host-owned now,
  which is why an unwired `/models` is empty.)
- `schema.py` — camelCase pydantic contract (`RunnerConfig`, `ModelEntry`, `HardwareInfo`).
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
# pyproject.toml of the consuming app / sidecar
dependencies = ["llm-runner @ git+https://github.com/delebash/just-llm-runner.git@v0.1.0"]
```
```bash
# dev: editable
pip install -e ../just-llm-runner
```

### Three mounting tiers — pick the smallest one that does what you need

The library is not all-or-nothing, and the tier decides what you must supply.

**1. Runner only** — hardware detection, engine install, model download/spawn. No storage,
no host wiring:

```python
import llm_runner
app.include_router(llm_runner.router)          # /v1/llm-runner/*
```

Working immediately: `/hardware`, `/config`, `/engine/*`. **`/models` returns an empty list**,
because the model catalog is host-owned and nothing has supplied one — the response says so
via `catalogWired: false` and the server logs it once. This is the only tier with no
SQLAlchemy anywhere in its path.

**2. Runner + your own catalog** — the above, plus models you can actually download and load,
with the catalog coming from wherever you keep it (JSON, TOML, a dict — any callable):

```python
from llm_runner.runner.lifecycle import configure_service
from llm_runner.runner.schema import ModelEntry, RecommendedFor

configure_service(
    catalog_fn=lambda: [ModelEntry(id="…", name="…", hf_repo="…", quant="…",
                                   recommended_for=RecommendedFor())],
    cache_root=str(my_data_dir / "ai-cache"),   # ALWAYS pass this — see below
)
```

Call it ONCE at boot, before the first `get_service()`. Every host-specific input is an
injected callable, so no database is implied.

**3. The whole stack, one call** — providers, dispatch, prompts, presets, tunes, usage
ledger, the DB-backed catalog. This is what JustWrite mounts:

```python
from llm_runner.llm import install_llm
install_llm(app, engine=…, session_factory=…, feature_catalog=…, feature_prompts=…,
            data_dir=my_data_dir)
```

**Tier 3 requires your app to be a SQLAlchemy app.** `engine` and `session_factory` are
SQLAlchemy objects, and the shipped stores are the only implementation — each router factory
takes a Protocol, so a non-SQLAlchemy host *can* implement its own store per router, but it
is writing those itself (JustVoice does exactly this, for `ProviderStore` alone). Tiers 1
and 2 carry no such requirement.

**Always pass `cache_root` / `data_dir`.** With neither, the engine and every downloaded GGUF
land in `~/.cache/just-llm-runner` — outside your app's data root, so a user who deletes your
app leaves tens of GB behind, and a backup of your data dir silently misses the models.

### After changing dependencies or any `__init__.py`

```bash
python scripts/check-clean-install.py     # ~40 s, builds a throwaway venv
```

The suite runs on JustWrite's interpreter, where every host dependency already exists, so it
**cannot** see a missing dependency or an eager storage import. This script can: it installs
the package alone with only its declared dependencies and imports every module, then removes
SQLAlchemy and asserts the storage-free core still imports. Both halves have been watched
failing. Not CI — a script you run.

## Status
The shared stack is live in both apps (JustWrite fully; JustVoice pending
convergence). Current state + open work: the outstanding master plan in
`docs/plans/` (kept twice-verified). The test suite is ~710 tests and runs on
JustWrite's venv (this repo has none of its own — see `CLAUDE.md`):
`../justwrite-app/.venv/Scripts/python.exe -m pytest -q`. All green except one
known-bad on Windows, `test_hardware.py::test_pci_gpus_linux_lspci_name_match`,
which exercises a Linux `lspci` path.

SPDX-License-Identifier: MIT
