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
> checker-confirmed no ghost/leak; P2's arbiter restructures this path). NEXT: P1g (box-verify router flags on b9644 +
> the sync-vs-async POST + whether a child's OOM text reaches the router log; bump `DEFAULT_PINNED_BUILD` if a flag absent).**
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
