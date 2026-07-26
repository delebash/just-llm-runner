# 2026-07-26 — "PC class config": the rename + every-model class visibility

**Status: EXECUTED 2026-07-26 (planner diff-review passed same day). The record lives in
justwrite-app `docs/plans/2026-07-22-igpu-research-and-cpu-band-recovery.md` §24 — including
the two claims below that §24 corrects: the "TASKS.md #214" item named in touch item 8 never
existed, and `ARCHITECTURE.md:198` is the model-FAMILY thinking table, not a PC-class section
(left untouched on merit).** Planner: the session model (Fable). Executor: the `executor`
agent (Opus). Not committed — the user owns the commit word.

## Decision lineage (why this exists)

The user hit the "Hardware/model class default" chip three times in three days and named the
root cause on 2026-07-26: "we keep getting it wrong" — the catalog (a chooser surface) shows a
tuner's concept, and the word "default" is triple-booked on one screen (Load as default ·
Hardware/model class default · Global launch defaults). Their direction, across the
2026-07-26 conversation: rename the whole thing everywhere; make each row's hardware story
visible without hovering ("when i look at list i have no idea what hardware it might run on");
show EVERY model under the hardware class, the untested ones honestly bare ("just for those
not tested they have no switches"); present correct info and just inform ("long as we present
user with correct info … we just need to inform user"); and **"dont over engineer"** (their
mid-turn word, which killed the provenance-schema branch — see NOT IN SCOPE). "Your rec"
adopts the planner's recommendations on every open pick. This supersedes the user's own
QC-19 anchor wording ("Hardware/model class default(s)", 2026-07-08) — their 2026-07-26
direction overrides their 2026-07-08 anchor — and resolves the open TASKS.md item #214
(whether that chip wording stays).

Design facts the plan rests on (planner-verified 2026-07-26): a class-tune "config" is only
per-switch rows keyed (model_id, class_key, flag_name) — `llm_runner/llm/db.py:435-441`, no
config-level entity — so "not tested = no switches" is ALREADY the stored truth and every
model × class is already an addressable slot; the panel merely hides no-switch models
(`ui/src/components/LuClassTunes.vue:419-421`). The §9 recommendation signal is "a model with
a config for YOUR class is the recommendation" (`llm_runner/llm/seed.py:458-462`), which is
why NO empty rows are ever created. The floors (`min_vram_mb`/`min_ram_mb`) are seeded on
every model row (`seed.py:179-382`) and already ride the fit-shaped catalog rows
(`LuModelCatalog.vue:268,273`), so the visible-floors change needs zero wire change.

## Closed decisions (the executor does NOT re-open these)

1. **The user-facing noun is "PC class."** Internals unchanged everywhere: `class_key`,
   table names, API routes, Python identifiers, test names. This is a COPY rename only.
2. **The library renames to "PC class configs"; the catalog badge becomes
   `PC class config · <short class label>`.** Because badge and editor share the new name,
   QC-1 (tags use the REAL editor name — `ui/src/tuneState.js:21-22`) stays satisfied; update
   that comment to record the 2026-07-26 rename, don't delete its history.
   **One-source for the layer name (rules-checker T3 catch, 2026-07-26):** the class-layer
   label exists in TWO independent literals today — `tuneState.js:26` AND
   `useResolvedRoute.js:51` (`class: "hardware class default"`, which had ALREADY drifted
   from the badge's wording, proving the copy hazard). Converge them: export
   `CLASS_LAYER_LABEL = "PC class config"` from `tuneState.js` and use it in BOTH
   `TUNE_BADGES.class.label` and `RESOLVED_SOURCE_LABELS.class`
   (`useResolvedRoute.js:48-55` — its own comment :43-47 already demands one-source for
   layer vocabulary; extend that comment to note the label now imports from the badge
   family's home).
2b. **The bare "class config(s)" shorthand converts too** (QC-1: no invented shorthand —
   one vocabulary): every user-visible "class config"/"class configs"/"class default"
   becomes "PC class config(s)". Known sites beyond the main list (each hand-read):
   `LuMeasureHistory.vue:73` (confirm message) and `:127` (title),
   `LuGlobalSwitches.vue:94` ("Your class configs and saved machine tunes are not
   touched."), `TuneMeasureModal.vue:344` ("Couldn't save the class config.").
3. **Floors visible on every chat-model catalog row**: the size/meta line gains
   ` · needs ~X GB VRAM + Y GB RAM` (existing `gb()` formatter for both numbers; only when
   both `m.minVramMb` and `m.minRamMb` are present; embedding rows EXCLUDED — they keep their
   placement story). Requirements are stated as RAW numbers, never class keys (class bands
   round DOWN, which is safe describing a PC but overstates describing a requirement).
4. **FIT hover says "estimated"**, and untuned non-embedding rows additionally say
   "not yet tested on your PC class" (untuned = `tuneBadgeOf` returns ""). **Branch-exact
   (rules-checker T5 catch):** the "Estimated —" prefix and the not-tested suffix apply ONLY
   to the needs-VRAM branch (`fitTitle`'s final return, `LuModelCatalog.vue:274-275`). The
   `cpu` (:271), `unknown` (:272), empty (:273) and embed-placement branches stay EXACTLY as
   they are — they are already whole sentences, and appending would splice a fragment
   against Ruling 6.
5. **The class panel lists EVERY chat model under each class.** Config'd models exactly as
   today. The rest behind one collapsed line — `N more models — not tested on this class` —
   expanding to `<Model name> — no switches` + an **Add switches** button that opens the
   EXISTING config editor prefilled with (model, class). No floors in the panel lines (keeps
   this pass free of any wire change). Embedding models excluded (CPU-placed by policy — a
   VRAM-class listing would mislead). **The embedding predicate is CLOSED (rules-checker
   T3/T4 catch):** use the shared singleton's strict flag — `useCatalogMeta().embeddingById`
   (`ui/src/composables/useCatalogMeta.js:30-36`, the one source whose comment records why
   the /embed/i name-guess was retired) — imported into `LuClassTunes.vue`; the same strict
   semantics the catalog itself uses (`LuModelCatalog.vue:307`). Do NOT add a local flag, a
   name regex, or a new fetch; the earlier STOP-if-absent branch is DELETED — the fact is
   available. (`QuickSetup.vue:88` / `LuBookSearchSetup.vue:70` keep their wider regex
   fallback untouched — out of scope.)
6. **The stale Recommended tooltip is rewritten** — `LuModelCatalog.vue:1039` still
   describes the curated hardware-class map DELETED 2026-07-22 (`seed.py:458-462`).
7. **English inline** (the §23 precedent: kit is 0% translated, vue-i18n batch comes later;
   whole-sentence messages per Ruling 6 — never splice fragments).

## NOT in scope (parked by the user's "dont over engineer" — do not build)

No schema or server or wire change of any kind. No provenance (measured/starter) column, no
empty-delta rows, no parent config entity. No §9/recommendation-logic change
(`modelPick.js`/`model_tunes_api.py` untouched). No rename of "Global launch defaults",
"Load as default", "Auto-tuned", "Hand-tuned", or "Untuned". No EZ measurement. No change to
`classKeyLabel`/`classKeyRangeLabel` logic (labels ride them as-is).

## Touch list (verify each site by reading it before editing; all in `just-llm-runner` unless marked JW)

Exact strings are NORMATIVE; surrounding-comment updates go wherever the old name would
become a lie.

1. `ui/src/tuneState.js:26` — `class` badge label → the new shared
   `CLASS_LAYER_LABEL = "PC class config"` const (closed decision 2, one-source). Update the
   QC-1 comment (:20-22) to record the rename and that tag = editor name still holds.
1b. `ui/src/composables/useResolvedRoute.js:51` — `class:` value → the imported
   `CLASS_LAYER_LABEL` (from `../tuneState.js`); extend the one-source comment (:43-47).
2. `ui/src/components/LuModelCatalog.vue`
   - :400-414 `tuneBadge()` — the `class` title →
     `"No applied config on this PC — launches start from the PC class config for your class (<range>)"`,
     where `<range>` is `classKeyRangeLabel(tuneState.value.classKey)` (add the import from
     `../classTunes.js`; the LABEL keeps the short `classKeyLabel` append at :412-414 —
     the user's standing B-short call, comment block :406-411 updated to match).
   - `fitTitle()` — per closed decision 4: the final needs-VRAM return (:274-275) ONLY
     gains the "Estimated —" prefix and, when the row is untuned
     (`tuneBadgeOf(tuneState.value, m.id) === ""`), the ` · not yet tested on your PC class`
     suffix; the :271 (cpu), :272 (unknown), :273 (empty) and embed-placement branches are
     UNTOUCHED.
   - the size/meta line (`rowMeta`, :294-298, and its template cell) — append
     ` · needs ~X GB VRAM + Y GB RAM` per closed decision 3. The cell's
     `title="Download size"` (:1047) is falsified by the addition — retitle it
     `"Download size, and the minimum hardware it runs on"`.
   - :1042 comment ("Auto-tuned / Hand-tuned / Class default") — update to the new badge
     vocabulary; same for the matching list in `TuneMeasureModal.vue:504`.
   - :1036-1040 — Recommended tooltip →
     `"What Quick Setup would pick for this machine — a model with a PC class config for your class first, then the speed-floor rule"`.
3. `ui/src/views/ProviderForm.vue` — :438 button → `PC class configs…`; :442 modal title →
   `PC class configs — the library`. Caption :440 — hand-read; keep "per-PC-class starting
   points" (already correct vocabulary).
4. `ui/src/components/TuneMeasureModal.vue` — :90 group label → `PC class config`;
   :543 link → `PC class configs ↗` (harmonize its :542 title text); :601 popup title →
   `` `PC class configs — ${model.name || model.id}` ``. Hand-read the running sentences
   near :584-588 and any other visible "Hardware/model class" / "hardware class" strings in
   this file and convert each in place (no blind replace).
5. `ui/src/components/LuGlobalSwitches.vue:126-127` — the sentence → "… a PC class config
   or an applied config overrides them per value."
6. `ui/src/components/LuClassTunes.vue`
   - Sweep every USER-VISIBLE "hardware class" → "PC class" (panel intro, dialog messages
     like the remove-class confirm at :199, aria/titles), each site hand-read.
   - NEW (closed decision 5): under each class card, after the configs table (:419-428), the
     collapsed not-tested line + expansion. The model list is already loaded (:62,
     "catalog rows … the Add-config picker"); untested = catalog chat models minus
     `configsByClass[c.classKey]` model ids; embedding exclusion via
     `useCatalogMeta().embeddingById` per closed decision 5 (predicate CLOSED — no
     discovery, no STOP branch). "Add switches" opens the existing editor prefilled with
     (model, class) — reuse the existing add/edit flow functions; read them first.
7. Whole-kit sweep (pattern WIDENED per the rules-checker T5 catch — the narrow "hardware
   class" grep structurally missed the bare-shorthand sites in 2b): case-insensitive
   `hardware[ /-]?(model )?class|class (default|config|tune)s?` over `ui/src` — every
   USER-VISIBLE remaining string converted to the "PC class config(s)" vocabulary; comments
   referencing history may stay when clearly historical (dates/QC numbers), but any comment
   describing CURRENT copy must match the new copy. Report a per-site table:
   file:line → old → new → (visible|comment|historical-kept).
8. JW docs (T11, repo `E:\Dev\Web\justwrite-app`):
   - `docs/models.md` — rename mentions; describe the floors line and the not-tested
     visibility in the models-surface section (hand-read the section first).
   - `docs/ARCHITECTURE.md:198` — the section headed "### Model class defaults"
     (rules-checker T11 catch: the narrow grep never saw it). Rename the heading + update
     its body to the new vocabulary; hand-read the whole section first.
   - Re-derive the LIVE-doc list with the widened item-7 pattern over BOTH repos' `docs/`
     roots: update any other live doc the rename falsifies; historical plan docs stay
     untouched (they are records) — list what the grep found and what was left as
     historical in the report.
   - `docs/plans/2026-07-22-igpu-research-and-cpu-band-recovery.md` — append **§24**, full
     prose (what changed · why · file:line · how verified · what would reverse it · OPEN),
     including the per-site rename table and the decision lineage above.
   - `docs/TASKS.md` — find item #214 (the chip-wording question), read its format, mark it
     resolved by this change with a one-line pointer to §24; add the your-box look item for
     the new surfaces (the user's eyes remain the look gate).

## Verification (all mandatory; report honestly — passed/failed/skipped with output)

- Biome on every changed kit file (exit 0).
- JW vitest FULL suite from `E:\Dev\Web\justwrite-app` — FIRST grep JW tests with the SAME
  widened case-insensitive pattern as item 7 (`hardware[ /-]?(model )?class|class
  (default|config|tune)s?`) and update any pinned strings as part of the change (they pin
  the old copy deliberately; changing them is correct here — say so in the report). One pin
  is KNOWN in advance and in scope: `src/renderer/src/services/__tests__/resolvedRoute.test.js:139`
  (`expect(resolvedSourceLabel("class")).toBe("hardware class default")`) — touch item 1b
  changes that value to "PC class config"; update the expectation and its comment. Then run;
  expect the prior baseline 450 passed / 49 files ± the adjusted pins.
- `npm run build:vite` in JW — green.
- Runner pytest from `E:\Dev\Web\just-llm-runner` — prove the pass touched no Python
  behavior. Known-bad on this Windows box (do NOT wave anything else through):
  `test_hardware.py::test_pci_gpus_linux_lspci_name_match`,
  `test_lifecycle.py::test_ensure_model_ready_loads_then_returns` (pre-existing),
  `test_lifecycle.py::test_ensure_model_ready_raises_on_failed_load` (flaky).
- The sweep table from touch-list item 7.

## Hard constraints

- Branch `claude/book-layout-chat-history-ui-5yjjr9` in BOTH repos — verify with
  `git rev-parse --abbrev-ref HEAD` first; never switch or create branches.
- Touch ONLY the files in the touch list. Another session may hold uncommitted/untracked
  files (e.g. JW `src/renderer/src/components/EntityIndex.vue`) — leave them alone.
- NO git commit, NO push, NO destructive git (no checkout --/reset/stash on tracked work).
- NEVER touch the live ports :1420/:17495 or the user's real data dir.
- Plain JS (no TS). Stop-don't-decide: any genuinely undecided question → STOP and report;
  do not improvise a decision.

## RISK

The rename may be pinned in tests or referenced in copy outside the enumerated sites — the
widened whole-kit sweep (item 7) and the JW-test grep are the guards. Second risk: the old
vocabulary appears mid-sentence in ways a blind replace would mangle — every site is
hand-read, never sed. Third risk: `RESOLVED_SOURCE_LABELS` phrases render mid-sentence in
the budget popover/Lab column — after switching :51 to `CLASS_LAYER_LABEL`, read one
consuming surface's sentence to confirm "PC class config" reads correctly in place.
