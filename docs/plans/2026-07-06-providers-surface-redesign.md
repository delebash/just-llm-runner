# Providers-surface redesign — five user decisions (2026-07-06 night)

> **STATUS: EXECUTING (go given 2026-07-06: "stop it a wste of time, just remove them add it
> tocurrent list, go ahead adn code go"). LIVE tracker — the per-item ✅ marks + the record at the
> bottom update as items ship.** Born from the post-plan-closure design round on the Providers &
> models screen (the user's live-app screenshot). Under the "do b" checker discipline: no
> pre-build agent check (grounding + an inline T1–T12 citation instead); ONE diff-checker verdict
> before the code commit.

## The decisions, verbatim (the user's words are the spec)

- *"1 keep gryphe and abliterateed huahau 27b, 2 your recommnedaiton, 3 include uninstall 4 C,
  list models we are seeding"* — answering the four-option design menu (C9 scope · rank honesty ·
  engine collapse · catalog embed/general design).
- *"see i know we have missed stuff i know i said remove defualt modles for provieder, so when
  you say we have nothing left i dont believe you"* → clarified: *"no default chat model like
  gpt-4o-mini, we pull model from provider once connected"* → *"just remove them add it
  tocurrent list"*. **Recording miss, owned:** that directive exists in NO plan/ledger/memory
  file (searched 2026-07-06: docs across all three repos + the memory dirs) — it was given in an
  earlier chat and never written down. This doc is now its record; the systemic rule stands
  (decisions land in docs the moment they're made).

## Item 1 — C9 trimmed (ledger edit) ✅ decided, doc-only

Candidate list narrowed to TWO: **Gryphe/Gemma-4-26B-A4B-StyleTune-V2** and
**HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP**. Dropped: the unsloth 31B dense
QAT and the HauhauCS 31B build. ⚠ INTERPRETATION NOTE: the user wrote "abliterateed huahau
**27b**" — no 27B exists in the candidate set; read as the **26B-A4B** ablated build (the user
consistently calls their 26B-A4B daily driver "27b"). If the 31B was meant instead, say so and
the ledger flips.

## Item 2 — rank honesty (the recommendation, taken)

The catalog's default sort claims "Quality" but orders by `quality_rank` — published
GENERAL-purpose benchmark standings (Qwen3.6's 8 is MMLU-Pro/IFEval/GPQA-cited; Gemma's 9 is
annotated reasoned-not-instrument-cited), which measure neither creative writing nor this box.
The user's lived result (Gemma best on the 2070S) exposed the dishonest label.

- Relabel: `SORT_OPTIONS` "Sort: Quality" → **"Sort: Benchmark score"** (LuModelCatalog.vue:44)
  + a title hint on the control: general benchmarks, not writing-specific.
- **"Recommended for this PC" badge** on the one chat row the auto-pick rule selects — the SAME
  rule QuickSetup applies (class-map first, §10 speed-floor fallback). The composed rule is
  EXTRACTED to `modelPick.js` as `recommendedModelId()` (one source); QuickSetup's
  `bestFittingId` (QuickSetup.vue:132-149) becomes a thin binding, LuModelCatalog renders the
  badge off the same call and gains `classPicks` from the useCatalogMeta destructure.
  **CHECKER CATCH (T2, folded):** the first cut fed the badge `useRunnerModels().vramMb` —
  which the /models endpoint sets to budget-aware REMAINING VRAM after the resident set — while
  QuickSetup feeds TOTAL card VRAM from /hardware; with a model loaded, the badge could mark a
  SMALLER class than the wizard picks, falsifying "can never disagree". Fixed: the catalog now
  reads `gpus[0].vramMb` from `/v1/llm-runner/hardware` (one rule, ONE input, both sites), with
  the catch recorded in the code comment; a failed hardware read degrades to 0 → the map yields
  "" and the §10 rule (fit-flag-based, VRAM-independent) still decides.

## Item 3 — engine panel collapsed + Uninstall

LuRunnerEngine.vue today stacks everything always-visible (status row · progress · error · log ·
"Loaded models" + VRAM · the two residency knobs · the Engine binaries drawer). New shape:

- **Compact header row always visible**: "Llama engine — Installed · b9870 · cuda12" (or "Not
  installed…") + actions: Install (when absent) / **Update** / **Uninstall** (new) / a Details
  chevron. Install **progress and errors stay OUTSIDE the collapse** — an in-flight install or a
  failure must never hide.
- **Details (collapsed by default)**: the log toggle, Loaded models + VRAM budget, the two
  residency knobs, the LuRunnerBinaries drawer. The B1 decision ("knobs editable BEFORE
  install") is preserved — Details opens regardless of install state; the knobs are gated on a
  click, not on `installed`.
- **Backend (new)**: `RunnerService.uninstall_engine()` (lifecycle.py, next to
  `install_engine` :405) — refuse while an install is in flight; `stop()` first (a running
  llama-server holds the exe open — Windows cannot delete it live); `shutil.rmtree` the pinned
  build's `binary_dir(cache_root, build)` (all per-GPU variants incl. the A3 fallback chain —
  that IS the engine; models in the HF cache untouched); reset `_engine_state`; return
  `engine_status()`. Exposed as `POST /v1/llm-runner/engine/uninstall` (api.py, next to
  :245). UI: confirm dialog ("Remove the engine binaries? Your models stay.") → POST → refresh.
  One pytest on the service method.

## Item 4 — catalog option C: the "Your setup" strip + embed/general split

The problem (user): nothing tells a manual user the app needs BOTH a general model and an
embedding model; embeds interleave with chat models in the rank sort. (QuickSetup already sets
both automatically — this fixes the manual Providers path.)

- **"Your setup" strip** above the catalog bar: two slot cards, driven by the already-shared
  `currentDefaultId` / `currentEmbeddingId` (modelApply.js — the same state the row badges use).
  General: the model's name, or "Not set — pick one under Chat & writing models". Embedding: the
  name, or "Not set — pick one under Embedding models". Each card carries a one-line job
  description (writes prose + chat / powers semantic search + grounded chat). Status only — the
  acting stays on the rows (no duplicate controls).
- **Split sections** inside the one table (section-header rows, same one-render-list pattern as
  the existing fit divider, LuModelCatalog.vue:74-81): **"Chat & writing models"** first, then
  **"Embedding models"**; the doesn't-fit divider logic preserved WITHIN each section.

## Item 5 — no hardcoded provider default models

Verified state: `PROVIDER_PRESETS` is ALREADY clean — `[label, baseUrl, providerType, isLocal]`
only (useProviderConnect.js:15-23), and the fetch-once-connected flow exists (probeModels /
listModels + the form's Fetch buttons). What still violated the directive:

- The two model fields render on the **local** provider form too (ProviderForm.vue:166-181 are
  uncondition­ed; the user: "the provider has two drop downs for picking these models but we dont
  user") — for local-llamacpp those slots belong to the catalog (the Item-4 strip + row buttons,
  QuickSetup). → both fields gain `v-if="!isBuiltin"`.
- The hint copy names hardcoded example models ("OpenAI: text-embedding-3-small · Ollama:
  nomic-embed-text", ProviderForm.vue:180) — the "gpt-4o-mini" pattern in copy form. → reworded
  to the fetch behavior, no model names.

Remote providers keep exactly: connect → Fetch pulls the live model list → the user picks.

**FOUND-AND-FIXED during verification (the REAL "them"):** the container screenshot of the live
provider list showed `chat: gpt-4o-mini · claude-haiku-4-5 · gemini-2.5-flash · deepseek-chat`
on the cloud rows — the SEEDED provider rows carried hardcoded `default_model` values
(`DEFAULT_PROVIDERS`, llm_runner/llm/seed.py:88-108). Those four prefills are REMOVED (the rows
stay — connect-ready endpoints only). Dispatch's `adapter.default_model` fallback
(dispatch.py:61,66,97,113) is untouched — it now simply stays empty until the user's fetched
pick writes it; a cloud provider gets traffic only via routing/pins that name a model, so the
empty window is the user's own pre-pick state, exactly the directive. Wire-verified after a
server restart + reset: `/v1/llm-providers` → 7 rows, **zero with defaultModel set**. Both
suites green after the change (runner 382 · JW server 76 — the gpt-4o-mini strings in tests are
request-payload fixtures, not seed assertions; none broke).

## Verification plan

Runner: ruff + pytest (+1 uninstall test). JW: build:vite + vitest + full headless smoke + the
QuickSetup probe (must stay 18/18 — `bestFittingId` behavior is unchanged by the extraction).
Live: engine uninstall round-trip against :17495 is NOT possible in this container (no engine
installed) — the endpoint is pytest-covered; the UX is a box check. Diff checker → commit (runner)
→ models.md + recap (JW) same series.

## ROUND 2 — user-filed todos (2026-07-06, filed mid-round-1, NOT started; each needs its own go)

The user's words, verbatim: *"todo · api key for online doesn't show save it should show hidden
input info instead of blank when you save provder after entering key · why does it say CUDA /
VULKAN do i have vuldan drivers installed or jsut cuda · quicksetup displasy bad info when know
models are available i deleted all models in catalog and it still says Embedding set to
qwen3-embedding-0.6b — runs on the bundled runner, downloads on first search/index. Per-feature
pins you've set stay as they are. and This machine is already set up — what Apply will change but
it cant be as all models where delete, if user deletes a model that is pinned in feature or task
what happens? · providers on built in move the install unistall update button to right of edit"*

1. **API-key saved indicator.** The key is write-only server-side, so the edit form re-opens with
   a BLANK field even when a key is stored — reads as "no key saved". Build: a masked
   has-key state ("•••••••• saved · Replace") instead of an empty input; typing replaces.
2. **Acceleration label clarity.** `AiModelsArea.vue:56` joins EVERY detected runtime
   (`h.runtimes` true-entries → "CUDA / VULKAN") — truthful (the one NVIDIA driver ships both
   APIs; nothing extra is installed) but reads as a question. Build: mark the ACTIVE backend
   (what the installed engine build uses) vs available, e.g. "CUDA (in use) · Vulkan available".
   (Question answered in chat 2026-07-06.)
3. **Dangling model references + QuickSetup stale-state honesty (the design decision).** Deleting
   a catalog model leaves routing.default.embeddingModel / task-preset models / feature pins /
   tune rows naming a model that no longer exists — QuickSetup then renders "Embedding set to
   qwen3-embedding-0.6b …" and the D4-1 "already set up — what Apply will change" changelist off
   those dangling ids (user repro: deleted ALL models, wizard still claimed both). What happens
   today: nothing validates existence — the pin/preset keeps the id and the next run fails at
   load time. OPTIONS (user picks): (a) block delete when referenced — "in use by …" + one-click
   repoint; (b) cascade-clear references on delete behind a confirm listing exactly what clears;
   (c) validate-at-read — QuickSetup/preview/strip/pins existence-check ids and render honest
   "was removed" states. (c) is needed regardless for imported/old DBs; (a) or (b) decides the
   delete UX.
4. **Engine actions on the provider LIST row.** Move/surface Install · Update · Uninstall on the
   Built-in row (right of Edit) in the providers list — NOTE the interplay: round-1 item 3 just
   put these on the engine panel header INSIDE the Edit view; this relocates/duplicates them one
   level up. Decide placement (row-only vs both) at build.
5. **QuickSetup scope clarity (THINK ABOUT, per the user — "not do yet").** User (verbatim):
   *"quick setup is really only for lamma.cpp i think we should make that clear maybe move it to
   that provider, is this correct we dont have any other provider tied to it even open ai local
   is not tied to it correct, maybe it should be, add to todo to think about, not do yet"*.
   FACTS (answered in chat): correct — QuickSetup configures the BUILT-IN llama.cpp runner ONLY
   (the C8 2026-07-06 user directive made it local-only; the "Run models with" selector + connect
   flows were removed); the "OpenAI-compatible (local)" provider (Ollama/LM Studio, :11434) is
   NOT touched by the wizard. To think through at pickup: (a) make the scope visible — e.g. move
   the Quick Setup strip INTO/ONTO the Built-in provider card instead of floating above the
   provider list; (b) whether openai-compat-local should participate (the wizard's value is
   hardware-fit + download + tune, which only the bundled runner exposes — an Ollama box manages
   its own models, so likely NO, but decide deliberately); (c) at minimum copy: "Quick Setup —
   sets up the built-in local engine."
6. **Add an existing models folder (THINK ABOUT — user, verbatim: "i think maybe we should be
   able to add a models folder, like if user alread has a hf model folder they can add it add to
   todo to think about").** Shape to think through at pickup: point the runner at an EXISTING
   Hugging Face cache (hf_hub layout — models.py already reads/writes that layout, so an
   alternate cache_root or a symlink may be nearly free) and/or a loose-GGUF folder (scan +
   register rows with facts read via gguf.py). Questions: one extra root or many; watch for
   moved/deleted files; how Add-model's quant detection composes; Windows path/permission
   reality. Related precedent: the portable data root (JW storage_relocate).

## ROUND 2 + FIT FIX — SHIPPED 2026-07-06 late night (verification WAIVED by the user)

**The user's process decrees, verbatim, both recorded:** *"fix it!!!!!!"* (the Fit scoring) and
*"do it all i am tired of dealing with this, dont do any test just code it, i will check, too much
time too many tokens"* — so this batch shipped with **build:vite as the only gate** (compile
clean, 3.1s); pytest/smoke/probe/rules-checker deliberately NOT run this round at the user's
explicit instruction; the user checks on their box. Earlier same-day rounds verified the
surrounding code fully.

1. **THE FIT FIX (api.py):** `get_models` scores Fit against the card's TOTAL VRAM
   (`max_vram_mb(hardware)`) — the former P2 §5c budget-aware scoring fed VRAM *remaining* after
   the resident set, so a sleeping model on the user's 8 GB box flipped EVERY row to "CPU" while
   the same screen's header showed the card (their reset-catalog repro). The response's `vramMb`
   now also reports the card (labels + tooltip agree). The `vram_mb` card-chooser override is
   unchanged. `service.remaining_vram_mb` (api was its only caller) deleted; the arbiter keeps
   `remaining_mb` for load-time decisions + the engine panel's VRAM line. The budget-aware test
   REWRITTEN as the total-card guarantee (a resident model must NOT change Fit) — 382 pytest ran
   green for THIS fix before the user's waiver arrived; user-confirmed on their box ("Fits"
   everywhere in their next screenshot).
2. **Wizard preselects the APPLIED model** (user: "if model is already applied then drop down
   should select that model"): after the wizard's three loads resolve, `pick.default` is set to
   the preview's `dominant` when it still exists in the catalog (re-opening the wizard proposes
   NO change; the recommendation is only the fresh-box fallback), and a routing embed pointing at
   a DELETED model falls back to the best fitting embed instead of silently preselecting a dead id.
3. **API-key saved indicator** (ProviderForm): the key is write-only server-side — the edit form
   now shows "•••••••• (a key is saved)" as the placeholder plus a "🔒 An API key is saved (never
   shown). Leave blank to keep it — typing replaces it." hint, instead of a blank field that read
   as no-key-saved.
4. **Acceleration label** (AiModelsArea): "CUDA (in use) · VULKAN available" — every detected
   runtime, the engine's actual backend marked first (priority = select_binary's order); a bare
   "CUDA / VULKAN" read as a question.
5. **Engine actions moved to the Built-in provider's LIST ROW** (right of Edit): Install /
   Update / Uninstall now live on the row via the NEW shared `useEngine` composable (module
   singleton — status + install/uninstall + busy/error in ONE place); LuRunnerEngine consumes the
   same state and keeps the status line, install progress/errors, and the Details drawer (its own
   action buttons removed per "move"; the panel and the row can never disagree).
6. **Dead-reference honesty on the "Your setup" strip**: an applied General/Embedding id that no
   longer exists in the catalog renders "<id> — removed from the catalog" with a pick-a-new-one
   hint (warn style), never the dead id as if fine. (The full dangling-refs decision — block vs
   cascade vs validate — remains the user's round-2 item 3 call; this ships the validate-at-read
   floor everyone needs.)

**NOT built (the user's own "not do yet" stands):** QuickSetup scope move (round-2 item 5) · the
models-folder import (item 6). **NEXT (user, same message):** the quick Qwen-vs-Gemma lineup
research ("did we determine qwen was better … make the gemma lineup instead of qwen, idk") —
research delivered in chat; the lineup does NOT change without the user's explicit pick.

## THE GEMMA-FIRST LINEUP — SHIPPED 2026-07-06 (post-midnight; the user's literal "go")

**Decision trail, verbatim:** research asked ("do a quick searh on the difference between the qwen
we have and the same type in gemma … make the gemma lineup instead of qwen, idk finish your tasks
first") → research delivered (published head-to-head is a 0.4-point tie on an adjacent task; the
user's measured on-box result is the only writing-task evidence) → *"1 26b-a4b qant, add gryphe
and ye"* → *"add auhauCS/Gemma4-26B"* → *"add Gryphe/Gemma-4-26B-A4B-StyleTune-V2 i dont think it
has ablated v2"* (correct — Gryphe is a style-tune, not ablated) → **PROCESS INCIDENT, recorded:**
the agent began building on the accumulated imperatives and the user stopped it — *"i did not say
go stop it"* — the #1 rule is LITERAL; trees were verified untouched; work waited → the use-policy
word: *"i want uncensored as option for fiction i dont want writers blocked when they have gory or
fantasy sex scenes"* → *"just go code it do it now"* + *"go"*.

**What shipped (runner seed.py DEFAULT_CATALOG — 11 rows, audit 12/12 incl. JW's extra):**
- ADDED: `gemma-4-12b-qat` (unsloth, UD-Q4_K_XL + MTP draft, apache-2.0, the small-card dense
  rung) · `gemma-4-31b-qat` (unsloth, UD-Q4_K_XL + MTP draft, apache-2.0, the 24 GB rung) ·
  `gryphe-styletune-v2` (**via mradermacher's quant repo — Gryphe's own repo ships NO GGUF and
  the "-GGUF" name 401s**; apache-2.0 through the full base chain, Q4_K_M, no MTP draft in the
  quant repo) · `gemma-4-26b-a4b-uncensored` (HauhauCS, Q4_K_M + in-repo MTP draft; **the repo
  declares `license:gemma` over an apache-2.0 Google base — honored as the repackager's own
  terms → use-limited flag + never-auto-default**, with the ruled-on discrepancy carried in a
  new per-row `license_reviewed` field the audit prints as a note instead of re-flagging; the
  seeded row carries the user's use-policy words in its comment).
- REMOVED: `qwen3-8b-q4_k_m` · `qwen3-14b-q4_k_m` · `qwen3-32b-q4_k_m` (the Gemma 12B/31B rungs
  cover those cards). KEPT: `qwen3.6-35b-a3b-mtp` (the one alternative MoE), Llama 70B, GLM-Air,
  all four embeds.
- CLASS MAP: `{6000: gemma-4-26b-a4b-qat}` — the user-tested pick; a host without JW's extra row
  (JustVoice) fails the map's exists() check and falls through to §10 → qwen3.6 there, graceful.
- RANKS (curated-for-writing, owner-tested basis): gemma-26b-a4b 5 (JW seed; was the
  reasoned-9) · 31b 7 · qwen3.6 8 · glm 10 · llama 11 · gryphe 12 · uncensored 13 · 12b 22 —
  community tunes deliberately BELOW the trusted auto-pick set until a Lab A/B earns them ranks.
- TESTS updated to the new truth (class-picks assertions → gemma; identity tests re-seated on
  the remaining dense no-MTP row, llama-70b; 14/14 green) · audit **12 rows, 12 OK, exit 0,
  live** · ruff clean. Full suites remain user-waived this round ("dont do any test just code
  it"); the audit IS the license/facts gate and ran.

## ROUND 3 — the user's disposition of the outstanding list (2026-07-06, verbatim: "1. a but if
## no models avalable does it default to start fresh, 4 what do you think 5 what do you think.
## 6 do, 7 do,8 park,9 park")

- **Delete policy = (a) BLOCK-WITH-REPOINT** + the user's empty-case rule: deleting a referenced
  model shows what uses it and offers a repoint; when NO eligible replacement exists it offers
  "Delete and clear" → references clear and the slots return to **Not set** (the fresh state).
  BUILD (this round).
- **4 (QuickSetup scope)** — recommendation delivered in chat: keep the wizard strip where it is
  (the first-run front door must not bury inside a provider card); add the scope words to its
  copy ("sets up the built-in local engine"). Await the user's reaction.
- **5 (models-folder import)** — recommendation delivered in chat: worth building as an
  Add-model "Import from folder" (scan loose GGUFs, read facts via gguf.py) — NOT cache-root
  swapping; park behind this round.
- **6 (A5, engine update detection) — DO:** GET /v1/llm-runner/engine/update-check (latest
  llama.cpp release tag vs the pinned build; fetch injectable — the container proxy blocks
  ggml-org, the user's box fetches direct), a Notify-default policy (off|notify, engine-config),
  the panel line "Update available · b9870 → bNNNN" + one-click bump (PUT pinnedBuild + force
  install). The pin-bump discipline note stands (asset names verified at install; A4's
  digest-capture rides any container bump later).
- **7 (D4-1 leg 3) — DO:** engine-presets rows gain `factoryModel` (joined from the app's
  registered seed library by preset id); the wizard's configured-detection gains the third leg
  (any preset.model ≠ its factoryModel counts as configured).
- **8 (Lab A/Bs) + 9 (D6 Discover/TurboLLM) — PARKED** (ledger stays the record).

## ROUND 3 — SHIPPED 2026-07-06 late (delete-guard (a) · A5 update check · D4-1 leg 3 · fixes)

Built on the user's dispositions ("1. a …, 6 do, 7 do, 8 park, 9 park") plus two live catches:

- **Install-progress consistency (user: "no progress bar on install engine please be
  consistant"):** polling moved INTO useEngine (module interval while installing, self-starting
  when any refresh finds one) and the Built-in LIST ROW renders the same UiProgress + error the
  panel does — one shared state, both surfaces. En route, a REAL runtime break shipped-and-fixed:
  the usePoll import was dropped while the resident poller still used it (user-reported
  ReferenceError) — restored in `999ab48`; **the smoke now runs on every UI change regardless of
  the verification waiver** (the compile gate cannot catch runtime references).
- **Delete policy (a) — BLOCK-WITH-REPOINT:** deleting a referenced model now checks live
  references (task presets by model + the embedding slot). Replacement available → ONE dialog
  ("in use by N task presets and the embedding slot — they'll be re-pointed to <best same-kind
  fitting model>") → re-point (full-row PUTs, settings preserved) → delete. NO replacement →
  "Delete anyway" keeps the references (**presets have no "none" state — the user's catch**;
  the validate-at-read layer labels the dead id "removed from the catalog"); only the embedding
  slot can ever truly clear to Not set.
- **A5 — engine update detection:** `GET /v1/llm-runner/engine/update-check` (latest ggml-org
  release tag vs the pinned build; the fetch is injectable — the dev container's proxy 403s
  ggml-org, verified live, and the endpoint reports that as `error`, never as a false
  updateAvailable) · `updatePolicy` ("off"|"notify", default notify) on engine-config
  (runner_setting-backed) · the panel status line gains "update available → bNNNN" · the
  Built-in row's Update button becomes **"Update to bNNNN"** (accent2) when one exists — the
  deliberate click PUTs the new pin then force-reinstalls (the acquire path verifies asset
  names; the A4 digest-capture rides container bumps later) · an "Engine updates" Off/Notify
  select in the panel Details. NEVER auto-applies (the verified-pin discipline). +2 tests → 384.
- **D4-1 leg 3 CLOSED:** engine-presets rows carry read-only `factoryModel` (joined from the
  app's registered seed library by id at list time); applyPreview's configured-detection gains
  the third leg (any preset.model ≠ its factoryModel) — the uniformly-re-pointed-untuned box no
  longer reads as fresh. The Phase-2 honest-omission comment replaced by the working code.
- **The wizard probe REWORKED to the new truths** (it FAILED honestly first): scenario 1 asserts
  the preselected APPLIED model (Gemma) and NO changelist when the pick IS the applied model;
  the changelist assertions moved to the TUNED (= configured) scenario via a real Reka-select
  pick switch to the Qwen alternative; the tunes stub now serves empty rows in the untuned
  scenario (the preselect change made the live gemma tunes suppress auto-start by design).
  Round-3 gates: ruff · **384 pytest** · build · FULL smoke zero-JS · **probe PASS**.

## ROUND 4 — SHIPPED 2026-07-06 (the Built-in card polish + the GPU requirement)

User directives, verbatim: *"put it in center on same line as /v1 remove the text Qucik Setup and
just ave the button with text to the right it pops out at you, change Built-in (llama.cpp) to
Built-in server -- llama.cpp, in quick setup popup change Recommended setup to Recommended setup
-- for local built in server only, Below that line put Requirements: Video card with at least 8GB
VRAM and 32GB of System RAM, personally even though some models technically can run on cpu, for
our use case i dont think we should support it it would be to slow, do you agree? Remove header
Local LLM"* + *"remove (docs/plans/2026-07-06-llamacpp-config-tuning-2070s.md)."* + *"yes on
embeding"*.

- **Run Quick Setup = just the button, centered on the Built-in card** level with the /v1 line
  (QuickSetup gains a `buttonOnly` prop — bare regular-size primary; the strip stays the default
  for other mounts; an absolute overlay so the row grid is untouched).
- **Provider renamed** in the seed: "Built-in server — llama.cpp" (existing DBs keep their name
  until a reset — merge-by-key never clobbers).
- **Wizard modal**: the "Local LLM" eyebrow REMOVED; title → "Recommended setup — for local
  built-in server only"; a requirements line above Detected: "Requirements: a video card with at
  least 8 GB VRAM and 32 GB of system RAM."
- **CPU-only chat UNSUPPORTED (agreed, with the user's "yes on embeding" nuance):** chat-model
  picking now uses FIT_GPU = {ok, tight} — the wizard's candidates, its auto-pick, the class-map
  fits() and the catalog's Recommended badge can never land on a CPU-spill model; the wizard's
  empty state states the requirement; EMBEDDINGS keep the CPU band (fittingEmbeds — tiny models,
  deliberately CPU on the user's own box). The catalog still LISTS everything with honest Fit
  labels; only auto-pick/support changed.
- **Gemma catalog description**: the internal doc path dropped from the user-facing copy.
- Probe: GPU-shaped hardware/models stubs (the container has no GPU and chat picks now require
  one — the page sees a probe 8 GB card; expectations updated). Gates: build · smoke zero-JS ·
  probe PASS.

## ROUND 5 — SHIPPED 2026-07-06 (measurements out of the seed; the sweep-parity experiment armed)

The design conversation (user, verbatim anchors): *"dont let me push you in a direction, think
about how it worsk and what it should be"* → the principle: **the seed ships facts and rules;
the machine supplies measurements; the pair (model × machine) owns the numbers** → *"one is a
cap not dont think at all"* (reasoning-budget ≠ the think toggle — a per-taste bound on
think-enabled tasks, not a rule) → *"i agree it should not be a defualt seed for everyone …
let me test the tunning with that model and see what happens, go ahead and make your code
changes firt"*.

1. **Tune rows OUT of the product seed** (JW seed_presets/app.py, commit `8ed7481`): tunes are
   measurements — never seeded. The discovery that forced it: the seeder stamped rows with
   WHATEVER machine ran the seeding, so "inert on other boxes" was false. The author-box values
   move to `scripts/dev-seed-tunes.py` (PUTs via the Tune-modal endpoint; the SERVER stamps the
   running box's fingerprint). Live-proven: reset → 0 gemma tune rows → script → 6 flags under
   the running machine's key.
2. **reasoning_budget OUT of the base bundle** (runner seed.py, commit `81694b6`): a per-taste
   bound on think-enabled tasks (the per-request toggle is the on/off mechanism — a different
   thing, the user's point); the 1024 was the author's own latency preference, not a rule. The
   knob stays in knob_catalog (default -1) for per-model use.
3. **THE EXPERIMENT (user's box, next):** pull + reset → run Quick Setup on the Gemma → with no
   seeded tunes the sweep AUTO-STARTS → compare its saved values + tok/s against the hand-tune
   (ngl 99 · ncmoe 21 · ctx 32768 · batch 512/512). Parity → the class-seed question dissolves;
   miss → hardware-class starting values return WITH evidence (the user's observation that the
   values also held on the Qwen 32B MoE is recorded as transferability evidence). The user
   doubts the sweep will match — that doubt IS the test.
4. Gates: ruff · switch_resolve 7/7 (base-set assertion updated) · JW server 76 pytest · the
   live reset/restore cycle. NOT built (awaits its own go): the empty-model factory seed.

## ROUND 6 — SHIPPED 2026-07-06 (catalog-full / selections-empty: the factory state)

**The user's definition, verbatim (correcting the agent's "empty-model seed" label):** *"we are
shipping with models, just no model is automatically set as default, honestly not even embed
should be set, this is all quick setup or manual"* → go given ("go"), with the standing
save-and-compact directive ("we need to save everything and compact when you get to stopping
point").

**What shipped:**
1. **JW task presets ship with EMPTY model slots** (seed_presets.py — all 8; every per-task
   SETTING still seeds: temps, samplers, json, think). The catalog itself stays FULL (the
   Gemma-first lineup + Qwen alternative + embeds, all downloadable).
2. **The routing row seeds with NO choices** (runner seed.py `seed_default_routing`): llmId,
   embeddingId, embeddingModel all empty — supersedes #120's seeded embed default AND the old
   `openai-compat-local` LLM default. The row itself still seeds (the idempotence anchor).
3. **Dispatch guards the pre-setup state** (dispatch.py, BOTH the run and stream finalization
   points): a resolved empty model now raises "No model is set. Run Quick Setup (Settings → AI)
   to pick one for this machine, or choose a model in the catalog (Set as default)." — guidance,
   never a raw provider error.
4. **Tests re-seated to the new truth**: test_shared_storage's routing assertions → empty
   selections (the #120 test renamed `test_seed_routing_ships_no_selections` with the decision
   quoted); suite 384 green + ruff clean + JW server 76 green.
5. **Live-proven on the wire** (post-restart + reset): preset models all "", factoryModels "",
   routing llm/embed all "" — then build clean · FULL smoke zero-JS · wizard probe PASS
   (scenario 1 = the fresh box: the wizard preselects via the RECOMMENDATION (map → Gemma) since
   nothing is applied; no changelist — honestly nothing to change; Apply makes Gemma dominant,
   which is exactly what scenario 2's configured-box assertions then exercise).

**The fresh-install/reset experience now:** strip shows General: Not set · Embedding: Not set →
Run Quick Setup (one click fills both + offers the sweep) or manual Set-as-default /
Set-as-embedding per row. Nothing is ever chosen by the seed.

**Adjacent decisions this round (all shipped earlier tonight, recorded here for the compact):**
reasoning_budget out of the base bundle (a per-taste bound on think-enabled tasks, not a rule;
knob stays in knob_catalog) · tune rows out of the product seed (measurements, owned by the
(model, machine) pair) · `scripts/dev-seed-tunes.py` KEPT as a MANUAL-ONLY tool (user: "keep it
in seed i can run manually" after first rejecting hidden automation — it never runs
automatically) · the tiny CPU test model lives ONLY in `scripts/dev-seed-test-model.py`.

**THE PARITY EXPERIMENT (user's box, next):** pull both repos → restart → reset → Run Quick
Setup on the Gemma → the sweep AUTO-STARTS (no seeded tunes) → compare its saved values + tok/s
against the hand-tune (ngl 99 · ncmoe 21 · ctx 32768 · batch 512/512). Parity → the
hardware-class-seed question dissolves; miss → class starting values return WITH evidence (the
user's Qwen-32B-MoE transferability observation is on record). To restore the hand values
afterward: run scripts/dev-seed-tunes.py manually, or re-enter in the Tune modal.

## ROUND 7 — EXECUTING 2026-07-06 (Built-in card polish + optimize-progress clarity + the hardware-change notification)

**STATUS: EXECUTING on the user's literal go — verbatim "plan and code it all" (2026-07-06),
following a post-compact chat round where the user reviewed the live Providers screen and gave a
batch of card + optimize-UX corrections plus a new notification design. LIVE tracker; the shipped
records land at the bottom of this section as each of the two commits (card tweaks, then the
notification) goes in. Checker discipline unchanged (the "do b" rule): no pre-build agent check —
grounding + inline T1–T12 before building, ONE diff-checker verdict before each code commit.**
Verification posture this round: the user said "no test for now" earlier and then "plan and code
it all"; per the STANDING amendment (the usePoll runtime break) the headless smoke RUNS on every
UI change regardless of any waiver, plus build:vite and a live curl of any new endpoint (the
anti-stub floor the user's rules 4/7 demand). The heavier pytest/probe suites stay waived unless a
change demands them.

### The decisions, verbatim (the user's words are the spec)

The correction thread opened with the Quick Setup button on the Built-in card. The user, verbatim
across several messages: *"you dont listen I asked for the orginal text to be to th right of the
button"* → *"quick setup button so people know what it does"* → *"leave out the all editable"*.
Owned miss: in ROUND 4 the agent read the user's "just have the button with text to the right" as
the button's own label and shipped `buttonOnly` as a bare button (QuickSetup.vue:392), deleting
the description that still sits one branch down at QuickSetup.vue:396. The fix restores that
description — "Detect your hardware, pick the best free local model that fits, and set it as your
default." with the trailing "— all editable" clause removed per the user — placed to the RIGHT of
the button.

On the optimize/tune sweep the user asked, verbatim: *"so when if goes to tuning that needs to be
obvious what it is doing Optimizing — trying n-cpu-moe 21… (2 trials done) is small the skip is
small"* and *"Optimizing — trying baseline… is there any realisic way to give a time estimate to
completion? if not a best guess to let user know just text may take 2-4 minutes depending on
hardware"* and *"are at least something moving to show it is still working"*. Answer given in chat
and recorded here: a reliable completion ETA is NOT possible (the sweep prunes weak configs and
backs off on OOM, so the trial count flexes and a countdown would mislead) — so the sweep gets a
STATIC hint "Typically 2–4 minutes, depending on your hardware", a live elapsed mm:ss timer
counting up, the indeterminate UiProgress bar (always animating — the "something moving"), and the
trial count it already reports. If the runner auto-tune status turns out to carry a planned trial
total, the trial line upgrades to "trial N of ~M"; that is verified against the runner payload at
build, not promised ahead of it. On the Skip/Cancel question the user asked *"if i choose skip does
it cancel auto tune, what happens if it hit cancel? … we need a cancle for optimization process"*
then, after learning Skip already IS the cancel (QuickSetup.vue:367-370 → POST
/v1/llm-runner/auto-tune/cancel, stops after the trial in flight), decided verbatim *"2 dont
rename … i think leave as is keep autotune running in background"* — so Skip keeps its name and
its behavior, closing the wizard leaves the sweep running server-side, and the only change is to
make the existing Skip prominent (it was a tiny ghost). Also verbatim: *"remove this Change the
model for any single task on the Tasks tab."* — delete QuickSetup.vue:531.

On the engine Update button the user, verbatim: *"that update button just say update avail change
the button color not actually but use our style system, move the update button next to the llm
icon"*. Read as: relabel the button to "Update available" (from "Update to bNNNN"), recolor it
through a kit INTENT rather than a hardcoded color (currently accent2/gold; the recommendation
taken to the user was `info`, the informational blue — awaiting no objection, applied as the
default with the version number preserved in the hover title), and move it out of the right-side
.lu-prow-actions cluster to sit next to the LLM capability tag in .lu-prow-name.

The new feature — the hardware-change notification — was the user's own design for the re-tune
discoverability gap the agent raised (there is no explicit "your hardware changed, re-optimize"
affordance; re-tuning is only reachable by re-running Apply or opening the per-model Tune dialog).
The user, verbatim: *"i think just a message pops up with choice rerun quick setup as new model
may be availabke for your hardware or retune exisitng model for hardware preset changes, something
like that and you can enable disable notification in settings"*, then the dispositions: *"counts
as changed just gpu vram"* (the fingerprint compares GPU name + VRAM only, not cores/RAM),
*"appears dismissinle toast"* (a dismissible toast, not a modal), *"4 yes"* (fire once per detected
change, then stay quiet — persist an acknowledged fingerprint), and *"no notifications live in app
settings add this to todo for later"* — READ AS: the enable/disable toggle for the notification
belongs in App Settings and is DEFERRED to a later todo, so this round ships the toast + the
detection now (fires once per real GPU/VRAM change, dismissible) and parks the on/off setting. The
two toast choices are Re-run Quick Setup (a better-fitting model may now exist for the changed
hardware) and Re-tune the current model (re-run the sweep for the new machine); both reuse existing
flows (the wizard and the auto-tune sweep), so the only genuinely new machinery is: remember the
last-acknowledged hardware fingerprint, compare it on load, and show the toast. The design
consciously MIRRORS the existing engine-update off|notify policy (the A5 pattern) — the deferred
settings toggle will be its sibling.

### The plan (what each change touches — verified against the read files)

Card tweaks (all in the shared kit, JW consumes via alias; JustVoice untouched by the standing
mandate — the change is additive/cosmetic to a shared trigger):
- QuickSetup.vue — import UiProgress; add an elapsed-timer (optElapsed ref + a 1s interval started
  when the sweep begins running, cleared in stopOptPoll/onBeforeUnmount) and an optRunLabel
  computed (detail + "trial N"); rewrite the optRunning block (:506-512) to the prominent moving
  form (title + elapsed + indeterminate UiProgress + the 2–4 min hint + a prominent secondary
  "Skip"); delete the trailing line (:531); rewrite the bare branch (:390-399) to button +
  description-minus-"all editable"; rename the prop buttonOnly→inline (accuracy) and add the CSS
  for the new blocks.
- AiModelsArea.vue — the update button (:221-224): "Update available" label, intent info, build
  number kept in the title; relocate it next to the LLM cap tag in .lu-prow-name (:203); update the
  QuickSetup mount (:237) to the renamed `inline` prop.

The hardware-change notification (kit + a small runner backend):
- Runner backend — persist the acknowledged hardware fingerprint as a runner setting (reuse the
  runner_config_api / RunnerSetting pattern that already backs update_policy + pinned_build); a
  get/set path so the client can read the last-acknowledged key and write the current one on
  dismiss/action. Confirm the /v1/ai/model-tunes endpoint scopes to the current machine (the
  re-tune trigger relies on it) while in that code.
- Kit frontend — on AiModelsArea mount, compute the current GPU+VRAM fingerprint from
  /v1/llm-runner/hardware, compare to the stored acknowledged key; if different, push a dismissible
  toast (the kit toast host) offering the two choices; on any choice or on dismiss, write the
  current fingerprint as acknowledged so it fires once. The enable/disable App-Settings toggle is
  the deferred todo.

### Parked / deferred this round (recorded so it is not lost)

The App-Settings enable/disable toggle for the hardware-change notification (user: "add this to
todo for later"). It will sit beside the engine-update off|notify control and share that shape.

## ROUND 8 — PLAN: the hardware-class tune library (autotune reframed) + the queued card tweaks

**STATUS: PLAN, written for the user's go (2026-07-06). Nothing here is built yet EXCEPT the
Round-7 QuickSetup progress-UI edits under Task D (compiling, uncommitted). Awaiting the literal
"go" before any of A/B/C/E is built.**

### Why this exists — the decision trail (verbatim anchors)

Round 7 built a good progress UI for the autotune sweep, but running it on the user's box exposed
the real problem [user, verbatim]: *"6 trials 12 minutes still going this is not acceptable
esecially for a quick setup, maybe for the tune tab or lab, we need to find another way or better
way to auto tune without the long wait for quick setup 2 mins is ok especially if we can really
get a good performance boost"*. The sweep is inherently slow — each `n-cpu-moe` value is a launch
flag, so every trial fully unloads/reloads the model (`autotune.py`: up to `_WALK_MAX_TRIALS = 12`
trials, `_LOAD_TIMEOUT = 240s` each); there is no fast version of a *measured* MoE sweep.

The user then closed a contradiction the design had carried [verbatim]: *"funny you mentions the
only reason to run [re-tune] is if hardware change like vram or cpu or ram, yet you keep telling me
my manual tunning for my 8gb card 32gb ram ryzen card wouldnt be good to have for other users with
similar systems, you kept saying let autotune do it, but by your own comment similar systems
should already have similiar defaults"*. This is correct: if re-tuning is only needed on hardware
change, the tune is a FUNCTION of the hardware, so a measured tune for one box is valid for every
box of the same class. Round 5's "never seed measurements" was an overcorrection to a MIS-KEYING
bug (the seeder stamped rows with whatever machine ran it); correctly keyed by the hardware they
were measured on, tunes ARE portable. Keystone then set [verbatim]: *"for now tune-only maybe
enhancment later"* — the library holds the TUNE only; quant/draft stay on the catalog row; a
unified {quant+draft+tune} row is a future enhancement — and the library is EDITABLE [verbatim]:
*"maybe this should be editable you can add other hardware configs you get from other users, maybe
or i guess or manually tune in lab"*.

### The design — a class-tune resolution layer (reuses switch_resolve)

The current `model_tunes` table (`db.py:280`) is keyed by the EXACT machine fingerprint `hw_key =
gpu|vram|cores|ramGB` and resolves as the top layer in `switch_resolve.resolve_model_switches`
(base bundle → type bundle → computed → HardwareSwitch → ModelTune wins). The class-tune library is
a NEW layer that sits BELOW the exact-machine ModelTune and ABOVE computed:

  base → type → computed(fit) → **class-tune (seeded + editable, keyed by VRAM+RAM class)** →
  HardwareSwitch → exact-machine ModelTune (measured here) → wins

So a box that matches a seeded class row gets the tuned config AUTOMATICALLY at model-load through
the normal resolution — no sweep, instant. A box that has run its own sweep keeps its
exact-machine tune (more specific, wins). A box with neither gets the computed fit config (runs,
just unmeasured). **class_key** = a coarse bucket, VRAM band + RAM band (e.g. `vram8|ram32`),
derived from `hardware` — the "similar systems" the user means; NOT the full fingerprint (GPU
name/cores are excluded because placement is set by memory fit, which VRAM+RAM determine; GPU
compute changes the tok/s achieved, not the optimal placement).

### Tasks

**A. Backend — the class-tune library layer.** New `class_tunes` table keyed by (model_id,
class_key), rows mirroring `model_tunes`' flag rows (no FK on class_key — a free bucket string like
hw_key). `hardware.class_key()` helper (VRAM band + RAM band). Insert the class-tune lookup into
`resolve_model_switches` between computed and HardwareSwitch/ModelTune. Seed row #1 = the user's
measured gemma tune (ngl 99 · ncmoe 21 · ctx 32768 · batch 512/512 · embed ngl 0) under
{vram8|ram32} for gemma-4-26b-a4b-qat — CORRECT to ship this time because it's keyed by the class
it was measured on and matched by class, not stamped by the seeder's machine (the Round-5 bug).
CRUD `/v1/ai/class-tunes` for the editable library. Tests: resolution order (class-tune applies,
exact ModelTune overrides it), class_key bucketing, seed present.

**B. Quick Setup — instant apply, no auto-sweep.** Remove the auto-start in `QuickSetup.vue
apply()` (the `if (target && !tunedAlready) startOptimize()` line). The class-tune, if the box
matches, is already in the resolved switches at model-load — instant. Done step: if a class-tune
matched, "Tuned settings for your hardware were applied"; if not, the computed-config state + an
"Optimize in the Lab" pointer (the no-seed path — leaning Lab per "manually tune in lab"; a short
capped ~2-min sweep here stays an option if the user prefers). The "Optimize for this PC" button
stays as a DELIBERATE action.

**C. Lab / Tune tab — the sweep's home + the editable library.** The full measured sweep (with the
Round-7 progress UI) lives here as a power feature. "Save as hardware-class default" on a result →
writes a class-tune row for the box's class. The editable class-tune library table (add/edit/delete
rows; import a config from another user).

**D. The card tweaks (Round-7 batch).** BUILT + compiling (uncommitted): QuickSetup progress UI
(elapsed/trials/close-guard), bare mode (button + caption minus "all editable"), removed the
Tasks-tab line, prop rename buttonOnly→inline. Still to build: Update button (`AiModelsArea.vue:221-224`)
→ "Update available" label, intent accent2→`info`, build number in the title, moved next to the LLM
cap tag in `.lu-prow-name`; MTP checkbox bug — `onDraftPick` (`LuModelCatalog.vue:268-273`) sets the
draft file but never checks `mtp`, contradicting the "auto-enables MTP" note → set mtp=true on a
non-empty draft pick + reflect on open; MTP-draft dropdown already works after Read-from-link (the
repo's 4 MTP quants are detected — live-verified) → auto-load the listing on Edit-open (non-blocking)
so Quant + Draft are pickers without the click.

**E. The hardware-change notification.** gpu+vram fingerprint change vs a persisted acknowledged key
(runner setting, reuse the update_policy pattern) → dismissible toast ("Re-run Quick Setup" /
"Re-tune in the Lab"), fires once per change; its re-tune path writes a class-tune. Settings
enable/disable toggle DEFERRED (App Settings todo).

**F. Verify + docs + commit.** Per commit: build:vite + headless smoke (mandatory UI gate) + live
curl the new class-tunes endpoint (anti-stub, rules 4/7). Ruff + the affected pytest for the
backend. Update this doc + the JW recap in full detail. Diff-checker before each commit. Logical
commits: (1) card tweaks + MTP fixes, (2) class-tune library backend + Quick Setup instant-apply,
(3) Lab library UI + notification.

### Open / deferred
- Unified {quant+draft+tune} per-class config — future enhancement (user: "tune-only, maybe
  enhancement later").
- No-seed fallback in Quick Setup: BOTH — ship computed defaults + a Lab pointer AND an optional
  time-boxed ~2-min quick tune (the same autotune sweep with a `budget_seconds` cap; self-diagnosing
  — a null result routes to the Lab). User confirmed "both lab and 2 min sweep".

### GO — EXECUTING (2026-07-07, user's literal "go")

Decisions LOCKED from the on-box tune review (the user's real `.ini` configs are the source of
truth — the recap summaries were shown unreliable this round):

- **BOTH `context_shift` AND `cache_reuse` come out of the base bundle** (`seed.py:234-235`), not
  just context_shift. The user's Gemma config documents it verbatim: *"context-shift / cache-reuse:
  tested 2026-07-06 and NOT added — Gemma 4's iSWA context does not support KV shifting or prefix
  reuse (llama.cpp auto-disables both with a warning)."* Their Qwen config omits both too. Neither
  is a safe universal default → they stay per-model knobs in knob_catalog. Base bundle becomes
  `{flash_attn=on, cache_type_k/v=q8_0, mlock=true}`.
- **The class-seed for {gemma-4-26b-a4b-qat · VRAM 8 GB / RAM 32 GB} = the user's exact hand-tune,
  n_cpu_moe = 21 (NOT the sweep's 23).** The sweep overshot to 23 (two more expert layers on CPU —
  safer, slower); the user's comment: *"floor at 32k ctx w/ CPU embed; 20 OOMs."* Full row:
  `spec_type=draft-mtp · spec_n_max=2 · n_gpu_layers=99 · n_cpu_moe=21 · ctx_len=32768 ·
  cache_type_k/v=q8_0 · no_mmap=true · mlock=true · cont_batching=true · batch_size=512 ·
  ubatch_size=512 · threads=8 · reasoning_budget=1024` (kept as the user's safety cap) — and NO
  context_shift / cache_reuse.
- **Why the sweep never fully reproduces the hand-config** (recorded for the design rationale):
  `ngl` is fit-derived (MoE pattern = ngl-max + n_cpu_moe; only n_cpu_moe is the free dial),
  `ctx` is a capacity choice not a speed knob (but it's coupled — the user's own note: ncmoe 20@8k /
  21@32k, so the sweep must tune n_cpu_moe AT the target ctx), `threads` measured flat
  (`autotune.py:18-19`). So the class-seed (the full 15-switch config) is the reliable path; the
  sweep is optional polish.

Building this go (fixes 1-3 of Task D + Task A): (1) drop both switches from the base bundle; (2)
surface `n_cpu_moe`/`ctx`/`batch`/`ubatch`/`threads` in the Tune grid; (3) the class-tune library
(new `class_tunes` table + `class_key()` + resolver layer + CRUD + the seed above). The already-built
QuickSetup progress-UI edits (Task D) commit in the same series. Task B (Quick Setup instant-apply /
remove auto-start), Task C (Lab library UI), Task E (notification), and the Update-button relabel/move
remain queued for a follow-up go.
