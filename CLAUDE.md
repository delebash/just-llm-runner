# just-llm-runner

The shared **local-LLM runner core** for **JustWrite** and **JustVoice**: detects hardware,
manages and recommends GGUF models, downloads the right prebuilt llama.cpp (CUDA runtime bundled,
no toolkit install) and spawns `llama-server`. The shared **Vue UI kit** lives here too, in `ui/`
(`@delebash/llm-ui`).

**Internal library — never published to PyPI or npm.** Both apps consume it as a git dependency
(pinned tag) or an editable install; it is frozen into each app's bundle (PyInstaller → Tauri
sidecar).

> **A change here lands in BOTH apps.** There is no per-app copy of any of this — that is the
> entire point of the repo. Before changing a Python contract or a `Ui*` primitive, consider what
> it does to JustWrite *and* JustVoice.

## Commands

This repo has **no venv of its own** — `llm_runner` is editable-installed into JustWrite's venv,
so its suite runs on that interpreter:

```bash
cd E:/Dev/Web/just-llm-runner
../justwrite-app/.venv/Scripts/python.exe -m pytest -q      # 713 pass, ~45s
../justwrite-app/.venv/Scripts/python.exe -m ruff check .   # lint (line-length 100, py310)
python scripts/check-clean-install.py                       # ~40s — run after ANY dep or __init__ change
```

**The suite runs where every host dependency already exists, so it is blind to a whole class
of defect.** `check-clean-install.py` is the counterpart: it builds a throwaway venv, installs
this package with ONLY its declared dependencies, imports every module, then removes
SQLAlchemy and asserts the storage-free core still imports. Both halves have been watched
failing.

`python -m pytest` with a bare interpreter picks up whatever is first on PATH — on this box a
stock `F:\Python312` with none of the dependencies — and dies at collection with
`No module named 'google'`. That reads as broken config; it is a missing install.

**Known-bad on Windows:** `tests/test_hardware.py::test_pci_gpus_linux_lspci_name_match` fails —
it exercises a Linux `lspci` path. One failure is expected here; a second is not.

The `ui/` kit has its own `package.json` and is consumed by both apps through a Vite **source**
alias, not a build — there is no publish step to run.

## Invariants that bite

- **Dependencies stay light — no ML.** No torch, no transformers. The JustWrite sidecar bundle size depends on it; the three vendor SDKs (openai, anthropic, google-genai) were an explicit ruling, not a precedent for adding more.
- **`pyproject.toml` must list what the code imports — and only `check-clean-install.py` can tell you.** `sqlalchemy` was missing for the repo's whole life. Nothing caught it because nothing could: both host apps declare it themselves, so the import always resolved by coincidence of the HOST's dependency list, and the suite runs on JustWrite's venv. Measured cost when it was finally tested in a clean venv: `llm_runner.llm` and `llm_runner.platform` both failed to import, taking **11,773 of 19,720 lines** with them. A library's real environment is a fresh app, not its biggest consumer.
- **A package `__init__` must never eagerly import the storage layer.** `llm/db.py` and `platform/data_api.py` are the ONLY files here that touch SQLAlchemy, but the `__init__`s pulled them in on the way to everything else — so one dependency made the adapters, dispatch, registry, tiers and schema unimportable, none of which touch storage. Both `__init__`s resolve exports lazily via PEP 562 `__getattr__` now, and check 2 of the clean-install script fails if that regresses.
- **Three mounting tiers, and only tier 3 needs a database** (README "Consume it"): the runner router alone · runner + your own `catalog_fn` via `configure_service` · the whole stack via `install_llm`. `install_llm` takes a SQLAlchemy engine + session factory and the shipped stores are the only implementation, so "drop it into any Python app" is true of tiers 1–2 and conditional at tier 3. Do not describe the one-call install as the only path.
- **An unwired catalog is not an empty one.** `catalog_fn` defaults to returning `[]`, which made "no host wired a catalog" and "your catalog is empty" indistinguishable at `/v1/llm-runner/models`. JustVoice mounted the router and sat in the first state for months unnoticed. The response now carries `catalogWired` and the server logs the unwired case once.
- **Always pass `cache_root` / `data_dir`.** With neither, engine + GGUFs land in `~/.cache/just-llm-runner`, outside the host's data root — so uninstalling the app strands tens of GB and a data-dir backup silently misses the models.
- **`schema.py` is a camelCase pydantic contract** shared with two apps' front ends. Renaming a field is a breaking wire change in both.
- **`runner-manifest.json` is the drift-prone shared data** — pinned llama.cpp build, per-platform binary assets, the GGUF catalog, flag presets, the VRAM-fit recipe. It is data on purpose; prefer a manifest row over a code branch.
- **Launch flags resolve in four tiers, strongest last** (full statement in `README.md`): our estimate is admission-only and never emitted · an untuned model omits `n-gpu-layers`/`n-cpu-moe` so llama-server's own `--fit` places tensors, but **`ctx-size` is ALWAYS emitted** because context is a product decision · user-set values render exactly · measured tunes win, and the auto-tune sweep saves only a STRICT winner beyond the 5% tie band, so a tie never overwrites the baseline.
- **`ui/` IS `@delebash/llm-ui`.** Plain-JS Vue SFCs; `peerDependencies` must list everything the kit imports — `vue-router` and `@floating-ui/dom` were missing until 2026-08-01 and resolved only because both apps happened to carry them (the latter transitively, via reka-ui). Same defect shape as the SQLAlchemy one: a dependency satisfied by the consumer's luck rather than declared. The kit owns the design contract: one `intent` prop encodes role AND style — never add `severity`/`outlined`/`text`. A capability gap gets solved here so both apps get it, never forked into an app.
- **Seeded catalog rows are claims about the world.** `scripts/seed-facts-audit.py` is a stdlib tripwire that checks each row against the HF tree — repo exists, seeded license matches the repo tag AND its `base_model`'s tag, quant and MTP-draft files present. It needs network and is not CI-gated, so run it at any seed change.
- **Detection proposes, never dictates.** The box's class is `vram<GB>|ram<GB>`, overridable via `classKeyOverride` on `/v1/ai/engine-config`.

## Where to look

| For | Read |
|---|---|
| What this is, how flags derive, what each module does | `README.md` (dense and current) |
| Open AI-stack work — THE ledger | `docs/plans/2026-07-06-outstanding-master-plan.md` (§A–J, twice-verified) |
| The current routing/preset model | `docs/plans/2026-07-15-preset-one-source-rewrite.md` (one-source: an action points at ONE engine preset that owns the model and every tunable) |
| Whole-system open work across all three repos | `../justwrite-app/docs/TASKS.md` |
| Per-task history and evidence | `docs/plans/*` — history unless a doc says otherwise; `2026-06-28-MASTER-PLAN.md` is fully historical |

Read branch and working-tree state from git, never from a doc.
