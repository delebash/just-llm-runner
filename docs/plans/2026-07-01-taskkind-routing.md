# PLAN v2 — Kill the job/category routing duality: `taskKind → preset` is the single routing model (2026-07-01)

## Authorization & locked decisions
User (2026-07-01): "you can change design docs and anything outdated deprecate … clean up any code, I don't want a mix of job or categories … Renaming files or names is what a professional developer would do … Go" + "Continue." Confirmed **doc 1** operative.
- **D1 Naming:** nav grouping → **`group`** (display only); the LLM-work routing key → **`taskKind`** (action-keyed).
- **D2 Recommendations:** ONE taxonomy — retag `model_recommendations.job` → **`task_kind`** (the 9 values). No coarse second taxonomy.
- **D3 Quality dial:** **DELETE** the Fast/Balanced/Best dial (`quality.py`/`quality_api.py`/`RoutingByJob.vue`/`LuJobSelect.vue`) — it was dropped in 06-29 and its UI is unmounted.
(All three are the panel-flagged decisions; user can veto before Phase 2.)

## Verified current state (code-grounded; panel-corrected)
- Preset cascade BUILT but **UNSEEDED** (`seed_llm` seeds no `EnginePreset`/`CategoryPreset`) → inert.
- Jobs **behaviorally inert**: `feature_jobs` IS seeded (JW `DEFAULT_FEATURE_JOBS`), but `job_routes`/`config.jobs` is NEVER seeded (`seed_default_routing` seeds none), so `_resolve_job` (dispatch.py:44-56) gets `target is None` → everything falls to first-registered (dispatch.py:143-151). Deleting the job leg is behavior-preserving.
- `_category_of` (install.py:69-74) returns the **nav** category and is **feature-keyed**. `_resolve_preset` (prompts.py:384-391) calls `category_of(feature)` **only** — never `(action)`. So splitting `writerAI` is a **BEHAVIOR CHANGE** (add an action-keyed lookup), NOT a rename.
- The **quality dial is live code** (`quality.py resolve_quality`, `_THINK_ON_BEST={"analysis"}`, `/v1/ai/job-quality`, mounted in install.py) but its only UI (`RoutingByJob.vue`) is **unmounted** → effectively dead; it consumes the recommendation `job` tag.
- Overlay `_effective_spec` (prompts.py:405-410): preset wins on json/top_p/think, temperature only if preset null. B3 `_effective_think` (373-381): json_mode forces think off. (verified)
- **JustVoice safe** — mounts shared routers by hand (`app.py:194-200`), no `install_llm`, own `feature_pins_api`, never seeds jobs. Deletions are behavior-preserving for JV.

## Target model — ONE task taxonomy
- **`group`** = feature nav grouping, display only ("Writing"/"Whole book"…). Zero routing meaning.
- **`taskKind`** = the LLM-work shape (9, action-keyed): `prose.generate · prose.edit · ideation · creative.structured · summary.grounded · extract.structured · judge.scored · chat.grounded · chat.inVoice`. THE single routing key + recommendation tag + QuickSetup unit.
- **`preset`** = engine config (model+switches+params). Cascade: `FeaturePresetRef`(action override) → `TaskKindPreset`(action's taskKind) → global default (`""` key).
- Drop+reseed on every schema change (`POST /v1/data/reset`). Verify per phase: runner `ruff`+`pytest`; JW `ruff`+`pytest`+`build:vite`+`node scripts/headless-smoke.mjs`.

---

## STRICT-DIFF — every `job`/`category` symbol (the T6 deliverable). Action ∈ {DELETE, RENAME→x, KEEP}. Acceptance = after execution, `rg -n '\b[Jj]ob\b|JobRoute|JobTarget|jobs_api|feature_jobs|SUGGESTED_JOBS|DEFAULT_JOB|prefill_job|resolve_quality|job-quality' llm_runner/ ui/src/ justwrite-app/server/` returns ONLY intentional keeps (e.g. JV TTS "jobs", the git branch). 

### DELETE — job machinery (backend `just-llm-runner/llm_runner/llm/`)
| Symbol / file | file:line | Consumers to also fix |
|---|---|---|
| `jobs_api.py`, `job_switches_api.py`, `job_presets_api.py`, `quality.py`, `quality_api.py` (whole files) | — | imports below |
| tests `test_job_switches.py`, `test_job_presets.py`, `test_quality*.py` | — | — |
| `db.py` classes `JobRoute`(198-215) `JobRouteSwitch`(223-241) `JobPreset`(326-340) `JobPresetSwitch`(343-354) `Job`(358-369) `FeatureJob`(372-381) | db.py | RoutingStore, stores |
| `stores.py:22` `from .jobs_api import FeatureJobRow, JobRow` | stores.py:22 | — |
| `stores.py` `JobRouteSwitchStore`(436) `JobStore`(594) `FeatureJobStore`(643) `JobPresetStore`(705) + singletons(914,1047,1048) + getters(1057,1065,1066,1067) | stores.py | install mounts |
| `stores.py` RoutingStore ↔ `db.JobRoute` reads/writes in `_row_to_routing`(110-113) + `_apply_routing`(136-140) | stores.py:110-140 | strip jobs, KEEP default+pins |
| `stores.py:637` `seed.seed_default_jobs(s)`; `:679/684` `app_feature_jobs`/`seed_default_feature_jobs` | stores.py | — |
| `schema.py` `LLMJobTarget`(58-63); `LLMConfig.jobs`+`.feature_jobs` fields | schema.py | config_builder, dispatch |
| `dispatch.py` `_resolve_job`(44-56) + call(132) | dispatch.py | chain stays: action→prod-config→pin→prefer-local→first |
| `config_builder.py` jobs dict(27-31) + feature_jobs(32) + kwargs(36-37) | config_builder.py | — |
| `switch_resolve.py` `resolve_profile_switches`(84-111) + `prefill_job_switches`(98) | switch_resolve.py | install profile_switches_fn |
| `routing_api.py` `JobTarget`(29-37, has `quality`) + `RoutingConfig.jobs`(60) + `RoutingResponse.jobs`(78) + `_response() jobs=cfg.jobs`(127) + docstring(7,66,96) | routing_api.py | KEEP default+pins+features |
| `recommendations_api.py:36` `SUGGESTED_JOBS` | recommendations_api.py | __init__ export |
| `seed.py` `configure_app_seed(feature_jobs=)`(22) `app_feature_jobs`(39) `DEFAULT_JOBS`(166) `seed_default_jobs`(434) `seed_default_feature_jobs`(456) `seed_llm` calls(503-504) | seed.py | install, JW seed |
| `install.py` imports(25,26,35), `feature_jobs` param(49)+kwarg(59), mounts `make_job_presets_router`(82) `make_job_switches_router`(101-103) `make_jobs_router`(105-106) `make_quality_router`(~92-94) `profile_switches_fn`(138-143) | install.py | — |
| `__init__.py` `jobs_api`/`job_presets_api`/`quality_api` export blocks + `JobTarget`(76) `SUGGESTED_JOBS`(117) `DEFAULT_JOB_ID`/`slugify_job_id`(125) `Job`/`FeatureJob`/`LLMJobTarget` from `__all__` | __init__.py | — |

### DELETE — job/quality UI (`just-llm-runner/ui/src/`) + JW
| Symbol / file | file:line |
|---|---|
| `views/RoutingByJob.vue`, `components/LuJobSelect.vue` (whole files) | — |
| `composables/useRouting.js` job surface: `jobs`/`feature-jobs` loads(36,47), `reloadJobs`(45), `setJob`(64-67), `setFeatureJob`(97-98), `resolveQuality`(73-75), `jobLabel`, the `jobs:` in save(55), exports(105-106) | useRouting.js | KEEP default/pins/features |
| `views/FeatureWorkbench.vue` feature-jobs load(173) + `routing.jobs` handling(178,275,278) | FeatureWorkbench.vue | — |
| `views/QuickSetup.vue:39` `jobs.value.map(...)` → repoint to taskKinds (or stub until the setup-preset follow-up) | QuickSetup.vue | — |
| `AiModelsArea.vue` any RoutingByJob import/mount (already unmounted — confirm & remove) | AiModelsArea.vue | — |
| JW `server/justwrite_server/seed.py` `DEFAULT_FEATURE_JOBS`(26-54) | seed.py | app.py handoff |
| JW `server/tests/test_routing.py` two whole job tests(31-76) → delete/rewrite | test_routing.py | — |

### RENAME — nav `category` → `group` (ATOMIC: backend + all readers, one phase)
`routing_api.py` `FeatureCatalogEntry.category`→`group`(102), `FeatureRow.category`→`group`(71), `FeatureRow(...category=e.category)`→`group=e.group`(120), docstrings(71,96). JW `feature_catalog.py` — entries pass positionally (21-46) so NO by-name edit; just any `.category` reader. UI `FeatureWorkbench.vue` nav grouping (71-96,108-116,420-427) reads `.category`→`.group`; **reconcile the existing local `a.group`(152)** so it doesn't shadow.

### RENAME — preset cascade category→taskKind (ATOMIC: backend + assignment API + UI, one phase; BEHAVIOR CHANGE in `_resolve_preset`)
`db.py` `CategoryPreset`→`TaskKindPreset`, table `category_presets`→`task_kind_presets`, PK `category`→`task_kind`(501-510). `stores.py` `CategoryPresetStore`→`TaskKindPresetStore`(864)+getter(1070). `preset_resolve.py` `resolve_feature_preset(feature_key, category)`→`(feature_key, task_kind)`(20-33). `presets_api.py` `CategoryAssignment`→`TaskKindAssignment`(58-60), `AssignmentsResponse.categories`→`.taskKinds`(101-104), route `/preset-assignments/category`→`/task-kind`(165-170). `install.py` `_category_of`→`_task_kind_of` **action-keyed** (69-74) + wiring(80). `prompts.py` `_resolve_preset` **ADD** `tk = task_kind_of(action) or task_kind_of(feature)` then `resolve_feature_preset(action, tk or "")`(384-391) — NOT a rename. `FeaturePresetRef` KEEP (action override leg). UI reads `.categories`→`.taskKinds`, `setCategoryPreset`→`setTaskKindPreset`, the assignment surface (Phase 5).

### RENAME — recommendations `job` → `task_kind` (D2; shared seed)
`db.py` `ModelRecommendation.job` PK(158)→`task_kind` (plain String PK, no FK to deleted Job table). `stores.py` `_rec_to_wire`(298), order-by(305-306), composite key(314), loop(340); wire `RecommendationRow.job`→`.taskKind`. SHARED `seed.py DEFAULT_RECOMMENDATIONS`(144) values retagged 4→9 (chat→{chat.grounded,chat.inVoice}; extraction→{extract.structured}; analysis→{judge.scored}; prose→{prose.generate,prose.edit,ideation,creative.structured,summary.grounded}). `recommendations_api.py` `.job`→`.taskKind`. UI `RecommendationsEditor` `.job`→`.taskKind`.

---

## PHASES (each shippable; verify gates per phase)
**P1 — DELETE job + quality machinery** (the whole DELETE tables above). Acceptance: `python -c "import llm_runner.llm"` clean; runner `ruff`+`pytest` green (job/quality tests removed); JW `ruff`+`pytest`; JW `build:vite`+smoke (job UI removed, app still boots). JV import unaffected.
**P2 — RENAME category→group** (atomic backend+UI). Verify runner pytest + JW build:vite+smoke (nav still groups, renders).
**P3 — RENAME CategoryPreset→TaskKindPreset + `_task_kind_of` action-keyed + `_resolve_preset` behavior change** (atomic). DB table rename → reset. Verify pytest (cascade resolves; writerAI.continue vs .tighten differ once seeded) + build:vite+smoke.
**P4 — SEED taskKind data** (JW `seed_presets.py`: 8 `DEFAULT_ENGINE_PRESETS` + 9 `DEFAULT_TASKKIND_PRESETS` + `FEATURE_TASK_KINDS`; shared `seed_default_engine_presets`/`seed_default_taskkind_presets` in `seed_llm`; `configure_app_seed` gains the three, drops `feature_jobs`; recommendations retag; per-action FeaturePrompt temps+json_mode per doc1 §4.3). Reset. Verify: sample action per taskKind → expected preset; writerAI split; invariant no `json&&think`; seed counts; live `/v1/ai/run` probe.
**P5 — UI**: nav headers = `group` (browse, drop the per-group set-all preset dropdown); NEW taskKind→preset assignment surface (9 rows + global default, reuse renamed `/preset-assignments/task-kind`); feature-card provenance (own→taskKind→default); QuickSetup repoint; delete RoutingByJob/LuJobSelect. Verify build:vite+smoke+screenshots + Playwright assign-probe. Guard: FeatureWorkbench.vue is JW-mounted only (JV has own AI area).
**P6 — DOCS**: NEW `just-llm-runner/docs/plans/2026-07-01-taskkind-routing.md` (this plan = live tracker); banner-deprecate 06-25 jobs-arch + 06-29 ai-lab-preset-model; update 06-28 MASTER banner + MORNING_RECAP + both CLAUDE.md pointers. Commit the plan doc as the FIRST execution step (live tracker from the start).
**P7 (separate follow-up)** — json_object→strict flat json_schema (#77). **P8 (separate)** — reason_then_emit for judgment (doc §4).

## Grep acceptance gate (run after P1, P2/P3, and at the end)
`rg -n '\b[Jj]ob\b|JobRoute|JobTarget|jobs_api|job_presets|job_switches|feature_jobs|SUGGESTED_JOBS|DEFAULT_JOB|slugify_job|prefill_job|resolve_quality|job-quality|make_quality_router|\.category\b|CategoryPreset|category_presets|preset-assignments/category' just-llm-runner/llm_runner just-llm-runner/ui/src justwrite-app/server justwrite-app/src` → only intentional keeps remain (JV TTS jobs, git branch names, doc history).

## Risks / notes
- Biggest risk was deletion-completeness (fixed via the strict-diff + grep gate + `import llm_runner.llm` gate in P1).
- Drop+reseed wipes the workspace (demo reseeds) — expected policy; warn in recap.
- JustVoice untouched (its own AI surface); the shared-vs-per-app audit (#92) + JV adoption of taskKind is a separate follow-up.
- P7/P8 are real features, not seed edits — kept out of this refactor's scope.

## v2.1 — panel re-verify fold (additional KEPT-file consumers; execution gates authoritative)
Both re-verify lenses confirmed the DESIGN (one taxonomy; `fit.py` KEPT with live consumers `runner/api.py:41`/`runner/process.py:28`/`test_fit.py`; `_resolve_preset` behavior-change; atomic phasing; JV-safe; reuse). They found more KEPT-file references to deleted symbols — folded into P1/P4/P5:
- `stores.py:20` `from .job_presets_api import …`, `:21` `from .job_switches_api import …` → DELETE (whole modules gone). `:30` drop `JobTarget` from the `from .routing_api import …` line.
- `__init__.py:65` `SUGGESTED_JOBS` import; `:85` `LLMJobTarget` in the `from .schema import (…)` block; `:122-125` `__all__` — enumerate ALL job symbols: `JobRow, JobStore, JobsResponse, make_jobs_router, FeatureJobRow, FeatureJobStore, FeatureJobsResponse, make_feature_jobs_router, DEFAULT_JOB_ID, slugify_job_id, LLMJobTarget, SUGGESTED_JOBS` → DELETE from both the import block AND `__all__`.
- `schema.py:110` `LLMConfig.default_job_id` → DELETE (orphaned once `_resolve_job` goes).
- `RecommendationsEditor.vue`: replace the deleted `LuJobSelect` widget (`:24` import, `:225` mount) with a static `UiSelect` over the 9 taskKinds; rewrite the `:226` "Routing by job" hint; retag every `.job` site (`83,84,94,105,107,113,129,133,137,201,207,225`).
- `RecommendationStore`/router rename also touches `stores.py:316,326,329,341` + `recommendations_api.py:80,89-92`.
- GREP FIX: add lowercase `default_job_id` to the acceptance patterns (`\b[Jj]ob\b` misses it — `_` is a word char).

**Execution gates ARE the completeness guarantee (the paper table is the map).** A symbol-deletion this size is iterative: after each backend delete run `python -c "import llm_runner.llm"` and fix EVERY dangling import it names; after each UI delete run `npm run build:vite` and fix EVERY dangling component; then the (fixed) grep gate must return only intentional keeps (JV TTS "jobs", git branch, doc history); then `ruff`+`pytest` green. A phase is "done" only when its gate is green. The final commit-gate rules-checker runs on the actual DIFF (where the import gate has already proven completeness), not on this doc.
