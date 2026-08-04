# Plan — Preset model A (task owns the preset) + full reset story + UI polish

> **⚠ CASCADE PARTLY SUPERSEDED (2026-07-14).** This plan's core (Plan A resets, edit-in-place,
> reset story) stands, BUT its **2-tier cascade** ("task preset → default; no per-feature
> override") was **reverted**: the per-feature preset override tier is restored, so the live
> cascade is again **3-tier — feature override → task preset → global default**. The removal here
> was a misread of intent (the user always wanted fine-grain per-feature control). Current
> AI-routing/preset model: `docs/plans/2026-07-14-feature-override-and-reasoning-plan.md`.

## ⛔ LIVE STATUS — where this stands (kept current; single source of truth)
Branch (all repos): `claude/admiring-galileo-il3q0o`. Base: runner `d4d91bf`, JW `39de67c`.
- **Approved** by the user (2026-07-02) after a 3-checker rules panel (architecture-fit · reuse · grounding) — all three approve Plan A; FAIL findings folded in (marked 【panel】). User then said "complete all phases without stopping" (no-stop mode).
- **Phase 1 — Backend: DONE + VERIFIED.** Dropped the `FeaturePresetRef` override tier (resolver→prompts→presets_api→stores→db→install; 2-tier cascade via `resolve_task_preset`). `reset_routing_to_factory` now restores built-in engine presets (delete→**FLUSH**→reseed, via the shared `stores._delete_engine_preset_rows`) + built-in task label/desc (enumerate for position). Per-task reset `POST /v1/ai/task-kinds/{id}/reset` (built-in only; guards a missing/deleted factory preset). `EnginePresetStore.delete` hardened (explicit child delete — no orphans). Tests rewritten (test_presets 2-tier; test_shared_storage reset+restore+teardown; test_task_kinds per-task reset). Backend docstring sweep done. **Verified:** import gate; runner ruff + **192 pytest**; JW ruff + **76 pytest**; live curl on a fresh server — preset-assignments has no `features`; 9 tasks + 9 factoryTaskPresets; edit a built-in preset → `POST /task-kinds/reset` → **RESTORED** (the flush); per-task reset built-in→200 / custom→400.
- **Phase 2 — UI: DONE + VERIFIED.** FeatureWorkbench Plan A (read-only resolved-preset line, Lab "use"→task preset, dropped the override/dot/`featurePreset`, 2-tier provenance via the shared `taskLabel`). TaskKinds per-task **Reset** beside Rename (built-in only) replacing the preset ↺; `resetAll` copy discloses presets/labels/Default snap back. Collapse→**JW Icon toggle** (`SidebarToggle`) in both views. Nav **flex-to-content** (`fit-content(40%)` + `min-width:280` + nowrap/ellipsis label; fixed a *pre-existing* `width:100%`+margin indent overflow via `align-self:stretch` — `scrollWidth==clientWidth`). FeatureLab `updatePreset` no-rename guard. **Copy sweep**: shared `ui/src/common/taskLabels.js` resolver; RecommendationsEditor relabeled "Task kind"→"Task" + id→label + a Task **picker**; ConfigColumn use-button task-grained; every kit AI view clean of "task kind"/raw-id. **Verified:** `build:vite` clean; `headless-smoke` **0 JS errors** over every route + all **6** AI sub-tabs; a Plan-A Playwright probe **PASSED** (built-in Reset present / custom Delete; icon toggles; read-only preset line; task-grained use-button; nav `scrollWidth==clientWidth==367`, ≤40% cap, ≥280 min).
- **Phase 3 — Docs + verify + ship: DONE.** `tasks.md` updated (the three reset levels + Update-vs-Save-as-preset + a feature's preset comes from its task); this LIVE STATUS + `MORNING_RECAP.md` updated in full prose; JV guard (grep-clean of every removed symbol; JV mounts none of these routers). A post-task **rules-checker on the full diff → PASS** (its one FAIL — stale header comments still describing the removed tier — + the `factoryTaskPresets` dead-surface advisory were both fixed, then re-verified **PASS**). Committed + pushed both repos on `claude/admiring-galileo-il3q0o` this turn (exact chain in `MORNING_RECAP.md`).

---

## Context
Follow-up to the shipped user-creatable Tasks feature. The user made these calls this session:
1. **Plan A — the task owns the preset.** Today the cascade is 3 tiers: a per-feature override (`FeaturePresetRef`) → the feature's task preset (`TaskKindPreset`) → the global default (`TaskKindPreset[""]`) — `preset_resolve.py:27`. The override tier is a leftover from before tasks were first-class; it makes Routing-by-feature show a preset dropdown identical to the Tasks page (the confusion the user hit). Decision: **drop the override tier.** A feature's preset IS its task's preset. Routing-by-feature shows the resolved preset **read-only**; a task's preset is changed on the Tasks page (or via the Lab's "use", which now sets the *task's* preset). Cascade → 2 tiers: task preset → default.
2. **Restore presets — folded into "Reset all to defaults."** Built-in engine presets are editable in place (Phase-2b Update) and deletable (`EnginePresetStore.delete` has no guard, `stores.py:604`) with no way back to factory. The global reset (`reset_routing_to_factory`, `seed.py:476`) only snaps *assignments* back. Fold **restore built-in engine presets + restore built-in task label/desc** into that one reset (custom tasks + presets kept).
3. **Per-task Reset next to Rename** (built-in only), replacing the per-task preset ↺ (`TaskKinds.vue:271`). Resets the task's **own definition** — factory label + description + preset (NOT members).
4. **Collapse-list → JW-style toggle button** (both lists) — match `Sidebar.vue:806` (`<UiButton intent="ghost"><Icon name="SidebarToggle"/></UiButton>`), replacing the text toggle (`FeatureWorkbench.vue:278-280`, `TaskKinds.vue:244-245`).
5. **Routing-by-feature nav flexes to feature width, no scroll.** `ui/src/common/styles.css:257` `.lu-fw-body` caps the nav at 26% → long feature names wrap/clip. Size the nav to content with a cap. Shared shell → fixes both views.
6. **Rules-checker fixes** from Phase-2b: T11 doc gap + 3 advisories.
7. **User-facing copy = "Task", never the internal id.** Every user-visible string reads "Task"/"Tasks" (never "task kind"/"taskKind"/"task_kind"/"kind") and shows task **labels** ("Generate prose"), never raw ids (`prose.generate`). Global RULE #1 §5. Internal ids stay in code + URLs only.

Grounding (line-by-line + panel-verified): JV **zero** references to any touched symbol (mounts only `llm_shared_api_router` + `make_provider_router`, `JustVoice/server/justvoice/app.py:194-200`) → fully insulated; orphan `feature_preset_refs` table is inert (`create_all` metadata-only, no Alembic). `/preset-assignments/feature` has 2 callers (FeatureWorkbench:196,225); `clear-features` **zero**. `EnginePreset.built_in` (`db.py:370`) is seeder-only (`save()` never writes it). JW enables `PRAGMA foreign_keys=ON` (`server/justwrite_server/database.py:48-52`) so cascade fires there; the runner's own path leaves it off — so preset teardown must delete children **explicitly** (host-agnostic).

---

## Phase 1 — Backend (Plan A cascade + the full reset story)

### 1a. Drop the per-feature override tier (Plan A)
- **`preset_resolve.py`** — rewrite the cascade (`:20-33`): drop the `refs.get(feature_key)` lookup (`:25`,`:27`) → `tks.get(task_kind) or tks.get("")`; rename `resolve_feature_preset(feature_key, task_kind)` → `resolve_task_preset(task_kind)`; update the module **docstring** (2-tier).
- **`prompts.py`** — `_resolve_preset` (`:384-395`): keep `task_kind = task_kind_of(action) or task_kind_of(feature)`, then `resolve_task_preset(task_kind)`; update import (`:35`) + docstring. Call sites `:440`,`:484` unchanged.
- **`presets_api.py`** — remove the override surface: `FeatureAssignment` (`:63-65`), `FeatureClearRequest` (`:68-72`), `FeaturePresetRefStore` Protocol (`:92-94`), `AssignmentsResponse.features` (`:104`), the `get_refs` param (`:110`), `features=` in `_assignments()` (`:126`), the `/preset-assignments/feature` (`:172-177`) + `/preset-assignments/clear-features` (`:179-188`) routes. Update the **module docstring** (`:9`) + router docstring (`:114`).
- **`stores.py`** — remove `FeaturePresetRefStore` (`:639-660`), `_feature_preset_ref` (`:896`), `get_feature_preset_ref_store` (`:913`); fix `_engine_preset_to_wire` comment (`:536`).
- **`db.py`** — remove the `FeaturePresetRef` model (`:409-416`). (Orphan table inert; no migration.)
- **`install.py`** — drop `get_refs=…` from the `make_presets_router(...)` mount.

### 1b. Reset all → true factory reset (restore presets + task defs) 【panel: critical fixes】
- **`stores.py`** — extract a shared teardown `_delete_engine_preset_rows(s, ids)` that deletes `engine_preset_switches` + `engine_preset_samplers` children **then** the `EnginePreset` parents explicitly; reuse it in `EnginePresetStore.delete` (`:604`, currently relies on cascade → orphans children when the host FK is off — host-agnostic fix).
- **`seed.py`** — two helpers, folded into `reset_routing_to_factory` (`:476`):
  - `restore_built_in_engine_presets(s)` — `_delete_engine_preset_rows(s, <built_in ids>)` → **`s.flush()`** → `seed_default_engine_presets(s)` (`:402`). **The flush is mandatory** — autoflush is OFF (`seed.py:405`); without it the seeder's `existing` query (`:407`) still sees the pending-deleted rows and its merge-by-id guard (`:410`) skips re-adding them → built-ins permanently gone. Mirror `SwitchPresetStore.reset_to_factory` (`stores.py:527`).
  - `restore_built_in_task_defs(s)` — `for i, t in enumerate(DEFAULT_TASK_KINDS)` (`:195`), overwrite `label`/`description`/`position=i` on the built-in row (keep `built_in`); custom untouched. **`enumerate` for position — `DEFAULT_TASK_KINDS` rows have no `position` key** (derived by index at `:456`).
  - `reset_routing_to_factory`: clear `task_kind_presets` + `feature_task_kinds` → `restore_built_in_engine_presets` → `restore_built_in_task_defs` → `seed_default_task_kinds` (add-missing) → `seed_default_feature_task_kinds` → `seed_default_taskkind_presets` (FK-safe: presets restored first). Drop the `FeaturePresetRef` clear line. Update docstring.

### 1c. Per-task reset endpoint (built-in only)
- **`seed.py`** — `reset_task_to_factory(task_id)`: built-in only; overwrite label/desc/position from `DEFAULT_TASK_KINDS` (enumerate) + set its `task_kind_presets` row from `app_taskkind_presets()`. **Edges**: if the task has **no** factory preset entry → **clear** its row (fall back to default); if the factory preset id no longer exists as an `EnginePreset` (user-deleted) → **clear/skip** rather than write an FK-violating id. Custom task → raise (400).
- **`task_kinds_api.py`** — `POST /v1/ai/task-kinds/{id}/reset` via a new `reset_task_fn` param; 400 on custom; returns the full `TaskKindsResponse`. Keep the literal routes `/feature` `:94` + `/reset` `:117` before `/{id}`.
- **`install.py`** — pass `reset_task_fn=seed.reset_task_to_factory`.

### 1d. Tests
- **`tests/test_presets.py`** (`:27`,`:74-113`) — preset-assignment/resolve tests hitting `/preset-assignments/feature` + `clear-features` → rewrite to 2-tier.
- **`tests/test_shared_storage.py`** (`:124`,`:132`) — update `test_reset_routing_to_factory`: assert custom preset + custom task **survive**, an **edited built-in preset restored** + a **renamed built-in task label restored**; drop FeaturePresetRef. New `test_reset_task_to_factory` (built-in restores label+preset; no-factory-entry clears; custom errors). Add `test_engine_preset_delete_removes_children`.
- **`tests/test_task_kinds.py`** (`:104`,`:174`) — add a `_reset_task` stub; test `POST /task-kinds/{id}/reset` (built-in ok, custom 400).
- **JW `server/tests`** — grep confirms zero code refs; no test change.

### 1e. Backend docstring/comment sweep
- Grep `FeaturePresetRef` + "per-feature override" + "3-tier" across both repos; update: `db.py:346-347` + `:400`, `preset_resolve.py` docstring, JW `server/justwrite_server/seed_presets.py:5-6`.

**Verify 1:** import gate; runner `ruff`+`pytest`; JW `ruff`+`pytest`. Restart server; live curl — `preset-assignments` has no `features`; 2-tier resolve; **edit a built-in preset → `POST /task-kinds/reset` → it's back** (the flush); delete a built-in preset → reset → back; rename a built-in task → reset → name back; custom task + preset survive; `POST /task-kinds/{builtin}/reset` restores, `{custom}` → 400; preset delete leaves no orphan children.

---

## Phase 2 — UI

### 2a. FeatureWorkbench.vue — Plan A (read-only preset, use-for-task)
- Remove the per-feature override: `hasProd` (`:119-121`) + the card `.lu-fw-dot` (`:258`); `setFeaturePreset` (`:195-199`); the now-dead `featurePreset()` (`:178-180`); rewrite `featurePresetLabel` (`:185-194`) to 2-tier; `onUseProduction` (`:202-205`) → set the feature's **task** preset via `PUT /preset-assignments/task-kind` (`taskKind = featureTask(selAction)`), toast "Set for task <label>".
- FeatureLab mount (`:283-286`): `:production-preset-id` = `assign.taskKinds[featureTask(selAction)] || defaultPresetId`.
- Header (`:266-281`): add a muted **read-only** "Runs: `<preset>` · from `<task>`" line; keep the Task dropdown + `resetFeature` ↺ (simplify `:222-231` to clear only the task override).
- `presetAssign` init (`:35`) + `load` (`:152-153`): drop `features`.
- **Sub-decision (approved):** the Lab "use" sets the feature's *task* preset; the shared button label makes the grain explicit.

### 2b. TaskKinds.vue — per-task Reset next to Rename
- Header (`:237-246`): `<UiButton v-if="selected.builtIn" intent="ghost" size="small" @click="resetTask(selected)">Reset</UiButton>` beside Rename (built-in only). `resetTask` → `POST /task-kinds/{id}/reset` → `applyTaskResp` + reload assignments.
- Remove the per-task preset ↺ (`:271-272`) + `resetTaskPreset` (`:179`); drop `factoryTaskPresets` if unused; clean dead `features:{}` init (`:27`,`:98`).
- `resetAll` confirm copy (`:181-192`): disclose the Default preset + built-in presets/labels also snap back.

### 2c. Collapse toggle → JW Icon button (both views)
- Replace the text toggle (`FeatureWorkbench.vue:278-280`, `TaskKinds.vue:244-245`) with `<UiButton intent="ghost" size="small" v-tooltip.bottom="…" :aria-label="…"><Icon name="SidebarToggle" :size="14"/></UiButton>`. `import Icon from "../common/components/Icon.vue"`. Kit `Icon` + `SidebarToggle` confirmed present (`Icon.vue:57`).

### 2d. Nav flexes to feature width (shared shell)
- **`ui/src/common/styles.css`** — `.lu-fw-body` (`:257`): `minmax(280px, 26%)` → `fit-content(40%) minmax(0,1fr)` + `.lu-fw-list { min-width: 280px }` + `white-space: nowrap` on `.lu-fw-card-label` (`:263`); keep `overflow-x: hidden`. Remove the unused `.lu-fw-dot` (`:266`). **Verify by measurement** (Playwright width probe).

### 2e. Edit-in-place advisory #1
- **`FeatureLab.vue`** (`ui/src/components/`) — `updatePreset` (`:91-96`): replace `p?.name || "preset"` (`:93-94`) with `const p = props.presets.find(...); if (!p) return;`.

### 2f. User-facing copy sweep + shared label resolver (Context #7)
- **Shared resolver:** add a pure `taskLabel(id, tasks)` helper in the kit (`ui/src/common/`), consumed by every view (kills the `taskKindLabel` fork at `FeatureWorkbench.vue:182` which falls back to the raw id; gives `RecommendationsEditor.vue:200` a resolver).
- **Per-view strict-diff sweep** (enumerate every kit AI view): `FeatureWorkbench.vue`, `TaskKinds.vue`, `AiModelsArea.vue`, **`RecommendationsEditor.vue`** (dirty: `:34`/`:94`/`:128`/`:182`/`:223`, raw ids `:200`/`:224`), `PricingEditor.vue`, `QuickSetup.vue`, `ProviderForm.vue`, `ConfigColumn.vue`, `CompareStrip.vue`, `FeatureLab.vue`. For each: file:line status row. Fix = relabel "task kind"→"Task"; id→label via the resolver.
- **`ConfigColumn.vue:328-330`** — the "use" button + tooltips say "this feature"; under Plan A the click sets the whole task → relabel task-grained (correct in both views); `useLabel`/`useTitle` prop if wording must differ, else neutral "Use for this task".

**Verify 2:** `npm run build:vite`; boot server :17495 + `npm run dev:vite` :1420; `node scripts/headless-smoke.mjs` (0 JS errors, all 6 AI sub-tabs); Playwright probes — read-only preset (no per-feature dropdown), Lab "use" sets task preset; per-task Reset built-in only + restores; collapse toggle icon both views; nav width measured; no "task kind"/raw-id leaks. Screenshots.

---

## Phase 3 — Docs + verify + ship
- **`justwrite-app/docs/tasks.md`** (T11) — add **"Reset to defaults"** (global = assignments + built-in presets + task names, custom kept; per-task Reset; per-feature ↺) + **Update** vs **Save as preset** + a note that a feature's preset comes from its task.
- Update this LIVE STATUS + `MORNING_RECAP.md` (2026-07-02) in full prose; reconcile the taskKind-routing model doc.
- JV guard: boot/import check + grep confirms no JV ref to removed symbols.
- **rules-checker on the final diff** (single, post-task) before commit.
- Commit per-repo on `claude/admiring-galileo-il3q0o` (runner + JW), push `-u`. No PR unless asked.

## Verification (all RUN in this container)
- Runner: `python -m pytest` + `ruff check llm_runner/ tests/`.
- JW: from `server/`, `python -m pytest` + `ruff check`.
- Renderer: `npm run build:vite`; boot server :17495 + `npm run dev:vite` :1420; **restart server**; `node scripts/headless-smoke.mjs`; Playwright probes.
- Live: 2-tier resolution; global reset **restores** presets + labels + assignments (custom kept — verify the flush); per-task reset (built-in ok, custom 400, missing-factory-preset guarded); edit-in-place no-rename; preset delete leaves no orphan children.

## Out of scope
- QuickSetup `/v1/ai/jobs` repoint (#100). (Copy sweep still relabels its user-facing "task kind".) — **CLOSED 2026-07-06 (user decision, took the recommendation — outstanding-master-plan D1):** QuickSetup keeps writing the picked model onto the EXISTING task presets (the non-clobber `modelApply.js:75-87` PUT; skips user-re-pointed presets); it does NOT generate a preset per task. Zero code; #100 closed.
- JustVoice adoption of the Tasks page (deferred).
- json_schema / GBNF (#77).
- New sampler numbers (grounding pass already done).
