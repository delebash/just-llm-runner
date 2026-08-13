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

**STATUS NOW (2026-08-13 — READ THIS FIRST on resume):**
- **ALL BUILD PHASES (0–7) ARE BUILT, GATED, COMMITTED, PUSHED.** The
  per-phase records below (in order: 0 · 1 · 2 · checkpoint round · 3 ·
  polish · executor choices · checkpoint list · 4 · 5 · checkpoint walk
  round 1 · the topology-aware probe · 6 · 7) carry the full detail —
  what each phase changed, why, the test lessons, the honest limits.
  Nothing is code-mid-flight. The standing fit-architecture story now
  lives in `docs/dev/serving-design.md` (the §7.6 one-authority section) —
  point people THERE for how fit works; the plan is the history.
- **THE DESKTOP CHECKPOINT IS CLOSED (user, 2026-08-13: "flaghsip works,
  tune and measure works" — at the Phase 7 go).** Final state of the six
  points: (1) CLOSED — the flagship reads ~fine after the probe-factor fix
  AND the Tune & measure flip works (measured tok/s replaces the estimate,
  ~ drops). (2)/(3) laptops NOT walked (user: desktop only for now — at
  their pace; the budget line there should read "Memory", the E4B should
  read Fits, and each box's `__machine_ram_bw__` probe row is worth a
  glance). (4) probe-row sanity RESOLVED on the desktop (19.01 row,
  calibrated, topology-aware); laptops when walked. (5) knobs round-trip +
  Save toast DONE. (6) the data reset DONE (JV + JW).
- **Phase 6 BUILT on "compact complete go"** (the joint MoE solve + shed
  direction + physics draft charge + the §7.2/§13.9 gates — record below).
  The untuned computed split now AGREES with the measured tunes (ngl=all,
  ncmoe 22 on the author's class) instead of the inverse's ngl 8-9.
- **Phase 7 BUILT on "go phase 7"** (the §7.3 uncurated-path gate + the
  launchable pin · §7.4-as-ranking via the new `ranHere` wire bit · the
  §7.5 pin audit (all four already existed) · the §7.6 docs pass — record
  below).
- **NEXT = the laptops walk at the user's pace · then the JV VRAM-wiring
  go (its registration points are in JV's tracker item; no kit
  prerequisite left).**
- **JV's VRAM wiring is UNBLOCKED** (Phase 5) — its own go required; the
  registration points are stamped in JV's tracker item.

Phase 0 BUILT 2026-08-13 (go: "then code"), all five items: RAM gate via snap_ram_gb
(TEMPORARY per §13.5, comment marks it) · a<=0 guard in estimate_vram_mb · quant
re-read + stale token + name snapshot-compare (LuModelCatalog) · >=4-bit fallback
(q4OrBetter on quant rows + pickDefaultQuant in draftSelect.js) · ctx cap 32768
(config/schema/stores/seed/api + compute_fit min-arm + GUI field in LuRunnerBinaries).
Gates: kit ruff clean + 787 passed/10 skipped · JW test:fast 128 passed (one
PRE-EXISTING stale test fixed: test_routing asserted the retired feature_pins attr,
kit 1952c6a) · i18n real-MISSING 0 · headless smoke PASSED (all routes, 0 JS errors).
JW user docs updated (models.md: quant fallback + auto re-read; engine settings gain
the cap). COMMITTED + pushed 2026-08-13 (user: "commit everything" — one commit,
both streams: lifecycle.py entangled Phase 0's cap edits with the eviction seam).
Phase 1 BUILT + COMMITTED 2026-08-13: `fit.kv_exact_mb` (uniform-exact KV, §5.1's
one-KV-source) · `fit.physics_vram_mb` (device weights × placement share + KV share
+ per-backend overhead seed, `PHYSICS_OVERHEAD_MB` — cuda=_C5, others documented
seed-guesses until Phase 5 learns them) · `hardware.active_backend` · compute_fit's
FORWARD BOOKING switched to physics (regression stays: CI oracle §7.1 + the
ngl-inverse until Phase 6; the DRAFT charge stays on calibrated marginal_vram_mb —
Phase 6 owns both) · the ARCH ARM: one-pool boxes (iGPU w/ GPU row, macOS even
without one — GPU-less Win/Linux stays the CPU path) budget ctx from the POOL
(Mac ctx-4096 clamp dead), default ncmoe 0 (the measured igpu truth), booking
capped at the ledger until Phase 4's arch-aware snapshot. Tests: the oracle
(physics/regression ∈ [0.95,1.15] on the dense domain, measured 1.016–1.088) ·
the physics gold pin (flagship config ∈ [6.5,7.9] GB measured window) · the
§13.10 arch matrix slice · kv/physics units · one literal re-pin (6432→5545,
the intended booking switch). Gates: ruff clean · kit 794 passed/10 skipped ·
JW test:fast 128 (no renderer files touched — smoke not required).
Phase 2 BUILT 2026-08-13 (go 2026-08-13; closed same day pending only the
user's data reset) — the stage record:
- A-1 DONE + committed: the nine facts columns on model_catalog (additive, in
  _ADDED_COLUMNS) + `identity.physics_facts_from_meta` (Wb/Gb walk pinned
  BYTE-IDENTICAL to kv_mb_at_ctx by test_physics_facts_reproduce_kv_mb_at_ctx).
  Columns are DORMANT until A-2 wires writers — tracked in-flight state.
- A-2 + A-3 + C DONE + committed: writers write facts (set_derived + inspect →
  form PUT `physicsFacts` dict ↔ the nine columns, one mapping in stores;
  `identity.computed_row_numbers` + `kv_mb_from_facts`); `_catalog_to_wire` is
  THE one door — chat rows with facts get floors/est computed FRESH (raw), the
  runner's badge + embed guard consume the same values via catalog_fn; EMBEDS
  keep curated floors; factless rows fall back (fidelity ladder). Floor-rule
  seeded facts landed (`floor_ctx_tokens` 4096 §8.21 · `ram_headroom_mb` 4096
  §13.13, additive rows). Form floor INPUTS retired for chat rows (embeds
  keep; read-only computed line instead); inspect fill is embed-only now.
  Tests: computed-fresh store test + facts-byte-identity pin. Gates: ruff ·
  796/10 · JW test:fast 128 · smoke PASSED.
- B + A-4 DONE + committed: refresh-seed-facts extended (nine facts + JV
  source `JV_MODEL_CATALOG`) and RUN LIVE against HF — all three seed files
  carry facts (26B numbers match the probe: share 0.9389, 30 layers, window
  1024); curated CHAT floors DELETED from both app seeds (16 keys JW, 6 JV;
  the three JW embeds keep theirs); seeder maps facts (+ fill-empty for
  existing DBs); the Phase-0 snap RETIRED (coarse_fit raw-to-raw; rung tests
  replaced — the legacy-rung cost pinned visible); display ladder shipped
  (`ui/src/fitDisplay.js` §8.15, snap-UP display-only; Needs line + form use
  it, hover keeps raw). Gates: kit ruff+796 · JW test:fast 128 + smoke PASS ·
  JV server 469.
- Post-B check DONE: embed-guard decisions UNCHANGED at 8/16/24 GB (est
  17,713→16,143: 8 GB → CPU, 16 GB → 241 MB leftover < embed floor → CPU
  (the 2026-07-25 proof case holds), 24 GB → GPU both ways).
- MEMBERSHIP BLESSED (user 2026-08-13 "your rec" → plan §8.23a): 7/8 sets
  identical; GLM's ram64 loss accepted (stays in catalog, per-box badge,
  runnable §8.23). classMembership.test.js FLEET = the computed floors now
  (JW c4ec055; 14/14 + test:fast 128). PHASE 2 CLOSED pending the user's
  DATA RESET (stale rung floors misread until then — accepted §13.5).
- THE CHECKPOINT ROUND (2026-08-13, live with the user — four bugs caught,
  all fixed+pushed; detail in commits 8977e83/5cc1a7a/171fe4c/f970060):
  (1) q4OrBetter was WIRE-STRIPPED — RepoQuantRow never declared it, Pydantic
  extra="ignore" dropped it, the ≥4-bit fallback saw undefined → IQ1_M again;
  fixed + the quant-row wire-guard test (the draft rows' guard's missing twin).
  (2) The quant pick learned the FAMILY ORDER (user-ruled): fitting branch =
  largest ≥4-bit that fits (sub-4-bit NEVER default even when it fits — the
  ghost's third life, on ≥12 GB cards); floor branch = K/UD family first
  (unsloth _XL beats _M inside a 15% size window), IQ4 only when the repo
  ships nothing else; six scenarios pinned in a node check + models tests.
  (3) The borrowed-MTP arm: a quant-flip re-read mistook the BORROW for an
  own draft and auto-armed MTP; "own" now means present in THIS repo's
  listing. (4) The tier-C probe proposed an 18 GB FULL MODEL as a "drafter"
  (see the variant-repo knowledge below) — _gguf_drafter_in_repo caps picks
  at 4 GB (_DRAFTER_MAX_BYTES; real drafters are 150-750 MB). Plus: the
  Needs hover now leads with the RAW computed floors and survives a
  class-less model (GLM lost its tooltip when it left all classes).
- KNOWLEDGE (verified by full structural header walks, keep — it answers
  "why doesn't my Qwen have MTP"): Qwen3.6 MTP is BUILT-IN single-file
  (qwen35moe.nextn_predict_layers=1 + blk.N.nextn.* tensors), BUT unsloth
  publishes TWO variants per model: plain `<name>-GGUF` = heads STRIPPED,
  `<name>-MTP-GGUF` = heads preserved (the seeded 27B row already uses the
  -MTP repo; bartowski's plain repo preserves heads). The user's original
  35B repro used the stripped variant — the app read it truthfully.
- CHECKPOINT STATE: desktop DONE (quant pick ✓ · 35B via the -MTP repo
  detects builtin-MTP ✓ · GLM row + hover ✓ · membership blessed).
  REMAINING: the laptops glance (E4B must read Fits on the 16 GB iGPU) ·
  the user's data reset.
- PHASE 3 BUILT 2026-08-13 (go: "compact complete go phase 3") — speed
  bands + badge display (feasibility × band SHIPPED TOGETHER §8.3) + §8.23
  veto removal (§13.16) + §13.17 GUI pins + measured-replaces-predicted.
  §13.17 AMENDED at the go (user, verbatim: "move the margin and cap nd
  the new fields under loaded models where Models kept loaded at once
  live, not under engine binaries") — margin + ctx cap + band thresholds +
  RAM headroom live in LuRunnerEngine's knobs group (the Loaded-models
  card), LuRunnerBinaries keeps only pinned build + URL rows. The build:
  (a) fit.py speed physics — active bytes/pass (Appendix-B pins 871+836 /
  6716) · kv_mb_from_facts RELOCATED here (identity delegates, one source)
  · speed_bytes_split (canonical placement, one-pool, dense spill, no
  budget → all host) · predict_decode_tok_s (serial pool sum, err-slow; a
  byte-carrying pool with no bandwidth → None, never a guess) · speed_band.
  (b) runner/bandwidth.py (NEW) — the §5.5 ladder: measured-derived
  (config-known, un-sped, backend+machine-matched; flagless NEVER
  qualifies §13.14) → device-reported (nvidia-smi bus×clock×2 = 448.06 on
  the 2070S; Apple chip table; RAM copy probe persisted as measurement row
  __machine_ram_bw__, Clear-history → re-probes §8.22) → class-seeded
  (hardware_classes +vram_bw_gbps/+ram_bw_gbps additive, JEDEC/vendor-
  cited slowest-common-card seeds, class-editor fields, ensure() seeds).
  Efficiency families runner_setting bw_eff_device 0.6 / bw_eff_host 0.15
  (§13.8 err-slow; source-1 bypasses). Metal one-pool = device family,
  iGPU/CPU = host family. (c) the wire — ModelEntry +size_bytes/
  trained_ctx/experts/physics_facts; RunnerModelInfo +speedBand/predTokS/
  measuredTokS; api.py prices the CAPPED ctx; measured (newest, this
  box+backend) outranks predicted for value AND band; MeasurementRow
  +backend (was DB-stamped but WIRE-STRIPPED — the documented Pydantic
  class); configure_service +measurements_fn/class_bw_fn/record_probe_fn.
  (d) §8.23 — slotOptions → pure buildSlotOptions (modelPick.js), NO fit
  filter, badge+band ride labels, fitWarning under a "no" pick; QuickSetup
  embedOptions unfiltered+annotated; grouping + all auto-picks KEPT as
  recommendations; §7.3 pinned (JW slotOptions.test.js — a "no" row IS
  selectable). (e) chip "Fits · ~fine" (~ = predicted, measured drops it);
  row shows measured tok/s; hover speed sentence + §13.7 MTP rider.
  Docs same-change: JW models.md (band + veto removal + knob move + class
  bw fields) · JV ai-features.md (new "Picking models" section). Gates:
  kit ruff + 813/10 · kit-ui biome · JW test:fast 128 + vitest(5) + i18n
  benign-only + build:vite · JV build:vite + smoke PASS (0 JS errors) ·
  check-family 0 · JW smoke RUN BY THE USER 2026-08-13 ("i ran the smoke
  test no errors" — it had refused while their app held port 1420). ALL
  Phase 3 gates green. After Phase 3: the deliberate checkpoint before
  Phases 4-6 (§11), each on its own go. Phase 3 consumed Phase 1's byte
  model (§13.15).
- PHASE 3 LIVE-REVIEW POLISH (user, 2026-08-13, from the running app):
  (1) the chip WRAPPED ("Tight · ~slow" split across two lines) — .lu-fit
  never declared itself atomic; its content was single-word when authored,
  so the missing rule was invisible until multi-word content arrived. FIX:
  white-space:nowrap ON THE CHIP CLASS (both the styles.css canonical and
  QuickSetup's scoped copy) — intent declared once, no explicit widths,
  future content can't reintroduce it. (2) user ruling, verbatim: "change
  painful to very slow on model catalog chip" — DISPLAY-ONLY via
  SPEED_BAND_LABEL in modelPick.js (the FIT_LABEL value≠label precedent;
  the wire keeps §8.14's fast/fine/slow/painful vocabulary). Docs + the
  §7.3 test updated same-change. Gates: biome · JW vitest 5/5 · JV
  build:vite + smoke PASS.
- PHASE 3 EXECUTOR CHOICES (recorded so nothing lives only in code):
  · Band-threshold SEEDS: fast ≥ 20 · fine ≥ 8 (§8.14's DECIDED reading-
    speed line — the only user-ruled number) · slow ≥ 2 · below = very
    slow. 20 and 2 are executor picks, GUI-tunable by design; changing
    them is a settings edit, never a code change.
  · The pool model is the SERIAL SUM (t = Σ pool_bytes/pool_bw), not the
    literal "slowest pool wins" min — it is what Appendix B's host-
    constant derivation actually solved and it is the conservative end
    (err-slow §8.17). Documented at fit.py's speed section.
  · Band ctx = min(trained, ctx_cap) — prices the config an untuned model
    would actually launch; cap 0 → trained (uncapped, still err-slow).
  · A MEASURED tok/s replaces the prediction for the VALUE and the BAND
    (newest row, this machine_key + backend; probe pseudo-rows can never
    match a catalog id).
  · One-pool efficiency family: metal → device (0.6); iGPU/Vulkan/CPU →
    host (0.15) — Appendix B's laptop rows sit in the host range.
- OPEN — the RAM-probe calibration (§5.5 source 2 said "calibrated ONCE
  against the measured-model path on the three known machines before
  ship"): NOT yet run live. The shipped convention (2 × bytes/elapsed =
  read+write traffic; best-of-3) was REASONED from the desktop numbers
  (DDR4-3200 memcpy ~35-45 GB/s × 0.15 ≈ 5.2-6.75 vs the measured
  effective 6.9-10.6 — conservative, the right direction) but no probe
  has been compared to a measured-model derivation on a real box. The
  probe SELF-RECORDS (measurement row `__machine_ram_bw__`, GB/s in
  tokensPerSec) — verify at the checkpoint, no code needed to read it.
- THE DELIBERATE CHECKPOINT (before the Phase 4 go) — the concrete list,
  so nobody re-derives it:
  (1) Desktop 2070S/32: chips show feasibility × band; the flagship reads
      Fits · ~fine untuned (predicted ≈8-9 un-sped) and its band flips to
      fast once a real measured row exists; GLM reads Won't fit · ~very
      slow, IS pickable in the slot dropdown, and shows the honest
      warning; a Tune & measure run puts real tok/s on the row.
  (2) 16 GB iGPU laptop: E4B reads Fits (the Phase-2 carryover glance);
      bands present and slow-leaning (host family prices the pool).
  (3) 32 GB Core Ultra laptop: same glance; bands present.
  (4) On each box: the measurement history holds `__machine_ram_bw__`
      with a plausible GB/s (desktop DDR4 ~35-45; LPDDR5 laptops higher);
      if a box's number × 0.15 lands far from its felt speed, that is the
      probe-calibration item above — adjust bw_eff_host (a setting).
  (5) The Loaded-models knobs group shows margin · cap · RAM headroom ·
      the three band fields, and Save round-trips all of them.
  (6) DONE 2026-08-13 (user: "jv and jw have been reset") — the data reset.
      Both apps run on fresh seeds now (facts-not-floors rows, no legacy
      rungs); docgen stays optional (self-heal covers its seeded rows).
- CHECKPOINT WALK, DESKTOP ROUND 1 (user, 2026-08-13, live): item (1)
  CAUGHT A REAL DEFECT — the flagship chip read "Fits · ~slow", not the
  designed ~fine. Diagnosis (verified by running the probe live on the
  same box): the RAM copy probe reads 19.01 GB/s there and SUPERSEDES the
  class seed (ladder order working as designed), but it shared the
  generic host factor — 19.01 × 0.15 = 2.85 GB/s effective → 3.3 tok/s →
  a band lie (the probe's single-thread memcpy badly underruns
  multi-channel streaming; the class-seed math 51.2 × 0.15 = 7.68 was
  the designed position). THE FIX = §5.5's own instruction executed
  ("the probe's efficiency factor calibrated ONCE against the
  measured-model path"): a SEPARATE seeded factor `bw_eff_host_probe` =
  0.40 (19.01 × 0.40 = 7.6, inside the box's measured 6.9–10.6 window),
  wired config→schema→stores→seed→reset→ladder→api; the ladder prices
  probe-sourced host at ITS factor, class-seeded at the generic one.
  Pinned: test_probe_factor_calibration_pin (window membership + the
  0.15 bug shape) + the ladder-order test updated. THE PROBE-CALIBRATION
  OPEN ITEM IS RESOLVED FOR THE DESKTOP; the laptops' probes may sit
  differently — refine via the settings row, never code. Item (5) OK per
  the user but Save was silent — the knobs Save now pushes a success
  toast ("Engine settings saved.", the FeatureLab after-the-await
  precedent). Items (2)/(3) laptops: NOT walked yet (user: desktop only
  for now). NEXT USER STEP: restart the app (picks up the new seed row +
  code), flagship should read ~fine; then the Tune & measure flip test.
- THE PROBE GOES TOPOLOGY-AWARE (user challenge → "upgrade it go",
  2026-08-13): the user pressed on the 0.40's generality ("how can you
  calibrate it just against my box… any box including cpu"). Measured
  answer (experiment on the desktop): threading adds NOTHING there
  (single 18.9 vs 2/4/8-thread ~14 — dual-channel DDR4 is CONTROLLER-
  bound), but wide memory systems (8-channel, Apple Max/Ultra) are
  single-CORE-bound and a lone stream under-reads them ×2-5. FIX:
  `probe_ram_copy_gbps` now runs the single pass PLUS threaded passes
  (4 streams · min(16, cores) streams; same total footprint split
  across streams) and reports the BEST — every box reads ITS OWN
  achievable parallel rate, and `bw_eff_host_probe` 0.40 becomes what
  it should be: the streaming → scattered-expert-gather discount, an
  ACCESS-PATTERN property that transfers across machines. The
  calibration box's numbers stand unchanged (live re-probe after the
  upgrade: 18.83 — single still wins there; the persisted 19.01 row
  stays right). The any-box safety story, restated for the record:
  ladder source 1 (a box's own measured runs) bypasses every factor
  per box incl. CPU-only; a wrong seed errs slow and can only mislabel
  a band, never gate anything; class seeds cover probe-less boxes.
  Test: test_probe_is_topology_aware (helper + best-wins).
- PHASE 4 BUILT 2026-08-13 (go: "go phase 4"; the user chose to run it
  BEFORE the checkpoint — their sequencing call; the checkpoint's six
  items above stay open and now also cover the Memory-labeled budget
  line). Per-backend used-memory probes + the arch-aware arbiter ledger:
  (a) hardware.py probe family — every arm best-effort None, and None =
  the pre-Phase-4 behavior (the true-up keeps the estimate), so an
  unverified probe can only fail to improve, never break a box.
  `used_device_mem_mb()` is the door: discrete → nvidia-smi (existing) →
  `_rocm_used_vram_mb` (rocm-smi --showmeminfo vram --csv; the used
  column is FOUND by "vram"+"used" because its wording varies by ROCm
  release) → `_amd_sysfs_used_vram_mb` (mem_info_vram_used — the
  documented amdgpu kernel ABI, sibling of the _total the GPU scan
  already reads) → `_windows_gpu_dedicated_used_mb` (typeperf
  "GPU Adapter Memory(*)\Dedicated Usage", one ~1 s sample; only reached
  when nvidia-smi is absent and only at load true-up, never on a poll).
  One-pool boxes → `_used_pool_mb` (psutil → GlobalMemoryStatusEx
  total−avail → /proc/meminfo MemTotal−MemAvailable → vm_stat
  active+wired+compressor × page size, the delta-stable macOS
  accounting) so a load's before/after delta counts a model's bytes
  ONCE (mmap'd weights + "GPU" allocation are the same bytes on UMA).
  (b) `hardware.budget_total_mb(hw)` — THE arch-aware denominator:
  discrete → largest single card (historical meaning untouched); else
  the pool (ram_mb). The arbiter's `_max_vram_mb` flows through it
  (remaining/can_coreside/make_room/snapshot), as does the true-up cap
  in `_trued_up_vram_mb`. Before this a Mac/iGPU box totaled 0 →
  remaining permanently 0 → every admission fell into evict-then-warn.
  (c) snapshot + wire: arbiter snapshot + RunnerResidentResponse gain
  `mem_arch` (additive, default discrete); the engine panel's budget
  line reads "Memory" instead of "VRAM" on one-pool boxes. The *_mb key
  names KEEP their historical spelling on purpose — §10's
  don't-reinterpret rule protects STORED columns; a live wire whose
  meaning is labeled by mem_arch beside it stays honest, and renaming
  would break every reader incl. the JV strip that consumes THIS
  snapshot when its wiring resumes (§6.7).
  (d) lifecycle's default probe switched used_vram_mb →
  used_device_mem_mb; the injection contract stays no-arg so every
  injected test fake kept working.
  TEST LESSON (keep): three lifecycle eviction tests broke because
  `_fake_hw(1000)` declared no runtimes — a sub-4-GB GPU without cuda
  now honestly classifies INTEGRATED and budgets the 32 GB pool, so the
  eviction scenarios never needed to evict. The fakes now declare cuda
  (a tiny discrete card IS what they meant). Future fake hardware must
  state its architecture, not just a vram number.
  HONEST LIMITS: the rocm / typeperf / vm_stat arms are fixture-pinned
  against documented formats, NOT live-verified (no AMD/Mac box here);
  the None contract is the safety, live confirmation lands whenever such
  a box appears. Tests added: rocm CSV parse + junk→None · amdgpu sysfs
  tmp-tree · typeperf sample parse + counter-absent→None · probe routing
  (one-pool vs discrete, first-non-None wins, all-None→None) · a LIVE
  pool-probe sanity on the dev box · the budget_total_mb arch matrix ·
  the §13.10(c) arbiter pins (one-pool committed ONCE, remaining =
  pool − claim; unified-mac pool; discrete stays the card, never RAM).
  Gates: ruff clean · kit 822 passed/10 skipped · kit-ui biome · JW
  models.md budget-line wording updated same-change (JV user docs
  describe no budget line — nothing stale there). Remaining Phase 4
  follow-through rides the standing checkpoint (the budget line on the
  laptops should now SHOW, labeled Memory, instead of hiding).
- PHASE 5 BUILT 2026-08-13 (go: "go" after the Phase 4 report) — persistence
  + the four-arm claim resolver + the embed-leftover consumption. The build:
  (a) PERSISTENCE (§6.3/§8.16): model_measurements gains `vram_model_mb`
  (the true-up footprint — vram_total_mb stays the CARD total, never
  reinterpreted) + `kind` (default 'llm'); knob_catalog gains
  `fit_relevant` (§13.3's ten memory-shaping knobs seeded True — the
  fingerprint IS this classification, read from data:
  ctx_len·cache_type_k·cache_type_v·flash_attn·n_cpu_moe·n_gpu_layers·
  no_kv_offload·parallel·batch_size·ubatch_size); runner_setting
  `load_rows_keep`=3 (§13.2's K). All additive columns + wire fields
  DECLARED (the strip-guard rule).
  (b) THE RECORDER: a confirmed load persists a source='load' row —
  vram_model_mb = the booked true-up, switches = the RESOLVED launch
  config in the UNDERSCORE knob canon (from the FitPlan, what actually
  launched) — then prunes keep-latest-K per (model, machine,
  fingerprint). A MEASURED true-up on the device also records the
  observed physics overhead as the `__overhead__` machine row
  (source='probe', label "physics-overhead <build>" — an engine-pin bump
  invalidates old rows by simple label non-match: recalibration by
  construction, §13.2/§13.6). Reservation PROVENANCE (§13.1):
  _Reservation.source measured|computed|declared, set at reserve, on the
  snapshot rows — the JV strip never reads a declared price as live
  truth. _trued_up_vram_mb returns (mb, source).
  (c) THE RESOLVER (§6.2, grown INTO preview_fit — no second door):
  resident-live (arbiter reservation + its provenance) → persisted-
  measured (MEDIAN over fingerprint-matched 'load' rows, this machine +
  backend; `matches` carries the evidence count — 1 = §13.2's low-
  confidence; a fingerprint MISS falls to computed FULL STOP, §13.4's
  cut) → computed (the physics booking; the LEARNED overhead replaces
  the seed when __overhead__ rows for this backend×machine×build exist)
  → declared (est_vram_mb over min_vram_mb — the conservative
  pre-download want; understating re-opens the 2026-07-11 co-load
  crash). Every claim = {vramMb, ramMb, source, matches}; ramMb = file +
  headroom on every arm (§13.12 shape; DISPLAY-ONLY per §8.18).
  preview_fit carries `claim` even for a not-downloaded model.
  DI seams for JV (§6.2): record_load_fn + fit_relevant_flags_fn wired
  by install_llm; declared_claim_fn DECLARED (None until JV's wiring
  registers its engine manifests — the kit handles kind='llm' itself).
  (d) CONSUMPTION (§6.6): _embed_gpu_leftover_mb subtracts the RESOLVED
  chat claim — resident booking, else measured median, else the physics
  booking (a DOWNLOADED chat stops claiming its declared est), else the
  est-based declared chain exactly as before for not-downloaded chats.
  BEHAVIOR CHANGE, deliberate + §6.6-decided: on a box whose downloaded
  chat model books less than its est, the embed leftover OPENS UP (the
  est was pre-download fiction; the booking is what the load will use;
  the resident arm is even truer). The 2026-07-25 est-based pins live on
  as the DECLARED-arm tests (seed_cache=False).
  (e) VOCABULARY FIX (latent Phase 3 bug, caught here): measurement
  switches speak the UNDERSCORE knob canon (autotune records
  {"n_cpu_moe": …}; the Tune modal saves KnobGrid names) while Phase 3's
  bandwidth derivation matched dashed launch tokens — so its measured
  arm could NEVER match a real row (silent, fell down the ladder).
  bandwidth.py now normalizes both spellings to one canon (ctx under
  ctx_len/ctx_size/ctx); the §13.3 fingerprint uses the same canon.
  (f) Speed UIs filter source ∈ (tune, autotune) at the ONE client door
  (measurements.js) — 'load'/'probe' rows are real data, not speed
  history. Clear-history copy says it also forgets footprints (§8.22 —
  claims fall back to computed and re-learn on the next load).
  Tests (+8, kit 830/10): footprint+kind round-trip THROUGH the wire ·
  keep-K prune (fingerprint-scoped, other fingerprints + speed rows
  untouched) · the seeded fingerprint set pin · trued-up provenance ·
  measured-arm median + every §13.2/§13.4 exclusion (other box, other
  backend, fingerprint miss never blended, no-fset → computed) ·
  load+overhead recorder rows · unmeasured load records no overhead row
  · preview_fit claim (computed + declared arms) · embed-leftover ladder
  (computed arm + resident arm win) — declared-arm pins kept via
  seed_cache=False.
- PHASE 6 BUILT 2026-08-13 (go: "compact complete go" — the next phase in
  §11's order after the compact) — the joint MoE solve + the shed direction
  + the physics draft charge + the §7.2/§13.9 gates. The build:
  (a) THE JOINT SOLVE (§5.7): `fit.moe_joint_split` (pure, tiny monotone
  loop) — pin ngl = n_layers, walk the SMALLEST ncmoe whose forward
  physics estimate (iSWA-KV, draft-charged budget) fits; expert offload is
  the cheap knob (≈0.45 GB/layer on the 26B — §13.9's measured 0.41),
  shedding a layer moves attention + KV too. Nothing fits even at
  ncmoe=n_layers → experts stay in RAM and ngl walks DOWN through the same
  physics. compute_fit's untuned two-pool MoE arm calls it; explicit
  overrides win untouched; a MoE with a tuned ncmoe-only keeps the old
  derived ngl rule. Consumers inherited for free (reservation, preview/
  Tune "Computed for this PC" rows, 1b-F4 retry, autotune anchors) — the
  displayed split IS the good one now (the Apply trap §5.7 named is dead).
  (b) PHYSICS-FULL-FIRST for every other untuned arm (dense, one-pool,
  ncmoe-pinned): if the full-offload physics fits the budget → ngl = all;
  else the fitted inverse exactly as before (partial dense offload stays
  the regression's fitted domain, §7.1). NEEDED for §7.2's 12B row: the
  fitted inverse's uniform KV projection prices iSWA KV ~9× over at 32k
  ctx (6.3 GB projected vs 436 MB real) and stranded 11 layers a 12 GB
  card holds (computed 37/48 where physics says all 48 fit).
  (c) DRAFT CHARGE → PHYSICS (the Phase 1 note "Phase 6 owns both",
  executed): the draft's whole file + its exact KV at our ctx, no base
  offset (the main model pays the backend overhead once); main-on-CPU →
  the solo draft pays the overhead itself. `fit.marginal_vram_mb` (the
  regression's fitted marginal — a −18 MB/layer credit and embedding-
  ratio slope with nothing to say about a 4-layer draft) has no callers
  left in compute_fit. KV + overhead are HOISTED above the split — the
  solve, the charge and the booking read the same two numbers (one
  source, computed once).
  (d) SHED DIRECTION (§1.7 fixed): `_router_load_with_backoff` — a MoE
  child's OOM RAISES n-cpu-moe by the step (ngl stays; the tracked ncmoe
  starts from the ENTRY's value so a tune's 21 is never replaced by a
  derived number); ngl sheds only once ncmoe = block_count; dense
  unchanged. The dormant `start_runner` mirror got the same direction AND
  the first-attempt fix (it recomputed `block_count − ngl` on EVERY
  attempt incl. #1, silently discarding the plan's computed ncmoe).
  (e) GATES AS TESTS: tests/test_fit_acceptance.py = §7.2's five-row
  measured gate on the REAL seeded physics facts (26B@vram8|ram32 with
  draft at ctx 32768 → ngl 30, ncmoe ∈ [21,23] — computed lands 22;
  26B@igpu-mem32 → ncmoe 0 ngl 30; 12B@vram12 → full 48/48; E4B@
  igpu-mem16 → full 42/42) + the HONEST NEGATIVE: 12B@vram8 stays
  partial at server ctx 32768 — its "ngl 99 · 39.1 tok/s" row was
  llama-bench (NO -c flag, §13.13), and 6716 weights + 436 KV + 1516
  overhead genuinely exceed the margined 7168 budget; the plan's
  "12B full offload" is pinned on the class where physics says it fits
  (the seeds pin ngl 99 there too). §13.9's
  test_expert_layer_marginal_matches_measured derives 0.446 GB/layer
  through the real functions vs the measured 0.41 (9%, inside the 15%
  band). Joint-solve unit tests (smallest-nc walk, roomier budget →
  fewer offloaded, fallback shed, dims-less flat-walk).
  RE-PINS (each an intended behavior change, not a fix-up): the 10 GB
  dims-less MoE literal (4, 6, 4096, 5545) → (5, 10, 4096, 6553) — a
  share-0 header can't credit expert stripping, so ALL experts offload
  and layers walk by physics; discrete untuned MoE ncmoe = n_layers −
  ngl → n_layers; start_runner OOM tests now assert ncmoe-first.
  Gates: kit ruff clean + 843 passed/10 skipped (was 832; +11) · JW
  test:fast 128 · JV server 469. No renderer files touched → smoke not
  required (the Phase 1 precedent). USER DOCS: checked models.md — the
  "Computed for this PC" rows and the backs-off line are described
  generically and stay TRUE (the values just got better); no stated fact
  went stale, and the fit docs pass remains §7.6's (Phase 7).
- PHASE 7 BUILT 2026-08-13 (go: "go phase 7"; the same message closed the
  desktop checkpoint — "flaghsip works, tune and measure works"). The build:
  (a) §7.3 THE UNCURATED-PATH ACCEPTANCE TEST
  (tests/test_uncurated_path.py): a FRESH DB with NO seed rows, a MoE
  hand-added BY LINK (fetch_gguf_meta faked with a byte-faithful
  26B-class iSWA header — the 5:1 window pattern + per-layer KV heads
  reproduce the real file's KV scalars 102400/10240 B/token; expert dims
  give share ≈0.92), on a simulated 8 GB/32 GB box. Drives the REAL
  chain: inspect_model_from_link → the form-PUT door (CatalogRow upsert,
  NO floors typed — §13.17) → the wire's computed-fresh floors (min_ram
  = file+headroom; max-offload min_vram ~3 GB; est ~16 GB) → the badge
  (ok/tight — and the §1.4 MoE-blind "no" lie pinned VISIBLY beside it:
  the same box without the computed floor still grades "no") → the
  untuned split (ngl 30, joint-solve ncmoe, capped ctx, booking inside
  the card). The LAUNCHABLE half of the pin lives in test_lifecycle
  (test_no_badged_model_is_launchable): a model whose badge reads "no"
  on a 4 GB box loads untuned to "running" — the load path consults no
  verdict (the doomed-spawn admission refusal is DENSE+EXPLICIT-ngl
  co-residency arithmetic, untouched and compatible).
  (b) §7.4-AS-RANKING (evidence outranks the estimate's veto):
  RunnerModelInfo gains `ranHere` (additive) — TRUE when ANY persisted
  measurement row for THIS machine_key names the model (a tune, an
  autotune trial, or a Phase 5 load footprint with tok/s 0; machine-
  keyed only per the plan's words — a backend switch changes speed, not
  the fact that it ran; the pseudo-rows never match a catalog id).
  pickByClassConfig keeps its runnable-preference but a ranHere
  candidate SURVIVES a "no"/narrowed-fitSet estimate — the box provably
  ran it. Quality still ranks; embed/use-limited guards still hold
  (evidence never rescues those). Seeded class configs alone remain
  NON-evidence (8 of 13 are extrapolations). Five truth-table cases in
  verify-model-pick.mjs (48/48) + the ranHere wire test.
  (c) §7.5 PIN AUDIT — no new work needed, verified by inspection: the
  gold-check (test_physics_gold_check_flagship_config) · the RAM-gate
  raw-to-raw cases (test_coarse_fit_ram_gate_raw_to_raw) · the a≤0
  guard (test_estimate_guards_degenerate_negative_slope) · the flagship
  est-17713 embed-guard pins (lifecycle embed tests + the declared-claim
  pin) + computed-fresh floors (test_computed_fresh_floors_from_facts)
  all exist from Phases 0–6.
  (d) §7.6 THE DOCS PASS: the ONE-AUTHORITY story now STANDS in kit
  docs/dev/serving-design.md (new "Fit — one physical authority"
  section: facts-not-floors, the joint solve, the regression's two
  surviving roles, verdicts-inform-never-gate + evidence ranking, the
  four-arm claim resolver, and §13.13's history gap closed — the June
  gguf-parser-vs-fit.py decision recorded as SUPERSEDED). JW
  architecture-notes has NO fit section to rewrite — verified by grep;
  the plan's target predates the 2026-08-04 docs-campaign distillation,
  so the kit doc is the family home (recorded rather than inventing a
  JW home). measured-performance.md's constants/calibration notes
  shipped in Phase 3 and stand. USER DOCS: models.md gains the one
  behavior line — a model you've run/tuned on THIS PC stays
  recommendable even when the estimate would reject it. The four §7.6
  user-doc items (band, Needs line, ctx cap, quant behavior) verified
  present from Phases 0–3.
  Gates: kit ruff clean + 846 passed/10 skipped (+3) · verify-model-pick
  48/48 · kit-ui biome clean · JW test:fast 128 + slotOptions vitest 5/5
  + build:vite · JV build:vite + smoke PASSED (all views, 0 JS errors) ·
  check-family 0 violations · JW smoke REFUSED as documented (the user's
  app holds port 1420; the kit-ui change is covered by the JW vitest +
  both builds + the JV smoke driving the same code).
Downstream: JV's VRAM wiring is UNBLOCKED as of Phase 5 (2026-08-13) — both its
claim-line sources now exist (the persisted-measured arm + the physics computed
arm, resolved through preview_fit; claim shape {vramMb, ramMb} + provenance per
§13.1/§13.12, RAM display-only §8.18; the declared_claim_fn seam awaits JV's
engine manifests). The wiring itself still needs ITS OWN go (the user's standing
stop) and lives in JV's tracker. JW's seed regeneration + membership
re-validation completed in Phase 2.
