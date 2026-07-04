# Plan — Serving / VRAM manager (router mode + a thin budget arbiter) — IMPLEMENTATION

> **Structure decision (user delegated it 2026-07-04, "you figure out what works best"):** the **serving/VRAM
> manager is ONE plan with phases** (below) — cohesive, all sharing the `fit.py`/`lifecycle.py`/DB seam, each
> phase shipping+verifying on its own. **The JV shared-LLM convergence is a SEPARATE plan** (captured at the end,
> NOT built here). Design source of truth: `just-llm-runner/docs/plans/2026-07-04-serving-vram-manager.md`. THIS
> file is the executable task plan + live tracker. **⛔ LIVE STATUS: APPROVED + IN BUILD (user "go" 2026-07-04;
> Lab per-load-tuning = Option A ephemeral-section re-emit, locked). Phase 1 in progress; tasks #113–117.**
> **Hardened by a 3-checker rules panel 2026-07-04** (architecture-fit · reuse · grounding) — grounding PASS (all
> citations verified accurate), the two FAIL findings folded in full (see "Panel review" §). The approach (router
> mode + thin arbiter + DB→`.ini`) is unchanged and design-approved; the panel fixed the plan's *specification*.

## Context (why this exists)
The app runs multiple model servers contending for one GPU and nothing arbitrates VRAM. Three pains, one root:
(1) **the embedding gap** — the bundled runner is stop-to-switch/one-model, launched without `--embeddings`, so
local RAG "Build index" fails ("provider has no embedding model set", `IndexBuildModal.vue:77`); local embeddings
only work if Ollama/cloud supplies them (seeded routing points at `openai-compat-local` :11434, NOT the bundled
runner — `seed.py:601-608`). (2) **per-task model swap** is a full kill+respawn+reload (~19–21 s measured). (3)
**JV TTS↔LLM** can OOM-collide on one GPU. The fix (design-approved): move the bundled runner to **llama.cpp
router mode** (native multi-model + idle-unload + `.ini` presets) + a **thin fit.py-driven VRAM arbiter**; the
**DB stays the source of truth, the `.ini` is a generated artifact**. This closes the embedding gap (a tiny embed
co-resident with the chat model, routed by model id) and unblocks the model-surface build (#104–112).

## Grounding — verified first-hand this session (file:line; the grounding checker re-confirmed EVERY citation accurate)
- **Runner is single-model today, greenfield on router.** `RunnerService` "owns the single live llama-server"
  (`runner/lifecycle.py:180-184`); `load()` (`:295-308`) → `_run_load` (`:441-490`) spawns ONE server via
  `self._start` (=`process.start_runner`, `process.py:337`); `stop()` (`:331-340`) kills it. `compose_flags`
  (`process.py:239-262`) builds the single-model `-m <gguf>` argv. **Grep confirmed ZERO** router/`.ini`/
  `models-preset`/`models-max`/`sleep-idle` code anywhere (greenfield on that axis).
- **The DB→runner seam** = `_wire_runner_catalog` (`install.py:130-176`) → `configure_service(catalog_fn,
  switches_fn, identify_fn, config_fn=stores.build_runner_config, cache_root)` (`install.py:172-176`).
- **Per-model flags** come from `switch_resolve.resolve_model_switches(model_id)` (`switch_resolve.py:36-65`):
  reads `ModelCatalog.type` (moe|dense) + layers `SwitchPreset`/`PresetSwitch` (`all`→type→hardware) → a
  `{flag_name: flag_value}` dict the runner turns into `process.Overrides` (module docstring `:2-6`).
- **Fit reuse:** `compute_fit` (`process.py:185-236`) → `fit.max_gpu_layers` gives the fitting `ngl`/`n-cpu-moe`
  per model — **but needs the GGUF on disk** (`GgufMeta` + `gguf.stat().st_size`, `lifecycle.py:476-479`).
  `coarse_fit` (`fit.py:75-111`) math is unchanged for budget-aware fit — only the `vram_mb` fed at `api.py:88`.
- **Per-load overrides layering (the Lab affordance — do NOT lose it):** `_run_load` layers user `overrides`
  (`_merge_overrides` `lifecycle.py:456`) + ad-hoc Tune-&-measure `switches` (`:459-460`) ON TOP of the resolved
  base, feeding BOTH `compute_fit` (`:478`) and `start_runner` (`:484`). This is #20's "test `--n-cpu-moe` on your
  own box" (`Overrides` docstring `process.py:56-59`; `LoadRequest`→`Overrides` `api.py:156-168`).
- **OOM back-off is the real safety net** and runs ONLY inside `start_runner` (`process.py:379-410`, ngl-shed on
  a CUDA-OOM/abort). The design measured the `ngl=999` abort on the 8 GB box (§5b).
- **Runner config is DB-backed + editable:** `stores.build_runner_config` (`stores.py:916-945`, read-site
  `:940-942`) reads `RunnerBinary`+`RunnerSetting`; settings seeded `seed.py:201-204`; pinned build `b9644`
  (`config.py:25`); `RunnerConfig` is `llamacpp`+`safety_margin_mb` only today (`schema.py:115-121`).
- **Embed path is provider-scoped + adapter-unchanged:** `POST /v1/ai/embeddings` (`llm/api.py:117-135`) →
  `registry.get(providerId).embed(input, model)` → `OpenAICompatAdapter.embed` (`openai_compat.py:235-246`) →
  `POST {base_url}/embeddings`. `local-llamacpp` base_url `127.0.0.1:8080/v1`, default_model "" (`:44-49`). A
  co-resident embed on :8080 routed by model id needs **NO adapter change** — only the routing default + a
  resident embed section. `nomic-embed-text` is CATALOGUED (`seed.py:147-150`) but NOT on disk (needs download).
  Seeded routing points at `openai-compat-local` (`seed.py:601-608`), not the bundled runner.
- **UI surfaces exist:** `LuRunnerEngine.vue` + `LuModelCatalog.vue` (`:241-259` actions; single-slot note
  `:268` "loading a new one replaces the running one") under `isBuiltin` in `ProviderForm.vue:162-202`;
  `useRunnerModels.js` is the shared poller ("ONE poller, ONE status truth" — consumed by BOTH apps).
- **Download-only exists:** `POST /v1/llm-runner/download` on its own state channel (shipped this session) — the
  mechanism to auto-fetch the embed GGUF.
- **Router mode web-verified 2026-07-04 (current upstream) + live on the user's b9644 box:** launch without `-m`;
  `--models-dir`, `--models-preset <ini>`, `--models-max N` (default 4), `--sleep-idle-seconds S` (default -1 =
  off; on sleep it unloads model+KV from RAM), `--models-autoload`. `.ini`: `[section]`=model id, keys = CLI args
  without dashes, `[*]` global, precedence CLI>per-model>global, preset-only keys `load-on-startup`/`stop-timeout`.
  Control: `GET /models` (status unloaded|loading|loaded|sleeping|failed|…), `POST /models/load {"model":id}`,
  `POST /models/unload {"model":id}`. POST routes by body `"model"`; GET by `?model=`. **The user's big.json test
  proved `--models-preset`+`--models-max 2`+chat/embed routing on b9644.** ⚠ **Auto-unload is UNRELIABLE**
  (llama.cpp Discussion #18939, Issue #23096) → the arbiter drives `/models/unload` EXPLICITLY.

---

## The build — ONE plan, five phases. Ship+verify after P3 (the embedding-gap milestone).

### Phase 1 — Runner → router mode + DB→`.ini` emission (shared `just-llm-runner`)
**1a. Extract ONE flags intermediate FIRST (panel T3 fix — so there is no second renderer).** In `process.py`:
NEW `overrides_to_pairs(ov, fit) -> list[(canonical_key, value|None)]` — the single normalized list covering the
value flags (`_VALUE_FLAGS` `:133-143`), presence flags (mlock/no_mmap/no_kv_offload), the INVERSIONS
(cont_batching→no-cont-batching, context_shift dual-flag `:161-168`), spec_type clearing/branching (`:169-176`),
the fit knobs (ngl/n-cpu-moe/ctx), and a DEFINED `extra_flags` rule (raw passthrough stored as `[flag, value?]`,
`lifecycle.py:152-155` → pair them; a bare toggle → value None). Then TWO thin renderers consume it:
`render_argv(pairs)` (`--flag` / `--flag value` / presence) and `render_ini(pairs)` (`key = value` / `key = true`).
**REFACTOR `compose_flags` (`:239-262`) onto `overrides_to_pairs`+`render_argv`** (behavior-preserving; the
OOM-backoff still calls it). One place to edit a flag's semantics; the emitter can't drift from the spawn.
**1b. `emit_models_ini(entries) -> str`** (consumes `render_ini`). One `[<model_id>]` section per model that is
**resident-intended AND on disk** (a section needs the GGUF for `compute_fit`; catalogued-but-not-downloaded
models are NOT emitted). Section: `model = <gguf_path>` + the `render_ini` pairs (fit + `resolve_model_switches`).
The embed entry adds `embeddings = true` + pooling (confirm the exact ini key at build). Section name = model id.
**1c. `compose_router_argv(...)`**: `--models-dir <hf cache>`, `--models-preset <ini>`, `--models-max <N>`,
host/port, `--sleep-idle-seconds <ttl>` if set. NO `-m`. `compose_flags` (single-model) STAYS (Lab path 1d +
standalone/tests).
**1d. `RunnerService` → router — via a PER-METHOD strict-diff (panel T5 fix; make the diff an explicit task).**
Build a strict-diff table of EVERY `RunnerService` method → its router-mode behavior BEFORE editing. Concretely:
- **`_router`** (long-lived router process) replaces the per-load `_runner`. **Lifecycle:** spawned LAZILY on the
  first `load()`, gated by the SAME engine-present check (`lifecycle.py:469-473` → "engine-not-installed" if
  absent); a change to `models_max`/`sleep_idle` (1e) or the resident set re-emits the `.ini` + reloads the
  affected model (or bounces the router — design §8.2), a config-time action, not per-request.
- **`load(model_id)`** → ensure the section (re-emit if changed) + arbiter (P2c) + `POST {router}/models/load
  {"model":id}`. **`stop(model_id)`** → `POST /models/unload`. The single-load-in-flight guard (`:300-301`)
  becomes per-model (N concurrent-resident within `models_max`).
- **`_state` → a resident-set map** (modelId → {status,url,…}); **`status()`** (`:244`, today reads
  `_runner.is_alive()` + one modelId `:161-163`/`:487`) reads `GET {router}/models`. **Re-spec
  `/v1/llm-runner/status` (`api.py:186-188`)** to a resident-set shape (grep for callers; keep a back-compat
  single-model view if needed).
- **`measure()` (`:342-363`) + `tokenize()` (`:365-378`) RE-HOMED onto the router** — pass the model id in the
  probe body (they use a model-LESS body today `:64`/`:87`) so #20 Tune&measure + b1 prompt-preview
  (`api.py:216-228`) keep working against a router-resident model.
- **Per-load tuning (the Lab, #20) — NOT dropped.** The Lab's transient "load with THESE `overrides`/`switches`
  + measure" (`:456`,`:459-460`; no surface on a by-id load): the Lab re-emits an EPHEMERAL section for that model
  with the tuned pairs + reloads via the router + measures + reverts (ONE serving mechanism). **DECIDED (user 2026-07-04): Option A —
  the ephemeral-section re-emit. `start_runner`/`compose_flags` stay ONLY for standalone/tests, NOT a parallel Lab spawn path.**
- **OOM recovery for router children (highest-risk gap).** `start_runner`'s ngl-shed back-off (`process.py:379-410`)
  runs only in the single-model spawn the router bypasses → a too-high emitted `ngl` aborts a child with no
  recovery (design §5b, the `ngl=999` abort). SPEC: on a child load-failure that looks like OOM (`GET /models`
  status `failed` / `common_fit_params … abort`), re-emit that section at a lower `ngl` (shed step) + reload — a
  router-level back-off mirroring `_BACKOFF_STEP`. The emitter stays conservative (fit yields a fitting ngl); this
  is the net.
**1e. Router config (editable) + OWNERSHIP (panel convergence-risk 3).** Add `models_max: int = 2`,
`sleep_idle_seconds: int = 900` to `RunnerConfig` (`schema.py:115-121`); seed (`seed.py:201-204`); read
(`stores.py:940-942`). **Ownership rule:** DB `models_max` = the CAP/default; the **arbiter works WITHIN it**
(never marks `load-on-startup` beyond the cap) and OWNS which sections are `load-on-startup` — the DB does not
separately own residency. One authority.
**1f. `api.py` resident-set aware.** `/load`,`/stop` per-model; `_status_for` (`:99-113`) + `/status`
(`:186-188`) read `GET {router}/models`; NEW `GET /v1/llm-runner/resident` (resident set + models_max + ttl +
committed/remaining VRAM from the arbiter).
**1g. VERIFY (build-time, pinned b9644, user's box):** `llama-server --help | grep -E 'models|sleep'`; confirm
`/models/load|unload`+`GET /models`. Absent on b9644 → bump `DEFAULT_PINNED_BUILD` (`config.py:25` + reseed), flag user.

### Phase 2 — Thin VRAM arbiter + budget-aware fit (shared) — task #29
**2a. NEW `runner/arbiter.py` — in-process ledger, built ONCE as a SHARED module** (JV consumes it in its own
plan). `reserve(key, vram_mb)->ok` / `release(key)` / `committed_mb()` / `remaining_mb(hw)`; policy
`can_coreside(mb)`, `pick_evict()` (LRU). Reads `hardware.detect()` (the one VRAM authority both apps use) +
`fit.py`. Policy (design §7): **pin the tiny embed resident; TTL-warm the active chat; co-reside more only if
remaining budget holds within `models_max`, else drive an explicit `/models/unload` on the LRU** (never trust
auto-sleep — #18939/#23096). NOTE: shared CODE, but each app's process holds its OWN ledger instance
(cross-APP arbitration is out of scope — design §7.2).
**2b. Budget-aware fit.** `api.py` `_fit`/`get_models` (`:88`) feed `arbiter.remaining_mb()` as `vram_mb` instead
of the whole detected VRAM. **`coarse_fit` math UNCHANGED** (design §5c).
**2c.** The runner's `load()` consults the arbiter before `/models/load` (reserve → load, or evict-LRU-then-load).

### Phase 3 — Embeddings wired (co-resident) — CLOSES THE GAP · first shippable milestone (P1+P2+P3)
**3a.** The emitted `.ini` carries the embed model's `[<embed_id>]` section (`embeddings = true` + pooling); the
arbiter pins it `load-on-startup`. `/v1/ai/embeddings` (`llm/api.py:117-135`) is UNCHANGED — already routes
provider→:8080/v1/embeddings→router→embed child by model id (proven on the user's box).
**3b. Auto-download the embed GGUF (panel gap 5 fix).** nomic is only CATALOGUED, not on disk — so before the
arbiter can pin it resident, ensure it is fetched via the existing `POST /v1/llm-runner/download` (own channel).
Only then is P3's "works out of the box" true.
**3c. Point local RAG at the bundled runner.** When the bundled provider is the embedding provider, resolve
`routing.default_embedding_id = "local-llamacpp"` + `default_embedding_model = <embed id>` (today `seed.py:601-608`
points at `openai-compat-local`). A sensible default (nomic) so RAG works out of the box; the full embed PICKER UI
stays in model-surface #107/#108. Then `IndexBuildModal.vue:77` guard (`ai.embeddingModelFor`, `ai.js:113-117`)
resolves non-empty.
**3d. VERIFY (user's box):** end-to-end RAG "Build index" + a Chat-with-book query via the bundled runner with the
chat model also resident. → **First user-verifiable ship; model-surface #104–112 unblocks here.**

### Phase 4 — UI (resident set + TTL) (shared kit)
**4a.** `LuRunnerEngine.vue`: add a "resident models" view (loaded/sleeping set + `models_max` + TTL, reading
`/v1/llm-runner/resident`); edit the two DB-backed knobs there. Add a help/user-doc entry for the two operator
knobs + residency (panel T11).
**4b.** `LuModelCatalog.vue` (`:241-259`) + `useRunnerModels.js`: status/actions become resident-set-aware (a
model can be loaded/sleeping/unloaded independently; drop the single-slot assumption `:268`). **This mutates a
SHARED kit component both apps consume** → P5 adds a JV UI smoke, not just import (panel convergence-risk 4).

### Phase 5 — Verify + docs + rules-checker (CONTINUOUS — each phase ships green)
- Per phase: runner `ruff`+`pytest`; JW `build:vite`+headless smoke (0 JS errors); **JV real BOOT check — boots +
  spawns NO router** (grep JV for any runtime call to `/v1/llm-runner/{load,models,status}`; JV mounts the router
  inertly) **+ a JV UI smoke** for the shared `useRunnerModels`/`LuModelCatalog` change (panel gaps 6 + risk 4);
  live curl + user-box runtime (router flags on b9644, embed routing, swap speed). **rules-checker on the diff
  before each commit.** Update the design doc (incl. the §7.2 correction), `MORNING_RECAP.md`, this plan's live
  status. Commit per-repo on `claude/admiring-galileo-il3q0o`, push `-u`. No PR unless asked.

## Panel review (2026-07-04) — findings folded (transparency)
A 3-checker rules panel (architecture-fit · reuse · grounding) reviewed the first draft. **Grounding: PASS** —
all 30+ file:line citations verified accurate, zero drift (author's prior-plan-doc errors did NOT recur; the
this-session re-grounding held). **Two FAILs, all folded above:** (T3, reuse) the `.ini` emitter would be a
SECOND rendering of the flags contract — folded via the shared `overrides_to_pairs`+`render_argv`/`render_ini`
(1a). (T5, both) the single→router refactor silently dropped `measure`/`tokenize`/`status`/OOM-recovery AND the
Lab's per-load tuning — folded via the per-method strict-diff, re-homed probes, resident-set `_state`, router OOM
back-off, and the ephemeral-section Lab path (1d). Plus: `models_max`/`load-on-startup` dual-ownership resolved
(1e), embed auto-download added (3b), router lifecycle specified (1d), JV lazy-spawn boot-check + JV UI smoke
(P5). The approach itself was unchallenged. **One item was the user's call — now RESOLVED:** the Lab
per-load-tuning path = Option A, ephemeral-section re-emit (user chose it 2026-07-04) — 1d.

## Reuse (rule #3 — no second copies)
The shared `overrides_to_pairs`+`render_argv`/`render_ini` intermediate (compose_flags AND the ini emitter consume
it) · `resolve_model_switches` (per-model flags) · `compute_fit`/`fit.max_gpu_layers` (per-model ngl) ·
`hardware.detect()` (the one VRAM authority) · `build_runner_config` + `RunnerSetting` (router knobs, DB-backed) ·
the existing `POST /v1/llm-runner/download` (embed fetch) · the unchanged `local-llamacpp` adapter +
`/v1/ai/embeddings` · `LuRunnerEngine.vue`/`LuModelCatalog.vue`/`useRunnerModels.js`. The `.ini` is DERIVED from
the DB (never hand-edited/read back), matching `schema.py:117`.

## Open items / flags (surface, don't decide)
- **Lab per-load-tuning path (1d)** — DECIDED: Option A, ephemeral-section re-emit (user 2026-07-04).
- **P1g pinned-build confirm** — router flags/endpoints on b9644 via `--help`; bump build if absent.
- **Auto-unload unreliable** (#18939/#23096) — arbiter drives explicit `/models/unload`.
- **Embed-picker UI boundary** — this plan = serving + a working default; the picker UI stays in #107/#108.
- **Defaults** `models_max=2`, `sleep_idle_seconds=900` — DB-editable starting points, tune on the box.

## Verification (end-to-end)
Container: runner ruff+pytest (incl. the `overrides_to_pairs`/render round-trip + `emit_models_ini` + the strict-diff
methods), JW build:vite+headless smoke, JV ruff+pytest+**boot-check (spawns no router)**+UI smoke, reseed. User's
box (runtime): `llama-server --help` router-flag confirm; router boots from the emitted `.ini`; `GET /models` shows
chat+embed resident; `POST /v1/embeddings {"model":<embed>}` returns a vector while chat is resident; RAG
Build-index + Chat-with-book via the bundled runner; a per-task load/unload round-trip; a Lab tune-&-measure still
works; a deliberately-too-high ngl triggers the router OOM back-off. Rules-checker PASS on each phase diff.

## Out of scope (of THIS plan)
Model-surface build #104–112 (unblocked here, its own plan) · the embed-picker UI (#107/#108) · measured per-tier
benchmarks (#28) · llama-swap / a bespoke supervisor (rejected, design §11) · **all JV changes** (separate plan below).

---

## FUTURE — JV shared-LLM convergence (a SEPARATE plan, NOT built here) — captured so nothing is lost
The user (2026-07-04) scoped JV LLM work beyond a VRAM hook. Recorded for its own plan:
1. **Figure out the JV LLM GUI** — how it works today and what to rework once JV runs the shared LLM.
2. **Remove JV's own LLM stack + replace with the shared runner** — JV today mounts only the BARE runner router
   (`app.py:190-201`, NO `install_llm`/`configure_service`) and runs a bundled `qwen3_llm` engine as a subprocess
   via `EngineManager` (`local_managed.py` bridges it into the shared registry). Convergence = drop JV's own LLM
   engine and wire JV onto the shared runner + provider stack, matching JW.
3. **Special speaker-extraction features** (`extraction/` + `refinement.py`) — keep + port LATER ("maybe a later todo").
- **The arbiter hook lands here:** JV's single choke point `EngineManager.load()` (`manager.py:1117-1235`)
  consults the shared `runner/arbiter.py` (built in P2), reserving by each engine's static `vram_min_mb`/variant
  `vram_mb` (`manifest.py` per engine; `model_catalog.py:320-337`) BEFORE `proc.spawn()` (`manager.py:1199-1203`;
  release on `prior.terminate()` `:1186` + `unload()` `:1242-1271`). Covers JV's local LLM (`local_managed.py:43`);
  external cloud LLMs bypass the manager.
- ⚠ **DESIGN-DOC CORRECTION owed (rule #6 — user notified 2026-07-04):** design §7.2 says "JV TTS runs in-process
  → one in-process ledger tracks the models." **Verified FALSE** — JV runs every local engine (TTS/STT/LLM) as a
  **separate OS subprocess** (`manager.py:1-14`, spawn `:824-834`) with **zero VRAM accounting**; JV's `CLAUDE.md`
  "PyTorch engines run in-process" is stale (`app.py:350-351`). The arbiter still works (reserve-by-manifest-vram
  before spawn), but the mechanism differs — fold this correction into design §7.2 when the JV plan is written.
- **JV facts verified:** JV consumes ZERO embeddings (reserved-empty `embedding` slot); one process per kind-slot
  {tts,stt,llm,embedding}, same-kind eviction only, cross-kind never budget-checked; both apps read VRAM from
  `llm_runner.runner.hardware.detect()` (JV via `system_info.py:18`).
