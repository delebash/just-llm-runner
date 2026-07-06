# Model-per-hardware plan — one profile, honest seeds, protected QuickSetup, measured everywhere (2026-07-06)

> **STATUS: APPROVED DIRECTION ("i will take your recommendations go") — per-phase execution with the
> standing discipline (design→build→verify→diff-checker→commit per phase). LIVE tracker: per-phase
> records appended below as phases ship.** Born from the 2026-07-06 model-per-hardware discussion; the
> measured basis is `justwrite-app/docs/plans/2026-07-06-onbox-profile-ab-test.md` (RESULTS, bc614c6).

## Context — the decisions this plan executes (all user-made, all recorded)

1. **ONE launch profile per model** (user: "lock 1 profile"; measured: per-request
   `chat_template_kwargs.enable_thinking=false` fully suppresses Gemma 4 reasoning; the 32k/ncmoe21/
   rb1024 section serves writer traffic at writer speed — B TTFT 1.52s vs A 1.68s cache-busted).
   The writer-vs-chat difference lives at the REQUEST layer (per-task think flags), not in launch
   identities. D4 secondary item (1) is DECIDED on this evidence (ledger updated, runner 973faa0).
2. **Models = a facts list; switches = layered derivation** (user question answered 2026-07-06):
   catalog rows carry NO launch switches; launch config = base bundle → type bundle → mtp bundle →
   COMPUTED knobs (ngl/ncmoe from fit) → MEASURED per-(model, machine) tunes (win). The consolidation
   closes the fresh-box gap: rb 1024 → the BASE bundle (the user's universal anti-loop safety cap);
   ctx → a COMPUTED knob (min(trained_ctx, KV-budget-affordable), tune-overridable).
3. **Optimize sweep = OPT-OUT with skip** in QuickSetup (user: "opt out with skip is fine");
   auto-start FIRST-TIME-ONLY (no tune rows for (model, machine)); Skip = the existing cancel
   endpoint; "Re-optimize" button when already tuned.
4. **The user's 2070S tunes stay machine-keyed** — never universal defaults (8GB-floor numbers are
   wrong elsewhere; other boxes compute + measure their own).
5. **Gemma 4 is Apache-2.0** (HF-API verified; tag + cardData on unsloth/gemma-4-26B-A4B-it-qat-GGUF)
   — the seeded `license:"Gemma"`/use_limited=1 is a DATA ERROR to fix. Gemma quality_rank 9 stays but
   gets an honesty annotation (reasoned, not instrument-cited — pending the model research).
6. **D4-1 QuickSetup overwrite protection = (a)+(c)** (user took the rec): detect an
   already-configured box + a confirm listing exactly which presets change; fresh box stays one-click.
7. **The "Plan for card" dropdown: REMOVE** (user took the rec; wire verified correct but the wizard
   scores the real machine — the what-if planner confused more than it helped).
8. **Class→model map = tiny curated seed data, no GUI** (user: "i meant 2 tiny curated list") —
   mechanism now, contents refreshed by the later model research (leaderboards → Lab; Gryphe
   StyleTune-V2 the one credible candidate so far). Community fine-tunes never seed as defaults
   without maker-reputation + verified license + an instrument or Lab win (my recorded pushback).
9. **Windows orphan router child = a real bug to fix** (on-box incident 2): stopping the JW server
   leaves llama-server holding :8080 serving the stale generated ini.
10. **Sleeping-child VRAM + bench cache-busting** (incidents 1+3): document — the arbiter path is
    immune, direct-to-router clients are not; verbatim-repeat prompts hit the llama prompt cache.

## Phase 1 — the one-profile consolidation + seed truth (JW server seeds + runner base bundle)

- `justwrite-app/server/justwrite_server/seed_presets.py`: the TWO Gemma entries
  (`writing-assistant-gemma-moe-mtp` + `book-chat-gemma-moe-mtp`, :85-101) collapse into ONE —
  id `gemma-4-26b-a4b-qat`, name "Gemma 4 26B-A4B (QAT)", same repo/quant/MTP-draft facts,
  `license: "Apache-2.0"` (fix), quality_rank 9 + a seed comment recording rank-not-instrument-cited,
  description rewritten (one model, both uses; keeps the measured numbers + the tuning-doc pointer).
- `model_tunes_seed` (same file, :111+): re-key this box's rows to the one id — ncmoe **21**, batch
  512, ubatch 512, threads 8 (the 32k-config values; the @8k ncmoe-20 row dies with the writer
  entry); keep the CPU-embed tune. NO ctx/rb tune rows — they move to the derivation (next bullets).
- Runner `llm_runner/llm/seed.py` base bundle: add `reasoning_budget = "1024"` to the `base`
  switch preset rows (+ its `reasoning_budget_message` if the flag exists in the Overrides surface —
  verify at build; Plan B added both to the wiring). Universal safety cap; harmless where unsupported.
- Runner ctx-as-computed: `fit`/`lifecycle` gain the computed ctx knob — `ctx = min(trained_ctx or
  DEFAULT_CTX_CAP, kv_affordable(vram, model))` emitted like ngl/ncmoe when no tune/preset override
  exists; `kv_affordable` from the existing fit math (KV bytes/token at q8_0 × headroom). Grounding at
  build: where ngl/ncmoe are computed + emitted (lifecycle/process); the same seam carries ctx.
  Tune-overridable (a ctx tune row wins, as any tune does).
- The 8 engine presets (:44-77): all point at the one id; per-task think flags verified at the
  FEATURE layer (feature_prompts.think — writer/autocomplete/expansion/dialogue think=false,
  book-chat/research think=true) — read the seed + fix any wrong think values; VERIFY the dispatch
  think-off path SENDS `enable_thinking: false` to the builtin runner (openai_compat.py:105-118 —
  the comment says "off→nothing" while :113 sets `= think`; the box proof used explicit false; adjust
  if the off-branch omits).
- Dev-DB story: `POST /v1/data/reset` (pre-production decree); the user's box likewise (their tunes
  ARE seed data, so reset restores them — recorded in the ship notes).
- Docs in-phase: `justwrite-app/docs/models.md` (one Gemma), the tuning doc gains a
  consolidation-record note, ledger D4 secondary item (1) already flipped.

## Phase 2 — QuickSetup: dropdown removal + D4-1 protection + opt-out sweep (kit)

- REMOVE Plan-for-card: `CARD_OPTIONS`/`cardOverride`/`onCardChange` + the `vram_mb` query leg in
  `loadAll` (QuickSetup.vue: CARD_OPTIONS :50-60, the vram_mb query leg in loadAll :158, onCardChange :211 — re-grounded by the panel); the API param STAYS (harmless
  surface; the catalog page is the power-user fit view).
- D4-1 (a)+(c): on wizard open, detect configured = (task presets NOT all one model) OR
  (`GET /v1/ai/model-tunes?modelId=<pick>` rows non-empty) OR (any preset model ≠ the factory seed
  default — grounding at build against dominantOf); the confirm step then renders a "What Apply will
  change" panel listing EXACTLY the presets that would re-point (the dominantOf set) and the ones
  kept; Apply proceeds only from that informed state. Fresh box (all presets on one model, no tunes)
  = today's one-click.
- Opt-out sweep: after `pollLoad` confirms running → `GET /v1/ai/model-tunes?modelId=` → rows empty →
  auto `startOptimize()` (save:true, as shipped); the done step shows the running sweep + a **Skip**
  button → `POST /v1/llm-runner/auto-tune/cancel` (endpoint exists; QuickSetup never called it);
  busy-guard rejection (`ok:false already running`) ADOPTS the shared job (render running state, no
  error); rows present → the button relabeled "Re-optimize (~4 min)". Close-while-running stays legal
  (job continues server-side; onBeforeUnmount stops only the poll).
- Wizard probe (`phaseD-quicksetup-probe.mjs`): stub `/v1/llm-runner/auto-tune` GET/POST + cancel +
  `/v1/ai/model-tunes`; assert — no card selector · the D4-1 change-list renders on a configured box ·
  auto-start fires when untuned (stubbed running state + Skip visible) · Re-optimize shows when tuned.

## Phase 3 — the class→model map (runner + kit; mechanism now, research fills later)

- New table `model_class_picks(min_vram_mb INTEGER PK, model_id TEXT)` (+ store + seed): consulted
  by QuickSetup's pick — the row with the largest `min_vram_mb <= detected/overridden VRAM` whose
  model exists + fits wins; NO row → the §10 speed-floor rule (unchanged fallback). Wire: extend the
  `/v1/ai/model-catalog` response with `classPicks` (one fetch, no new endpoint — grounding at build:
  stores.py wire + useCatalogMeta maps).
- SEED: rows mirroring current evidence ONLY — `{6000: qwen3.6-35b-a3b-mtp}` (the C2-cited global
  best; below 6GB the fallback picks 14b/8b by fit) — explicitly commented as
  placeholder-equal-to-§10 until the model research lands (the map is the EXPRESSION POINT; contents
  are replaceable data).
- Kit: `modelPick.js` gains `pickByClassMap(picks, vramMb, {exists, fits})` (pure, truth-table-
  testable); QuickSetup consults it before `pickBestModel`. `verify-model-pick.mjs` gains the map
  cases (map hit · map miss → fallback · map row not fitting → fallback).

## Phase 4 — the Windows orphan-child fix (runner)

- `runner/process.py` spawn: on Windows, create the llama-server child inside a **Job Object** with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (ctypes, stdlib-only — CreateJobObjectW +
  SetInformationJobObject + AssignProcessToJobObject; the job handle owned by the service so
  parent death → OS kills the child). Non-Windows unchanged (process-group semantics already fine).
- Tests: mock/ctypes-guard unit tests (job created on win32 path, handle retained, close-on-stop);
  the REAL kill-on-parent-death is a box check (G-item, recorded).
- Docs: the incident + fix in this plan's record; the SVM plan gains the sleeping-child caution note
  (incident 1: direct-to-router clients bypass the arbiter — manual-router users beware); the bench
  cache-busting note lands in the on-box test doc (already) + the autotune module docstring.

## Phase 5 — the seed-facts audit (runner script)

- `scripts/seed-facts-audit.py` (runner repo, stdlib urllib): walks runner `DEFAULT_CATALOG` + JW's
  `DEFAULT_MODEL_CATALOG_EXTRA` (seed_presets.py:84) (import via path arg or env — no hard cross-repo import), and for each row
  queries the HF API: repo EXISTS + `license` tag matches the seeded license (case/spdx-normalized) +
  (where cheap) the quant file appears in the tree listing. Exit non-zero on mismatch; prints a
  per-row table. NOT CI-gated (network); run at any seed change + in sessions. Run it NOW in-phase —
  it must pass on the corrected seeds (and would have caught the Gemma error the day it was written).

## Phase 6 — verify + ship (continuous; per-phase commits)

- Per phase: runner ruff + pytest · JW build:vite + vitest + FULL headless smoke + the wizard probe ·
  live API round-trips on :17495 where touched (reset → seeded one-Gemma catalog · presets all on the
  one id · think flags per task · classPicks on the wire) · residual greps · diff rules-checker →
  commit + push (runner + JW as touched).
- Ledger/tracker/recap updates per phase; models.md + kit README where surfaces changed.
- Box checks recorded (not claimed): the orphan-child kill-on-death · the consolidated config's first
  real load (reset → one Gemma → writer TTFT sanity) · the opt-out sweep UX end-to-end.

## Out of scope (recorded)
The model-quality research (leaderboards → Lab; Gryphe evaluation) — refills the map + ranks later ·
D5 (parked) · JustVoice (F-items) · quant-ladder seeding (superseded by the map + research) ·
profiles UI (died with profiles).


## PANEL RECORD + FOLDED AMENDMENTS (2026-07-06 — three checkers, lenses: architecture-fit · reuse/convergence · grounding)

**Verdicts: FAIL(1) · FAIL(2) · FAIL(1) — every finding real; ALL folded below. The convergent
catch (two of three checkers independently): the rb-in-base move collided with a box-verified code
comment the plan never engaged. The panel also confirmed the load-bearing feasibility facts:
`reasoning_budget` is fully wired (Overrides field process.py:94, argv map :121, ini int_fields
lifecycle.py:195, knob_catalog seed seed.py:278 — knob default is -1, so seeding 1024 respects the
Plan-B never-seed-the-default guardrail); the computed-ctx seam exists exactly where planned
(compute_fit process.py:306 `ov.ctx_len or DEFAULT_CTX` → FitPlan.ctx_len → BOTH the active load
lifecycle.py:837-842 AND the passive ini emission :989-994; ctx_len in int_fields :194 so a tune
wins); the think-off dispatch ALREADY sends explicit `enable_thinking=false` for local-llamacpp
(openai_compat.py:112-114 — the "off→nothing" comment governs only the generic openai-compat branch)
so Phase 1's "adjust if the off-branch omits" resolves to NO code change; and ctx/rb DO ride tune
rows today (seed_presets.py:112-119), confirming the plan's structural premise.**

**A1 (Phase 1, the convergent T2) — the rb-vs-toggle reconciliation.** `openai_compat.py:106-109`
carries a 2026-07-04 box-verified comment: the per-request toggle "works only when no hard
`reasoning-budget` is on the CLI — we emit none." The 2026-07-06 on-box A/B (bc614c6) measured the
OPPOSITE combination working: the book-chat section launches WITH `reasoning-budget 1024` and
per-request `enable_thinking:false` fully suppressed reasoning (598ch→0, wall 15.9s→3.9s) at writer
speed. The newer measurement (newer llama.cpp pin b9870, Gemma template) SUPERSEDES the comment.
Phase 1 therefore ALSO: updates the `openai_compat.py:106-109` comment to the 07-06 truth (cite the
results doc + commit), and records the composition-safety argument — on any model whose template
ignores the toggle, the base rb=1024 still CAPS runaway reasoning, which is exactly the safety
behavior the cap exists for; the layers compose safely in both cases.

**A2 (Phase 1, arch checker) — ctx-tune removal gets a validation gate.** The plan originally
dropped the proven `ctx_len=32768` tune row in favor of computed ctx with no derivation shown.
AMENDED: the consolidation KEEPS the `ctx_len 32768` tune row for this box in `model_tunes_seed`
(tunes win — consistent layering, zero risk); computed-ctx ships for boxes with NO tune (the
fresh-box gap it closes); the §Phase-6 box checks gain "computed ctx on the 2070S == 32768" and only
a LATER pass may retire the tune row once that check passes. The rb tune rows DO drop (the base
bundle carries 1024; the A/B validated the on-CLI form).

**A3 (Phase 4, reuse checker's sharp catch) — the single spawn seam does not exist yet; build it
first.** `runner/process.py` spawns at FOUR `subprocess.Popen` sites (start_runner :515/:517,
start_router :582/:584) with no shared helper, and `RouterHandle` (:445-451) carries no job handle —
so the Job Object would either be a drifting copy across sites or wrap one branch and still orphan;
worse, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kills the child the moment the handle is GC'd if nobody
retains it. AMENDED Phase 4: FIRST extract ONE `_spawn_child(argv, log_path, _popen)` helper that
all four sites call; wrap CreateJobObjectW + SetInformationJobObject(KILL_ON_JOB_CLOSE) +
AssignProcessToJobObject there ONCE (win32 only, ctypes/stdlib); `RouterHandle` gains a
`job_handle` field retained by the service (`lifecycle._spawn_router` ~:1040-1055) until `stop()`.

**A4 (Phase 1+5, grounding checker's load-bearing find) — license provenance made first-party +
the audit de-circularized.** The Apache-2.0 flip clears the never-a-default gate (db.py:105), so the
evidence must be better than the repackager's declared tag. CLOSED 2026-07-06 the same hour: the HF
API confirms `license:apache-2.0` on GOOGLE'S OWN repos — `google/gemma-4-26B-A4B-it`,
`google/gemma-4-26B-A4B-it-qat-q4_0-unquantized` (the unsloth GGUF's declared base_model), and the
whole google/gemma-4 family (31B-it, 12B-it, E4B-it, E2B-it-qat) — not just
`unsloth/gemma-4-26B-A4B-it-qat-GGUF`. Google moved Gemma to Apache-2.0 at Gemma 4; the user was
right. Phase 1's seed comment carries BOTH URLs + the 2026-07-06 retrieval date. Phase 5's audit is
AMENDED to be non-circular for licenses: for each row it checks the GGUF repo's tag AND, when the
repo declares a `base_model`, the BASE repo's tag — a repackager mislabel now flags instead of
self-confirming.

**A5 (grounding checker) — line-ref drift fixed inline** (Phase 2 now cites the re-grounded
QuickSetup locations) and the Phase-5 symbol corrected to `DEFAULT_MODEL_CATALOG_EXTRA`.

## STOPPING POINT (2026-07-06, pre-compact — user: "we need to compact soon…update docs and everything needed in detail") — READ THIS FIRST ON RESUME

**State: the plan is PANEL-CHECKED with all findings folded (this section + the amendments above);
EXECUTION HAS NOT STARTED — zero code written for any phase.** The pickup:
1. Restart drill as always: fetch → compare → `--ff-only` pull on all three repos (origin is the
   truth); re-read the global rules + the JW recap header + THIS PLAN IN FULL (incl. the amendments).
2. The go is STANDING ("i will take your recommendations go") — begin at **Phase 1** (the
   consolidation + seed truth, WITH amendments A1/A2/A4), then Phases 2→5 in order, Phase 6
   continuous. Per-phase discipline unchanged: build → verify (ruff+pytest · build:vite+vitest+full
   smoke+wizard probe · live round-trips) → diff rules-checker → commit+push → append the phase
   record HERE + ledger/recap updates.
3. Dev-DB note: Phase 1 changes seeds → the one-time `POST /v1/data/reset` on any dev DB (and the
   user's box after pulling — their tunes are seed data and re-seed).
4. Open ledger beyond this plan: F1–F5 (JustVoice) · §G box checks (+ the new ones this plan adds:
   orphan-child kill-on-death, computed-ctx==32768, consolidated first load, opt-out sweep UX) ·
   the model-quality research (map contents; Gryphe StyleTune-V2 the credible candidate) · D5 parked.
