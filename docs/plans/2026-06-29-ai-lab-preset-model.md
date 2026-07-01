# AI Lab + Preset Model — LOCKED design (2026-06-29)

> ## ⛔ PARTIALLY SUPERSEDED (2026-07-01) — read `2026-07-01-taskkind-routing.md` for the live model
> The **Lab + preset ENTITIES** below still stand (a preset = model + frozen switches +
> params; a feature carries a prompt and points at a preset; ready-made default presets).
> What changed on 2026-07-01 (the "taskKind routing" refactor — live tracker:
> `docs/plans/2026-07-01-taskkind-routing.md`) is the **ROUTING KEY** and the symbol names
> this doc still uses as if current. The renames shipped in code; treat every mention below
> of the following as HISTORICAL, mapped to its new name:
> - `CategoryPreset` / table `category_presets` → **`TaskKindPreset`** / `task_kind_presets`
> - `PUT /v1/ai/preset-assignments/category` → **`…/task-kind`** (body `{taskKind, presetId}`)
> - `resolve_feature_preset(feature_key, category)` → **`(feature_key, task_kind)`**
> - `_category_of` (feature→nav-category) → **`_task_kind_of`** (action-keyed → LLM-work taskKind)
> - `AssignmentsResponse.categories` → **`.taskKinds`**; nav `FeatureCatalogEntry.category` → **`.group`**
> - the "legacy job/pin routing" fallback: the **job** leg is DELETED (Phase 1); only pins + default remain.
>
> The cascade is now `feature/action override → the action's **taskKind** preset → global default`
> (routing keys on LLM work, not the nav grouping). The rest of this doc is the original
> 2026-06-29 design record, kept for history.

> The agreed redesign of the AI area's routing/tuning model, worked out with the user
> over 2026-06-28/29. It SUPERSEDED the job-centric routing in the master plan (AREA 1/2 and
> the C1/C2/C3/C5 "conflict" resolutions for the lab/switches, and the "Routing by job" engine
> screen). The master stays authoritative only for the catalog / Fit / license / model
> research (unchanged by this).

## The core idea
**The Lab is the single source of truth.** You build + test a complete engine config there
and save it as a **preset**. A **feature** just carries a prompt and points at a preset.
**Defaults** (ready-made presets) make it work with zero tuning. Nothing is hidden behind
the scenes; everything the app would auto-pick is shown in the Lab and is overridable.

## Entities
- **Preset** = a complete engine config: **model + switches + params**. The one thing that
  runs. Built, tested, and saved in the Lab. **Frozen** (what's stored is what runs) —
  EXCEPT the two hardware-fit knobs:
  - **Switches (frozen choices):** flash-attn, cache-type-k/v, mlock, no-mmap, MoE spec-off, etc.
  - **Fit knobs (`-ngl`, `--n-cpu-moe`): auto-computed at load, always SHOWN in the Lab, and
    user-OVERRIDABLE** (an override is stored in the preset and wins). Matches Ollama
    (`num_gpu=-1` auto, override `num_gpu N`) and LM Studio (`--gpu auto`, override
    `--gpu 0.5/max`; "Force Expert Weights onto CPU" = `--n-cpu-moe`). Auto-fit isn't always
    right, so the override is required.
  - **Params:** temperature, top_p, max tokens, reasoning effort, json mode, long-tail samplers.
- **Feature** = a prompt (system + user) + per-call params; it resolves an engine via the
  cascade below. **No model picker, no switch grid on the feature screen.**
- **Category** = the visible feature grouping (Writing, Analysis, …) already in the nav. **The
  unit you assign a preset to in bulk.** Set a category → preset, and every feature in it
  inherits (and a NEW feature in that category auto-joins). Task-type (chat/prose/extraction/
  analysis) is NOT a routing entity anymore — it survives only as the key the model
  *recommendations* + setup use.
- **Default** = a global default preset, plus the ready-made presets generated at setup.

## The cascade (what a feature actually runs)
**feature's own preset (override) → its CATEGORY's preset → the global DEFAULT preset.**
At call time it all combines into one call: model + switches + prompt + params.

## The Lab (the workbench — the source of truth)
1. Pick a model → **detect** its type + your hardware.
2. **Prefill** switches (type defaults: MoE → spec-off + no-mmap; base → flash-attn, Q8 cache,
   mlock) + **compute** the fit knobs (`-ngl`/`--n-cpu-moe`) for this box.
3. Show **fits / doesn't-fit**.
4. **Override** anything (incl. the fit knobs).
5. **Run / Compare** (1 column = tune one; N columns = race several) on real input → output ·
   words · tok/s · time · cost.
6. **Save as a preset** (the frozen bundle).
- **Retune / Retune-all** — recompute the fit knobs (clear overrides) after a hardware change.

## Setup (QuickSetup) — generates the ready-made presets
Detect hardware → for **each task** (chat/prose/extraction/analysis) take its ranked
recommendations, drop what won't fit, pick the top survivor → download the **distinct** models
(small box → 1–2 cover everything; big box → 3–4 specialized) → build a **preset per task**
(model + auto switches + task params: extraction temp≈0/JSON, prose temp≈0.9) → assign each to
its matching **category**. The user just clicks "set up" — or pastes a cloud key (no download).
Every preset is then visible/editable in the Lab (nothing hidden).

## Downloading a new model
Lands in the catalog **available + fit-checked** (fits/doesn't-fit for this machine). **Nothing
auto-changes** — existing presets keep running. If it's recommended for a task and fits, the app
**offers** it ("Mistral-24B fits and is recommended for extraction — use it there?") → one click
builds the preset + points that category at it. To use it elsewhere: Lab → pick → prefill →
test → save preset → assign. A new model never quietly takes over.

## The screens (after the redesign)
- **Providers & models** — connect engines; download models (fit-tagged); Quick Setup. No switch editing.
- **Routing by feature** — per feature: prompt + params + **which preset** (or "inherit my category"). No model picker, no switch grid.
- **Tuning (the Lab)** — the full preset workbench: build / test / compare / save presets; Retune.
- **Category → preset assignment** — "set all ‹category› features to preset X" (bulk; auto-join). Built as its
  own dedicated page (`ui/src/views/AssignPresets.vue`): a global Default preset + one preset per category. Its
  exact placement in the AI sub-nav is the one open decision — see the LIVE TRACKER below (variant A = a renamed
  "Routing" tab; variant B = a new "Assignments" tab; the user picks by feel, then the loser is removed).
- **Recommendations** — per task-type model picks; drives setup + the download offer.
- **Usage** — the ledger.
- **Removed:** the standalone "Routing by job" engine-routing screen and the job switch-editor.
  The global Default LLM moves to Providers/Setup. "Job/task-type" remains only as the
  recommendation key.

## At load — no hidden behavior
Use the preset's frozen switches + params; **compute the fit knobs** (unless overridden); run
the **fits/doesn't-fit check** and **warn** if the preset no longer fits ("Retune in the Lab").
Nothing else is computed silently.

## Why this shape (the decisions, so we don't re-litigate)
- **One source of truth** = the preset (model + switches + params). The model-type only
  *prefills* switches at creation; it is NOT a live layer that re-resolves at load (we reject
  the current code's base→type→hardware→job live layering). (User, 2026-06-28.)
- **At call time it's one bundle** — but the parts have different SCOPE: the model is shared
  across many features (so it's set once, per category/recommendation), the prompt + params are
  unique per feature. That scope difference is the only reason anything is "split."
- **Fast/Balanced/Best dial dropped** — it was size-based guesswork over only the recommended
  models. Replaced by: recommended-that-fits + a fits/doesn't-fit model list + the Lab.
- **"Job" demoted** — its only unique value was auto-join + being the recommendation key.
  Auto-join now rides on the **category**; recommendations keep a light task-type tag. No
  separate job-routing concept.
- **Per-task models are required** (not one all-rounder): some models are better per task AND
  VRAM decides which model per task. (User, 2026-06-29.)

## Build plan (phased — verify `build:vite` + headless smoke + reseed each)

> **Status (2026-06-29) — LIVE TRACKER. This block is the single source of truth for where the build
> stands. It is kept current on every change, in full prose, never summarized or truncated (user rule:
> the plan is the live task tracker).**
>
> **⚠ WORKING MODE (user, 2026-06-29): the AI-area SCREEN STRUCTURE is being iterated by trial-and-error —
> "locking sorta of, we are trial and error testing different designs until we get it correct." So the
> entities + cascade below are stable/locked, but the exact tabs and where assignment/tuning live are NOT
> frozen; they change build-to-build until the UX feels right. The trial log records each iteration so the
> history isn't lost.**
>
> **Trial iteration log (newest first):**
> - **Trial 4 — walk-through corrections on the one-page build (2026-06-29).** After walking the one-page
>   build on their own machine (Windows / RTX 2070 SUPER 8 GB), the user drove a sequence of UI fixes. They
>   also repeatedly flagged that I kept making changes BEYOND what was asked (removed the category dropdown off
>   a *question*, invented a prompt-persistence "bubble", deleted the wrong helper line) — the hard rule was
>   reaffirmed and is now load-bearing: **ZERO decisions on my own; do EXACTLY what's said and nothing adjacent;
>   a question is a question (answer it, don't act); stop and ask on anything ambiguous.** Sub-changes this trial:
>   - **Global Default row — REMOVED** from the left nav (user: "use your recommendation"). The per-category
>     set-all dropdown was **KEPT** (user: the left nav is otherwise correct — I had wrongly removed it). The
>     duplicate **System + Instruction prompt block** above "Tune presets" was **REMOVED** (the prompt now lives
>     only in the column = the "testing prompt"); the **"Tune presets" helper line was RESTORED**. The tune
>     column width is **flex** (1 col = full width, 2 = split 50/50, 3+ scroll) — `CompareStrip .lu-cmp-col
>     { flex: 1 1 0; min-width: 360px }`, not a hardcoded width. Commits `0b4a6e0`, `1302f88`.
>   - **#2 Remove the per-feature "Engine preset" override dropdown** from the right pane — DONE (`1302f88`).
>   - **#3 "Use in production" — DONE** (`1302f88` + `81d9875`). A button in the column's preset bar sets the
>     feature's preset (`FeaturePresetRef`, via PUT `/v1/ai/preset-assignments/feature`) to the column's
>     currently-selected preset; on open the column preselects + loads the feature's in-production preset
>     (`ConfigColumn` `productionPresetId` prop → `onMounted` sets `selPreset` + emits `apply-preset`); the
>     button is **always visible** (disabled until a preset is loaded; reads "✓ In production" when it is the
>     feature's live one). Wired `ConfigColumn` → `CompareStrip` (`use-production` emit) → `FeatureWorkbench.onUseProduction`.
>   - **#1 Page must not scroll — only nav + content — DONE** (`81d9875` runner + `5877090` JW). The FIRST
>     attempt (`675a035`, `height:100%`) FAILED because a percentage height does not resolve through a flex item,
>     so the page still scrolled (and I only eyeballed the top instead of measuring). The REAL fix is a flex
>     chain (`flex:1; min-height:0` at every level): `AiView` now wraps the area in a flex-fill `.ai-fill`
>     (flex:1, flex column, min-height:0) instead of the scrolling `.scrollarea`; `AiModelsArea .lu-area` is
>     `flex:1` + flex column; the Routing-by-feature `<section>` is `.lu-tab-fill` (flex column, `overflow:hidden`,
>     no own scroll) so FeatureWorkbench fills it; `FeatureWorkbench .lu-fw` is `flex:1`, `.lu-fw-body` is
>     `grid-template-rows: minmax(0,1fr); flex:1; min-height:0`, and `.lu-fw-list` + `.lu-fw-edit` are
>     `overflow-y:auto; min-height:0`. VERIFIED programmatically (not eyeballed): `document` overflow 0,
>     `.ai-fill`/`.lu-area` overflow 0, nav list + editor pane each scroll. **JV note:** this touches the SHARED
>     kit — JustVoice's AI host still uses a scrolling container, so it needs the same flex-fill wrapper as
>     `AiView` (degrades gracefully — scrolls as before — until then). I have the JV repo in scope and CAN verify
>     it; the user said NOT to for now.
>   - **#4 Preset dropdown was full-width — FIX IN PROGRESS** (uncommitted/just-applied at the compaction). Root
>     cause: a `class=` on `<UiSelect>` falls through to its `SelectRoot` wrapper, NOT the visible `SelectTrigger`,
>     so the `max-width:180px` did nothing. The cap is the UiSelect **`width` prop** (→ `ui-w-{token}` on the
>     trigger; tokens in `ui/src/common/styles.css`: token 110 / id 180 / name 280 / url 360 / …). Applied
>     `width="name"` (280px) + moved the "Use in production" button to sit **next to** the dropdown (before the
>     spacer), per the user. **User reviewed (2026-06-29) — dropdown width OK; follow-up tweak:** the
>     `＋ Save as preset` button was flung to the far right by a `cc-spacer`; the spacer was removed so the
>     preset-bar actions group on the left — order is now `Preset · dropdown · Use in production · Save as preset ·
>     🗑 delete` (delete shows only when a saved preset is selected), dead space on the right per the layout
>     grammar. Verified by screenshot.
>   - **#5 Samplers + switches grid rework — DONE (2026-06-29).** The add-a-blank-row sampler/switch editors in
>     `ConfigColumn` are replaced by a **prefilled checklist** built from the seeded `knob_catalog`. Grounded in
>     the SillyTavern survey (`justwrite-app/docs/plans/2026-06-24-sillytavern-survey.md` §"Minimum useful first
>     slice") + the user's "anchor on llama.cpp; online providers we can research later." Implementation, additive:
>     - **The shared `KnobGrid` got an opt-in `checklist` MODE** (new props `checklist`, `catalogList`, `exclude`,
>       `scrollMax`). When `checklist` + `catalogList` are given it renders the prefilled grid; otherwise the
>       EXISTING add-a-row UI is byte-unchanged as the `v-else` branch. Both branches funnel through the SAME
>       `commit`/`patch`/`remove` helpers (no forked logic — T3). The two OTHER live `KnobGrid` consumers —
>       `LuModelCatalog.vue:424` (the per-model switch editor) and `RoutingByJob.vue:348` (dead-but-present) —
>       pass ONLY the legacy object-map `:catalog`, so they are completely untouched; JustVoice (which consumes
>       the kit) is likewise undisturbed. This was the central "additive, opt-in" requirement and it held.
>     - **Each managed row** = an enable/disable checkbox (presence in the v-model `[{name,value}]` array) + a
>       kind-aware value control: enum → `UiSelect`; int/float → `UiInput type=number`; **bool → the checkbox
>       ALONE** (a llama.cpp presence flag — enabling stores value `"true"`, there is no separate value box, the
>       row shows "on"/"off"); string → text. A per-row **↺ reset-to-default** appears when an enabled value
>       differs from the catalog default. The value control is disabled until the row is enabled, and prefills the
>       catalog default on enable (a knob with no seeded default enables blank → the user types it; an enabled,
>       value-less sampler is dropped on the wire by `_parse_sampler_value("")→None`, no crash).
>     - **Rows are common-first** — the catalog API already returns rows ordered by `(plane, position)`
>       (`stores.list_knob_catalog`), and the seed insertion order IS the intended priority (verified against the
>       survey's "minimum useful first slice": the common samplers before the exotics). VERIFIED in-browser the
>       sampler order is `["top_k","min_p","repeat_penalty","presence_penalty","frequency_penalty","typical_p","dry_multiplier","xtc_probability","mirostat","seed"]`
>       and switches `["ctx_len","flash_attn","cache_type_k","cache_type_v","no_mmap","mlock","no_kv_offload","spec_type","spec_n_max","threads","batch_size","parallel"]`.
>     - **Footer** = `＋ Add custom …` (the future-proof escape — a key not in the catalog) + **Reset to
>       defaults** (restores every listed knob's value to its catalog default; bool + custom rows untouched). A
>       **fixed-height scroll** (`scrollMax`, default 260px) keeps the column compact — the user's "scrollable
>       data grid, a certain height then it scrolls." Layout is **label-then-value adjacent** (a 200px label
>       column, the value next to it) with dead space on the RIGHT — fixing a first cut that flung the value to
>       the far edge (the "fragment orphaned across a spacer" the layout grammar forbids).
>     - **⚠ TWO EXCLUDE LISTS — a judgment call made while the user slept; FLAGGED so it can be reversed in
>       seconds.** The prefilled grid would otherwise list knobs that ALREADY have a dedicated control elsewhere,
>       which would let two controls write the SAME knob to two different stores (a real double-edit bug, both
>       paths confirmed in code). So: the **samplers** grid excludes `temperature` + `top_p` — they live in the
>       per-call params row (`ConfigColumn` Temp / Top-p) and are sent as top-level `temperature`/`topP` by
>       `buildBody`; the **switches** grid excludes `n_cpu_moe` — it is a hardware-FIT knob stored as
>       `nCpuMoeOverride` and edited in the Hardware-fit row per the locked Entities section above, NOT a frozen
>       switch. **If the user instead wants temperature/top_p/n_cpu_moe shown IN the grid, delete the matching
>       `:exclude="[…]"` array on the `<KnobGrid>` in `ConfigColumn.vue` (and remove the now-duplicate dedicated
>       control).** An excluded knob that is nonetheless already set in a loaded preset does NOT vanish (see next).
>     - **Excluded-but-present + custom keys** both fall into a raw **"Other keys"** sub-section — defined as
>       anything in the v-model whose name is not in the *visible* catalog — rendered as raw name/value rows with
>       a remove ✕, so a hand-added key (old add-row UI) or a future setup-generated key, or an excluded knob that
>       was set anyway, is ALWAYS visible and removable, never silently dropped while still being saved.
>     - **NO backend change.** `knob_catalog` already carries `label`/`kind`/`default`/`help`/`plane`/`options`
>       and is returned ordered, so the checklist needed no new data. The UI now reads the RAW catalog rows — note
>       the wire field is **`default`** (not `defaultValue`/`default_value`, the DB name) — instead of the
>       stripped object-map. `FeatureWorkbench` computes `samplerCatalogList`/`switchCatalogList` (= the raw
>       `knobCatalog` filtered by plane) and threads them through `CompareStrip` → `ConfigColumn`; the old stripped
>       object-map computeds + their props were REPLACED (the checklist needs `kind`+`default`+order that the
>       object-map dropped). This rename is confined to the ConfigColumn catalog chain (3 files already edited for
>       this feature) and touches no external consumer (LuModelCatalog/RoutingByJob build their own object-maps).
>     - **Provider-applicability tagging (local-only grey-out) is still DEFERRED** — user: "online providers … we
>       can research later" (the survey's portability matrix is ready when we do).
>     - **Files:** `ui/src/components/KnobGrid.vue` (the checklist mode + an updated header doc comment),
>       `ui/src/components/ConfigColumn.vue` (both grids → checklist, the two excludes, the `*List` prop rename,
>       the stale `n_cpu_moe` summary-copy fix), `ui/src/components/CompareStrip.vue` (thread the arrays),
>       `ui/src/views/FeatureWorkbench.vue` (the ordered-array computeds). **Verified:** `npm run build:vite`
>       exit 0; `node scripts/headless-smoke.mjs` PASSED with ZERO JS errors across every route + all 5 AI
>       sub-tabs (Routing-by-feature 6650 chars; Providers & models + model-manager 0 errors → LuModelCatalog's
>       legacy grid intact); a dedicated Playwright check confirmed the prefilled rows, the common-first order,
>       BOTH excludes, the "Other keys" fallback, and that toggling a knob enables its value input (all green,
>       0 JS errors); `ruff check` clean + the preset/prompt pytest (17) green (no Python touched).
>     - **Process:** a **2-checker rules panel** (architecture-fit + reuse/scope lenses) was run on the PLAN
>       BEFORE any code; both returned FAIL with actionable findings that were folded in before coding — stay
>       additive on the shared component, read the `default` wire field + the raw rows, never drop an
>       excluded-but-present row, fix the stale `n_cpu_moe` summary copy, and ship the doc update WITH the feature
>       (this entry). The exclude-list call is the one item the panel said to surface to the user — hence the ⚠ above.
> - **Trial 3 — collapse to ONE page (idea 1 + idea 2 DONE).** The user decided the separate
>   assignment tab still felt like too many pages and proposed folding everything into **Routing by feature**:
>   a preset dropdown on each CATEGORY heading that sets all its features, with per-feature overrides, plus a
>   global Default — and (idea 2) making the right pane a 1→N column workbench so Tuning folds in too. **Idea 1
>   is built:** the standalone "Routing by category" tab/section and `AssignPresets.vue` were REMOVED; its
>   assignment moved INTO the Routing-by-feature LEFT list — a global **Default** preset row at the top, then
>   each category heading carries a **set-all** preset dropdown (`setCategoryPreset` just PUTs
>   `/preset-assignments/category` — non-overridden features inherit it live via the cascade; it does NOT
>   silently wipe overrides) plus an explicit **Reset** button that clears that category's per-feature
>   overrides so they all re-inherit (the user's "jw had it right way back" set-all reset). Each feature card
>   shows its **resolved** preset with provenance (`featurePresetLabel`: own override → `· category` → `· default`).
>   The per-feature OVERRIDE picker stays in the right pane for this trial (candidate to move inline onto the
>   cards next). One small BACKEND addition for the reset: `POST /v1/ai/preset-assignments/clear-features`
>   (`FeatureClearRequest{featureKeys}`) bulk-clears the given features' overrides — the client passes the
>   category's feature keys (test `test_clear_features_bulk`, 5 preset tests pass). Otherwise the backend was
>   unchanged — `CategoryPreset` (per-category default, `""`=global default) + `FeaturePresetRef` (override) +
>   the cascade already supported all of this. AI sub-nav is now 6 tabs: Providers & models · Routing by
>   feature · Tuning · Recommendations · Usage · (host app tab). **Confirmed with the user (2026-06-29):**
>   prompt is per-feature; columns are SHARED engine presets; "+ add column" just adds another column (no
>   dialog); Save makes a named shared preset that appears in the dropdowns. **"Use in production" (the old JW
>   lab→test→use button) is DEFERRED** — the user wants to try the Save→dropdown→select flow first and decide
>   later. **Idea 2 — DONE.** The Tuning tab is GONE and its column workbench is folded into the
>   Routing-by-feature right pane: under the feature's prompt + override there is now a **Tune presets** section
>   = this feature's `{{variables}}` test input + `<CompareStrip>` starting with **one** column (was 2-up;
>   `CompareStrip` `onMounted` now adds a single column) seeded from the feature's resolved config; **+ Add
>   column** adds more to compare (no dialog); **Save** a column → a named shared engine preset that appears in
>   the dropdowns above. The `mode` prop + `compareMode` branch were removed from `FeatureWorkbench` (one
>   unified view); the left list is collapsible (`nav-collapsed`) to give the columns full width. "Use in
>   production" stays DEFERRED (user: try Save→dropdown first). AI sub-nav is now **5 tabs**: Providers & models
>   · Routing by feature · Recommendations · Usage · (host app tab). Verified: `build:vite` 0, headless smoke 0
>   JS errors, 5 sub-tabs; 5 preset pytest + ruff clean.
>   **Tweaks after the user's first look (2026-06-29):** removed the descriptive helper line under the "Tune
>   presets" heading (user: "we don't need the extra prompt info above tune presets"); pinned each tune column
>   to a fixed ~400px (`CompareStrip` `.lu-cmp-col`, was `clamp(320,42%,460)`) so a lone column reads as a tidy
>   card instead of stretching across the pane.
>   **Open for the next trials:** (a) the per-feature override picker + column 1 are loosely coupled right now
>   (column 1 seeds from the feature's config, the override dropdown assigns an existing preset) — may want
>   selecting a preset to load it into column 1; (b) "Use in production" (save + assign in one click) if the
>   Save→dropdown flow feels like too many steps; (c) whether the always-on full ConfigColumn under every
>   prompt is too heavy vs. collapsed-until-needed.
> - **Trial 2 — assignment as its own "Routing by category" tab** (commit `addde83`): extracted the assignment
>   matrix to `AssignPresets.vue`, shipped two placement variants, user chose "Routing by category" after Tuning.
>   SUPERSEDED by Trial 3 (folded into Routing-by-feature).
> - **Trial 1 — assignment matrix at the bottom of the Lab** (commit `74f7819`): the first cut; user found the
>   bottom-of-page placement wrong. SUPERSEDED by Trial 2.
>
> **Phase 1 — the backend — DONE, tested, committed, pushed.** The complete data model lives in
> `llm_runner/llm/db.py`: the `engine_presets` table is the preset row (id, name, provider_id, model,
> temperature, top_p, max_tokens, json_mode, reasoning_effort, the two hardware fit-knob overrides
> `ngl_override` and `n_cpu_moe_override`, plus `position` for ordering and `built_in`), with two child
> tables — `engine_preset_switches` (the frozen Plane-1 switch choices for the preset) and
> `engine_preset_samplers` (the long-tail Plane-2 samplers). Assignment is two more tables:
> `category_presets` (category as primary key → preset id, where the empty-string category row is used
> as the global default) and `feature_preset_refs` (feature key → preset id, the per-feature override).
> The preset API is `llm_runner/llm/presets_api.py` (`make_presets_router`): full CRUD on
> `/v1/ai/engine-presets`, and the three assignment layers on `/v1/ai/preset-assignments` (GET the whole
> assignment map; PUT `/default`, PUT `/category`, PUT `/feature`). The stores + the wire mapping live in
> `llm_runner/llm/stores.py` (`EnginePresetStore`, `CategoryPresetStore`, `FeaturePresetRefStore`, the
> `_engine_preset_to_wire` helper, and the global-default accessor pair built on the empty-string
> category row). The cascade resolver is `llm_runner/llm/preset_resolve.py`
> (`resolve_feature_preset(feature_key, category)`): a feature's own override wins, else its category's
> preset, else the global default; it returns the preset row or `None`. The dispatch is wired in
> `llm_runner/llm/prompts.py` — `run_feature` and `stream_feature` resolve the preset (`_resolve_preset`,
> using a `category_of` lookup built in `install.py` from `seed.app_feature_catalog()`) and build an
> "effective spec" via `_effective_spec`, which overlays the preset's model + params over the action's
> own spec using `dataclasses.replace` (a `None` on the preset means "leave the action's value alone");
> the resolved provider/model also override the body. When no preset is assigned anywhere in the cascade,
> the code falls back to the legacy job/pin routing, so nothing breaks during the migration. Verified:
> 178 runner pytest + ruff clean (`tests/test_presets.py`, plus `test_run_uses_resolved_preset` added to
> `tests/test_prompts.py`). Commits on `claude/admiring-galileo-il3q0o`: `f18e80b` (this design doc) ·
> `b11f6b5` (data model) · `deacca0` (API + resolver mount) · `7acb78d` (dispatch wiring) · `5d309be`
> (the first preset-library UI).
>
> **Phase 2 — the UI — the standalone-popup misstep, corrected.** A first UI attempt put preset
> *creation* in a standalone popup component (`EnginePresets.vue`). The user rejected it as wrong, and
> correctly so: a preset is the OUTPUT of the Lab — you build an engine config, TEST it, then SAVE the
> tested result; a blind fill-in popup makes no sense. That component was DELETED and the Lab itself
> became the preset editor. Committed: `ecc9e87` (slim Routing-by-feature + drop the popup) and `74f7819`
> (the Lab is the preset editor).
>
> **Routing-by-feature — slimmed, committed, smoke-verified** (`ecc9e87`). `FeatureWorkbench.vue` in its
> default `mode="feature"` now shows only the feature's prompt (system prompt + instruction template) and
> a single engine-preset picker (a `UiSelect` whose blank option reads "inherit this feature's category",
> wired to PUT `/v1/ai/preset-assignments/feature`), plus a Save-prompt button and a Reset-to-default for
> built-in prompts. Everything that used to live on the feature screen — the model picker, the Plane-1
> switch grid, the per-call params, the per-feature job-classification dropdown, the bulk set-all model
> pickers, and the inline Compare — is gone, because in the locked model the model/switches/params belong
> to the preset (built in the Lab) and a feature is only prompt + which-preset.
>
> **The Lab (Tuning tab) — reworked into the preset editor, committed, smoke-verified** (`74f7819`).
> `FeatureWorkbench.vue` mounted with `mode="tuning"` (a separate "Tuning" sub-tab in `AiModelsArea.vue`)
> is the workbench: a shared Test-input panel (the action's `{{variables}}`) feeds `CompareStrip`, which
> renders N `ConfigColumn`s. Each column is a full engine config — model + Plane-1 switches + the fit-knob
> row (`nglOverride` / `nCpuMoeOverride`, blank = auto-computed) + params — that you Run on the shared
> test input and then Save as an engine preset. `cfgToEnginePreset` in `FeatureWorkbench.vue` maps a column
> to the `/v1/ai/engine-presets` POST body; the prompt is the feature's test input and is NOT part of the
> saved preset. `ConfigColumn.vue` and `CompareStrip.vue` were reworked to speak engine-presets (load an
> existing preset + "Save as preset"); the old "Use as production" / promote-to-job emit path was removed
> from both.
>
> **The assignment surface — EXTRACTED to its own page; placement DECIDED + shipped: "Routing by category", after Tuning.**
> The Lab-rework first placed the Default + per-category preset assignment as a matrix at the bottom of the
> Lab. On review the user said that felt wrong — "the assign presets feels wrong to be on every page at the
> bottom… not sure if it should be its own page" — and observed this is "full circle" to how the old jobs
> screen worked: a job used to be an engine/model with one-to-many features assigned to it, and now it is a
> PRESET with categories assigned to it, which is exactly what the user wanted. So the assignment matrix was
> pulled out of `FeatureWorkbench.vue` into a dedicated page, `ui/src/views/AssignPresets.vue` (NEW). That
> page loads `/v1/ai/engine-presets`, `/v1/ai/preset-assignments`, and `/v1/ai/routing` (for the category
> list), and renders a global Default preset dropdown plus one dropdown per category, each persisting via
> PUT `/v1/ai/preset-assignments/default` and `/category` respectively (a single feature can still override
> in Routing-by-feature). The placement/naming was strictly the user's call (NOT a design change), so the
> two options were first shipped side-by-side for the user to feel — variant A reused the old "Routing by
> job" tab slot renamed "Routing", variant B was a new "Assignments" tab (committed at `7688c71`). **The
> user chose: name it "Routing by category", positioned right after Tuning** (2026-06-29). That decision is
> now applied in `AiModelsArea.vue`: the variant-A "Routing" tab and its section are removed, and the
> surviving tab is `tab==='category'` labelled "Routing by category", sitting after "Tuning". The final AI
> sub-nav is: Providers & models · Routing by feature · Tuning · **Routing by category** · Recommendations ·
> Usage · (the host app tab). Smoke confirms 7 sub-tabs, "Routing by category" rendering clean.
>
> **Dead-code cleanup in `FeatureWorkbench.vue` — DONE + verified (2026-06-29).** With the feature screen
> slimmed and the promote/job paths removed, the following were unreferenced by either template path (each
> verified unreferenced by grep against the whole file before removal) and have now been deleted: the legacy
> feature-preset `presets` ref together with `actionPresets` and `applyPreset`; the promote path `snapshot` +
> `applyToLive` + `useAsProduction` + `onComparePromote`; the old job wiring `setFeatureJob` + `activeModel` +
> `jobLabel` + the `jobs` ref + its `/v1/ai/jobs` fetch in `load()` + the legacy `/v1/ai/feature-presets`
> fetch; the set-all helpers `setGroupAll` + `groupCommonPin` + `groupMixed` + `setAllLabel` + the now-dead
> `setAll` row property in `navRows`; the orphaned `byId` + `providerName` (only `activeModel` used them) and
> the unused `saving` ref; and the unused imports `LuModelPicker`, `LuJobSelect`, and `ConfigColumn` (the
> feature screen no longer renders a ConfigColumn directly — `CompareStrip` owns the columns in tuning mode).
> The stale top-of-file doc comment was rewritten to describe the actual two-mode behavior. The LIVE paths
> are intact and real (not stubs): feature-mode prompt + preset-picker
> (`featurePreset`/`setFeaturePreset`/`presetOptions`/`savePrompt`/`resetPrompt`), tuning-mode `CompareStrip`
> with `saveAs`/`delPreset`/`cfgToEnginePreset`, the category-grouped nav, and the `columnConfig` bridge.
> (`loadSwitches`/`featureJobs`/`featureOf` are kept: they still feed the tuning column's switch v-model;
> with jobs demoted they resolve to empty, which is correct — the user adds switches per column.)
>
> **Verification of the current uncommitted state:** see the "Verification log" line appended at the very
> end of this status block before the commit (`build:vite` + `node scripts/headless-smoke.mjs`).
>
> **Remaining work, in order:**
> - ✅ DONE (2026-06-29) — the user chose the assignment-page placement ("Routing by category", after
>   Tuning); the variant-A "Routing" tab was removed.
> - ✅ DONE (2026-06-29) — the `FeatureWorkbench.vue` dead-code cleanup above, re-verified with `build:vite`
>   + headless smoke (both clean).
> - ⬜ Setup (QuickSetup) auto-generating a ready-made preset per task at first run and assigning each to its
>   matching category.
> - ⬜ The download "use it for ‹task›?" offer + Retune / Retune-all + the load-time fits/doesn't-fit warning.
> - ⬜ Removing the obsolete standalone "Routing by job" engine screen (`RoutingByJob.vue`) and the job
>   switch-editor entirely — task-type survives only as the recommendation key, per the locked design above.
>   (Note: `RoutingByJob.vue` is already unmounted — `AiModelsArea.vue` no longer imports or renders it — so
>   it is dead-but-present; the file deletion + any remaining job-switch-editor UI is the only step left here.)
>
> **Verification log (2026-06-29):**
> 1. Two-variant review state: `npm run build:vite` (from `justwrite-app`, compiling the kit via the
>    `@delebash/llm-ui` alias) exited 0 — "✓ built in 3.74s"; `node scripts/headless-smoke.mjs` PASSED with
>    ZERO JS errors across every hash route AND all 8 AI sub-tabs; the smoke auto-discovered the new nav and
>    rendered both placement variants clean — "Routing" (variant A) and "Assignments" (variant B) each at 1607
>    chars (identical, confirming both mount the same `AssignPresets` component).
> 2. Finalize state (placement decided + dead-code cleanup): `npm run build:vite` exited 0 — "✓ built in
>    3.71s"; `node scripts/headless-smoke.mjs` PASSED with ZERO JS errors; the nav is now 7 sub-tabs with
>    "Routing by category" (1607 chars) after Tuning and the variant-A "Routing" tab gone; Routing-by-feature
>    (6149 chars) and Tuning (7220 chars) still render, confirming the dead-code removal broke nothing.
> Servers used throughout: JustWrite Python server on :17495 and `npm run dev:vite` on :1420.

1. **Data model** — `preset` (model + switches + params + optional fit-knob overrides);
   `category → preset` assignment; `feature → preset` override; the cascade resolver. DB reset
   (schema change, per the drop+reseed policy).
2. **Lab** — `ConfigColumn` becomes the full preset editor (it already has model + switch grid +
   prompt + params + run + cost): add the **fit-knob auto/show/override** row + **Save preset** +
   **Retune**. Compare (`CompareStrip`) stays as N columns.
3. **Routing by feature** — slim to prompt + params + **preset picker** (drop the model picker +
   switch grid).
4. **Category → preset assignment** — "set all ‹category› → preset X" + auto-join new features.
5. **Setup** — generate ready-made presets per task at first run; assign to categories.
6. **Download offer + Retune-all + the load-time fits/doesn't-fit warning.**
7. **Remove** the old job switch-editing UI and the "Routing by job" engine screen; keep
   task-type only for recommendations.

Each phase ships runnable so the user can walk through it and feel it.
