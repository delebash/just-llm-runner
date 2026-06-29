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
- **Category → preset assignment** — "set all ‹category› features to preset X" (bulk; auto-join). Lives on the feature screen or the lab (TBD in build).
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

> **Status (2026-06-29):**
> - **Phase 1 — DONE + tested + pushed** (178 pytest, ruff). The data model (`engine_presets`
>   + switch/sampler children + `category_presets` + `feature_preset_refs`), the preset API
>   (CRUD + the default/category/feature assignment layers), the resolve cascade (feature
>   override → category → global default), and the **dispatch wiring** — `/v1/ai/run` and
>   `/v1/ai/stream` now build an "effective spec" from the resolved preset (its model + params)
>   and fall back to the legacy routing when no preset is assigned, so nothing breaks during the
>   migration. Commits: `f18e80b` (doc) · `b11f6b5` (data) · `deacca0` (API + resolver) ·
>   `7acb78d` (dispatch).
> - **Phase 2 — CORRECTED course.** A first attempt put preset *creation* in a standalone popup
>   (`EnginePresets.vue`). The user rejected that as wrong, and rightly so: a preset is the
>   OUTPUT of the Lab — you build an engine config, **test it**, then **save** the tested result;
>   a popup you fill in blind makes no sense. That popup has been removed. The Lab itself is being
>   reworked into the preset editor (Save-as-preset from a tested column + the fit-knob row +
>   assign), and the old feature-preset bar / promote-to-job are being taken out of it.
> - **Routing by feature — SLIMMED + shipped + smoke-verified.** It now shows only the feature's
>   **prompt** (system + user) and a **preset picker** (which engine preset it runs — inherit its
>   category, or a specific one). Removed from it: the model picker, the Plane-1 switch grid, the
>   per-call params, the job classification, the bulk set-all model pickers, and the in-line
>   Compare — because in this model the model/switches/params live in the preset (built in the
>   Lab) and a feature is just prompt + which-preset. `FeatureWorkbench.vue` still carries some
>   now-dead helpers (the old job/pin/set-all functions); they get cleaned out in the Lab-rework
>   commit once the tuning surface stops using them.
> - **Remaining:** the Lab rework (Save-as-preset + the fit-knob row + assign + drop the old
>   bar/promote); setup auto-generating presets per task; the download "use it for ‹task›?" offer
>   + Retune-all; removing the old job switch-editor + the Routing-by-job engine screen.

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
