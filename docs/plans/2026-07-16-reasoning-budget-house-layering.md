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