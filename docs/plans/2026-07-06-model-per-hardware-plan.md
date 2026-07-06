# Model-per-hardware plan — one profile, honest seeds, protected QuickSetup, measured everywhere (2026-07-06)

> **STATUS: EXECUTION IN PROGRESS (the go re-confirmed post-compact 2026-07-06: "fold them in …
> you have a go with your plan lets move forward") — per-phase execution with the standing
> discipline (design→build→verify→diff-checker→commit per phase). LIVE tracker: per-phase records
> appended below as phases ship.** The post-compact question round added amendments **A6–A10**
> (§USER-ROUND AMENDMENTS below): A6/A7/A9 modify Phase 1's seed + derivation work, A8 modifies
> Phase 2's protection/sweep UX, A10 is research-before-build for the sweep and runs FIRST. Born
> from the 2026-07-06 model-per-hardware discussion; the measured basis is
> `justwrite-app/docs/plans/2026-07-06-onbox-profile-ab-test.md` (RESULTS, bc614c6).

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

## USER-ROUND AMENDMENTS A6–A10 (2026-07-06 post-compact — the seeding/auto-tune question round; folded on the user's "fold them in … you have a go with your plan lets move forward")

The post-compact question round ("I have a question before you start coding") re-examined the
seed-vs-tune story and produced five further amendments. The user's driving points, verbatim: *"so
we have a special seed just for me? my point is that a user with 8gb vram 32gb ram wouldnt they
have same settings"* · *"it took a while to fine tune this model i dont thinkt the quick tune will
get good values versus what i had to test"* · *"my tunes being seed data does not make sense, in
development fine, but in production it will be an install file i wont have my default in
produciton"* · *"On precfigure box we my want a notfication that you have an exisintg config doe
you want to overwrite with this tune data"* · *"so you are saying that if i have a 32gb vram these
would stay the same … that alos does not make sense beside threads"* · *"also maybe research if
other llms do auto tunning like this, doeas ollama, lm studio, if so how"*.

**A6 (Phase 1) — personal tune rows are NOT product data; staged retirement from the seed.** The
grounding fact (`llm_runner/runner/hardware.py:56-68`): `machine_key` = `gpu.name|vram|cores|ramGB`
— the seeded 2070S rows match ONLY a literal "RTX 2070 SUPER|8192|<cores>c|32g" box, so in a
production installer they are inert fingerprint rows shipped to every user; they are NOT "defaults
for 8 GB boxes" (a 3060 8GB/32GB user inherits nothing from them — different key). Tunes are USER
data (written to the user's DB by the Tune-modal Save and by the sweep), not product data. AMENDED
Phase 1: the consolidated `model_tunes_seed` rows (ncmoe 21 · batch 512 · ubatch 512 · threads 8 ·
ctx_len 32768 per A2 · the CPU-embed row) are KEPT for now as DEV-ONLY convenience with a loud
comment stating exactly that, plus the recorded RETIREMENT CONDITION: they are deleted the moment
the A7 box-checks pass (the derivation + fixed sweep reproduce them from scratch on the user's
box) — and production packaging never ships them regardless. The user accepted this staged shape
(the replacement gets proven before the safety net is removed — the same pattern as A2's ctx-tune
gate). Open sub-decision AT BUILD, record here when decided: where the embed-on-CPU truth (embed
ngl 0 — frees 684 MB on an 8 GB card, query latency unchanged at 46 ms) lives for OTHER boxes —
candidate: a policy default for embed-role models on VRAM-constrained boxes vs staying per-box
measured.

**A7 (Phase 1/2 — the user's sweep skepticism, verified CORRECT and worse than stated) — the
derivation and the sweep get fixed as GENERAL logic; the user's machine is the TEST ORACLE, never
the target.** Verified: the sweep anchors at the existing tune or the COMPUTED value
(`autotune.py:121-123`) and tries the fixed deltas +2/−1/−2 (`autotune.py:124`) — it refines a good
anchor and can NEVER escape a bad one (the user's manual journey was ncmoe 37→21; from anchor 37
the ladder explores 35–39 and crowns ~35). The computed anchor is `n_cpu_moe = max(0, n_layers -
n_gpu)` (`process.py:329-332`) and nobody has verified what it produces on an 8 GB box. AMENDED:
(a) audit + fix the computed-ncmoe formula (the fit math's per-layer/expert/KV accounting) so it
lands NEAR the measured floor from hardware numbers alone — a model/box-generic math fix; (b) make
the ladder ADAPTIVE — keep walking in the improving direction until tok/s stops improving
(bounded), instead of the fixed ±2 window; (c) box-checks (the user's box, recorded not claimed):
computed ncmoe ≈ 21 (32k ctx, CPU embed co-resident) · computed ctx == 32768 (A2's check) · a sweep
FROM SCRATCH lands within the tie-band of the hand-tuned values. The literal 21 appears in no code
— it is the known optimum the general algorithm must reproduce to be believed (the user's framing
question answered explicitly: NOT "fix autotune to match my machine" — fix the general math,
validate it on the one box where the true optimum is known).

**A8 (Phase 2) — overwrite consent on tuned boxes + the detection-signal fix.** (a) The D4-1
"configured box" detection must query tunes for the CURRENTLY-POINTED preset models (dominantOf of
the existing presets), NOT the wizard's new pick — on the user's box the pick would be Qwen (rank
8) with zero Qwen tunes, so the original "?modelId=<pick>" wording would read the box as fresh and
skip the changelist entirely. (b) Since the sweep's save REPLACES the (model, machine) rows, the
"Re-optimize" button on a box with existing tune rows gets an explicit kit `confirmDialog` first —
"This machine already has a tuned config for this model (…the current values…) — overwrite it with
the new sweep results?" — per the user's verbatim ask. Auto-start still never fires on a tuned box
(unchanged from the base Phase-2 design).

**A9 (Phase 1 — the 32-GB challenge) — the layering principle sharpened: bundles carry ONLY
semantic policy + model mechanics; budget-shaped optima live in the computed layer; the sweep
covers what math can't predict.** The user's catch: q8_0 KV and spec-n-max 2 were 8GB-born
compromises about to ship as universal constants. Resolution per knob: `reasoning-budget 1024`
stays base (a semantic safety cap, hardware-independent — the user's own decree; a 32 GB card
thinks the same tokens, just faster). `spec-type draft-mtp` + the draft file stay MTP-bundle (model
mechanics), but `spec-draft-n-max` optimality is hardware-conditioned (the draft/target speed
ratio changes completely when the target runs fully on-GPU) → **spec-n joins the sweep's candidate
set** (MTP models only; the seeded 2 remains the starting default). `cache-type-k/v q8_0`: the
"near-lossless" claim gets WEB-VERIFIED at build (upstream evidence, cited URLs + date) — if it
holds, q8_0 stays universal BY EVIDENCE as deliberate policy ("spend VRAM on context, not KV
precision" — coherent at every card size); if it does not hold, KV type moves to the COMPUTED
layer (f16 when affordable at the target ctx, q8_0 when needed to afford it). `mlock` stays base
(helps offload boxes, harmless otherwise — recorded as defensible-not-sacred). ngl/ncmoe/ctx are
already computed — hardware-ADAPTIVE by construction (a 32 GB box gets ngl=all, ncmoe=0, ctx=the
full trained window; "computed" means adaptive, the opposite of stays-the-same).

**A10 (research-before-build — the user's ask) — competitive auto-tune survey.** Before building
A7's sweep/derivation changes: research how the other local-LLM runtimes adapt engine config to
hardware — **Ollama, LM Studio**, and the llama.cpp ecosystem itself (+ neighbors like koboldcpp
where informative): do they COMPUTE (estimate from VRAM/model geometry), MEASURE (benchmark trials
like our sweep), or leave it MANUAL; what exactly do they auto-set (offload layers, ctx, KV type,
batch); and how do they handle being wrong (overrides, env vars, fallbacks). Findings recorded
HERE with cited URLs + retrieval date (the upstream hard rule), feeding A7's design (T4
adopt-before-build — if someone already solved adaptive tuning well, adopt the shape; if nobody
measures, that is a recorded differentiator, not a reason to skip the fix).

### A10 RESEARCH RECORD (survey run 2026-07-06; all URLs retrieved that day)

**The headline: EVERY runtime in the field COMPUTES (estimates); NOBODY MEASURES. Our sweep —
real load→measure trials picking a winner by observed tok/s — has no equivalent in Ollama, LM
Studio, koboldcpp, or llama.cpp itself. The measured layer is a genuine differentiator and stays.
The compute-anchor problem, however, is SOLVED UPSTREAM, in the engine we already ship.**

Per-runtime findings:

1. **llama.cpp itself (the engine our runner spawns)** — PR #16653 "llama: automatically set
   parameters not set by the user in such a way that maximizes GPU utilization", MERGED 2025-12-15
   (https://github.com/ggml-org/llama.cpp/pull/16653) — seven months before our b9870 pin, so THE
   PINNED BUILD CARRIES IT. It adds: `--fit on|off` (ON BY DEFAULT in llama-server), `--fit-ctx`
   (minimum acceptable ctx, default 4096), `--fit-margin` (free-VRAM margin to leave, default
   1024 MiB), the `llama_params_fit` C API, and a standalone `llama-fit-params` binary that "does
   the fit and prints the resulting CLI arguments to stdout". Algorithm (PR + discussion
   https://github.com/ggml-org/llama.cpp/discussions/18049): ESTIMATION via iterative VIRTUAL
   ALLOCATIONS (dummy models/contexts with `no_alloc`, the same accounting as the memory-breakdown
   feature) — first check as-is, then REDUCE CTX, then move weights to RAM **prioritizing dense
   tensors on GPU for MoE models** ("dense tensors are prioritized for better MoE performance" —
   exactly the expert-offload geometry our naive `max(0, n_layers - n_gpu)` anchor lacks). CRITICAL
   INTERACTION: **auto-fit DISABLES ITSELF when the caller sets `--n-gpu-layers`/`--tensor-split`/
   `--override-tensor`** — and our launch path always emits computed `-ngl`/`--n-cpu-moe`, so today
   we actively SUPPRESS the upstream fitter and substitute our weaker math. Known caveats to
   respect at build: fitting takes seconds per load (4–20 s reported on multi-GPU; the docs' table
   documents `--fit` default-on, https://github.com/ggml-org/llama.cpp/blob/master/docs/multi-gpu.md);
   unreliable/racy edges when a model only barely fits (issues #18066, #18085); some models'
   context memory mis-accounted (#19980 mmproj, Qwen3-Next reports in #18049).
2. **Ollama** — pure computation, no measurement: estimates per-layer weight+cache needs against
   detected free VRAM in estimation→allocation→commitment phases (new-engine memory management,
   https://deepwiki.com/ollama/ollama/5.4-memory-management-and-gpu-allocation); known to misjudge
   near the boundary and on MoE multi-GPU (https://github.com/ollama/ollama/issues/14351); the
   escape hatch is the manual `num_gpu` Modelfile parameter. KV-cache type is a GLOBAL env opt-in
   (`OLLAMA_KV_CACHE_TYPE`), not hardware-derived. No per-machine persistence of good values.
3. **LM Studio** — a conservative built-in ESTIMATOR ("auto… usually a few layers under what your
   card could actually handle"; beta memory estimator that under-accounts KV growth), manual
   offload slider as the override; and — the strongest signal — LM Studio has an OPEN FEATURE
   REQUEST to adopt llama.cpp's `llama_params_fit`
   (https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1673): the field is converging on
   the upstream fitter we already ship.
4. **koboldcpp** — `--autofit` / `--gpulayers -1`: estimation of layers + MoE tensor overrides +
   tensor splits; its own wiki recommends "determine the optimal layer fit through trial and error
   for best results" (https://github.com/LostRuins/koboldcpp/wiki,
   https://github.com/LostRuins/koboldcpp/issues/390) — i.e. it documents the gap our sweep fills.

**Design consequence for A7 (the anchor fix) — T4 adopt-don't-duplicate:** hand-fixing our
`max(0, n_layers - n_gpu)` formula to encode expert-vs-dense placement would DUPLICATE the
allocator knowledge upstream now maintains (and ours would drift with every engine release). The
adopt-shaped fix: for the NO-TUNE case, obtain the anchor FROM the upstream fitter — either by
omitting `-ngl`/`--n-cpu-moe` and letting the server's default `--fit` place tensors (with
`--fit-margin` covering embed co-residency headroom), or by running `llama-fit-params` once and
CACHING its printed values — then the sweep walks from that anchor and the saved tune (explicit
flags) governs every later load, which cleanly disables upstream fit exactly when we know better
(measured > estimated > none — the layering already expresses this). Fit-cost note: delegating on
EVERY load would add the fitter's seconds to every model switch, so the anchor should be computed
once and cached (tune-row-with-provenance or equivalent), not re-fit per load. OPEN AT BUILD
(verify before designing the seam): whether `llama-fit-params` ships in the b9870 release-asset
zips we download; how the chosen path reports the fitted values (stdout parse vs server log vs
`/props`); and the barely-fits reliability caveats above. **This adopt-vs-hand-fix choice is
load-bearing and is SURFACED to the user with a recommendation before the derivation half of
Phase 1 builds (rule 6); the seed-truth half of Phase 1 is independent of it and proceeds.**

## STOPPING POINT (2026-07-06, pre-compact — user: "we need to compact soon…update docs and everything needed in detail") — READ THIS FIRST ON RESUME

**State: the plan is PANEL-CHECKED with all findings folded (this section + the amendments above);
EXECUTION HAS NOT STARTED — zero code written for any phase.** *(SUPERSEDED 2026-07-06 post-compact:
the question round added amendments A6–A10 and the user re-confirmed the go — "fold them in … you
have a go with your plan lets move forward" — execution began the same day: A10 research first,
then Phase 1 WITH A1/A2/A4/A6/A7/A9. Per-phase records appended below as they ship.)* The pickup:
1. Restart drill as always: fetch → compare → `--ff-only` pull on all three repos (origin is the
   truth); re-read the global rules + the JW recap header + THIS PLAN IN FULL (incl. the amendments).
2. The go is STANDING ("i will take your recommendations go") — begin at **Phase 1** (the
   consolidation + seed truth, WITH amendments A1/A2/A4/A6/A7/A9; A10 research runs first), then
   Phases 2→5 in order, Phase 6 continuous. Per-phase discipline unchanged: build → verify
   (ruff+pytest · build:vite+vitest+full smoke+wizard probe · live round-trips) → diff
   rules-checker → commit+push → append the phase record HERE + ledger/recap updates.
3. Dev-DB note: Phase 1 changes seeds → the one-time `POST /v1/data/reset` on any dev DB (and the
   user's box after pulling — their tunes are seed data and re-seed).
4. Open ledger beyond this plan: F1–F5 (JustVoice) · §G box checks (+ the new ones this plan adds:
   orphan-child kill-on-death, computed-ctx==32768, consolidated first load, opt-out sweep UX) ·
   the model-quality research (map contents; Gryphe StyleTune-V2 the credible candidate) · D5 parked.
