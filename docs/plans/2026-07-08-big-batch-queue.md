# The 2026-07-08 big batch — organization of the user's 52-item list (discussion first, then gos)

**STATUS: ORGANIZED, NOTHING BUILT.** The user dropped a 52-line list (verbatim below) with the
instruction "take your time to think about each one, many or related, organize them int working
items, we will need to discuss some in more detail". Rule #10 stands: no code until a per-batch
"go". The no-tests posture is ON for this stretch ("no testing for now, unless you need to …
i can test manually it eats to many tokens") — container gates (build/smoke) still run before any
ship unless the user waives those too; on-box behavior verified by the user manually.

This doc is the working queue for the batch (the providers-surface-redesign precedent: the design
doc carries the round queue; the outstanding ledger stays the strategic list). Every item from the
user's message appears exactly once in §3–§5, tagged with its source line number from §0.

---

## §0 — The user's list, VERBATIM (source of truth; numbering added for reference)

> no testing for now, unless you need to but it i can test manually it eats to many tokens. I have
> a big list of items, take your time to think about each one, many or related, organize them int
> working items, we will need to discuss some in more detail, take your time to think about them.

1. Online providers -- not saving api key
2. Providers, we need to be able to set a provider as default, for online providers when you set default it sets the tasks and features to that provider/model, for built in if models are already set as default, then apply, otherwaise let user know they need to select defuault models first manually or they can run quicksetup to do this, then set provider as defualt
3. Built-in provider card --change name from Built in server to Built-in provider
4. Built in provider card -- align run quick setup section to top
5. Built-in provider edit -- on the drop down chat embed select for my system dont we recommend an embed model, so for me qwen 3 .6b at least i thought we did. also leave the drop downs visivble so you can change it will just unload and load
6. Built-in provider edit -- make global launch and hardware class popup dialog edits instead of embeded,
7. Built-in provider updated engine doesn't delete previous engine
8. Built-in provider edit -- Local engine Installed · b9899 · cuda12 should have uninstall button
9. model on change and if embed model has not been loaded it says the same as it does not load on first search
10. model catalog -- above search model put a heading called Model Catalog
11. model catalog -- make the chat embed headers more pronounced maybe a highlight color so you now when you are viewing chat models, embed models, i think you already do it with doesn't fit header
12. edit model -- model card hyperlink doesn't work, missing Size(file) and Download size data, shouldn't this have been in seed data? Move read from link and its text above quant drop down and rename it Load model info from HF, make button different color from our system so it is more pronounced, remove just — no download end of the text info
13. tune and measure -- speculative decode switch is indented from the right, i don't know how you style elements but elements should fit container or container should grow, this seems to be a common problem you don't know how to place elements or use flex correctly.
14. tune and measure -- save tune button at top it does say saved for this pc but i think we need a toast or something so user really knows, thi is related to one of my questions in this list what does it do does it apply this or it is just
15. tune and measure -- also we need distinction about how the machine was tunned, from hardware presets, manually tune in tune and measure, auto tune, and tune should display in model grid, since this is model related correct? i guess we have hardware presets, but they are tied to a specific model, should they be, i thought hardware presets like you have are more machine, we need to discuss this again, remember we also have tasks and features that are per model
16. tune and measure -- removed save tune button need to be a different, i am not of fan of the plain ghost button its hard to see, maybe move it next to save button so you can see it. also tuned for machine label make it bigger.
17. tune and measure -- we have a tag at top when a model is successfully autotuned, lets have a flag that says tuned hardware defaults if it has a default, then the autotune if user runs that and overrides hardware defaults
18. tune and measure -- auto tune we need a ok/cancel dialog box working user this make take a long time 4-30 minutes depending on hardware. But should give better results for an untuned model.
19. tune and measure -- global defaults should be a link to the new popup edit control instead of embedded control
20. tune and measure -- send to task lab does open a new compare tab but is set as the first task i think it should be set to start fresh so user doesn't accidently update task as he is testing, this should be the default for any new compare tab start fresh
21. tune and measure -- when you click load and measure have it show process and result without having to scroll to bottom maybe make it a different row outside of switch scrolling row
22. hardware defaults says for all models but is it model specific?
23. what does the load and measure verse the fit do? does it set any switches like global?
24. model catalog -- how do we determine recommended for this pc? maybe if we have hardware default we use that also in catalog have tuned by hardware defaults or auto tune, what do you think?
25. tune and measure -- does tune and measure just inherit all switches from global and hardware defaults? this is the same for lab? this way whatever it type or add in tune and measure that is what is sent not re reading global or hardware defaults, correct?
26. tune and measure -- for model without hardware defaults you have button that says add to grid GPU layers 8 · Context size 131072 · CPU MoE layers 33, again i think we are doing to many different things, for tune nad measure that should be your source of truth and show all switches. we keep hiding things, tune and measure should inhere all switches from global + hardware, i think hardware override global, model overrides hardware and global, but you also have for hardware default models Anything not listed here uses the engine's own defaults and non hardware and fit info for non hardware, this is confusing we need to discuss how this works and priority, including lab it still feels a little confusing, what happens when i save tune, where does that go, per model, per task? how many places do we tune the llm system?
27. tasks lab -- when you save a preset the dropdown should change to the new preset.
28. task lab -- move add a feature to same line as feature in this task,
29. task lab -- the features in a task is one column, make it 2 and move the Preset & test line, preset and test against items to the second column
30. task lab -- the test input we are supposed to have a chapter selection here to fill the test with a chapter, also we should have sample button with some sample data we have in database, note since this lab is also share with jv which will have other test data beside books we need to have a way to use different test data since jv has game and podcast data not just chapters so think on how to do this
31. task lab -- same type of question i have asked about switches, we set the model in drop down model has hardware presets, but lab has no preset set even though task has model set, it is all related to how the global, hardware. model tune and measure, auto tune switches and data relate to each other
32. task lab -- we still have context_shift switch and others, again switch question we need to sync these up once we determine the flow, right now in the lab i have no idea what we are using currently as there is a disconnect between the tunning systems switches and lab
33. task lab -- by default once we determine the switch flow when you are in the lab any switches that we are currently using add have a value should be enabled in the lab, again dependent on the flow and how model relates that we decide.
34. task lab -- when i sent my config from measure and tune to task
35. task lab -- don't make a specific advance section in the switches, just all the switches that we are currently using one column
36. task lab -- no ai progress bar no task
37. providers tab -- we need a set as default engine so engine model selector drop down like in ask the book has the correct engine and model selected, only list one that have been tested and have a connection, or list them all but if not connected let user know when they select from drop down.
38. ask the book -- we have two ways to set engine and model a selector at the top and one at the bottom, i am not sure if we even want a provider model selector in the app besides what we have for task and feature
39. ask the book -- when i change the drop down to from ask the book to talk to a character it changes provider and model, i think we have a lot of old stuff not update since we have made changes to shared llm, we probably should audit jw
40. scene editor -- we also have a drop down to choose model, i think we should remove these and leave that settings to task and features section instead of individually.
41. scene editor -- we have an ai menu in the header, it would be nice to have this as a context menu, highlight a sentence right click and choose your ai action,maybe some other items on context menu as well
42. scene editor -- when you run an ai function on text it write the new text and you can accept or reject, if you accepts it leaves a strike through of the original text, this is good but we need a way to easily remove all strike throughs to clean up the chapter, maybe a button on menu, also maybe in read mode we dont show strike throughs, also maybe add as a an editor setting to enable disable creating strike through vs just replacing text when you accept, we have undo function.
43. scene editor -- every time an ai action competes we have a toast that show task complete, with view, 1 change the word for view to view task que, 1 can we move that from a toast to display on the scene edtiors bottom bar where word count and other info is displayed you can to the right of that info
44. feature lab -- we have inputs like character name and profile to fill in manually which is fine, but shouldn't we be also able to just select a character in a book? this concepts of being able to select chapters, characters etc. to test against. is it too much or too difficult, since it is shared it need to work with jv features as well? i am not sure how you designed the shared llm features for these types of things,
45. ask the book -- when i do the ai progress bar calls it Ask the manuscript instead of Ask the book
46. ask the book -- change new thread to new chat, and we need a delete chat
47. main nav bar -- make ask the book bigger or bolder or in color something to make it stand out more
48. feature lab -- in the nav the features the task associated with each feature is sort of listed twice it is listed twice but some names are slightly different.
49. ai - during our tunning we decided setting streaming on for ones that take a lot of time is better for user, maybe just leave streaming as default setting, think this is a param, but then we need to parse the stream which i don't think we currently do, so we need to parse both ways streaming on streaming off. don't think we even have this a a param
50. check llama.cpp https://github.com/ggml-org/llama.cpp/pull/25348, this might help our ai progress system
51. how do we handle tunning for online and should we, we probably should but just the samplers, even for local openai still just samplers, think about this as well.
52. scene editor -- allowing user to customize context menu and the editor menu would be a nice feature in the future. speaking of future stuff we have some roadmaps we need to clean those up with what we have implemented and not and start a new one and customize menu to it,

---

## §1 — The grounded system truth (verified this session, file:line) — the answers the discussion builds on

This section answers the user's direct questions (#14b, #22, #23, #24, #25, #26's questions, #31,
#5a, #51) from code read 2026-07-08. Nothing here is from memory.

**1a. There are exactly TWO live tuning planes today — plus one DEAD one causing all the confusion.**

- **Plane 1 (launch switches — need a model load):** resolved PER MODEL at load by
  `llm_runner/llm/switch_resolve.py` (docstring lines 9–14 + code 79–107). Layer order, later wins:
  **base bundle (`all`) → the model's TYPE bundle (`moe`/`dense`) → the gated auto-MTP bundle →
  the hardware-CLASS tune (`class_tunes`, keyed (model, `vram<GB>|ram<GB>`)) → THIS machine's saved
  tune (`model_tunes`, keyed (model, machine))**. That is exactly the priority the user articulated
  in #26 ("hardware override global, model overrides hardware and global") — global bundles →
  class → this machine. Anything no layer sets falls to llama-server's own defaults, and the fit
  engine computes `ngl`/`n_cpu_moe` at load when nothing overrides them. The live load path and the
  Tune modal's pre-fill use the SAME resolver keyed to this machine (`install.py:182-189` — the
  "seen = run" invariant), and per-row provenance (which layer wrote each value) is already
  returned (`resolve_model_switches_with_origins`).
- **Plane 2 (request params — per call, no reload):** owned by the TASK's preset via the Plan-A
  cascade task → global default (`preset_resolve.py:21-33`). A preset (`db.py:494-514`) carries
  provider + model + temperature/top_p/max_tokens/json_mode/reasoning_effort, plus long-tail
  samplers (`engine_preset_samplers`). At run time `prompts.py:346-399` merges samplers per-call →
  stored per-action → preset (lowest), and think is forced off under json (`prompts.py:416-424`).
- **The DEAD plane (the disconnect the user feels in #26/#31/#32/#33):** presets ALSO store frozen
  Plane-1 switches (`EnginePresetSwitch`, `db.py:517-527`) and `ngl_override`/`n_cpu_moe_override`
  columns (`db.py:511-512`) — and **nothing anywhere applies them**: not the production load
  (grep: only `stores.py`/`db.py`/`seed.py` reference them), not the Lab's own test runs
  (`ConfigColumn.vue:292` — "Plane-1 switches are NOT sent"). The Lab still shows an editable
  "Engine switches — Plane-1" section (`ConfigColumn.vue:422-430`, where `context_shift` lives,
  #32). So the Lab edits launch switches into a store that no execution path reads. This is
  structural, confirmed twice, and it is the root of "I have no idea what we are using currently".

**1b. Direct answers.**

- **#22 — "hardware defaults says for all models but is it model specific?"** Model-specific:
  `class_tunes` rows are keyed **(model_id, class_key)** (`db.py:294-308`). The "— all models"
  suffix the user saw is the cross-model LIBRARY view's header (`LuClassTunes.vue:215`,
  `globalMode` only — the Built-in Edit view mount) listing every model's class rows; the copy is
  ambiguous and should say "library" not imply one tune covers all models. In the Tune modal the
  same component is mounted per-model (`TuneMeasureModal.vue:387`).
- **#23 — "what does load and measure verse the fit do?"** Load & measure (`TuneMeasureModal.vue:244-261`)
  POSTs `/v1/llm-runner/load` with EXACTLY the grid's switches, then `/v1/llm-runner/measure` for
  tok/s, and records a measurement-history row. It **persists no switches** — it's a trial run.
  Fit is the calculator that fills `ngl`/`n_cpu_moe` at load when no layer set them; the grid shows
  fit-computed values as chips and "Add to grid" makes them explicit editable rows
  (`TuneMeasureModal.vue:55-56, 377`) — deliberately NOT auto-saved so Save tune can't freeze
  today's fit by accident (the strict-beat rule).
- **#14b/#26 — "what does Save tune do / where does it go?"** Save tune persists the grid VERBATIM
  as `model_tunes` rows for (this model, this machine) (`TuneMeasureModal.vue:8-9`, `db.py:273-287`).
  It is the WINNING layer at every subsequent load of that model — for every task/feature (launch
  config is per model, never per task). It does NOT hot-apply to an already-resident model; the
  next load uses it.
- **#25 — "does tune and measure inherit global + hardware? grid = what's sent?"** Yes and yes:
  the grid pre-fills from resolved-defaults = base→type→mtp→class→machine for THIS box
  (`install.py:182-189`), and Load & measure sends the grid verbatim (1b above). For the LAB the
  answer is currently NO — that's the dead plane (1a); fixing it is discussion A.
- **#31 — "lab has no preset set even though task has model set".** The Lab column's model
  dropdown and the task's preset are separate objects today; the column seeds switches/samplers
  from the picked MODEL (`ConfigColumn.vue:96-110`), not from the task's resolved preset. Same
  root as 1a-dead-plane; folded into discussion A.
- **#24 — "how do we determine recommended for this pc?"** Already exactly what the user suggests:
  `recommendedModelId` (`modelPick.js:99-118`, ONE source used by both QuickSetup and the catalog
  badge) consults the **class→model map first** (largest `minVramMb` ≤ this box's VRAM whose model
  exists + fits), falling back to the §10 quality-rank + fit-tiebreak pick. The second half of #24
  (show "tuned" provenance badges in the catalog) is new work → batch 3/A(c).
- **#5a — "don't we recommend an embed model?"** Yes — QuickSetup auto-picks the best-fitting
  embedding (lowest quality-rank among fitting embeds, editable dropdown; `QuickSetup.vue:109-113`,
  wired always-on via routing). The gap is the Built-in EDIT view: the inline pickers appear only
  on EMPTY slot cards (#144) and don't preselect a recommendation → batch 2 item.
- **#51 — online tuning.** Already samplers-only by construction: launch switches exist only for
  the built-in engine; presets carry provider-agnostic request params + samplers (1a Plane 2). What
  remains: (a) the Lab hides its launch-switch section for online targets only implicitly via the
  dead plane — after A it shows launch info only for the built-in; (b) OPEN question worth a
  later pass: per-provider sampler capability (e.g. OpenAI's API rejects `mirostat`) — adapters
  should drop unsupported keys; not yet audited.
- **#50 — llama.cpp PR 25348** (fetched 2026-07-08): merged 2026-07-07; adds `return_progress` +
  `timings_per_token` to the `/responses` endpoint, **mirroring what `/chat/completions` already
  has** — i.e. our pinned llama-server can already stream `prompt_progress` frames (prompt-eval
  progress) + `timings` on the endpoint we actually use. Directly useful: the TTFT dead-zone in
  our AI progress UI can become a real percent bar. → batch 6 / discussion D.

**1c. Bug root-causes found while grounding (no fixes applied — rule #10).**

- **#1 API key not saving:** `ProviderForm.vue:44` — new providers default `local = true`; and
  `:122` — a local provider sends `apiKey: null`; the PATCH handler treats null as CLEAR
  (`provider_api.py:181-182`: `"" preserves; None clears`). So an online provider created/edited
  while the where-it-runs toggle sits on the default "Local · free" silently drops its key. Fix
  direction (discuss in batch 1): derive local from provider type for the known online types
  (anthropic/gemini/openai/deepseek/openrouter → online), and never force-null the key merely
  because local=true.
- **#7 engine update leaves the old build:** the replace logic EXISTS and is stop-first with
  models.ini carry (`lifecycle.py:803-844`, ships warnings "old engine build … still present
  (files in use?)"). Suspected Windows exe-lock survival on the user's box → needs the box's
  engine/server log line before any code change (candidate hardening: delayed retry sweep on next
  boot). Box-evidence item.
- **#12a model-card hyperlink dead:** the links are plain `target="_blank"` anchors
  (`LuModelCatalog.vue:703, 785`) — in the Tauri webview external links don't open (JW policy:
  `window.justwrite.shell.openExternal`; kit is host-agnostic). Fix: a kit-level configurable
  "open external" hook (configureHelp precedent), JW wires it to the bridge; browser falls back to
  `_blank`. Works in `vite dev`, dead in the desktop app — matches the user's report.
- **#12b Size(file)/Download size missing:** the seed mapper supports `size_label`/`size_bytes`
  (`seed.py:546`) but the seeded catalog rows don't carry values, and the Edit dialog shows "—"
  until a Read-from-link/download fills them (`LuModelCatalog.vue:827-830`; also `:351-352` clears
  sizeBytes on quant change by design). Per the seed principle (seed ships FACTS), the pinned
  quant's file size IS a fact → bake real sizes into every seeded row (fetch once from the HF API
  during the build of the seed change; cite per row).
- **#45 "Ask the manuscript":** `ChatPanel.vue:250` (task label), `:341` (aria-label), `:344`
  (eyebrow). Copy fix. **#46 "New thread"**: `ChatPanel.vue:393`. **#39 mode-switch changes
  provider/model:** NOT a leftover bug — book vs character are different features → different
  task presets → possibly different provider/model (Plan A working as designed); the perceived
  noise feeds discussion B (kill in-surface pickers). The "audit JW for stale pre-shared-stack
  surfaces" remains a real sweep item (batch 5).
- **#3 "Built-in server" name:** it's the seeded provider NAME (`seed.py:95` "Built-in server —
  llama.cpp") + one health string (`llm/api.py:78`). Existing DBs keep their row name (recorded
  precedent from the last rename) — the user's box needs a reseed or a targeted name-refresh for
  seeded built_in rows; decide in batch 2.
- **#48 feature-lab nav double listing:** the nav groups actions under a display `group` header
  and each action carries its task provenance (`FeatureWorkbench.vue:4-9, 58-94, 248-251`) — the
  group label and the taskKind label are near-duplicates with drifted names. Fix direction:
  one-line-per-fact (group header OR per-action task tag, not both when identical) + reconcile
  the two label sources; exact template rows at build time.
- **#36 lab runs show no progress/task:** JW's AiView test hook DOES wrap the stream API with a
  task label (`AiView.vue:23`); the user's report suggests the Lab path that runs a column test
  (ConfigColumn → `/v1/ai/run` direct) bypasses task registration. Verify at build; make every
  lab run register in `useAiTasksStore` like production runs.

**1d. Streaming reality (#49).** Streaming infra EXISTS end-to-end: server `/v1/ai/stream`
(`prompts.py:514`), kit `runAiFeatureStream` (accumulates deltas, registers a task, returns the
full text — i.e. "parse both ways" already: onDelta live + final parse). USED by the writer editor
actions (`writerAI.js:128,169,186`) and the Lab test hook (`AiView.vue:23`). NOT used by ~16
call-sites: the analysis suite, brainstorm, sessionRecap, stuckDiagnostic, sensoryResearch,
resumeBriefing (`runAiFeature(` grep, 2026-07-08) — mostly JSON-mode features. There is NO stored
per-task "stream" flag — the caller picks the endpoint. Design in discussion D.

---

## §2 — DISCUSSION AGENDA (blocked on the user; nothing here is decided)

**A. THE tuning-flow consolidation (settles #14b/#15/#22/#23/#25/#26/#31/#32/#33/#35 + halves of #17/#24).**
Current truth in §1a. My recommendation (pushback welcome):
1. **Confirm the rule that already runs the system: launch config is owned by the MODEL tune
   stack (global bundles → class → this machine), full stop.** It matches the user's own priority
   statement in #26 and the one-profile A/B verdict (2026-07-06: per-task differences live at the
   request layer — the think flag — not in launch profiles).
2. **Delete the dead plane:** drop `EnginePresetSwitch` + `ngl_override`/`n_cpu_moe_override`
   storage/UI (schema + seed + Lab "Engine switches" section incl. `context_shift`), since nothing
   applies them (§1a). The Lab column instead shows a READ-ONLY "launch config this model runs
   with" panel fed by resolved-defaults + provenance tags, linking to Tune & measure ("tune it
   there"). One truth, no sync problem — #32/#33 dissolve instead of being synced.
3. **Tune & measure becomes the single launch-config surface and shows ALL switches** (the user's
   #26 ask): the grid lists every catalog knob with its resolved value + origin tag (base / type /
   auto-MTP / class default / your tune / fit-computed / engine default), not just the layers'
   explicit rows. "Add to grid" disappears as a concept (everything is already a row; editing a
   fit-computed or engine-default row just creates your machine-tune override).
4. **Provenance display (#15/#17/#24b):** one "tuned" badge family everywhere — Tune modal header
   (Hardware-class default / Auto-tuned / Hand-tuned / Untuned), the models grid column, and the
   catalog row tag. Data already exists (origins + `model_measurements.source` for autotune-vs-
   measure; class rows built_in flag).
   Open sub-question for the user: exact badge wording + which surfaces get which badges.
5. After 1–4, the answer to "how many places do we tune?" is exactly TWO: **Tune & measure** (per
   model, launch) and **Tasks/Lab presets** (per task, request params + samplers). Docs
   (`docs/models.md`) updated same change.

**B. Provider default + killing per-surface model pickers (#2/#37/#38/#39/#40).**
Current: no provider-level default exists; tasks own provider+model via presets; Ask-the-Book has
pickers (top + bottom), the scene editor has one, mode-switch rebinds visibly (#39, by design).
My recommendation: (a) **remove in-app per-surface model pickers** (Ask the Book, scene editor) —
surfaces show a read-only provenance chip ("runs on: Interactive chat → <preset model>") linking to
the Tasks tab (this matches the #111 decision that removed the per-task change line from
QuickSetup copy). (b) **Add "Set as default provider"** on a provider row implementing EXACTLY the
user's #2 semantics: online → repoint every task preset (and the global default row) to that
provider + its default model (one bulk write, undoable via reseed of presets? — discuss the undo
story); built-in → require assigned default chat model first, else offer "pick defaults manually or
run Quick Setup", then apply. (c) #37's "only tested/connected in dropdowns" mostly dies with the
pickers; where a picker legitimately remains (Tasks tab), annotate not-connected providers instead
of hiding them.
Open sub-questions: does "set default" also flip the EMBEDDING routing when the provider has an
embedding model? What happens to per-task models the user hand-picked (clobber-with-confirm vs
skip-customized)? (The D4 QuickSetup-clobber discussion is precedent.)

**C. Lab test data from the host app (#30/#44).**
The labs are kit views; chapters/characters are JW domain (JV: game lines, podcast segments). The
kit already takes host adapters (configureHelp precedent; feature catalog is host data by charter).
Recommendation: a kit **test-data source registry** — the host registers named sources
(`{ id, label, kind, list(), fetch(id) → {variables} }`); the Lab input panel shows "Insert from
<source>" pickers + a "Sample" button; canned per-taskKind samples ship in the DB (seeded,
editable), satisfying "sample data we have in database". JW registers chapters/characters/locations;
JV later registers its own. Feasible, moderate size, no JV blocker (registry empty = manual fill,
today's behavior).

**D. Streaming as the default + progress (#49 + #50/#36).**
Facts in §1d + the PR note in §1b. Recommendation: (a) add a per-task **stream** flag on presets
(default ON for free-text tasks, ON-with-end-parse for JSON tasks — runAiFeatureStream already
accumulates and returns the final text, so JSON parses at completion; deltas drive progress only);
(b) flip the ~16 non-stream call-sites to the stream wrapper honoring the flag; (c) wire
`return_progress: true` into the local-runner streaming calls and surface `prompt_progress` (the
prompt-eval %) in AiTaskStrip/AiStatusPanel — the TTFT dead bar becomes a real percentage on the
built-in engine (b9899's /chat/completions already supports it; the PR extends the same to
/responses which we don't use). Cloud adapters just skip the field.
Open sub-question: stream default ON for everything, or per-taskKind seeded choices?

**E. Online/sampler-only tuning (#51).** Answered in §1b — already samplers-only by construction;
after A the UI stops implying otherwise. Remaining follow-up worth its own small item: per-adapter
sampler-capability filtering (drop `mirostat`-class params the API would reject) — needs a
per-provider capability audit before building. Park until A ships.

**F. Roadmap refresh (#52b).** The outstanding ledger (sections A–I) is the accurate open-work
list; the old roadmaps are bannered historical. Proposal: ONE user-facing `ROADMAP.md` (per repo or
just JW?) distilled FROM the ledger: shipped (one line each) / next / later, updated at ship-time
like docs/models.md. The "customizable editor/context menus" future item (#52a) becomes its first
"later" row. Needs the user's call on location + grain.

---

## §3 — WORK BATCHES (straightforward items; each gets its own go; no code until then)

**Batch 1 — bugs (kit/runner unless marked):**
- B1-1 (#1) API-key save: root cause §1c; decide fix shape (derive local from type + never
  null-clear on online), then fix + a regression test (user allowed tests for bug verification?
  no-tests posture — container pytest still fine).
- B1-2 (#7) engine-update old-build survival: WAITS ON BOX EVIDENCE (the log line) — then decide
  hardening (boot-time stale-sweep retry).
- B1-3 (#12a) model-card link in Tauri: kit openExternal hook + JW bridge wiring (§1c).
- B1-4 (#12b) seed real size facts for every catalog row (+ keep Read-from-link refresh).
- B1-5 (#27) Lab: saving a preset selects it in the dropdown.
- B1-6 (#36) Lab runs register as tasks (progress bar + queue entry) — verify path at build (§1c).
- B1-7 (#45) "Ask the manuscript" → "Ask the book" (3 spots, `ChatPanel.vue:250,341,344`). [JW]
- B1-8 (#48) FeatureWorkbench nav de-duplication (group header vs per-action task tag) (§1c).
- B1-9 (#9) CLARIFY with the user first — garbled: "model on change and if embed model has not
  been loaded it says the same as it does not load on first search". Best guess: the embedding
  model doesn't lazy-load on first search (Ask-the-Book/RAG ensureEmbeddingReady path?) and the
  error after changing models is the same unhelpful one. Need surface + repro.

**Batch 2 — providers & catalog UI (kit):**
- B2-1 (#3) rename seeded provider "Built-in server — llama.cpp" → "Built-in provider — llama.cpp"
  (`seed.py:95` + `llm/api.py:78`); existing DBs: decide reseed vs targeted refresh of built_in
  provider names.
- B2-2 (#4) Built-in card: align the Run-Quick-Setup section to the card top.
- B2-3 (#5) Edit view: chat/embed dropdowns ALWAYS visible (change = unload+load via the existing
  apply path) + preselect the recommended embed on empty (QuickSetup's pick, §1b #5a).
- B2-4 (#6) Global launch defaults + Hardware-class defaults become popup dialog editors
  (AppModal) instead of embedded blocks on the Edit view (`ProviderForm.vue:214,217`).
- B2-5 (#8) Local-engine row: Uninstall button beside "Installed · b9899 · cuda12" (backend
  exists: `lifecycle.py:460-467`).
- B2-6 (#10) "Model Catalog" heading above the search row.
- B2-7 (#11) Chat/Embedding section headers get the pronounced treatment (doesn't-fit precedent).
- B2-8 (#12c/d) Read-from-link: move above the quant dropdown, rename "Load model info from HF",
  distinct button color, drop the "— no download" tail (`LuModelCatalog.vue:801-802`).
- B2-9 (#2/#37) "Set as default provider" — AFTER discussion B locks semantics.

**Batch 3 — Tune & measure UX (kit; several depend on discussion A):**
- B3-1 (#13) spec-decode switch right-edge overflow/indent — fix with a container-fit pass over
  the tune grid (flex audit).
- B3-2 (#14a) Save tune → success toast (+ one-line "applies at the next load of this model").
- B3-3 (#16) "Remove saved tune" restyle (not ghost; sits beside Save), "Tuned for this machine"
  label bigger.
- B3-4 (#17 + #15/#24b) provenance badges (class-default / auto-tuned / hand-tuned) — modal header
  + models grid + catalog rows — per discussion A(4).
- B3-5 (#18) Auto-tune OK/Cancel confirm ("4–30 minutes depending on hardware; best for untuned
  models") via kit confirmDialog.
- B3-6 (#19) Global-defaults/class editors inside the Tune modal become links to the B2-4 popups
  (no embedded editing in the modal).
- B3-7 (#20) Send-to-Tasks-Lab opens a FRESH compare column (never pre-bound to the task); fresh
  = default for every new compare tab.
- B3-8 (#21) Load & measure progress/result pinned outside the scrolling switch area.
- B3-9 (#22-copy) class-library header copy: stop reading as "one tune for all models" (§1b #22).
- B3-10 (#26 build-half) the all-switches resolved grid + origin tags + "Add to grid" retirement —
  THE build of discussion A(3).

**Batch 4 — Tasks Lab layout (kit; after A):**
- B4-1 (#28) "Add a feature" inline with the "Features in this task" heading.
- B4-2 (#29) two-column layout: features left; Preset & test + test-against right.
- B4-3 (#35) no "Advanced" split — one column of the switches actually in use (post-A this is the
  sampler grid + the read-only launch panel).
- B4-4 (#30/#44) test-data sources + Sample button — the discussion-C build.
- B4-5 (#34) CLARIFY — the sentence ends mid-thought: "when i sent my config from measure and tune
  to task". Suspected: the sent config didn't land/show as expected in the compare column. Need
  the rest of the sentence.

**Batch 5 — JW app surfaces [JW]:**
- B5-1 (#38/#40) remove per-surface model pickers (Ask the Book top+bottom, scene editor) →
  provenance chip + Tasks-tab link — per discussion B.
- B5-2 (#39) JW stale-surface audit (pre-shared-stack leftovers) — sweep with findings-first
  (RULE-5 style decompose+table), fixes after review.
- B5-3 (#46) "New thread" → "New chat" + a delete-chat control (needs a small thread-list/delete
  model — today "New thread clears" `ChatPanel.vue:8`; decide: delete current vs a chat list).
- B5-4 (#47) nav prominence for Ask the Book (bolder/color treatment).
- B5-5 (#41) editor context menu: right-click a selection → AI actions (+ sensible non-AI items);
  header AI menu stays.
- B5-6 (#42) strikethrough (track-changes) management: clear-all-strikethroughs action; hidden in
  read mode; editor setting strikethrough-vs-replace on accept.
- B5-7 (#43) AI-complete notice: "View" → "View task queue", moved from toast to the editor bottom
  bar (right of word count).
- B5-8 (#52a) customizable context/editor menus — FUTURE ledger row, not this batch.

**Batch 6 — cross-cutting/infra:**
- B6-1 (#49) streaming per discussion D (flag + call-site flips + both-ways parsing note §1d).
- B6-2 (#50) `return_progress` prompt-progress in the local adapter + task strip % (needs D's (c)).
- B6-3 (#52b) roadmap refresh per discussion F.

---

## §4 — Items answered in place (no build unless the user disagrees with the answer)

- #22, #23, #24a, #25, #5a, #51, #14b, #31 — answered in §1b with file:line; the buildable halves
  are queued above (B3-9, B3-4, B2-3, B3-10).
- #39's "changes provider and model" — working as designed under Plan A (different feature →
  different task preset); the un-asked-for VISIBILITY of that is what discussion B removes.

## §5 — Needs the user (can't proceed without)

1. Discussions A–F above (A first — it unblocks batches 3+4 and dissolves four items).
2. CLARIFY #9 (garbled) and #34 (truncated) — exact surface + the rest of the sentence.
3. B1-2 needs the box's engine-log line for the leftover-build failure before any code.
