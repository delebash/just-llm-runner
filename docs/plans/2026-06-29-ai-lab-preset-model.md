# AI Lab + Preset Model — LOCKED design (2026-06-29)

> The agreed redesign of the AI area's routing/tuning model, worked out with the user
> over 2026-06-28/29. **This is the source of truth for the AI config model going
> forward.** It SUPERSEDES the job-centric routing in the master plan (AREA 1/2 and the
> C1/C2/C3/C5 "conflict" resolutions for the lab/switches, and the "Routing by job" engine
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
> **The assignment surface — EXTRACTED to its own page; its PLACEMENT is the one OPEN decision (UNCOMMITTED).**
> The Lab-rework first placed the Default + per-category preset assignment as a matrix at the bottom of the
> Lab. On review the user said that felt wrong — "the assign presets feels wrong to be on every page at the
> bottom… not sure if it should be its own page" — and observed this is "full circle" to how the old jobs
> screen worked: a job used to be an engine/model with one-to-many features assigned to it, and now it is a
> PRESET with categories assigned to it, which is exactly what the user wanted. So the assignment matrix was
> pulled out of `FeatureWorkbench.vue` into a dedicated page, `ui/src/views/AssignPresets.vue` (NEW). That
> page loads `/v1/ai/engine-presets`, `/v1/ai/preset-assignments`, and `/v1/ai/routing` (for the category
> list), and renders a global Default preset dropdown plus one dropdown per category, each persisting via
> PUT `/v1/ai/preset-assignments/default` and `/category` respectively (a single feature can still override
> in Routing-by-feature). The remaining OPEN question is strictly a placement/naming decision for the user
> to make by feel — NOT a design change, and per the standing rule I will not decide it myself — namely
> WHERE this page sits in the AI-area sub-nav. To let the user feel both options, `ui/src/views/AiModelsArea.vue`
> currently mounts `AssignPresets` TWICE, temporarily: variant A reuses the old "Routing by job" tab slot
> (`tab==='jobs'`), renamed in the nav from "Routing by job" to "Routing"; variant B is a brand-new
> "Assignments" tab (`tab==='assignments'`). After the user picks one, the other variant (and any now-unused
> nav entry) is removed. These three files — `AssignPresets.vue` (new), `AiModelsArea.vue` (both variants
> mounted), and `FeatureWorkbench.vue` (assignment matrix removed) — are UNCOMMITTED as of this writing and
> will be committed/pushed so the user can pull the branch and walk through both placements on their machine.
>
> **Known dead code carried in `FeatureWorkbench.vue` (UNCOMMITTED, pending the cleanup commit).** With the
> feature screen slimmed and the promote/job paths removed, the following are now unreferenced by either
> template path and must be removed in the cleanup commit (each verified unreferenced against the template
> this turn, 2026-06-29): the legacy feature-preset `presets` ref together with `actionPresets` and
> `applyPreset`; the promote path `snapshot` + `applyToLive` + `useAsProduction` + `onComparePromote`; the
> old job wiring `setFeatureJob` + `activeModel` + `jobLabel`; the set-all helpers `setGroupAll` +
> `groupCommonPin` + `groupMixed` + `setAllLabel`; and the now-unused imports `LuModelPicker` and
> `LuJobSelect`. The LIVE paths are intact and real (not stubs): feature-mode prompt + preset-picker
> (`featurePreset`/`setFeaturePreset`/`presetOptions`/`savePrompt`/`resetPrompt`), tuning-mode CompareStrip
> with `saveAs`/`delPreset`/`cfgToEnginePreset`, the category-grouped nav, and the `columnConfig` bridge.
> The dead code is harmless (unreferenced) but unprofessional to ship, so it is removed before this work is
> called done — held to the same cleanup commit as the placement decision to avoid two churns of the file.
>
> **Verification of the current uncommitted state:** see the "Verification log" line appended at the very
> end of this status block before the commit (`build:vite` + `node scripts/headless-smoke.mjs`).
>
> **Remaining work, in order:** (1) the user picks the assignment-page placement → remove the losing
> variant and its nav entry; (2) the `FeatureWorkbench.vue` dead-code cleanup listed above, then re-verify
> `build:vite` + headless smoke; (3) Setup (QuickSetup) auto-generating a ready-made preset per task at
> first run and assigning each to its matching category; (4) the download "use it for ‹task›?" offer +
> Retune / Retune-all + the load-time fits/doesn't-fit warning; (5) removing the obsolete standalone
> "Routing by job" engine screen (`RoutingByJob.vue`) and the job switch-editor entirely — task-type
> survives only as the recommendation key, per the locked design above.
>
> **Verification log (this turn, 2026-06-29):** `npm run build:vite` (from `justwrite-app`, which compiles the
> kit via the `@delebash/llm-ui` alias) exits 0 — "✓ built in 3.74s". `node scripts/headless-smoke.mjs` PASSES
> with ZERO JS errors across every hash route AND all 8 AI sub-tabs; the smoke auto-discovered the new nav and
> rendered both placement variants clean — "Routing" (variant A) and "Assignments" (variant B) each at 1607
> chars (identical, confirming both mount the same `AssignPresets` component). The two servers used: JustWrite
> Python server on :17495 and `npm run dev:vite` on :1420.

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
