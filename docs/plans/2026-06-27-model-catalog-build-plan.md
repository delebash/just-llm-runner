# MASTER BUILD PLAN — LLM stack + JustWrite (model catalog, dial, lab) (2026-06-27)

> **THE plan to follow + code from after a compaction.** Status was **panel-verified** (3 independent
> Opus agents, file:line + ran the suites: **144 runner + 77 JW tests pass**). Read this + the audited
> index `justwrite-app/docs/plans/2026-06-27-complete-remaining-plan.md` (§0–§7). Branch (all repos):
> `claude/admiring-galileo-il3q0o`. **Rules in force:** I act only on an explicit "go"; I show agent
> prompts before sending; "save docs" always updates `MORNING_RECAP.md` + the session-handoff.
>
> **Verification harness (runs in THIS container):** runner → `cd just-llm-runner && python -m pytest -q && ruff check`. Renderer (JW) → boot `python -m justwrite_server.cli serve --port 17495` (bg) + `npm run dev:vite` (:1420, bg), then `node scripts/headless-smoke.mjs` (zero JS errors); compile `npm run build:vite`. Reseed = drop+recreate (no migrations). Commit per phase, push with retry.

---

## ✅ COMPLETED — what we did + why (panel-verified at file:line)

**Foundation (earlier, verified shipped):**
- **Shared LLM stack is job-native** — role→job end-to-end; all LLM code lives in `just-llm-runner`; JW is a thin `install_llm` consumer (`app.py:149,156`). Old `/v1/llm/*` gateway DELETED (source gone; `openai-compat.js` gone). *Caveat (panel): JW `routingBackend.js:15,55-56,78-79` still carries `quick`/`accuracy` role fields → residual cleanup, see Phase F #31.*
- **#18** structured-output (json_mode) + **#22 subset** (top_p) — `prompts.py:56-57,142-143,192-193`. **#19** Overrides through `/load` — `api.py:149,159`. **#30** model manager (+Add/edit/delete) — `LuModelCatalog.vue:124,142`. **#33** Routing-by-job as a `UiTable` grid — `RoutingByJob.vue:213` (commit `37aa116`). catalog/recs/switch-presets → DB (`seed.py:69,104,114`). Fit engine + hardware presets. feature-prompts → DB.

**This session (verified shipped):**
- Token-stat camel/snake fixed + **tok/s readout** — `aiFeature.js:139`, `aiTasks.js:145-146`, `FeatureWorkbench.vue:427,570` (`32c3756`, `80d9ac4`).
- Provider **Test** GET→POST `AiModelsArea.vue:112`; RecommendationsEditor native `confirm()`→`confirmDialog` `:25,127,150`; dead `LuModelPicker.showRoles` removed (zero refs) (`d1d05dd`).
- **recommendations + ModelCatalogStore backend tests** — `tests/test_recommendations_catalog.py` (10) (`c822257`).
- Ollama/Gemini `_apply_extra` (per-call params no longer dropped) — `ollama.py:70-83`, `gemini.py:108-122` (`52d38fe`).
- `extra_flags` passthrough — `process.py:80,178-179`, `lifecycle.py:82-104` (`703d379`).
- Dead per-model switch-editor remnants removed from Providers (§6.6) — `LuModelCatalog.vue` (`600820d`, `f1afa6f`).
- **`ProductionConfig` re-examined → NOT dead** (was mislabeled): live + tested in the shared pkg (`dispatch.py:59,73,109`, `test_llm_dispatch.py:69`), consumed by JV; JW just doesn't populate it yet (planned convergence delta). Corrected status-index/handoff.
- **Newly credited by the panel (were uncredited):** job-switches WRITE side + `resolve_profile_switches` + prefill (`switch_resolve.py:69-113`, `stores.py:512`, `install.py:74`); the shared **KnobGrid** + per-Profile switch editing + **sampler KnobGrid** (Plane-2) (`1d8671e,5d67047,d885ef9,790ab40`); **GGUF identity auto-detect → `model_catalog.type`** (`6fe9a5f`).

**Research done (committed docs, build pending):** model catalog + per-job×per-tier matrix + the **Fast/Balanced/Best dial** + per-model-type switch sets (`2026-06-27-model-catalog-research-and-recommendations.md` + `-evidence.md`); **speaker-attribution LLM recipe** (`2026-06-27-speaker-attribution-llm-research.md`). These ANSWER backlog #25 + #28-partial (per-tier picks decided but MEASURED tok/s still needs a GPU).

---

## ⬜ OUTSTANDING — phased, detailed to code

### PHASE A — Catalog seed (in-container · pytest + reseed) — NOT built (verified: `seed.py` still old Qwen-only)
- **A1 — verify GGUF repos** (web, cheap; most already confirmed in research): `unsloth/gemma-4-12b-it-GGUF` (fallback `…-qat-GGUF`) · `Mistral-Small-3.2-24B-Instruct-2506-GGUF` · `GLM-4.5-Air-GGUF` · `Llama-4-Scout-17B-16E-Instruct-GGUF` · `Qwen3-235B-A22B-Instruct-2507-GGUF` · `gemma-4-31b-it-GGUF` · a `nomic-embed-text` GGUF. **Accept:** each confirmed or fallback. (Show me the search first per the prompt rule if it needs an agent; otherwise inline web.)
- **A2 — `DEFAULT_CATALOG`** (`seed.py:69-90`): DROP `qwen3.5-9b-q4_k_s`, `qwen3-14b-q3_k_m`; CHANGE `qwen3.6-35b-a3b-mtp` `min_ram_mb` 24000→**32000**; ADD (MoE VRAM=active-path+KV est., RAM=total): `gemma-4-12b-q4_k_m` (7000/32000/mid) · `mistral-small-3.2-24b-q4_k_m` (14000/32000/high) · `glm-4.5-air` (12000/64000/high-ram, **MIT**) · `llama-4-scout` (12000/64000/high-ram, **Llama-Community license → FLAG**) · `qwen3-235b-a22b` (16000/96000/high-ram) · `gemma-4-31b-it` (22000/32000/high) · `nomic-embed-text` (1000/4000/cpu). Add tier value `high-ram`. **Verify:** `test_recommendations_catalog.py` (add id asserts) + reseed.
- **A3 — RAM-gated fit-filter (CODE FIX, not a confirm — panel-corrected).** `coarse_fit` (`fit.py:91-105`) enforces `min_ram` ONLY on the CPU path (`vram_mb<=0`); the **GPU branch (L97+) checks VRAM only** → an 8 GB-VRAM/16 GB-RAM box is wrongly offered the 32 GB-RAM MoE. **Fix:** add the `min_ram_override` vs `ram_mb` check to `coarse_fit`'s GPU branch **AND** add a `ram_mb` param (+ system-RAM detect / override) to `get_models` (`api.py:79`); `_fit` (`api.py:35`) passes both. **Accept:** 8 GB+16 GB-RAM → 35B-A3B/GLM-Air NOT offered; 8 GB+32 GB → offered. **Verify:** pytest in `test_runner_models.py`/`test_fit.py`.
- **A4 — `DEFAULT_RECOMMENDATIONS`** (`seed.py:114-125`): add cited per-job rows — prose: Qwen3.6-27B r10, Qwen3-235B r3, Gemma-4-31B r20 · extraction: Mistral r5, GLM-4.5-Air r3 · chat: Gemma-4-12B r15 · analysis: Qwen3-235B r5. Reword 35B-A3B "6 GB"→"runs at the floor (8 GB+32 GB) via offload." **Verify:** pytest + reseed.
- **A5 — `DEFAULT_SWITCH_PRESETS`** (`seed.py:104-111`): confirm base/moe/mtp; A3B-spec stays configurable (machine-dependent). **Verify:** resolver layers by type/mtp.
- **A6 — tests + reseed + commit.**

### PHASE B — Fast / Balanced / Best dial (in-container) — NOT built (verified: no `resolve_quality`, `tiers.py` is old Guided/Direct/Reasoned)
- **B1 — backend:** `quality` enum (`fast|balanced|best`, default balanced; chat→fast) on the job route; `resolve_quality(job, quality, hardware) → (model, think)` = fit-filter the per-job list → pick the stop's model → set think per the dial table (analysis Best=on; attribution=reason-then-emit; else off). **file:** `dispatch.py`/`routing_api.py` + job-route model. **Verify:** pytest per (job×quality×tier).
- **B2 — frontend:** a 3-stop segmented Fast/Balanced/Best control per job (kit, reuse UiChip), bound to `quality`, showing the resolved model as a muted note. **Verify:** build:vite + smoke.
- **B3 — `think` guardrail:** auto-off under a JSON schema; attribution reason-then-emit. **file:** `prompts.py`/`dispatch.py`. **Verify:** pytest.

### PHASE C — switch grid + per-model tuning UI (#20) (in-container; real tok/s 🔒 GPU)
The **switch grid = `KnobGrid.vue`** (ONE generic key/value editor for Plane-1 switches AND Plane-2 samplers; unknown keys pass through). Already exists + wired (job-switches + samplers).
- **C1 — `knob_catalog`** (DATA, no code per param): seed label/type/default/dense-MoE-hint/plane for the Plane-1 switches so the KnobGrid renders friendly inputs. **Verify:** pytest store + smoke.
- **C2 — per-model "Tune & measure" panel (#20):** on the model card, KnobGrid → "Load & measure" → `POST /v1/llm-runner/load` (Overrides, #19 done) → fixed probe → **tok/s + VRAM + RAM** readout; "Save as this model's switches." Pre-fill from type-preset. **In-container:** UI + load-call + render; **real numbers 🔒 GPU.**

### PHASE D — Job/Feature LAB (#21) (in-container build; real tok/s 🔒 GPU) — design: `2026-06-27-switch-and-preset-architecture.md`
- **D1 — wire the switch-override tables to the LOAD path (panel-corrected wording):** `HardwareSwitch` ALREADY has a live reader (`switch_resolve.py:62`→`install.py:106`→`lifecycle.py:209`) — it needs a **writer/editor** (the §1b "[+conf] per-hardware switch editor"), not a reader. `JobRouteSwitch` has a resolver (`switch_resolve.py:86`) but **no load-path caller** — wire it (gated by the residency orchestrator, 🔒). `PinSwitch` (per-feature) is the only **truly zero-reader** table (`db.py:230`) — build store+resolver+reader. **Verify:** pytest each resolver.
- **D2 — Compare (#21):** N-column strip = (model + Plane-1 switches + Plane-2 samplers + prompt); run one action across columns; rank by tok/s·time·cost·quality. ONE unit-parameterized `<ConfigColumn>` (extract from FeatureWorkbench, render ×1/×N). Scheduler: cloud parallel · different-model local co-reside · same-model-switch serial. **file:** `ConfigColumn` kit + Compare view. **Verify:** build:vite + smoke; real tok/s 🔒 GPU.
- **D3 — `JobPreset` store + `make_job_presets_router` + promote** (mirrors FeaturePreset; promote writes `job_routes`+`job_route_switches`; add `job_preset_switches`/`feature_preset_switches` tables). **Verify:** pytest + smoke.

### PHASE E — extraction / structured features (in-container) — attribution FEATURE is JV-later (§G)
- **E1 — #24 scaffold (CURRENT):** temp `speaker_attribution` + `entity_extraction` entries in the JW feature catalog (flat JSON schema, think-off). The shared model recs already cover them (research). **file:** JW feature catalog + seed. **Verify:** pytest + reseed. *(The full attribution FEATURE — the CoT character-roster→chunk→number→whole-chunk-CoT→JSON, reason-then-emit, **+ step 5 incremental refinement** — is JV-later, see §G; recipe in `2026-06-27-speaker-attribution-llm-research.md`.)*
- **E2 — finish #22 sampling set** (top-k/min-p/dyn-temp/XTC/typical/penalties/DRY/seed/stop, grouped, backend-aware) + custom-JSON passthrough + reasoning-effort enum. (complete-remaining-plan §1c.)

### PHASE F — remaining backlog (mixed gates)
- **#31 (jobs-replace-role) — PARTIAL, not confirm-only (panel):** remove the residual `quick`/`accuracy` from JW `routingBackend.js:15,55-56,78-79`. (in-container)
- **License-flag UI (panel gap):** render the model's license as a badge/warning in the model UI (Llama-4 carries the flag as data; nothing displays it). **file:** B2 control / JW provider views. (in-container)
- **#23 shared AI task queue** → move `aiTasks.js`+`AiTaskStrip.vue`+`aiFeature.js` into `@delebash/llm-ui`, sweep JW consumers, delete copies (Decision 22). (in-container)
- **#29 VRAM/RAM-budget planner** (residency/LRU/co-reside; **embeddings never-swap rule**; gguf-parser feeds fit.py metadata, NOT a fit.py replacement). (in-container core; live timing 🔒 GPU)
- **#27 router mode** (`--models-preset` INI, `--models-max`, route-by-model; design around count-eviction OOM + TOCTOU). **🔒 GPU + ❓ router-vs-spawn is a USER decision first** (complete-remaining-plan §4).
- **#28 measured benchmarks** (per-tier tok/s + 8 GB-exact) — research, **🔒 needs a GPU**.
- **#32 audit** shared-vs-app (RULE #7) — in-container (note: §0 once marked #32 "dropped"; the build-plan keeps it as an audit task — reconcile with the user).
- **Test isolation fix:** `test_plane2_params.py` fails alone (missing `configured` fixture) — add fixture/conftest. **Stale `.pyc` cleanup** (gateway debris). (in-container)

### ❓ DECISIONS to settle before building the gated items (complete-remaining-plan §4)
Router-vs-spawn (+hybrid) = USER's call · cloud-native adapters (Anthropic `thinking`, Gemini thinkingConfig/safety, **prompt caching** — verified NOT implemented: `anthropic.py:88,139`/`gemini.py:132,171` accept `think` but ignore it) · reasoning-effort enum · `prefer_local_features`/`vramFit.tiers` editable-vs-hardcoded (currently hardcoded) · job lifecycle on delete/rename · samplers per-action-vs-default.

---

## §G — JUSTVOICE — LATER, NOT current scope (isolated)
*Listed for completeness; none is current-plan work. Full list: complete-remaining-plan §7.*
- **Speaker-attribution FEATURE build** (the LLM-CoT recipe: character-roster discovery → chunk 4096/1024 → number quotes → whole-chunk CoT → JSON-by-id → **step 5 incremental refinement**; route to 35B-A3B+/cloud). Recipe verified in `2026-06-27-speaker-attribution-llm-research.md`. *(The model research that informs it was correctly current/shared.)*
- **U5 adoption** (delete `engines/llm/*` → `install_llm`; bring `ProductionConfig` per-feature layer to JW; JV feature seeds; reconcile QuickSetups). **TTS Lab** (engine-knob compare). **Audiobook-converter feature mining** + **BookNLP2 pipeline eval** (`JustVoice/docs/plans/2026-06-27-audiobook-tools-research-todo.md`). JV capture/dictation fix; JV prompt-editor view; JV catalog drift.

---

## Pending-task index (task # → phase)
#20→C2 · #21→D2/D3 · #22→E2(rest; subset done) · #23→F · #24→E1 · #25→A4(answered by research) · #27→F(🔒+❓) · #28→F(research,🔒) · #29→F · #31→F(partial role-removal) · #32→F(reconcile) · #33 DONE(§0) · attribution feature→§G.
