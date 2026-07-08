# The 2026-07-08 big batch — organization of the user's 52-item list (discussion first, then gos)

**STATUS: §7.1 DECIDED+BUILT · BATCHES 1+2 BUILT (see the B1 + B2 BUILD RECORDS in §3; B1-2 still
waits on box evidence; B2-9 waits on discussion B) · discussions B–F + batches 3–6 await their own
gos.** The user dropped a 52-line
list (verbatim below) with the
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

> ⛔⛔ **SUPERSEDED — this whole §2-A block (the original recommendation + A-REVISED + round-3
> "flow rethought") is the EXPLORATION that led to the locked answer. It is now stale in places
> (A-REVISED proposed making the Lab's switches LIVE; the DECISION went the other way — switches
> come OUT of the Lab entirely). Read `§7.1 — the switches ⇄ params flow (LOCKED)` at the bottom
> of this doc for what was actually decided 2026-07-08. Kept here for the reasoning trail only.**

> ⛔ **A-REVISED (2026-07-08, after the user's pushback — supersedes points 2–3 below; kept for
> the record).** The user, verbatim: *"i am confused so you are removing the setting engine
> switches in the lab? that does not make sense, that is the whole point of the lab, to be able
> to further tune what switches are correct, you choose provider and model and further test
> besides tune and measure is just very basic nothing really tuned."* The correction this forces:
> the defect was never "switches don't belong in the Lab" — it's that the Lab's switches are
> FAKE (stored, never sent, never applied). Revised proposal:
> 1. **The Lab's switch column becomes LIVE for built-in columns:** each Test first loads the
>    model with the column's switches — the exact call Tune & measure's Load & measure already
>    makes (`POST /v1/llm-runner/load {switches}`, `TuneMeasureModal.vue:255`) — then runs the
>    real prompt. Reloads (~8–12 s) are acceptable in a lab; show a "loading model with these
>    switches…" status. Online-provider columns show NO launch-switch section (cloud APIs have
>    none — this also closes #51's UI half): samplers only.
> 2. **Saving splits by plane, each to its one true store:** the winning LAUNCH switches save to
>    the MODEL's tune (`model_tunes` — the same store Save tune writes; optional "save as
>    hardware-class default"), and the winning provider/model/samplers/max-tokens/JSON/think save
>    to the TASK's preset. The preset NEVER stores launch switches again (the dead
>    `EnginePresetSwitch`/`ngl_override` storage still gets deleted) — that dead storage is what
>    made "which one is applied?" unanswerable.
> 3. **Division of labor, stated in the UI:** Tune & measure = the quick SPEED bench (fit, tok/s,
>    autotune sweep, save) — deliberately basic; the Lab = the FULL bench (same launch switches,
>    live this time + real task prompts + output quality + side-by-side compare). Both write
>    launch results to the same single store, so production still has exactly ONE saved launch
>    truth per model (+ machine), and the Send-to-Lab carry (#34/B4-5) becomes a real, fixed
>    path: grid → live column switches → test → save back to the model tune.
> 4. Open sub-points for the user: (a) should Lab test loads also record into the measurement
>    history (they can, same seam as Load & measure)? (b) after a Lab test loads trial switches,
>    the resident model is running THOSE switches until its next production load — acceptable
>    (next real request reloads per the saved truth via the arbiter/ensure path), or should the
>    Lab offer "restore saved config" on exit?
> Points 1, 4, 5 of the original recommendation below stand unchanged (one resolved grid with
> origin tags in Tune & measure, provenance badges, two-owners answer).

> ⛔ **A — THE FLOW, RETHOUGHT END-TO-END (2026-07-08, third round; the user's scenario
> verbatim):** *"I use quicksetup it sets my provider and models for my tasks and features. I
> then tune my default model and save. No i go look at task a, it has my provider and model set
> per quick setup but what about the switches are they updated from the save on tune and
> measure, how does the user know, i still see a big disconnect."*
>
> **The scenario traced through the real code:** (1) QuickSetup repoints every task preset's
> `.model` to the pick (`QuickSetup.vue:19` — only `.model` changes) + sets routing default +
> embedding. (2) Save tune writes `model_tunes` (model, THIS machine). (3) Task A RUNS: dispatch
> resolves the preset → provider gemma + the model id; the runner load asks the ONE resolver
> (`install.py:182-189` → `switch_resolve`) which includes the step-2 tune → the process spawns
> with the tuned flags (`lifecycle.py:602`). **So the tune DOES reach task A — automatically,
> because the preset stores a POINTER to the model and the model brings its launch config
> wherever it's pointed. Nothing is copied into the task, so nothing can go stale in the task.**
> The task page just never SHOWS this (and worse, shows the dead editable switches instead) —
> the disconnect is real but it is a VISIBILITY defect, not a wiring defect.
> **One honest wrinkle found while tracing (new):** an already-resident model is deliberately
> NOT reloaded by a plain re-request (`lifecycle.py:501-504` — idempotent keep-warm), so a tune
> saved while the model is loaded takes effect only at the NEXT load (idle-sleep ~30 s → next
> use, or explicit unload). Proposal to close it: the ensure-load path compares the resolved
> config against the flags the resident process was spawned with and respawns on mismatch
> ("active = resolved, enforced"), plus the Save toast says "applies at the next load" either way.
>
> **The design law (one breath):** a TASK answers "which model, and how do I ask it" (preset:
> model + samplers/max-tokens/JSON/thinking — per request, no reload). A MODEL × THIS MACHINE
> answers "how do I launch" (global bundles → class default → your tune — resolved ONCE, at
> load). The only moment launch switches become ACTIVE is a model load, and every load asks the
> same resolver. The Lab is the bench where BOTH are exercised (live trial switches per column +
> real prompts), and its saves route by kind: launch → the model's tune; ask-style → the task's
> preset.
>
> **The visibility contract (the actual rethink — every surface shows the same resolved truth):**
> - **Tasks tab (task A's page):** the dead switch grid is REPLACED by a live read-only "Runs
>   on" panel: "gemma-x on Built-in — launches with: [resolved rows, origin-tagged global /
>   class default / your tune / computed] — Tuned on this PC 2026-07-08 · Tune this model →".
>   After the user's step 2, task A's page VISIBLY shows the tuned rows tagged "your tune" —
>   the propagation the user asked about becomes something you can see.
> - **Tune & measure:** header scope line "these launch settings apply to EVERY task that uses
>   this model on this PC"; Save toast repeats it.
> - **Lab column:** trial switches clearly labeled "this column's trial only — not saved", next
>   to the same "Runs on" panel showing what production would use; two explicit save targets.
> - **Global launch defaults / class library:** unchanged as editors; their values appear as
>   the origin tags everywhere else, so the chain global → class → tune → running process is
>   inspectable from any surface, always through the one resolver.
> The flow table (SET where / SEEN where / ACTIVE when): global bundles — Global-defaults
> editor / origin tags everywhere / at load, lowest layer. Class default — class library /
> origin tags + Tune header badge / at load, middle. Your tune — Tune & measure or Lab-save /
> origin tags + "Tuned" badges (grid, catalog, task panel) / at load, wins. Task preset — Tasks
> tab + Lab save / the task page + feature chips / per request. Lab trial — the column / the
> column only / during that test's load only.

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
- B1-9 (#9) RESOLVED by the user 2026-07-08 ("lazy load embed"): the embedding model must
  LAZY-LOAD on first use — first search loads it instead of erroring, and changing the embed
  model loads the new one on the next search the same way. Work item: the search path (RAG /
  Ask-the-Book ensureEmbeddingReady chain) triggers the load + shows a loading state; the
  unhelpful identical error goes away as a consequence.

**B1 BUILD RECORD (2026-07-08, the user's bare "go" after the §7.1 ship — read as "the next
buildable unit in the queue", which is this batch; B1-2 deliberately excluded, it still waits on
the box's engine-log line).** Everything grounded in current post-§7.1 code before touching it;
inline T1–T12 citations preceded each first edit per the "do b" checker discipline; ONE
consolidated gate pass at batch end per the no-tests posture.

- **B1-1 built.** The root cause held exactly as recorded in §1c against current code
  (`ProviderForm.vue:44` new-provider `local=true` default; `:122` `apiKey: local ? null : …`;
  `provider_api.py:181-182` None clears) — plus one aggravator: the key FIELD only renders when
  the toggle reads Online (`:166`), so a mis-flagged row could silently wipe its key on every
  save with no key field even visible. Fix shape as recorded: a new
  `ONLINE_ONLY_TYPES` set exported beside `PROVIDER_PRESETS` in `useProviderConnect.js` (the
  kit's one source for known-provider facts) — anthropic/gemini/openai/deepseek/openrouter;
  `openai-compat` + `ollama` deliberately absent (both genuinely run local OR remote — the
  presets themselves carry both flavors of openai-compat: LM Studio local, OpenRouter online).
  `ProviderForm` gains `lockedOnline` + `isLocal` computeds: known-cloud types render the
  where-it-runs row as a LOCKED "Online · metered" pill (the `isBuiltin` locked-pill precedent)
  and self-heal a row mis-saved local; the save body sends `local: isLocal` and **never sends
  the null clear-sentinel on edit** (`apiKey: draft.apiKey || (isNew ? null : "")`) — the form
  has no explicit remove-key affordance, so it must never clear one implicitly. The server
  contract (""=preserve · None=explicit clear) is UNCHANGED and now locked by
  `tests/test_provider_api.py::test_patch_apikey_empty_preserves_even_when_local_flips`. Honest
  note for the box: a key that was ALREADY wiped by the old bug is unrecoverable — re-enter it
  once; the form now shows the key field for the healed row.
- **B1-3 built.** New kit seam `common/services/external.js` — `configureExternal({open})` +
  `openExternal(url)` (mirrors the configureHelp/configureDialog boot-config precedent;
  unconfigured fallback `window.open`). ALL kit external anchors route clicks through it
  (`@click.prevent`, href kept for copy-link/a11y): the catalog row "Model card ↗" + the footer
  "Hugging Face ↗" + the edit-dialog "model card ↗" (`LuModelCatalog.vue`) and the
  "llama.cpp releases page ↗" (`LuRunnerBinaries.vue`); `HelpDrawer.onContentClick` gains an
  external branch (rendered help-doc links were equally dead — `helpMarkdown.js:45` stamps
  `target=_blank`). JW converges its TWO pre-existing inline bridge-aware copies onto the seam:
  `main.js` calls `configureExternal` once at boot (shell bridge → `window.open` fallback) and
  `onOpenWeb` + `HelpView.openOnWeb`/`onContentClick` now call the kit `openExternal`. JW's own
  anchor sweep: clean — the only other `_blank` is RichEditor's TipTap Link config with
  `openOnClick:false` (prose links deliberately don't navigate).
- **B1-4 built.** All 11 seeded rows now carry `size_label` + `size_bytes`, harvested 2026-07-08
  by running the app's OWN pre-download inspector (`identity.inspect_model_from_link` — the
  Read-from-link path) against each pinned quant, so seed == detection by construction
  (size_bytes = summed-shard download size; size_label = the file's `general.size_label`;
  nomic's header genuinely carries no size_label — seeded bytes only, noted inline). One value
  independently cross-checked byte-for-byte against the raw HF file listing
  (Qwen3-Embedding-0.6B Q8_0 = 639,150,592). Values corroborate the rows' own notes (Llama 70B
  "~42 GB" → 42,520,398,432; Qwen3-8B-embed "~4.7 GB" → 4,676,804,928). Existing DBs (the box —
  NO reset): `seed_default_catalog` now does a **fill-empty-only touch-up** on already-present
  built-in rows — sizes land at next boot only where the fields are EMPTY; a download-derived
  value is never clobbered (locked by
  `tests/test_identity.py::test_seed_ships_size_facts_and_reseed_fills_empty_only`).
- **B1-5 built.** The save flows upward (the column emits only the NAME; FeatureLab owns the
  POST), so the created id never reached the column's dropdown. `ConfigColumn` now remembers
  `pendingSaveName` and adopts the matching NEW id when the refreshed preset list flows back
  down (one-shot: the first refresh after a save either carries it or the save failed). Covers
  both hosts (TaskKinds + FeatureWorkbench both handle `presets-changed`).
- **B1-6 built.** Every kit Lab run went through the RAW one-shot `request("/v1/ai/run")`
  (`CompareStrip:145` hardcodes `run-stream=null`) — no task registration, and Cancel was
  INERT on that path (`testCtrl` never set). `runAiFeature` extended symmetrically with its
  stream sibling's Lab overrides (providerId-as-string · temperature · topP · maxTokens ·
  jsonMode · reasoningEffort · think · system · userTemplate · samplers — all optional,
  forwarded only when set; the server accepted these exact fields from the old raw body) +
  usage/cost passthrough in the response (additive — `{content, model}` destructuring keeps
  working; the JW aiFeature vitest updated to the new contract). `ConfigColumn.run()` one-shot
  now calls `runAiFeature({..., task: {label: "Lab test — <action>"}})` with a real
  AbortController; the 501 hint branch hardened to read the wrapper's `statusCode`.
- **B1-7 built.** "Ask the manuscript" → "Ask the book" at the three spots
  (`ChatPanel.vue` task label / aria-label / eyebrow). (#46 New-thread is B5-3, untouched.)
- **B1-8 built — with a root-cause CORRECTION to the §1c/queue theory.** The dup is NOT the
  group header vs the card tag (headers are "Writing"/"Whole book"… — nothing like the task
  labels). The real pair is INSIDE the card's provenance line `presetName · taskLabel`: the
  seeded preset names mirror their task labels — "Ideation · Ideation" (identical) and
  "Judgment / scoring · Judgment & scoring" (the user's "slightly different names", verbatim
  match to the data). Fix per the same one-fact-per-line principle: `featurePresetLabel`
  collapses the pair when the two names normalize equal (lowercase, strip non-alphanumerics) —
  the editor's read-only Preset line uses the same function, so both surfaces de-dup. A
  user-renamed preset shows both names again (they're then different facts).
- **B1-9 built.** The lazy-load infra ALREADY existed (P3: `embedTexts` →
  `ensureEmbeddingReady` → POST `/v1/llm-runner/ensure-embedding` → poll resident) — the defect
  was the kit's session-wide ensure cache being UNKEYED: changing the embedding model replayed
  the stale "ready" for the previous model, so the first search after a switch failed with the
  SAME not-loaded error as a cold start (the user's #9, verbatim behavior). The cache is now
  keyed by the requested `(providerId, model)` target — a model switch re-ensures (the server
  loads whatever routing now configures) and the search proceeds; and the cold ensure
  REGISTERS in the shared AI task panel ("Preparing the embedding model") so the minutes-long
  first-use download/spawn is visible instead of a dead spinner (guarded on `getActivePinia()`
  for unit tests/headless hosts). New vitest case: same model twice = one ensure; switch = a
  second ensure.

**B1 gates (one consolidated pass at batch end, per the no-tests posture):** runner `ruff`
clean + **411 pytest** (409 + the 2 new regressions) · JW `npm run test:unit` **30/30** (the
aiFeature shape test updated for the usage passthrough) · JW `build:vite` clean · the **FULL
headless smoke: every route + all 5 AI sub-tabs + the provider-form and sampler probes, zero JS
errors** · rules-checker verdict before the code commits (sha in the git log). Box notes: no DB
reset needed (the size facts fill empty fields at next boot); the model-card links need the
DESKTOP app to show the fix (the browser dev path always worked); an apiKey already wiped by
the old bug must be re-entered once.

**Batch 2 — providers & catalog UI (kit) — BUILT 2026-07-08 except B2-9 (gated on discussion B);
see the B2 BUILD RECORD below:**
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

**B2 BUILD RECORD (2026-07-08, the user's bare "go" after the post-B1 compact — read as "the
next buildable unit in the queue", which is this batch; B2-9 deliberately excluded, it stays
gated on discussion B).** Everything grounded in current post-B1 code before touching it
(ProviderForm.vue:224-227 · AiModelsArea.vue:343-345 · LuModelCatalog.vue:601-663/665-672/
688/793-807 · LuRunnerEngine.vue:134-146 · useEngine.js:75-93 · seed.py:94-96/512-527 ·
api.py:78 · lifecycle.py:452-467); inline T1–T12 citation preceded the first edit per the
"do b" checker discipline; ONE consolidated gate pass at batch end per the no-tests posture.

- **B2-1 built.** `DEFAULT_PROVIDERS` name → "Built-in provider — llama.cpp" (`seed.py`) and
  the health string's "install it on the Built-in server row" → "Built-in provider row"
  (`llm/api.py`) — the only two occurrences in either repo (grep-swept). Existing DBs:
  `seed_default_providers` gained a NAME-REFRESH — a new `_RENAMED_PROVIDER_NAMES` map of
  each id's PRIOR seeded names; a present row is renamed to the new seeded name ONLY while
  its current name still equals one of the old seeded strings, so a user's own rename is a
  different fact and is never touched (the B1-4 fill-empty precedent applied to a rename).
  Locked by `tests/test_shared_storage.py::test_reseed_refreshes_old_seeded_provider_name_only`
  (old name → refreshed; custom name → preserved). LIVE-verified in this container: the dev
  DB predates the rename and the card read "Built-in provider — llama.cpp" after a plain
  server boot — exactly the path the user's box takes, NO reset.
- **B2-2 built (interpretation flagged).** The Run-Quick-Setup section (`.lu-prow-qsbtn`,
  the QuickSetup inline mount) moved from the BOTTOM spanning row of the built-in card to
  its FIRST grid row — the card now opens with the centered "Run Quick Setup" band, a
  bottom border seating it as the card's header above the provider row (screenshot-verified;
  the 2026-07-06 "own separate row" fix stands). The user's words were "align run quick
  setup section to top" — read as move-to-top-of-card; one template block to move back if
  a different alignment was meant.
- **B2-3 built.** The "Your setup" slot cards' pickers render ALWAYS (the #144 empty-only
  `v-if` is gone): the dropdown IS the card's value line, showing the current assignment;
  changing it routes through the SAME assign+load writers as the rows (`makeDefault` /
  `makeEmbedding` — the load swaps the resident model, the user's "it will just unload and
  load"). The dead-pointer warning line stays for the GONE case only (the dropdown then
  shows the placeholder). New `recommendedEmbedId` = QuickSetup's exact embed pick
  (`pickLowestQuality` over the FITTING embeds — the shared modelPick comparator, one rule
  both sides), tagged "· Recommended" in the embed dropdown (the chat dropdown already
  tagged `recommendedId`) and NAMED in the empty card's hint ("we recommend <name> for this
  PC") — surfaced, never auto-applied (the seed principle: the user picks). The assigned
  model stays in its dropdown even if it no longer fits (a shrunk box must show the truth,
  not a blank select). Container check: the embed card read "Qwen3 Embedding 8B ·
  Recommended" as the selected value with the always-visible dropdown.
- **B2-4 built.** The embedded `LuClassTunes` (global) + `LuGlobalSwitches` blocks on the
  built-in Edit view became two BUTTONS ("Hardware-class defaults…" · "Global launch
  defaults…", one caption line) opening AppModal popups hosting the SAME components — both
  components gained an `expanded` prop (render the body directly with no `<details>`/summary
  and load on mount; default false keeps every existing drawer mount unchanged, incl. the
  Tune modal's per-model LuClassTunes). No fork — the two-mode precedent LuClassTunes
  already set, extended by one presentation flag. Probe-verified: the popup opens expanded
  with all 3 switch bundles editable. (B3-6 later points the Tune modal's embedded editors
  at these same popups.)
- **B2-5 built.** The Local-engine panel's actions gained "Uninstall engine" beside Details
  when installed (v-if installed && !installing) — the SAME shared `useEngine.uninstall`
  action the list-row cluster uses (it already confirms via dialog; models are kept), so the
  row and panel can never disagree. The panel comment's "actions live on the row" note now
  records TWO in-reach exceptions: Install when absent (#135) + Uninstall when installed
  (#8). Not screenshot-verifiable in this container (engine not installed → the panel
  correctly shows Install engine instead); the v-if mirrors #135's proven pattern.
- **B2-6 + B2-7 built.** A "Model Catalog" heading row above the search bar (`.lu-mcat-title`,
  the `.lu-pcard-title` type treatment; the 14px breathing-room margin moved onto it). The
  Chat-&-writing / Embedding section rows inside the table got the pronounced treatment the
  user pointed at ("like the doesn't fit header"): an `--accent-soft` band with a 3px accent
  left border and full-ink section name — you can now tell at a glance which kind of model
  the rows under it are. Screenshot-verified.
- **B2-8 built.** The inspect block moved ABOVE the Quant label (it's what FILLS the quant
  list — the flow now reads repo → load info → pick quant), the button renamed "Load model
  info from HF" with `intent="info"` (solid blue — distinct from every neighboring button,
  the user's "different color … more pronounced"), and the caption's "— no download" tail
  dropped. Probe-verified: button present, above Quant in DOM order, tail gone.

**B2 gates (one consolidated pass at batch end):** runner `ruff` clean + **412 pytest** (411 +
the name-refresh regression) · JW vitest 30/30 · `build:vite` clean · the **FULL headless
smoke: every route + all 5 AI sub-tabs + the provider-form and sampler probes, zero JS
errors** · a dedicated **B2 Playwright probe observing every changed surface** (QS-row-first
assertion · heading · section headers · slot cards · library buttons + an opened popup ·
the renamed button above Quant — 9/9 pass, zero page errors) + 4 screenshots eyeballed ·
rules-checker verdict before the code commits (sha in the git log). Box notes: NO reset
needed — the provider rename reaches the existing DB at next boot via the name-refresh
(container-proven); everything else is kit UI, visible on the next `npm run tauri dev`
build; the engine-panel Uninstall shows only when the engine is installed.

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
- B4-5 (#34) RESOLVED by the user 2026-07-08: "when i sent my config from measure to task, none
  of the switches where set it had all defaults" — the Send-to-Lab handoff loses the switches.
  Traced 2026-07-08: the modal DOES send them (`TuneMeasureModal.vue:149` → `labHandoff.js:21`)
  and TaskKinds lands the payload on the FIRST task + arms `pendingHandoff`
  (`TaskKinds.vue:125-131`; line 128 is also the #20 "first task" complaint) — the loss is in
  FeatureLab/ConfigColumn's column seeding (the model-pick watcher re-seeds both grids from the
  MODEL, `ConfigColumn.vue:96-110`, clobbering the handed rows). The user notes this is the same
  syncing issue as discussion A — CORRECT, and stronger: even a successful carry would change
  nothing, because the column's engine switches are never sent on Test
  (`ConfigColumn.vue:292`) and never applied in production (the dead plane, §1a). Disposition:
  dissolved by discussion A (launch switches leave the Lab; Send-to-Lab becomes "open the Lab on
  this model for quality testing" and the launch config follows the model automatically). If the
  user instead keeps launch switches in the Lab (A rejected), this becomes a carry-bug fix.

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
2. ~~CLARIFY #9 and #34~~ — both resolved by the user 2026-07-08 (see B1-9, B4-5).
3. B1-2 needs the box's engine-log line for the leftover-build failure before any code.

## §6 — Q&A record (2026-07-08, after the organization landed)

**User:** "we have 2 places to set and save engine switches, how do you know which one is
applied, it still seems confusing to me."

**Answer (grounded):** only ONE of the two is ever applied. (1) Tune & measure → Save tune →
`model_tunes` (this model + this machine): every load of that model — whichever task triggers
it — resolves global bundles → class default → this saved tune and spawns llama-server with the
result (`switch_resolve.py`, wired live `install.py:182-189`). (2) The Lab column's "Engine
switches" saved into a preset: applied NEVER — not on the Lab's own Test
(`ConfigColumn.vue:292` "Plane-1 switches are NOT sent") and not in production (nothing reads
`EnginePresetSwitch`/`ngl_override` — grep proof, §1a). So today the honest answer to "which is
applied?" is "always the Tune side; the task side is dead storage" — and the fact that the UI
can't tell the user that IS the defect. The confusion is not a documentation gap to explain
away; it's the dead plane, and discussion A's proposal deletes it so exactly one place exists.
The design principle: engine switches are the flags the model's server PROCESS starts with; the
process is shared by all tasks, so its launch config cannot belong to any one task (per-task
launch flags would force a full unload/reload on every task switch — ~8-12 s on the 2070S — and
"current config" would be whichever task ran last). What tasks legitimately own is everything
that varies per REQUEST without a reload: samplers, max tokens, JSON, thinking — which presets
already carry. The one-profile A/B (2026-07-06) is the measured proof this split works.

**User (same thread):** "switches are mostly tied to a machine based on vram, yes different
models may mean different switches, it seems like you are making modle the holder of the
swicthes."

**Answer (grounded):** the values are keyed by the PAIR — (model × machine) — which is the
user's own 2026-07-06 seed-principle decision ("the pair (model × machine) owns the numbers"),
and both halves are load-bearing: same machine, different models → different values (on the
2070S: Gemma MoE wants n_cpu_moe ~21, a dense model wants plain ngl and no n_cpu_moe at all,
the embed model fits outright); same model, different machines → different values (Gemma on
8 GB offloads experts; on 24 GB it wouldn't). The machine side is literally VRAM-based in the
schema: `class_tunes.class_key` = `vram<GB>|ram<GB>` with GPU name + cores deliberately
excluded (`db.py:294-304` — "placement is memory-fit-bound, not compute-bound"), and
`model_tunes.hw_key` is the machine key. The model is not the OWNER — it's the navigation
anchor (you open Tune from a model row); every saved row is stamped with the machine or class
it belongs to, and a different GPU simply stops matching (the #113 hardware-change notice
covers the swap case). Truly machine-only box policies (mlock, no_mmap, cache types,
flash-attn) live in the Global launch defaults bundles — all models, overridable above. A
per-machine-ALL-models layer existed (`hardware_switches`) and was retired 2026-07-07 in the
user's own provenance review: anything memory-driven turns out to vary by model too, so the
layer had nothing unique to hold. If the model-first presentation is what makes it FEEL
model-owned, the machine-first view already exists (the cross-model class library, #127) and
can be made more prominent — presentation change, not a schema one.

---

## §7 — LOCKED DECISIONS (these OVERRIDE the §2 exploratory discussion; read THESE for what was decided)

### §7.1 — The switches ⇄ params flow (DECIDED 2026-07-08, multi-round discussion; user "go" to record)

**THE LAW — two owners, one store each:**
- **Engine/launch switches belong to the MODEL × THIS MACHINE.** A loaded model is ONE llama-server
  process with ONE set of launch flags; every task that uses that model shares them. Physical reason
  the user REJECTED per-task switches (verbatim): *"no every task cannot have its own switches that
  would be massive reload thrash"* — two configs of the same model can't be co-resident on 8 GB
  (2× weights VRAM), so per-task launch switches = reload on every task switch.
- **Request params belong to the TASK's preset** (Plan A, unchanged): provider · model · temperature ·
  top_p · max_tokens · json_mode · reasoning/thinking · stop · long-tail samplers. Per request, no reload.

**ONE store for switches; the dead duplicate is DELETED:**
- LIVE store = the model-keyed resolve chain: global bundles (`all`/`moe`/`dense`/auto-MTP) → hardware
  CLASS default (`class_tunes`, per `vram|ram` class) → THIS machine's tune (`model_tunes`), resolved
  at load by `switch_resolve.resolve_model_switches(model, hw, class)`, wired into every production load
  (`install.py:182-189`; `lifecycle.py:602` main load + `:1100` ini-emit). QuickSetup + catalog load pass
  NO switches (`QuickSetup.vue:316`, `LuModelCatalog.vue:116,153`) → they get this resolve.
- DELETE the DEAD second store (grep-verified: read by NOTHING at load across
  lifecycle/dispatch/prompts/process/config; only WRITTEN by the preset form `stores.py:629-630` + seeded
  `seed.py:665`): the `EnginePresetSwitch` table (`db.py:517-527`) and the `ngl_override` /
  `n_cpu_moe_override` columns on `EnginePreset` (`db.py:511-512`). This dead duplicate was the ROOT of the
  user's "which one is active / still disconnected"; removing it leaves provably ONE place switches live.

**THE SURFACES — Tune & measure is THE only switch editor; the Lab LINKS to it (user's proposal, verbatim:**
*"we a like to engine switches that open the same tune and measure that is associated with model, we
reuse code and keep everything centrally located in mental model"*):
- **Tune & measure** (`TuneMeasureModal.vue`, opened per-model via its `:model` prop — today from the
  model card `LuModelCatalog.vue:879`) is the single switch editor, for every model.
- **The Lab column** (`ConfigColumn.vue`) LOSES its "Engine switches" `<details>` grid
  (`ConfigColumn.vue:422-435` — the block whose caption wrongly says "Save writes these into this Task's
  preset"). It keeps ONLY the request params (→ the task preset). It GAINS a link **"Engine switches ↗"**
  (muted caption "shared by every task using this model") that opens the SAME `TuneMeasureModal` for the
  column's currently-selected model. REUSE — no new switch UI built.
- The Lab's Test loads the model with its REAL applied switches (model-keyed resolve) + the task's params
  → what you see in the Lab IS production ("seen = run"). Switch A/B lives in Tune & measure (grid +
  measure + autotune); prompt/param/model-quality A/B lives in the Lab.

**APPLY SEMANTICS (Tune & measure's commit) — DECIDED:** the commit **reloads the model IMMEDIATELY**, not
"at next load" — the user rejected the wait, verbatim: *"if you save a user would expect that to apply now
not wait 30 seconds for it to unload and load this is the type of thinking you should not have."* Progress
shown during the reload. The Lab has NO switch commit anymore (it has no switches). "Save as hardware-class
default" stays as a secondary library-write action, unchanged.

**TWO CONSEQUENCES THE USER ACCEPTED (verbatim 2026-07-08 — "1 yes... 2. i also agree"):**
1. Co-tuning switches+params is a modal round-trip (find a switch problem while quality-testing a task in
   the Lab → "Engine switches ↗" → change + Apply in the modal, reloads → close → re-test). User: *"yes i
   mean that was how the lab was originally supposed to work if you changes switches it would have to reload."*
2. **"Send to Tasks Lab" (from Tune & measure) is REMOVED** — it existed only to carry switches into a Lab
   column (the source of #20 "opens as the first task" + #34 "switches came as defaults"). Switches out of the
   Lab ⇒ nothing to carry. Delete the button (`TuneMeasureModal.vue:148-151,385`) + the `labHandoff.js`
   switch-carry channel + its consumer (`TaskKinds.vue` consumeHandoff/pendingHandoff/watch). Resolves #20 + #34
   by deletion.

**RESOLVES in the batch:** discussion A is DECIDED; queue items #14b, #22, #23, #25, #26, #31, #32, #33, #35
(all the "which switch / how many places / disconnect" questions), #20 + #34 (send-to-lab, by removal), and
#51's UI half (online providers show samplers only — not the built-in model, so no switch section).

**STILL OPEN sub-questions (NOT part of this lock — do not treat as decided; need the user):**
- (a) The Apply **blast-radius confirm** — whether it NAMES the affected tasks (capped, e.g. "Generate prose,
  Chat, +N more") or says a generic "every task using this model". (My rec was to name-capped; user has NOT
  answered.)
- (b) Exact commit **verb/label** — the user's phrasing was "maybe we just have apply button"; behaviour
  (reload-now) is locked, the literal label ("Apply" vs a reworded "Save") is a wording detail to confirm.
- (c) The **help popover** exact copy (proposed: "The model decides how it runs — engine switches, one place:
  Tune & measure, shared by every task that uses it, needs a reload. The task decides how it's asked —
  temperature, tokens, thinking — per task, no reload.").
- (d) Provenance **badges** (#15/#17/#24b): wording + which surfaces. Separate from this core.

**BUILD RECORD (2026-07-08, the user's "go" — BUILT + VERIFIED; scope below executed with
two recorded deviations):** the dead preset-switch storage is deleted end to end
(`EnginePresetSwitch` class + `ngl_override`/`n_cpu_moe_override` columns out of `db.py`;
`stores.py` wire/list/save/teardown narrowed to samplers; `seed.py` preset seeder drops the
switch child + override kwargs; `presets_api.py` wire model + docstrings; tests rewritten —
`test_presets.py` roundtrip asserts the fields are GONE and a stale `switches` key is ignored,
`test_shared_storage.py` delete-children test is samplers-only). Kit: `ConfigColumn.vue` lost
the Engine-switches grid + the Hardware-fit override row and gained the **"Engine switches ↗"**
link (local models only) that mounts `TuneMeasureModal` for the column's model, with the budget
window now derived from the model's RESOLVED `ctx_len` (windowSource "model"); `CompareStrip` /
`FeatureLab` / `TaskKinds` / `FeatureWorkbench` dropped every switch/handoff prop and ref;
`TuneMeasureModal` — "Save tune" → **Apply** (blast-radius `confirmDialog` naming affected
tasks capped at 3 "+N more" → `PUT /v1/ai/model-tunes` → **immediate reload when the model is
the currently-running one**: stop → load `{modelId}` only, so the spawn resolves the just-saved
config through `switches_fn` — seen = run; honest limit noted in-code: a co-resident secondary
isn't respawned, its next load picks the config up), "Remove applied config" reloads the same
way, all "Save tune" copy → Apply/applied; **"Send to Tasks Lab" removed** + `labHandoff.js`
DELETED + `AiModelsArea` back to a local tab ref (resolves #20 + #34 by deletion).
**Deviation 1 (open sub-question (c)):** the "?" help popover was NOT built — the two-owner
explainer shipped as the modal's lede sentence + the Lab link's caption/titles instead; the
dedicated popover is DEFERRED pending the user's call on the (c) copy — the affordance is
recorded here, not dropped. **Deviation 2 (open sub-question (a), flagged):** the confirm
NAMES the affected tasks (capped +N) per the recorded recommendation — the user never
explicitly picked named-vs-generic; one-line changeable. Also folded opportunistically:
the "Remove applied config" button is `secondary` (not ghost) per the user's queue item #16
wording ("not a fan of the plain ghost button").
**Gates:** runner ruff clean + **409 pytest** · JW `build:vite` clean · **FULL headless smoke
zero JS errors** (all routes + 5 AI sub-tabs) · rules-checker round 1 **FAIL** (2 genuine:
`tk.tasks`→`tk.taskKinds` in the blast-radius fetch — fixed; the popover deferral unsurfaced —
recorded above; + a stale `AiModelsArea` comment — fixed) → re-run → see the ship commit.
Orphan note: existing DBs keep the inert `engine_preset_switches` table + override columns
(`feature_preset_refs` precedent) — **no reset needed**.

**ORIGINAL BUILD SCOPE (as locked; kept for the record):**
- Runner backend: delete `EnginePresetSwitch` + `ngl_override`/`n_cpu_moe_override` (`db.py`, `stores.py:572,629-630`,
  `seed.py:665`, the `EnginePresetRow`/wire fields + presets_api); drop+reseed DB (pre-release policy — the
  user's box needs a data reset). Verify ruff + pytest.
- Kit UI: remove `ConfigColumn.vue:422-435`; add "Engine switches ↗" link → `TuneMeasureModal` for the column
  model; `TuneMeasureModal` commit → reload-now + blast-radius confirm (kit `confirmDialog`); remove "Send to
  Tasks Lab" + `labHandoff.js` switch channel + `TaskKinds.vue` handoff consumer; `?` help popover (kit
  `HelpTrigger`/`openHelp`). Verify build:vite + full headless smoke.
- Docs: `docs/models.md` tuning section; this doc (mark items resolved); recap pointer.
- rules-checker on the diff → PASS before the code commit(s).
