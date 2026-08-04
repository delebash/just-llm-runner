# Model-per-hardware plan — one profile, honest seeds, protected QuickSetup, measured everywhere (2026-07-06)

> **STATUS: EXECUTED — ALL SIX PHASES SHIPPED, THE PLAN IS CLOSED (2026-07-06; per-phase records
> below, newest first — the PHASE 6 RECORD carries the final gate tally and the closure
> commit list). What the plan leaves behind is RECORDED, not claimed: the §G box checks on the
> user's Windows machine (orphan kill-on-death · computed ctx == 32768 · sweep-from-scratch
> parity · untuned fit-placed boot · the opt-out sweep UX · llama-fit-params in the win zip) +
> the ledger follow-ups (A5 engine-update surface · C9 model research · D6 Discover/TurboLLM
> study · the D4-1 leg-3 factory-default exposure).** Discipline change (user, 2026-07-06, "do b"
> from the cost-lever menu): the per-phase PRE-BUILD rules-check is DROPPED — the pre-commit
> DIFF check remains the one agent-verdict gate per code commit (the already-launched Phase-5
> design check was stopped mid-run on the same word; grounding + an inline T1–T12 citation
> replace the pre-build agent). Go trail: execution started on the post-compact go ("fold them
> in … you have a go with your plan lets move forward"), then "go ahead and code i will be back
> later just keep coding" + "dont stop coding just comtinue through all phases and turns" — the
> go is STANDING. The post-compact question round added amendments **A6–A10**
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
The model-quality research (leaderboards → Lab; Gryphe evaluation) — refills the map + ranks later;
**the candidate list + guardrails now live as ledger C9** (user-filed 2026-07-06: + the 31B dense
QAT for bigger cards, + the two HauhauCS refusal-ablated builds for fiction writers) ·
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

**USER-SUBMITTED ADDENDUM (2026-07-06, mid-execution — "just found this maybe something better
already built you should research"):** three links checked the same hour. (1)
**autotune / autotunellm.com** (https://www.autotunellm.com/, pip `llm-autotune`) — a drop-in
wrapper for OLLAMA doing PER-REQUEST memory right-sizing: measures the real token count and tells
Ollama the exact minimum KV allocation with headroom, buckets buffer sizes (512/768/1024…) to
avoid Metal-buffer reallocation, and reads OS RAM pressure before every request to step ctx + KV
precision across four tiers. A REQUEST-layer optimizer for a different engine — llama-server's ctx
is launch-fixed (verified upstream earlier), so this layer does not exist for our runner; the
pressure-tier idea rhymes with our arbiter's admission logic, nothing to adopt directly. (2) the
**Medium "LLM-guided HPO/auto-tune"** piece (better-ml, Jaideep Ray) — using an LLM to plan/prune
hyperparameter SEARCH SPACES (training-style HPO methodology, in the same family as
openshift-psap/auto-tuning-vllm = vllm+guidellm+Optuna for datacenter serving). Methodology, not a
local-runtime tool; our sweep's space (batch × ncmoe × spec-n) is small enough for a deterministic
walk — an optimizer/LLM-planner layer is overkill at our scale, recorded not adopted. (3)
**TurboLLM** (https://github.com/mohitsoni48/TurboLLM, 159★, v1.7.3 released 2026-07-06, active) —
the REAL comparable and a correction to this record's headline: a local-LLM manager that
"auto-benchmarks on load" to derive "fast defaults for your exact GPU" ("real measured tokens/sec
… never a synthetic estimate"), tuning the same knob family we do (ngl, MoE CPU-offload, KV-cache
quant type, threads, flash attention, speculative decoding, ctx). So "nobody measures" becomes "no
MAINSTREAM runtime measures — one small active project does, and it independently validates the
measured-sweep bet." Its README does not document the trial structure; ACTION AT A7 BUILD: read
its source for the benchmark/trial design (what it varies, time budget, per-machine caching) as
comparative input. LICENSE GUARD: FSL-1.1 (Apache-2.0 grant only in the future) — free to study,
**code may NOT be lifted** into our GPL/MIT codebase; ideas only, cite what we learn. Net effect
on the design consequence below: UNCHANGED — upstream `--fit` remains the anchor adoption, our
sweep remains the measured layer on top; TurboLLM adds a study reference for the sweep's trial
structure, and the combination (estimate anchor + measured walk + per-machine persisted tunes)
still exists nowhere mainstream.

**✅ DECIDED 2026-07-06 (user: "il take your rec to adopt dont duplicate"): ADOPT — the design
consequence below is the operative Phase-1b direction; the hand-fix alternative is dead.**

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

## PHASE 1b DESIGN — adopt upstream `--fit` (DECIDED 2026-07-06: "il take your rec to adopt dont duplicate" + "go"; written before code)

**The division of labor (the design's one sentence): ctx POLICY stays ours; tensor PLACEMENT
becomes upstream's.** Rationale for the split — upstream fit's documented order (PR #16653:
"first reduces context size … if that is still not enough, it starts moving tensors") sacrifices
CONTEXT before offloading experts, which is the wrong preference for a writing app where context
is a product feature; but its dense-priority MoE tensor placement is exactly the allocator
knowledge our naive `max(0, n_layers - n_gpu)` lacks. So: we always EMIT `ctx-size` (tune wins;
else computed `min(trained_ctx, kv_affordable)` — the plan's original computed-ctx bullet, now
unified with the adopt decision), and for an UNTUNED model we OMIT `n-gpu-layers`/`n-cpu-moe` so
the server's default `--fit on` (in-pin since 2025-12-15 ≪ b9870) places tensors at our chosen
ctx. Explicit values (tunes, preset switches, request overrides) emit exactly as today — which
legitimately disables upstream fit for those args (upstream's own user-set-wins semantics). The
layering doctrine becomes: measured (tunes) > user-set (presets/request) > upstream-fit
(placement, via omission) > our estimate (ADMISSION ONLY — never emitted when not explicit).
**Safety property: boxes WITH tunes (the user's box, the seeded dev container) see ZERO launch
change from 1b — every knob is tune-explicit there; the fit path activates only on fresh boxes
(and after A6's future tune retirement).**

**Grounded seams + the changes, file by file:**
1. `runner/process.py:134-153 overrides_to_pairs` — today unconditionally emits `n-gpu-layers` +
   `ctx-size` (ncmoe when >0). CHANGE: `n_gpu_layers`/`n_cpu_moe` params become `int | None`;
   a `None` OMITS the pair (both renderers — argv and `.ini` — consume the same pairs list, so
   one change covers the spawn and router paths with no drift). `ctx_len` stays required
   (always emitted, per the division above).
2. `runner/process.py:306-344 compute_fit` — UNCHANGED as the estimator (its `vram_mb` keeps
   feeding the arbiter reservation + Fit badges). NEW: `FitPlan` records WHICH knobs were
   explicit (`ov.n_gpu_layers`/`ov.n_cpu_moe` is not None) so the emission layer can decide
   emit-vs-omit; and the ctx leg gains `kv_affordable` — ctx = `ov.ctx_len` if explicit, else
   `min(meta.trained_ctx or DEFAULT_CTX, kv_affordable(...))` where `kv_affordable` is a small
   pure function in `runner/fit.py` derived from the SAME KV bytes/token math `max_gpu_layers`
   already uses (this is ctx POLICY, deliberately ours — not a duplication of upstream's
   allocator).
3. `runner/lifecycle.py:837-842` (active load) + `:989-994` (passive ini): build `ModelIniEntry`
   with `None` ngl/ncmoe when the plan says non-explicit (`ModelIniEntry` fields
   `process.py:~100-104` go `int | None`); tuned models produce byte-identical sections to
   today.
4. **Spawn-failure fallback (the barely-fits caveat, #18066):** if an UNTUNED fit-placed spawn
   fails to reach running, retry ONCE with the explicit computed values (today's exact path),
   then surface the error as today. Bounded, honest, and never worse than the status quo.
5. **`--fit-margin`:** v1 emits nothing (upstream default = 1024 MiB free headroom; a resident
   embed is already subtracted from free VRAM at fit time). A `fit_margin` knob_catalog row is
   recorded as a future knob, not built.
6. **The sweep — A7b adaptive walk + A9 spec-n (`runner/autotune.py`):** `_candidates`' static
   `(+2, −1, −2)` list becomes a bounded WALK — start at the anchor (tune else computed preview,
   as today `:121-123`), measure, keep stepping ±2 in the improving direction while decode tok/s
   improves (cap ~6 steps, `0 ≤ n ≤ block_count`, batch pinned 512/512 as today); the run loop
   goes from for-static-list to generate-next-from-results. NEW candidates for MTP models:
   `spec_n_max` ∈ {2, 3} \ {current} (1–2 cheap trials, only when the MTP gate fired). Baseline
   trial unchanged (on an untuned box it measures the fit-placed launch). Winner/tie-band/save
   semantics unchanged (REPLACE under the machine key). The anchor needs NO log parsing in v1 —
   launch quality comes from upstream fit; the walk covers anchor imprecision by construction
   (a log-parse anchor refinement is recorded as a later option, not built).
7. **Tests:** overrides_to_pairs None-omission (argv + ini) · FitPlan explicit-flags ·
   lifecycle ini generation (untuned MoE → section WITHOUT ngl/ncmoe WITH computed ctx; tuned →
   byte-identical to today) · kv_affordable unit cases · the spawn-fallback (mock child fails
   once → explicit retry) · walk tests over simulated tok/s curves (monotone-improving, peaked,
   noisy-tie) assert stop conditions + bounds + spec-n trials fire only for MTP.
8. **Box checks appended to §G:** fresh-box-style load (tunes absent) boots via fit and serves ·
   computed ctx == 32768 on the 2070S (A2's gate — validates OUR kv_affordable) · sweep-from-
   scratch lands within the tie-band of the hand values (A7) · whether `llama-fit-params` ships
   in the b9870 win-cuda zip (container egress to ggml-org is blocked — the tool target EXISTS
   upstream, `tools/CMakeLists.txt` `add_subdirectory(fit-params)`, verified 2026-07-06; archive
   packaging is a one-command box answer; the tool is an optional preview nicety, NOT load-
   bearing — the design uses the server's own default fit).

### 1b DESIGN AMENDMENTS (2026-07-06 — pre-build checker verdict FAIL(4); every finding real, ALL folded here; the design above is read WITH these)

**RE-CHECK 2026-07-06: PASS — all five findings independently verified RESOLVED** (the re-check
re-derived every code-side citation: FitPlan :99-106 int + its three concrete readers, ModelIniEntry
:226-230, the `_slope_offset:137` KV term, the OOM gate :1181/:1195, the tie-break :153 + band :42;
and confirmed the step-budget math — 37→21 needs 8 steps ≤ 12 — and that the performance-equivalence
reframe is sound, not a dodge). The design is LOCKED; build proceeds (user: "go ahead and code i
will be back later just keep coding").

**1b-F1 (T2 keystone — VERIFIED at the pin's own tag, 2026-07-06):** the ctx-ours/placement-upstream
division rests on user-set `ctx-size` NOT disabling fit. Confirmed from b9870's OWN tree (not
master, not inference): `docs/multi-gpu.md@b9870` — "`--fit` … on by default … **Auto-fit unset
args to device memory**" (a set ctx is not an unset arg; fit adjusts only unset ones), and the
same doc's troubleshooting explicitly describes the COEXISTENCE pattern — "**You may need to
manually set the `--ctx-size` to make the model fit**" (user-set ctx alongside active fit is the
documented remedy, only `tensor`-split mode disables fit entirely). `tools/fit-params/README.md@
b9870` exists in-tag (closing the b9870-ancestry inference rider too) and shows the respect
behavior: when args already align, "no changes needed"; it fits `-c`/`-ngl`/`-ot`. The #18049
full-disable set (`-ngl`/`--tensor-split`/`--override-tensor`) remains the record for which args
suppress placement fitting when user-set — exactly the args we omit for untuned models.
**1b-F2 (T2 citation fix):** `ModelIniEntry` fields are `process.py:226-230` — THOSE go
`int | None`. `FitPlan` (`process.py:99-106`) **stays `int`** — the arbiter (`fit.vram_mb`),
`preview_fit` (`lifecycle.py:540`), and the OOM recovery (`lifecycle.py:1170`) all read concrete
values; the emission layer consults FitPlan's NEW explicit-flags to decide emit-vs-omit.
**1b-F3 (T3 single source):** `kv_affordable` does NOT re-derive the KV term — extract ONE
`kv_bytes_per_token(n_kv_heads, cache_type_bits)` helper from the `_C1 * n_kv_heads * cache_type`
term inside `_slope_offset` (`fit.py:137`); `_slope_offset` AND `kv_affordable` both call it, and
a drift test pins their equality.
**1b-F4 (the fallback made concrete):** `_router_load_with_backoff` (`lifecycle.py:1154-1197`) is
OOM-text-gated and fails fast on non-OOM failures — the barely-fits case (#18066) can present
non-OOM. NEW gate AHEAD of the existing logic: if the entry was FIT-PLACED (ngl omitted) and the
confirmed outcome is ANY failure, re-emit ONCE with the explicit computed values (FitPlan's
concrete ints) and reload; only then the existing OOM-shed / fail-fast applies (now on an explicit
entry, semantics unchanged). Never worse than today's path.
**1b-F5 (the sweep redesign — the checker's sharpest catch):** under adopt, the BASELINE trial is
redefined (tuned box = the tune's launch; untuned box = the FIT-PLACED launch), and the old
tie-break (`_pick_winner` prefers higher explicit ncmoe; baseline reads as −1) would let an
explicit trial that merely TIES the fit baseline get SAVED — permanently disabling upstream fit
over an equal-or-better placement, a regression machine. FIXED SAVE RULE: a tune is saved ONLY
when the best explicit trial beats the baseline STRICTLY beyond the tie band (> the 5% band on
decode tok/s); any tie → the baseline stands and NOTHING is saved (fit keeps governing untuned
boxes; an existing tune keeps governing tuned ones). The higher-ncmoe tie preference survives only
AMONG explicit candidates, never versus baseline. The walk: anchor = tune else computed estimate,
±2 while decode improves, step budget raised to 12 (a 37→21 journey is coverable when each step
improves), abort on plateau; QuickSetup's duration label becomes honest ("a few minutes"). And
the A7 box-check is REFRAMED to performance-equivalence: a from-scratch sweep must land within
the tie band of the hand-tuned config's MEASURED tok/s — the hand values were always a proxy for
performance; if the fit baseline already performs there and nothing gets saved, that is a PASS.
**1b-F6 (T11 named docs + the riders):** docs landing WITH 1b: the runner `README.md` gains a
"how launch config derives" section (the 4-tier doctrine: measured > user-set > upstream-fit-by-
omission > estimate-for-admission-only) · JW `docs/models.md` gets the one-line truth (untuned
models launch with the engine's automatic memory fitting until a tune is saved) · this plan's
phase record. Riders acknowledged in-design: the arbiter keeps reserving OUR estimate for
fit-placed loads (the used-VRAM true-up corrects it on nvidia-smi boxes; on non-measurable boxes
the estimate stays conservatively in force — accepted drift, recorded); `start_runner`'s
single-model path keeps explicit values (an asymmetry, fine — production is router-only, noted
in the code comment).

## PHASE 6 RECORD — EXECUTED 2026-07-06 (runner doc commit, same as this record). Final verify — THE PLAN CLOSES HERE.

**The final gate tally (everything re-run at closure, from the correct repo roots).** Runner:
ruff clean · pytest **380** · the seed-facts audit **11/11 OK, exit 0**. JustWrite: `build:vite`
clean · vitest **29/29** · the FULL headless smoke over every hash route with **zero JS errors** ·
the Phase-D QuickSetup wizard probe **PASS** (Skip cancels the sweep · a tuned pick does NOT
auto-start · a tuned pick offers "Re-optimize" · Re-optimize asks the A8 overwrite confirm first;
0 page errors, 0 non-benign failed requests) · server ruff clean · server pytest **83**.

**The live API round-trips on :17495 (plan §Phase 6's list, verified ATOMICALLY after a clean
`POST /v1/data/reset`).** Catalog: 11 rows with exactly ONE Gemma row (`gemma-4-26b-a4b-qat`) ·
`classPicks` on the wire: `[{minVramMb: 6000, modelId: "qwen3.6-35b-a3b-mtp"}]` · the dev tunes
re-seed after reset (6 rows for the Gemma id — the Phase 2 reset-loses-extras fix holding) ·
engine-presets: 8 rows, ALL on the one Gemma id · prompts: 37 rows with `think=True` exactly
`["chat"]` · preset-assignments: all 9 taskKinds mapped to their seeded `p_*` presets, empty
global default. One verification lesson recorded: an earlier engine-presets read showed
`qwen3-14b-q4_k_m` on all 8 — NOT a seed bug but the wizard probe's leftover (the probe runs its
own reset-then-Apply of a 14b pick, and my first round-trip interleaved with it); the atomic
re-run after a quiet reset shows the true seeded state. Round-trip checks must not share the DB
with a running probe.

**Closure.** All six phases executed on branch `claude/admiring-galileo-il3q0o`: Phase 1a (runner
`4faa39c` + JW `f6f8167`) · Phase 1b (runner `9b65ebb`+`16a4747` + JW `4685939`) · Phase 2 (runner
`39fb9da`+`38d63ee` + JW `86d881e`) · Phase 3 (runner `dc97798`) · Phase 4 (runner `7fcac3f`) ·
Phase 5 (runner `0f3edac`) · Phase 6 (this doc commit + the JW recap commit). JustVoice untouched
throughout (the standing read-only mandate). The outstanding-ledger banner flips in this same
commit; the JW recap header closes the session state in the same series. **Recorded, NOT
claimed** (they need the user's Windows box): the §G checks — kill the JW server → the
llama-server child must die (the SOLE runtime proof of the Phase 4 orphan fix) · computed ctx ==
32768 on the 2070S (calibrates `_KV_CTX_SHARE`, gates the A2 ctx-tune retirement) ·
sweep-from-scratch lands within the tie band of the hand-tuned config (gates the A6 tune-row
retirement) · an untuned fit-placed load boots and serves · whether `llama-fit-params` ships in
the b9870 win zip · the opt-out sweep UX end-to-end.

## PHASE 5 RECORD — SHIPPED 2026-07-06 (runner, same commit as this record). The seed-facts audit script. **PHASE 6 (final verify + closure) runs in the same session — see the STATUS header.**

**What shipped.** `scripts/seed-facts-audit.py` — the standalone stdlib tripwire that verifies the
seeded model catalogs against live Hugging Face facts, exactly per §Phase 5 + amendment A4. Per row
it checks: (1) EXISTS — `hf_repo` resolves on the HF model API (HTTP 200); (2) LICENSE — the seeded
`license` matches the repo's `license:` tag, case/SPDX-normalized (lowercase, `[^a-z0-9.]+`→`-`),
with ONE sanctioned fan-out: the seed's display label "Llama-Community" accepts Meta's per-version
community tags {llama2, llama3, llama3.1, llama3.2, llama3.3, llama4} (`LICENSE_ALIASES` — the
table prints both raw values so the fan-out stays inspectable); (3) BASE — the A4
de-circularization: every `base_model` the repo declares (cardData string-or-list plus
`base_model:*` tags, relation namespaces like `quantized:` stripped) is fetched and the seeded
license must match the BASE repo's tag too, one hop per the amendment's letter — a repackager
mislabel now FLAGS instead of self-confirming; (4) QUANT — the row's `quant` appears
case-insensitively in the repo tree (siblings), and when the row carries `mtp_draft_file` that
exact rfilename must be present as well. Output: a per-row table with honesty markers
("base (none declared — the A4 hop has nothing to check)" when a repo declares no base;
"+mtp-draft" when that check ran) plus per-problem ✗ lines. Exit codes: 0 all-pass · 1 any FACTS
mismatch · 2 network failure (the run ABORTS — a red network run is never a facts verdict). NOT
CI-gated (network); run at any seed change and in sessions (`python3 scripts/seed-facts-audit.py`;
dev container: `SSL_CERT_FILE=/root/.ccr/ca-bundle.crt`).

**Sources + the no-import decision.** Both seed symbols are extracted by AST literal parse
(`load_literal`) — runner `DEFAULT_CATALOG` from `llm_runner/llm/seed.py` (path derived from the
script's own location) and JW `DEFAULT_MODEL_CATALOG_EXTRA` via `--jw-seed` / `JW_SEED_PRESETS` /
the sibling-checkout default (`../justwrite-app/server/justwrite_server/seed_presets.py` — the
layout JW's own Vite kit alias guarantees). Both symbols were verified pure literals before the
build (seed.py:118-179; seed_presets.py:94-106), and `load_literal` fails with a clean message if
a future edit breaks that. No `llm_runner` import and no cross-repo import: the auditor runs with
bare python3 anywhere and must not depend on the package whose seed data it audits. The T3 reuse
question was checked line-by-line, not waved off: `llm_runner/runner/models.py` DOES carry HF
code — but it is the **requests** dep against the *revision/tree* endpoints (models.py:36,60,65)
with no license/`base_model` fetch anywhere, and importing it executes `llm_runner/__init__.py`
which imports the FastAPI router (`__init__.py:12`). The diff checker independently verified both
cites and judged the standalone shape FOLLOWS the codebase's own precedent (models.py's docstring:
"self-contained … without importing the library").

**The in-phase run (the plan's own requirement).** 11 rows audited live (10 runner + 1 JW):
**11 OK / 0 FAIL, exit 0** — on the Phase-1a-corrected seeds, as the plan demanded. Load-bearing
rows: `Llama-Community→llama3.3` with base `meta-llama/Llama-3.3-70B-Instruct=llama3.3`
(gated-repo metadata publicly readable — the alias and the base hop both proven live); the Gemma
row `Apache-2.0→apache-2.0` with base
`google/gemma-4-26B-A4B-it-qat-q4_0-unquantized=apache-2.0` — the audit now automates the exact
non-circular license check that caught the original `license:"Gemma"` seed error ("would have
caught the Gemma error the day it was written" — now it exists and runs). `bge-m3` (gpustack) is
the one row declaring NO base — printed honestly; the A4 hop has nothing to check there. Every
other row's declared base license matched the seed.

**Verification.** Runner: ruff clean (the repo-root walk covers the script; len-100 conforms) ·
pytest 380 (the script imports nothing from the package — suite unchanged). The script ran green
three times during the phase (initial 11/11 · after the honesty-marker tweaks 11/11 · after the
advisory hardening 11/11). SPDX header per repo convention. One ops note: the wrong-cwd
chained-`cd` footgun struck a FOURTH time (the gate commands briefly ran inside justwrite-app —
caught because "83 passed" is not this repo's count; re-run from the runner root, all green).

**The diff checker (the ONE per-phase check under the user's "do b").** VERDICT: PASS — T1–T8 and
T11 PASS, T9/T10/T12 NA. Three non-blocking advisories, two folded immediately: `load_literal` now
raises a clean SystemExit message when a seed symbol stops being a pure literal (instead of a bare
traceback), and `print_table` guards the empty-results case; the third (the phase record + recap
must land in the same series) is THIS record. Discipline note, recorded in the STATUS header too:
per the user's 2026-07-06 "do b" from the checker-cost lever menu, the per-phase PRE-BUILD agent
check is dropped — grounding + an inline T1–T12 citation precede the build, and the pre-commit
DIFF check remains the one genuine agent verdict per code commit. The already-running Phase-5
design checker was stopped mid-run on the same word.

**Honest limits (recorded, accepted).** The audit attests the MOMENT's HF state — repos and
license tags can change after a green run; that is exactly why it exists as a re-runnable tripwire
rather than CI. The base hop is one level (A4's letter). The quant check is a filename substring —
a rename that keeps the quant token would still pass; acceptable for a tripwire whose FAIL side
(a missing file) is the side that matters.

**Docs.** README "What's here (Python core)" gained the script bullet (same commit); this record +
the STATUS header update (same commit); the JW recap header updates in the same series (JW doc
commit).

## PHASE 4 RECORD — SHIPPED 2026-07-06 (runner, same commit as this record). The Windows orphan-child fix.

**The incident + the fix:** stopping the JW server ORPHANED its llama-server child on Windows
(on-box incident 2 — :8080 survived serving a stale generated ini; the user's "restarted with the
correct ini" confusion). Fix: every spawned llama-server child is enclosed in a Windows **Job
Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`** — the OS kills the child when the last job
handle closes, which includes the parent dying. **As built (per A3):** ONE `_spawn_child(popen,
argv, logf)` seam extracted FIRST — both former ad-hoc Popen sites (start_runner's backoff loop +
start_router) route through it (grep-verified the only spawn path; hardware.py's subprocess.run
GPU probes are not spawns); `_win_job_for_child` creates/configures/assigns the job and returns
None off-Windows or on ANY failure (a safety net must never block a spawn); the handle rides
`_ServerHandle.job_handle` (kw_only field) — RETENTION NEEDED NO LIFECYCLE EDIT: the service
already holds the whole handle object on `self._router` until `stop()`, and `stop()` now closes
the job via `_close_job` (guaranteeing the child tree dies); both failed-spawn paths close their
job right after `_kill`.

**The checker trail (a worker restart interrupted the first diff-check; re-spawned):** verdict
FAIL(1) — T2: the Win32 constants/struct layouts/`proc._handle` were from RECALL with no citations,
and a wrong value silently no-ops the safety net (the fabricated-enum failure class the upstream
hard rule exists for); plus the concrete catch that no `restype`/`argtypes` were set, so
`CreateJobObjectW`'s HANDLE return would truncate through the ctypes default c_int on Win64.
**REMEDIATED, all five facts web-verified 2026-07-06 (the citations live in the
`_win_job_for_child` docstring):** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000` and
`JobObjectExtendedLimitInformation = 9` verbatim in golang/sys `windows/types_windows.go`
(SDK-generated) + the kill-on-last-handle-close semantics via Microsoft Learn;
`JOBOBJECT_EXTENDED_LIMIT_INFORMATION` = Basic + **inline `IO_COUNTERS IoInfo`** + 4×SIZE_T and
`IO_COUNTERS` = 6×ULONGLONG, verbatim golang/sys — the verification also REFUTED two
doc-extraction paraphrases encountered en route (an "IoInfo is PVOID" and a "time limits are
DWORD" claim — both wrong vs the SDK-generated sources; paraphrases are not citations);
`JOBOBJECT_BASIC_LIMIT_INFORMATION` = LARGE_INTEGER×2 · DWORD · SIZE_T×2 · DWORD · ULONG_PTR ·
DWORD×2 per Microsoft's own windows-rs bindings (i64,i64,u32,usize,usize,u32,usize,u32,u32) +
the Learn-indexed verbatim head; `proc._handle` per CPython Lib/subprocess.py (`self._handle =
Handle(hp)`, Handle subclasses int). Hardening applied: explicit `restype`/`argtypes` on
CreateJobObjectW / SetInformationJobObject / AssignProcessToJobObject / CloseHandle (HANDLE =
pointer-width `c_void_p`).

**Honest test scope:** +3 unit tests (the seam's wiring contract — argv/stdout/text, job None
off-win32 · fake-win32 graceful degradation, no windll → None and the spawn proceeds · stop()
closes the retained handle) — the POSITIVE Windows path is un-unit-testable off-Windows by
construction, so **the §G box check (kill the JW server → the llama-server child must die with
it) is the sole runtime proof of the orphan fix and must be run + recorded before "fixed" is
claimed on the box.** Doc notes shipped in-diff per the Phase-4 bullet: the SVM plan's
sleeping-child caution (incident 1: direct-to-router clients bypass the arbiter) + the autotune
docstring's bench cache-busting caveat (incident 3) and spec-n note. **Verified:** runner ruff
clean + **380 pytest** (377→380).

## PHASE 3 RECORD — SHIPPED 2026-07-06 (runner, same commit as this record). The class→model map.

**Built to §Phase 3; the diff checker returned FAIL(2) — both findings were THIS record + the
README/recap notes, folded into the same commit series (every code finding passed: the down-ladder
reading of "largest row whose model exists+fits" judged faithful and tested; the placeholder-
equals-§10 claim substantiated against the C2 evidence — qwen3.6-35b-a3b rank 8 is what §10 picks
at ≥6 GB).** What shipped: `db.ModelClassPick` (`min_vram_mb` PK · `model_id` · `built_in`);
`DEFAULT_MODEL_CLASS_PICKS = [{6000: qwen3.6-35b-a3b-mtp}]` — explicitly commented placeholder-
equal-to-§10 until the C9 research refills the rows; `seed_default_class_picks` (merge-by-key,
user edits never clobbered — pinned by test) wired into `seed_llm` so BOOT and RESET both carry it
(the Phase-2 lesson applied); `stores.list_class_picks()`; `CatalogResponse.classPicks` via the
`class_picks_fn` DI seam (the resolve_switches pattern; one fetch, no new endpoint);
kit `pickByClassMap(picks, vramMb, {exists, fits})` in `modelPick.js` (pure, truth-table-tested:
map hit · ladder climb · unfitting-row down-ladder · below-ladder miss · nothing-fits ·
empty-map); `useCatalogMeta` exposes `classPicks` off the same response; QuickSetup's
`bestFittingId()` consults the map FIRST and falls back to `pickBestModel` unchanged. **Verified:**
runner ruff + **377 pytest** (3 new) · `verify-model-pick.mjs` **24/24** (6 new map cases) ·
fresh-DB live wire (`classPicks: [{minVramMb: 6000, modelId: qwen3.6-35b-a3b-mtp}]`) · JW
build:vite + vitest 29/29 + wizard probe 18/18 (the CPU container maps to VRAM 0 → miss → the §10
fallback keeps the 14b pick — probe stable by construction) + full headless smoke zero JS errors ·
runner README notes map-first-then-§10. **NEXT: Phase 4** (the Windows orphan-child Job Object,
with the A3 `_spawn_child` seam extraction) — then Phase 5 (the seed-facts audit script).

## PHASE 2 RECORD — SHIPPED 2026-07-06 (runner `39fb9da` · JW `86d881e`). QuickSetup protection + opt-out sweep.

**Built to §Phase 2 + amendment A8; the diff checker returned FAIL(3) and every finding was folded
before commit** (T3: the tune-read predicate extracted as `modelApply.modelHasTunes` — one source
beside `dominantOf`; T5b: the dangling "pick a larger card above" empty-state copy fixed; T11:
`models.md` updated in-series — the Plan-for-card sentence deleted, the changelist + sweep flow
documented). **What shipped:** (1) the Plan-for-card what-if selector REMOVED (decision #7; zero
references remain; the server's vram_mb param survives for the catalog view); (2) **D4-1 (a)+(c)**
— `applyPreview()` in `modelApply.js` computes the change preview from the SAME `dominantOf` the
Apply writer uses; a CONFIGURED box (mixed task models OR tune rows for a currently-pointed model —
the A8 signal, never the new pick) sees exactly which presets re-point and which are kept, plus the
"your saved machine tunes are never touched" truth, before Apply; fresh boxes stay one-click.
**HONEST OMISSION recorded (the checker's T5a):** the plan's third detection leg (any preset ≠ the
factory seed default) is NOT implemented — no client-readable factory-model source exists; the
uncovered case is ALL presets uniformly on one un-tuned non-factory model (itself only reachable by
a prior one-click Apply or a deliberate all-8 hand re-point). FOLLOW-UP: expose the factory preset
models (the server has them in `configure_app_seed`) + wire leg 3 — a small bounded item, filed
here in the plan.
(3) **The opt-out sweep** — Apply checks `modelHasTunes(pick)`: untuned → the sweep AUTO-STARTS
(save:true) and the done step renders it running with **Skip** (the between-trials cancel endpoint,
which the wizard never called before); tuned → NO auto-start, **Re-optimize** behind an explicit
`confirmDialog` (the user's verbatim overwrite-consent ask; with 1b's strict-beat rule the save
only actually replaces rows on a strictly faster measure); a busy `ok:false` ADOPTS the already-
running shared job; the done copy handles the strict-beat "nothing needed saving" outcome honestly.
(4) **FOUND-AND-FIXED (exposed by the probe's reset-first determinism):** `POST /v1/data/reset`
silently LOST the per-app extra catalog rows + tune seeds — install-time-only seeding meant the
reset's `seed_llm` path never saw them, leaving presets pointing at a vanished catalog id (the
"reset-proof seed data" promise held only for fresh-DB boots, since the 2026-07-06 seeding
session). Fix at the root: `configure_app_seed` registers `model_catalog_extra`/`model_tunes_seed`/
`hw_key_fn` and `seed_llm` — the ONE reseed entrypoint for boot AND reset — seeds them (checker T1
PASS on the shape; the install-time seeding is retained for boot order and calls the same seeders).
**Verified:** runner ruff + 374 pytest · JW build:vite + vitest 29/29 + FULL headless smoke zero JS
errors + the rewritten wizard probe **18/18 PASS** (scenario 1: configured-box changelist renders +
names re-points, untuned pick auto-starts, Skip cancels; scenario 2: tuned pick never auto-starts,
Re-optimize renders and asks the A8 confirm) · JW server 76 pytest · live reset round-trip (post-
reset: the gemma extra row present + 6 tune rows under the machine key). **NEXT: Phase 3** (the
class→model map) — then 4 (the Windows Job Object) and 5 (the seed-facts audit script).

## PHASE 1b RECORD — SHIPPED 2026-07-06 (the derivation half; runner `9b65ebb` + `16a4747` · JW `4685939`). PHASE 1 IS COMPLETE.

**Built exactly to the locked design + amendments 1b-F1..F6 (pre-build checker FAIL(4) → all
folded → re-check PASS; both code commits rode genuine agent PASS verdicts):**
1. **fit.py** — `kv_bytes_per_token` extracted as the ONE KV-term source (`_slope_offset`
   consumes it; a drift test pins the equality, 1b-F3) + `kv_affordable` (ladder ctx
   4096…262144 bounded by `_KV_CTX_SHARE`=0.5 of the VRAM budget — explicitly BOX-GATED: the §G
   "computed ctx == 32768 on the 2070S" check calibrates the share before any tune retirement).
2. **process.py** — FitPlan stays int + gains `ngl_explicit`/`ncmoe_explicit`/`ctx_explicit`
   (1b-F2); compute_fit's ctx = explicit override else `min(trained_ctx, kv_affordable)`;
   `overrides_to_pairs` omits None placement knobs (ctx-size ALWAYS renders); `ModelIniEntry`
   ngl/ncmoe went Optional (`:226-230`, the corrected citation).
3. **lifecycle.py** — both emission sites emit only EXPLICIT placement knobs: tuned boxes render
   byte-identically (the user's box unchanged); untuned sections omit ngl/ncmoe so the child's
   default `--fit` (verified at the b9870 tag, 1b-F1) places tensors at our pinned ctx. 1b-F4:
   a fit-placed entry failing for ANY reason (incl. non-OOM barely-fits) retries ONCE with the
   explicit computed placement, then the pre-existing OOM-shed/fail-fast governs.
4. **autotune.py** — the static ladder became the bounded WALK (probe the anchor when the
   baseline didn't measure it + ±2, step while decode improves, budget 12) + the STRICT-BEAT
   save rule (an explicit candidate wins only beyond the 5% tie band; a tie keeps the baseline
   and saves NOTHING — the checker's regression-by-tie catch, 1b-F5; ties among explicit still
   prefer higher ncmoe) + ONE spec-n alternative trial for draft-mtp bases (A9).
5. **Docs (1b-F6):** runner README "How a model's launch config derives" (the 4-tier doctrine) ·
   JW models.md untuned-launch line · QuickSetup's duration label honest ("a few minutes").

**Verified:** runner ruff + **374 pytest** (361→371 emission half→374 sweep half; 14 new tests:
pairs omission/explicit-zero · explicit flags · trained-ctx cap · kv_affordable bounds/monotone ·
KV drift pin · untuned-omits/tuned-renders ini · F4 retry-once + then-fail-fast · walk-improving
strict-beat · tie-keeps-baseline-saves-nothing · untuned anchor probe · spec-n gate · walk stops
at failure) · JW build:vite + vitest 29/29 + FULL headless smoke zero JS errors + wizard probe
PASS (the label change verified in-flow). **Box checks appended to §G (recorded, not claimed):**
untuned fit-placed load boots + serves · computed ctx == 32768 on the 2070S (calibrates
`_KV_CTX_SHARE`) · sweep-from-scratch lands within the tie band of the hand-tuned config's
MEASURED tok/s (the performance-equivalence reframe) · whether `llama-fit-params` ships in the
b9870 win zip (optional tool; egress-blocked in-container). **NEXT: Phase 2** (QuickSetup D4-1
(a)+(c) protection with A8, card-dropdown removal, opt-out sweep — whose backend semantics now
include the strict-beat rule this phase shipped).

## PHASE 1a RECORD — SHIPPED 2026-07-06 (the seed-truth half of Phase 1; runner `4faa39c` · JW `f6f8167`)

**What shipped (all live-verified on a fresh dev DB the same hour):**
1. **One Gemma catalog row** — `justwrite-app/server/justwrite_server/seed_presets.py`: the
   `writing-assistant-gemma-moe-mtp` / `book-chat-gemma-moe-mtp` pair collapsed into
   `gemma-4-26b-a4b-qat` ("Gemma 4 26B-A4B (QAT)"), same verified facts (unsloth GGUF repo, quant
   UD-Q4_K_XL, MTP draft file, trained_ctx 262144, min 4 GB VRAM / 24 GB RAM, tier low-vram-moe),
   **license "Gemma" → "Apache-2.0"** with the full first-party provenance comment (A4), rank 9
   kept with the reasoned-not-instrument-cited annotation, description rewritten one-model-both-uses
   with the measured numbers + tuning-doc pointer. The file's header comment now records the
   one-profile truth and its measured basis. `use_limited` clears deterministically
   (`"Apache-2.0"` matches no `_USE_LIMITED_TERMS` keyword) — the never-a-default gate opens;
   the keyword list itself is UNTOUCHED (older Gemma-Terms models must stay flagged).
2. **All 8 engine presets re-pointed** to the one id (`DEFAULT_ENGINE_PRESETS`) — samplers,
   top_p, json_mode, positions all unchanged.
3. **Tunes re-keyed + honest** (`DEFAULT_MODEL_TUNES`): the writer row died with its identity; the
   one row carries ngl 99 · ncmoe 21 · **ctx_len 32768 (KEPT per A2** until computed-ctx is
   box-validated) · batch/ubatch 512/512 · threads 8; the CPU-embed row stays; the
   reasoning-budget flags LEFT the tunes (now bundle policy). The comment block is the A6 record:
   DEV-ONLY convenience, machine-key inertness (`gpu.name|vram|cores|ramGB` — the user's real key
   is `NVIDIA GeForce RTX 2070 SUPER|8192|16c|31g`), the retirement condition (A7 box-checks pass),
   and production-never-ships-them.
4. **Per-task think flags** (`seed_feature_prompts.py`): grounded reality was ALL 26 prompts
   think:False — the app path never thought anywhere. Per the approved Phase-1 mapping, `chat`
   (grounded book-chat) flipped to **think: True** — the ONE thinking task, capped engine-side;
   `characterChat` stays False (dialogue), `briefing` stays False (digest), every json_mode task is
   B3-gated regardless. ⚠ USER-VISIBLE BEHAVIOR CHANGE, surfaced in the ship report: grounded chat
   now reasons before answering on the app path (deeper, slower — bounded by rb 1024 ≈ ~30 s
   worst-case think at 32 t/s); a one-line revert if unwanted.
5. **rb → the base switch bundle** (`llm_runner/llm/seed.py:183-195`): `reasoning_budget "1024"` +
   `reasoning_budget_message` seeded in `base` for EVERY local model (A9: semantic policy belongs
   in bundles). Both values differ from the knob defaults (-1 / "") per the file's one-source rule.
   The measured-composition rationale comment cites the A/B (A1).
6. **The stale toggle comment fixed** (`llm_runner/llm/openai_compat.py:104-116`, A1): the
   2026-07-04 "works only when no hard reasoning-budget is on the CLI — we emit none" claim is
   superseded by the 2026-07-06 measurement (toggle fully works WITH rb 1024 on CLI at b9870); the
   composition-safety argument is recorded in the docstring.
7. **Test updated**: `tests/test_switch_resolve.py::test_unknown_model_empty` — the exact base-set
   assertion gains the two new keys (the only such assertion, checker-confirmed).
8. **Docs in-series**: the tuning doc gained the CONSOLIDATED-TO-ONE-PROFILE banner (the two-entry
   seeding paragraph marked HISTORY; the hand `models.ini` explicitly untouched — it remains the
   user's manual-router instrument). `docs/models.md` REVIEWED with the verdict **no substantive 1a
   change** (it enumerates no per-row Gemma content; its Plan-for-card sentence is Phase 2's
   removal) — recorded per the pre-build checker's T5 catch instead of silently dropped. Old-id
   references now exist ONLY in history docs (this plan's context, the tuning doc's history
   paragraphs, the ab-test doc, recap history) — deliberate, they are the record.

**Verification (all green):** runner ruff + **361 pytest** · JW server ruff + **76 pytest** (count
unchanged vs HEAD — stash-proven) · live fresh-DB on :17495: catalog = ONE gemma row
(`Apache-2.0`, useLimited false, rank 9, old ids ABSENT, 11 rows total) · 8/8 presets on the one
id · model-tunes = exactly the 6 flags under the container key `cpu|4c|15g`, NO rb rows · the
resolved base bundle carries rb 1024 + message · think flags = exactly `{chat: True}` of 37 ·
JW build:vite clean · vitest **29/29** · FULL headless smoke ZERO JS errors · wizard probe
**10/10** · **the one-row license audit pulled forward from Phase 5 and RUN LIVE** (the pre-build
checker's rider): `google/gemma-4-26B-A4B-it`, `google/gemma-4-26B-A4B-it-qat-q4_0-unquantized`,
`unsloth/gemma-4-26B-A4B-it-qat-GGUF` — all three `license:apache-2.0` (tags + cardData), the
base_model chain intact · **trained_ctx first-party confirmed** (the diff checker's residual):
Google's own `config.json` says `max_position_embeddings: 262144`, `num_hidden_layers: 30`,
128 experts — the seeded facts match exactly.

**Checker trail:** pre-build checker **FAIL(1)** — T5, the models.md bullet silently dropped +
the doc-coverage table demand + the pull-the-audit-forward recommendation — ALL folded (see item
8 + the audit above). Diff checker on the final diff: **PASS, zero FAILs** (independently
re-verified the rb single-source, the zero orphan code references to the deleted ids, the lone
base-set test assertion, and the `_use_limited` derivation).

**Mid-execution user round (same hour, all recorded where they belong):** the three
user-submitted links researched into the A10 addendum (autotunellm = Ollama request-layer wrapper;
LLM-guided-HPO = training methodology; **TurboLLM = the real measured-benchmark comparable**,
FSL-licensed study-only — and the license-mixing analysis the user asked for is in the session
chat: FSL code cannot be vendored into GPL/MIT trees, study-and-reimplement is the sanctioned
path); ledger **A5 filed** (the engine-update surface — Update-now + Off/Notify/Auto policy,
Notify default — from the user's TurboLLM screenshot).

**PHASE 1b — ✅ DECIDED 2026-07-06: ADOPT (user: "il take your rec to adopt dont duplicate" +
"go").** The derivation half — computed ctx + the sweep-anchor fix (A7) — builds on the adopt
shape: obtain the no-tune anchor FROM the upstream fitter (fit once per (model, machine, build),
cache it; tunes still win and legitimately disable fit), keep our sweep as the measured layer on
top with the adaptive walk. The build design + at-build verifications (llama-fit-params in the
b9870 assets · how fitted values are read · the cache table · --fit-margin composition with the
arbiter · the barely-fits fallback) are recorded in the §PHASE 1b DESIGN section appended below
as execution proceeds.
