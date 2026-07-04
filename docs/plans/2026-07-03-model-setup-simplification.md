# Plan — Model-setup simplification (delete the grid · one good model + embed · catalog under Providers · collapse recommendations to a quality signal + a model description)

> ⛔ **LIVE STATUS (2026-07-03): ALL PHASES A–E BUILT + verified + rules-checked (PASS). Phase D rewired QuickSetup onto the taskKind-preset model + the seed was aligned to one model; Phase E is docs. QuickSetup is now a WORKING front door (the old one wrote the model to the dead `routing.default`, which the current task system no longer reads → "Apply" did nothing; the rewire writes it onto the task presets, verified live).**
> ⚠️ **DESIGN UNDER USER REVIEW (2026-07-03, post-build):** on testing, the user found the model surface confusing — partly because the *pushed* branch still had the OLD broken QuickSetup (the Phase D fix was unpushed), and partly a genuine shape question: I built QuickSetup to **auto-pick ONE best-fit model** (+ an override dropdown); the user expected to **see the models that fit and choose from a list** ("a list of models we added for QuickSetup to choose from"). The working Phase D was pushed so the user can evaluate the real thing; the auto-pick-vs-pick-from-list shape is **OPEN** — do NOT treat the auto-pick shape as final. Also clarified for the user (all verified, not bugs): the catalog is the seeded downloadable list (never empty; "Your models" is empty until you download — a fresh seed shows all 11 behind "Browse catalog"); a DB reset clears catalog *metadata* but NOT downloaded model *files* (so a previously-downloaded 9B still shows on disk); the task presets showing `qwen3.6-35b-a3b-mtp` is the seeded default placeholder, not stale state.

---

## MODEL-SURFACE REDESIGN — PLAN OF ACTION (2026-07-03 · IN DISCUSSION · NOT BUILT · awaiting the user's explicit "go")

**Process note (why this section exists, and a standing rule the agent broke and is correcting).** After Phase D shipped, the user reviewed the model surface on their machine and opened a long design discussion that is still in progress. During that discussion the agent began writing code (a `quality_rank`→`embedding` field swap plus fit-number edits) before the user said "go", and was stopped. Those uncommitted changes were reverted, so the tree sits clean at the committed Phase D (runner `18bc4fc` / JW `8ce73f6`). The standing rules are reaffirmed here and must be honored on this work: no code is written until the user literally types the word "go"; a question such as "what do you think?" is a question, never a "go"; the plan of action is documented in this section BEFORE any code is written; and the agent does not make the design calls — the user does, and the agent stops and surfaces them. This section is that documented plan of action and is kept live as the discussion converges.

**What the user is unhappy with (all verified against the running app during the discussion, not guessed).** The catalog was hidden behind a "Browse catalog" toggle so a fresh install showed an empty "Your models" list — the user wants the catalog shown as one visible list with an Installed/Not-installed marker, the way it used to be. The catalog's "Load" button implies "this is the model the whole system uses," but loading only runs a model in the engine to try it and does not set it as the model features use — a genuinely confusing seam. QuickSetup showed the embedding as a fixed line effectively hardcoded to Nomic Embed, with no way to choose a different embedding (embedding is not a task, so it has no picker). The eleven seeded models are unverified example data with a lot of overlap. QuickSetup's "plan for card" VRAM options stopped at 24 GB even though the RTX 5090 is 32 GB and workstation cards go higher. And the fit numbers were wrong for several dense models (the user caught the Gemma-4-12B claiming it "fits a ~7 GB GPU").

**Decisions the user has confirmed in this discussion (locked unless the user re-opens them).** The catalog is un-hidden into one visible list, every model shown, marked Not-downloaded / Downloaded / Default (a badge on the model currently used as the default), with no "Load"/"Unload" jargon. Each model gets a plain "Download" action (fetch the file only) plus a "Set as default" action for LLMs (which writes that model onto the task presets — the same effect QuickSetup's Apply has, so what features run is the model you set) and a "Set as embedding" action for embedding models (which writes routing.default.embedding*). After QuickSetup or Set-as-default runs, the catalog reflects it: the chosen model shows as Downloaded and carries the Default badge. QuickSetup's embedding becomes a dropdown that lists only the embed models that fit the box and defaults to the best embed that fits (no longer pinned to Nomic), and QuickSetup's model dropdown lists only the models that fit the box. The "plan for card" VRAM options extend to 32 GB (RTX 5090), 48 GB and 64 GB. The catalog grid groups the models that fit the machine together at the top (non-fitting below) and gains a search box and a sort control. QuickSetup stays the guided front door that auto-picks one model and sets it; the catalog is where the user picks manually and curates which models exist, and a user can mark their own added model as an embedding model.

**Model curation — the user's direction (final set still to be confirmed).** Narrow the eleven unverified example models to a small curated set, but NOT to a single model per hardware tier: dense and MoE are different tools, so where the choice is real, keep both. On a 12–16 GB card a 14B dense runs fully on the GPU (fast, needs only ~14 GB RAM) while a 35B-A3B MoE runs via CPU expert offload (higher quality, needs ~32 GB+ RAM, slower) — both are legitimate picks for the same box depending on the user's RAM and their speed-versus-quality preference. The working set under discussion is: Qwen3.5 9B (fast/small), Qwen3 14B (fast dense mid), Qwen3.6 35B-A3B (quality default, floor via offload), Qwen3.6 27B (big dense, 24 GB+, fully on-GPU), GLM-4.5-Air (64 GB RAM workstation) and Qwen3-235B (96 GB RAM), dropping gemma-4-12b, mistral-small-3.2-24b, gemma-4-31b and llama-4-scout. The exact final set and whether the 12–16 GB tier keeps the 14B dense are still the user's call.

**quality_rank — to be dropped (tentative, contingent on the auto-pick rule).** The user reasoned that `quality_rank` was a construct of the old recommendations system; with a curated, hardware-tier-mapped set and no on-machine measurement, a numeric quality rank is dead weight pretending to be authoritative, so drop it and let QuickSetup's auto-pick run off fit plus model size. This is REOPENED by the dense-versus-MoE point: "auto-pick the biggest model that fits" is too crude because it would always grab an offloading MoE over a faster dense model that fully fits the VRAM. So whether `quality_rank` is dropped depends on settling the auto-pick rule (see OPEN below); if the rule needs an explicit ordering, some signal remains necessary even if it is not called "quality_rank".

**Embedding models — verified this session via the app's own inspect endpoint (real Hugging Face repos, real file sizes; not recalled).** Keep Nomic Embed Text v1.5 as the CPU floor (English, ~137M). Add two verified GGUF embedding models: bge-m3 (`gpustack/bge-m3-GGUF`, Q4_K_M, ~0.44 GB, BERT arch, multilingual across 100+ languages, MIT, CPU-fine) and Qwen3-Embedding-8B (`Qwen/Qwen3-Embedding-8B-GGUF`, Q4_K_M, ~4.68 GB, ~6.9 GB estimated VRAM, qwen3 arch, the #1 multilingual MTEB model, Apache-2.0). Qwen3-Embedding-4B (`Qwen/Qwen3-Embedding-4B-GGUF`, ~2.5 GB) and 0.6B (`Qwen/Qwen3-Embedding-0.6B-GGUF`, ~0.64 GB) are also verified and available as middle options if wanted. Because "bge-m3" contains no "embed" in its id or name, the existing `/embed/i` name heuristic misclassifies it; the correct identifier is an explicit, editable `embedding` boolean on the catalog row, which also lets a user mark their own added embedding model. (An in-progress `quality_rank`→`embedding` field swap toward this was the code that was reverted for jumping ahead; it will be redone only after "go".)

**Fit-number audit — verified via the app's inspect endpoint reading the real GGUF files (the dense estimates were hand-set too low).** Gemma-4-12B was seeded needing 7000 MB VRAM but the real estimate is ~11134 MB (the file alone is 7.1 GB). Qwen3-14B was 11000 but is ~11352. Mistral-24B was 14000 but is ~16813 — the file alone is 14.3 GB, so 14000 could not even hold the weights. Gemma-4-31B was 22000 but is ~27091. Qwen3-9B (7500 vs est 7320) and Qwen3.6-27B (20000 vs est 18780) are fine as-is. The MoE numbers (6000 / 12000 / 16000 for 35B-A3B / GLM-Air / 235B) are the CPU-offload floor — a different concept from the full-GPU estimate — and are left as reasoned estimates. If the dropped models stay dropped, only the kept models' numbers need correcting.

**Provenance honesty (the user asked whether the seeded models and settings are real research for our use case or just test data).** The model SELECTION came from a real deep-research run (104 agents, 22 sources, claims verified and killed) plus a 3-reviewer panel, tied to the writing jobs (prose, chat, extraction, analysis) — it is not random test data. But the fit/VRAM SIZES were never verified: the research doc itself says "confirm exact quant sizes at build time (some HF pages blocked the fetcher)," and that confirmation never happened, which is why the wrong numbers shipped. The per-job "best model" is reasoned from general benchmarks and reviews, NOT measured on JustWrite prose (#28). On settings: the feature PROMPTS are genuine fiction-editor prompts ported verbatim from the working app, and the temperatures/samplers are principled starting defaults matched to each task's nature (low + deterministic + JSON for extraction, warmer for creative prose), NOT measured-optimal. So the honest summary is: grounded and reasoned, not fake — but with unvalidated numbers (one set provably wrong, now caught) and nothing benchmarked on the user's own writing; the real fix for the quality claims is the built-in Tune & measure path (#28).

**OPEN — the user's calls, still to be made before any build is authorized.** First, the auto-pick rule: (a) prefer a dense model that fully fits the VRAM for speed, falling back to MoE offload only when no dense model fits; (b) always take the biggest / highest-quality model that fits, favoring quality over speed; or (c) do not auto-pick a winner at all — QuickSetup lists the fitting models and the user chooses. The agent leans (a) but has NOT decided. Second, the final model set and whether the 12–16 GB tier keeps the 14B dense. Third, whether dropping `quality_rank` stands given the auto-pick rule may still need an ordering signal. Fourth, how QuickSetup's earlier "leave as is, one model auto-picked" direction reconciles with the dense-versus-MoE nuance in the auto-pick rule.

**Shared-component plan (reuse, rule #3) — to apply WHEN the build is authorized.** The catalog-meta join is already the shared `useCatalogMeta` singleton, consumed by both `LuModelCatalog.vue` and `QuickSetup.vue`. The "Set as default" preset-write, the "Set as embedding" routing-write, and the current-default / current-embedding state that drives the Default and Embedding badges should be extracted into one shared service (for example `ui/src/common/services/modelApply.js`) consumed by BOTH QuickSetup and the catalog so the two surfaces never drift — following the `useRunnerModels` singleton precedent. None of this is written until the user says "go".

---

## MODEL-SURFACE REDESIGN — FORMALIZED DESIGN (2026-07-03 · APPROVED · awaiting the user's "go" to build)

The discussion above converged and the user approved the design on 2026-07-03 ("go ahead and update design in detail, wait to code"). This subsection SUPERSEDES the OPEN-items paragraph above: the **auto-pick rule is CONFIRMED** — originally option (a), then **REFINED on 2026-07-04 (full algorithm in §10, decision record in §15)** to a "most-capable model that still streams faster than you read" **speed-floor rule** that keeps a usable A3B-MoE offload as a candidate while excluding the slow dense-partial-offload; the **auto-composed factual description is CONFIRMED**; QuickSetup stays **one-model-auto-picked**; and `quality_rank` is **KEPT** as the curated capability order (the 2026-07-04 refinement REVERSED the earlier "drop it" — the speed-floor rule needs a ranking signal that raw parameter count cannot give, because parameter count overstates a 3B-active MoE). Two minor curation picks remain (flagged in §9), and the **entire embedding half — §14 items (2)/(5)/(6) AND the embed-fit-numbers portion of (8) — stays OPEN behind the §12 embedding-serving gap**, so "approved" here means the LLM-side design, NOT the embedding side. **No code is written until the user literally types "go."** Everything below was verified against real code and real GGUF files this session (not recalled).

**1 · Model philosophy — one model, settings per task.** The default is ONE model on the local engine, chosen for the user's hardware. Deliberate, not merely simpler: the bundled llama.cpp runner holds ONE model at a time (verified — `runner/api.py`/`lifecycle.py`), so per-task models would force a multi-gigabyte unload/reload on every task switch (thrash), and the per-task "which model is best" has never been measured on the app's own tasks (#28). What genuinely differentiates the tasks is their SETTINGS — temperature, think, json_mode — seeded per task and applied automatically at dispatch (verified in `justwrite-app/server/justwrite_server/seed_feature_prompts.py`: every JustWrite task currently runs `think:False`; extraction at temp ~0.15 + `json_mode:True`; prose at ~0.7). So on one model, extraction still behaves like extraction and prose like prose, for free. The per-task AND per-feature model override stays **EXACTLY AS IT IS TODAY — UNCHANGED** (the Tasks-tab preset assignment + the per-feature routing pins); it is NOT demoted, hidden, or touched by this work. The ONLY change is that QuickSetup's default becomes one model that fits the hardware. (The override is genuinely useful for cloud providers, which have no reload cost, and for a future routing feature where a box with enough VRAM+RAM could hold several models loaded at once — but that is existing behavior we are keeping, not changing.)

**2 · The catalog — a verified, desktop-capped hardware ladder (two axes).** A DENSE ladder gated by VRAM (runs fully on the GPU, fast) and a MoE ladder gated by system RAM (experts offload, higher quality, slower), capped below server-only frontier models (235B+/1T need 256 GB+ RAM or multi-GPU and crawl even then — cloud-only at home; dropped per the user). Every repo + size below was inspect-verified this session against the real GGUF files.

Dense (VRAM, fully on GPU): **Qwen3-8B** (`unsloth/Qwen3-8B-GGUF`, ~5.0 GB Q4_K_M, ~7 GB VRAM — 8 GB card); **Qwen3-14B** (`unsloth/Qwen3-14B-GGUF`, ~9.0 GB, ~11 GB VRAM — 12–16 GB card); **Qwen3-32B** (`unsloth/Qwen3-32B-GGUF`, ~19.8 GB, ~22 GB VRAM — 24 GB card; the 2026 pick for narrative writing on a 24 GB rig); **Llama-3.3-70B** (`unsloth/Llama-3.3-70B-Instruct-GGUF`, ~42.5 GB, ~46 GB VRAM — 48 GB card; the best all-round local creative-writing model per current write-ups).

MoE (system RAM, offload): **Qwen3.6-35B-A3B** (`unsloth/Qwen3.6-35B-A3B-MTP-GGUF`, ~22.9 GB, 8 GB VRAM + 32 GB RAM — floor MoE / smart default) *[agent lean; the user may swap for the lighter Qwen3-30B-A3B (`unsloth/Qwen3-30B-A3B-GGUF`, ~18.6 GB) — §9 PENDING]*; **GLM-4.5-Air** (`unsloth/GLM-4.5-Air-GGUF`, ~67.7 GB, 64 GB+ RAM — high-RAM ceiling) *[agent lean; gpt-oss-120b (`unsloth/gpt-oss-120b-GGUF`, ~62.8 GB) may be added as a second high-RAM option — §9 PENDING]*.

Embeddings (also a ladder): **nomic-embed-text** (`nomic-ai/nomic-embed-text-v1.5-GGUF`, ~0.1 GB, English, CPU floor); **bge-m3** (`gpustack/bge-m3-GGUF`, ~0.44 GB, multilingual 100+ languages, MIT, CPU-fine); **Qwen3-Embedding-8B** (`Qwen/Qwen3-Embedding-8B-GGUF`, ~4.68 GB, ~7 GB VRAM, #1 multilingual MTEB, Apache-2.0 — the big multilingual embed for big cards).

Dropped from the 11-model seed: gemma-4-12b, mistral-small-3.2-24b, gemma-4-31b, llama-4-scout (overlapping / unverified / use-limited) + the server-only qwen3-235b. At build time the latest point-version of each Qwen is reconfirmed (a 3.6 variant may supersede a base-Qwen3 one).

**3 · QuickSetup — the guided front door.** Auto-picks ONE model by the CONFIRMED **speed-floor rule** (REFINED 2026-07-04 from the original option (a) — full algorithm in §10): among the models that RUN on the box, keep only the ones that stream faster than reading speed — a DENSE model that fully fits VRAM (`fit==ok`, all on GPU, fast) OR an A3B-style MoE that offloads its experts to RAM usably (`type==moe` AND `fit ∈ {ok, tight}`, since only ~3B is active per token) — and among those pick the model with the best curated capability rank; the slow dense-partial-offload case (`type==dense` AND `fit==tight`) is EXCLUDED, with a fallback to the best runnable model when nothing clears the speed floor. The model dropdown lists ONLY fitting models. The embedding is a dropdown of only the fitting embed models, defaulting to the best embed that fits (no longer hardcoded to nomic). The "plan for card" VRAM options extend to 32 / 48 / 64 GB. On Apply it writes the one model onto the task presets, sets the embedding via `routing.default.embedding*`, and downloads/loads the pick; afterward the catalog reflects it (Downloaded + the Default badge).

**4 · Catalog UX.** One VISIBLE list (the "Browse catalog" toggle is gone), models that fit grouped at the top (non-fitting below), plus a search box and a sort control. Row status is Not-downloaded / Downloaded / a Default badge on the current default model (and an Embedding badge on the current embedding). Actions are a plain Download (fetch the file only) plus Set as default (LLM → written onto the task presets, same effect as QuickSetup) or Set as embedding (embed → written to routing); the Load / Unload jargon is removed (loading is automatic when a model is used). After QuickSetup or Set-as-default the catalog shows the model Downloaded + Default. The Edit form KEEPS the quality-rank field (surfaced as the curated capability order that drives the auto-pick ranking) and gains an embedding checkbox.

**5 · The smart Add-a-model flow.** Paste a Hugging Face GGUF repo → **"Get model info"** reads the repo tree in one call (`runner/models.py` `_tree`) and fills the name + a QUANT dropdown where each quant carries its real download size (`_entry_size` — the true LFS byte size) → pick a quant → **"Test fit"** computes the fit for THAT quant and inspects its GGUF header for exact context / type / recommended samplers (re-run on quant change — a different quant is a different size and a different fit) → add / download. The DESCRIPTION is auto-composed from grounded facts — architecture / type / params / context from the GGUF plus language (→ multilingual) / license / base-model from the HF model API — editable, with the card's first line as an optional rough draft (**CONFIRMED** by the user). Reuses existing primitives (`_tree`, `_entry_size`, `select_files`, inspect); only a small "list a repo's quants + sizes" helper is new.

**6 · Data-model changes.** KEEP the `quality_rank` column + `CatalogRow.qualityRank` + its seeder line + the `test_shared_storage` roundtrip assertions — REVERSING the earlier "drop it" (2026-07-04): the refined speed-floor auto-pick needs a curated capability order to rank the fast-enough candidates, and raw parameter count cannot serve because it overstates a 3B-active MoE (a 35B-A3B would falsely outrank a 32B dense). `quality_rank`'s existing semantics already fit exactly — "curated overall-quality order (LOWER = better); QuickSetup picks best-that-fits; 100 = unranked" (`model_catalog_api.py:50`) — so no rename and no schema churn on it; it is re-seeded for the curated 6-model ladder and labeled "reasoned, not measured (#28)." ADD an editable `embedding` boolean on the catalog (`db.py` ModelCatalog + `CatalogRow` + `stores.py` `_catalog_to_wire`/`upsert` + seeder) so bge-m3 (no "embed" in its name) is correctly an embed and a user can mark their own — this is now a pure ADD (one new column), NOT a field-swap. Seed fit numbers from the inspect-verified real sizes. Schema touch → drop-and-reseed the dev DB.

**7 · Reuse (rule #3).** `useCatalogMeta` (shared singleton, both consumers) gains an `embeddingById` map and KEEPS `qualityById` (the refined auto-pick ranks the fast-enough candidates by the curated capability order, so `qualityById` stays load-bearing — not dropped). The Set-as-default preset-write, Set-as-embedding routing-write, and current-default / current-embedding state (badges) are extracted into ONE shared `ui/src/common/services/modelApply.js` consumed by BOTH QuickSetup and the catalog (the `useRunnerModels` precedent). A new backend helper + endpoint lists a repo's quants + sizes (reusing `_tree`/`_entry_size`).

**8 · Build order (only after "go").** (1) Seed — curate to the verified ladder, KEEP + re-seed `quality_rank` (the curated capability order), add the `embedding` flag, verified fit numbers. (2) Backend field ADD (`embedding` column across db.py / CatalogRow / stores.py / seeder / test — `quality_rank` KEPT, so this is an ADD, not a swap) + list-quants helper + endpoint. (3) Shared `modelApply` + `useCatalogMeta` embedding map (`qualityById` kept). (4) QuickSetup — the §10 speed-floor pick, fitting-only model + embed dropdowns, 32/48/64 GB cards, shared service. (5) Catalog UX — visible, fit-grouped, search + sort, Download / Set-as-default / Set-as-embedding, badges, no Load/Unload, Edit-form embedding checkbox. (6) Smart Add flow — Get model info → quant dropdown w/ sizes → Test fit → auto-inspect + auto-composed description → download. (7) Tasks-tab — **NO CHANGE**: the per-task/per-feature model override stays exactly as today (NOT demoted — this step is listed only to state explicitly that the build does not touch it). (8) Verify — drop+reseed, runner ruff + pytest, JW build:vite + headless smoke + a probe (Set-as-default, embed dropdown, quant list), rules-checker. (9) Docs — this LIVE STATUS + `MORNING_RECAP.md` + `docs/models.md` — commit per-repo on `claude/admiring-galileo-il3q0o`. **NOTE: every embedding-touching step (the embed dropdown in (4), Set-as-embedding in (5), the embed models + embed fit numbers) is BLOCKED by §12 and is NOT built until that gap is resolved.**

**9 · DECISION STATE (2026-07-03, UPDATED 2026-07-04 — NOT "all locked": the LLM side is settled, the embedding side is OPEN).** Floor MoE = **Qwen3.6-35B-A3B** (confirmed). High-RAM ceiling = **GLM-4.5-Air alone** (confirmed — beyond it the user adds their own model). LLM-side confirmations: the **refined speed-floor auto-pick rule** (§10, supersedes plain option (a); confirmed 2026-07-04) · one-model default · per-task/per-feature override UNCHANGED (not demoted) · **KEEP `quality_rank`** as the curated capability order (2026-07-04 — reverses the earlier "drop it") · add the `embedding` flag · the smart Add flow with the auto-composed factual description · the dense LLM ladder + its inspect-grounded fit numbers. The catalog is the 6 LLMs + 3 embeds in §2 (two minor curation picks — the 30B-A3B swap and adding gpt-oss-120b — remain the user's call). **STILL OPEN (do NOT treat as locked): (a) the §12 embedding-serving gap — the current blocker; and behind it (b) the embedding-side agent decisions §14(2) bge-m3 + Qwen3-Embedding-8B, §14(5) the "Set as embedding" mechanism, §14(6) the Embedding badge, and (c) the embed-fit-numbers portion of §14(8).** So this design is explicitly NOT "nothing open."

**10 · The exact auto-pick algorithms (REFINED + code-verified 2026-07-04 — locked so there is NO ambiguity at build time).** Fit bands from `/v1/llm-runner/models` are `ok` (active path fully fits GPU) / `tight` (fits with some offload) / `cpu` (no GPU — CPU-only box) / `no` (won't fit) / `unknown`; VERIFIED in `runner/fit.py:85,103‑111` + `runner/schema.py:140`. The runnable set is `{ok, tight, cpu}`. **VERIFIED how MoE-offload is banded (the crux for the speed-floor rule):** `coarse_fit` does NOT compute MoE offload from active params — a MoE encodes its offload by setting an explicit `min_vram` override to its *active-path* VRAM (e.g. 35B-A3B → ~8 GB, not the 22.9 GB weights), fed in at `api.py:47` and used as `need` at `fit.py:103` (docstring `fit.py:87‑89`); a separate RAM gate (`fit.py:101‑102`, from `api.py:48`) returns `no` when the box lacks the MoE's declared RAM floor, so any MoE that survives to `ok`/`tight` is guaranteed to have the RAM to hold its offloaded experts. CONSEQUENCE (verified): a usable MoE lands `ok`/`tight`, and a slow dense-partial-offload ALSO lands `tight` — so **the `fit` band ALONE cannot tell them apart; the rule MUST combine `fit` + `type`.** `type` (dense|moe) comes from the catalog join (`CatalogRow.type`, `model_catalog_api.py:42`) via `useCatalogMeta` (NOTE: `type` is NOT on the runner `RunnerModelInfo`, `schema.py:127‑142`; but `active_params` IS — `api.py:119`/`schema.py:137` — plus `tier` can read `low-vram-moe`, both usable as fallback MoE signals). The curated capability order comes from `quality_rank` (`useCatalogMeta` `qualityById`; LOWER = better). **LLM auto-pick — the speed-floor rule ("most capable that still streams faster than you read"; supersedes plain option (a)):** candidates = runnable AND not `embedding`. Compute FAST-ENOUGH = the candidates that stream faster than reading speed = (`type==dense` AND `fit==ok`, fully on GPU) OR (`type==moe` AND `fit ∈ {ok, tight}`, A3B-style offload usable because only the active path runs per token). EXCLUDE from FAST-ENOUGH the slow dense-partial-offload (`type==dense` AND `fit==tight` — verified in `fit.py` to be a real `tight` case where a dense pays full CPU compute on the spilled layers every token). If FAST-ENOUGH is non-empty → pick the model with the best (lowest) `quality_rank` among it. FALLBACK (so the pick is never empty) → if FAST-ENOUGH is empty, pick the best `quality_rank` among ALL runnable (this is where a `tight` dense, or on a CPU-only box a `cpu` model, is accepted because nothing faster runs). Rationale: JustWrite is mostly generate-and-read, so weight quality up, but never auto-land on the partial-dense-offload trap. **Embedding auto-pick (⛔ BLOCKED by §12 — NOT buildable until the embedding-serving gap is resolved):** candidates = runnable AND `embedding`; pick the best `quality_rank` (Qwen3-Embedding-8B on a card with ≥~7 GB VRAM, else bge-m3, else nomic). **Catalog "Default" badge / current-default** = the model most task presets share (the mode across `preset-assignments.taskKinds` values → `engine-presets`), computed in `modelApply`; **Embedding badge** = `routing.default.embeddingModel`. **Set as default** writes the chosen model onto every task preset that currently shares the previous dominant model (non-clobber — a preset the user re-pointed keeps its model), the same logic Phase D's QuickSetup already ships (`prompts.py`/`preset_resolve.py` cascade unchanged).

**11 · Pre-flight re-verification (2026-07-03, against the real code — no open conflicts, so no mid-build questions).** (a) Fit bands confirmed in `runner/fit.py` (`coarse_fit` → `ok|tight|cpu|no|unknown`) — READ IN FULL 2026-07-04 along with `api.py get_models` + `schema.py RunnerModelInfo`; the refined speed-floor rule (§10) keys on `type` + `fit` together (a MoE and a slow dense both read `tight`, so the band alone is insufficient — the rule combines them), and §10's algorithm is directly implementable on this code. (b) **The per-task AND per-feature model override is UNCHANGED and OUT OF SCOPE** — the user confirmed it stays exactly as it is today; there is no "demote"/hide step (that was mis-scoped agent wording, now removed). For reference only, the override lives in three places, ALL unchanged: (i) the Tasks tab's **Lab has a Provider + Model picker** — `LuModelPicker` in `ConfigColumn.vue` (`patchPin` sets a `{providerId, model}` pin on the task's preset column) — this is the direct per-task MODEL override, confirmed live in the running app; (ii) the task→preset assignment (`TaskKinds.vue` `setTaskPreset` → `/v1/ai/preset-assignments/task-kind`); (iii) per-feature routing pins. This work touches NONE of them. (Correction: an earlier pre-flight note wrongly claimed the Tasks tab has no model picker — it DOES, in the Lab column; the agent had grepped only `TaskKinds.vue` and missed `ConfigColumn.vue`.) QuickSetup/Set-as-default simply write the ONE default model onto the task presets; a user who has overridden a task/feature keeps their choice (the non-clobber write already respects that). (c) `modelApply.setDefaultModel` reuses Phase D's shipped non-clobber preset-write; the current-default badge = the mode across `preset-assignments.taskKinds` → `engine-presets` (same endpoints the Tasks tab already uses). (d) The list-quants + auto-inspect Add flow reuses `runner/models.py` `_tree`/`_entry_size` + the existing inspect endpoint — a new read-only helper/endpoint, no schema or HF-access change. (e) QuickSetup + LuModelCatalog changes sit on the committed Phase-D base (the `useCatalogMeta` singleton already shared). Conclusion (CORRECTED by §12 below): the QuickSetup / catalog / Add-flow / field-ADD steps (`embedding` column added, `quality_rank` KEPT) are implementable on the current code, BUT continued verification found a real OPEN BLOCKER — the embedding-serving gap (§12). **The LLM half is ready to build; the embedding half is NOT, until that path is resolved.**

**12 · EMBEDDING-SERVING GAP (2026-07-03 · CRITICAL OPEN BLOCKER · must be resolved before the embedding UI is built).** Continued pre-flight verification — prompted by the user's question "is the embedding loaded all the time?" — uncovered a gap the plan had assumed away. VERIFIED (file:line): embeddings are served through the provider ADAPTER's `embed()` method (`llm_runner/llm/api.py:130`, `POST /v1/ai/embeddings` → `adapter.embed(input, model)`), a path completely separate from chat dispatch (`dispatch.py` contains ZERO "embed" references). The `embed()` implementations that exist are on the Ollama adapter (`ollama.py:195`, native `/api/embed`) and the OpenAI-compat adapter (`openai_compat.py:235`, `POST {base_url}/embeddings`). The BUNDLED RUNNER has NO embedding-serving code at all — grepping `llm_runner/runner/` for "embed" returns only `embedding_length`/`embedding_dim` used in the FIT math (`fit.py`, `gguf.py`, `process.py`); there is no separate embed process and no second server. And the runner loads ONE model at a time (`runner/api.py`/`lifecycle.py`). CONSEQUENCE: the bundled runner cannot hold the chat LLM and an embed model (nomic) loaded at the same time, so the plan's claim that "the embedding is a fixed always-on utility that rides `routing.default`" does NOT hold for the local runner — locally it would either reuse the loaded chat model's embeddings (ignoring the chosen embed model) or have to swap to nomic and back (thrash). NOT YET VERIFIED (do NOT assume): the exact local embed path — whether the `local-llamacpp` provider's adapter reuses the loaded model, loads nomic on demand, or whether JustWrite's RAG (`services/rag/*`, `embedApi.js`) actually routes embeddings to Ollama (which CAN hold multiple models) or a cloud provider. The `local-llamacpp` adapter class was not located this session (`config_builder.py` / `runner_adapter.py` were wrong guesses; find the real adapter next). IMPLICATION: the entire embedding half of this plan — the QuickSetup embedding dropdown, "Set as embedding," and the three seeded embed models (nomic / bge-m3 / Qwen3-Embedding-8B) — rests on a local-embed path that is NOT confirmed to function. RESOLUTION REQUIRED before building the embedding UI: **(option 1)** trace the `local-llamacpp` adapter's `embed()` + JustWrite's `embedApi.js`/RAG to establish exactly how local embeddings resolve today, then design the embedding UI to match reality (e.g. only offer "Set as embedding" for providers that actually support it, or add a second runner process for the embed model — new work); **(option 2)** the user states how embeddings are meant to work (e.g. "embeddings come from Ollama / cloud; the bundled runner never embeds") and the plan is scoped to that. This is the current open item; NO code until it is settled. **→ RESOLUTION DIRECTION (2026-07-04, user-approved): SUBSUMED into the serving/VRAM-manager workstream — the bundled runner moves to llama.cpp ROUTER MODE and keeps a tiny embed model CO-RESIDENT with the chat model, routed by model id (so `/v1/embeddings` hits the embed model). Full design: `2026-07-04-serving-vram-manager.md`. One GATING runtime check remains — that `/v1/embeddings` routes to the co-loaded embed entry in router mode (env-blocked in the dev container: GitHub downloads denied → no `llama-server`; confirm on a real box). Per the user's (b) choice the whole model-surface build WAITS on that manager design.**

**13 · Pre-flight verification results so far (2026-07-03 · file:line evidence — what has actually been READ in full, not grepped-and-assumed).** BACKEND / Add-flow: `runner/models.py` `_tree()` (`:64`) fetches the repo file listing, `_entry_size()` (`:74`) the true LFS byte size, `select_files()` (`:84`) filters by quant → the "list quants → per-quant size → per-quant fit" Add flow is feasible with no new HF plumbing. `stores.py` `_catalog_to_wire` (`:286`, wire `qualityRank` at `:292`) + `upsert` (`:311`, `quality_rank` write at `:332`) are the exact two sites where the new `embedding` field is ADDED alongside the RETAINED `qualityRank` (kept, not swapped — 2026-07-04). `runner/fit.py` `coarse_fit` returns `ok|tight|cpu|no|unknown` (READ IN FULL 2026-07-04, with `api.py:34‑49,72‑133` + `schema.py:127‑142`): the MoE-offload band is set by the `min_vram` active-path override + a RAM gate (`fit.py:87‑89,101‑103`), so a usable MoE and a slow dense both read `tight` → the §10 speed-floor rule keys on `type`+`fit`, not the band alone. QUICKSETUP (`ui/src/views/QuickSetup.vue`, read in FULL): `apply()` non-clobber preset-write at `:202‑232` + routing/embedding write at `:237‑249` → cleanly extractable into `modelApply.setDefaultModel`; the rewire targets are `bestFittingId()` `:113‑125` (currently keys on `qualityRank` → becomes rule a), `modelOptions` `:84‑91` (lists ALL non-embed → add the fitting filter), the fixed embed line `:341‑344` (→ becomes the dropdown), `CARD_OPTIONS` `:49‑56` (max 24 GB → add 32/48/64), `isEmbed` `:36` (the `/embed/i` regex → becomes the `embedding` flag), `useCatalogMeta` destructure `:66` (drop `qualityById`, add `embeddingById`). STILL UNREAD (must read before claiming verified): `LuModelCatalog.vue` (the un-hide / badges / Add-form base), `ConfigColumn.vue` in full (only the `LuModelPicker` import `:34` + `patchPin` `:94` were read), the preset stores + `presets_api` end-to-end (current-default computation), and the dispatch cascade (`prompts.py`/`preset_resolve.py`, to confirm it is untouched).

**14 · Agent-vs-user decision audit (2026-07-03 — decisions the AGENT made WITHOUT explicit user sign-off, surfaced for review; the user must confirm or change these before they are treated as final).** AGENT proposals/choices (not explicit user decisions): (1) the exact dense models — Qwen3-8B / 14B / 32B, Llama-3.3-70B (the user approved the ladder SHAPE + research direction, not each model); (2) the exact embed additions — bge-m3, Qwen3-Embedding-8B; (3) WHICH seed models to cut — gemma-4-12b, mistral-24b, gemma-4-31b, llama-4-scout; (4) the new `embedding` DB flag as the identifier; (5) "Set as embedding" as the catalog mechanism; (6) the Embedding badge; (7) the exact auto-pick math ("most capable = biggest by parameter count" + the tiebreaks — the user confirmed only the RULE, not the math); (8) the specific corrected fit numbers (grounded in real GGUF sizes but agent-derived); (9) implementation plumbing (the shared `modelApply` service + the non-clobber preset-write carried from Phase D). The USER EXPLICITLY decided: one-model default; per-task/per-feature override UNCHANGED; auto-pick rule (a); floor MoE = Qwen3.6-35B-A3B; ceiling = GLM-4.5-Air alone; drop the 235B; drop `quality_rank`; catalog visible; the "Set as default" label; no Load/Unload; fit-grouped + search + sort; the QuickSetup embedding dropdown + system default + fitting-only dropdowns; card options past 24 GB; the smart Add flow (list quants, fit per quant, two buttons Get-info/Test-fit, auto-inspect, auto-composed factual description). PROCESS LESSON (recorded so it is not repeated): the agent repeatedly said "verified" after skimming (grepping one line) and folded its own choices in as settled; corrected this session by reading full files with file:line evidence and separating "code confirms (file:line)" from "agent decision — user's call." Two concrete errors caught + fixed this session: the "demote the per-task model" over-reach (the override is UNCHANGED — removed) and the wrong "the Tasks tab has no model picker" claim (it DOES — `LuModelPicker` in `ConfigColumn.vue`).

**15 · 2026-07-04 — REFINEMENT + DECISION-AUDIT RESOLUTION (user review of §14; the auto-pick rule refined; `quality_rank` KEPT).** The user reviewed the §14 agent-decision audit and the auto-pick math turn by turn. RESOLVED this session: §14(1) the dense model picks (Qwen3-8B/14B/32B, Llama-3.3-70B) — APPROVED ("1 is fine"). §14(3) which seeds to cut (gemma-4-12b, mistral-24b, gemma-4-31b, llama-4-scout) — APPROVED ("3 is fine"). §14(4) the `embedding` flag as the identifier — APPROVED ("4 is fine"). §14(7) the auto-pick math — REFINED and APPROVED: the user wanted quality weighted up but "not so slow it is not worth it," so plain option (a) (speed-first, biggest-params) is REPLACED by the **speed-floor rule in §10** ("the most capable model that still streams faster than you read"): keep dense-fully-on-GPU AND usable A3B-MoE-offload as candidates, EXCLUDE the slow dense-partial-offload, rank the survivors by the curated `quality_rank`, and fall back to best-runnable if none clear the floor. §14(9) the `modelApply` plumbing + the carried non-clobber preset-write — APPROVED (the user took the lean: one shared `modelApply` service). The user's KEY CONSEQUENCE, explicitly confirmed: **KEEP `quality_rank`** (the curated capability order the speed-floor rule ranks by) — this REVERSES the earlier "drop quality_rank" recorded across §6/§8/§9; the field already has the right semantics (`model_catalog_api.py:50`), so it is kept, NOT re-added, and re-seeded for the 6-model ladder. §14(8) the corrected fit numbers SPLIT (the user's 2026-07-04 point that item 8 is partly embedding-related): the DENSE fit numbers (Qwen3-8B/14B/32B/70B) are LLM-side and ACCEPTED, grounded in real GGUF sizes via the inspect endpoint + `estimate_vram_mb`; the EMBED fit numbers (nomic / bge-m3 / Qwen3-Embedding-8B) move to the STILL-OPEN embedding pile (they ride the §12 gap). CODE VERIFICATION backing the refinement (read IN FULL 2026-07-04, file:line): `runner/fit.py` (bands `ok|tight|no|cpu|unknown`; MoE offload encoded via the `min_vram` active-path override + a RAM gate at `fit.py:87‑89,101‑103`; a usable MoE and a slow dense both read `tight`, so the rule combines `fit`+`type`), `runner/api.py get_models` (`:34‑49,72‑133` — the picker receives `fit`, `active_params`, but NOT `type`), `runner/schema.py RunnerModelInfo` (`:127‑142` — `type` absent from the runner endpoint → the picker reads `type` from the catalog join `model_catalog_api.py:42`). STILL PENDING the user's decision, all behind the §12 blocker: §14(2) bge-m3 + Qwen3-Embedding-8B, §14(5) the "Set as embedding" mechanism, §14(6) the Embedding badge, and §14(8)'s embed-fit-numbers portion — i.e. the entire embedding half. NEXT: resolve the §12 embedding-serving gap (research authorized by the user 2026-07-04).

> This is a chat-plan design consolidation reached through a long, grounded discussion held
> immediately after the GGUF-grounded model layer (`2026-07-02-gguf-grounded-model-layer.md`,
> Phases 1–6) shipped and the user walked the resulting **Models tab** and found it confusing.
> The decisions below were made by the user turn by turn and confirmed with an explicit "go".
> **The QuickSetup front-door mechanics are now DESIGNED (Phase D below, settled 2026-07-03 via "go").
> Build STARTED on the user's go — **Phase A (delete the grid) is SHIPPED** (runner `91b7194` / JW `e26606c`; verified green: runner ruff + 224 pytest, JW build:vite + headless smoke 0 JS errors; rules-checker pass after its 2 findings were folded — a missed CSS comment + this status reconciliation). Phases B–E pending; each ships on its own verification. The grid descriptions in the body below are HISTORICAL (the grid is now deleted).** Both repos
> were clean and synced with origin when this was written (runner `b7290ff` / JW `f513189`). This
> plan supersedes the Phase-4 decision in the GGUF plan that "the per-hardware recommendation grid
> becomes the single model surface" — the user reconsidered that after using it, which is a
> legitimate, user-initiated revision of a shipped design decision (not an override by the agent).

> **✅ PHASE C SHIPPED (2026-07-03) — C1a `cef3457` + C1b `081501c` + C2 `f315bb0`; live-verified (catalog carries `qualityRank`+`description` on all 11 models; `GET /v1/ai/recommendations` → 404; ruff + 211 pytest; build:vite + headless smoke 0 JS errors). NEXT: Phase D (QuickSetup rewire) + E (docs). The per-sub-phase detail below is the record of what C did.** The recommendations→catalog collapse was split for safety. **C1a (DONE, additive):** `ModelCatalog` gained editable `quality_rank` (LOWER=better; 100=unranked) + `description` columns, wired through `db.py` / `CatalogRow` / `_catalog_to_wire` / `upsert` / the catalog seeder, seeded across all 11 models (35B-A3B=10 the smart default; 27B=12; 235B=5 workstation; 9B=30 fast; nomic-embed=100; llama-scout=40 use-limited). ruff + 224 pytest green; **schema touch → drop+reseed the dev DB**. QuickSetup's use of the quality signal is Phase D. **C1b (REMAINING — delete the recommendations table/store/API/editor; exact sites verified this session):** `db.py` delete `ModelRecommendation` (`:173-183`); `seed.py` delete `DEFAULT_RECOMMENDATIONS` (`:170-197`) + `seed_default_recommendations` (`:572-581`) + its call in `seed_llm` (`:679`); `stores.py` delete `from .recommendations_api import RecommendationRow` (`:27`) + `_rec_to_wire`+`RecommendationStore` (`:286-336`) + the taskKind-delete cleanup `s.query(db.ModelRecommendation)...` (`:761`) + `_recommendation = RecommendationStore()` (`:799`) + `get_recommendation_store` (`:939`); delete `recommendations_api.py`; `install.py` remove the `make_recommendations_router` import + `app.include_router(make_recommendations_router(...))` (`:110`); `__init__.py` remove the recommendations import block (`:49-53`) + `__all__` entries (`:94-96`); `tests/` delete `test_recommendations_catalog.py` + fix `test_shared_storage.py` (drop recommendation-store asserts). QuickSetup already `.catch`es the deleted `/v1/ai/recommendations` (safe until D). **C2 (REMAINING — UI):** delete `ui/src/views/RecommendationsEditor.vue` + its export at `ui/src/index.js:33` (the Phase-B rules-checker flagged the dangling barrel export); `LuModelCatalog.vue` show + edit the `description` (row + Add/Edit form). **Verify C1b+C2:** ruff+pytest, drop+reseed, curl the catalog (quality/description present, `/recommendations` 404), build:vite + headless smoke. **Then D (QuickSetup rewire — re-read `QuickSetup.vue` first) + E (docs + final verify + rules-checker).**

## Why this rethink

The GGUF-grounded model layer shipped a unified **Models tab** whose headline was a per-hardware
recommendation **grid** (`RecommendationGrid.vue`): rows were hardware tiers, columns were the five
functions (chat / prose / extract / analysis + embed), and each cell recommended a model that fits
that tier for that function, with Download / Load / Tune actions. Walking it, the user found a real
cluster of design problems, every one of which was validated against code + the research this
session:

1. **"Manage all models" is not empty on a fresh install.** It lists the full curated
   `model_catalog` (~11 seeded downloadable models) with per-row download/loaded status — so a brand
   new user sees eleven rows they never chose.
2. **The grid is inert.** It recommends a model per hardware-tier × function but never *sets* the
   model on a task; the actual task→model binding is a separate manual step on the Tasks tab. The
   grid's only per-cell actions are `load(modelId)` (download/load into the runner) and `tuning`
   (open the Tune modal) — verified `RecommendationGrid.vue:120‑135`. It is a discover→download→tune
   poster, a dead end with respect to actually wiring a model to anything.
3. **The same model repeats across function columns**, each with its own Download button, so one
   model that wins several functions looks like several separate downloads.
4. **The columns are functions/categories, not the nine real tasks**, so "by job" is misleading and
   "doesn't match the task."
5. **Three overlapping surfaces on one tab** — the grid + "Manage all models" + "Advanced: edit
   recommendations" (`AiModelsArea.vue:244‑256`) — is clutter.
6. **"No user is going to go through all tasks and download a model — it needs to be intuitive."**

The research question the user then asked — *"do we need separate models per task?"* — and the
grounded answer: essentially **no** for a normal user. The per-task picks collapse to about two
roles (a fast model for latency-sensitive chat; one good quality model for everything else), and
every per-tier/per-task model pick is a **reasoned extrapolation, not a measured benchmark** (#28
is the open "measured per-tier benchmarks + per-task recs" item). The thing that genuinely differs
per task is the **settings** (temperature / think / JSON), which the app already applies
automatically per task — not the model. So the elaborate per-hardware × per-function model grid
over-invested in choosing a *model* per task, for a difference we never measured, while the thing
that actually differs per task (settings) was already handled.

## Grounding verified this session (cite file:line — do not re-derive after compaction)

**The dispatch cascade (how a task resolves to a model at run time).** In `prompts.py` the run path
(`/v1/ai/run` + `/v1/ai/stream`) resolves the preset via `_resolve_preset(action, feature,
task_kind_of)` (`prompts.py:384`) → `resolve_task_preset(task_kind)` (`preset_resolve.py:21`), whose
cascade is `tks.get(task_kind) or tks.get("")` (`preset_resolve.py:27`) — i.e. **the task's own
preset, else the global default preset `task_kind_presets[""]`**. The resolved preset's model +
provider are passed down as `model_override` / `provider_override` (`prompts.py:458‑459`) into
`dispatch.chat`, where they **override** whatever the routing chain (`resolve_pin`: action config →
feature config → feature pin → prefer-local → first-adapter) picked (`dispatch.py:178‑183`). The
routing `default` (`RoutingDefaults.llmId/model`, `routing_api.py:27`) is the deeper fallback used
only when NO preset resolves. **Consequence that anchors this whole plan:** "one good model = the
shared default" maps cleanly onto **the global default preset `[""]`.model** — set that one preset's
model and every task with no override inherits it (via `preset_resolve.py:27`) and it beats routing
(via `dispatch.py:178`). No contradiction with the nine tasks; they each still *can* carry their own
preset, they just don't have to.

**Catalog vs recommendations (two different tables — they do NOT duplicate).**
- `model_catalog` (`seed.py:101‑140`; DB model `ModelCatalog`, `db.py:69‑104`; wire `CatalogRow`,
  `model_catalog_api.py:29‑51`) = **the LIST of downloadable models** — id, name, hf_repo, quant,
  total/active params, mtp, type, trained_ctx, min_vram/min_ram, tier, license, use_limited,
  position, built_in, plus a child `model_samplers` table. **There is NO description field.**
- `model_recommendations` (`seed.py:170‑197`) = per-`(model × taskKind)` rows carrying a `rank`
  (lower wins) + a `why` string. Each row **points at** a catalog model by `model_id` (a string,
  no FK) and adds "good for WHICH task + how good + a prose why." It does not re-store the model.
- The **grid** (`RecommendationGrid.vue`; builder `recommendation_grid.py`
  `build_recommendation_grid`; endpoint `GET /v1/ai/recommendation-grid`,
  `recommendation_grid_api.py:72`) is a **read-time VIEW** that joins recommendations × catalog ×
  live `coarse_fit` into the tier × function matrix. Deleting it removes **zero editable data.**
- **Both tables are seed + fully user-editable** (the user's standing principle — see Decisions):
  the catalog has `GET/PUT/DELETE /v1/ai/model-catalog` + `POST /model-catalog/reset` +
  `POST /model-catalog/inspect` (`model_catalog_api.py:128‑176`; inspect reads model facts from the
  actual GGUF file so nothing is hand-typed — Phase 2 of the GGUF plan); recommendations have
  `GET/PUT/DELETE /v1/ai/recommendations` + `POST /recommendations/reset`
  (`recommendations_api.py:64‑86`), edited in `RecommendationsEditor.vue`.

**The 32 GB → "Qwen3.6 27B (MTP)" pick is a DENSE model, and is correct.** `qwen3.6-27b-mtp-q4_k_m`
(`seed.py:115‑117`) has `total_params:"27B"`, `mtp:True`, and **no `type` key** → it defaults to
`type:"dense"` (`seed.py:415`). Every MoE carries an explicit `"type":"moe"` (35B-A3B `:123`, GLM
`:127`, Llama-4 `:131`, 235B `:135`). **MTP = multi-token prediction (a speculative-decoding *speed*
feature), NOT mixture-of-experts.** For the `vram32` tier (`seed.py:233`, 32 GB VRAM / 32 GB RAM)
the chat quality pick is the dense 27B at rank 10 (fits fully, `min_vram 20000` ≤ 32000); the A3B
MoE (rank 12) is the *small-card* floor pick (fits 8 GB via CPU expert offload into RAM). Big card →
dense; small card → MoE-with-offload — the fit story is right. **Two real defects remain, both
presentation not pick:** (a) the "(MTP)" in the user-facing name is internal jargon (violates the
no-jargon UI rule); (b) the *rank* that makes 27B the chat pick over e.g. Gemma-31B is reasoned
panel judgment, **not a measured benchmark** (#28) — a sound default, not a proven winner.

**Embed is a genuinely-built always-on utility, orthogonal to the chat LLM.** `nomic-embed-text`
(`seed.py:137‑139`) is an *embedding* model (~137M, CPU-fine) that turns text into vectors. Verified
built in JustWrite (not aspirational): server `api/rag.py` + `rag_search.py` (+ `test_rag*.py`);
renderer `services/rag/{indexer,chat,characterChat,vectorStore,autoIndex,chunker}.js` +
`embedApi.js` + `IndexBuildModal.vue`. It builds a searchable index of the manuscript that powers
**grounded chat / RAG Q&A** (`chat.grounded`), **in-character chat** (`chat.inVoice` — retrieves
what a character knows), and **semantic search + the auto-rebuilt index**. One obvious pick; it is
NOT a per-task "which model" choice, just a single fixed utility that must be present if RAG /
grounded chat / search is used.

**`coarse_fit` is the valuable kernel.** `runner/fit.py` `coarse_fit` gates VRAM + RAM + MoE-offload
= the "which models actually RUN on your box, best-first" answer a novelist can't compute. It is
already reachable per model: `/v1/llm-runner/models` returns a live per-model Fit, and QuickSetup
re-scores it with a `?vram_mb=` card override (`QuickSetup.vue:110`).

**QuickSetup is currently STALE and unwired to the taskKind/preset model.** It reads
`/v1/llm-runner/hardware` + `/v1/llm-runner/models` (with the card override) + `/v1/ai/recommendations`
+ **`/v1/ai/jobs`** (the DELETED jobs system, backlog #100) and on Apply PUTs `/v1/ai/routing` with
`default.{llmId,model,embeddingId,embeddingModel}` + a `jobs` map + `pins`
(`QuickSetup.vue:110‑112,161,197,208`) — the OLD jobs-based routing, NOT the current
task-owns-the-preset model (Plan A, `2026-07-02-preset-model-a-resets.md`). To become the front
door it must be rewired to write the one fit-best model INTO the per-task presets (see Phase D — the
model does NOT live in routing or in the global default `[""]`, both of which are dead; verified this
session against `seed_presets.py`). This is exactly why the user said "we have quick setup that we have
not linked yet."

## Decisions

### Decided (locked by the user)

1. **Delete the recommendation grid** — the 9-tier × function matrix VIEW: `RecommendationGrid.vue`
   + `GET /v1/ai/recommendation-grid` + `recommendation_grid.py` + `recommendation_grid_api.py`. It
   is a read-only view, so deleting it removes no editable data; the recommendations + catalog it
   read from are untouched.
2. **Default model setup = 1 LLM + 1 embed.** The optional "fast chat" second LLM is deferred — the
   user will test whether a snappier chat model is actually wanted before we add one. (When it is
   wanted, the mechanism already exists: point the `chat.grounded` / `chat.inVoice` tasks at a fast
   model via their own preset on the Tasks tab — the per-task override, `preset_resolve.py:27` — so
   no "fast chat" recommendation role is needed.)
3. **The model list (catalog, "Manage all models") moves back under Providers → Built-in**, next to
   the Install-engine panel. Consequence (accepted): with the grid deleted, the catalog moved, and
   the recommendations editor folded, the separate top-level **"Models" tab dissolves**.
4. **Keep the seed.** Seeded defaults are fine (see the principle below).
5. **Standing principle (applies to this whole redesign):** seed defaults are fine; **everything the
   app ships must be user-editable**; "hardcoded" = frozen / not user-editable — *that* is the thing
   to avoid. This is already how the catalog, recommendations, pricing, switches, and presets are
   built (seed → DB → CRUD editor).
6. **QuickSetup is in scope** as the intuitive front door — but its mechanics are still to be
   discussed before any code.

### Unchanged (settled earlier this rethink, not re-opened)

- The **nine LLM-work tasks** (`DEFAULT_TASK_KINDS`, `seed.py:207‑217`) and their **per-task
  settings** (temperature / think / json_mode) stay — they are real and already applied
  automatically at dispatch (`prompts.py` `_effective_spec`).
- The **Tasks tab** stays exactly as-is as the per-task override surface (a power/advanced surface;
  "advanced" never meant hiding it).
- **"One good model that fits your hardware = the shared default"** — realised (per Phase D, verified
  this session) NOT via the global default preset `task_kind_presets[""]` (which is never reached: the JW
  seed assigns every one of the 9 tasks an explicit preset, so the cascade always hits the task's own
  preset and `[""]` is dead). The model lives IN the per-task presets; "one good model" means QuickSetup
  writes the one fit-best model onto every task preset (option A), keeping each preset's per-task settings.

### Recommendations accepted via "go" (reversible before build)

7. **Collapse recommendations to one editable quality number per model** (drop the per-`(model ×
   task)` × per-tier matrix). Chosen because it ships *less unmeasured guessing* — Fit is computed,
   overall quality was researched, but the per-task model split was never measured (#28). The picking
   rule becomes one line, computed live: **the highest-quality model that fits your box** (filter the
   catalog by `coarse_fit` = ok/tight/cpu, pick the top of the quality order). Keeping the per-task
   table would have been equally valid under the editability principle (#5) — it is the user's call,
   greenlit as collapse; still reversible before build. *(The user leaned collapse originally, the
   "not-hardcoded" correction re-opened it, and "go" on the summarizing ledger accepted the collapse
   recommendation. Flag to re-confirm if the intent was keep-per-task.)*
8. **Add an editable `description` field to each catalog model**, distilled from the
   *model-describing* half of the recommendation `why` text (task-independent: what the model is, its
   quality/speed character, how it runs) — NOT the per-task/fit framing (Fit is computed; the task
   half is going away). Result: each model carries facts (file-derived) + license + a quality number
   + a plain-language description = a self-describing list, and the description is where the
   "(MTP) / Q4_K_M" jargon becomes human terms ("runs fully on your GPU" vs "uses your GPU + system
   RAM"). The user proposed this; the agent recommends it. Good either way on #7 (cleanest with
   collapse — the description lives once, on the model, no overlap with a per-task `why`).
9. **Model-list freshness:** the seed is the offline fallback now; *if* "fresh without app updates"
   matters (it likely will), consider a **remote curated manifest** the app fetches (list + quality),
   with the seed as the offline fallback, later. Not urgent, and a real product/infra decision to
   make on its own; measurement (the Tune & measure path shipped in Phase 5 of the GGUF plan)
   eventually replaces the guessed quality rank with real tokens/sec + quality per model (#28).

## The plan (Phase D now designed; build on the user's explicit go)

Scope is the shared `just-llm-runner` (runner + `ui` kit) consumed by JustWrite; **JustVoice is OUT**
(JV inherits the shared kit; it mounts the runner router directly and never calls `install_llm`, so
it never mounted the grid router). Build/verify JW only. No PR unless asked.

### Phase A — delete the grid (runner + kit)
Remove `RecommendationGrid.vue`; drop its mount + the "Models" section wiring in `AiModelsArea.vue`;
remove `recommendation_grid.py` + `recommendation_grid_api.py` + the `make_recommendation_grid_router`
wiring in `install.py`; drop the grid's tests (`test_recommendation_grid*` / the grid assertions).
Confirm no other consumer of `/v1/ai/recommendation-grid` before deleting (grep). `DEFAULT_HARDWARE_TIERS`
+ `function_of` may retire with the grid unless the collapse (Phase C) or QuickSetup (Phase D) still
needs the function map — decide during build, do not leave orphans.

### Phase B — model list (catalog) under Providers → Built-in (kit)
Move `<LuModelCatalog>` out of the Models tab into `ProviderForm.vue` under the `isBuiltin` gate,
next to `<LuRunnerEngine>` (Install engine). Reframe it **installed-first**: a "Your models" view
(what is downloaded — empty to start) plus an explicit "Add or browse models" affordance that reveals
the full seeded catalog + "Add your own GGUF." Keep every power action (load / unload / delete / reset
/ edit / tune / add-from-link). Remove the now-empty "Models" subnav tab from `AiModelsArea.vue`.

### Phase C — collapse recommendations → a quality signal + a model description (runner + kit)
Add an editable **quality rank** and an editable **description** to the model (per the decisions).
Sub-choice to settle at build (both editable, both pass the principle): (A) a `quality_rank` +
`description` **column on `model_catalog`** (the catalog *is* the ranked, self-describing list; the
separate recommendations table + `RecommendationsEditor` + `recommendations_api` retire), vs (B) keep
a slim one-row-per-model `model_recommendations`. Agent lean: (A). Seed the quality order + the
distilled descriptions from the current `why` text. Drop "(MTP)" jargon from surfaced names in favour
of plain-language behaviour ("runs fully on your GPU" / "uses GPU + system RAM"). If (A): remove the
`model_recommendations` table/editor/endpoints; update `seed.py`, `db.py`, `model_catalog_api.py`,
`LuModelCatalog.vue`, and any reader (QuickSetup — Phase D). Schema touch → drop-and-reseed the dev DB
(pre-production, free).

### Phase D — QuickSetup front door (DESIGNED 2026-07-03; build on the user's go)
**Grounding correction (verified this session):** the model does NOT resolve from routing or from the
global default preset `[""]`. The JW seed (`seed_presets.py`) defines 8 engine presets, each bundling a
model + settings, and assigns every one of the 9 tasks to one of them (`DEFAULT_TASKKIND_PRESETS:75‑85`);
no `[""]` default is seeded, so `[""]` is never reached. The seed today even runs a **2‑model split** —
`qwen3.6-35b-a3b-mtp` for the quality tasks, but the fast `qwen3.5-9b` for ideation / prose-edit / digest
(`:47,50,69`). So "one good model = the default" is a real change and must be written INTO the per-task
presets, not into `[""]`.

**Decided approach — option A (model → all presets), reversible toward D:**
- QuickSetup picks the one **fit-best** model (`coarse_fit` + the Phase-C quality signal, editable) and, on
  Apply, writes that model onto **every task preset** via `PUT /v1/ai/engine-presets/{id}` — keeping each
  preset's per-task settings (top_p / json_mode / samplers; temperature stays per-action). One model
  everywhere, per-task settings preserved. It also sets the **embedding** via the live
  `routing.default.embedding*` (that half of the old routing write is genuinely used) and **downloads +
  loads** the chosen model (keep the existing detect / card-override re-score / progress-poll machinery).
- **Drop entirely:** the `/v1/ai/jobs` load + the per-job role rows + the `jobs` map and `routing.default.model`
  write (all dead). The confirm step becomes "here's the one model that best fits your box" (editable) + embed.
- **The fast 9B is NOT auto-downloaded** (the runner loads one model at a time) — it stays a per-task opt-in via the catalog's Browse + the Tasks tab. (**UPDATE 2026-07-04: a download-only endpoint now EXISTS** — `POST /v1/llm-runner/download` on its own state channel + the catalog's separate **Download** / **Load** buttons + a "Download anyway" override for too-large models; auto-pre-downloading a second model during QuickSetup remains deferred, but is now unblocked by that endpoint.) *(Corrected 2026-07-03: an earlier draft here said "also download the 9B during setup" — the shipped code downloads+loads the PICK only, matching the grounding note below.)*
- **Non-clobber on re-run:** QuickSetup must only overwrite presets still pointing at the *previous* default
  model — never a per-task model the user has changed — so testing the 9B on a task survives a re-run.
- **Align the seed to one model:** drop the seed's arbitrary 9B split (ideation/edit/digest) so the pre- and
  post-QuickSetup baseline agree; the 9B becomes a tested per-task opt-in, not a hidden default.

**The "9B vs one model" option (user: "i want option for 9b and 1 model, i have no idea if 9b will work"):**
served by EXISTING mechanisms, no new architecture — one good model is the default; the 9B is installed and
one swap away on the **Tasks tab** (the per-task preset override, which stays), with **Tune & measure** (the
Phase-5 Lab) to compare the 9B vs the good model on a real prompt (quality + tokens/sec) and keep or revert
per task. This IS decision #2's "we will test."

**Noted options (NOT this build):** (D) evolve to "model lives once" — a global default preset holds the
model, per-task presets carry only settings and inherit it (resolution: task-preset model → default-preset
model → routing); cleaner "one knob," but needs a resolution change + seed rework + a Tasks-tab "inherits
default" tweak. (Toggle) an optional QuickSetup "also use the fast 9B for quick tasks" one-click split —
agent lean is to NOT add it (keep the front door to one model; the Tasks tab is the split), but it is cheap.

This also resolves backlog #100 (QuickSetup `/v1/ai/jobs` → taskKind/preset).

**⏳ PHASE D GROUNDING (QuickSetup.vue re-read 2026-07-03, before build — the exact rewire; NOT yet started, tree clean at C-fix-up `84727c2`):** Current QuickSetup: `loadAll` (`:102-125`) fetches `/v1/llm-runner/hardware` + `/v1/llm-runner/models{?vram_mb}` + `/v1/ai/recommendations` (now 404, `.catch`'d) + `/v1/ai/jobs` (404, `.catch`'d); `roleRows` (`:34-43`) = a Default row + one per job (jobs=[] → just Default now); `prefillRoles` (`:130-147`) picks by recommendation-rank then a largest/smallest heuristic; `whyFor` (`:149-157`) reads recommendations; `apply` (`:190-236`) GETs `/v1/ai/routing`, builds `pins` + a `jobMap`, PUTs `/v1/ai/routing` `{default:{llmId,model,embeddingId,embeddingModel}, jobs, pins}`, then loads the default (`/v1/llm-runner/load` + `pollLoad` `:238-254`). **VERIFIED: `/v1/llm-runner/models` does NOT carry `qualityRank`/`description`** (grep of `llm_runner/runner/` = none — those are `CatalogRow` fields only). **The rewire:** (1) `loadAll` — DROP the `/recommendations` + `/jobs` fetches; ADD `/v1/ai/model-catalog` (JOIN by id for `qualityRank`, exactly like LuModelCatalog's `catalogRows`) + `/v1/ai/engine-presets` + `/v1/ai/preset-assignments`. (2) The pick — the fitting (`coarse_fit` ok/tight/cpu) model with the LOWEST `qualityRank`, EXCLUDING embed (`/embed/i` on id/name) + `useLimited` models = the one good LLM; + the embed (nomic, `/embed/i`). Replaces `prefillRoles`/`whyFor`/`roleRows` → one editable "Default model" row + a fixed embed line (drop per-job rows). (3) `apply` — for each task preset (the presets referenced by `preset-assignments.taskKinds` values + `defaultPresetId`) whose `.model` == the current DOMINANT model (the mode across those presets = the old default), `PUT /v1/ai/engine-presets/{id}` with `.model`=the pick, preserving its other fields → NON-clobbering (a user-overridden task's preset has a different model → skipped); set embedding via `PUT /v1/ai/routing` `default.embeddingId/embeddingModel` (KEEP `pins`; DROP the `jobs` map + `default.model`); download+load the pick. (4) Confirm-step template — drop the `roleRows` loop; show detected hw + ONE editable Default-model pick + a fixed embed line. **Seed alignment (JW `seed_presets.py`):** change `p_ideation`/`p_prose_edit`/`p_digest` from `qwen3.5-9b-q4_k_m` → `qwen3.6-35b-a3b-mtp` so the seed default is ONE model (the 9B split is the arbitrary thing decision #2 dropped; the 9B is now a per-task opt-in via the Tasks tab / catalog Browse). **Download-both caveat:** the runner loads ONE model at a time → QuickSetup downloads+loads the PICK only; auto-pre-downloading the 9B during setup stays deferred (a nice-to-have). *(UPDATE 2026-07-04: a download-only endpoint now EXISTS — `POST /v1/llm-runner/download` on its own state channel — so the 9B is reachable via the catalog's separate **Download** button, no longer only via a load.)* **Phase C rules-checker: PASS** after the fix-up `84727c2` (folded its T5 stale-comment + the user-facing-false TaskKinds delete-dialog copy + a new `test_model_catalog_quality_and_description_roundtrip`).

### Phase E — verify + docs
Runner `ruff` + `pytest`; JW `build:vite` + headless smoke (0 JS errors) over every route + the AI
sub-tabs + Providers (catalog now under Built-in) + reseed; live curl; a post-task rules-checker before
each commit (doc-only commits exempt). Update this plan's LIVE STATUS, `MORNING_RECAP.md`, and the
GGUF plan's cross-reference. Commit per-repo on `claude/admiring-galileo-il3q0o`, push `-u`.

## Open items
- **#7 storage sub-choice** — quality + description as catalog columns (agent lean, option A) vs a
  slim recommendations table (option B). Settle at Phase C.
- **#9 freshness** — seed-only now; remote curated manifest is a later product decision.
- **Phase D → option D** — evolve to "model lives once + per-task presets inherit" (noted in Phase D);
  a future refactor, not this build.
- **Phase D → toggle** — optional QuickSetup "also use the fast 9B for quick tasks"; agent lean = skip.
- **Re-confirm #7** — collapse vs keep-per-task, if "go" was meant only as "save the ledger."

## Out of scope
- JustVoice (inherits the shared kit; no JV build/verify in this plan).
- Measured per-tier benchmarks (#28) — the quality rank stays reasoned until measured.
- The optional "fast chat" second LLM — deferred to the user's own testing (decision #2).
