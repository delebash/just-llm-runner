# Plan — User-creatable, testable TASKS (taskKinds): DB-backed, feature-assignable, with a Tasks page

> **⚠ CASCADE SUPERSEDED (2026-07-02 PM).** The user-creatable Tasks feature stands as shipped, but the preset **cascade** noted here ("FeaturePresetRef → TaskKindPreset → default") was changed the same day by **Plan A**: the per-feature `FeaturePresetRef` override tier was removed, so a feature's preset IS its task's preset — **2-tier: task preset → global default**. Current AI-routing model: `docs/plans/2026-07-02-preset-model-a-resets.md`.

## ⛔ LIVE STATUS — where this stands (kept current; single source of truth)
Branch (all repos): `claude/admiring-galileo-il3q0o`.
- **Phase 1 — Backend (tables/stores/seed/api): COMPLETE + VERIFIED + COMMITTED + PUSHED** (rules-checker GO on the diff — all T1–T12 PASS; commits runner `f74625a`+`b221576`, JW `21860eb`+`c0604df`). Shipped: `db.py` two new tables `TaskKind` (`task_kinds`) + `FeatureTaskKind` (`feature_task_kinds`), plain-String soft refs. `stores.py` `TaskKindStore` (list · upsert with slug-id + collision suffix · delete with built-in guard + a 3-table cascade: `task_kind_presets` + `feature_task_kinds` + `model_recommendations`) + `FeatureTaskKindStore` (list · set; "" → re-float) + `_slugify_task` + singletons + getters. `seed.py` shared `DEFAULT_TASK_KINDS` (the 9 defs moved out of `task_kinds_api`) + `seed_default_task_kinds` (merge-by-id) + `seed_default_feature_task_kinds` (from the app map, merge-by-key), wired into `seed_llm`. `install.py` `_task_kind_of` = DB row → in-memory app map → `writerAI.rule.*` prefix → "" (the fallback preserves routing if the DB seed is empty) + the 4-arg `make_task_kinds_router` mount. `task_kinds_api.py` rewritten — `TASK_KINDS` constant removed, `TaskKindRow` gains position+builtIn, CRUD (`POST` · `PUT /{id}` · `DELETE /{id}` = 400-on-builtin) + `PUT /task-kinds/feature` (declared before `/{id}` to avoid the path clash); the served `featureTaskKinds` map is still built via `task_kind_of` over the prompt store (the 3 unseeded `rule.*` keep provenance). `tests/test_task_kinds.py` rewritten for the new signature + DB-backed catalog + CRUD/cascade/built-in-guard/re-float. JW `seed_presets.py` sampler-grounding cross-check recorded (every key is a real catalog key; all 3 principles hold — no value changes). **Verified:** runner `import` gate clean; runner **185 pytest** + ruff; JW **76 pytest** + ruff; a live probe on a fresh reset server — **9 tasks seeded, 37-key map** (34 seeded + 3 prefix `rule.*`), writerAI split intact (continue→prose.generate, tighten→prose.edit), create→`my.probe.task`, reassign wins, built-in delete→400, custom delete → the feature re-floats to prose.generate. **JV untouched** (it mounts none of these routers and never `create_all`s the shared base). Checker follow-ups shipped in `b221576`: the reserved-`feature`-slug guard (`_slugify_task`) + a real DB-store cascade/collision regression test (`test_shared_storage.py`), and the stale recap line marked superseded (`c0604df`). One non-blocking note left (checker #4): `_task_kind_of` loads `feature_task_kinds` per dispatch resolution — correctness-neutral, cache only if it ever matters.
- **Phase 2 — UI (FeatureLab + Tasks page): COMPLETE + VERIFIED (commit pending this turn).** Shipped: the shared master/detail shell CSS promoted to `common/styles.css`; a new shared `FeatureLab.vue` extracted from FeatureWorkbench's right pane (owns draft/vars/samplers/switches/columnConfig/CompareStrip; routing stays in the PARENT — the pin arrives as a prop, a pin change is emitted); a new `TaskKinds.vue` Tasks page (task list + New / rename / delete-custom; members with **+ Add** and **Move to…**; preset dropdown + **Test against** a member → `<FeatureLab>`; a zero-member empty state; a global-default fallback control); `FeatureWorkbench.vue` refactored (dropped the "Presets by task kind" panel + the moved-out Lab internals; added a per-feature **Task** reassign dropdown; mounts `<FeatureLab>`); a **Tasks** sub-tab mounted in `AiModelsArea.vue` after Providers; a Tasks help doc (`justwrite-app/docs/tasks.md` + a `toc.json` entry). **DEFERRED within Phase 2 (follow-ups, honestly flagged):** (a) preset **edit-in-place** — Save-as always creates a new preset; an update-in-place needs a `ConfigColumn` change, and the core create/test/assign works via Save-as-new + assign; (b) a per-task **Reset-to-factory** control — the per-member *Move to…* + the preset dropdown's *— inherit default —* already cover reassignment + preset-reset, and a correct bulk reset needs the factory map. **⚠ A rules-checker on the UI diff returned NO-GO (3 findings); resolved in a follow-up commit:** the dead pin-write path was removed (T2 — see NEW#1 above); preset Save-as/Delete was centralized in `FeatureLab` (emits `presets-changed`) + `.lu-fw` promoted to shared CSS (T3 dedup); Reset-to-factory deferred honestly (T5). **Verified:** `build:vite` clean; `node scripts/headless-smoke.mjs` PASSED with **0 JS errors** over every route + all **6** AI sub-tabs (incl. the new **Tasks** tab, 3005 chars; Routing-by-feature 7492); a Playwright probe drove the full flow — 9 tasks render → select Generate prose → 4 members + FeatureLab mounts → create → 10 + empty state → add feature → member + FeatureLab remounts → delete custom → back to 9. JV renderer imports none of these (grep-verified insulated).
- **Phase 3 — Verify + docs: DONE** — the verification above + the JV guard; the plan LIVE STATUS + `MORNING_RECAP.md` updated in full prose + the `docs/tasks.md` help doc shipped with the feature.
- **Phase 2b — Resets + preset edit-in-place: DONE + VERIFIED (commit pending this turn).** Backend: `seed.reset_routing_to_factory()` (clears task→preset + feature→task + per-feature preset overrides, re-seeds the built-in tasks + the app's factory maps; **custom tasks + custom presets kept**) + `POST /v1/ai/task-kinds/reset` + a `factoryTaskPresets` map on the task-kinds GET (for the per-task ↺); wired in `install.py`. UI: **edit-in-place** — a ConfigColumn "Update" button → CompareStrip → FeatureLab `PUT /engine-presets/{id}` (tune a loaded preset without spawning a copy); **per-feature reset** (↺ by the Task dropdown on Routing-by-feature → clears that feature's preset + task overrides → factory routing); **Tasks-page resets** — a global "↺ Reset all to defaults" by the Default control (confirm-gated → `/task-kinds/reset` → reload) + a per-task ↺ by the preset dropdown (→ its `factoryTaskPresets` value). Verified: runner **189 pytest** + ruff (2 new: factory-map/global-reset router test + `reset_routing_to_factory` DB round-trip); JW 76 pytest + ruff; `build:vite`; headless-smoke 0 JS errors over every route + 6 AI sub-tabs; live curl (factoryTaskPresets = the 9, `reset`→200, `PUT /engine-presets/{id}`→200). The former DEFERRED items (edit-in-place + Reset-to-factory) are now SHIPPED; only the `_task_kind_of` per-dispatch DB read stays a non-blocking perf note.
Design was validated by a 3-reviewer rules-checker panel (all NO-GO on v1 → fixes folded) + a confirmatory re-check = **GO** (all 14 blockers verified against code). Panel fixes marked 【panel】; two Phase-2 clarifications marked 【NEW#1/#2】.

---

## Context
Routing keys on the LLM-work **taskKind**, but review found the design half-built:
1. **A taskKind can't be set up or tested.** Testing only exists per-feature (the Lab needs a feature's prompt); a taskKind has no prompt of its own. The only task-level UI is a bare assignment dropdown.
2. **Nothing is user-editable.** The 9 taskKinds are a hardcoded constant (`task_kinds_api.py TASK_KINDS`) and the feature→taskKind map is an in-memory code map (`seed_presets.py FEATURE_TASK_KINDS` → `seed._APP`, read by `install.py _task_kind_of`). Neither is in the DB, so the user can't create a task or reassign a feature via the UI.
3. The 8 seeded presets' samplers are hand-typed and never validated, so the sampler research never reaches the categories.

**Decision (user, 2026-07-02):** make **Tasks first-class, user-creatable, testable units** — "jobs, done right" on the preset foundation. A **Task** = name/description + an assigned **preset** (model + samplers, tuned + tested in the Lab) + the **features assigned to it** (one feature → one task; reassignable from both sides). DB-backed, seeded with defaults, nothing hardcoded. **NOT** restoring the deleted job code. User-facing word = **"Task"**; internal id stays `taskKind`/`task_kind`.

## The model
- **Task (taskKind)** = DB row (id, label, description), seeded with the 9 **shared** defaults; create / rename / delete (custom) in the UI.
- **feature→task** = DB row (feature_key → task_kind), seeded per-app with the **34** JW defaults; reassignable from the Tasks page's member list AND a per-feature dropdown on Routing-by-feature.
- **task→preset** = the existing `task_kind_presets` table (unchanged; `""` = the global-default row).
- **Cascade (as of this plan; 2026-07-02 Plan A later removed the `FeaturePresetRef` tier → now 2-tier):** `TaskKindPreset` (task's preset) → global default. *(Originally a `FeaturePresetRef` feature override sat on top; Plan A dropped it — see the banner above.)*
- **Test a task** = run its **assigned preset** against one of its member features' real prompts.

## Backend — `just-llm-runner/llm_runner/llm/`
Plain-String refs (no hard FK to `task_kinds`) — preserves the `""` global-default row; store does soft cleanup on delete. No FK children → no flush gotcha.

**`db.py` — two new tables** (after `FeaturePresetRef` @417):
- `TaskKind` (`task_kinds`): `id` PK · `label` · `description` (Text "") · `position` · `built_in`.
- `FeatureTaskKind` (`feature_task_kinds`): `key` PK · `task_kind` (String).

**`stores.py` — two new stores + singletons + getters** (mirror `RecommendationStore` @289, `EnginePresetStore` CRUD, `TaskKindPresetStore.list/set` @613):
- `TaskKindStore`: `list()` (order position,id) · `upsert(row)` (id = slug(label) when empty; slug collision → numeric suffix, never clobber) · `delete(id)` (blocked for `built_in`; for custom, cascade cleanup: `task_kind_presets` + `feature_task_kinds` + `model_recommendations`) · `reset_to_factory()`.
- `FeatureTaskKindStore`: `list() -> {key: task_kind}` · `set(key, task_kind)` (non-empty upserts; "" deletes the row → re-floats to FACTORY task via the `_task_kind_of` fallback, NOT task-less).

**`seed.py`:** add **`DEFAULT_TASK_KINDS`** (the 9 defs) to the SHARED block; NEW `seed_default_task_kinds(s)` (merge-by-id) + `seed_default_feature_task_kinds(s)` (from `app_feature_task_kinds()`, merge-by-key); wire into `seed_llm` before `seed_default_taskkind_presets`.

**`install.py`:** `_task_kind_of(key)` → DB row → in-memory `app_feature_task_kinds()` → `writerAI.rule.*→prose.edit` prefix → "". Wire the two new stores into `make_task_kinds_router`.

**`task_kinds_api.py`:** remove the `TASK_KINDS` constant. `make_task_kinds_router(get_task_kind_store, get_feature_task_kind_store, get_prompt_store, task_kind_of)`:
- `GET /v1/ai/task-kinds` → `{ taskKinds (DB store), featureTaskKinds (built via task_kind_of over the prompt store — NOT a raw dump, so the 3 unseeded rule.* keep provenance) }`.
- `POST` (create) · `PUT /{id}` (rename/edit) · `DELETE /{id}` (cascade; 400 on built-in) — return the full response.
- `PUT /task-kinds/feature` (`{featureKey, taskKind}`; "" clears).
- **Update `tests/test_task_kinds.py`** (imports `TASK_KINDS`, old signature).

**Preset edit-in-place:** wire the existing `PUT /v1/ai/engine-presets/{id}` (`presets_api.py:142`) in the UI (Phase 2) so tuning a task's preset updates it, not spawns a copy.

## Host seed — `justwrite-app/server/justwrite_server/`
- `seed_presets.py`: keep `FEATURE_TASK_KINDS` (the 34-entry feature→task seed), `DEFAULT_ENGINE_PRESETS`, `DEFAULT_TASKKIND_PRESETS`. Do NOT add `DEFAULT_TASK_KINDS` (shared in runner seed.py).
- **Sampler grounding pass:** cross-check the 8 presets' sampler keys/values against the knob-catalog cited defaults + the sampler-guide principles (XTC creative-only; DRY *or* presence; `seed` on deterministic extract/judge); fix violations / non-catalog keys; cite the source. Grounded starting defaults, surfaced with provenance in the Tasks Lab.
- `app.py`: no new arg (`feature_task_kinds` already passed).

## UI — `just-llm-runner/ui/src/` (Phase 2)
- **Promote the master/detail SHELL** (`.lu-fw-body/list/edit/card`, scoped in `FeatureWorkbench.vue:481`) to shared `common/styles.css` so both views consume it.
- **`FeatureLab.vue`** — OWNS `draft`(read-only prompt)+`vars`+`loadSamplers`+samplers/switches+`columnConfig` (getter-only)+`<CompareStrip>`+the engine-preset `saveAs`/`delPreset` (emits `presets-changed`)+a `use-production` EMIT + `productionPresetId` prop. 【NEW#1 — corrected in build】 the pin-EDIT path was **removed as vestigial** (CompareStrip takes `:base-config` one-way + deep-clones it, so the config setter never fired); `pin` is a **read-only seed** for the column's model — model choices persist via Save-as-preset + assign, not the routing pin.
- **NEW `TaskKinds.vue`** — master/detail: task list + New task; per-task label/desc/delete(custom); Members (chips + Add + Move-to…, 【NEW#2】 no remove-to-none); Preset & test = task's preset dropdown + per-task Reset-to-factory + Test-against member → `<FeatureLab>` whose use-production assigns the TASK's preset; empty state for zero members; global-default fallback control.
- **`FeatureWorkbench.vue`:** drop the "Presets by task kind" panel; add a per-feature Task dropdown; adopt `FeatureLab`.
- **`AiModelsArea.vue`:** add a "Tasks" sub-tab after Providers.
- Add a **Tasks help entry** to JW `services/helpDocs.js`.

## Migration / JustVoice
- New tables, no new columns on existing tables → `create_all` + `seed_llm` merge-seed on a plain **restart**; no workspace reset required (dev may reset to re-seed changed defaults).
- **JustVoice insulated (verified both axes):** JV mounts only `llm_runner_router` + shared api + `make_provider_router` (no `install_llm`/`make_task_kinds_router`/`make_presets_router`); JV renderer imports no `AiModelsArea`/`FeatureWorkbench`; JV never `create_all`s the shared `LlmBase`. Guard with a JV import/boot check.

## Policy decisions
- Built-in tasks: rename/re-point/reassign yes; delete no. Custom: full CRUD, delete cascades 3 tables.
- Slug collision → numeric suffix.
- `_task_kind_of`: DB → in-memory map → prefix → "".
- Served `featureTaskKinds` = prompt-store-derived via `task_kind_of` (34 seeded + 3 prefix ≈ 37).
- The `pin` is a read-only seed for the Lab column's model (the pin-EDIT path was removed as vestigial — models persist via presets, not routing pins); every feature always HAS a task (reassignment only).

## Phases (each shippable + gated)
1. **Backend** — 2 tables + 2 stores + shared `DEFAULT_TASK_KINDS` + 2 seeders + `_task_kind_of` (DB→map→prefix) + wiring + remove `TASK_KINDS` + CRUD/feature-assign API + update `test_task_kinds.py` + JW sampler-grounding. Verify: import gate; runner ruff+pytest; JW ruff+pytest; restart + live `GET /v1/ai/task-kinds` (9 + ~37 map); resolve probe (writerAI split; created task + reassign routes; custom-delete re-floats + drops recs; empty-seed fallback routes).
2. **UI** — shell CSS; `FeatureLab`; `TaskKinds.vue`; edit `FeatureWorkbench`; mount Tasks tab; preset edit-in-place; help entry. Verify: build:vite; headless-smoke; Playwright probe.
3. **Verify + docs** — both repos green; JV guard; screenshots; rules-checker on the diff; update `2026-07-01-taskkind-routing.md` (live model) + `MORNING_RECAP.md` + banners + kit/endpoint inventory; commit + push.

## Verification (all RUN in this container)
- Runner: `python -m pytest` + `ruff check llm_runner/ tests/`.
- JW: from `server/`, `python -m pytest` + `ruff check`.
- Renderer: from `justwrite-app`, `npm run build:vite`; boot server :17495 + `npm run dev:vite` :1420; restart server; `node scripts/headless-smoke.mjs`.

## Out of scope
- Inventing new sampler numbers (grounding pass + the Tasks Lab is the fix).
- JustVoice adoption of the Tasks page (deferred).
- json_schema / GBNF (#77).
