# TASKS — the live open-work tracker (just-llm-runner: kit + shared server)

> **THIS is the live tracker for the shared stack** — created 2026-08-04 by the docs
> campaign (`just_ai_i18n_docgen/docs/plans/2026-08-04-docs-cleanup-campaign.md`),
> per the family convention (`docs/app-structure.md` §13). One line per open item +
> a pointer to its detail doc. **Close = delete** — git and the plan docs keep
> history. **An item lives where the code that closes it lives** — kit/shared-server
> work HERE; app work in `../justwrite-app/docs/dev/TASKS.md` /
> `../JustVioce/docs/dev/TASKS.md`. A tracker line is a claim, not evidence.
> Items extracted from plan docs are marked **[verified]** (code-checked at
> extraction) or **[attributed]** (the plan doc's claim, not re-verified).


## THE THINKING GATE + THE TIER SUBSYSTEM — BOTH DEAD (kit record)

The capability gate was built 2026-08-06 (`def5142`) and REMOVED the same
day by the user's ruling ("no fancy magic" — honest provider errors + one
fix-pointer sentence). The tier-debris cleanup (approved 2026-08-07,
decision text in `../JustVioce/docs/dev/TASKS.md`) then excised the whole
tier subsystem: `tiers.py` and `capability.py` deleted, dispatch's
tier-derived think fallback deleted (no explicit think = off — the preset
is the ONE thinking control), the caller-less classify-tier endpoint
deleted, the `tier` slot off FeaturePinConfig/ProductionConfig and
resolve_pin/resolve_route, the catalog `thinking` column + Thinks tag +
row-editor checkbox + seed heuristic deleted. JV owns its route floors
locally now.

## THE FAMILY PARITY BATCH — SHIPPED 2026-08-06 (all twelve slices)
- The master plan + its BUILD LOG (deviations, guard-caught bugs, end-gate
  results): `../justwrite-app/docs/plans/2026-08-05-family-parity-batch.md`.
  What remains open is the after-batch order recorded there: JV UiTable
  convergence → JV e2e harness → THE deep exhaustive audit → product calls,
  plus the user's QC walk with the acceptance checklists.

- **test_hardware.py::test_pci_gpus_linux_lspci_name_match fails with OSError
  on this box (2026-08-05 late), on clean HEAD too** — environmental (the
  Linux lspci path under Windows), not code; the same suite was green earlier
  the same night. Diagnose or mark it skip-on-windows.

## Found by the 2026-08-05 family audit [spot-verified by hand]

- **`GET /v1/ai/knob-catalog` silently strips `backends`** — stores serves it per
  knob row for "friendly KnobGrid metadata" (`stores.py:1449-1466`) but the wire
  model `KnobMeta` (`knob_catalog_api.py:23-32`) doesn't declare the field, so
  Pydantic drops it — the exact silently-dropped-field class this repo already
  documented at `model_catalog_api.py:140-148`; the UI can never gray out
  backend-inapplicable knobs. Its test asserts the stores dict, not the HTTP
  shape — which is why it stays green.
- **"llm/ must not import runner/" is violated five ways** (`seed.py:18`,
  `identity.py:21-22`, `reasoning.py:89-93`, `stores.py:831,1492`,
  `cache_api.py:25` — all module-level) while `dispatch.py:37-38` and
  `switch_resolve.py:48-50` still state the invariant; either fix the imports or
  fix the claim.
- **Promptless run-route test gaps (the 2026-08-04 change is SOUND; pin it):**
  `/v1/ai/stream` promptless parity untested; promptless + `jsonMode:true`
  (`_response_format(None,…)` → json_object) unpinned; `_effective_think(None,…)`
  unpinned; `RunRequest.history`/`_history_messages` has ZERO tests on either
  endpoint; the feature_key fallback's ledger/route side-effects unasserted.
  Wire limitation recorded: promptless can never get schema-enforced JSON
  (RunRequest carries jsonMode but no jsonSchema).
- **Adapter drift set:** ollama comment claims think-blocks are stripped, code
  returns content verbatim (`ollama.py:147-149`); the legacy `/api/embeddings`
  fallback posts OUTSIDE the try so transport errors escape the RuntimeError
  contract (`ollama.py:236-243`); `adapter_http_error` claims one D10 format
  while openai_compat + ollama hand-build the same strings in three places;
  anthropic's legacy budget enforces only the max_tokens half; openai_sdk's
  stream ignores `response.incomplete` (truncated stream ends silently with
  zero token counts, unlike the non-stream `finish="length"`).
- **Stale class-key format in five places** (README:23, db.py:401,425-427,
  class_tunes_api.py:8-9, switch_resolve.py:17, install.py:57-58) — the real
  format since 2026-07-22 is `dgpu-vram<V>|ram<R>` / `igpu-mem<M>` /
  `unified-mem<M>`; `parse_class_key` knows no `cpu|` form.
- **`tokenize` vs `measure` residency-authority split** — measure got the
  2026-07-21 router-authority fallback; tokenize still refuses on the stale
  internal ledger (`lifecycle.py:1327-1343` vs `:1287-1305`).
- **Docstring drift set:** RunRequest temp/think comments predate the preset
  tier; reasoningEffort vocabulary missing xhigh|max; schema.py points at a
  nonexistent `prompts._resolve_preset`; lifecycle names `start_runner` as the
  seam (it's `start_router`); `Overrides.reasoning_budget` still documents the
  retired launch flag; arbiter's `remaining_mb` cites the reverted §5c consumer;
  `reset_feature_ref`'s docstring contradicts its own inline ruling.
- **Promptless-mode retirement (kit half)** — rides docgen's
  template-convergence item (decided 2026-08-05 s2; the item lives in
  docgen's TASKS): FeatureLab's promptless machinery, the Workbench preview
  plumbing + zero-actions drop (FeatureWorkbench.vue:59-60), §11's
  two-kinds section rewritten to ONE kind; `dataLinks` KEPT.
  **CARVE-OUT approved 2026-08-08:** the preview door survives SOLELY for
  composed-call parents (JV's dictation cleanup, nothing else) — full text on
  docgen's retirement item; the redesign decision text is in git (the
  2026-08-08 "cleanup redesign" TASKS commit; built + closed same day). (The shared
  hard gate is DONE 2026-08-05 s3: render() was silent-empty and now FAILS
  LOUD — MissingTemplateVariables naming every key, both run routes → 400,
  union across system+user via _render_pair; five incomplete-variables
  tests fixed in runner+JW that the silence had been hiding.)
- **Half-built surfaces with no caller anywhere** (decisions, not deletions):
  the `/v1/ai/model-list-rules` editor trio; test-samples PUT/DELETE;
  switch-presets DELETE; preset-assignments/clear-features; the pre-router
  `Runner`/`start_runner` spawn API; `LoadRequest.job_id`; arbiter snapshot
  reservations nobody reads.
- **README staleness:** frames the family as two apps while docgen is the
  standard's reference implementation; the "not yet proven from a non-JustWrite
  host" caveat is stale (docgen booted the stack live 2026-08-02/03);
  app-structure §11's FeatureWorkbench line number drifted (235→238).

## The family docs standard — DECIDED 2026-08-08

### Each app writes its own help pages; the kit holds one mechanism reference

STATE: DECIDED 2026-08-08 — the user took the recommendation ("your rec go")
after three adversarial passes. An earlier pass recommended a shared master with
copy-sync; that was **reversed** and is recorded under NOT so it stays reversed.
WHY: every documented failure is one a shared master would NOT have caught —
JustWrite documents Quick Setup twice in its own repo (`ai-providers.md` §Quick
setup for local AI + `models.md` §Quick Setup), JustWrite has no `ai-features.md`
and no troubleshooting page at all, JustVoice's `mcp-server.md` was factually
wrong until 2026-08-04, and one concept carries four names across three apps
(`providers.md` / `ai-providers.md` / `ai-setup.md`). Cross-app prose drift never
appeared in the failure record. Naming, coverage and accuracy did.
NOT — shared page FILES hosted in the kit and globbed at runtime: docgen extracts
`lede:`/`hints:` from ONE `docsDir` per project (`extract.py:80`), so a kit-hosted
page could never carry a localized lede.
NOT — a kit master copied into each app and hash-checked: forces app-neutral
prose ("your features" instead of naming them), makes a one-sentence JustVoice fix
a cross-repo edit against the standing docs law, and grows an exception list the
moment one app needs a variation.
BUILT: the shared Help viewer already takes each app's own glob + toc
(`ui/src/common/services/helpDocs.js:37-44`) — no viewer change is needed for any
of this.
OPEN: (1) the kit's mechanism reference — `docs/feature-model-system.md` is the
seed and does not yet cover routing, presets, thinking or Quick Setup; app pages
get written against it, and it is dev-facing, never shipped to users. (2) the
naming + coverage standard: one slug per concept present in every app · a slug
means the same thing everywhere (JustVoice's `presets` renames — render presets
there, the LLM preset bar in JustWrite) · named toc groups in a fixed order · one
topic, one page, per app. (3) the check that enforces (2), reading filenames,
`toc.json` and H2 headings — no hashing, no sync.
GO: given 2026-08-08. Order: the check first, then fix what it reports, worst app
first.

## Now / near-term

### The AI-call convention's streaming lane + the install-progress bridge

STATE: OPEN — the user's NAMED next work (2026-08-08, at the convention's go:
"after this we will look at engine install and vram arbiter"); no go yet.
WHY: the convention shipped family-wide 2026-08-08 (lane 2B — JSON responses
carry usage, every app on `withAiTask`/`runAiEndpoint`, check 11 at zero;
git holds the build record). Two deliberate remainders: long pipelines still
give no LIVE progress (attribution's minute-plus waits are the case), and an
engine install's download percent reaches the Engines card but not the strip
(installs moved lifecycle-only by the approval's scope note).
NOT: frames/SSE everywhere — overbuilt; 2B covers one-shots (ruled at approval).
BUILT same session (2026-08-08): (a) `stream_action` beside `run_action` on the
extracted `_resolve_action` core (the /stream route rides it too — its inline
copy died); JV's `stream_feature` → `analyze_scene(on_delta, on_progress)` →
`POST /v1/scenes/{id}/analyze/stream` speaking the family frames, driven by the
kit's new `runAiEndpointStream` (requestStream now resolves the FULL done frame,
`done` flag stripped; llmUiUrl passes absolute URLs). (b) the bridge —
`setProgress(done, total, text)` grew the optional text (strip+panel render it),
and SpeechEnginesTab mirrors the job task's bytes + the ONE shared caption into
the panel for installs AND loads. Tests: 3 SSE server tests (JV 426 pytest),
kit 773, JW 573, JV 48 vitest, smoke 15/15, check-family zero.
GO: given 2026-08-08 — *"fix engine install streaming lane and any others of
your rec"*; the my-rec riders fixed at approval: `requestStream` resolves the
FULL done frame (additive — usage fields stay top-level) so a pipeline's domain
result rides the stream's end; a `runAiEndpointStream` runner beside
`runAiEndpoint`; attribution is the one 2A conversion (discover/smart-assign
stay 2B — short calls). After this the user's named STOP: the VRAM think
(JV TASKS carries it), no arbiter build without its own go.

### The install contract — one runbook a human and an AI can follow

STATE: DECIDED 2026-08-08 — *"do we have a contract for how to install
llmrunner both server and client side that a human and ai can understand, so in
a new project both ai and human can read doc and understand how to install; if
doc doesent exist it should be in dev docs in llmrunner"*.
WHY: app-structure.md §8 covers adopting the stack but as part of the
build-a-family-app narrative spread across §1–§12; nothing is the ONE
sequenced install runbook for dropping the stack into a project.
NOT: duplicating §8's depth — the runbook is the SEQUENCE with cites into
app-structure for each step's detail, code-verified (function names, args).
BUILT same session: `docs/dev/install-runbook.md` — both halves as ONE
sequence, every function name and argument verified against the code
(`install_llm` at `llm_runner/llm/install.py:250`, `installLlmUi` at
`ui/src/installLlmUi.js:91`), the storage caveat and the editable-install
lesson carried, "done when" = §12's boxes + a clean check-family run.
Linked from app-structure §8's head.
GO: given 2026-08-08 (same word) — built.

- **`UiSelect` has no option groups [verified 2026-08-08, JV-driven]** — it takes a
  flat `options: [{label,value}]` and renders one `v-for` over `normalized`
  (`ui/src/common/components/UiSelect.vue:21-40,101`), so a consumer cannot group a
  long list. Found in JustVoice's import-format picker: eight adapters doing three
  different jobs (a book, a line list, timing data from an audio editor) read as a
  grab-bag, and grouping is the fix — *From JustWrite · Books · Scripts and line
  lists · From audio tools · Advanced*. Deliberately NOT done as a JV one-off: form
  primitives come from the kit, and a local grouped select would fork the primitive.
  Scope: accept `[{label, options: […]}]` alongside the flat form (Reka supports
  `SelectGroup`/`SelectLabel`), leaving every existing caller untouched. Gates all
  three app suites. **GO: needed.**
- **Engine-cache `replaceBuild` deletion guard [verified live 2026-08-03/04]** — with
  a SHARED family cache, the update path's build-folder cleanup would delete builds
  under ANOTHER app's directory; guard deletion to the app's OWN cache root.
- **Silent update-check failure [verified]** — a failed GitHub check on AI-page mount
  is swallowed (no error state, unauthenticated call every mount); surface it (kit).
- **Phase 5 — residency knobs BEFORE engine install [verified]** —
  `ui/src/components/LuRunnerEngine.vue:275` still gates `modelsMax`/idle-sleep
  behind `v-if="installed"`. Plan: `docs/plans/archive/2026-07-05-model-surface-build.md`.
- **Phase-4 remainder — auto-composed model description [attributed:
  2026-07-05-model-surface-build.md]** — never built.
- **SVM remainder — CORRECTED (docs campaign): P4 is NOT open.** The design doc's
  header ("P4 NEXT, needs a fresh go") was stale — the implementation doc records
  **4a SHIPPED + VERIFIED** and **4b CLOSED-DROPPED** ("not deferred"). What
  genuinely remains: the two on-box checks (P3 §3d end-to-end · P1g router-flag
  confirm). Design distilled: `docs/dev/serving-design.md`.
- **`test_llm_dispatch.py::test_think_is_sent_even_to_a_known_nonthinker` fails
  when the FILE runs alone** (RuntimeError "LLM storage not configured",
  db.py:667 via the reasoning-levels path) but passes in the full suite —
  order-dependent storage wiring, identical on clean HEAD (verified via stash
  A/B, 2026-08-08). Wire the file's own storage fixture or accept and note it.
- **Multi-click unload/reload — observe once, REPORT BACK, don't fix blind** (the
  load-cancel plan's own Q3 ruling): one timestamped observation decides between
  (a) the router lock, (b) UI refresh racing the poller, (c) idle-sleep timing.
- **Stopping a host server can ORPHAN its router child on Windows** (holds :8080;
  the on-box A/B incident) — candidate fix: Job-Object/process-group teardown in
  the spawn path.
- **T5 — real VRAM-load percentage [attributed:
  2026-07-17-load-cancel-and-one-progress-control.md:149 "NOT BUILT"]** — the load
  bar's model-load leg has no true progress source.
- **I2 — cloud prompt caching: research pass, then the user's build/skip call**
  [verified 2026-07-26: the Anthropic + Gemini adapters send no caching hints].
  Output = a recommendation with numbers. Ledger §I2. (Moved from JW's tracker.)
- **Big-batch triage DONE (docs campaign 2026-08-04)** — the 510 KB doc's header
  was stale: B2-9, DL-2, B5-4, the QC clusters and E2 all shipped per its own build
  records; batches 4-6 have nothing open. The genuinely-live extractions became
  lines here and in JW's tracker (§7.1 sub-questions, I1 follow-ups, the doorway
  label, the box checks); the doc is banner'd + archived.
- **llama.cpp adoption review is stale** — `docs/llama-cpp-watch.md` last reviewed
  2026-07-14 (b9993); the CUDA Q2_0 watch item (#25707) has never been re-checked.
  Trigger phrase: "check llama.cpp since our last update".

## Box-gated / parked (wakes on a trigger)

- **CPU-only band box test** — `docs/plans/2026-07-19-cpu-only-band-test.md` is a
  RECIPE with an empty results table; needs the 2070S/32 GB box. A band product
  decision is blocked behind it.
- **Upstream WATCH: `--fit` silently kills Gemma-4 MTP drafts** (llama.cpp #24350;
  `--fit off` is the verified cure; our fit-by-omission placement walks into it) —
  re-test on a build newer than b10107. (Moved from JW's tracker.)
- **Model watchlist:** Harrier-27B (MIT, no GGUF yet) · KaLM-Gemma3-12B embed trial
  when the 32 GB card arrives. (Moved from JW's tracker; Ternary Bonsai lives in
  IDEAS with its trigger.)
- **D5 — remote curated model catalog** — PARKED by the user's word, shape recorded
  (ledger §D5). · **D6 — in-app HF "Discover" surface** (ledger §D6). ·
  **I3 — Apple-Silicon fit/tune refinements** (needs a Mac; ledger §I3).
- **LICENCE flag** — Gemma-ToU propagation matters only if weights are ever BUNDLED;
  the user's call then. · **Provider SDK pivot re-opens only if funded keys appear**
  (OpenAI/xAI/Mistral ship wired, live-unverified — "close 3 i dont have keys").

## Fit redesign — one physical fit truth (family-wide, runner-owned)

PLAN: `docs/plans/2026-08-09-fit-redesign.md` — the FULL design, evidence index
(file:line + probe numbers), verified consumer map, DECIDED rulings (§8, incl. the
user's 2026-08-09 "your rec" on regeneration precedence / speed thresholds / VRAM
ladder / kind column), the DO-NOT list (§10 + §13.14), and the 8-phase order (§11).
Designed 2026-08-09 in a full adversarial session; that session was cut off,
recovered from its transcript 2026-08-13, and the passes CONTINUED to FULL
CONSENSUS — the closed amendments are §13 (read WITH the sections they amend), the
corrected speed constants §5.5 + Appendix B, the reasoning record
`2026-08-09-fit-redesign-debate.md`. ALL rulings DECIDED — §8.17–23 (§9 empty;
§8.23 = verdicts inform never gate, the picker veto dies in Phase 3 per §13.16).
EXECUTE AGAINST THE PLAN, do not re-derive. Each phase needs its own literal "go".
Phase 0 GO GIVEN 2026-08-13 ("then code") — quick lane: RAM gate via snap_ram_gb
TEMPORARY per §13.5 · a<=0 guard · quant re-read + stale token · >=4-bit fallback ·
ctx cap 32768 + GUI.
Downstream: JV's VRAM wiring waits on Phase 5 (its claim-line sources are what this
fixes; claim shape {vram_mb, ram_mb} + provenance decided §13.1/§13.12, RAM
display-only §8.18); JW seeds regenerate (DECIDED §8.19: facts columns incl. the three
KV scalars, not floors) + classMembership re-validation with the user.
