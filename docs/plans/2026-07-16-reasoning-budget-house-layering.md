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