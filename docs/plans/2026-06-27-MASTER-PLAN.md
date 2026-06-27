# MASTER PLAN — LLM stack + JustWrite — THE single source of truth (2026-06-27)

> **This is the ONE master plan. Everything is in here, in full detail — what + why, ✅ completed and
> ⬜ outstanding. There are NO secondary plan docs to chase: every other plan doc is SUPERSEDED and
> says "see this master." The ONLY things that point here are `MORNING_RECAP.md` + the session-handoff.**
>
> Branch (all repos): `claude/admiring-galileo-il3q0o`. Status below was **panel-verified 2026-06-27**
> (3 independent Opus agents, line-level code reads + ran the suites: **144 just-llm-runner + 77 JW tests pass**).
> Scope: the LLM stack + JustWrite. **JustVoice is out of current scope — all JV work is isolated in §G (bottom).**
>
> **Standing rules (the user, hard):** ① act only on the literal word "go"; ② show agent/research prompts
> before sending them; ③ "save docs" ALWAYS updates `MORNING_RECAP.md` + the session-handoff; ④ always choose
> the MORE thorough option — half-jobs are what cause the expensive repeats; ⑤ never guess — read code line
> by line, cite file:line; never claim "done" without file:line proof.
>
> **Verification harness (runs in THIS container):**
> - runner: `cd just-llm-runner && python -m pytest -q && ruff check`
> - renderer (JW): boot `python -m justwrite_server.cli serve --port 17495` (bg) + `npm run dev:vite` (:1420, bg) → `node scripts/headless-smoke.mjs` (asserts ZERO JS errors); compile `npm run build:vite`
> - reseed = drop + recreate (no migrations); commit per phase, push with retry.

---

# PART 1 — ✅ COMPLETED (what we did + why, file:line-verified)

## 1.1 Foundation (earlier; verified shipped)
- **Shared LLM stack is job-native.** Role→job replaced end-to-end; ALL LLM code lives in `just-llm-runner`; JW is a thin `install_llm` consumer (`justwrite-app/server/justwrite_server/app.py:149,156`). WHY: one shared implementation for both apps. *Residual (panel): JW `routingBackend.js:15,55-56,78-79` still carries `quick`/`accuracy` fields → see §3 F-#31.*
- **Gateway retired.** Old `/v1/llm/*` server gateway DELETED (source gone; `openai-compat.js` gone; `app.py` mounts only the `llm_runner` router). WHY: the runner dispatch (`/v1/ai/*`) replaces it.
- **#18 structured-output (json_mode)** + **#22 subset (top_p)** — `llm_runner/llm/prompts.py:56-57,142-143,192-193`. **#19 Overrides → `/v1/llm-runner/load`** — `runner/api.py:149,159`. **#30 model manager** (+ add/edit/delete) — `ui/src/components/LuModelCatalog.vue:124,142`. **#33 Routing-by-job as a UiTable grid** — `ui/src/views/RoutingByJob.vue:213` (was cards). **catalog/recs/switch-presets → DB** — `seed.py:69,104,114`. **Fit engine + hardware presets** — `runner/fit.py`, `runner-manifest.json` *(manifest config → DB per A7; only the fit formula stays in fit.py)*. **feature-prompts → DB.** **LuJobSelect + jscpd reuse gate.** **reset = drop+recreate** (`677d165`).

## 1.2 This session (verified shipped, with commits)
- Token-stat camel/snake fixed + **decode tok/s readout** — `aiFeature.js:139`, `aiTasks.js:145-146`, `FeatureWorkbench.vue:427,570` (`32c3756`, `80d9ac4`). WHY: the lab token stat read 0; tok/s is the tuning yardstick.
- Provider **Test** GET→POST — `AiModelsArea.vue:112`. RecommendationsEditor native `confirm()`→`confirmDialog` — `:25,127,150`. Dead `LuModelPicker.showRoles` removed (zero refs). (`d1d05dd`.)
- **Backend tests for RecommendationStore + ModelCatalogStore** — `tests/test_recommendations_catalog.py` (10 cases) (`c822257`).
- Ollama/Gemini `_apply_extra` — per-call params no longer dropped: `ollama.py:70-83` (`options`/`format`), `gemini.py:108-122` (`generationConfig`/`responseMimeType`) (`52d38fe`).
- **`extra_flags` passthrough** — `process.py:80,178-179`, `lifecycle.py:82-104` `_switches_to_overrides` routes unknown switch keys (`703d379`).
- Dead per-model switch-editor remnants removed from Providers (§6.6) — `LuModelCatalog.vue` (`600820d`, `f1afa6f`).
- **`ProductionConfig` re-examined → NOT dead** (was mislabeled): live + tested in the shared pkg (`dispatch.py:59,73,109`; `tests/test_llm_dispatch.py:69`), consumed by JV; JW just doesn't populate it yet (a planned convergence delta). Corrected the docs.
- **Panel-credited shipped work that was uncredited:** job-switches WRITE API (`/v1/ai/job-switches`) + `resolve_profile_switches` + `prefill_job_switches` (`switch_resolve.py:69-113`, `stores.py:512`, `install.py:74`); shared **KnobGrid** + per-Profile switch editing + **sampler KnobGrid** Plane-2 (`1d8671e,5d67047,d885ef9,790ab40`); **GGUF identity auto-detect → `model_catalog.type`** (`6fe9a5f`).

## 1.3 Research done (committed; build pending) — drives Part 2
- **Model catalog + per-job×per-tier matrix + Fast/Balanced/Best dial + per-model-type switch sets** (two `/deep-research` runs + a 3-reviewer consensus panel). ANSWERS backlog #25 + #28-partial (per-tier picks decided; MEASURED tok/s still needs a GPU = extrapolated). Full data in Part 3 + the provenance appendix.
- **Speaker-attribution LLM recipe** (101-agent run, 25 confirmed/0 killed): zero-shot CoT is SOTA; the whole-chunk numbered-quote recipe; 8B fails implicit. Full recipe in Part 3.
- **Tests green:** 144 runner + 77 JW.

---

# PART 2 — ⬜ OUTSTANDING (everything, phased; what · why · file:line · acceptance · verify · gate)

Markers: **[IC]** in-container-buildable now · **🔒** needs your GPU/live model · **🔬** research · **❓** decision-first.

## PHASE A — Catalog seed  [IC]  (NOT built — verified: `seed.py` still old Qwen-only)
- **A1 — verify GGUF repos** (web; most already confirmed in research): `unsloth/gemma-4-12b-it-GGUF` (fallback `…-qat-GGUF`) · `Mistral-Small-3.2-24B-Instruct-2506-GGUF` · `GLM-4.5-Air-GGUF` · `Llama-4-Scout-17B-16E-Instruct-GGUF` · `Qwen3-235B-A22B-Instruct-2507-GGUF` · `gemma-4-31b-it-GGUF` · a `nomic-embed-text` GGUF. **Accept:** each confirmed or fallback chosen. (Show me the search prompt first if it needs an agent.)
- **A2 — `DEFAULT_CATALOG`** (`seed.py:69-90`). **DROP** `qwen3.5-9b-q4_k_s`, `qwen3-14b-q3_k_m` (redundant quants). **CHANGE** `qwen3.6-35b-a3b-mtp` `min_ram_mb` 24000→**32000** (RAM is the floor). **ADD** (MoE VRAM = active-path+KV *estimate*; RAM = total; the tuning UI measures real):

  | id | repo | quant | total/active | min_vram_mb | min_ram_mb | tier | license |
  |---|---|---|---|---|---|---|---|
  | gemma-4-12b-q4_k_m | unsloth/gemma-4-12b-it-GGUF | Q4_K_M | 12B dense | 7000 | 32000 | mid | Apache-2.0 |
  | mistral-small-3.2-24b-q4_k_m | unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF | Q4_K_M | 24B dense | 14000 | 32000 | high | Apache-2.0 |
  | glm-4.5-air | unsloth/GLM-4.5-Air-GGUF | UD-Q4_K_XL | 106B/12B MoE | 12000 | 64000 | high-ram | **MIT** |
  | llama-4-scout | unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF | Q4 | 109B/17B MoE | 12000 | 64000 | high-ram | **Llama-Community → FLAG** |
  | qwen3-235b-a22b | unsloth/Qwen3-235B-A22B-Instruct-2507-GGUF | UD-Q2_K_XL→Q4 | 235B/22B MoE | 16000 | 96000 | high-ram | Apache-2.0 |
  | gemma-4-31b-it | unsloth/gemma-4-31b-it-GGUF | Q4_K_M | 31B dense | 22000 | 32000 | high | Apache-2.0 |
  | nomic-embed-text | (embeddings GGUF) | Q4_K_M | embed | 1000 | 4000 | cpu | Apache-2.0 |

  Add a `high-ram` tier value (`CatalogRow.tier`, `model_catalog_api.py`). **WHY:** family diversity + the full hardware range; the all-Qwen catalog had no non-Qwen, no 8GB 2nd family, no high-RAM tier. **Verify:** `test_recommendations_catalog.py` (add id asserts) + reseed. **NEVER seed Gemma ≤3** (Gemma Terms of Use — not GPL/Apache-safe; only Gemma 4 is Apache).
- **A3 — RAM-gated fit-filter (CODE FIX — NARROWED by the 2026-06-27 audit; the earlier description overstated it).** Verified: `coarse_fit` (`fit.py:75-105`) ALREADY accepts `ram_mb`+`min_ram_override` and RAM-gates the **CPU** path (`fit.py:91-96`); `_fit` (`runner/api.py:35-50`) ALREADY passes `min_ram_override=model.min_ram_mb`; `get_models` ALREADY passes detected `hardware.ram_mb` (`runner/api.py:124`). So the ONLY missing piece is **the RAM check in `coarse_fit`'s GPU branch** (`fit.py:97-105`, currently VRAM-only → an 8 GB-VRAM / 16 GB-RAM box is wrongly offered the 32 GB-RAM MoE). FIX ≈ 3 lines in `coarse_fit`. *(Optional nicety: a `ram_mb` OVERRIDE query param on `get_models` so QuickSetup can re-score for a different RAM, mirroring `vram_mb` — NOT required for the gate.)* **Accept:** 8 GB+16 GB-RAM → 35B-A3B/GLM-Air NOT offered; 8 GB+32 GB → offered. **Verify:** pytest (`test_fit.py`).
- **A4 — `DEFAULT_RECOMMENDATIONS`** (`seed.py:114-125`): cited per-job rows — prose: Qwen3.6-27B r10, Qwen3-235B r3, Gemma-4-31B r20 · extraction: Mistral-3.2-24B r5, GLM-4.5-Air r3 · chat: Gemma-4-12B r15 · analysis: Qwen3-235B r5. Reword 35B-A3B "6 GB"→"runs at floor (8 GB+32 GB) via offload." **Verify:** pytest + reseed.
- **A5 — `DEFAULT_SWITCH_PRESETS`** (`seed.py:104-111`): confirm base/moe/mtp; A3B-spec stays configurable (machine-dependent). **A6 — tests + reseed + commit.**
- **A7 — ELIMINATE `runner-manifest.json` → DB (audit 2026-06-27; USER DECREE: there is NO config-JSON exception — not even the binary pin; "it's just data, mark it built_in").** `llm_runner/runner/runner-manifest.json` still holds live config the no-hardcoding/no-files-on-disk rule bans: ① **`flagPresets`** — STILL read at spawn (`process.py:206,247,249`) despite the DB `switch_presets` that "replaced" it → rip it; the runner reads base/mtp from the DB presets. ② **`vramFit.safetyMarginMb`** — read live (`runner/api.py:91`, `process.py:205`) → a settings/DB row. ③ **`llamacpp.binaries`+`pinnedBuild`** — read live (`binary.py:45,73,98`) → a DB table seeded `built_in=true` (not-user-editable ≠ a JSON file on disk). ④ **`models:[]`** (empty) + **`vramFit.tiers`** (DEAD — audit found NO reader; also drop its unused schema field `runner/schema.py:118`) → delete. The ONLY thing that stays in code is the fit **FORMULA math** itself (`fit.py` — the rule's explicit "VRAM fit formula" carve-out). Steps: new DB tables + seeders for binaries/pin + vram-fit settings; rewrite the `binary.py`/`process.py`/`runner/api.py` readers; delete the file. **Verify:** pytest + boot-and-load-a-model with the JSON deleted.

## PHASE B — Fast / Balanced / Best dial  [IC]  (NOT built — no `resolve_quality`; `tiers.py` is old Guided/Direct/Reasoned)
ONE per-job quality control resolving to **(model, think)**, fit-filtered — replaces exposing raw model+think toggles (two technical dials confuse a novelist; raw `think` under a JSON schema silently breaks extraction). The dial table:

| Job | Fast (small, think-off) | Balanced (default) | Best (best-that-fits; think where it helps) |
|---|---|---|---|
| chat | Qwen3.5-9B | tier pick (9B→14B→27B) | 35B-A3B "smarter" (think off — latency) |
| prose | smaller dense | Qwen3.6-27B | Qwen3-235B / cloud (think off) |
| extraction | 9B flat | Mistral-3.2-24B / 35B-A3B | GLM-4.5-Air (**think OFF — JSON**) |
| attribution | 35B-A3B | 35B-A3B (reason→emit) | Qwen3-235B / cloud (reason→emit) |
| analysis | Qwen3.5-9B | 35B-A3B | best that fits (**think ON**) |

- **B1 backend:** `quality` enum on the job route; `resolve_quality(job, quality, hardware)→(model,think)` (fit-filter the per-job list → pick the stop → set think per table). **file:** `dispatch.py`/`routing_api.py` + job-route model. **Verify:** pytest per (job×quality×tier).
- **B2 frontend:** 3-stop segmented Fast/Balanced/Best per job (kit; reuse UiChip), shows the resolved model as a muted note. **Verify:** build:vite + smoke.
- **B3 think guardrail:** auto-off under a JSON schema; attribution reason-then-emit (`prompts.py`/`dispatch.py`). **Verify:** pytest.

## PHASE C — switch grid (`KnobGrid`) + per-model tuning UI (#20)  [IC; real tok/s 🔒]
`KnobGrid.vue` exists (ONE generic key/value editor for Plane-1 switches AND Plane-2 samplers; unknown keys pass through). **C1 `knob_catalog`** (DATA, no code per param): seed label/type/default/dense-MoE-hint/plane for the Plane-1 switches → friendly inputs. **C2 per-model "Tune & measure" (#20):** model-card KnobGrid → "Load & measure" → `POST /v1/llm-runner/load` (Overrides, #19 done) → fixed probe → **tok/s + VRAM + RAM** readout; "Save as this model's switches"; pre-fill from type-preset. **Verify:** build:vite + smoke (UI/request shape); real numbers 🔒 GPU.

## PHASE D — Job/Feature LAB (#21)  [IC build; real tok/s 🔒]  (design: the architecture doc, now folded — see Part 3)
- **D1 switch tables = the LOCKED D9 architecture (USER-RULED 2026-06-27).** ⚠️ The prior "build PinSwitch store+resolver+reader" line was **WRONG/STALE** — it was code-derived ("no reader → must build") and never folded in the decision. The decision (`switch-and-preset-architecture.md` D9/§3, now the ruling) is: **switches belong to the Profile only.** So:
  - **DROP `model_switches`** entirely — table (`db.py:95`), `ModelSwitchStore` (`stores.py:465`), CRUD router `/v1/ai/model-switches` (`model_catalog_api.py:125`, mounted `install.py:72`), the per-model resolver branch (`switch_resolve.py:58`), its test. **Verified status: UI already done** (no per-model editor in `LuModelCatalog.vue:112-113`; NO UI caller of `/model-switches`; seed already empty `seed.py:96`) → only the **backend removal remains**.
  - **DROP `pin_switches`** — features don't carry switches. **Verified status: inert** — table-only (`db.py:230`), zero store/reader/writer → trivial drop. *(This REPLACES the old wrong "build PinSwitch".)*
  - **`job_route_switches` = THE Profile's switches** (the survivor). Already editable (KnobGrid `RoutingByJob.vue:268`) + pre-filled on model-set (`prefill_job_switches`, `install.py:75`); resolver `resolve_profile_switches` (`switch_resolve.py:69`) is written but **UNCALLED** → the one real wiring left = **add the load-path reader** (full live apply needs router mode #27 🔒).
  - **KEEP `switch_presets`/`preset_switches`** (type-default pre-fill) + **`hardware_switches`** → wire `hw_key` at load (D9 says it's not passed today — verify `install.py`).
  - Fold the rest of the architecture in: **freeze-flat (D8)** · **Default-is-a-Profile (D16)** · **Profile(UI)=job(code) (D12)** · **switches are a model+hardware axis, not a job axis (D17)** → split the resolver into a pre-fill (base→type→mtp on model-set) + `resolve_profile_switches` (frozen + hardware at load).
- **D2 Compare (#21):** N-column strip = (model + Plane-1 switches + Plane-2 samplers + prompt); run one action across columns; rank by tok/s·time·cost·quality. ONE unit-parameterized `<ConfigColumn>` (extract from FeatureWorkbench, render ×1/×N). Scheduler: cloud parallel · different-model local co-reside · same-model-switch serial. **Verify:** build:vite + smoke; real tok/s 🔒.
- **D3 `JobPreset` store + `make_job_presets_router` + promote** (mirror FeaturePreset; promote writes `job_routes`+`job_route_switches`; add `job_preset_switches`/`feature_preset_switches` tables).
- **D4 §6.6 finish (audit-corrected 2026-06-27 — the master had glossed this):** the per-MODEL switch sub-editor IS gone (`LuModelCatalog.vue:112-113`), BUT `LuSwitchPresets.vue` (the base/moe/mtp PRESET editor) is **still mounted in the model manager** (`LuModelCatalog.vue:244`, under `ProviderForm.vue`) → that directly contradicts §6.6's "switches… none in Providers". Move `LuSwitchPresets` to the lab (or consciously revisit whether the preset editor belongs in Providers). This is real remaining work, not a "confirm".

## PHASE E — extraction/structured features  [IC]
- **E1 — #24 scaffold (CURRENT):** temp `speaker_attribution` + `entity_extraction` entries in the JW feature catalog (flat JSON schema, think-off). **file:** JW feature catalog + seed. *(The full attribution FEATURE build is JV-§G.)*
- **E2 — finish #22 sampling set:** top-k/min-p/dyn-temp/XTC/typical/penalties/DRY/seed/stop (grouped, backend-aware) + custom-JSON passthrough (merged into `extra`) + reasoning-effort enum (think bool → low/med/high → per-provider native) + context/token-budget guard + lab prompt-preview+token-count + per-action chunk-size + optional review/refine QC + render() macros + story-bible→prompt injection (budget-capped). (sillytavern §1-§5.)

## PHASE F — remaining backlog  [mixed gates]
- **#31 (jobs-replace-role) — PARTIAL [IC]:** remove residual `quick`/`accuracy` from JW `routingBackend.js:15,93,94` *(audit 2026-06-27 corrected the stale `:55-56,78-79`)*.
- **License-flag UI [IC]:** render a model's license as a badge/warning in the model UI (Llama-4 carries the flag as data; nothing displays it).
- **#23 shared AI task queue [IC]:** move `aiTasks.js`+`AiTaskStrip.vue`+`aiFeature.js` into `@delebash/llm-ui`, sweep JW's ~46 consumers, delete copies; replace the FeatureWorkbench `runStream` stopgap with the shared runner+store; also share `AiStatusPanel`/`AiProgressBar`/`PresetBar`/`ProviderRow` + fix the in-file `ProviderRow` dup in `AiModelsArea.vue` (Decision 22; shared-component §B; per-component strict diff first).
- **#11 QuickSetup wizard [IC]:** modal — card/VRAM chooser re-scores Fit → pick Default+Quick/Accuracy+Embedding → Apply sets routing + downloads/loads. RAM a first-class Fit line; MoE-aware Fit (`--n-cpu-moe` steering; prefer 35B-A3B when RAM allows); editable embedding; "Test on your book →" deep-link to Compare; download hygiene (instruct>base; trusted quant uploader; GGUF for budget); best-effort seeder, Compare confirms.
- **Shared LLM-UI client views [IC]:** build in the kit `LlmProviderForm`·`ModelPicker`·`ProviderSelect`·`RunnerStatus`·`DownloadStrip`·`UsageView`·routing/jobs surface; P0a normalize download-progress→camelCase + fix rate/ETA once; P0c fold tier picker into `LlmProviderForm`; add/edit provider inline form; provider role/job badges; per-provider model mgmt (llama.cpp router list/load/unload/`-hf` · Ollama/LM-Studio `/api/tags`+pull · Cloud list-fetch); rename built-in runner → "Local engine"; Routing&Cost defaults card. **Preserve** Ollama/LM-Studio Fetch-models combobox (not the catalog table). Build host `ProviderBackend` adapters then delete per-app adapter. Verify the kit `common/` vs `llm/` split + `tokens.contract.css`.
- **Streaming feature ports [IC]:** port `writerAI` (rewrite/expand/tighten/continue/applyRule/guidedContinue/describe) onto `runAiFeatureStream` + RichEditor live-diff + VariationsModal 3-alt (0.55/0.7/0.95); port `rag/chat`+`characterChat` onto `/v1/ai/stream`; migrate resumeBriefing/sessionRecap/stuckDiagnostic/sensoryResearch/brainstorm; **port `voiceFingerprint`** (was missed); then delete the `/v1/llm/...` gateway once last consumer migrates (verify).
- **Cleanup/dedup/gates [IC]:** #34 new-entity-popup audit → app-wide redundant double-step/popup audit (RULE-5) → collapse to open-detail+validate-before-save; deep-audit A-items (reconcile `htmlToText`×9/`tailWords`×4; shared `runJsonAnalysis`; promote big CSS clones to `styles.css`; `useEntityCrudView` composable); gates (extend `check-shared-pickers`; recs-dropdown smoke; ratchet jscpd; i18n `SettingsView.startNew`); remove unused `PromptLab.vue` (in the KIT `ui/src/views/`, NOT JW) + UI-less routing-presets endpoints (`routing_api.py:174-222`, mounted `install.py:29`); unify usage path to `/v1/ai-usage`. **#30 residual:** job tags on the model row never landed — decide build-or-supersede. **Test-isolation fix:** `test_plane2_params.py` fails alone (audit-confirmed: 3 fail w/ `RuntimeError: LLM storage not configured`, `db.py:362` — missing the `configure_storage` fixture). **Stale `.pyc` cleanup** (gateway debris). **PROVIDER_DEFAULTS dedup [IC] (audit 2026-06-27):** `openai_compat.py:26-51` hardcodes per-type base_url/default_model — a 2nd source of truth duplicating the DB seed `DEFAULT_PROVIDERS` (`seed.py:47-67`); the adapter should read the seeded config. **tiers.py hardcoded heuristics [❓/IC] (audit):** the Guided/Direct/Reasoned model→tier maps (`tiers.py:60,72,90`) are hardcoded mappings → per the no-hardcoding rule they belong in DB, or consciously accept as an engine heuristic (small decision).
- **Platform settings remainder [IC]:** U4 Updates/Changelog panel; Cache/Data "reclaim disk"; generic Hardware panel in the AI menu (both apps).
- **#27 router mode 🔒❓:** `RunnerService` `--models-preset` INI from catalog+switches, no `-m`, route by model, `--models-max` by tier; design AROUND count-eviction OOM (#19425/#18939), TOCTOU (#20137), `/metrics?model=` autoload (#23096). **❓ router-vs-spawn (+hybrid) is the USER's call.**
- **#29 residency / VRAM-budget planner 🔒 (core [IC]):** VRAM/RAM detect → per-model estimate → `--models-max` + co-reside vs LRU-evict/reload + dedup identical (model+flags) + idle-TTL; cross-kind coordinator; Low-VRAM 1-at-a-time toggle; **embeddings never-swap rule** (tiny → resident or CPU-only); Ollama pattern (queue rather than OOM; pre-flight must-fit tracking RAM vs VRAM separately).
- **Runtime switch apply 🔒:** apply per-job+per-feature switch overrides at (re)load on job-switch; same-model-two-jobs reload+dedup.
- **Per-tier auto-strategy 🔒:** detect→auto model-set+`--models-max`+offload (manual override); advanced (RoPE/YaRN off-by-default; multi-GPU `-sm/-ts/-mg`); turbo/KV-type validation; Apple-Silicon path (unified-memory budget; no `--n-cpu-moe`; `sudo sysctl iogpu.wired_limit_mb`).
- **#18 structured-output quality 🔒:** evaluate `--json-schema`/GBNF quality+latency for extraction/attribution.

## RESEARCH 🔬
- **#28** corrected deep-research → measured per-tier tok/s + VRAM (incl. real 8 GB-exact), serving/switching adopt-vs-build, MoE-vs-dense extraction quality, per-task benchmark recs. **#25** curate `model_recommendations` (cited per-job; EQ-Bench/MTEB overlay) — **answered by the 2026-06-27 research** (Part 3); only the MEASURED numbers remain (#28). Adopt `gguf-parser` to feed `fit.py` metadata (additive, #29; NOT a fit.py replacement); extend `hardware.py` beyond NVIDIA → AMD/Intel/Apple. Study **GPUStack v0.x** (NOT v2). TurboQuant fork ship-or-not (lean: stock default, advanced opt-in).

## ❓ DECISIONS to settle before the gated builds
Router-vs-spawn (+hybrid: router-serve + #19-spawn-for-switch-tuning) = USER's call (present receipts, don't switch unilaterally) · serving/switching mechanism (router vs llama-swap vs spawn) + keep-TTS-resident · job lifecycle on delete/rename (immutable id + editable label) · feature→job scope (global vs per-config) · samplers per-action vs also per-default · tokenizer for token-count · **cloud-native adapters** (Anthropic `thinking`, Gemini thinkingConfig/safety, **prompt caching**, Ollama-native think:false — verified NOT implemented: `anthropic.py:88,139`/`gemini.py:132,171` accept `think` but ignore it; no prompt caching anywhere) · `prefer_local_features` editable-vs-hardcoded · prose/embedding/recommendation defaults · kit git-dep packaging at release. *(RESOLVED by the 2026-06-27 audit: the `runner-manifest.json` / `vramFit.tiers` / binary-pin "editable-vs-hardcoded" question is settled — ALL of it moves to DB per A7; there is NO config-JSON exception. JV `engines/llm/config.py` is the mirror to fix in §G.)*

## DECIDED — not to build / superseded (no work)
§6.6: switches = freeform string in the lab, no per-flag fields, none in Providers; **#20 separate tuning UI → folded into the lab.** **#32** Locations↔Objects convergence → **dropped** (NOTE: a separate #32 "audit shared-vs-app" task also exists — reconcile which #32 the user means). VRAM fit math stays per-domain (only the "fits" badge is shared). App/UI prefs stay a simple store (not relational). Roles→jobs end-to-end. Connection-profiles/instruct-templates/CFG/beam/Author's-Note → design-reference only.

## DEFERRED-until-needed
P2.5 incremental per-scene writes; full per-entity write REST; RAG sqlite-vec ANN; IDB→SQLite import; drop dead `idb-keyval`; boot/splash UX for spawn; dead Tauri `images_save` cleanup. P5 extract kit `common/` → `@delebash/ui`; llama-swap optional layer; Tauri/package rename PR (track, don't churn).

---

# §G — JUSTVOICE — LATER, NOT current scope (isolated)
- **Speaker-attribution FEATURE build** (the LLM-CoT recipe — see Part 3 for the recipe; route to 35B-A3B+/cloud). *(The model research that informs it was correctly current/shared.)*
- **U5 adoption:** delete `engines/llm/*` → `install_llm(...)` + JV feature seeds + run seed; fix role→job consumer breakers; mount the shared llama.cpp runner; bring `ProductionConfig` per-feature layer to JW; supply catalog values + point-of-use labels; reconcile the two QuickSetups; persistent usage table; two-base reset/backup.
- **TTS Lab** (JV half of Compare): engine-knob schema (Chatterbox/Qwen3/Kokoro) + render/batch + merge-timing + audio-variant compare.
- **Audiobook-converter feature mining + BookNLP2 pipeline eval** — `JustVoice/docs/plans/2026-06-27-audiobook-tools-research-todo.md`.
- **JV capture/dictation fix** (wrongly shown shipped; align to server variant ids, drop dead localStorage). **JV Lab prompt-editor view** (`/v1/ai/prompts` editor — never built). JV catalog drift (`refine`/`voice_gender` first-class; dynamic-prompt features → base-text-in-DB); shared `ProviderForm` TTS-capability section; JV de-blobbing; fix JV CLAUDE.md "in-process" wording; JV planner wiring (keep TTS resident while swapping LLM); shared TTS `DownloadStrip`/task-queue; JV platform-settings checklist.

---

# PART 3 — Reference detail (inline — the data the build needs)

## 3.1 Per-job × per-tier matrix (no blank cells; "+RAM" = MoE RAM-gated; extraction/attribution = think-OFF for JSON)
| Job | CPU(32GB) | 8GB+32GB (floor) | 12GB | 16GB | 24GB | 32GB | 64GB-RAM | 96GB-RAM | 128GB+ |
|---|---|---|---|---|---|---|---|---|---|
| **chat** | 35B-A3B+RAM / 9B | **Qwen3.5-9B** (9B fast default; 35B-A3B "smarter" toggle) | Gemma-4-12B | Qwen3-14B | Qwen3.6-27B | Qwen3.6-27B | 27B (same) | 27B (same) | 27B (same) |
| **prose** | 35B-A3B (drafts) | 35B-A3B+RAM (9B drafts) | Qwen3-14B | Qwen3-14B | **Qwen3.6-27B** (local ceiling) | Gemma-4-31B | Gemma-4-31B | **★ Qwen3-235B+RAM** | Qwen3-235B (GLM-4.6 opt) |
| **extraction** | 35B-A3B+RAM | 35B-A3B+RAM | Qwen3-14B/35B-A3B | **Mistral-3.2-24B** | Mistral-3.2-24B | 35B-A3B/Mistral | **GLM-4.5-Air** | GLM-4.5-Air | GLM-4.5-Air |
| **attribution** | 35B-A3B (2-pass) | 35B-A3B+RAM (8B fails) | 35B-A3B+RAM | Mistral/35B-A3B | Mistral/35B-A3B | 35B-A3B | GLM-4.5-Air | Qwen3-235B/GLM-Air | GLM-4.5-Air |
| **analysis** | 35B-A3B+RAM | 35B-A3B+RAM | 35B-A3B+RAM | 35B-A3B+RAM | **Qwen3.6-27B** | 27B/35B-A3B | GLM-4.5-Air | **★ Qwen3-235B** | Qwen3-235B |
Cloud (Claude/GPT) is an optional ceiling, NOT required (a 96 GB rig runs Qwen3-235B locally for prose). MTP = speed knob, not quality.

## 3.2 Per-model-type switch sets (recommendation)
**DENSE** (9B/14B/27B/Mistral/Gemma): `-ngl 999 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --mlock --ctx-size <task>` + (MTP-GGUF dense only) `--spec-type draft-mtp --spec-draft-n-max 3` (~+40%).
**MoE** (35B-A3B/Scout/GLM/235B): `-ngl 999 --n-cpu-moe <fit> --no-mmap --mlock --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --ctx-size <task>`. **`--spec-type` on the A3B is MACHINE-DEPENDENT** — video budget-GPU +16% (17→19.7 t/s) vs a 3090 benchmark losing → expose + measure (#20 tok/s), don't hardcode.
**Per-job Plane-2:** extraction/attribution temp≈0 + **think-OFF under JSON** + flat schema; prose temp~0.8-1.0 + repetition penalties; analysis think-on (capped). **Full switch surface:** Plane-1 (load): `-ngl·--n-cpu-moe·--cpu-moe·--ctx-size·--cache-type-k/v·--flash-attn·--no-mmap·--mlock·--no-kv-offload·--batch/--ubatch·--threads/--threads-batch·--parallel·--cont-batching·--cache-reuse·--spec-type(+n-max)·RoPE/YaRN·-sm/-ts/-mg·--jinja` → all typed in `Overrides`/`LoadRequest` (`process.py:60-80`, `runner/schema.py:167-188`) + `extra_flags` passthrough. Plane-2 (per-request): temperature·top-k/top-p/min-p/typical·repeat/presence/frequency penalty·dry_*·xtc_*·json-schema·reasoning-budget·max-tokens.

## 3.3 Speaker-attribution recipe (the verified SOTA — for E1 scaffold now, full feature §G)
LLM zero-shot **Chain-of-Thought** is SOTA (beats BookNLP+ ~+12 PDNC1/+9 PDNC2; the gain is entirely on IMPLICIT quotes — why 8B fails). Recipe: **(1) character-roster discovery** (the published numbers used a GOLD alias list → a fresh manuscript needs an upstream discovery step) → **(2) chunk** each chapter ~4096 tok / 1024 stride → **(3) number every quote 1..n** → **(4) attribute the WHOLE chunk in ONE CoT pass → output JSON keyed by quote-id** → **(5) incremental** (feed prior overlapping-chunk predictions back, +~1pt). Reason-then-emit (CoT to reason → think-off to emit JSON; flat schema). Route to ≥24-32B-class (35B-A3B) or cloud for hard/unseen. Hybrid (BookNLP/BookNLP2 proposes spans+candidates → LLM resolves implicit) is a cost-saver (explicit is ~98% cheap). Coreference is the dominant bottleneck.

## 3.4 License gate (ship = GPL-3.0-or-later; the catalog LISTS, llama.cpp downloads on the user's box)
Apache-2.0/MIT = clean (Qwen, Mistral-3.2, GLM, **Gemma 4**). **Gemma ≤3 = NEVER seed** (Gemma Terms of Use). Llama-4 = Community License (use limits) — list + UI flag, never a default. Mistral Large = Research License (non-commercial) — list + flag.

---

# PART 4 — PROVENANCE (so nothing is "pointed away" — this is the evidence, in-doc)
- **Status:** panel-verified 2026-06-27 by 3 independent Opus agents (line-level reads + ran the suites: 144 runner + 77 JW pass). They corrected: A3 RAM-gate is a code fix; #31 partial; "zero readers" → only PinSwitch; credited uncredited shipped work.
- **Deep audit 2026-06-27 (inline, code-grounded, 5 passes + suite re-run — the user's "do it right, 3×").** Re-read the ACTUAL code line-by-line for every load-bearing claim (the panel had still missed things). **CORRECTED into this plan:** A3 overstated → only the `coarse_fit` GPU-branch RAM check remains (`fit.py:97-105`; RAM already threaded `api.py:124`); the binary-pin "defensible JSON exception" was WRONG → **A7 eliminates the whole `runner-manifest.json`** (incl. `flagPresets` still live at `process.py:206,247,249`, `safetyMarginMb`, binaries/pin); §6.6/D4 had glossed that `LuSwitchPresets.vue` is **still in Providers** (`LuModelCatalog.vue:244`); `routingBackend.js` #31 lines were stale (→`:15,93,94`); added the **PROVIDER_DEFAULTS** dup (`openai_compat.py:26-51` vs `seed.py:47-67`) + **tiers.py** hardcoded maps. **VERIFIED-ACCURATE, no change:** gateway gone (comments only); D1 switch wiring (`resolve_model_switches` live `install.py:101-110`→`lifecycle.py:209`; `resolve_profile_switches` uncalled-by-design; PinSwitch zero-reader); `extra_flags` passthrough IS wired (`lifecycle.py:86-104`); master citations largely correct; old-doc remaining items (#28/#23/streaming-ports/JV-deblob) already folded. **Suite re-run:** 144 runner pass + ruff clean; `test_plane2_params` confirmed fails-in-isolation. Full per-finding log: session scratchpad `audit-findings.md`.
- **D9 ruling folded in (USER-RULED 2026-06-27):** reading `switch-and-preset-architecture.md` in full exposed that the master's old Phase-D1 "build PinSwitch" **contradicted** the LOCKED design D9 (which DROPS `model_switches`+`pin_switches`, makes `job_route_switches` the Profile's switches). User ruled **D9 is correct**; D1 rewritten to it. Verified status: model_switches drop is **UI-done / backend-pending**; pin_switches is **inert** (trivial drop); job_route_switches editable but **load-reader pending**. This was the master's biggest stale spot — it existed because the D9 decision was never propagated from the design doc into the master (the "update docs with decisions" lesson).
- **Outstanding-work basis:** a 13-agent audit of 17 plan docs (339 items) + 3 confirmers (added 20 items) — the former `complete-remaining-plan.md`, now folded here.
- **Model research:** two `/deep-research` runs (catalog: 104 agents/22 sources/17 confirmed; attribution: 101 agents/19 sources/25 confirmed) + a 3-reviewer model panel. Sources: EQ-Bench Creative Writing v3 + Longform · BFCL (gorilla.cs.berkeley.edu) · JSONSchemaBench (arXiv 2501.10868) · llama.cpp #20345 (JSON+thinking) · Doctor-Shotgun MoE-offload guide · unsloth.ai/docs · HF repos (Qwen3.6/3.5, Mistral-3.2-24B, GLM-4.5-Air, Llama-4-Scout, Qwen3-235B, gemma-4) · aithinkerlab (Qwen3.6-27B vs Gemma-4-31B creative) · attribution: arXiv:2406.11380 + NAACL 2025 (LLM CoT SOTA), arXiv:2307.03734 (PDNC coref), AAAI 2024 (SIG), LREC 2022 (PDNC), booknlp/booknlp.
- **Every other plan doc is SUPERSEDED — each is bannered "⛔ NOT THE CURRENT PLAN → this master" at its top; kept as historical background / raw evidence only.** In `just-llm-runner/docs/plans/`: the model-catalog research+recs (`2026-06-27-model-catalog-research-and-recommendations.md` + `-evidence.md`), `2026-06-27-speaker-attribution-llm-research.md`, `2026-06-24-llamacpp-switches.md`, `-small-vram-multimodel-research.md`, `2026-06-25-serving-architecture-research.md`, `2026-06-24-quicksetup-redesign.md`, `-server-model-management-brief.md`, `2026-06-23-shared-component-architecture.md`, and the prior `2026-06-27-model-catalog-build-plan.md`. In `justwrite-app/docs/plans/`: `2026-06-27-{complete-remaining-plan,llm-status-index,switch-and-preset-architecture,switch-param-lab}.md`, `2026-06-20-shared-ai-stack-plan.md`, and the older convergence / cutover / gateway / storage / server-migration docs. **Only `justwrite-app/MORNING_RECAP.md` + `justwrite-app/docs/plans/2026-06-27-session-handoff.md` point here — nothing else.**

## Pending-task index (task # → location here)
#11→Phase F · #18→done(+🔒 quality eval) · #19→done · #20→C2 · #21→D2/D3 · #22→done(subset)+E2(rest) · #23→F · #24→E1 · #25→answered(Part 3)+#28 · #27→F(🔒❓) · #28→Research · #29→F · #30→done(+residual F) · #31→F(partial) · #32→F(reconcile) · #33→done · #34→F · attribution feature→§G.
