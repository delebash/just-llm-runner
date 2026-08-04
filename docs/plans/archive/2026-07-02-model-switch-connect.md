# Plan — Connect model → engine switches + simplify the model/tune surface (JustWrite AI)

> ✅ **CLOSED (docs campaign 2026-08-04)** — all phases shipped; the "LIVE STATUS" header below is historical. History/evidence only; live work: `docs/dev/TASKS.md`.

> Scope: shared kit `just-llm-runner/ui` + runner, consumed by JustWrite. **JustVoice is out** (user directive). Branch `claude/admiring-galileo-il3q0o`. No PR unless asked.
>
> **Validated by a 3-checker rules panel (architecture-fit · reuse/convergence · grounding).** All three confirmed the macro shape ("connect, don't collapse") is correct and the grounding claims verify (T2 all-true). Their FAILs — the preset-clobber guard (T1), shared-helper extraction (T3), the switch-presets-editor gap (T5), the backend copy-sweep (T6), and docs (T11) — are folded below and marked 【panel】.

## ⛔ LIVE STATUS — where this stands (kept current)
Branch `claude/admiring-galileo-il3q0o`; verified per phase (build:vite · headless-smoke 0 JS errors · Playwright probe · rules-checker). JustWrite-only.
- **Phase 0 — copy sweep + dead-code: SHIPPED** (`b0a9f09`). Stale "job/Profile/D9/RoutingByJob" copy re-termed across UI + backend docstrings; orphaned `LuSwitchPresets.vue` deleted (the `/v1/ai/switch-presets` router + `switch_presets` table KEPT as API/reset surface — Decision 4); "(advanced)" dropped from the Engine-binaries panel. rules-checker PASS (T6 sweep re-verified).
- **Phase 1 — connect model → switches: SHIPPED** (`2b0543f`). New shared `ui/src/switchResolve.js`; `ConfigColumn` seeds the switch KnobGrid from the model's resolved baseline on the model-STRING change, guarded by a `switchesSource` tag (`'model'|'preset'|'user'`) + async token + post-await re-checks (no preset/user clobber, no loop); `CompareStrip.presetToConfig` tags `'preset'`; `LuModelCatalog.fetchResolved` delegates to the helper. Probe: dense=6 / MoE=8 switches, differ, seedReqCount=2. rules-checker PASS (T1 guard + T3 single source).
- **Phase 2 — Tune & measure: kept, relabelled.** No separate code — it now shares `switchResolve.js` (Phase 1) and its "Routing by job/Profile" copy was fixed in Phase 0.
- **Phase 3 — trim the model Edit form + surface mtp: SHIPPED** (`22827f7`). `LuModelCatalog` Edit form restructured — download-source note (repo+quant = the one thing you must set), fit-estimate note (pre-download guess; the GGUF sets the real fit), `type` relabeled "auto-detected at download" + demoted into a "Capability flags" Advanced disclosure, new `mtp` `UiCheckbox` (rides the existing catalog PUT — `mtp` round-trips: `stores.py:345,372`). Probe + a live PUT round-trip green.
- **Phase 4 — final docs + verify: SHIPPED** (JW `f76cb9c`). Plan persisted (+ this LIVE STATUS marking all phases done); the historical `justwrite-app/docs/plans/archive/2026-06-27-switch-and-preset-architecture.md` bannered with the 2026-07-02 evolution; the runner `ai-state-grid.md:42` stale row fixed (Phase 1); the JW `MORNING_RECAP.md` current-state entry added. Final verify all green: runner ruff + **202 pytest** · `build:vite` · `headless-smoke` **0 JS errors**. **✅ FEATURE COMPLETE — Phases 0–4 shipped + pushed** (runner `b0a9f09`→`2b0543f`→`22827f7`; JW `f76cb9c`).
- **Decision 4 (open):** after deleting the orphaned editor, the `switch_presets` baseline is seed/reset/API-only by design; the full `/v1/ai/switch-presets` router removal is a shared-shapes/test cascade — deferred + flagged, kept as API surface. QuickSetup `/v1/ai/jobs` copy = the separate deferred #100.

## Context (why this change)
Walking the Providers → AI surface, the user hit a real architectural disconnect and a pile of stale/dead bits. Grounded findings (cited, panel-verified):

- **Picking a model in the Lab does nothing to the switches.** `FeatureLab.vue:36,102` starts `switchRows=[]` and on action-change loads only *samplers*, never switches. The Lab's switch checklist is the generic `knob_catalog` (`ConfigColumn.vue:52-57`), model-independent.
- **Tune & measure** (Providers → **Tune**, `LuModelCatalog.vue:452`) DOES pre-fill from the model's resolved switches (`fetchResolved` → `GET /v1/ai/model-catalog/switches`, `:191-194`) → but is **measure-only** (no save; `runMeasure` `:238-262`) and its note points at the **deleted** "Routing by job / Profile" (`:463-466`).
- Switch config lives in **three distinct LAYERS** (not duplicated truth — 【panel: keeping all three is right】): **`knob_catalog`** = knob vocabulary/labels; **`switch_presets`** = the **file-grounded per-type baseline** (`type` set from the GGUF `expert_count` at **download** — `identity.py:19-33`, wired `install.py:151-157`, called `lifecycle.py:437`; consumed at load by `resolve_model_switches`, `switch_resolve.py:31-59`, which reads the `switch_presets` **table** directly); **`engine_presets`** = the saved per-task config used in production. The only real defect is that the **Lab never consumes the baseline** — the disconnect.
- Hand-editing a model's `type` is near-pointless: for a downloaded model the GGUF overrides it at download; `mtp` is NOT GGUF-inferrable (`identity.py:8-10`) and is currently unreachable in the Edit form (`TYPES` = dense/moe only, `:270`).
- Dead/stale: **`LuSwitchPresets.vue` orphaned** (zero code importers — its old mount `RoutingByJob.vue` no longer exists); stale "Routing by job / Profile" copy in **both UI and backend** (see Phase 0); the "(advanced)" label on the Engine-binaries panel (already edited this session, staged uncommitted).

**Outcome:** one visible flow — *pick a model → see + tune its file-grounded baseline switches → Save as the preset a Task uses* — surfaces consistent + honestly labelled, the Edit form leaning on the GGUF, and the dead/stale bits gone. **Connect** `switch_presets` into the Lab (do not tear it down): the panel confirmed the three layers are genuinely distinct, so the merit is the **layer distinction**, not merely "lower risk".

## Phase 0 — Copy + dead-code cleanup (low risk)
- **Drop "(advanced)"** from the Engine-binaries panel — `LuRunnerBinaries.vue` title + two comments (ALREADY edited; staged — commits here).
- **Stale "job / Profile" strict-diff sweep — UI *and* backend** 【panel T6】. Per unit:
  - UI: `LuModelCatalog.vue:463-466` (visible Tune note → *"Measuring only. To keep a config, tune it in the **Lab** and **Save it as a preset** for a **Task**."*), comments `:182,416,419-420,451`; `ConfigColumn.vue:19`.
  - Backend docstrings/comments still asserting the deleted model: `model_catalog_api.py:15` ("switches belong to the Profile/job… not per-model" — contradicts `switch_resolve.py:15`), vestigial profile-switch docstrings `lifecycle.py:51-52,398-402` + `schema.py:164-165`. Fix the copy (no logic change — the `profile_switches_fn` path isn't wired by JW).
- **Delete `LuSwitchPresets.vue`** (orphan). This also makes the **`/v1/ai/switch-presets` router UI-dead** (LuSwitchPresets was its only consumer; `resolve_model_switches` reads the *table*, not the endpoint) 【panel T5/A】 → see Decision 4 for its fate. KEEP the `switch_presets` **table** (load-bearing).

## Phase 1 — Connect model → switches in the Lab (the core fix)
- **Extract a shared resolver helper** 【panel T3】: new `ui/src/switchResolve.js` (or a composable) owning `fetchResolvedSwitches(modelId) → [{name,value}]` (the `GET /v1/ai/model-catalog/switches?modelId=` + `{flagName,flagValue}→{name,value}` map). Refactor `LuModelCatalog.fetchResolved` (`:191-194`) to call it, and `ConfigColumn` imports the SAME helper — one source, no copied endpoint string.
- **`ConfigColumn.vue`**: on the column's model (`modelValue.pin.model`) being set/changed, seed the Plane-1 switch KnobGrid via `patch('switches', …)` (same write path as an existing KnobGrid edit, `:350-353`; each column is independently deep-cloned, `CompareStrip.vue:37-42`, so N models seed independently).
  - **Provenance guard — on the CONFIG object, not a child flag** 【panel T1, critical】: add `switchesSource` to the column config (`'model'` | `'preset'` | `'user'`). The **parent** preset-apply (`CompareStrip.applyPresetTo → presetToConfig`, `:95-113`) sets `switchesSource:'preset'` **in the same patch as the model**; a KnobGrid edit sets `'user'`. The seed runs **only** when `switchesSource ∈ {unset,'model'}` — so a preset-driven model change (which arrives already tagged `'preset'`) never re-seeds, and the on-mount production-preset apply (`ConfigColumn.vue:301-306`) wins. Pin the mount ordering: the seed watch is non-immediate / guarded so it can't fire before the onMounted preset apply.
- **`FeatureLab.vue`**: the switch-seed origin is now the column's model (above); `columnConfig` (`:109-120`) still passes `switches: switchRows.value` for the no-model path. Result: same resolve source as Tune & measure → the two screens agree; dense vs MoE show different baselines.

## Phase 2 — Tune & measure: keep as a labelled quick benchmark (minimal)
- After Phase 1 both surfaces read the same helper, so Tune & measure stays a per-model **speed check** — keep it (copy fixed in Phase 0; no behavior/endpoint change).

## Phase 3 — Trim the model Edit form to what the file can't tell us
- In `LuModelCatalog.vue` Edit form (`:421-448`):
  - **Lead with the download pointer** — HF repo + Quant + the VRAM/RAM hints (pre-download Fit).
  - **Demote `type`** to a de-emphasized/"Advanced" field labelled *"auto-detected from the model at download"* — keep it **editable** (it's a legit pre-download guess that drives both pre-download Fit, `runner/api.py:34-40`, and the new Phase-1 Lab seed, `switch_resolve.py:37`, before the GGUF corrects it at download).
  - **Surface `mtp`** as a kit **`UiCheckbox`** 【panel T12】 (matching `:439`) in the Advanced disclosure — it affects switches, isn't GGUF-inferrable, and is currently unreachable. Rides the existing `PUT /v1/ai/model-catalog` (`blankModel`/row already carry `mtp`).
  - Keep **Add model** (bring-your-own GGUF) primary.

## Phase 4 — Docs (ship in the same change) 【panel T11, unanimous】
- Update the switch/preset **architecture doc** `justwrite-app/docs/plans/archive/2026-06-27-switch-and-preset-architecture.md` (referenced by `identity.py:5`) + the stale row in `just-llm-runner/docs/plans/archive/2026-06-28-ai-state-grid.md:42` ("LuSwitchPresets.vue editor (moved to Routing-by-job)") + any MASTER-PLAN ref: LuSwitchPresets deleted, the Lab now seeds switches from the model, `switch_presets` is baseline-only (see Decision 4).
- **Persist THIS plan** to `just-llm-runner/docs/plans/2026-07-02-model-switch-connect.md` (project rule) + refresh the active-plan map in `just-llm-runner/MORNING_RECAP.md` and note it in `justwrite-app/MORNING_RECAP.md`.

## Files (representative touch-list — reuse first)
- New: `ui/src/switchResolve.js` (shared fetch+map). Edit: `ui/src/components/ConfigColumn.vue` (seed + `switchesSource` guard), `FeatureLab.vue` (`:36,102,109-120`), `LuModelCatalog.vue` (Tune copy `:463-466`, `fetchResolved` → helper `:191-194`, Edit-form trim + `mtp` `:270,421-448`), `LuRunnerBinaries.vue` (staged). Delete: `ui/src/components/LuSwitchPresets.vue` (+ Decision 4 on the endpoint). Backend copy: `model_catalog_api.py:15`, `lifecycle.py:51-52,398-402`, `schema.py:164-165`.
- **Reuse, don't re-create:** `resolve_model_switches` (`switch_resolve.py:31`), `GET /v1/ai/model-catalog/switches` (`model_catalog_api.py:120`), the new shared helper, `KnobGrid`, `identity.detect_and_store_model_type` (`install.py:151`). No backend *logic* change (P0 backend edits are docstring-only; P3 rides the existing PUT).

## Verification (JustWrite only — no JV)
- `npm run build:vite`; boot server + `dev:vite`; `node scripts/headless-smoke.mjs` = **0 JS errors**.
- Playwright probe: Lab → pick a model → switch KnobGrid pre-fills its resolved switches; switch to a MoE model → set changes; **load a preset whose model differs → the preset's switches are NOT clobbered by the seed** (the T1 guard); Tune & measure same model → same set; Edit a model → `type` reads "auto-detected", `mtp` `UiCheckbox` present; no `LuSwitchPresets`; 0 JS errors.
- Runner `python -m pytest` + `ruff` (P3: `mtp` round-trips the catalog PUT; extract-helper leaves the resolve tests green).
- Per-phase post-task **rules-checker** on each diff; commit per phase on the branch + push. Staged "remove advanced" edits land with Phase 0. Docs (Phase 4) land in the same commit series.

## Decisions (my recommendation — flag any you disagree with)
1. **Connect, don't collapse `switch_presets`** — the panel confirmed the three switch layers are genuinely distinct (vocabulary / file-grounded baseline / saved config), so this is the right **final** shape, not just the cheap one. Keep the table; seed the Lab from it.
2. **Keep Tune & measure** (relabelled) — cheap distinct benchmark, not redundant enough to remove.
3. **`type` stays editable but demoted/auto-labelled** — pre-download Add still needs it; the GGUF corrects it at download.
4. **After deleting `LuSwitchPresets`, make the base/moe/mtp baseline seed/reset/API-only by design** (no bespoke editor) — the Lab now shows+tunes switches per model (per-preset) and `type` is GGUF-derived, so the *global* baseline rarely needs hand-editing. **Also remove the now-UI-dead `/v1/ai/switch-presets` router** unless you want to keep it as raw API/reset surface. *(This is the one genuinely new user call the panel surfaced — say if you'd rather keep a minimal editor.)*

## Out of scope (flag for later)
- Fully collapsing `switch_presets` → `engine_presets` (bigger teardown; not needed). Auto-inferring `mtp` from GGUF (no reliable key — `identity.py:8-10`). Any JustVoice work.
