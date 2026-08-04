# Plan — One-source preset rewrite: delete the task tier, params live ONLY on presets

> **STATUS: BUILT — ALL STAGES SHIPPED (see the in-doc status at the build's end; the
> "awaiting go" line that stood here was stale, corrected by the 2026-08-04 docs
> campaign — code agrees: no `task_kinds` anywhere, `llm_runner/llm/preset_resolve.py`
> is the two-source resolver). This doc remains THE reference for the current
> routing/preset model (CLAUDE.md points here).**
> Approved by the user via plan-mode approval after the full checker discipline: a 3-lens
> rules-checker PANEL (architecture-fit · reuse/convergence · grounding — 6 real findings, all
> folded: the 21-row sample count, the defaultPresetId→RunnerSetting relocation found
> independently by two lenses, the top_p repoint, the TestSample re-key chain, the JW-path-only
> pin scoping, the dormant FeaturePreset deletion) + three confirmatory rounds (FAIL(2)→
> FAIL(1)→ **PASS**, all 12 rule-tests). Supersedes the task-tier model everywhere; the
> 2026-07-14 feature-override-and-reasoning plan's Unit-2 BACKEND content stays authoritative
> and is absorbed by T4 below (its task-tier language is superseded — banner lands with T9).
> The parked uncommitted Unit-2 diff in this repo is the STARTING TREE for the build.

**Repos:** `just-llm-runner` (runner + kit) + `justwrite-app` (seeds; renderer verified untouched).
**Branch:** `claude/admiring-galileo-il3q0o`. **JustVoice: OUT OF SCOPE** (user's word 2026-07-15: "dont worry about jv").
**Protocol (user, 2026-07-15):** plan approved → **Opus subagents do all build + testing work** — code starts ONLY on the user's explicit "go" after approval. Push on the user's word.

## ⛔ CORRECTION (2026-07-15, same day — the USER's verdict on seeing the built UI)

**The separate Presets page is DELETED. `Routing by feature` is the ONE routing surface,
and the Lab's preset bar is the ONE preset control — restored to its ORIGINAL shape.**
The user's words: *"task kind should not even exist anymore … it looks to me like you just
renamed tasks to presets"* · *"we should only have routing by feature and it works the same
way originally"* · *"the dropdown has button use in production … another thing you renamed
without approval"*. They were right on every count:

- **My design error:** I concluded "the preset IS the group" (correct) and then leapt to
  "so it needs a group-management page" (wrong) — rebuilding TaskKinds.vue's master/detail
  shell with member lists + Move-to. Structurally that page WAS the task page renamed. My
  own approval note even flagged the doubt ("whether you'd rather fold preset management
  into Routing by feature entirely and drop the second tab") and I never asked it.
- **My process error:** nothing in the pipeline ever LOOKED at the built UI. Probes assert
  elements exist; they don't say what a page reads like. The user was the first human to
  see it — against my own standing memory rule (render + screenshot before "done").
- **Unapproved renames reverted** (verified in git, not memory): the ORIGINAL control is
  `Use in production` + a `● in production` marker (`1302f88`); the task era renamed it
  "Use for this task"/"✓ Task preset" (`46cf11a`) and my rewrite made it "Use for this
  feature"/"✓ feature preset". All three renames are dead; the original is back verbatim.

**Shipped:** `Presets.vue` DELETED (+ its tab/import/section); `ConfigColumn` restored to
the original bar (drop the invented `assignLabel`/`showUseProduction` props — one shape for
every mount); FeatureWorkbench's TOP assignment dropdown DELETED (it duplicated the bar);
per-feature **Reset to default** restored as a real labeled **danger** button, right-aligned
in the action header, resetting the ref AND remounting the Lab (`labEpoch`) so the whole
form reloads; `↺ Reset presets to defaults` relocated to the feature-list footer; the
**Writing AI** tab moved beside Routing by feature (user's ask); `b4-probe.mjs` DELETED
(it asserted the deleted page's layout); `presets-probe.mjs` REWRITTEN to the real surface
(**31/31**, incl. the flattening pin + the original-button assertions); docs re-swept
(`presets.md` rewritten; ai-providers/models off the dead tab).

**A REAL PRE-EXISTING BUG found by that probe — `csrf.py` (fixed here):** the CSRF Origin
guard allowlisted only the dev port (1420) + Tauri, never **the server's own origin** — but
`app.py:216` also serves the UI at that origin (the headless `serve` + browser mode), and
browsers DO send `Origin` on same-origin mutations. Every write from the self-hosted UI
403'd. Same-origin is by definition not a CSRF vector; the guard now derives the server's
own origin per-request and allows it (cross-site is still rejected — `test_csrf.py` 4/4,
incl. a new same-origin regression). Pre-existing since `227c44f`, unrelated to this
rewrite; the smoke never caught it because it ran against the allowlisted dev origin.
**Gates:** JW server pytest **108** + ruff clean · vitest **145/145** · build:vite · FULL
headless smoke zero JS errors (only the pre-existing `jscpd` threshold red) · presets-probe
**31/31** · biome clean · **screenshots reviewed by me before calling it done.**

### QUICKSETUP FOLLOW-ON (2026-07-15, same day)

After the correction above the user drove Quick Setup on their box and asked for a genuine
PARALLEL-download experience — verbatim: *"why cant we have two progress bars with downloads
running in parrallel? cancel or restart on both, just like it is in the progress bar in the
models download"* and *"you have to download the main model if it is not downloaded so you can
run both downloads at same time, if main is already downloaded it still need to load its
weights and we can show progress bar of downloading embed"*, plus earlier: friendlier words
(not "model weights") and the embed must ACTUALLY download during Apply. Built to this
user-decided design (kit `ui/src/views/QuickSetup.vue`): the apply step now shows **two
independent reactive bars** (`chatBar`/`embedBar`) fired together via `Promise.all` — the chat
model on the LOAD channel (`/load`+`/status`, download then spawn into VRAM) and the embedding
on the DOWNLOAD-ONLY channel (`/download`+`/download/status`, no VRAM, which
`lifecycle.download()` states can proceed while another model is loaded). Each bar carries its
own **Cancel** (`/stop` · `/download/cancel` — state flips first so the poll loop exits at
once, the partial blob stays cached, Retry resumes from it) and **Retry**; `friendlyPhase`
replaces the raw engine `detail` with plain words; the embed is downloaded DURING Apply, no
longer deferred to first search. **The rethink fix:** a successful chat Retry must call the
extracted `finishApply()` so the wizard advances to the done step — without it the user
retries, it works, and the modal stays stuck on the apply step forever (`retryChat` guards on
`chatBar.state === "done" && step === "apply"`). The modal's `:closable` now opens whenever
nothing is running (`!optRunning && chatBar.state !== 'running' && embedBar.state !== 'running'`)
— cancellable parallel bars must never trap the user. The old single-bar state
(`applyStage`/`applyPhase`/`resetBar`) + `pollLoad`/`pollDownload` were deleted; their logic
lives in `runChat`/`runEmbed`. **T3 (rules-checker catch, folded):** the bar-caption format was
hoisted to a shared `progressCaption(phase, done, total, rateText)` in `common/services/
downloadRate.js` — `barLabel` had forked `useRunnerModels.progressLabel`'s three-branch
`${phase} · ${cur} / ${tot}${rate}` shape; both now call the one formatter, covered by a new
vitest case. Gates: `build:vite` ✓ · vitest **147/147** (2 new `progressCaption` cases) ·
headless smoke zero JS errors (only the pre-existing `jscpd` red) · a 3-scenario Playwright
driver — parallel mid-flight (two bars, friendly words, bytes+speed+ETA + Cancel on each) ·
error→Retry→**done** (the rethink fix) · embed Cancel while chat keeps downloading — **13/13
verdicts PASS with the screenshots read**. Docs shipped in the same commit:
`justwrite-app/docs/models.md` step 4 + the A5-1 ledger line + the recap pointer.
(Runner-repo QuickSetup.vue has no biome/lint gate — no `biome.json`, no lint script — verified.)

### ONE-DOWNLOADER CONSOLIDATION (2026-07-15)

Seeing the two-parallel-bars build, the user gave the reuse order — verbatim: *"regardless of
what we download engine model whatever we should be able to do it, reuse the control … stop
repeating code, reuse stuff, if component exists to do this already use it instead of writing
your own"* + *"the existing bar for model and engine both have cancel if not they should"* +
*"if engine is not installed … first user interaction will be quick setup we need same type of
progress bar cancel"*.

**The triplication that existed** (all three re-implemented the same "POST to start → poll a
status channel → feed a progress bar → cancel/retry" loop): (1) `composables/useEngine.js` — the
engine install singleton, with ZERO cancel; (2) `composables/useRunnerModels.js` — the catalog
singleton, whose `refresh()` MERGED the LOAD and DOWNLOAD channels into ONE `detail/downloaded/
total` ("the active download's progress wins"), so a simultaneous load row and download row shared
one lying label, and the LOAD row had no cancel; (3) `views/QuickSetup.vue` — the freshly-added
`chatBar`/`embedBar` reactive objects + `runChat`/`runEmbed`/`cancelChat`/`cancelEmbed`/`retryChat`/
`retryEmbed`, a third hand-rolled copy of the same poll loop.

**What replaced it.** A new kit composable `composables/useDownloadTask.js` — `createDownloadTask(channel)`
— is THE one orchestrator: `channel = {start, statusUrl, read, cancel, friendly, fetch?, pollMs?,
maxPolls?}`; it returns a reactive task `{state ("" | running | done | error | cancelled), phase,
done, total, rateText, error, label, start(), cancel() (flips state FIRST so the poll loop exits,
THEN the server call), retry(), waiting(phase), fail(message), reset()}`. Its caption reuses the
EXISTING single-source formatter `progressCaption` (downloadRate.js) — no fork. A new kit component
`common/components/DownloadBar.vue` is THE one bar (props `{title, role, task}`: header row · [Cancel
while running] / [Retry on cancelled|error] / "Ready ✓" on done · shared `UiProgress` · error line;
the old `.lu-qs-bar*` styles moved here as `.lu-dlbar*`). QuickSetup now mounts **three**
`createDownloadTask` instances rendered by DownloadBar — `engineTask` (only when the engine isn't
installed, from a `GET /engine/status` at open), `chatTask` (the LOAD channel; when the engine is
missing it shows a held "Waiting for the engine…" state and fires the moment `engineTask` reaches
done — an engine cancel/error sets the chat to a needs-engine error), and `embedTask` (the DOWNLOAD
channel, fired in parallel since a download needs no engine). The finishApply gating, the
embed-failure honest done-note, and the `:closable = nothing running across ALL three tasks` are
preserved; the chat watch drives finishApply so a successful chat retry still advances.

**Merit-flagged reuse boundary (T1/T3).** `createDownloadTask` models a SELF-STARTED, FINITE task
(perfect for QuickSetup's three). The two domain singletons are NOT that shape: `useRunnerModels`
polls a continuously-mutating models LIST and its channels are triggered by external buttons (not
by the composable), and `useEngine`'s install has four entry-shapes (install/reinstall/backend-add/
update) plus singleton terminal duties (#138 models-refresh, backend fields). Wrapping either in a
finite self-started task would add indirection, not remove it — so they KEEP their pollers but (a)
reuse the ONE `progressCaption` formatter (killing the duplicated caption logic the checker cited),
(b) gain cancel, and (c) `useRunnerModels` SPLITS the merged progress into `loadProgress` +
`downloadProgress` so a load row and a download row show their own real bytes. `useEngine` gains
`cancel()` (the new endpoint) surfaced as a Cancel button beside `LuRunnerEngine`'s install bar;
`LuModelCatalog` reads the channel that concerns each loading row and the LOAD row gains a Cancel
(`/stop`, now a TRUE abort — see server S2).

**Two server additions** (`llm_runner/runner/lifecycle.py` + `api.py`): **S1 — engine-install
cancel.** `RunnerService._engine_cancel` (a `threading.Event`), cleared on install start, threaded
as `cancel_check=self._engine_cancel.is_set` into every `_run_install` `acquire_binary` call (the
DL-2 `stream_download` seam already accepted it); `DownloadCancelled` is caught → `_engine_idle()`
(back to not-installed; the partial archive is left on disk but a fresh install RESTARTS the fetch —
the segmented path re-preallocates from segment offset 0, no cross-call resume). New method
`cancel_install_engine()` + route `POST /v1/llm-runner/engine/install/cancel`, mirroring the model
`download_cancel`. **S2 — true load abort.** The load's weights (and MTP-draft) download now passes
`cancel_check=lambda: model_id not in self._resident`, so a `stop()` (which pops the model) aborts the
fetch at the next chunk; `_run_load` catches `DownloadCancelled` BEFORE the generic except (log info,
`arbiter.release`, return with NO error state — the model is already gone, don't resurrect it). Before
this the download ran to completion and the load only unwound at the router-lock re-check.

**Gates.** Runner `pytest` 509 passed (+3 new: S1 cancel-flips-to-idle, S1 idempotent-when-idle, S2
stop-during-download-no-error; the only 2 failures are the pre-existing Windows-env `test_hardware`
lspci + `test_lifecycle` ensure_model_ready timeout) · `ruff` clean · JW `build:vite` ✓ · `test:unit`
**157/157** (+12 new `useDownloadTask` cases) · headless smoke zero JS errors on every route (only the
pre-existing `jscpd` red) · the extended Playwright driver — **16/16 verdicts PASS with the screenshots
read**: scenario A (three bars at once — engine downloading ∥ embed downloading, chat "Waiting for the
engine…", then engine done → chat loads), B (engine Cancel → chat needs-engine error → engine Retry →
recovery to done), C (catalog load row 2.4 GB / 4.2 GB ∥ download row 300 MB / 640 MB — different bytes,
both with Cancel — the merged-label lie dead).

## BUILD RECORD (2026-07-15 — built on the user's "go" / "keep going until its done")

**ALL STAGES BUILT + VERIFIED; commits pending the diff checker; PUSH awaits the user's word.**
Execution was Opus subagents per the user's protocol (backend · kit-UI · chips · verification),
orchestrated + spot-verified stage by stage. **Backend (T1–T4 + python T8):** runner pytest
**506 passed** + ruff clean (2 pre-existing Windows env failures only) · JW server **107
passed** + ruff clean · fresh-DB proof: 10 presets / 37 refs / default `p_prose_edit` / 21
sample blobs fanned to 41 per-action rows. Deviations, all sound + recorded: temperature
widened to `float|None` omit-on-None across dispatch + 4 adapters (its checker caught the
no-preset rule fabricating a 0.7 / emitting null — the max_tokens precedent); preset reset
endpoints live in `presets_api` (`POST /engine-presets/reset` + `/{id}/reset`);
`default_preset_id` threaded through `configure_app_seed`/`install_llm`. **Kit UI (T5–T7):**
Presets.vue built to the mockup (TaskKinds.vue deleted); Workbench = the one preset control
with the named-default sentinel; the Lab column seeds entirely from the preset; JSON = a
read-only contract badge + ephemeral test toggle; TuneMeasureModal blast radius names
presets; taskLabels.js/setPin/PromptLab deleted; chips: opt-in editable doorway on the two
ChatPanel mounts + the ProviderForm reasoning-levels table. **Two T0-audit misses found +
folded during T9:** (1) JW `routingBackend.js` was a FUNCTIONAL pins consumer (derived pins
from the deleted `FeatureRow.providerId`, sent a ghost `pins` field in every routing PUT) —
the whole JW pins chain removed (`featurePins` state, `setFeaturePin`, `modelForFeature`:
all caller-free, verified; `providerForFeature` kept as the modals' configured-guard with
identical fallback); (2) runner comments `db.py:9-11,:176` were still stale — and the pre-commit diff checker
then caught EIGHT MORE stale comments this record had over-claimed as swept (db.py:551,
presets_api.py:64/:69/:198, stores.py:472, prompts.py:253, switch_resolve.py:39,
schema.py:88, seed.py:67 — all describing the deleted tier as live; all rewritten to the
ref→default model, ruff clean, before commit). Round 2 of that checker then caught ONE more
(db.py:552's self-contradictory "a feature's preset IS its task's" parenthetical) plus six
loose "per-Task" wordings (model_catalog_api.py:15/214, presets_api.py:5/40,
runner/schema.py:231/263) — all fixed, residual grep clean, ruff clean, test_presets 7/7. **Verification
(T8):** vitest **145/145** · build:vite ✓ · headless smoke ZERO JS errors (26 routes + 6 AI
sub-tabs, isolated temp data dir — proven via /v1/health dataDir) · NEW presets-probe
**22/22** incl. the flattening pin (reasoning-only preset edit leaves temperature 0.3) ·
chip 5/5 · b29 8/8 · b5 21/21 · qc35 15/15 · qc-quintet 22/22 · b4 10/10 · runner spot
suites 42 + ruff. **Left red, all pre-existing/environmental (root-caused):** headless-smoke
`jscpd` duplication threshold (40+ untouched renderer files); switch-probe SW1–7 (the
ISOLATED fresh DB correctly reports no engine installed); rag-probe entity legs (its own
staleness banner, rag-probe.mjs:46-51). **Probe container-ism fixed:** hardcoded
`/home/user/...` `createRequire` paths → `import.meta.url` in 6 probes (they never ran on
Windows before). **Infra follow-up (claude-config): FIXED same day — see the recap's SUBAGENT-HOOK GAP go
paragraph + `claude-config/EFFECTIVENESS.md` (2026-07-15 entry).** The PreToolUse
pre-action hook DENIED subagent Edit/Write all day: its sidechain bypass read
`isSidechain` from the transcript the hook receives, but the harness passes the MAIN
transcript even for a subagent's call, so the bypass never fired once. Agents applied
writes via shell file-ops instead — a ~2-3× wall-clock multiplier (this build: 66 min for
~30 min of code work). Detection now keys on the payload's own `agent_id`, live-captured
from both sides (subagent has it, coordinator doesn't); 4 regression cases added. **Remaining for the USER's box:** engine
present → one local High chat run (thinking stops at the hardware cap), one new-Anthropic
run (words on the wire, no 400) — the Unit-2 acceptance carried through this rewrite.

## Context — why

The 2026-07-15 design session (this session, all claims verified in code) found today's routing is
**four sources deep** and lying to the user:

1. `feature → task → preset` (`FeatureTaskKind` → `TaskKindPreset`) plus the Unit-1 per-feature
   override (`FeaturePresetRef`, seeded EMPTY — restored as a capability, not as the model).
2. **Hidden per-action params on the prompt rows** (`feature_prompts.temperature/top_p/max_tokens/
   think/reasoning_effort`) blended into every run by `_effective_spec` (`prompts.py:483-500`) with
   per-field-inconsistent rules (temperature/max_tokens fall back; top_p/json/think/reasoning clobber).
   These params have **no durable editor mounted in either app** (sole writer `PromptLab.vue:86`,
   unmounted) — run behavior depends on values the user cannot see or change.
3. A dormant per-action sampler layer read by the run path (`prompts.py:415-418`), zero seeds, no UI.
4. A **pins** tier that is write-orphaned IN JW (`routing_api.py:5-7,44-66`; the kit writer
   `useRouting.setPin` `useRouting.js:55-58` has zero callers — verified). **Scope note
   (confirmatory-checker finding): the SHARED contract behind it is live in JustVoice**
   (`FeaturePinConfig` imported at JV `models.py:24`, `feature_pins` populated at JV `config.py:50`,
   `resolve_pin` called at JV `extraction_api.py:310`, a live JV pin-writer API mounted at JV
   `app.py:233`) — so only JW's plumbing dies; the shared schema stays (see T1/T2).

Consequences demonstrated live: the Lab **flattening trap** (open Critique, change only Reasoning,
Update preset → six of eight judgment actions silently re-tuned to 0.4 — simulated with real seed
data); save-erases-think; chips able to claim reasoning that never runs. The task tier itself is
pure indirection — `TaskKind` = id/label/description/position/built_in (`db.py:685-699`), consumed
only for preset lookup, sample keying, and labels.

**User decisions (2026-07-15, this session — build to these, do not re-litigate):**
- "the main source is that a feature is the base it has a preset, that is the truth" — tasks were
  only ever a convenience so features with the same settings share one config.
- "i agree with deleting and no legacy fallback and remove tasks".
- "i dont care what is done today, if we need to rewrite to get it correct that is ok".
- Nav grouping is user-friendly shelving, "not necessary grouping the features by use or preset".
- Earlier this session (carried): resolved-route gains override params (cap-hint pick); the
  resolved-route mirror break gets fixed; PromptLab recorded as dead.
- Standing (2026-07-14, carried): reasoning levels + `min(ask, cap)` local rule; Unit-2 backend design.

## The target model (the settled design)

- **Action** (37 of them; "feature" in UI = the display shelf an action sits under, nothing more) owns:
  its **prompt** (system/user text, variables), its **JSON contract** (`json_mode` + `json_schema` —
  kept on the action because the app's parsers are per-action; routing must never break a parser),
  its **nav metadata** (label/description/group — display-only), and **one pointer: `preset_id`**
  (the existing `feature_preset_refs` table — Unit 1's restoration completed: seeded FULL, 37 rows).
- **Preset** owns the model + every tunable: provider/model, temperature, top_p, max_tokens,
  samplers, think + reasoning level (Unit 2). NOTHING else stores a tunable. "Used by N features"
  is derived from the refs.
- **One `defaultPresetId`** catches unassigned/custom actions. **Storage relocates (panel finding):**
  today its ONLY persistence is the `TaskKindPreset[""]` row — inside the deleted table
  (`install.py:156-157` wires `get_default`/`set_default` through the task-preset store;
  `preset_resolve.py:69` reads it). New home: a **`RunnerSetting` row `default_preset_id`**
  (db.py:487-496 — the existing scalar store; the `reasoning_cap_default` precedent). Repoint
  `install.py:156-157`, the resolver's default read, and the reset write onto it.
- **Resolution:** ref → default. `_effective_spec`, the prompt param columns, the dormant sampler
  layer, the three task tables, the task API + page, and PromptLab are **deleted — no legacy
  fallbacks** (user's explicit word). `resolve_pin`'s pin tier is **NOT deleted** — it simply never
  FIRES in JW (JW stops populating `feature_pins`; the shared function stays, JV-live — see the
  scope note in Context #4). Request-body overrides stay as EPHEMERAL arguments (Lab tests,
  writerAI 3-variation) — never stored config.
- **Effective think** = preset.think AND NOT (body.jsonMode ?? action.json_mode) — the B3 guardrail
  reading two different facts; no overlay.
- **No-preset behavior (panel-forced definition):** an action with no ref AND an empty
  `default_preset_id` (only reachable for custom actions before assignment — every seeded action
  ships a ref) dispatches on the provider-default route with NO tunables sent (adapter/provider
  defaults apply) and think OFF. Params are never invented client- or server-side.
- DB policy: drop + reseed (pre-release; recap STANDING RULES) — schema changes are free, no migrations.

## The mint (generated from live seed data — 10 presets, 37 refs, 8 changed rows)

Bundles inherit the old family preset's top_p + samplers. `max_tokens` all 0 today. JSON stays on
the action (contract), so presets carry NO json field. Reasoning: "Grounded chat" think=on/medium
(the 2026-07-14 decision); all others think=off.

| New preset | top_p / samplers (inherited) | Actions @ temp (— = unchanged) |
|---|---|---|
| Generate prose | .95 / min_p .05, xtc .3/.1, dry .8 | continue, describe, expand, guided-continue @ 0.85 — |
| Edit prose | .90 / min_p .08 | 7 rule.* @ 0.6 —; **rewrite 0.7→0.6**; **tighten 0.5→0.6** |
| Ideation | .95 / min_p .06, xtc .5/.1, dry .8 | brainstorm, brainstormPlot @ 1.0 — |
| Grounded chat (think·medium) | .90 / min_p .05, rp 1.05/64 | chat @ 0.3 — |
| Character chat | .90 / min_p .05, rp 1.05/64 | characterChat @ 0.7 — |
| Grounded summary | .90 / min_p .05 | briefing @ 0.45 — |
| Structured extraction | .90 / min_p 0, seed 7 | 7 actions @ 0.15 —; **recap 0.2→0.15** |
| Structured creative | .95 / min_p .05, xtc .4 | unstuck @ 0.75 —; **sensory 0.8→0.75**; **marketingPack 0.5→0.75** |
| Judgment & scoring | .95 / min_p .05, seed 7 | plotHoles @ 0.3 —; **critique 0.4→0.3**; **voiceDrift 0.4→0.3**; **critiqueStructure 0.2→0.3** |
| Reader panels | .95 / min_p .05, seed 7 | 4 multiReader* @ 0.55 — |

**⚑ USER REVIEW at approval (fold/split as you like — the 8 bold rows are the only behavior
changes; every value is editable in-app afterward anyway):**
- ⚑1 `marketingPack` 0.5→0.75 is the biggest jump — fold as proposed, or split an 11th preset
  "Marketing pack" @ 0.5?
- ⚑2 The judge folds (0.4/0.2 → 0.3) — fold, or keep exact (splits "Judgment & scoring" into 2–3)?
- ⚑3 `defaultPresetId` seed (catches future/custom actions): lean **"Edit prose"**; alternatives:
  "Grounded chat", or empty (falls to provider-default routing with no params).
- ⚑4 Preset display names above — rename freely.

## Tasks (each = one Task entry; Opus-executable with acceptance criteria)

**T0 — Preflight audit (read-only; the fresh-audit discipline).** Re-grep BOTH repos for
`task_kind|taskKind|TaskKind`, `pins|setPin|resolve_pin`, `_effective_spec`, `FeatureSamplerParam`,
and the prompt param columns; diff hits against this plan's Deletion checklist — any extra consumer
gets a row in the build record BEFORE code. Build the per-action JSON-parser table from JW services
(`llmText.js` call sites + `services/analysis/*` + `writerAI.js`) and reconcile against the seeds'
`json_mode` (mismatches = flagged, not silently changed). Acceptance: checklist delta table + the
37-row contract table, both in the build record.

**T1 — Runner schema + stores.** `db.py`: DELETE `TaskKind` (:685-699), `FeatureTaskKind`
(:702-710), `TaskKindPreset` (~:655), `FeatureSamplerParam` (~:587); `feature_prompts` DROPS
`temperature/think/max_tokens/top_p/reasoning_effort` (KEEPS system/user_template/json_mode/
json_schema/label/description/subgroup/built_in); `EnginePreset` DROPS `json_mode` (contract moved);
`TestSample.task_kind` (:394) → `action_key` — **and its whole chain (panel finding):**
`TestSampleStore` (`stores.py:1263-1341` — `list_for_kind`/`upsert`/`seed_fill` all speak
task_kind) re-keys to action, the `test_samples_api.py` wire re-keys (`taskKind` field on
Row/Put + the `?taskKind=` query param → `action`). DELETE the **dormant legacy `FeaturePreset`
system** (panel finding — it stores tunables with ZERO live callers, violating the one-source
invariant; NOT the same object as `FeaturePresetRef`): `db.FeaturePreset` (:534),
`FeaturePresetStore`, `feature_presets_api.py` + its mount (`install.py:153`),
`test_feature_presets.py`. DELETE the JW-path pin plumbing (confirmatory-checker-verified JV-free):
`db.RoutingPin` + `RoutingStore._row_to_routing`/`_apply_routing` pin legs (`stores.py:118-143`);
the SHARED `FeaturePinConfig`/`LLMConfig.feature_pins`/`resolve_pin` tier is **KEPT** (JV-live —
JW just never populates `feature_pins`, a no-op; the `ProductionConfig` template).
`stores.py`: delete `TaskKindPresetStore` (:670), `TaskKindStore` (:735), `FeatureTaskKindStore`
(:791), the feature-sampler store, singletons + accessors (:1106, :1456-1459);
`_engine_preset_to_wire` (:590) drops json. Acceptance: `create_all`
boots a fresh DB; grep proves zero references to deleted names outside tests being rewritten in T8.

**T2 — Resolution + APIs.** `preset_resolve.py`: `resolve_feature_preset(key)` = ref → default
(dangling-ref fall-through kept, Unit-1 improvement); `resolve_task_preset` deleted.
`prompts.py`: `_effective_spec` (:483-500) DELETED — params come from the preset object alone;
`_effective_think` (:456-464) → preset.think AND NOT (body.jsonMode ?? spec.json_mode);
`_plane2_extra` drops the feature-sampler read (:415-418) **and repoints its top_p source
`spec.top_p` (:399) → `preset.topP`** (the preset is already passed in — panel note);
`install.py:156-157` `get_default`/`set_default` repoint onto the `default_preset_id`
RunnerSetting (the relocation above); `PromptUpdate` (:131-149) shrinks to
text + contract + nav (param fields GONE from the wire, not preserved); `resolved_route`
(:670-711): `taskKind` field dies, `presetSource` → `"assigned"|"default"`, **and it gains optional
`providerId`/`model` override params** (the user's decided cap-hint pick — mirrors RunRequest
:267-268) so a Lab column can ask for ITS pinned route's cap. `presets_api.py`: task-kind routes +
`AssignmentsResponse.taskKinds` die; `features` (refs) + `defaultPresetId` stay; `EnginePresetRow`
drops `jsonMode` (:52). DELETE `task_kinds_api.py` whole. `install.py`: task wiring + `_task_kind_of`
(:125-138, incl. the writerAI.rule prefix) die. `routing_api.py`: pins (:44-66) die; `group` stays — **plus JW's pin plumbing behind them
(panel finding, scope narrowed by the confirmatory checker):** `config_builder.py:20-27` stops
building `feature_pins`; `schema.py:47` `FeaturePinConfig` + `LLMConfig.feature_pins` (:93) are
**KEPT** (shared contract, JV-live; JW leaves `feature_pins` empty = no-op). `dispatch.py`:
`resolve_pin` **UNTOUCHED** — the preset's provider/model already flows via
`provider_override`/`model_override` in `run_feature` (`prompts.py:557-558,:581-582`), so the
pin tier simply never fires in JW; `_apply_reasoning` (U2) untouched. **Run path rewritten explicitly (panel finding):**
`run_feature`/`stream_feature` (`prompts.py:556-583, :611-645`) read EVERY param from the
resolved preset (no spec params exist anymore), honoring the no-preset rule above.
Acceptance: pytest T8 suites green; a run of `critique` dispatches the preset's params only;
resolved-route with `model=` override reports that model's cap.

**T3 — Seeds + resets (both repos).** Runner `seed.py`: `configure_app_seed` seam (:30-53) —
`taskkind_presets`/`feature_task_kinds` OUT, `feature_presets` (action→preset_id refs) IN;
`DEFAULT_TASK_KINDS` (:442) + seeders (:930, :942, :959) + task resets (:990-1026) die;
`reset_routing_to_factory` (:1002) → restore built-in presets + seeded refs + the
`default_preset_id` RunnerSetting (seeded per ⚑3); NEW per-preset reset (built-ins). JW `seed_presets.py`: the MINT table above (10 presets + 37 refs);
`FEATURE_TASK_KINDS` + `DEFAULT_TASKKIND_PRESETS` die; `DEFAULT_TEST_SAMPLES` (:203, **21 rows** — panel-corrected; the seed test in T8 derives its
expected count from the list itself, never a hardcoded number) re-key per ACTION — author each blob once, fan to sibling actions in the seeder (no copy-paste
rows). JW `seed_feature_prompts.py`: per-action param keys (temperature/top_p/think/reasoning)
REMOVED — rows keep text + json contract + nav. Acceptance: fresh-DB boot seeds 10 presets +
37 refs + samples; reset round-trip proven live.

**T4 — Unit-2 absorption.** The parked uncommitted U2 diff is the STARTING TREE (builders work on
top of it). CARRIES: `reasoning.py`, `reasoning_map_api.py`, reasoning db/stores columns + map
table, all adapter work (`anthropic/gemini/ollama/openai_compat/base`), `dispatch._apply_reasoning`,
engine bump b9993 + the key grep (`reasoning_budget_tokens`), `tests/test_reasoning.py`,
ConfigColumn REASONING_OPTIONS + stored-pair buildBody, FeatureLab `cfgToEnginePreset` think fix.
DROPS (superseded by this rewrite): the prompt-row think fallback in `_effective_think`/docstrings,
the p_chat one-shot migration (`seed.py:905-911` — moot, seeds rewritten), the slice-A
`columnConfig` patch (the Lab now edits presets directly), `seed_feature_prompts` think-comment
churn. Acceptance: reasoning pytest matrix green on the new resolution path.

**T5 — Kit UI.** MOCKUP-FIRST (design law): precedent = the existing master/detail shell
(`styles.css .lu-fw-*`). `TaskKinds.vue` → **Presets page**: list = presets w/ "used by N" member
counts; detail = params editor + members (move-to = write the action's ref; the QC-15 no-naming-
popup create form, QC-36 local undo, per-preset reset + reset-all all carry). `FeatureWorkbench.vue`:
the per-action Preset dropdown (U1-T8) becomes THE control; task dropdown + 3-tier
`featurePresetLabel` (:186-216) → "assigned"/"default"; nav untouched (group display-only :55-70).
`FeatureLab.vue`: `taskKind` prop dies (samples per action) **including its sample fetch
(`:143`) re-keyed to the action (panel finding)**; `productionPresetId` = the action's ref. `ConfigColumn/CompareStrip`: the column IS a preset editor — temp/top_p/max_tokens seed FROM
the preset (the flattening dies structurally); the JSON checkbox → read-only contract badge + an
ephemeral "test as JSON" toggle (exact form at mockup). `TuneMeasureModal.affectedTaskLabels`
(:171-182) → affected PRESETS + feature counts. DELETE `taskLabels.js` (one consumer),
`useRouting.setPin` (:55-58), `PromptLab.vue` + its export (`index.js:56`). Copy sweep: "Routing by
task" (4 sites), `useResolvedRoute.js:10` comment, chip tooltip. Acceptance: build:vite + FULL
smoke zero JS errors + a committed probe driving the Presets page end-to-end (create → assign →
member move → reset).

**T5 MOCKUP (design-law artifact, 2026-07-15 — precedent: the existing `.lu-fw-*` master/detail
shell, the QC-15 create form, the QC-36 local undo; build to this):**

```
┌─ Presets ─────────────────────────────────────────────────────────────────┐
│ ┌ list ────────────┐ ┌ detail ──────────────────────────────────────────┐ │
│ │ ＋ New preset     │ │ [Grounded chat____] ← name IS an inline field    │ │
│ │                  │ │ built-in · used by 1 feature   [Reset] [Delete†] │ │
│ │ ▸ Generate prose │ │                                                  │ │
│ │   used by 4      │ │ Features using this preset            (refs map) │ │
│ │ ▸ Edit prose     │ │   Ask the book                    [Move to… ▾]   │ │
│ │   used by 9      │ │   [＋ Assign a feature here… ▾]                   │ │
│ │ ▸ Grounded chat  │ │                                                  │ │
│ │   used by 1      │ │ Test & tune — THE one params editor              │ │
│ │  …               │ │ [FeatureLab full-width; its column SEEDS FROM    │ │
│ │ ↺ Reset all      │ │  THIS preset; "Update preset" writes THIS row;   │ │
│ └──────────────────┘ │  test-against = a member feature ▾]              │ │
└───────────────────────────────────────────────────────────────────────────┘
```

- **ONE params editor:** the Lab column (ConfigColumn, already becoming a true preset editor in
  T5) mounted in the detail pane IS the editor — the Presets page grows NO second standalone
  params form (a second form = the drift this rewrite kills). Create form (QC-15, in-pane, no
  popup): name only, Save disabled until named; a new preset starts with NO values set — a run
  on it sends no tunables (provider defaults) until the user sets them. Honest, never invented.
- Move-to / Assign write the action's ref (`PUT /preset-assignments/feature` — the U1 route);
  the member list visibly gains/loses rows (QC-37, no toast); QC-36 inverse-undo records both.
- **Delete** (user-created only): members re-float to the default preset; confirm names the
  member count. Built-ins: per-preset **Reset** (name + params + its seeded members return).
- "used by N" derives from the refs map; the empty state names the assign affordance.

**T6 — Chips + doorway (U2-T7 rebuilt on the new model).** `LuFeatureChip` opt-in edit popover
(`editable`, ChatPanel's two mounts first) edits **the action's preset** with the caption
"changes <preset> — used by N features"; cap/effective line from resolved-route (with the T2
override params when a Lab column pins); ProviderForm "Reasoning levels" table over the
reasoning-map endpoint; QC-43 any-write invalidation already covers refresh. Acceptance: chip
probe — edit level via doorway → resolved-route reflects it, every chip updates without reload.

**T7 — QuickSetup / modelApply.** Enumeration change only (verified: writes already target
presets): collect ALL built-in preset ids + `defaultPresetId` instead of walking `taskKinds`
(`modelApply.js:34-39`); keep-vs-overwrite semantics unchanged; embedding untouched (routing doc,
verified independent). Acceptance: b29-probe (set-as-default round-trip) green after repoint.

**T8 — Tests + probes.** Runner pytest: rewrite `test_presets` (ref/default resolution, dangling
fall-through, reset), `test_prompts` (params-from-preset-only, contract guardrail, PromptUpdate
shrink), delete task_kinds tests, carry `test_reasoning`; JW server: seed tests (mint counts,
refs, samples-per-action). JW vitest: `modelApply.test`, `resolvedRoute.test` (+ override params).
Probes: repoint switch/qc-quintet/b4/b5/b29/chip off task-tab markup; NEW presets-page probe (T5).
Acceptance: full fleet green, all counts recorded.

**T9 — Docs (same commits as the code).** `docs/models.md` + `docs/tasks.md` → the preset model
(one source, contract-on-action, the mint list); JW `CLAUDE.md` AI-section pointer; recap GO
paragraph; this plan copied verbatim to `just-llm-runner/docs/plans/2026-07-15-preset-one-source-
rewrite.md` (the FIRST execution act, per protocol); the 2026-07-14 plan doc gets a superseded-by
banner on its task-tier language (Unit-2 backend content stays authoritative).

**T10 — Gates + ship.** Per commit: runner ruff + pytest · JW server pytest + ruff · vitest ·
build:vite · FULL headless smoke zero JS errors · probe fleet · ONE genuine rules-checker diff
verdict. Push both repos ONLY on the user's word.

## T0 AUDIT RESULTS (2026-07-15 — ran on the user's go; BUILD TO THESE TOO)

The preflight audit swept all three repos and found **19 deltas** the checklist missed (3
boot-breaking) + **1 JSON-contract mismatch** + a clean JV shared-symbol sweep. Absorptions:

- **→ T3 (HIGH, boot-breaking):** the JW `install_llm` CALL SITE `justwrite-app/server/
  justwrite_server/app.py:169-195` (imports `DEFAULT_TASKKIND_PRESETS` :172 +
  `FEATURE_TASK_KINDS` :174; kwargs `taskkind_presets=` :187 + `feature_task_kinds=` :188)
  and the runner `install_llm` SIGNATURE params + pass-through (`install.py:73-74,93-94`) —
  both become the new `feature_presets` (action→preset_id refs) parameter.
- **→ T1/T2 (HIGH, boot-breaking):** the feature-sampler ROUTER — `feature_samplers_api.py`
  (whole file) + its import `install.py:27` + mount `install.py:249` — dies with its table.
- **→ T1:** dormant-FeaturePreset residue: package exports `llm/__init__.py:39-40,91`;
  stores singleton/accessor `stores.py:820,:1435`. And `EnginePresetStore.save`'s wire-IN
  json write `stores.py:647` (`row.json_mode = preset.jsonMode`) dies with the wire field.
- **→ T2:** `prompts.py:432-433` `_plane2_extra`'s `spec.reasoning_effort` read → the preset
  (verify the parked U2 tree's state first); docstring `presets_api.py:14`; the `task_kind=`
  param on `resolve_feature_preset_with_source` (`preset_resolve.py:58`); the then-unused
  `FeaturePinConfig` import `config_builder.py:13` (ruff).
- **→ T5:** `AiModelsArea.vue` residuals: `:507` "Also overwrite tasks I customized" copy,
  `:533-540` mount/comments, the `'tasks'` tab id.
- **→ T8 (tests/probes not previously named):** `test_shared_storage.py:92-108,155-190,
  203-308` (task-tier + JW-pin tests); `test_test_samples.py:29-76` (re-key to `action`);
  `test_routing_api.py:55-63` (pins wire assert); `test_feature_samplers.py` (delete);
  `test_plane2_params.py:17` (rewrite off the sampler read); `rag-probe.mjs:173`
  (reads `origAssignments.taskKinds`); `qc35-probe.mjs:44` (verify vs the reworked tab).
- **→ T9 (comment sweep additions):** `db.py:10,176,605` · `prompts.py:288` ·
  `testData.js:17` · `useResolvedRoute.js:25` · `QuickSetup.vue:19,23` ·
  JW `feature_catalog.py:6-7`. (KEEP `QuickSetup.vue:579` "per-feature pins" copy — shared,
  still true for JV.)
- **JSON-contract mismatch (⚑5, FLAGGED — not silently changed):** `voiceDrift` seeds
  `json_mode: True` but its prompt returns PLAIN PROSE and its consumer never parses
  (`voiceDrift.js:307,:318-323`). The seed CARRIES True (today's behavior, byte-for-byte);
  the user may flip it in-app or by word. All 36 other actions reconcile (18 JSON / 18 prose).
- **JV sweep: CLEAN** — zero JV usage of any deleted symbol; JV's only shared touchpoints
  are the KEPT pin contract (its own `feature_pins_api.py`, not the runner's JW-path
  plumbing). `OverviewView.taskKind()` is a JV-local helper, false positive.
- **Mint mechanics (build note):** keep existing preset ids where the family survives
  (`p_prose_voiced`, `p_prose_edit`, `p_ideation`, `p_chat`→"Grounded chat", `p_digest`,
  `p_extract`, `p_creative_structured`, `p_judge`); mint two new ids for the splits
  (`p_character_chat`, `p_reader_panels`). `default_preset_id` seeds `p_prose_edit` (⚑3 lean,
  built as approved).

## Deletion checklist (every consumer, verified this session)

Runner: 3 task tables + stores + accessors · `task_kinds_api.py` · `_task_kind_of` ·
`_effective_spec` · prompt param columns + their `PromptUpdate` fields · `FeatureSamplerParam` +
store + `_plane2_extra` read · pins JW-PATH ONLY (`FeaturePin` wire in
`routing_api.py:44-66`, `db.RoutingPin`, `RoutingStore` pin legs `stores.py:118-143`,
`config_builder.py:20-27` `feature_pins` build, kit `useRouting.setPin`) — the shared
`FeaturePinConfig` (`schema.py:47`), `LLMConfig.feature_pins` (:93), and `resolve_pin`'s tier
are **KEPT, not deleted** (JV-live; JW never populates them — the `ProductionConfig` template) · the dormant legacy `FeaturePreset` system
(`db.py:534` + `FeaturePresetStore` + `feature_presets_api.py` + mount `install.py:153` +
`test_feature_presets.py`) · `TestSampleStore` re-key (`stores.py:1263-1341`) +
`test_samples_api.py` wire + `run_feature`/`stream_feature` param reads
(`prompts.py:556-583,:611-645`) ·
`DEFAULT_TASK_KINDS` + 3 seeders + 2 task resets · comments `schema.py:88`, `routing_api.py:81` ·
**defaultPresetId storage RELOCATES** (not deleted): `TaskKindPreset[""]` row → `RunnerSetting
"default_preset_id"` — repoint `install.py:156-157` + the resolver default read + the reset write.
Kit: TaskKinds.vue (reworked) · FeatureWorkbench task controls · FeatureLab taskKind prop ·
`taskLabels.js` · `setPin` · PromptLab + export · TuneMeasureModal task lookup · copy sites (4×
"Routing by task") · `useResolvedRoute.js:10`. JW: `FEATURE_TASK_KINDS` · `DEFAULT_TASKKIND_PRESETS`
· prompt param seed keys · sample task keys · stale comment `routingBackend.js:6`.
JW renderer code: no FUNCTIONAL changes (verified); the stale comment `routingBackend.js:6` and
the renderer tests carrying task refs (`resolvedRoute.test.js:60,68-69`, `modelApply.test.js:38`)
are rewritten in T8 (panel wording correction — the work was already captured, the summary line
overstated).

## Verification (end-to-end, in-container)

Fresh-DB boot → 10 presets/37 refs seeded; `GET /v1/ai/resolved-route?feature=critique` →
presetSource "assigned", Judgment & scoring params; live curl a `chat` run → body carries preset
temp + think medium + `reasoning_budget_tokens`; Lab flow probe: open Critique → column shows the
PRESET's values → Update preset → **plotHoles' resolved route unchanged in every field except the
edited one** (the flattening regression pin); reset round-trips; full gate fleet.

## Out of scope

JustVoice (user's word) · per-chat ephemeral override tier · multi-select bulk assign (revisit if
family re-points get tedious) · json_schema/GBNF (#77) · the GPU-box acceptance runs (local High
chat stopping at the cap; new-Anthropic wire check) — they remain the user's box checks after ship.
