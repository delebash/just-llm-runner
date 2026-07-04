# Plan — Serving / VRAM manager (router mode + a thin budget arbiter) — IMPLEMENTATION

> **Structure decision (user delegated it 2026-07-04, "you figure out what works best"):** the **serving/VRAM
> manager is ONE plan with phases** (below) — cohesive, all sharing the `fit.py`/`lifecycle.py`/DB seam, each
> phase shipping+verifying on its own. **The JV shared-LLM convergence is a SEPARATE plan** (captured at the end,
> NOT built here). Design source of truth: `just-llm-runner/docs/plans/2026-07-04-serving-vram-manager.md`. THIS
> file is the executable task plan + live tracker. **⛔ LIVE STATUS: APPROVED + IN BUILD (user "go" 2026-07-04;
> Lab per-load-tuning = Option A ephemeral-section re-emit, locked). Phase 1 IN PROGRESS (tasks #113–117):
> 1a–1c DONE + tested — shared `overrides_to_pairs`/`render_argv`/`render_ini` (`compose_flags` refactored onto
> it, behavior-preserving), `emit_models_ini` (+ `ModelIniEntry`), `compose_router_argv`; ruff + 230 pytest green
> (rules-checker flagged a T5 coverage gap on the context_shift/spec/extra-flag branches → tests added + the
> `extra_flags` negative-value edge fixed; re-checked PASS). **1d/1e DONE** — the `RunnerService`→router refactor (lazy `_router` +
> `_resident` set · DB→`.ini` emission · re-homed measure/tokenize · router OOM back-off · Option-A Lab tuning) + the two
> `RunnerConfig` knobs; ruff clean, 238 pytest. A rules-checker FAILED the first cut (T1 stop-during-load ghost race · T3
> Runner/RouterHandle + is_cached duplication · T5 the `GET /models` reconciliation dropped-but-unflagged) → ALL folded
> (cancellation re-check + a race test · `_ServerHandle` base + `is_cached` delegate · deviations + the synchronous-load
> assumption recorded in §"AS-BUILT DEVIATIONS" + runtime-unknown #2). **P1f DONE + SHIPPED (2026-07-04, box-grounded
> "go"; ruff clean, 253 pytest; rules-checker FAIL(3)→folded→re-run PASS):** the load-confirmation poll
> (`_default_router_models` client + `_parse_router_models` reading the box-verified NESTED `data[].status.value` + `meta`;
> `_confirm_load` polls `GET /models` until `loaded|sleeping` = success / `failed`|dead-router|timeout = error, keyed off
> status NOT the HTTP raise, per the async box finding) wired into `_router_load_with_backoff` — which now sheds ngl ONLY on
> a genuine CUDA-OOM log signal (`_looks_like_oom(tail)`), a non-OOM failure fails FAST with no router bounce (rules-checker
> T1 fix; see AS-BUILT). A resident-set-aware `get_models._status_for` reads `service.resident()` (live `GET /models`
> per-model + the download overlay + an `error` in-flight overlay so an engine-not-installed load still shows `error` —
> rules-checker T5 fix); NEW `resident()` + `GET /v1/llm-runner/resident` (`router` up · `models_max`/`sleep_idle_seconds` ·
> per-model status + `meta` sizes) + the `RunnerResidentResponse`/`ResidentModel` schema. `/status` STAYS single-model (3 UI
> consumers read it that way: `useRunnerModels`/`QuickSetup`/`TuneMeasureModal`) — supersedes the plan §1f "`/status` reads
> GET /models". KNOWN limitation deferred to P2: `_router_lock` is held across the ≤300s confirm poll (no correctness bug —
> checker-confirmed no ghost/leak; P2's arbiter restructures this path). **P2 DONE + SHIPPED (runner `6644d35`; user "go"
> 2026-07-04):** the thin VRAM arbiter — `runner/arbiter.py` (in-process ledger: reserve/release/touch/committed_mb/
> remaining_mb/can_coreside/count/pick_evict(exclude)/snapshot/reserved_mb/clear, per-app singleton) + budget-aware fit
> (`api.py get_models` feeds `remaining_vram_mb()` when VRAM isn't card-overridden; `fit.py` math UNCHANGED) + `_run_load`
> admit→evict-LRU→reserve (release on stop/error); a plain re-load of a LIVE running model is idempotent (guarded on
> `overrides==Overrides()` AND `router.is_alive()`). Policy §7.1: pin the tiny embed (wired in P3), TTL-warm the active chat,
> co-reside if the remaining budget holds within `models_max` else evict the LRU. A reservation = the GPU-resident VRAM
> (`FitPlan.vram_mb`, `n_gpu==0`→0), NOT the full weight size (a MoE offloads experts to CPU RAM). Rules-checker
> FAIL(1+4)→fold→FAIL(dead-router)→fold→**PASS**; ruff clean, 282 pytest. FULL detail + all decisions/limitations + the
> pre-existing QuickSetup `?vramMb` no-op (flag for #107) in §"P2 AS-BUILT". **P3 DONE + BUILT (2026-07-04; user "go"; the FIRST
> user-verifiable ship):** co-resident embeddings — local RAG "Build index"/"Ask the book" works OUT OF THE BOX on the bundled
> runner (auto-download nomic + load co-resident + PIN so a chat co-load never evicts it + serve /v1/embeddings by id).
> Trigger = LAZY on first RAG use (user-chosen): a runner `POST /v1/llm-runner/ensure-embedding` JW calls (via its ONE embed
> choke point `embedTexts`), then polls `/resident` until loaded|sleeping. Embed identity from routing
> (`default_embedding_id == local-llamacpp` → `{default_embedding_model}`, a new `embedding_ids_fn` seam wired in install.py);
> the `.ini` embed section (`embeddings = true` + pooling) set in ONE post-pass over ALL emit paths; `reserve(pinned=True)`;
> `seed_default_routing` repoints the embed default → local-llamacpp + nomic (LLM default unchanged — that's #107). PIN-MECHANISM
> DEVIATION from plan §3a "load-on-startup": achieved via the arbiter pin + ensure_embedding + bounce-preserve, NOT the `.ini`
> load-on-startup key (which would leave a chat-first-spawn embed resident-but-UNRESERVED → a 400-on-reload + spurious bounce —
> verified mechanism) — full rationale + options-considered in §"P3 AS-BUILT". Rules-checker PRE-BUILD **FAIL(3)** (T2
> wrong-rationale · T7 untested-primary-path + all-emit-paths bug · T11 no-doc) → ALL folded BEFORE writing code; ruff clean,
> **291 pytest**, JW build:vite + headless smoke **0 JS errors**. JV `import justvoice.app` fails on a PRE-EXISTING unrelated
> `LLMRolesSettings` schema drift (out of P3 scope; JV-convergence plan). **NEXT — P4** (resident-set + TTL UI, shared kit;
> needs a fresh "go"); P3 §3d end-to-end + P1g router-flag box-verify await the user's box (neither blocks P4).**
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

## P1d/P1e build spec — `RunnerService`→router per-method strict-diff (the panel's T5 artifact; verified first-hand 2026-07-04 against the code cited)

**Approach.** The bundled runner stops owning ONE `llama-server` and starts owning a LONG-LIVED router (`llama-server`
launched via `compose_router_argv`, no `-m`, on the same `127.0.0.1:8080` the `local-llamacpp` adapter already targets
— `openai_compat.py:44`), spawned **LAZILY on the first `load()`** (nothing at boot; both apps still mount the router
inertly). Models go resident/unloaded BY ID through the router's `/models/{load,unload}`; per-model launch flags live in
the emitted `.ini` — **one section per ON-DISK catalog model, each fitted by `compute_fit`** (so any downloaded model is
loadable by id without a re-emit; that is what avoids a bounce on the common co-residence path). Runtime stays green
because `status()` keeps a BACK-COMPAT single-model shape (the full resident-set `/status` + `/resident` is P1f).

**New module-level pieces (`process.py`):**
- `RouterHandle(process, url)` + `is_alive()/health()/stop()` — the router process handle (distinct concept from the
  per-model `Runner`; a clean small dataclass, not a copy — T3).
- `start_router(server_exe, *, models_dir, models_preset, models_max, sleep_idle_seconds, host, port, log_path, _popen,
  _health, _sleep, _now) -> RouterHandle` — `compose_router_argv` (P1c) + `Popen` + `_wait_until_healthy` (REUSED). **NO
  OOM back-off** (the router doesn't OOM; its CHILDREN do — handled at the service level, row 18).

**New module-level router-control client (`lifecycle.py`, injectable like `_default_measure_probe`):**
`_default_router_models(url) -> dict` = `GET {url}/models` (resident-set status map) · `_default_router_load(url,
model_id)` = `POST {url}/models/load {"model": id}` · `_default_router_unload(url, model_id)` = `POST {url}/models/unload
{"model": id}`.

**Reuse add (`models.py`, next to `is_cached` — one source):** `cached_gguf_path(repo, quant, *, cache_root,
mmproj=None) -> Path | None` — mirrors `is_cached` (:118-130) but RETURNS the path, so `_emit_ini` resolves an on-disk
model's GGUF WITHOUT downloading.

**State (`__init__` :202-222):**
| Today | → Router mode |
|---|---|
| `_runner = None` (:216) | REMOVED → `_router: RouterHandle\|None = None` (long-lived) |
| — | NEW `_resident: dict[str,dict] = {}` — model_id → `{status,modelId,url,detail,error,downloaded,total}`; status ∈ downloading\|loading\|loaded\|error |
| — | NEW `_last_id: str = ""` — most-recent load, for the back-compat `status()` primary view |
| — | NEW `_ini_ids: set[str] = set()` — ids currently in the running `.ini` (re-emit only when a load's id is absent) |
| `_state = _idle()` (:214) | REMOVED as a stored field → `status()` DERIVES the primary dict from `_resident.get(_last_id)` or `_idle()` |
| `_start = start` (:213) | KEPT (standalone/tests only, per Option A). NEW injected `_start_router`, `_router_models`, `_router_load`, `_router_unload` (test seams) |
| all others | UNCHANGED (`_download_*`, `_engine_*`, `_switches_fn` [now ALSO feeds `_emit_ini`], `_last_log_path`) |

**Per-member strict-diff (EVERY member — nothing silently dropped):**
1. `cache_root` property (:224) — UNCHANGED.
2. `catalog()` (:231) — UNCHANGED; now ALSO iterated by `_emit_ini`.
3. `config()` (:237) — UNCHANGED; P1e adds `models_max`/`sleep_idle_seconds`, read here.
4. `status()` (:242-246) — CHANGED. If `_router` alive, refresh `_resident` from `_router_models(url)`; RETURN a
   back-compat single-model dict from `_resident[_last_id]` (so `api.py._status_for` + `/status` are UNBROKEN). Router
   dead while a model was loaded → primary `error`.
5. `engine_status()` (:250) — UNCHANGED.
6. `install_engine()` (:272) — UNCHANGED.
7. `engine_log()` (:287) — UNCHANGED (tails `_last_log_path` — now the router or last-child spawn log).
8. `load(model_id, overrides, job_id, switches)` (:295-308) — CHANGED. In-flight guard becomes PER-MODEL
   (`_resident[id].status in (downloading,loading)` → return that; a DIFFERENT model proceeds → co-residence). Set
   `_resident[id]=downloading`, `_last_id=id`; thread → `_run_load` (SAME signature).
9. `download(model_id)` (:310) — UNCHANGED (own channel).
10. `download_status()` (:326) — UNCHANGED.
11. `stop(model_id=None)` (:331-340) — CHANGED. `stop(id)` → `_router_unload(url,id)` + drop `_resident[id]`. `stop(None)`
    → unload ALL resident (back-compat "stop the running model"). Does NOT kill the router (stays lazy-warm; children
    sleep via TTL). api `/stop` (no arg) → stop-all.
12. `measure(*, prompt, max_tokens, probe, sample, model_id=None)` (:342-363) — CHANGED. `model_id` defaults to
    `_last_id`; requires that id resident (`_resident[id].status=='loaded'`). Probe the ROUTER url with `"model": id` in
    the body (`_default_measure_probe` gains the model field — today model-less :64).
13. `tokenize(*, text, probe, model_id=None)` (:365-378) — CHANGED. Same: `model_id` default `_last_id`;
    `_default_tokenize_probe` body gains `"model": id` (today :87 model-less); requires resident.
14. `_main_gguf` (:382) — UNCHANGED (post-download resolve in `_run_load`).
15. `_runner_log_path` (:390) — UNCHANGED; NEW sibling `_router_log_path()` for the router spawn log.
16. `_run_install` (:397) — UNCHANGED.
17. `_acquire_and_identify` (:418) — UNCHANGED (shared load+download IO).
18. `_run_load` (:441-490) — MAJOR CHANGE. Steps 1-5 UNCHANGED (resolve base/user/ad-hoc switches → `ov`;
    engine-present fail-fast gate :469-473; `_acquire_and_identify` fetch; `_read_meta`; `compute_fit`). THEN, instead of
    `self._start(...)`: build a `ModelIniEntry` (id, gguf, fit knobs, `ov`, embeddings=False for P1d) → `_ensure_router()`
    → if `id` not in `_ini_ids`, `_emit_ini()` re-emit + (hot-read else `_bounce_router()` preserving residents) →
    `_router_load(url,id)` → poll `_router_models` until `id` is loaded|failed → **router OOM back-off:** a child that
    fails looking like OOM (status `failed` / `_looks_like_oom`) → re-emit that section at `ngl - _BACKOFF_STEP` + reload
    (mirrors `start_runner` :486-489, which the router bypasses) → set `_resident[id]=loaded, url=_router.url`. Exception
    → `_resident[id]=error` (same terminal shape as :488-490).
19. `_run_download` (:492) — UNCHANGED.
20. NEW `_ensure_router()` — lazy: if `_router` None/dead → `_emit_ini()` → `start_router(...)` (models_max/sleep_idle
    from `config()`) → set `_router`. Idempotent; engine-present already checked by `_run_load`.
21. NEW `_emit_ini() -> Path` — for each ON-DISK catalog model (`is_cached`): `cached_gguf_path` + `_read_meta` +
    `compute_fit`(switches_fn→`ov`) → `ModelIniEntry`; write `emit_models_ini(entries)` to
    `<cache_root>/llamacpp/models.ini`; set `_ini_ids`; return the path. (The DB→`.ini` last mile; generated, never read back.)
22. NEW `_bounce_router()` — capture resident ids → stop router → `_ensure_router()` (fresh `.ini`) → reload the captured
    ids. ONLY when a re-emitted `.ini` isn't hot-read (the runtime unknown below); the common co-residence path never bounces.
23. `configure_service`/`get_service` (:514/:546) — UNCHANGED.

**PRESERVED-behavior checklist (the T5 anti-drop ledger):** OOM recovery (→ row 18, router-level) · measure/tokenize
#20/b1 (→ rows 12/13, re-homed onto router+id) · `status()` API shape (→ row 4, back-compat) · Lab per-load
overrides/switches (→ row 18, `ov` folds into the entry = Option A ephemeral section) · download-only channel (rows
9/10/19 untouched) · engine-install channel (rows 5/6/16) · engine-not-installed fail-fast (row 18).

**P1e (folded in — `_ensure_router` READS these, so they land together):** add `models_max: int = 2`,
`sleep_idle_seconds: int = 900` to `RunnerConfig` (`schema.py:115-121`); seed (`seed.py:201-204`); read in
`build_runner_config` (`stores.py:916-945`). Ownership: DB = the CAP; the arbiter (P2) works WITHIN it.

**THE P1d runtime unknowns (cannot run the router in-container — GitHub egress blocked → P1g box-verify):**
1. Does the router HOT-READ a re-emitted `.ini` on `/models/load` (a new/changed section), or need a restart? Design §8.2:
   "design for re-emit + reload regardless." Implemented as re-emit + reload with a `_bounce_router()` fallback on a
   changed `.ini` (correct either way).
2. **Does `POST /models/load` BLOCK until the child is loaded and return non-2xx on a CUDA-OOM abort?** P1d's
   load-confirmation + the router OOM back-off (row 18) ASSUME it does — `_default_router_load` raises on HTTP ≥400 and the
   back-off sniffs `_looks_like_oom(exc / router-log)`. If instead the router returns 200 then loads/OOMs ASYNC, the
   back-off won't fire and a dead child would report `running`. If the box shows async, add a `GET /models` poll (the
   deferred `_router_models`, see AS-BUILT) in P1f to confirm `loaded` / detect `failed`.
3. `/tokenize` + `/v1/chat/completions` honour the body `"model"` field in router mode.

**BOX-VERIFIED (2026-07-04, b9644) — the `GET /models` schema (unblocks P1f's resident-set read):** the response is
OpenAI-list-shaped — `{"object":"list","data":[{…}]}` — one entry per `.ini` section with `id` = the section/alias name
(what clients request), and `status` an OBJECT: `{"value":"unloaded"|"loading"|"loaded"|"sleeping"|"failed", "args":[…child
argv…], "preset":"…the emitted .ini section text…"}`, plus `need_download:bool` / `owned_by` / `created` / `architecture`
(`input_modalities`/`output_modalities`). **So status is NESTED at `data[].status.value`, NOT a flat `data[].status`** — the
earlier tolerant-parse guess would have been WRONG (vindicates deferring it, rule #7). P1f's `_router_models`/`_status_for`
read `data[].id` + `data[].status.value` (map `loaded`/`sleeping`→resident, `loading`→loading, `failed`→error). Each child
spawns on `--port 0` (random) under `--alias <id>`, router-proxied.

**⛔ UNKNOWN #2 RESOLVED — `POST /models/load` is ASYNCHRONOUS (2026-07-04, b9644):** `POST /models/load {"model":"chatmoe"}`
(a 35B) returned **HTTP 200 in 4 ms** — it cannot have loaded that fast, so the POST is fire-and-forget: it ACCEPTS the
request and the child loads in the background. (An UNKNOWN id returns **404 synchronously**, so the router does use real HTTP
codes — but a VALID id is accepted `200` BEFORE it's loaded.) **CONSEQUENCE — P1d's synchronous assumption is WRONG for this
build → P1f MUST, after `POST /models/load`, POLL `GET /models` until `data[].status.value` is `loaded` (success) or `failed`
(the OOM / fit-abort surfaces HERE, not in the POST's HTTP code); the router OOM back-off (`_router_load_with_backoff`) must
key off `status==failed`, NOT the raise.** As-built P1d sets `running` immediately on the 200 and would never fire the
back-off on an async OOM — the flagged risk, now confirmed (not a crash: `status()` is just optimistic for the ~load-time
window until P1f adds the poll). ALSO observed on the box: an unknown id → **404 sync**; a repeat / at-`models-max` load of
`chatmoetoobig` → **HTTP 400 sync** (body `{"success":true}`, ignore) — so the router CAN reject a load with a 4xx.
**→ FINAL P1f LOAD SPEC (box-grounded):** `_router_load` treats any NON-2xx POST as an immediate failure; on a **2xx
accept**, `_run_load` POLLS `GET /models` (`data[]` where `id==model_id`) until `status.value` is `loaded` (success) or
`failed`/`unloaded` (error → the OOM back-off) or a timeout (error). The exact settled word for an OOM'd child (`failed`
vs `unloaded`) is a 1-curl confirm during P1f dev — the poll handles both. Unknown #1 (`.ini` hot-read) is also a P1f-dev
curl (re-emit a new section, load its id → 404 = needs the `_bounce_router` path, load-OK = hot-read).

**BOX SURPRISE (2026-07-04) — b9644 AUTO-OFFLOADS at ngl=999; the "guaranteed abort" premise is softer than design §5b.**
`chatmoetoobig` (35B-A3B, `n-gpu-layers = 999`, NO `--n-cpu-moe`) loaded to **`status.value:"loaded"`** on the 8 GB card
(real `--port 60364`), NOT `failed` — b9644 gracefully offloads what doesn't fit to CPU RAM instead of the
`common_fit_params … abort` design §5b saw earlier (a different build/scenario). IMPACT: (a) the router OOM back-off
(`_router_load_with_backoff`) stays as the net for a genuine over-fit but will RARELY fire — and is moot in practice since
the emitter already sets a FITTING ngl from `compute_fit`, never 999; (b) a `failed` example could not be forced, so P1f
polls for `loaded` (success) and treats `failed` OR a no-progress timeout as the error path (robust to the exact word).
Also seen: an already-loaded / at-capacity load returns a **non-2xx (400)** — P1f treats ANY non-2xx POST as a failure.
BONUS: a LOADED model's `GET /models` entry carries a **`meta` block** — `{n_params, size, n_ctx, n_ctx_train, n_embd,
n_vocab}` (chatmoetoobig: n_params 35 505 251 456, size 22 842 671 616 B) — useful for the P1f `/resident` view (actual
resident size/params vs the pre-download catalog estimate).

**AS-BUILT DEVIATIONS from the spec above (folded from the rules-checker, 2026-07-04 — recorded so spec≠code drift is not silent):**
- **`GET /models` reconciliation DEFERRED to P1f** → rows 4 & 18 are PARTIAL. The spec's `_default_router_models` client +
  the `status()`/`_run_load` `/models` polling are NOT in P1d — the exact `GET /models` JSON shape is a box-unknown (rule
  #7: don't parse an unverified schema). As-built: `status()` reconciles with `_router.is_alive()` + `_resident`
  (back-compat single-model), and `_run_load` confirms the load via the SYNCHRONOUS `POST /models/load` raise (unknown #2
  above). Only `_default_router_load` / `_default_router_unload` ship in P1d.
- **`_ini_ids` REMOVED** — change-detection uses a whole-`.ini`-text compare (`_last_ini_text`); the id set was write-only.
  `_load_via_router` bounces iff the rendered `.ini` text changed (catalog-stable order → a no-override co-resident load is
  a no-op, no bounce).
- **`_run_load` control flow** consolidated into `_load_via_router` (spawn-if-down / bounce-if-changed / load) +
  `_router_load_with_backoff`; no separate `_ensure_router()` (folded into `_load_via_router` + `_spawn_router`).
- **`start=`/`self._start` REMOVED** (start_runner no longer used by the service; kept in `process.py` for
  standalone/tests). Injected test seams: `_start_router` / `_router_load` / `_router_unload` (no `_router_models`).
- **status vocabulary = `downloading | starting | running | error`** (the single-model runner's words, so
  `api.py._status_for` maps UNCHANGED); measure/tokenize require `status=='running'`.
- **Concurrency (T1 fix)** — `_lock` guards the resident-set queue; `_router_lock` serializes router process ops and is
  held by BOTH `stop()` and `_run_load`'s router section, so a `stop()` during a load's (unlocked) download is caught by a
  cancellation re-check (`if model_id not in _resident: return`) BEFORE any spawn — no ghost router. Covered by
  `test_stop_during_load_leaves_no_ghost`.
- **T3 fixes** — `Runner` + `RouterHandle` share a `_ServerHandle` base (is_alive/health/stop, one source); `is_cached`
  delegates to `cached_gguf_path`.

**P1f AS-BUILT (2026-07-04 — the deferred reconciliation, now box-grounded; ruff clean, 252 pytest; rules-checker FAIL(3)→folded→re-run):**
- **The `GET /models` reconciliation deferred in P1d is now BUILT** (resolves rows 4 & 18). `_default_router_models(url)`
  (GET /models) + `_parse_router_models(payload)` (reads the box-verified NESTED `data[].status.value` + the loaded child's
  `meta` block; tolerates a flat-string/malformed entry). `_confirm_load(model_id)` polls GET /models until `loaded|sleeping`
  (success) / `failed` or dead-router (failed) / deadline (timeout); injected `now`/`sleep`/`router_models` seams poll
  deterministically offline. `_LOAD_POLL_TIMEOUT=300s` (a 70B cold-load headroom), `_LOAD_POLL_INTERVAL=1s`.
- **The load path is now async-correct** — `_router_load_with_backoff` POSTs (2xx accept, async) then CONFIRMS via the poll,
  replacing P1d's optimistic "200 means loaded" (unknown #2, box-confirmed async). A sync 4xx from the POST still propagates
  as a plain load error (bad id / at-capacity — not OOM).
- **OOM back-off is GATED on a CUDA-OOM signal (rules-checker T1 fix — a spec deviation, recorded).** The box-grounded spec
  said "on `failed`/timeout → shed, keyed off status." As-built the shed fires only when `ngl>0` AND `_looks_like_oom(spawn
  log tail)`. WHY the deviation: a NON-OOM `failed` (bad `extra_flags`, corrupt/mismatched GGUF, a rejected flag) re-emits the
  SAME overrides — shedding ngl cannot fix it — and each `_bounce_router` knocks down + reloads EVERY healthy co-resident, so
  a literal "shed on any failed" would bounce residents ~ngl/`_BACKOFF_STEP` times for a guaranteed-to-fail load. So a non-OOM
  failure now fails FAST, no bounce. Residual: whether a router CHILD's OOM text actually reaches the router spawn log
  (`_last_log_path`) is a **P1g box-check** — if it doesn't, the shed won't fire (fail-fast), acceptable because b9644
  auto-offloads an over-fit (loads, not fails), the emitter never emits ngl=999, and P2's arbiter pre-checks fit. Covered by
  `test_router_load_oom_backoff` (OOM log → sheds 20→16→12) + `test_non_oom_failure_does_not_shed_or_bounce` (no OOM log →
  error, spawns==1, ngl stays 20).
- **`api.py` is resident-set aware.** `get_models._status_for` now reads `service.resident()` (the live GET /models per-model
  status) instead of the single-model `status()` — co-resident models each show their own state; a `sleeping` model reads
  `loaded` in the catalog; router-down → all fall through to disk/available. NEW `resident()` service method + `GET
  /v1/llm-runner/resident` (`RunnerResidentResponse`/`ResidentModel`: `router` up · `models_max`/`sleep_idle_seconds` ·
  per-model status + `meta` sizes). **`resident()`'s in-flight overlay surfaces `error` too (rules-checker T5 fix)** — an
  errored load the router never saw (engine-not-installed → no router spawned) would otherwise show `available`, losing the
  catalog error state + the UI's install-engine CTA (`useRunnerModels.needsEngine`). Covered by `test_status_reflects_load_error`
  (api) + `test_resident_surfaces_load_error` (lifecycle).
- **`/status` STAYS single-model back-compat** — three UI consumers read it that way (`useRunnerModels.js`, `QuickSetup.vue`,
  `TuneMeasureModal.vue`), so this supersedes the plan §1f "`/status` reads GET /models"; the resident-set truth is on `/resident`.
- **KNOWN LIMITATION (rules-checker T1 secondary — DEFERRED to P2, not a bug).** `_router_lock` is held across the entire
  ≤300s `_confirm_load` poll (via `_run_load` → `_load_via_router` → `_router_load_with_backoff` → `_confirm_load`), so a
  concurrent `stop()` or a second co-resident load serializes behind it (typically ~20s, worst-case 300s on a stuck load).
  The rules-checker confirmed NO correctness bug — no deadlock, no ghost/leak (the P1d cancellation re-check + shared
  `_router_lock` hold; `test_stop_during_confirm_poll_is_clean` proves a stop() during the poll ends clean). NOT fixed in P1f:
  releasing the lock mid-poll would reintroduce the resurrect/ghost race the checker just cleared, and **P2's arbiter
  restructures this exact load path** (reserve→load→confirm under the ledger), so the lock discipline is redone there. Flagged
  here so the serialization is a known, chosen tradeoff, not silent.

## P2 AS-BUILT (2026-07-04 — the thin VRAM arbiter + budget-aware fit; ruff clean, 282 pytest; rules-checker FAIL→fold→FAIL→fold→re-run)

**What shipped (design §5b/§5c/§7.1).** A NEW `runner/arbiter.py` — `VramArbiter`, an in-process committed-VRAM ledger + the co-residence policy the runner's `load()` consults. Surface: `reserve(key, vram_mb, *, pinned=False)` / `release(key)` / `touch(key)` (LRU freshness) / `committed_mb()` / `remaining_mb(hw=None)` / `can_coreside(mb, hw=None)` / `count()` / `is_reserved(key)` / `pick_evict(exclude=None)` (LRU, non-pinned) / `snapshot(hw=None)` / `reserved_mb(key)` / `clear()`. Thread-safe (`_lock`); a process-wide singleton `get_arbiter()` (+ `set_arbiter()` for tests) — the per-app ledger (design §7.2; JV's `engines/manager.py` consults the SAME instance in the future JV plan, so cross-kind TTS↔LLM budgeting is one in-process ledger, no IPC). A reservation = the **GPU-resident** VRAM (`FitPlan.vram_mb`, added to `process.py`; `compute_fit` computes it forward via `fit.estimate_vram_mb` at the chosen ngl — the SAME KV/head derivation it already had, hoisted, no second path), NOT the full weight size (a MoE offloads experts to CPU RAM). **Integration (`lifecycle.py`):** `RunnerService` gets the arbiter (injectable). `_run_load` — under `_router_lock`, after the P1 cancellation re-check — calls `_admit(id, fit.vram_mb, models_max, hardware)` (evict the LRU non-pinned until it fits the VRAM budget AND `count() < models_max`, accounting for the model's OWN prior reservation via `reserved_mb(id)` + `pick_evict(exclude=id)` so a re-tune never self-evicts or double-counts; PROCEEDS with no eviction when only pinned/nothing evictable — the spawn OOM back-off + the build's CPU auto-offload are the nets), then loads, then `reserve()` ON SUCCESS; `release()` on error (no leaked reservation). `_evict_resident` = `router_unload` + `_resident.pop` + `arbiter.release` + `_last_id` re-home. `stop(id)` releases; `stop()` clears. `measure`/`tokenize` `touch` the LRU. `resident(hw=None)` merges `snapshot(hw)` → committed/remaining/total VRAM + per-model `vram_mb` for `/v1/llm-runner/resident` (`schema.py`: `ResidentModel.vram_mb` + `RunnerResidentResponse.{vram_total_mb,committed_mb,remaining_mb}`). **Budget-aware fit (`api.py`):** `get_models` feeds `service.remaining_vram_mb(hardware)` (= detected − committed) as the Fit VRAM when the request is NOT card-overridden (a `?vram_mb=` card-chooser override is a hypothetical fresh card, used as-is); `coarse_fit` math is UNCHANGED — only the VRAM fed in shrinks by what's already resident (design §5c).

**LOAD-BEARING DECISIONS (recorded so they aren't buried in code):**
- **`n_gpu == 0 → vram_mb = 0` (`compute_fit`).** A fully-CPU load touches no GPU (no CUDA context), so it reserves 0 — NOT the oobabooga formula's ~1.5 GB base offset (which represents an in-use GPU). This also makes the arbiter's VRAM-budget path a NO-OP on a GPU-less box (every reservation 0 → the VRAM check never forces an eviction; the `models_max` count cap still applies).
- **The idempotent re-load guard (`load()`).** A plain re-load of a running model (no tuning) is short-circuited to `touch`+return, to avoid a router 400 "already loaded" that would then error + `release()` a still-resident child (ledger drift). Two subtleties the rules-checker caught: (a) the HTTP path (`api.load_model`) ALWAYS passes an empty `Overrides()`, so "no tuning" must compare `overrides == Overrides()` (dataclass `__eq__`, all-default incl. `extra_flags==[]`), NOT `is None` (dead for HTTP); (b) the guard is gated on `self._router.is_alive()` — a stale `_resident[id]=="running"` after a router crash (which `status()` only reconciles for the `_last_id` primary, not a co-resident like the pinned embed) must FALL THROUGH to `_run_load`'s recovery spawn, else the dead router is never respawned. A re-load also promotes to `_last_id` (matches the non-guard path). A Lab re-tune (real overrides/switches/job) still re-loads (the `.ini` changes → bounce).
- **Release-on-attempted-unload (`_evict_resident`, `stop`).** The reservation is freed on the unload ATTEMPT, not only on a confirmed unload: it guarantees `_admit`'s loop terminates (an un-released victim would keep returning from `pick_evict`), and a failed unload almost always means the child is already gone (a 4xx "not loaded" / router down). The rare "unload failed but still resident" under-counts committed → a possible OOM caught by the spawn back-off + auto-offload.
- **T3 reuse:** the `max((g.vram_mb …), default=0)` reduction is now the ONE `hardware.max_vram_mb(hw)` (arbiter/process/lifecycle delegate) — the arbiter's stated "one VRAM authority" made literal.

**KNOWN LIMITATIONS (flagged, not fixed in P2):** (1) the arbiter LRU sees only load-time + `measure`/`tokenize` touches, NOT live generate traffic (which hits the router's `:8080/v1` directly via the adapter) — for JW's 2-model case (pinned embed + one evictable chat) the LRU order barely matters, and the router-native TTL handles real idle-unload; a usage-aware LRU (a router last-use field) is later. (2) `--sleep-idle-seconds` idle-*unloads* a child (frees VRAM) while the router lists it `sleeping` + the arbiter KEEPS the reservation → `committed_mb` OVER-counts after models sleep — conservative (never OOMs), reconciling against the live sleeping set is P2+. (3) An evict-then-failed-load leaves the victim evicted (collateral) — bounded (evicts the minimum LRU) and rare (the emitter sets a fitting ngl; b9644 auto-offloads). Limitations (1)+(2) are in `arbiter.py`'s module docstring; (3) is in `_evict_resident`'s docstring.

**RULES-CHECKER CYCLE (the required gate, BEFORE the commit):** 1st pass **FAIL (1 + 4)** — (T1) the idempotent guard was DEAD for the HTTP path (`overrides is None` never true from `api.py`) → a re-POST 400 → `release()` on a resident child (ledger drift); (T1) `resident()` re-detected hardware (nvidia-smi) on every poll; (T7) the idempotent test exercised the dead path + branches unpinned; (T2) sleep-drift unflagged; (T1) release-on-attempt undecided. ALL FOLDED. Re-review **FAIL (1)** — the guard fix introduced a NEW hole: no router-liveness check → a re-load of a stale-`running` co-resident after a router crash was swallowed, never respawning the dead router (a recovery regression). FOLDED: the guard now gates on `router.is_alive()` + a `test_reload_respawns_dead_router`; plus the twice-flagged T3 `max_vram_mb` consolidation, the strengthened `test_admit_retune_excludes_own_reservation` (a 2nd co-resident to genuinely pin the `own` add-back), and the `_last_id` promotion. Verified: **ruff clean, 282 pytest** (+ `tests/test_arbiter.py` 13 unit tests + the lifecycle admit/evict/reserve/idempotent/dead-router/re-tune tests + the api budget-aware-fit + `/resident` VRAM tests).

**VERIFIED PRE-EXISTING FINDING (flagged, NOT P2's scope — belongs to model-surface #107 QuickSetup rewire):** the catalog card-override query param is `vram_mb` (the FastAPI arg name), but `QuickSetup.vue` sends `?vramMb=` — probed live: `?vram_mb=99999` is honored, `?vramMb=99999` is IGNORED. So QuickSetup's "re-score Fit for another card" override is a silent no-op today. Not fixed here (scope), recorded so #107 fixes it (add a `Query(alias="vramMb")` or accept both).

**NEXT (P2 remainder / P3):** JV coordination is the SEPARATE future plan (NOT built). P1g's box-verify (router flags, sync-vs-async, child-OOM-log location) still awaits the user's box. **P3** = co-resident embeddings — the arbiter PINS the embed (`reserve(..., pinned=True)`, the mechanism P2 built), auto-downloads nomic, points local RAG at the bundled runner → the first user-verifiable ship (closes the embedding gap; unblocks model-surface #104–112).

## P3 AS-BUILT (2026-07-04 — co-resident embeddings, the FIRST user-verifiable ship; ruff clean, 291 pytest; rules-checker pre-build FAIL(3)→folded→built)

**What shipped (design §5a/§5e/§7.1; closes the embedding gap `2026-07-03-model-setup-simplification.md` §12).** Local RAG "Build index" / "Ask the book" now works OUT OF THE BOX on the bundled llama.cpp runner: a tiny embed model (nomic) is auto-downloaded, loaded co-resident with the chat model, PINNED so it is never the eviction victim, and served at `/v1/embeddings` by id — no Ollama/LM Studio needed for embeddings. `/v1/ai/embeddings` (`llm/api.py:117-135`) is UNCHANGED — it already routes provider→`:8080/v1/embeddings`→router→embed child by id (proven on the user's box, design §8.1).

**Trigger DECIDED by the user 2026-07-04: LAZY on first RAG use** (the alternative was eager-at-boot). The embed downloads + loads + pins the FIRST time JustWrite needs local embeddings, not at boot. WHY lazy: it preserves the deliberate lazy-router design (nothing spawns at boot — P1d), and JustVoice (which uses NO embeddings and does NOT run `install_llm`) stays fully inert — it never downloads nomic or pins an embed. The ~100 MB fetch + child spawn land inside the "Build index" progress flow the user already sees. The mechanism: a runner `POST /v1/llm-runner/ensure-embedding` that JustWrite calls (through its single embed choke point) before the embed request, then polls `GET /v1/llm-runner/resident` until the embed reads `loaded`.

**Runner side (`just-llm-runner`):**
- **Embed identity is derived from routing, one source (`lifecycle.py` + `llm/install.py`).** New injected `embedding_ids_fn` on `RunnerService` (default `_default_embedding_ids_fn` → empty set for standalone; a new `configure_service(embedding_ids_fn=...)` kwarg). `install.py._wire_runner_catalog` wires it from `stores.get_routing_store().get_routing().default`: when `embeddingId == "local-llamacpp"` and `embeddingModel` is set, the set is `{embeddingModel}`; else empty. So the runner learns which catalog id is the embed WITHOUT a new catalog column (that's model-surface #105) — the DB routing config is the single authority.
- **The `.ini` embed section (`lifecycle.py._resolve_ini_entries`).** A single POST-PASS over the resolved entries (`_dc_replace(e, embeddings=True, pooling="mean")` when `e.model_id in embed_ids`) marks the embed section — covering EVERY emit path in one place (the override-in-loop slot, the DB-resolved sections, AND the not-in-catalog fallback insert). This was the rules-checker's T7 fix: a per-branch patch would have missed the fallback-insert path and emitted the embed as a plain chat child, so `/v1/embeddings` would mis-route. `emit_models_ini` (P1b) already renders `embeddings = true` + `pooling = mean`.
- **The pin (`lifecycle.py._run_load`).** The reserve is `pinned=(model_id in embed_ids)` — the embed reserves PINNED (`arbiter.pick_evict` skips pinned, arbiter.py:125), a chat reserves unpinned. So a co-resident chat load evicts the LRU chat, NEVER the embed the index depends on.
- **`ensure_embedding()` + `POST /v1/llm-runner/ensure-embedding` (`lifecycle.py` + `runner/api.py`).** Resolves the embed id; empty → `{"ok": False}` (the caller falls back to its cloud/Ollama provider unchanged); else delegates to `load(embed_id)` (download-if-needed + lazy-spawn the router + reserve pinned via `_run_load`), returning `{"ok": True, "modelId": …, **state}`. Idempotent + cheap when the embed is already resident (the P2 idempotent guard). The load is ASYNC (returns immediately) — the client polls `/resident`.
- **The routing seed repoint (`llm/seed.py.seed_default_routing`).** Fresh installs now seed `default_embedding_id="local-llamacpp"` + `default_embedding_model="nomic-embed-text"` (was both at `openai-compat-local`/Ollama). The LLM default stays Ollama — repointing it at the bundled runner is model-surface #107's QuickSetup scope, NOT P3. Idempotent (the seed only writes a missing row, so an existing user's routing choice is never overwritten).

**JustWrite side (`justwrite-app`):**
- **The lazy ensure lives in the ONE embed choke point (`services/embedApi.js`).** `embedTexts` now calls `ensureEmbeddingReady(providerId, providerType, {signal})` before `POST /v1/ai/embeddings`. When `providerType === "local-llamacpp"` it (module-promise-cached per session, so a burst of index batches triggers it ONCE): `POST /v1/llm-runner/ensure-embedding`, then polls `GET /v1/llm-runner/resident` until the returned `modelId` reads `loaded` OR `sleeping` (parity with the runner's own `_confirm_load`, lifecycle.py:909 — rules-checker T5 note), with a ~180 s timeout for the cold ~100 MB fetch and friendly errors on `error`/`failed`/timeout. A cloud/Ollama provider → a no-op Promise. On a real (NON-abort) embed failure the cache is dropped so a crashed pinned router self-heals on the next attempt; an ABORT does NOT clear a healthy cache (rules-checker T5 note). The three RAG embed callers (`rag/indexer.js:65`, `rag/chat.js:145`, `rag/characterChat.js:155`) each pass `providerType: provider.providerType`.

**PIN-MECHANISM DEVIATION from the plan §3a wording ("pins it load-on-startup") — intent preserved, flagged to the user, verified rationale.** The plan §3a said the arbiter pins the embed "load-on-startup"; design §7.4 explicitly left the `.ini` emission mapping as "build detail, pin at implementation." As-built, "pinned resident" is achieved by (a) the arbiter `reserve(pinned=True)` — the REAL eviction-proof pin; (b) `ensure_embedding` — the reliable explicit loader called before every RAG embed; (c) `_bounce_router` already reloading running residents across a re-tune bounce (lifecycle.py:867-879). The `.ini` `load-on-startup` key is deliberately NOT set for the embed. **The verified reason** (the rules-checker corrected the author's first, wrong rationale): a router-side auto-load via `load-on-startup` never populates `_resident` (only `load()`/`_run_load` do), so the later `ensure_embedding` → `_run_load` → `_router_load` would `POST /models/load` for an ALREADY-loaded id → the router 400s → `_router_load` raises → error + `release()` (the working embed reported as failed AND its reservation dropped); and/or the emitted `.ini` text would flip when `load-on-startup` toggles → a spurious `_bounce_router` that knocks down + reloads the resident chat (~20 s). Dropping `load-on-startup` avoids both and keeps the arbiter ledger exact (the embed is reserved iff resident). The `ModelIniEntry.load_on_startup` field + its `emit_models_ini` branch STAY (a supported emitter capability, still unit-tested at test_runner.py:245) — P3 just doesn't set it; a future eager-pin-at-boot option could.

**OPTIONS CONSIDERED for the pin mechanism (rules-checker T4 note — a real both-sides record):** (1) `.ini load-on-startup=true` + reserve-at-`.ini`-emit — rejected: the reserve-at-emit would reserve a model that may never actually load (over-count), and load-on-startup creates the invisible-`_resident` / 400-on-re-load / spurious-bounce failure above. (2) `ensure_embedding` (explicit load) + `reserve(pinned=True)` + bounce-preserve, NO load-on-startup — CHOSEN: exact ledger, one reliable load path, no re-load-400, no spurious bounce. The design intent ("embed pinned resident, works out of the box") is fully met by (2).

**COUPLING TO PRESERVE (rules-checker T3 note — for model-surface #107/#108).** The whole chain works because `routing.default_embedding_model` == the catalog id == the emitted `.ini` section id == what the client requests at `/v1/embeddings` — all the same string ("nomic-embed-text" for the seed). The future embed-picker UI (#107/#108) MUST keep these equal when it lets the user change the embed model, or the runner will emit/pin one id while the client requests another.

**RULES-CHECKER CYCLE (pre-build, on the spec — the pre-task gate + drift catch).** A single adversarial checker returned **FAIL (3)** BEFORE any code: (T2) the deviation's causal claim was WRONG (it blamed `load()`'s idempotent guard touch-return, but a router auto-load leaves `cur is None` so the guard doesn't fire and load() DOES reserve) → re-derived to the verified 400-already-loaded + spurious-bounce mechanism (above); (T7) the PRIMARY path — the embed emitted as the OVERRIDE (embed-first RAG) — was untested and the fallback-insert emit path would ship the embed unmarked → the single post-pass covers all three paths + `test_embed_own_load_emits_embeddings_section` (override) and `test_chat_load_emits_ondisk_embed_section` (DB-resolved) both assert `embeddings = true`; (T11) no doc deliverable on the first user-verifiable ship → this AS-BUILT + the recap + a user-facing note in `justwrite-app/docs/ai-providers.md` (§Embedding). Folded NOTES: JW poll accepts `loaded|sleeping`; cache-invalidation excludes aborts; the id==section-name coupling recorded; options-considered recorded. T1 PASS (dropping load-on-startup is the correct final shape), T3 PASS (single embed-identity source, `ensure_embedding` reuses `load()` with no second download path, `embedTexts` the true single choke point), T5 PASS (co-residence verified — admit evicts the chat LRU, the pinned embed is skipped; models_max=2 → embed + 1 chat steady state, extra chats rotate, DB-editable, not a surprise). **DIFF re-check on the BUILT code, before commit: VERDICT PASS (all 12 PASS/NA)** — the three pre-build FAILs verified genuinely fixed in code (T2 mechanism traced correct against the real `load()`/`_run_load`/`_router_load` path; T7 the single post-pass covers ALL emit paths + the two named tests assert through the real emitted `.ini` and fail if reverted; T11 docs shipped), no new correctness bugs (the pin/ledger/`_admit` interaction traced: embed reserved once, pinned, never self-evicts; a chat load skips the pinned embed). Non-blocking notes folded: the shared-`_ensurePromise`-binds-the-first-caller's-signal tradeoff got a clarifying comment (embedApi.js); the JW ensure/cache JS logic's zero automated coverage is recorded as limitation (4) below.

**VERIFIED (container):** runner `ruff` clean + **291 pytest** (+9 over P2's 282: 6 lifecycle [ensure no-op, loads+pins, both emit paths, pinned-survives-coresidence, non-embed-unpinned] + 2 api [ensure endpoint configured / not] + 1 seed [routing repoint]). JW `npm run build:vite` clean; **headless smoke — all 24 routes + the AI area + provider-form render, ZERO JS errors** (the embedApi rewrite is inert at boot/route level, firing only on a RAG action). The shared runner imports cleanly and a default `RunnerService` (JustVoice's path) has an empty `embedding_ids_fn` + `ensure_embedding() → {ok:False}` (JV inert, confirmed).

**PRE-EXISTING, OUT-OF-SCOPE finding (honest report, NOT caused by P3):** `import justvoice.app` FAILS — `justvoice/models.py:23` imports `LLMRolesSettings` from `llm_runner.llm.schema`, which no longer exists there. P3 did not touch `llm/schema.py`; this is JustVoice lagging a prior shared-stack schema change — the known JV-convergence drift (the SEPARATE future plan). JV is currently un-bootable against the shared stack regardless of P3; recorded so the JV-convergence plan knows it is more urgent than "later."

**KNOWN LIMITATIONS (flagged, not fixed):** (1) the embed is served on first RAG use, so the very first "Build index" of a session pays the one-time ~100 MB nomic download + child-spawn latency (inside the progress modal) — subsequent builds/chats reuse the pinned resident embed, instant. (2) On a box where a chat model is loaded FIRST and the embed is NOT yet on disk, the embed only becomes resident when `ensure_embedding` runs (before the first embed) — by design (lazy). (3) `models_max=2` means embed + one chat is the co-resident steady state; loading additional chat models rotates the non-pinned chat via the LRU (the pinned embed always stays) — DB-editable if a user wants more co-resident. (4) the JW `embedApi.js` ensure/poll/abort/cache logic has NO automated coverage — JW has no JS unit-test harness (its `test` script runs the desktop e2e suite; the headless smoke is inert for the RAG path). This subtle logic (burst-dedupe, cache-clear-on-real-failure-but-NOT-abort) is traced-correct by the diff rules-checker + will be exercised end-to-end by the §3d box-verify, but it is not covered by a regression test. Adding a JW **vitest** harness (covering this + future renderer logic) is a sensible follow-up — FLAGGED for the user, NOT built in P3 (a new JS test-tooling convention is a project decision, not this phase's scope). The `_resetEnsureCache` export is the seam a future test would use.

**Reuse (rule #3):** `emit_models_ini` embed rendering (P1b) · the arbiter `reserve(pinned=True)` / `pick_evict` skip-pinned (P2) · `load()`/`_run_load`/`_acquire_and_identify` download+load (unchanged — NO second download path) · `RoutingStore` (the one embed-id source) · `embedTexts` (the one RAG embed choke point) · the kit `post`/`get` transport · `GET /v1/llm-runner/resident` (poll). The `.ini` is DERIVED from the DB, never read back.

**NEXT — P4** (resident-set + TTL UI, shared kit — surface the co-resident embed + chat, `models_max`/TTL knobs, reading `/v1/llm-runner/resident`; needs a fresh "go"). **P3 §3d end-to-end box verify** (RAG Build-index + Chat-with-book with the chat model also resident, on the user's Windows box) + **P1g** router-flag box-verify both await the user's box; neither blocks P4.

## BOX-TESTED FINDINGS (2026-07-04, user's own box, Gemini-assisted) — model picks + the chat/extraction insight + P4/P5 follow-ups

The user ran real model tests on their box and shared a working router `.ini` + findings. Recorded here in FULL (they FEED the DB — our emitter GENERATES the `.ini`, so the hand-tuned file is the TARGET OUTPUT our DB→`.ini` should produce, not a file we keep by hand). NONE of this is built — it is the P4/P5 backlog + two small fixes + one USER decision, all pending a fresh "go".

**The user's tested `.ini` (verbatim):**
```ini
[*]
models-max = 2
models-autoload = 1
flash-attn = on
mlock = true

[speaker-extract]
model = ./data/models/gemma-4-12b-it-Q4_K_M.gguf
ctx-size = 16000
n-gpu-layers = -1
reasoning-budget = 0

[book-chat]
model = ./data/models/gemma-4-12b-it-Q4_K_M.gguf
ctx-size = 16000
n-gpu-layers = -1

[book-index]
model = ./data/models/qwen3-embedding-0.6b.gguf
ctx-size = 2048
n-gpu-layers = -1
embedding = true
```

**MODEL PICKS (verified against §8.2b; feed the seed catalog #104/#105):**
- **Dense `gemma-4-12b-it` (Q4_K_M) for BOTH chat + extraction; the MoE is "slow".** CONFIRMS the §8.2b measured nuance — prompt-heavy / short-output work (speaker extraction, RAG, a 16k context) favours a dense model fully on GPU for time-to-first-token; the A3B MoE only wins for long-output prose. `n-gpu-layers = -1` = all layers on GPU (fits their card, or b9644 auto-offloads the remainder); ctx 16000.
- **`qwen3-embedding-0.6b` for the embed** (over P3's seeded nomic) — stronger on MTEB, still tiny (~0.6B); ctx 2048. → make it the seed embed default over nomic (a model-surface #104/#105 curation flip).
- **Global switches `flash-attn = on`, `mlock = true`** (in `[*]`) — these are our Plane-1 switches; they belong in the DB `switch_presets` base, not hand-edited. The emitter renders them per-model.

**THE CHAT-vs-EXTRACTION INSIGHT (the most load-bearing) — "one model, toggle thinking, NO reload" is RIGHT, but the tested `.ini` doesn't implement it yet; it needs ONE small adapter fix.** Gemini told the user chat + extraction use the SAME model so there is no reload — just turn thinking on/off. Correct in principle, and it VALIDATES the taskKind/preset model (chat + extraction = the SAME engine preset, differing ONLY in the per-action `think` flag). But:
- The tested `.ini` has TWO sections (`speaker-extract`, `book-chat`) BOTH loading gemma-4-12b. In router mode a section = a SEPARATE child server keyed by section id. Two ~7.8 GB gemma entries CANNOT co-reside on a tight card (8–16 GB) alongside the embed. The user reports the 8 GB config VERIFIED-working (2026-07-04) — consistent with EITHER (a) the router SHARING one child across two sections that point at the IDENTICAL model file (a box-verify: does the router dedupe same-`model` sections?), OR (b) extract↔chat SWAPPING gemma (evict + reload, softened by `mlock` keeping the weights in RAM). Either way the two-section shape is redundant, and on the tight tiers a swap is exactly the reload cost we want gone. The user REAFFIRMED the target (2026-07-04): "think ON for chat, OFF for extraction, no reload/thrash if same model" — which is PRECISELY the one-entry refinement below: ONE gemma entry, thinking toggled per-request, nothing to swap.
- **Verified upstream (llama.cpp server README + Discussions #20408/#21445):** `--reasoning-budget 0` in the `.ini` is a SERVER-LEVEL HARD OFF — a per-request budget only applies "as long as you haven't specified a budget on the command-line," so a `reasoning-budget = 0` section can NOT be re-enabled per-request (it FORCES two entries). The per-request lever is `chat_template_kwargs: {"enable_thinking": true|false}` (and `reasoning_effort` via the same kwargs) — no reload, one resident model.
- **Our adapter ALMOST does it (`openai_compat.py:108-116` `_apply_reasoning`):** for the local runner it sends `chat_template_kwargs.enable_thinking = true` when thinking is ON — but when thinking is OFF it sends NOTHING and relies on the model's default (which for a thinking model is ON). THAT is why the user needed `reasoning-budget = 0` as a workaround. **THE FIX (one line):** for the local runner, send `enable_thinking: false` when `think` is off. Then ONE gemma entry serves both — extraction sends thinking-off, chat sends thinking-on, ZERO reloads, fits `models-max = 2` alongside the embed. **Consequence for the DB→`.ini` emission:** emit ONE section per resident MODEL, NOT one per taskKind — taskKinds that share a model share the entry + toggle thinking per-request. (Risk to weigh: unconditionally sending `enable_thinking: false` to a NON-thinking model whose template lacks the key — templates ignore unknown kwargs, so low-risk, but confirm on the box.)

**LATENT BUG the config caught — embedding POOLING (P5-adjacent fix):** the P3 emitter HARDCODES `pooling = mean` (`_resolve_ini_entries` post-pass → `emit_models_ini`). Correct for nomic (mean-pooling) but **Qwen3-Embedding is trained for LAST-token pooling** — forcing `mean` would quietly DEGRADE it. The user's tested `.ini` correctly OMITS `pooling`, letting llama.cpp read `pooling_type` from the GGUF. **Fix:** don't hardcode `mean` — omit it (let the file's `pooling_type` decide) or make it a per-model switch. (Confirm Qwen3-Embedding's exact pooling before flipping the default embed.) The `embedding` vs `embeddings` key is a NON-issue: both are accepted aliases (`--embedding, --embeddings`); our plural `embeddings = true` is box-confirmed working (the §8.1 nomic test); the user's singular `embedding = true` is equally valid.

**PIN RECONSIDERATION (the P3 deviation, now a USER DECISION — do NOT decide unilaterally, rule #6):** the user leans toward "leave the embed IN the `.ini`" rather than P3's lazy `ensure_embedding`. Grounding: `models-autoload` DEFAULTS to enabled — the router auto-loads a model when a request for it arrives, so "embed in the `.ini`, loads when needed" works ONCE THE ROUTER IS UP. The two things the bare-`.ini` approach loses vs P3-lazy: (1) something must still SPAWN the router if RAG runs before any chat (a `.ini` alone doesn't self-start); (2) an auto-loaded embed is INVISIBLE to the arbiter's VRAM ledger (the exact "unreserved resident" hole that made P3 drop `load-on-startup`). **The clean reconciliation IF the user chooses eager:** mark the embed section `load-on-startup = true` AND have the runner RESERVE it pinned when it SPAWNS the router (closes the unreserved-resident hole) — keep a thin ensure only to spawn-the-router-if-down for the RAG-first case. That gives the user's "it's just in the ini, always resident" mental model WITH correct VRAM accounting. **DECISION PENDING (user):** eager (`load-on-startup` + reserve-at-spawn) vs keep P3-lazy.

**Sources (web-verified 2026-07-04):** llama.cpp server README (`--embedding/--embeddings`, `--reasoning-budget`, `--reasoning-format`, `chat_template_kwargs.enable_thinking`, `models-max`/`models-autoload`/`load-on-startup`/`--sleep-idle-seconds`) · Discussions #20408 (per-request reasoning_effort) + #21445 (dynamic reasoning-budget per request) · the llama-server `models.ini` gist (embedding/pooling/reranking keys).

**FOLLOW-UP (tasks added; NONE built — pending a "go"):** (a) adapter — send `enable_thinking:false` when think off for the local runner → one-model chat+extraction, no reload; (b) emitter — stop hardcoding `pooling=mean` (omit / per-model) → fixes qwen3-embedding; (c) catalog/seed — add gemma-4-12b (dense) + qwen3-embedding-0.6b, make qwen3-embedding the embed default, capture flash-attn/mlock/ctx as switches (feeds #104/#105); (d) USER DECISION — pin eager vs lazy.

## FOLLOW-UP PROGRESS (2026-07-04 EVENING — user "go" on #118→#120; #121 resolved KEEP-LAZY)

**#121 (pin eager vs lazy) — RESOLVED by the user = KEEP LAZY.** Verified in code first: the embed is ALREADY managed in the `.ini` like every other model — `_resolve_ini_entries` (lifecycle.py:830-878) builds sections by iterating `for m in self.catalog()` (:841), the embed included, through the same on-disk gate + `compute_fit` + switches path as every chat model; the ONLY embed-specific touch is the required `embeddings = true` (+ pooling) at :872-877. The "lazy" part is purely the load TRIGGER (`ensure_embedding()`), not the `.ini` management. The user's condition ("manage the model in the `.ini` like other models") is therefore satisfied by P3 as-built; no code change for #121.

**Pre-build rules-checker on the #118→#120 plan = FAIL(4), ALL folded BEFORE code** (this is why we run it first): T2 — #119's "omit `pooling=mean`" would NOT work because `ModelIniEntry.pooling` defaults to `"mean"` (process.py:216) and the emitter emits it whenever truthy (process.py:235), so the dataclass default must ALSO change; T7 — #119 breaks two existing green tests asserting `pooling = mean` (test_lifecycle.py:962, test_runner.py:257), which must be updated in the same commit; T5 — #118 must gate the false-send to `local-llamacpp` ONLY (not the whole `_LOCAL_TYPES` which includes generic `openai-compat` whose chat template we don't own) + fix the now-stale docstring; T11 — #120 must also refresh `justwrite-app/docs/ai-providers.md` §Embedding (it calls nomic the "default"/"safe choice").

**#118 (one-model chat+extraction) — DONE + VERIFIED (ruff clean, 291 pytest; committed this turn).** `openai_compat.py` `_apply_reasoning`: for `provider_type == "local-llamacpp"` it now sends `chat_template_kwargs.enable_thinking = think` BOTH ways (True on / False off), so ONE resident model serves chat (think on) + extraction (think off) with NO reload / section-swap. The OFF-send is GATED to `local-llamacpp` ONLY — a generic `openai-compat` server keeps the conservative on→enable_thinking / off→nothing (we do not own its chat template). The now-dead `_LOCAL_TYPES` set was removed; the docstring was corrected. The emitter's "one section per model, not per taskKind" was ALREADY satisfied (the `.ini` is catalog-model-keyed, verified) so no emitter change was needed. The rules-checker's whole-runner audit found ZERO `reasoning-budget` occurrences, so no emitted CLI budget defeats the per-request `enable_thinking` toggle. Tests (test_adapter_extra.py): local off→`enable_thinking:false`, local on→`true`, generic openai-compat off→nothing, cloud→`reasoning_effort` unchanged.

**#119 (emitter pooling) — IN PROGRESS; the web-verification CHANGED the fix (do NOT blind-omit).** The box-finding's "omit `pooling=mean` — let the GGUF's `pooling_type` decide" is NOT safe. Web-verified 2026-07-04: llama.cpp uses the GGUF's baked-in `pooling_type` only IF present, else it errors ("failed to get embeddings from sequence, pooling type is not set" — abetlen/llama-cpp-python #1288) or uses a wrong default; **Qwen3-Embedding usage explicitly passes `--pooling last`** (its GGUF card + discussion #8; ggml-org/llama.cpp #14234 "bad output" + #20085 "all zeroes" are pooling-mismatch symptoms); and nomic-embed-text-v1.5's mean-pooling metadata could NOT be confirmed from its GGUF card. So the correct fix is **EXPLICIT per-model pooling** (nomic=`mean`, qwen3-embedding=`last`), NOT omission — which also SIDESTEPS the GGUF/box uncertainty entirely (an explicit `--pooling` always works, no b9644 guess needed). This is bigger than the planned one-line omit → surfaced to the user (rule #6). **USER DECISIONS (2026-07-04):** (A) pooling as a proper per-model DB attribute [chosen over B, a quick per-embed map + follow-ups] + "do it right, professional, not lazy"; and (2) the model-form pooling control = **READ-ONLY DISPLAY** [chosen over (3) an editable dropdown — a FOOTGUN: a user could set nomic→`last` and silently degrade it, the exact failure we fix for qwen3 — and over (1) deferring the field entirely]. **Web-verified pooling enum = `{none, mean, cls, last, rank}`** (llama.cpp server README `tools/server/README.md`; the models.ini gist shows a real reranker stuck at near-zero scores until pooling was set right — corroborates "explicit per-model or it breaks"). CORRECTED MECHANISM (rule #7 — my first framing "per-model switch" was WRONG): `resolve_model_switches` (switch_resolve.py:36-63) layers ONLY `all → type(moe|dense) → hardware`, with NO per-individual-model layer, so nomic + qwen3-embedding (both `dense`) CANNOT get different pooling via a switch. Pooling is an INTRINSIC per-model attribute → a **`ModelCatalog.pooling` String column**, mirroring `use_limited` (#74) — BUT with the extra hop the 2nd pre-build rules-checker (FAIL(6), all folded) surfaced: **the emitter reads `ModelEntry` (runner/schema.py:86), NOT `CatalogRow`**, and `use_limited` never reaches the emitter, so pooling ALSO needs `ModelEntry.pooling` + threading in `catalog_fn` (install.py:143) or it is a SILENT NO-OP; and pooling must be resolved **BY-ID in the `_resolve_ini_entries` POST-PASS** (the single authority covering the override-load path :843 + the not-in-catalog insert :859 — the PRIMARY P3 embed loads as an OVERRIDE built at lifecycle.py:750 with no pooling, so a main-loop-only set would emit none), mirroring how `embeddings=True` is applied there. FINAL TOUCH-LIST — **Backend:** `db.py` `pooling` column on ModelCatalog; `model_catalog_api.py` `CatalogRow.pooling`; `stores.py` `_catalog_to_wire` (:292) + upsert (:331); `runner/schema.py:86` `ModelEntry.pooling`; `install.py:143` `catalog_fn` threads `pooling=r.pooling`; `process.py:216` `ModelIniEntry.pooling` default `"mean"`→`""` (KEEP the field + its `emit_models_ini` embed-block render :233-236); `lifecycle.py` `_resolve_ini_entries` builds `pooling_by_id` from the catalog and sets it in the POST-PASS `_dc_replace(e, embeddings=True, pooling=pooling_by_id.get(e.model_id, ""))`; `seed.py` `pooling="mean"` on the nomic row + threaded into `seed_default_catalog` (qwen3-embedding=`last` lands with #120). **UI (shared kit, READ-ONLY):** `useCatalogMeta.js` `poolingById`; `LuModelCatalog.vue` a READ-ONLY pooling display (like the `type`/`mtp` auto-detected read-only fields), NOT a UiSelect editor. **Docs:** `justwrite-app/docs/models.md` plain-language pooling entry (rule T11) + recap. **Tests:** `_EMBED` fixture gets `pooling="mean"` so the override-path guard `test_lifecycle.py:952-963` (:962 `pooling = mean`) STAYS a genuine guard (do NOT weaken it — the FAIL(6) T7 catch); `test_runner.py:245-260` is a DIRECT `emit_models_ini` test → pass pooling explicitly on the embed `ModelIniEntry` + add a no-pooling→no-line case; + a store round-trip + a DB-resolved-path emitter test. Schema bump → dev reseed (fresh installs auto-create); verify ruff + pytest AND JW `build:vite` + headless smoke (shared-kit UI change). **STATUS: design LOCKED + 2 rules-checker passes folded (the #118→#120 plan FAIL(4); the #119 catalog-column plan FAIL(6)); NO code written yet — the 3rd container restart interrupted before the build. Code starts on the user's next "go."**

**#120 (seed the tier ladder + qwen3-embedding default) — PENDING** (queued after #119; shares seed.py). Will web-verify the HF GGUF repos (never recall — the upstream-audit rule) + add catalog rows + flip `seed_default_routing` embed default nomic→qwen3-embedding-0.6b (fresh-install-only) + refresh ai-providers.md §Embedding.

## TIER LADDER — box-informed hardware → model recommendations (2026-07-04, Gemini-assisted; the curation DATA for model-surface #104)

The user provided a full hardware-tier ladder of router `.ini` configs (a monolingual set + a multilingual set), SAME structure across all (the `[*]` header `models-max=2` / `models-autoload=1` / `flash-attn=on` / `mlock=true`; every entry `n-gpu-layers=-1`; extract adds `reasoning-budget=0` [→ should become the per-request `enable_thinking:false`, see above]; embed adds `embedding=true`). Only the MODEL, QUANT, and CTX vary per tier; the multilingual set raises ctx + adds `pooling=cls` to the embed. Captured in FULL (this is the seed-catalog ladder for #104; the 8 GB monolingual `.ini` is quoted verbatim above):

| Tier (VRAM) | Chat + Extract model | Quant | ~size | ctx | Embed model | Embed ctx | Multilingual Δ (ctx / embed ctx / pooling) |
|---|---|---|---|---|---|---|---|
| **8 GB — VERIFIED on box** | gemma-4-12b-it | Q4_K_M | ~7.8 GB | 16000 | qwen3-embedding-0.6b | 2048 | 20000 / 8192 / `cls` |
| 12 GB | gemma-4-12b-it | Q4_K_M | ~7.8 GB | 16000 | qwen3-embedding-0.6b | 2048 | 20000 / 8192 / `cls` |
| 16 GB | gemma-4-12b-it | Q8_0 | ~12.6 GB | 24000 | qwen3-embedding-0.6b | 4096 | 30000 / 8192 / `cls` |
| 24 GB | Qwen3-32B-Instruct | Q4_K_M | ~19.5 GB | 24000 | qwen3-embedding-0.6b | 4096 | 30000 / 8192 / `cls` |
| 32 GB | Meta-Llama-3.1-70B-Instruct | Q3_K_M | ~28.5 GB | 32000 | qwen3-embedding-0.6b | 8192 | 40000 / 8192 / `cls` |
| 64 GB | Meta-Llama-3.1-70B-Instruct (or Qwen3-72B-Instruct) | Q6_K | ~58.5 GB | 64000 | qwen3-embedding-0.6b | 16384 | 80000 / 16384 / `cls` |

**How it maps to our stack (feeds #104/#105 + the emitter):**
- **The embed is qwen3-embedding-0.6b at EVERY tier** (tiny, fits any card) → reinforces making it the seed embed default over nomic.
- **`pooling = cls` for multilingual** (cross-lingual search) → CONFIRMS pooling must be a CONFIGURABLE per-model/per-mode switch (our P3 hardcoded `mean` is wrong for this). ⚠ Qwen3-Embedding is trained for LAST-token pooling, so `cls` (Gemini's rec) may be sub-optimal for it — CONFIRM the right pooling for qwen3-embedding on the box before adopting `cls`; regardless, the emitter must LET it be set, never hardcode.
- **The `.ini` ctx values ARE our per-model fit `ctx-size`** → they become the DB catalog per-tier ctx the emitter sets; the tiers double as the Fit bands (8/12/16/24/32/64 GB) the model-surface §10 speed-floor auto-pick already reasons about.
- **This is a RECOMMENDATION ladder, not a config we keep by hand** — the DB holds the models/quants/ctx/switches; the emitter GENERATES the tier-appropriate `.ini`; the arbiter/Fit picks the tier from detected VRAM.
- **`n-gpu-layers = -1` (all on GPU) at every tier** — on the tightest tiers (8 GB gemma-Q4 ~7.8 GB) this relies on b9644's graceful CPU auto-offload of the overflow (the "verified 8 GB" result); `compute_fit` should target a fitting ngl and let the build auto-offload the tail.

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
