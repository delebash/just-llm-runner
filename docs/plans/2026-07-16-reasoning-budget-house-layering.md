# reasoning_budget → the house switch layering (2026-07-16)

**The user's design, settled over 2026-07-16 (full decision trail: the JW session's
memory `thinking-cap-plan-2026-07-16` + this doc):** `reasoning_budget` is a NORMAL row
in the existing switch layer system — Global launch defaults (base bundle, re-seeded
1024) → Hardware/model class default (ClassTune, the tested row) → Your applied config
(ModelTune snapshot; Apply owns every set row and wins like any row). Resolution = the
standard `resolve_model_switches_with_origins` (most-specific wins, provenance map).
**No clamp, no min(), no cap language** — the resolved value IS the thinking budget,
sent per request as JSON `reasoning_budget_tokens` (engine semantics: -1 unlimited /
0 suppress / N cap; b9982, pin b9993). It is NEVER a launch flag (U2-T4 retirement
stands, `process.py:130-136`).

**The labeling law (user):** a row in a switches surface must be a real engine switch
or SAY it isn't. The knob stays plane 1 + gains `per_request: true`; every grid renders
the tag "per-request — sent with every request, not a launch flag; applies without
reload." Honest sentinels: -1 = unlimited, honored + displayed with the loop warning
(the Gemma thinking loop is VERIFIED — joint on-box test ~2026-07-06); 0 = thinking
off. Nothing SHIPS unlimited: local Max map row seeds 32768 finite; gemini max seeds -1
(fixes the live Max<High bug — `gemini.py:140` substituted 8192 where the seed promised
dynamic). *(A 2026-07-16 amendment to seed local Max at -1 was floated then reversed by
the user's counter-ruling the same day — 32768 finite stands; -1 remains legal as an
explicit typed value but is never seeded.)*

**Superseded on the user's word (do not re-propose):** the min-wins clamp (Candidate C,
2026-07-14 — reversed by the user 2026-07-16 "no magic behind the curtains"); the
hidden `reasoning_cap_default` RunnerSetting (deleted — the visible base-bundle row is
the global tier); seconds-denominated settings; per-feature local budgets (presets keep
think on/off only; cloud levels unchanged via the reasoning_map); my redirect idea for
"dead grids" (the snapshot Apply owns every row — the name applies normally from any
layer).

**Feature door (kit UI, second builder):** the feature reasoning control displays the
RESOLVED value + origin ("global default / hardware class default / your applied
config") via resolved-route's new `value`/`valueSource` fields, and edits the WINNING
layer's row through the EXISTING class-tunes / model-tunes endpoints (untuned → class
row; tuned → applied row — a masked write is a lie). Level names remain the display
vocabulary where the value matches a map number; otherwise "Custom".

**Then (user-ordered, on their box):** the think off/on A/B (time + quality — the
original question) and the b9993 loop re-test (engine-direct, -1 + max_tokens net,
declared verdict rule). Harness spec lives with the JW-side record.

---

## BUILD RECORDS (appended by each builder)

### BUILD RECORD (the preset tier, inline — 2026-07-16, the user's "feature is the end of the line")

**Design change (user):** the thinking level moved ONTO the preset as an optional top
tier. Level set = the preset's OWN ask (local: the map's number, source "preset"; cloud:
the map's word) · level EMPTY + think on = FOLLOW the selected model's layered
`reasoning_budget` (unchanged house layering below), resolved live, nothing copied ·
think off = off. The chip/Lab thinking control is three-state (Off / Model|Provider
default / levels) and saves ONE preset PUT — identical to the Lab's update; the chip
NEVER writes layer rows (the 2026-07-16 morning design's winning-row writes are
superseded and deleted).

**What changed · file:line:**
- `llm_runner/llm/reasoning.py` — preset tier in `resolve_reasoning` (level→map tokens,
  source "preset"; token-less map row falls through to follow); docstring.
- `llm_runner/llm/prompts.py:386-392` — the reasoning key is ALWAYS injected under
  effective think ("" = a real state); `llm_runner/llm/dispatch.py:216-226` — only
  think-off short-circuits. (Pre-existing latent gap: think-on with no level never
  reached the resolver — would have broken the follow state.)
- `llm_runner/llm/seed.py` (`seed_default_reasoning_map`) — `s.flush()` before the
  provider query: the host session is autoflush-OFF, so the seeder saw zero providers
  and seeded an EMPTY reasoning map on every fresh boot/reset since 2026-07-14 (found
  on the user's box; proven live: fresh boot + in-process reset both now seed 5 rows).
- `ui/src/components/LuFeatureChip.vue` — three-state control; one preset save;
  `saveLocalBudget`/`seedLocalBudget`/CUSTOM/savedNote deleted; blast line preset-sized.
- `ui/src/classTunes.js` — `upsertSwitchRows`/`mergeClassSwitches` deleted with their
  only consumer; the replace-hazard warning stays as a comment for future writers.
- `ui/src/components/ConfigColumn.vue` + `FeatureLab.vue` + `CompareStrip.vue` — the
  "default" option + the think/effort mappings (a stored think-on+empty-level must load
  as Default, never collapse to Off); `ui/src/services/aiFeature.js:62` — "" forwarded
  as a REAL override (never falls back to the preset's stored level mid-test).
- `ui/src/views/ProviderForm.vue` — Reasoning levels became a POPUP editor (user
  ruling; the launch-config-libraries button pattern), loaded on open.
- `ui/src/composables/useResolvedRoute.js` — source label "preset" → "this preset".
- JW: `server/justwrite_server/seed_presets.py` — p_chat seeds think ON + level EMPTY
  (follow; the old "medium" would ask 4096 on fresh boxes, 4× the tested value);
  `docs/models.md` rewritten to the three-state story; chip tests rewritten
  (`LuFeatureChip.save.test.js` — pins one-preset-write + the no-layer-writes contract
  + the follow-state collapse regression); `classTunes.test.js` deleted with its
  subject.

**How verified:** runner pytest 515 passed / 3 documented pre-existing / ruff clean;
JW `test:fast` fully green (build ✓, vitest 163, server 108); the reasoning suite
carries 4 new preset-tier cases + the autoflush regression test PROVEN to fire
(fails with the flush removed — demonstrated, restored); the seed fix proven on a
live isolated rig (boot + `/v1/data/reset` → 5 rows).

**What reverses it:** revert the commit; the JW seed change re-seeds only on fresh/reset
DBs (fill-if-missing) — an existing p_chat row keeps its stored pair.

### BUILD RECORD (backend, Opus builder) — 2026-07-16

**What changed · why (one line each):**

- `llm_runner/llm/reasoning.py` — deleted `_cap_for` + `_CAP_LAST_DITCH`; reshaped
  `ReasoningPlan` to `think/level/word/value/source`; rewrote `resolve_reasoning` (added
  `hw_key` param) so LOCAL reads the layered `reasoning_budget` switch value via
  `switch_resolve.resolve_model_switches_with_origins` — NO min()/clamp, the resolved
  value IS the budget; honest sentinels pass through, non-numeric → `(None, "invalid")`.
  *Why: the budget is now a normal switch row, not a two-tier cap.*
  (resolve at `reasoning.py:47`; layer read + default/invalid at `:80-90`.)
- `llm_runner/llm/dispatch.py:230-231` — `_apply_reasoning` emits `plan.value` (was
  `plan.effective`). *Why: field rename; no clamp.*
- `llm_runner/llm/prompts.py:296-297,635` — `ResolvedRouteResponse` drops
  `ask/cap/effective/capSource` for `value` + `valueSource`; builder maps `rp.value`/
  `rp.source`. *Why: the mirror law follows the plan's new shape.*
- `llm_runner/llm/reasoning_map_api.py:44,62` — local `max` seed `None → 32768` (finite by
  policy; Gemma loop verified on-box); gemini `max` seed `None → -1` (documented dynamic;
  fixes Max silently < High). Tokens comment reworded (word-only = None). **FINAL STATE
  after two same-day rulings:** a floated amendment to seed local `max` at `-1` was
  **reversed by the user's counter-ruling 2026-07-16** — local `max` **STAYS 32768**
  (original spec value); `-1` remains legal as an explicit typed value but is never seeded.
  Gemini `max` = `-1` throughout (untouched by the reversal).
- `llm_runner/llm/gemini.py:140-143` — `_apply_reasoning`: `budget is None` → set NO
  `thinkingConfig` (was `else 8192`, the Max<High bug); a number (incl -1) passes verbatim.
- `llm_runner/llm/seed.py` — base bundle gains `reasoning_budget: "1024"` (`:360`, the
  visible GLOBAL tier, reversing 2026-07-06); `reasoning_cap_default` RunnerSetting seed
  DELETED (`:450`); `reasoning_budget` knob gains `per_request: True` + new help (`:514`);
  `reasoning_budget_message` knob DELETED (retired launch flag; a no-op knob is a lie).
- `per_request` wire (knobs are DB rows): new `KnobCatalog.per_request` column
  (`db.py:505`, additive — `create_all` picks it up, no reset), carried through
  `seed_default_knobs` insert+sync (`seed.py:1050,1061`), `list_knob_catalog`
  (`stores.py:1252`), and `KnobMeta.perRequest` (`knob_catalog_api.py:32`).
- Tests: rewrote `tests/test_reasoning.py` (12 cases: class/tune/base/default layering,
  -1/0/invalid sentinels, think-off, cloud word/number, seed policy); fixed
  `test_prompts.py:403` (`cap`→`value`), `test_switch_resolve.py:131` (base now carries
  `reasoning_budget=1024`), `test_adapter_extra.py` (gemini None→omit / -1→verbatim; stale
  comment), added a `perRequest` assertion to `test_knob_catalog.py`.

**How verified:**
- `python -m pytest` → **510 passed, 1 skipped, 3 failed**. The 3 failures
  (`test_hardware.py::test_pci_gpus_linux_lspci_name_match` — Windows can't create a path
  with `:` colons; `test_lifecycle.py::test_ensure_model_ready_loads_then_returns` +
  `::test_ensure_model_ready_raises_on_failed_load` — threaded-load timeouts) are
  **PRE-EXISTING**: `git stash` → the same 3 fail on the clean tree. None touch
  reasoning/knob/switch code.
- `ruff check .` → **All checks passed!**

**What reverses it:** revert the commit. Caveats:
1. **Orphan row** — existing DBs keep a `reasoning_cap_default` runner_setting row; the
   resolver no longer reads it (harmless, not cleaned up).
2. **Seed-merge granularity** — `seed_default_switch_presets` is fill-if-missing at
   PRESET granularity (`seed.py:854` `if p["id"] in existing: continue`): an existing
   `base` preset does NOT gain `reasoning_budget=1024` on reseed. Those DBs fall to the
   resolver's `"default"` last-ditch (1024) — same value, tagged `default` not `base`.
3. **Kit-UI handoff (out of THIS build's scope)** — `ui/src/components/LuFeatureChip.vue`
   (~`:87-97`) still reads the removed `cap`/`ask`/`effective` fields (its caption
   degrades to empty, not a crash — `if (r.cap == null) return ""`), and
   `ui/src/composables/useResolvedRoute.js:11` has a stale field-list comment. This is the
   plan's explicit **"Feature door (kit UI, second builder)"** work — the resolved-route
   now serves `value`/`valueSource` for it. Not modified here (backend scope; JS not in the
   pytest/ruff tier; caption wording is a UI design choice the plan owns).

---

## BUILD RECORD (label deletion, Opus builder)

**User ruling (2026-07-16):** Switch UIs show the **EXACT switch name only** — never a
friendly label ("the only name we use is the exact switch name … yes delete label
column"). The knob-catalog `label` column + every data/wire/render path is DELETED.
`help` STAYS ("the help is fine"); `kind`, `plane`, `tier`, `per_request`, `options`,
`default` all STAY. KnobOption's `label` (enum-option display, e.g. `On`/`Off`) is a
DIFFERENT column and is untouched.

**What changed · file:line**
- `llm_runner/llm/db.py:495` — deleted the `label = Column(...)` declaration on
  `KnobCatalog`; updated the section comment (`~487`) `(label/type/...)` → `(type/...)`
  and added the orphan-column note.
- `llm_runner/llm/knob_catalog_api.py:26` — deleted the `label: str = ""` field on
  `KnobMeta`; module docstring `catalog (name → {label, help, kind})` → `{help, kind}`.
- `llm_runner/llm/stores.py:1250` — `list_knob_catalog` no longer emits `"label"`
  (line 1246's `{"value", "label"}` is the KnobOption enum-option join — untouched).
- `llm_runner/llm/seed.py` — removed `"label": "…"` from all **41** `DEFAULT_KNOBS` rows
  (mechanical regex on `{"flag_name":` lines only); `seed_default_knobs` sync path
  (`~1042` `row.label = …` deleted) and insert (`~1056` `label=…` kwarg deleted); the
  `seed_default_knobs` docstring's synced-field list (`~1025`) `label/kind/…` → `kind/…`.
  The `DEFAULT_KNOBS` comment (`~456`) carried no `label` mention — unchanged.
- `ui/src/knobCatalog.js:27` — `plane1SwitchCatalog` map `{ label, help, kind }` →
  `{ help, kind }`; raw-row shape comment (`~8`) + the map comment (`~19`) updated.
- `ui/src/components/KnobGrid.vue` — the checklist metacell was a friendly-label headline
  (`.ui-kg-label`, `{{ row.m.label || row.m.flagName }}`) STACKED over the raw-flag
  `<code class="ui-kg-flag">{{ row.m.flagName }}</code>`. Deleting the friendly label
  (`.ui-kg-label` span) leaves the `<code>` flag as the SINGLE exact-name line; its CSS
  is promoted from muted 10px to ink 12.5px (reusing the old `.ui-kg-label` values, kept
  monospace), the dead `.ui-kg-label` rule + the is-cols selector reference removed.
  (First pass swapped the span's binding to `flagName`, which DOUBLE-rendered the name —
  the rules-checker R1 catch; corrected to the metacell collapse above.) Prop/shape doc
  comments (`~8,~28,~42,~57`) updated. The GROUP header `sec.label` (`~266`, from the
  `groups` prop) + `BOOL_OPTIONS` labels (`~168`) are NOT knob labels — left as-is.
- `tests/test_knob_catalog.py:91` — dropped the now-invalid `label=` kwarg from the
  hand-built `KnobCatalog(...)` (line 94's `KnobOption(... label="q8_0" ...)` STAYS).

**Sweep — `grep -rn "\.label" ui/src` (every hit inspected):**

| File:line | Object source | Verdict |
|---|---|---|
| `knobCatalog.js:27` | knob catalog (`plane1SwitchCatalog`) | **CHANGED** |
| `components/KnobGrid.vue:202` | knob catalog (`catalogList` row) | **CHANGED** |
| `components/KnobGrid.vue:266` | `sec.label` — `groups` section header | not knob (excluded) |
| `views/ProviderForm.vue:238` | `PROVIDER_TYPES` option | not knob |
| `views/QuickSetup.vue:780,798` | optimize-trial / measurement (`t.label`, `best.label`) | not knob |
| `views/FeatureWorkbench.vue:56,77,82,85,96,98,223,226,228` | routing feature/group/action labels | not knob |
| `stores/aiTasks.js:230` · `services/aiFeature.js:34` | AI-task label | not knob |
| `components/AiTaskStrip.vue:79` · `AiStatusPanel.vue:167,253` | task/history label | not knob |
| `common/components/AppDialog.vue:46,179` | dialog field label | not knob |
| `common/services/appearance.js:51,54` | font label | not knob |
| `components/LuModelPicker.vue:104` | model-option label | not knob |
| `components/LuModelCatalog.vue:850,879` | tune-badge / DownloadBar label | not knob |
| `components/LuGlobalSwitches.vue:44,138` | `/v1/ai/switch-presets` row (`SwitchPresetRow.label`, a bundle name) | not knob |
| `components/FeatureLab.vue:108,129,130,208` | sample/source labels | not knob |
| `common/services/toastBridge.js:29` | toast action label | not knob |
| `components/LuMeasureHistory.vue:95` | measurement label | not knob |
| `components/LuFeatureChip.vue:68,69,207` | feature / REASONING_OPTIONS label | not knob |
| `common/components/Breadcrumb.vue:23,24` | breadcrumb segment label | not knob |
| `components/TuneMeasureModal.vue:125,505,559,562` | tune-badge family / trial labels | not knob |
| `common/components/DownloadBar.vue:31` | task label | not knob |
| `common/components/HelpTrigger.vue:29` | help label | not knob |
| `components/LuCombobox.vue:25,52` | combobox item label | not knob |
| `common/components/UiField.vue:20` · `UiSelect.vue:64,99` | form/select-option label | not knob |

Also inspected (no `.label` read, but consume the catalog): `ConfigColumn.vue` (passes
`samplerCatalogList` → KnobGrid checklist; its labels are UiSelect options/field labels)
and `LuClassTunes.vue` (builds `plane1SwitchCatalog` → KnobGrid `catalog`, add-row mode
which reads only `help`/`kind`). Add-row mode never rendered `label`. **No item left for
owner decision.** Runner test sweep (`grep -rn label tests/`): only
`test_knob_catalog.py:91` was a knob-catalog `label`; all other `label=` hits are
FeatureCatalogEntry / SwitchPresetRow / TestSample / measurement-trial — not knob.

**Verification**
- `python -m pytest` → **3 failed, 510 passed, 1 skipped** — the 3 are the documented
  pre-existing failures (`test_hardware.py::test_pci_gpus_linux_lspci_name_match` Windows
  path-colons; `test_lifecycle.py::test_ensure_model_ready_loads_then_returns` +
  `::test_ensure_model_ready_raises_on_failed_load` threaded-load timeouts). No new
  failures; all knob-catalog tests pass.
- `ruff check .` → **All checks passed!**
- JW kit compile check `cd justwrite-app && npm run build:vite` → **✓ built** (the kit is
  aliased into JW's build; warnings are pre-existing vueuse `#__PURE__` annotations). Re-run
  clean after the KnobGrid metacell fix.
- **Rules-checker (Opus, one pass on the final diff):** initial verdict FAIL on 3 items —
  R1 (KnobGrid double-render), R4 (stale `label/` in the `seed_default_knobs` docstring),
  R5 (renderer change cleared only by build:vite). All three now addressed: R1 by the
  metacell collapse, R4 by the docstring fix. R2/R3 passed; KnobOption `label` correctly
  preserved.
- **R5 / visual gate — HONEST LIMITATION:** the KnobGrid render change was verified by
  `build:vite` (compile) + diff inspection (the metacell now renders `flagName` exactly
  ONCE, at `KnobGrid.vue:203`). The headless renderer smoke + a live screenshot of the
  checklist were **NOT run** — that gate requires booting the server on **:17495** and
  `dev:vite` on **:1420**, ports this task EXPLICITLY forbade touching (consistent with the
  task's own tier listing only build:vite). The single-render is structurally guaranteed by
  the diff; the promoted `.ui-kg-flag` size reuses the previously-shipped legible values, so
  no new magic numbers. **Owner: eyeball the switch checklist once (AI settings → sampler /
  switch grids) to confirm the monospace name reads well as the sole line.**

**What reverses it:** revert the commit. Orphan-column caveat — existing DBs keep a
physical `knob_catalog.label` column; `create_all` never drops it, and nothing reads it.
Harmless under the pre-release drop+reseed policy (same class as the
`reasoning_cap_default` orphan above).

---

## BUILD RECORD (UI surfaces, Opus builder)

Closes the plan's **"Feature door (kit UI, second builder)"** + the backend record's
handoff caveat 3 (LuFeatureChip still reading the deleted `cap`/`ask`/`effective`).
Every user-facing string below is the user-approved copy, verbatim.

**What changed · why · file:line**

- **THE source-label map** — `ui/src/composables/useResolvedRoute.js:43-59`:
  `RESOLVED_SOURCE_LABELS` + `resolvedSourceLabel()` (tune→"your applied config" ·
  class→"hardware class default" · base→"global default" · default→"built-in default" ·
  invalid→"invalid value"; cloud "map"/"" carry none — the budget line is local-only).
  *Why: ONE export so the chip popover and the Lab line can't drift into two
  vocabularies for the same layer.*
- **Stale field-list comment fixed** — `useResolvedRoute.js:10-17`: `ask/cap/effective/
  capSource` → `value`/`valueSource` (the plan's named handoff item).
- **Override params** — `useResolvedRoute.js:66-111`: `keyOf`/`fetchRoute`/`routeFor`/
  `ensureRoute`/`refreshRoute` take optional `providerId`/`model` and forward them to the
  endpoint's own override params. **Backward compatible by construction**: an override-free
  call returns the ORIGINAL key shape (`:70`), so every existing chip row is byte-identical
  and a pinned Lab column can never overwrite a feature chip's route. *Why: Surface 4 needs
  THIS column's pinned route, not the feature's production route.*
- **Surface 1 — per-request note.** `ui/src/knobCatalog.js:32` carries `perRequest` through
  `plane1SwitchCatalog` (`{help, kind, perRequest}`); `ui/src/components/KnobGrid.vue:295-297`
  renders THE one note under any add-row row whose catalog entry is `perRequest` —
  *"per-request — sent with every request as JSON, not a launch flag; applies without
  reload"*. **One site, three grids**: verified all three build their catalog from
  `plane1SwitchCatalog` (TuneMeasureModal.vue:59 · LuClassTunes.vue:94 ·
  LuGlobalSwitches.vue:57) and pass it as `catalog`, so no per-grid copy exists or is needed.
  The row loop became a `<template v-for>` so the note is a full-width sibling of its row —
  the namecell is a 1fr grid column and would have shredded the sentence.
- **Surfaces 2+3 — the chip popover** (`ui/src/components/LuFeatureChip.vue`):
  - DELETED `capLine` + `alwaysThinksNote` (they read `cap`/`ask`/`effective`, gone from the
    wire) and their now-dead `.afc-pop-note` rule.
  - `isLocalRoute` (`:137`) branches on `route.providerId === LOCAL_RUNNER_ID` — the SAME id
    comparison `modelApply.js:70,72` already gates its Default/Embedding badges on (the
    codebase compares by provider **id**, not type; mirrored exactly as instructed).
  - LOCAL control: label **"Thinking"**, options Off + each level from
    `GET /v1/ai/reasoning-map/{providerId}` labelled with its own number ("Low (1024)");
    a resolved `value` matching no level's tokens shows a display-only **"Custom (N)"**.
  - `budgetLine` (`:166`) — *"thinking budget {value} — {source label}"*, straight off the
    wire (no client math). `isUnlimited` (`:182`) adds the verbatim **"Unlimited ⚠ — this
    model has been observed to loop; may think until the context fills"** at `value === -1`.
  - Blast radius branches (`:template`): LOCAL says *"Changes {model}'s thinking budget on
    this hardware — every thinking feature on this model shares it"*; cloud keeps the preset
    blast. *Why: a model-on-this-hardware edit must never claim preset scope.*
  - **SAVE (the one-value design)** — the picked level's map number is written to the layer
    that **WON** (`valueSource`), through existing endpoints only: `tune` → GET
    `/v1/ai/model-tunes?modelId=…` + PUT the FULL set with `reasoning_budget` upserted;
    every other layer (`class`/`base`/`type`/`mtp`/`default`/`invalid`) → the (model,
    this-class) row via `putClassTune`, which out-ranks all of them (layer order
    `base < type < mtp < class < tune`, `switch_resolve.py:79-92`). Off ⇒ think false, no
    budget write; Custom ⇒ display-only, no write. *Why the winning layer: writing anywhere
    else is a masked write — the number would sit under an override and the line would keep
    reading the old value.* The preset still takes think on/off; for LOCAL `reasoningEffort`
    is forced `""` (the plan: presets keep think on/off only for local — the local resolver
    reads the layer, never the level, and `reasoning.py:65` resolves fine with `level=""`).
  - **ORDERING is load-bearing**: the PRESET write goes FIRST, then the route is re-resolved,
    and only THEN is the budget written into the freshly-named winning layer. A think-OFF
    route resolves no budget at all (`reasoning.py:72` returns an empty plan ⇒ `valueSource`
    `""`), so on the off→on path the winning layer is *unknowable* beforehand — writing first
    would have to GUESS a layer, and guessing "class" while an applied tune exists is a
    masked write. The same ordering makes a mid-popover model change safe: the re-resolved
    route names the NEW model, so the budget lands on the model the preset now points at.
  - After a LOCAL save the popover STAYS OPEN and re-seeds via `seedLocalBudget(final)` from the
    row `refreshRoute` returned — never `props.route`, which only flows down on the parent's next
    render and would re-seed off the PRE-save value — so the value+source line shows the layer
    the write actually landed in. Cloud save closes, unchanged. *(This exact claim was false in
    the first cut: the seeding function didn't exist. It does now — `:243` — and every SFC
    identifier was enumerated def-vs-call-site. It is still **unexecuted**; see caveat 2.)*
- **Surface 4 — the Lab line** (`ui/src/components/ConfigColumn.vue`): `localBudgetLine`
  renders *"local: thinking budget {value} — {source label}"* only when the column's PINNED
  route resolves local + thinking-on; cloud/no-pin renders nothing. The ensure is driven by a
  **string** key (`pinnedRouteKey`), reusing this file's own documented precedent (`:182-184`
  "Watch the model STRING (not an array getter) … which would loop") — `modelValue` is a new
  object on every keystroke, so an array getter would re-fire the ensure constantly
  (`localBudgetLine` at `:241`). Placed under the params row rather than inside `.cc-reason`
  (that field is capped at 120px and would wrap the line into a column of fragments). Also
  fixed the file's **stale clamp comment** (`:52-57`) that still described the deleted
  hardware-cap min().
- **Surface 5 — the read-only chip: NO changes** (verified: `editable` still defaults false;
  the read-only path touches none of the branched code).

**classKey outcome — accessor FOUND, no fallback taken.** `listClassTunes()`
(`ui/src/classTunes.js:11`) returns the server-derived current-box `classKey` alongside the
library; `LuClassTunes.vue:78` already reads that exact field. It is reachable from the chip,
so the spec's 5-minute fallback (hide the save / "needs owner decision") was **not** used and
**no new endpoint** was invented. A missing classKey throws a real error rather than writing
to a guessed class.

**Verification**
- `npm run build:vite` (justwrite-app; the kit is aliased into JW's build) → **✓ built**.
  Warnings are the pre-existing vueuse `#__PURE__` annotations.
- `npm run test:unit` → **168 passed** (157 = the documented baseline, + 11 new).
- New tests, all in JW (the kit has no JS harness — see caveat 1): `resolvedRoute.test.js`
  (+2) the override forwarding + cache-key isolation and the approved source-label vocabulary;
  `classTunes.test.js` (+4, new) the `mergeClassSwitches` full-replace guard;
  `components/__tests__/LuFeatureChip.save.test.js` (+5, new) which MOUNTS the chip and
  actually drives the local save (caveat 2). **Three legs proven to FIRE, not just green** —
  each re-broken, observed failing, reverted: the override leg (`expected 2 calls, got 1`),
  the data-loss leg (`expected { reasoning_budget: '8192' } to deeply equal { n_gpu_layers:
  '99', … }`) and the ReferenceError leg (`expected 'seedLocalBudgetTYPO is not defined' to be
  ''`). `resolvedRoute.test.js` ALSO carried a comment asserting "no consumer forwards
  override through the cache" — true until this change, now false, so it was corrected rather
  than left to lie.
- `npx biome check` on the changed kit files → exit 0, **but scope it honestly**: biome does
  NOT validate identifiers in `.vue` SFCs here — injecting a bare `totallyUndefinedThing()`
  call into `LuFeatureChip.vue` still exits 0 (tested, then reverted). So biome's pass covers
  the `.js` modules; for the SFCs it proves nothing about undefined references. `build:vite`
  doesn't either — it compiles SFCs without resolving script identifiers.
- **Bounded live probe** on an ISOLATED rig (JW server :17610 + vite :17611 — **1420/17495
  never touched**; Chromium resolved via the `findChrome()` pattern copied from
  `scripts/headless-smoke.mjs`, pointed at Edge through `JW_CHROME` because this box is
  Windows and the smoke's roots are Linux-only). `#/ai` renders (title "JustWrite",
  2219 body chars) with **2 console 404s** (`/v1/ai/engine-config` resolving against the vite
  origin — a rig-wiring artifact). **Attributed, not assumed**: re-probing the BASELINE with
  the kit changes stashed produced the IDENTICAL 2 errors and IDENTICAL body size ⇒
  pre-existing, **zero new console errors from this diff**. Rigs torn down.
- **R5 / visual gate — HONEST LIMITATION:** no screenshot was taken and none of the three new
  surfaces was driven interactively (the popover's local branch needs a configured LOCAL
  route + a reasoning-map row; the probe only proves the page mounts clean). This is at the
  **user's explicit instruction** — they are doing all visual verification on their own box.
  **Owner's look pass:** (1) a `reasoning_budget` row in any switch grid shows the
  per-request note once; (2) the chip popover on a LOCAL route shows Thinking + the
  value+source line, and a save moves the value to the layer the line names; (3) the Lab
  column's "local: thinking budget …" line appears only for a local pin.

**Rules-checker (Opus): TWO passes, both FAIL, both fixed — the second caught a shipped bug
the first pass's fixes introduced.**

**Pass 2 — `seedLocalBudget` DID NOT EXIST.** The pass-1 fix renamed the seeding call site but
never split the function: `save()` called `seedLocalBudget(...)` while the definition was still
the zero-arg `loadLocalBudget()`. Every LOCAL budget save would have thrown
`ReferenceError` *after* the write landed — so a SUCCESSFUL save would report itself FAILED with
a JS internals string in the error slot. **Nothing caught it**: `build:vite` compiles SFCs
without resolving script identifiers, biome doesn't validate `.vue` identifiers (proven above),
the probe only mounted `#/ai`, and no test touches an SFC. This is the textbook "green ≠ proof
— a test that never exercises the path is no test", and the pass-1 record's defence ("verified
by code-read only") is exactly what failed: the code-read missed an undefined call one line
below the code it was inspecting. Fixed by the real split — `loadLocalMap()` (fetch, keyed by
provider) + `seedLocalBudget(route)` (seed from a passed row) — and every identifier in the SFC
was then re-enumerated def-vs-call-site.

**Pass 2 — the `draftIsLocal` fix had REGRESSED cloud→local.** Display branched on the route
while save branched on the pin, so they disagreed on a mid-popover repoint: a cloud route
showing "Reasoning: High" saved as `think=false` — a visible pick silently discarded. Fixed by
the invariant the checker named: **the control and the save now key off the SAME thing** (the
pin being written, `draftIsLocal`), the level map loads on a repoint into local, the value+source
line additionally requires the pin to still name the route (`pinNamesRoute` — otherwise the row
describes the model you left), and the blast line names `budgetModel` (what will change). The
spec's "branch on the ROUTE" is honoured where it was written for — on open, pin == route — and
the divergence only exists in the repoint case the spec didn't anticipate. **This one is flagged
for the owner** (see caveat 4): it is a guess at intent, and the checker is right that it should
have been asked.

**Pass 4 — the fix had landed on the BRANCH, not the bug CLASS (R3).** The upsert existed
TWICE: `mergeClassSwitches` (hardened, documented, tested) and a private `upsertRows` inline in
the SFC for the `tune` branch — same operation, split only by the two endpoints' body shapes.
And **model-tunes PUT is the identical wholesale replace** (`tests/test_model_tunes.py::
test_put_replaces_the_whole_set`: "the old batch_size row is GONE, not merged" — **read, not
taken on the checker's word**). So the exact bug that was fixed for class-tunes still had an
untested, undocumented twin one branch over. Fixed properly: ONE `upsertSwitchRows` in
`classTunes.js:43` serves both endpoints (`mergeClassSwitches:52` is now a thin shape
conversion over it), the SFC's private copy is gone, and a 5th mount leg drives the `tune`
branch — **proven to fire**: a partial write there fails it with *expected
`{ reasoning_budget: '8192' }` to deeply equal `{ threads, batch_size, … }`*. Also from pass 4:
`save()`'s `saveLocalBudget(resolved || props.route)` fallback re-introduced the very layer
GUESS the ordering exists to prevent (`refreshRoute` returns null on a swallowed fetch error and
the preset PUT had just dropped the cache) — it now throws an honest error instead; and the map
no longer double-fetches on open.

**Pass 1 — the three original findings, all fixed:**

- **R1(a) — a DATA-LOSS bug, the checker's best catch.** `putClassTune` is a wholesale
  REPLACE (`stores.py:970-975` DELETEs every row of the (model, class) pair before
  inserting — **verified by reading the store**, not taken on the checker's word). The first
  cut looked the existing class row up only when `src === "class"` and otherwise PUT
  `{reasoning_budget}` alone. But **a class row can exist while a BROADER layer owns
  `reasoning_budget`** — the row simply doesn't carry that key (only one model is seeded with
  it, `seed.py:396-400`), so the origin reads `base`/`default` while a row full of
  `n_gpu_layers`/`n_cpu_moe`/`ctx_len` sits there. Picking "High" in a chip would have
  **silently destroyed those switches**. Fixed: the lookup is now UNCONDITIONAL and the merge
  moved into `classTunes.js` as `mergeClassSwitches` — the module that owns the class-tune
  wire — carrying the replace hazard in its doc so the next one-key writer can't repeat it.
  The spec's "base/default → CREATE the row with `{reasoning_budget}` only" is satisfied
  exactly: with no row the merge yields that single key. *(The checker is right that this
  ambiguity — "create" when the row already exists — should have been ASKED, not guessed.)*
- **R1(b) — stale route as the write target.** Half was already fixed by the ordering above
  (the budget write consumes the route re-resolved AFTER the preset write, so it names the
  new model). The other half was real: `local` was computed from the OLD route, so repointing
  local→cloud still forced `reasoningEffort: ""`, leaving the cloud preset `think=true` with
  no level ⇒ `resolve_reasoning` returns nothing (`reasoning.py:93-94`). Fixed: save
  semantics now follow `draftIsLocal` (the pin being written), while the displayed control
  still branches on the route as the spec ordered.
- **R2 — three stale claims** in `ConfigColumn.vue`, all fixed: the deleted hardware-cap
  clamp still described at `buildBody` (a second copy of the claim I'd fixed 330 lines
  above), the `samplerCatalogList` row shape still listing the deleted `label`, and my own
  new comment overclaiming that the line reports "the Reasoning ask above" — it reports the
  **route**, which derives think/level from the assigned PRESET (`prompts.py:628-629`).
- **Also from the checker's notes:** `valueSource`'s real vocabulary is wider than the spec's
  five — `base · type · mtp · class · tune` (`switch_resolve.py:24-25`, verified). A
  `reasoning_budget` typed into the MoE/dense/MTP bundle would have rendered a dangling
  "budget 2048 — " with an empty label. Both surfaces now fall back to the raw origin. The
  save was already correct for those origins (class out-ranks type/mtp).
- R3/R4 PASS (one source label map, one note site, Surface 5 untouched, no dead CSS, the
  composable's new params additive so every existing caller is unaffected).

**What reverses it:** revert the commit (kit-only; no schema, no endpoint, no seed touched).
Caveats / owner decisions:
1. **The JW-side tests + harness are NOT in this commit.** The kit has **no JS test harness of
   its own** (`ui/package.json` has no test script and there are no specs under `ui/`), which is
   why the kit composable's tests already live in JW's vitest suite. This task was scoped to
   commit in THIS repo only, and the JW repo also holds unrelated concurrent work from another
   session, so nothing there was staged. Left modified/created and uncommitted **in
   justwrite-app**:
   - `vitest.config.js` — the vue plugin + the mirrored dedupe list (the mount harness).
   - `src/renderer/src/services/__tests__/resolvedRoute.test.js` (+2 legs).
   - `src/renderer/src/services/__tests__/classTunes.test.js` (new, +4).
   - `src/renderer/src/components/__tests__/LuFeatureChip.save.test.js` (new, +5).
   **Owner: land these four with JW's own commit** — without them the kit ships with its
   override/label/merge behaviour and its whole local-save path unpinned, which is exactly how
   the two bugs above got in. This split is an artefact of the task scoping, not a design view.
2. **R5 — the LOCAL save path is now EXECUTED (pass-3 finding; the gap is CLOSED).** Passes 1-2
   left this path untested, and that gap had already shipped two bugs past a fully green
   build+lint. My stated excuse — "no mount harness exists, closing it is bigger than this
   task" — was **FALSE, and the checker caught it**: I had "verified" the deps with CJS
   `require.resolve`, which reports ESM-only packages as missing. `jsdom` (`package.json:72`)
   and `@vitejs/plugin-vue` (`:68`) are both installed and importable; only `@vue/test-utils` is
   absent, and `createApp` doesn't need it. An error that flattered the work was never checked.
   The real cost was ~3 config lines. Done instead of excused:
   - `vitest.config.js` gains `plugins: [vue()]` + the SAME `dedupe` list as `vite.config.js`
     (the aliased kit imports peers by bare specifier from a dir with no node_modules — without
     dedupe a mounted kit SFC can't resolve `reka-ui`). The default environment stays **node**;
     the one component file opts in with a `@vitest-environment jsdom` docblock, so the pure-JS
     suites are untouched.
   - `src/renderer/src/components/__tests__/LuFeatureChip.save.test.js` (new, 5 legs) MOUNTS the
     chip, opens the popover, picks a level and clicks Save — executing `saveLocalBudget` for
     real. It pins BOTH write branches: the class-row write and the model-tune write each
     preserve their row's other switches; a save reports success (not a ReferenceError); think
     on/off goes to the preset while the budget never does; Off writes no budget at all.
   - **Three legs PROVEN to fire** (green ≠ proof), each re-broken then reverted: the
     `src === "class"` gate fails it with the wipe itself (*expected `{ reasoning_budget:
     '8192' }` to deeply equal `{ n_gpu_layers: '99', … }`*); a partial model-tunes write fails
     the tune leg (*… to deeply equal `{ threads, batch_size, … }`*); the typo fails it with
     *expected `'seedLocalBudgetTYPO is not defined'` to be `''`*.
   Residual: the CLOUD branch and the mid-popover repoint are still not mounted — the harness
   now exists to cover them cheaply. The owner's look pass is still worth one real local save.
3. **`reasoningEffort` is cleared on a LOCAL preset save.** Repointing local→cloud starts at
   Reasoning = Off rather than re-using a level that was never meaningful locally. Follows
   "presets keep only think on/off for local"; flag it if the level should be remembered.
4. **OWNER DECISION — the mid-popover repoint (a guess, not an approved rule).** The spec says
   branch the control on the ROUTE; it never said what happens when the user repoints the model
   picker while the popover is open, and the two obvious readings conflict (branch-on-route
   silently discards a visible pick; branch-on-pin diverges from the spec's words). The
   implemented rule, stated as it actually SHIPS: **control + save both read the same
   `draftIsLocal`, so display and save can never disagree.** Each branch keeps its own draft —
   there is no reset code — so a repoint shows the OTHER branch's draft: cloud→local lands on
   Off only because `draftBudget` was never seeded, and switching back preserves the earlier
   pick. Identical to the spec on open (pin == route); only the repoint case differs. Confirm
   or redirect.
5. **Two spec-mandated behaviours worth the owner's eye** (surfaced by the checker; both follow
   the spec as written, so neither was changed):
   - `putClassTune` always writes `built_in=False` (`stores.py:984`), so a budget pick in the
     chip silently converts a **seeded built-in class tune into a user-owned row** — it stops
     re-seeding from then on. That is a property of the existing endpoint, not of this change,
     but this change makes it reachable from a chip instead of only from the tune editor.
   - The UI branches local on provider **id** (`LOCAL_RUNNER_ID`, as the spec instructed) while
     the backend branches on provider **type** (`_LOCAL_TYPES`, `reasoning.py:21`). Identical
     today; they'd diverge for a second provider of type `local-llamacpp`.
6. **Cache-key alignment** (checker note, correct today): the chip's `refreshRoute(props.feature)`
   matches the host's key because `AiFeatureChip.vue:31,33` ensures/reads with feature only and
   the kit chip has no `action` prop. It would break if a host ever mounted the chip WITH an
   action — cheap guard, not a defect now.