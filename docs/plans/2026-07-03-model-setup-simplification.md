# Plan — Model-setup simplification (delete the grid · one good model + embed · catalog under Providers · collapse recommendations to a quality signal + a model description)

> ⛔ **LIVE STATUS (2026-07-03): BUILD IN PROGRESS — Phases A + B SHIPPED (grid deleted; catalog relocated under Providers → Built-in, installed-first, Models tab dissolved); Phase C in progress; D–E pending.**
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
- **Also download the fast 9B** during setup (small, fits almost any box) so it is on disk and ready to try.
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
