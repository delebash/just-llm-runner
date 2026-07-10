# OUTSTANDING MASTER PLAN — every open item across the three repos, verified twice (2026-07-06)

> **PURPOSE.** The ONE ledger of everything genuinely outstanding across `just-llm-runner` (+ the `@delebash/llm-ui` kit inside it), `justwrite-app`, and `JustVoice` — built at the user's direction after tracker mistakes were found: *"i want new master plan with all outstanding items verified against code, then reverify … including jv outstanding items, we are not coding anything … verify this info twice."* **METHOD:** every item's status was (pass 1) verified by the author against code with file:line or a live endpoint, then (pass 2) independently re-verified by adversarial rules-checker agents instructed to refute each claim and to hunt for items MISSED by this list. Both evidence columns are recorded per item. **No code was written in this exercise** (three tracker/doc corrections only, listed in §H).
>
> **How to read STATUS:** `NOT BUILT` = the feature/change does not exist in code (evidence cited) · `DECISION` = nothing to build until the user decides · `BOX` = built, but only verifiable on the user's Windows machine · `RESEARCH` = a reading/benchmarking deliverable, not code.
>
> **✅ THE EXECUTION VEHICLE CLOSED (2026-07-06 night): `2026-07-06-model-per-hardware-plan.md` —
> ALL SIX PHASES EXECUTED** (per-phase records + the final gate tally in that plan's PHASE 1a–6
> RECORDS; closure commits: runner `4faa39c`/`9b65ebb`+`16a4747`/`39fb9da`+`38d63ee`/`dc97798`/
> `7fcac3f`/`0f3edac` + JW `f6f8167`/`4685939`/`86d881e`). It consumed this ledger's D4 (fully
> decided) and shipped: the one-profile consolidation + seed truth (ONE Gemma row Apache-2.0,
> rb→base bundle, ctx→computed), fit-by-omission + the strict-beat adaptive sweep, QuickSetup
> protection (changelist + card-dropdown removal + the opt-out sweep) + the reset-loses-extras
> found-and-fix, the class→model map mechanism, the Windows orphan-child Job-Object fix, and the
> seed-facts audit script (11/11 live). **Still open FROM that work: the §G box checks on the
> user's Windows machine (the orphan kill-on-death proof · computed ctx == 32768 · sweep parity ·
> untuned fit-placed boot · the opt-out sweep UX · llama-fit-params in the win zip) and the
> ledger items A5 · C9 · D6 + the D4-1 leg-3 factory-default follow-up (filed in that plan's
> Phase 2 record).**
>
> Supersedes, as the outstanding-work view only: the open-item scatter across `2026-06-28-MASTER-PLAN.md` (the roadmap archive — **fully folded 2026-07-08 via §I below**, so the master never needs to be opened as a tracker again), `2026-06-28-ai-state-grid.md` (whose two ⚠ forks are now: per-model-tune-save → RESOLVED by Plan B; json-grammar → item C1 here), and the per-plan LIVE trackers (which stay authoritative for their own shipped history).

---

## A. Bundled engine / runner — hardware + platform gaps

- **A1 — AMD and Intel VRAM detection — ✅ SHIPPED 2026-07-06 (the A–E batch; full design + verification in `2026-07-06-a-to-e-execution.md` §A1).** `hw.gpus` now carries real AMD/Intel rows: Linux via the kernel sysfs scan (amdgpu `mem_info_vram_total` byte-exact; Intel VRAM honestly None — no stable merged ABI), Windows via the display-class registry (`DriverDesc` + 64-bit `qwMemorySize`, stdlib winreg — AdapterRAM's uint32 cap never used). Fit + the per-machine tune key now work on those boxes; NVIDIA fast-path unchanged; 7 new tests, suite 331. Windows registry walk is desktop-gated → box check **G6**.
- **A2 — Intel Arc discrete GPUs auto-route to the Vulkan build — ✅ SHIPPED 2026-07-06 (same batch; §A2).** `detect()` routes `vulkan` when a scanned Intel row's name matches the Arc-discrete pattern (`\barc\b|dg1|dg2|battlemage`); iGPU-only Intel boxes stay CPU (the recorded scope). `binary.py` needed no change — its vulkan preference row already existed.
- **A3 — Spawn-time backend retry chain (ROCm → Vulkan → CPU) — ✅ SHIPPED 2026-07-06 (the A–E batch; full design incl. the per-variant binary layout + install-content consequence in `2026-07-06-a-to-e-execution.md` §A3).** A `RunnerStartError` at router spawn now chains across builds ALREADY on disk (never downloads at load — decision A preserved): per-variant dirs (`<build>/<gpu>/`, legacy root still honored for the selected asset), the engine install plants the safety net (selected + cpu, + vulkan on a rocm pick, best-effort), the proven exe is remembered so bounces never re-try a broken build, and an all-fail aggregates every backend's exit-code+tail reason. 9 new tests, suite 340. On-device rescue = a G3 companion check.
- **A4 — Linux CUDA engine install (the docker route) — ✅ RESOLVED-RESCOPED 2026-07-06 (the A–E batch; full upstream evidence + design in `2026-07-06-a-to-e-execution.md` §A4; the re-scope is surfaced to the user, not silently decided).** The wiring-as-recorded turned out to be IMPOSSIBLE pin-faithfully: upstream discontinued per-build container tags (b47xx-era only; every b96xx probe 404s on ghcr; only rolling `server-cuda*` tags remain, which track master) — and our config's `server-cuda12-b9644` image tag never existed. Shipped instead: Linux+NVIDIA boxes stop dead-ending — `detect()` records the vulkan fact there, `select_binary` never auto-picks docker rows, so those boxes get the REAL pinned `linux/vulkan` b9644 archive (+ cpu chain via A3's install extras); the docker row stays as the future seam with the digest-capture procedure for the next pin bump recorded. The full container spawn builds THEN, pin-faithfully — not now against a rolling tag.

- **A5 — engine update surface (pinned-build bump UX) — ✅ SHIPPED 2026-07-06/07 (this line was
  stale, corrected 2026-07-07): the update CHECK + "Update available bNNNN" button + the
  `updatePolicy off|notify` (default notify, no Auto — the verified-pin discipline) landed in the
  providers-surface ROUND 3 (`2026-07-06-providers-surface-redesign.md` §ROUND 3), and the
  update-REPLACES-old-folder + Reinstall semantics landed in its ROUND 10; the pin is b9899 since
  ROUND 17 and the user's box took the update live.** The original filing record follows for
  history — NOT BUILT (user-filed 2026-07-06: "add to
  todo, nice engine update feature", from a TurboLLM screenshot of its Engines page).** What exists
  today: the pin is a `runner_setting` row (`pinned_build`, seeded from `runner/config.py`
  `DEFAULT_PINNED_BUILD` = b9870) and the engine-config endpoint + `LuRunnerBinaries` editor let a
  user hand-edit the pin/URLs — but nothing DETECTS that upstream has newer builds, offers a
  one-click update, or carries an update policy. The reference UX (TurboLLM v1.7.3, the user's
  screenshot): an "Update available · b9608 → b9888" line on the engine row plus a menu — **Update
  now / Disable / AUTO-UPDATE: Off · Notify · Auto**. Shape when built: (a) an update CHECK against
  the ggml-org/llama.cpp releases API (latest bNNNN vs the pinned build), surfaced on the Built-in
  provider's engine section; (b) **Update now** = re-run the existing acquire path for the new
  build (per-variant dirs already exist via A3), verify the release's asset names (the pin-bump
  discipline that caught the b9644→b9870 rename risks), write the new `pinned_build` setting,
  respawn; (c) a policy setting **Off / Notify / Auto with NOTIFY as the default and Auto shipped
  disabled-or-absent initially** — our pin is a VERIFIED pin (flag semantics move between builds:
  reasoning-budget, the ini fields, and now the PR#16653 `--fit` behavior were each verified AT a
  specific pin), so silent auto-bumps conflict with the verification discipline; Notify preserves
  it (surface, then a deliberate click); (d) the A4 digest-capture procedure rides every bump.
  Box observation from the screenshot: the user's TurboLLM runs llama.cpp b9608 < our pin b9870 <
  upstream b9888 (2026-07-06) — an update check would have surfaced exactly this skew.

## B. Model-surface — the two remainders

- **B1 — Show the engine knobs before the engine is installed — ✅ SHIPPED 2026-07-06 (the A–E batch; full detail in `2026-07-06-a-to-e-execution.md` §B1).** The `v-if="installed"` that gated the whole resident block now wraps ONLY the runtime half (the "Loaded models" list + VRAM line); the two knobs render/seed/save before install (seeding safe pre-install: `GET /v1/llm-runner/resident` works router-down, `runner/api.py:204-215`). Verified: extended `resident-panel-probe.mjs` 13/13 incl. the new not-installed scenario + full smoke zero errors.
- **B2 — Auto-composed model description at Add time — ✅ SHIPPED 2026-07-06 (the A–E batch; full detail in `2026-07-06-a-to-e-execution.md` §B2).** `inspectLink()` now ends by composing the plain-language description from the read facts (params/kind/context/MTP/quant+QAT+size) into an EMPTY field only — hand-typed text is never clobbered. Verified live against the user's real gemma repo: composed "128x2.6B mixture-of-experts model · 256k context · MTP draft for faster generation · UD-Q4_K_XL (QAT) · 13 GB"; no-clobber probe check green.

## C. Shared LLM stack / kit

- **C1 — Grammar-guaranteed JSON output (json_schema / GBNF) — ✅ SHIPPED 2026-07-06 (the A–E batch; full design + the two found-and-fixed adjacent #18 bugs in `2026-07-06-a-to-e-execution.md` §C1).** Per-action `json_schema` (action-grain; presets stay shape-free) flows from the seeded/edited row through `_response_format()` (nested OpenAI form, degrade-on-invalid) into per-backend translations: builtin runner flattened to the b9644-documented form (converted to grammar server-side), Ollama `format=<schema>`, Gemini `responseSchema`, Anthropic strips (no such param — that strip also fixes #18's silent leak there). PromptLab edits it; JW seeds `entitySweep`'s real shape end-to-end; the prompts PUT is now preserve-on-omit (the found wipe bug). Runner 350 tests; live PUT/GET + preserve proof on :17495; smoke clean. The model-side enforcement quality remains a box observation (C2's benchmark scope).
- **C2 — Measured per-tier model benchmarks.** STATUS: **✅ PASS-1 DONE 2026-07-06** (the A–E batch; the URL-cited evidence table + verdicts in `2026-07-06-a-to-e-execution.md` §C2). The published-benchmark re-grounding swept all 10 catalog models and found ONE contradiction, fixed in `seed.py`: **Qwen3.6-35B-A3B now ranks 8, GLM-4.5-Air 10** — both vendors' cards (MMLU-Pro 85.2 vs 81.4, IFEval 88.2 vs 86.3) and the independent Artificial-Analysis harness (GPQA-Diamond 84.1 vs 73.3) agree; GLM's description drops the unsupported "top" claim. The Llama-70B-vs-Qwen3-32B PROSE ordering has NO published instrument (EQ-Bench v3's data checked — neither model listed) and stands on its recorded reasoned basis, now honestly annotated; the dense-family and embedder orderings are supported. Per-task recommendation lines + the §G on-box `llama-bench` note shipped with the table. The honesty boundary holds: published fp16 evals re-ground ORDERING; true measurement remains a box activity (§G). REOPENS when new instruments cover our mid-size models — a future pass, not an open deliverable. Runner ruff + 350 pytest green with the swap.
- **C3 — Shared AI task queue promoted into the kit.** STATUS: **✅ SHIPPED 2026-07-06** (the A–E batch; full design + grounded amendments + verification in `2026-07-06-a-to-e-execution.md` §C3). The queue lives in the kit's llm layer — `ui/src/stores/aiTasks.js` (Pinia; `pinia` now a kit peer dep) + `ui/src/services/aiFeature.js`/`aiErrors.js` (consolidated onto the kit client, which gained `{signal}` + null-until-done usage) + `AiTaskStrip`/`AiStatusPanel`/`AiStatusButton` — all exported from `index.js`; JW's six locals DELETED and all 43 consumers swept (import-lines-only diffs, mechanically proven); verified by build + full smoke (0 JS errors) + vitest 28/28 incl. 8 new tests over the real kit modules. The JV half (deleting its `renderTasks.js`/`TaskStrip.vue` fork and adopting the shared queue + its own CLAUDE.md kit-note) stays under **F1/F4** per Decision 22 step 4 — excluded from this batch by the no-JustVoice mandate.
- **C4 — The "everything LLM is shared" audit.** STATUS: **✅ DONE 2026-07-06** (the A–E batch; the full per-unit strict-diff table with file:line evidence is in `2026-07-06-a-to-e-execution.md` §C4). Results: kit and runner are CLEAN (all 45 app-name matches across both are comments/lift-provenance docstrings — zero app logic in the shared stack); JW's LLM surface decomposed into 15 units — most APP-OK (feature callers over the kit wrappers, the sanctioned seeds, the host-chrome mounts, the two pre-mount sync boot caches), with **five violations found and FIXED in-batch** (the dead provider-CRUD chain in `providerBackend.js`+`stores/ai.js` — the kit ProviderForm owns editing; the zero-consumer `Combobox.vue` fork DELETED — kit LuCombobox superseded it; `routingBackend.js`'s stale-wire `jobs` field + comments from the removed job-routes design; a stale `aiStream.js` reference in writerAI; the tiers heuristic now carries DOCUMENTED-MIRROR cross-notes both sides, canonical = runner `tiers.py`), one **new-scope finding FILED as C5** (below), and **five JV findings RECORDED under F1** (JV untouched per the mandate). Verified after the fixes: build:vite clean · vitest 28/28 · full headless smoke zero JS errors · runner ruff + 350 pytest.
- **C5 — the model-picker family → kit.** STATUS: **✅ SHIPPED 2026-07-06** (user's go; full design v1→panel→v2→implementation record in `2026-07-06-a-to-e-execution.md` §C5). The design survived a 3-checker PANEL that materially reshaped it — `ModelPicker.vue` turned out to be DEAD code (zero importers; deleted, not promoted, and `parseQuant`/`entryLabel`/`TIER_IDS`/`getModelTierObject` died with it), and the REAL convergence was ChatPanel's inline picker vs the chip's popover logic. Shipped: kit `useProviderModels` (ONE model-list cache on the ONE endpoint accessor `listModels`; `LuModelPicker` adopted it, its per-instance cache deleted) + presentational `LuFeatureChip` (host owns state) + the kit `embedApi` (`embedTexts`/`ensureEmbeddingReady` on the kit client); JW `useFeaturePin` (the one pin binding), `AiFeatureChip.vue` as the thin binding (same props — ~20 consumers untouched; foot link fixed from the dead `/settings/audio` to `#/ai`), ChatPanel riding the same binding — which also fixed the found character-mode wrong-pin bug; JW's `useModelList.js` + `embedApi.js` deleted. Verified: build clean · vitest 29/29 · full smoke zero JS errors · residual greps zero · JV untouched.
- **C6 — the kit-internal layering violation — ✅ SHIPPED 2026-07-06 (user's go "do c6"; full design + implementation record in `2026-07-06-a-to-e-execution.md` §C6).** The five llm-endpoint files that broke the common charter (`common/index.js:2-6`: "nothing here may import from ../") moved to the llm layer: `useRouting`/`useRunnerModels`/`useProviderConnect`/`useCatalogMeta` → `ui/src/composables/`, `modelApply` → `ui/src/services/` (git renames); their `../../client.js` imports became `../client.js`, the three stale "lives in common/" rationale headers were rewritten, and the kit-internal importers re-pathed (`LuModelCatalog.vue:16-18` · `QuickSetup.vue:27,28,30` · `ProviderForm.vue:19` · `useProviderModels.js` — whose C5 llm→common honesty note is now retired: `listModels` is the clean llm→llm edge `./useProviderConnect.js`). ZERO public-surface change (neither index ever exported the five — verified) and zero app-side edits (JW/JV have no references — verified). `modelPick.js` stays in common (pure, no upward import). Verified: pre-build rules-checker PASS (zero failures) · build:vite clean · vitest 29/29 · the FULL headless smoke ALL routes + AI sub-tabs ZERO JS errors (the provider-form probe exercised three moved files live) · the upward-import sweep of `ui/src/common/` now returns ZERO — the charter is clean; `common/composables/` retains only `usePoll.js` + `useRovingTabindex.js`.
- **C8 — QuickSetup back to LOCAL-ONLY — ✅ SHIPPED 2026-07-06 (user directive: "quick setup is for local only… remove the connect provider… we dont need a drop down for providers"; full design + record in `2026-07-06-a-to-e-execution.md` §C8).** A USER REVERSAL of the 2026-07-05 Option-2 other-provider decision (the one actor allowed): the "Run models with" selector, the in-wizard connect flow (detected-local rows + the hardcoded PROVIDER_PRESETS cloud chips + key input), and the external apply path are REMOVED from `QuickSetup.vue` — the wizard configures the bundled runner only; external providers connect on the provider list (ProviderForm, which keeps the shared `useProviderConnect` presets/probe/create). Adjacencies: `detectLocal` pruned (the cut removed its only consumer; the server endpoint remains) and the committed wizard probe got a found-and-fixed (its hardcoded "Nomic" embed assertion was stale vs the evolved ladder + seeded routing — now data-driven, + two local-only negative assertions); `qs-otherprovider-probe.mjs` deleted (its subject is gone); `models.md` §Quick Setup rewritten local-only. Verified: build clean · vitest 29/29 · full smoke zero JS errors · the fixed probe 9/9 (open → confirm → stubbed Apply → done, 0 page errors). The user's item 3 ("changing default model doesn't actually do anything") was WITHDRAWN by the user ("dont worry about 3").
- **C7 — prune the dead `useRunnerModels.load()`/`unload()` exports — ✅ SHIPPED 2026-07-06 (user's go "do c7", same day it was filed; implementation record in `2026-07-06-a-to-e-execution.md` §C7).** The two functions + their return-object entries are deleted; the stale comments fixed both sides (`useRunnerModels.js` header/`loadingId`/`download()` notes; `LuModelCatalog.vue`'s pre-Phase-2 header rewritten to the fit-grouped-list + Download/Set-as-default/Set-as-embedding truth); `loadErr`/`needsEngine`/poller/download machinery untouched. Verified: build clean · vitest 29/29 · full headless smoke zero JS errors with the provider-form probe green · zero residual references · the served-module check proved the smoke ran the pruned code. Bundled: the fast-9B QuickSetup optional **DECIDED NO** (user, "no 9b quick setup") — annotated at `2026-07-03-model-setup-simplification.md:344`. The original filing record follows for history: The audit finding, code-verified: `ui/src/composables/useRunnerModels.js` still defines `load()` (:103) and `unload()` (:115) and returns both from `useRunnerModels()` (:153), but their ONLY consumer — LuModelCatalog's Load/Unload buttons — was removed in the model-surface Phase 2 redesign (catalog actions became Download / Set-as-default / Set-as-embedding). The recap deliberately deferred the prune "until the residency/4b surface is finalized … to avoid speculative churn on the shared singleton" — and §H6 then CLOSED-DROPPED 4b (the user's recorded call: no per-model residency controls), which fulfilled the prune condition, but nobody filed the prune. Verified dead 2026-07-06: `LuModelCatalog.vue` calls only `download()` (:411); `QuickSetup.vue` drives the runner directly (`request("/v1/llm-runner/load")` at :372 with its own status poll at :395); JW and JV have zero references (symbol greps both apps). Scope when built: delete the two functions + their return-object entries + fix LuModelCatalog's stale header comment (its ":7 …loads/unloads" line still describes the removed buttons); the `needsEngine`/`loadErr` machinery STAYS — it feeds the catalog's engine-not-installed CTA off the status poll, not off `load()`. Size: tiny, mechanical. (Paths reflect the post-C6 locations.)

- **C9 — the model-quality research: class→model map contents + rank re-grounding + the candidate
  evaluations — CANDIDATES NOW IN THE CATALOG (2026-07-06 Gemma-first lineup, non-default, see the
  providers-surface doc §GEMMA-FIRST LINEUP); the RESEARCH HALF (Lab A/B rank evidence: Gryphe +
  the ablated build + 31B-vs-26B for writing) NOT STARTED (user-filed 2026-07-06: "add todo for model research", from
  TurboLLM Discover screenshots; consolidates the follow-up recorded in the model-per-hardware
  plan §Out-of-scope).** PURPOSE: fill the Phase-3 `model_class_picks` map with evidence, re-ground
  Gemma's quality_rank 9 (currently annotated reasoned-not-instrument-cited), and evaluate the
  writing-use-case candidates. THE CANDIDATE LIST so far:
  1. **Gryphe/Gemma-4-26B-A4B-StyleTune-V2** (carried from the 2026-07-06 five-model scoring — the
     one credible candidate; maker-reputation + license + EQ-Bench-creative + Lab A/B).
  2. **HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP** — the refusal-ablated
     26B-A4B build the user wants evaluated **for fiction writers** (stock refusal behavior
     blocking dark/violent/romance prose is a real writing-app failure). Card facts to re-verify
     per-repo at research: QAT Q4_K_M ≈ 16.8 GB, in-repo MTP draft (252 MB; claimed ~35% faster
     with identical output), vision mmproj, maker-recommended sampling (temp 0.6 · top_k 64 ·
     top_p 0.9 · min_p 0.05 · repeat_penalty 1.1 — seedable `model_samplers` rows if adopted),
     author-claimed clean refusal benchmarks (updated Jun 24 2026; 55.3K downloads).
  **TRIMMED 2026-07-06 (user: "keep gryphe and abliterateed huahau 27b")** — the list is now the
  two candidates above; **DROPPED**: unsloth/gemma-4-31B-it-qat-GGUF (31B dense, 24 GB-class) and
  HauhauCS/Gemma4-31B-QAT-Uncensored (its ablated sibling). ⚠ Interpretation note: the user wrote
  "huahau 27b" — no 27B exists in the set; read as the **26B-A4B** ablated build (the user calls
  their 26B-A4B daily driver "27b"). If the 31B was meant instead, say so and this flips.
  GUARDRAILS (the recorded pushback stands): community fine-tunes/ablations NEVER seed as DEFAULTS
  without maker-reputation + first-party-verified license + an instrument or Lab win; catalog
  INCLUSION and default-ELIGIBILITY are separate calls; the license of every candidate is checked
  via the HF API including the `base_model` chain (the Phase-5 de-circularized method — derivatives
  of Gemma 4 should inherit Apache-2.0, but each repo's actual tag gets verified, never assumed);
  the "uncensored" positioning additionally needs the user's explicit use-policy word before any of
  them becomes a default anywhere. METHOD: HF-API facts + license per candidate → leaderboards /
  EQ-Bench-creative where listed → Lab A/B on the user's box → map rows + rank updates land as
  SEED DATA through Phase 3's expression point.

## D. Decisions only the user can make (nothing buildable until then)

> **SECTION CLOSED 2026-07-06 — no open decisions remain.** D1 and D3 were both decided by the user on 2026-07-06 ("i take your rec on d1 and d3, go" — the user took the agent's recommendation on each); D2 had already been refuted/moved to F4 by pass 2. The decided records are kept below in full so the reasoning and evidence survive. **REOPENED later 2026-07-06: D4 (below) was FILED at the user's request — the tuning-session follow-ups, headlined by the QuickSetup-overwrite concern, are an OPEN discussion item — and D5 was FILED the same day on the user's "add 1 and 2" after the design-doc audit; D1–D3 remain closed.**

- **D1 — Quick Setup preset generation — ✅ DECIDED 2026-07-06 (user took the recommendation): KEEP today's write-onto-existing behavior; CLOSED with ZERO code.** The question was: when Quick Setup applies, should it also GENERATE a preset per task, or keep writing the picked model onto the existing task presets (today's behavior)? The user chose to keep today's behavior — under Plan A each task already owns its preset, so writing the picked model onto the existing preset is the model-consistent move, and generating per-run presets would multiply rows without a clear payoff. Nothing to build; tracker task #100 closed. The behavior that now stands as final, with the pass-2-sharpened cites: the non-clobber write is the shared `modelApply.js:75-87` (PUT onto the EXISTING `/v1/ai/engine-presets/{id}`, never a create; skips user-re-pointed presets), invoked from the kit `QuickSetup.vue:367,378`.
- **D2 — ~~Co-residence policy + JV VRAM coordination~~ — REMOVED from the decision list (pass-2 REFUTED it).** These were **DECIDED 2026-07-04** — the serving design's §7 is literally titled "Decisions (the user took the agent's recommendation)": §7.1 fixed the co-residence policy (pin the tiny embed · TTL-warm the active · co-reside-if-budget-else-swap-LRU; JV = LLM XOR TTS) and §7.2 fixed the mechanism (the in-process shared VRAM arbiter — which is BUILT, `runner/arbiter.py`); the recap's LOCKED DECISIONS reaffirm "multi-residence = chat + embed only — user confirmed." What actually remains is a BUILD, not a decision: the JustVoice `EngineManager.load()` → arbiter hook (the SVM plan's own explicitly-deferred future plan, + a §7.2 wording fix — JV engines are OS subprocesses, not in-process). Moved to **F4**.
- **D3 — The stale umbrella verify task ("build + smoke + screenshots, line-by-line") — ✅ DECIDED 2026-07-06 (user took the recommendation): CLOSE tracker task #71; the marketing-screenshots half is FOLDED INTO §G as G4 (now unconditional).** The item, from the June samplers work: its build/smoke/docs parts demonstrably shipped in later phases; the *marketing screenshots* half needs a built `.exe` on Windows, so nothing in-container can ever finish it — it is purely a your-box item now. Pass-2 had confirmed the harness (`package.json:20` → `e2e/capture-direct.mjs`, hard Windows deps at `:15-16,91,121`) and that nothing in-container can verify a screenshots run.
- **D4 — OPEN DISCUSSION (filed 2026-07-06 at the user's request after the 2070S tuning + seeding session — "docs and app updated with tuning info we need to add to todo to discuss"): the tuning-session follow-ups, headlined by the QuickSetup re-pick overwrite hazard.** The user's stated concern, verbatim: *"this is what my concern is — QuickSetup re-pick would overwrite the seeded preset models."* CODE-VERIFIED MECHANISM (2026-07-06, `ui/src/common/services/modelApply.js:29-46` + `:75-87`): QuickSetup's Apply calls `setAsDefault`, whose non-clobber rule is MODE-BASED — `dominantOf` computes the DOMINANT model (the most common `.model` across the assigned task presets) and the write loop overwrites every preset still on that dominant, skipping only presets whose model differs (assumed "overridden by the user — non-clobber", `modelApply.js:82`). That heuristic was designed for the fresh-box state where all presets share ONE previous default and any deviation is a deliberate user re-point. The 2026-07-06 seeding (JW `13ba839`) deliberately created a TWO-model state — creative tasks → `writing-assistant-gemma-moe-mtp`, grounded tasks → `book-chat-gemma-moe-mtp` — so a QuickSetup re-run would MISCLASSIFY: the majority Gemma group reads as "the previous default" and gets rewritten to the wizard's pick (per the recap web-pickup stamp the pick-best step would likely choose Qwen3.6-35B — quality_rank 8 vs the Gemma entries' 9), while the minority group survives as a presumed user re-point — a PARTIAL clobber of the seeded per-task split, leaving an inconsistent mix that neither the seed nor the user chose. Today's mitigations (recorded in the recap stamp): do not run QuickSetup on this box; the Tasks page (Settings → AI → Tasks) restores per-task models manually if it happens. CANDIDATE DIRECTIONS — **✅ DECIDED 2026-07-06 (user took the recommendation, "i will take your recommendations go"): (a)+(c) together** — QuickSetup detects an already-configured box (task presets not all on one model, and/or `model_tunes` rows for this machine) AND the confirm step lists exactly which presets would change before anything writes; a fresh box stays one-click. The BUILD rides `2026-07-06-model-per-hardware-plan.md` Phase 2 (panel-checked, execution pending). SECONDARY AGENDA from the same session (SSOT: `justwrite-app/docs/plans/2026-07-06-llamacpp-config-tuning-2070s.md`): (1) the ONE-catalog-entry + per-request-reasoning refactor — **✅ DECIDED 2026-07-06 (user: "lock 1 profile"), on MEASURED on-box evidence** (`justwrite-app/docs/plans/2026-07-06-onbox-profile-ab-test.md` RESULTS, commit bc614c6): per-request `chat_template_kwargs.enable_thinking=false` fully suppresses Gemma 4 reasoning (598ch→0; wall 15.9s→3.9s), and the 32k/ncmoe21/rb1024 section with thinking off serves writer traffic at writer speed (cache-busted TTFT 1.52s vs the 8k section's 1.68s; decode ratio 0.89). ONE launch config per model; the writer-vs-chat difference lives at the REQUEST layer (the per-task `think` flag → enable_thinking, the #118 wiring). The BUILD (collapse the two seeded Gemma entries into one row + re-point the 8 presets + per-task think flags + docs) is future work needing its own go — it rides the full model-per-hardware plan. The old per-preset-launch-flag alternative (`engine_preset_switches`) is moot for this purpose; (2) the foreign-listener guard (tuning doc line 140 — explicitly nice-to-have, NOT built) — **✅ DECIDED 2026-07-06 (user: "3 leave it"): NOT BUILT, leave as-is.** The operational rule stands (never run the manual router and the app's local-llamacpp path at the same time — a raw bind error is the accepted failure mode); do not re-file without a fresh user ask; (3) pruning the dormant hand-ini sections (`book-chat-qwen-moe-mtp` + the old 12B rows are unused — "the qwen is just the embed") — **✅ DECIDED 2026-07-06 (user: "4 no pruning leave it"): LEAVE THEM in `b9870/models.ini`** — harmless unused sections; do not prune, do not re-raise. The A4 linux-docker digest capture stays recorded in §A4 — not duplicated here. STATUS: **✅ FULLY DECIDED 2026-07-06** — every D4 item is now resolved: the headline overwrite protection = (a)+(c) (build rides the model-per-hardware plan Phase 2); secondary (1) one-launch-profile LOCKED on measured evidence (build rides Phase 1); secondary (2) the :8080 guard NOT built; secondary (3) the hand-ini sections stay. Nothing left to discuss on this item. **BUILD UPDATE 2026-07-06 evening: secondary (1)'s build SHIPPED as the plan's Phase 1a** (runner `4faa39c` + JW `f6f8167` — one catalog row `gemma-4-26b-a4b-qat`, Apache-2.0 license fix, 8 presets re-pointed, per-task think flags with `chat` the one thinker, rb 1024 → the base bundle; full record + verification in the plan's §PHASE 1a RECORD). The headline (a)+(c) build remains Phase 2, next.
- **D5 — FILED 2026-07-06 (the design-doc audit; user: "add 1 and 2"): the remote curated model catalog — an OPEN product decision.** Recorded twice in the design docs but tracked in no ledger until now: the model-setup simplification plan's Open-items #9 ("seed-only now; **remote curated manifest is a later product decision**") and the model-surface build plan's flagged FUTURE (its line 16: "fetch the curated catalog from a remote so new models don't need an app release — NOT built now") — both born from the user's recorded reservation that they "don't really like us just seeding models" (keep the seed small, lean on Smart Add, fetch curation remotely later). Nothing buildable until the user decides: (a) whether to build it at all; (b) where the manifest lives (a GitHub raw file / a release asset / an owned endpoint); (c) update cadence + trust — is the fetched manifest pinned/signed, and can a bad fetch ever degrade the app; (d) the offline story — the in-app seed presumably stays as the baseline and the fetch overlays it; (e) who curates entries and to what bar (the C2 evidence-cited method is the natural one). Interacts with the D4 one-catalog-entry discussion: a remote manifest wants the final catalog-row shape settled first. STATUS: **✅ PARKED (user, 2026-07-06: "D5 park it").** Deliberately deferred — not open work; do not re-raise until the user does. The recorded shape for when it wakes (the recommendation the user parked it with): a versioned JSON manifest shipped as a GitHub release asset on `just-llm-runner`, pinned per app release with a user-triggered refresh, overlaid on the seed with the same insert-if-missing non-clobber discipline the tune seeds use, curation held to the C2 evidence-cited bar, sequenced after the §G box checks + F1 and after D4 settles the catalog-row shape.

- **D6 — curated catalog + an in-app HF "Discover" surface, and the TurboLLM feature-adoption
  study — DISCUSS/RESEARCH, LATER (user-filed 2026-07-06: "possible we have our currated list of
  modles but we just do normal discover of hf models like turbo llm add to todo to think about, i
  think we need to look at turbo llm to see what features we may want to adopt, this is a todo
  item later").** Two halves. **(a) The Discover idea:** keep our curated catalog as the quality
  floor (ranks, defaults, verified licenses) and ADD a TurboLLM-style Discover tab — in-app search
  of HF GGUF repos (their surface, from the user's screenshots: Library|Discover tabs, search box
  + Trending sort, result rows with downloads/likes/updated, a rich model card with the launch
  snippet, a downloads table listing every file incl. mmproj + MTP drafts with sizes, the maker's
  recommended sampling, specs, compatibility notes) feeding our EXISTING Add-model pipeline
  (read-from-link quant dropdown, fit pre-pick, MTP-draft auto-detect). Architecture note: this
  slots in cleanly — discovered models enter as user-added catalog rows (no quality_rank, never
  auto-default), the curated list keeps owning defaults; the search leg is an HF API query
  (`/api/models?search=&filter=gguf&sort=` + per-repo tree listing we already consume at Add
  time). Related-but-distinct: **D5 (parked)** is the remotely-UPDATED curated list; D6-a is
  in-app SEARCH of the open HF space — cross-reference both when either wakes. **(b) The TurboLLM
  feature study:** a structured pass over TurboLLM's surface for adopt/skip/already-have calls —
  seen so far: the engine manager (multi-engine incl. vLLM/SGLang/ik_llama.cpp/llamafile/
  koboldcpp/TurboQuant + add-your-own llama-server-compatible binary; engine auto-update
  Off/Notify/Auto = our **A5**), auto-benchmark-on-load (= our A7/sweep territory), measured
  tok/s shown in the model list (live + last-session), pre-load VRAM-fit verdict (≈ our Fit
  badges), vision/mmproj loading (we have no vision story), the Workspace/Customize/Developer
  areas (unexamined). Deliverable when picked up: a comparison table (feature · theirs · ours ·
  adopt?) for the user to choose from. LICENSE GUARD stands: FSL-1.1 — study freely, adopt IDEAS,
  never lift code.

## E. JustWrite app

- **E1 — ~~Retire the legacy LLM gateway~~ — REFUTED by pass 2; ALREADY RETIRED. The comment cleanup ✅ SHIPPED 2026-07-06 (the A–E batch; detail + a precision correction in `2026-07-06-a-to-e-execution.md` §E1 — only two of the three files actually NAMED the class; the third referenced the dead route; all three cleaned, real producers/consumers verified by grep).** The pass-1 claim was WRONG: the grep matched `"openai-compat"` as a providerType STRING LITERAL, not an import — `services/openai-compat.js` does not exist, nothing imports it, and ALL live LLM traffic is on the shared dispatch (`aiFeature.js` → `/v1/ai/run|stream` · `writerAI.js` → `/v1/ai/stream` · `embedApi.js` → `/v1/ai/embeddings` · `routingBackend.js` → `/v1/ai/routing`; `providerBackend.js` talks to the shared `/v1/llm-providers` CRUD; the JW server mounts the stack via `install_llm`, zero `/v1/llm/` routes). **The leftovers that fooled pass 1 are ALL cleaned now:** the three stale code comments naming the removed `OpenAICompatClient` were rewritten in E1 itself (2026-07-06), JW's `CLAUDE.md` §"AI providers" was rewritten when the audit found it misleading, and the same section was updated AGAIN at C3 (2026-07-06) when `aiFeature.js`/`aiErrors.js` moved into the kit — the run/stream callers are now the kit's `runAiFeature`/`runAiFeatureStream`. STATUS: **DONE — nothing remains**.
- **E2 — A JS unit-test harness (vitest) — ✅ SHIPPED 2026-07-06 (the A–E batch; detail in `2026-07-06-a-to-e-execution.md` §E2).** vitest + root config + `npm run test:unit`; the first tests cover exactly the flagged seam — the lazy-embed ensure cache via `_resetEnsureCache` (11 tests incl. the failure-drops-cache/abort-keeps-cache pair) + the modelMeta helpers (9). 20/20 green in-container; JW CLAUDE.md tooling paragraph updated.
- **E3 — (footnote, outside the AI stack) ODT import drops lists.** STATUS: **✅ SHIPPED 2026-07-06** (the A–E batch; full design + verification in `2026-07-06-a-to-e-execution.md` §E3). `parseOdt` now renders `text:list` recursively as TipTap-canonical `<ul>/<ol>` with `<li><p>…</p></li>`, ordered-vs-bullet resolved PER NESTING LEVEL from the list styles in content.xml AND styles.xml (so the stock "List Number" named style detects as ordered); the "N lists dropped" warning arm is gone. Verified by a new 5-test jsdom unit suite driving the real parser over a real jszip-built ODT fixture (vitest 33/33) + build + full smoke.

## F. JustVoice

- **F1 — Convergence onto the CURRENT shared stack (the big one).** JV cannot even import against today's `llm_runner`: `server/justvoice/models.py:23` imports `LLMRolesSettings`, a symbol the shared schema no longer exports — 30 of JV's tests die at collection on it; that is only the FIRST blocker (full drift enumeration is part of the work — the import-chase stops at the first error by nature). Convergence also delivers, for free, everything JV currently lacks from this month's shared work: the model catalog/tune system, auto-MTP, the per-day Logs panel, provider connect, etc. STATUS: **NOT DONE**. Pass-1: the live ImportError (reproduced 2026-07-06) + JV pytest 30 collection errors. Size: **large** — the single biggest outstanding item.
  **F1 RENDERER RECORDS from the 2026-07-06 C4 audit (read-only findings, JV untouched per the batch mandate; full evidence in the batch tracker §C4):** (a) `services/llmBackend.js` — the pre-client-direct "ProviderBackend contract" adapter era; the kit's `client.js:9` records that it "replaces the old per-app ProviderBackend adapter" — audit its remaining liveness at F1 and delete/converge (JW's equivalent was reduced to a read-only boot cache by C4). (b) `components/ProviderForm.vue` — a JV-local LLM+TTS provider editor vs the kit `views/ProviderForm.vue`; the TTS half is app-domain, the LLM half converges. (c) `components/QuickSetup.vue` — a self-described copy of the JW QuickSetup pattern; its LLM feature-pin auto-config half is drift, the TTS-wizard half is legit. (d) `components/RecommendCard.vue` — machine-fit recommendation surface to evaluate against the kit's fit surfaces. (e) the `renderTasks.js`/`TaskStrip.vue` task-queue fork → adopt the kit queue shipped by C3 (Decision 22 step 4) + add JV's own CLAUDE.md kit-note for it.
- **F2 — Speaker-attribution / entity-extraction task scaffolding.** The shared nine-task taxonomy has no `speaker_attribution` task; it's a JustVoice need (JustWrite explicitly bans speaker analysis), parked until JV convergence makes it meaningful. STATUS: **NOT BUILT**, sequenced after/with F1. Pass-1: `speaker_attribution` absent from JW seeds (grep) and from the shared `DEFAULT_TASK_KINDS` (seed.py — nine tasks, none of them attribution).
- **F3 — Audiobook converters + speaker-attribution deep research.** The parked research TODO (converters/casting/chaptering features to mine + attribution improvements). STATUS: **RESEARCH**, parked by the user 2026-06-27. Pass-1 + pass-2 CONFIRMED (the TODO doc's own line 3: "NOT STARTED — parked for later (user, 2026-06-27)").
- **F4 — JustVoice `EngineManager.load()` → shared-VRAM-arbiter hook (moved here from the refuted D2).** The coordination DECISION was made 2026-07-04 (design §7.2: one shared budget arbiter in `just-llm-runner`, already built as `runner/arbiter.py`); the JV side of the wiring — JV's TTS engine loads reserving/releasing against that arbiter — is the SVM plan's own explicitly-deferred future plan, sequenced naturally with F1 (JV can't even import the shared stack until convergence). Includes the small §7.2 wording fix (JV engines are OS subprocesses, not in-process). STATUS: **NOT BUILT** (deferred build, decision already made). Size: medium, after F1.
- **F5 — JV Appearance settings knob-set gap (pass-2's missed-item find).** JV's Appearance tab exposes only Theme / Interface size / Accent hue / Language (`JustVoice … SettingsView.vue:2291-2383`) while the SHARED appearance engine (already adopted by JV) supports the full set JW exposes (font pairing, second accent, nav/section-heading styles, status hues). The JV recap itself calls this "the clearest remaining user-facing inconsistency" (`JustVoice/MORNING_RECAP.md:117-119`). NOTE: this is a renderer-Settings gap — NOT delivered for free by F1's server-side convergence. STATUS: **NOT BUILT**. Size: small-medium.

## G. Your-box checklist (built + container-verified; only your Windows machine can finish these)

- **G1 — Plan B on-device gates:** pull the branch → one-time `POST /v1/data/reset` (new columns + the tunes table) → a real Gemma load with its separate MTP draft (`--model-draft`) → a tok/s measure → reasoning-budget behavior. The container proved everything up to the llama-server boundary (no GPU here).
- **G2 — Portable data folder on-device:** the Settings → Storage change-folder/move/respawn flow, the native folder picker, the engine-install UX. Code shipped (`lib.rs:365-376` + the Storage card); runtime is desktop-only.
- **G3 — The RTX 2070 SUPER spawn failure:** still UNDIAGNOSED — but no longer silent: the spawn now writes a per-load log and reports the exit code (`GET /v1/llm-runner/engine/log`, `runner/api.py:251`), so the next failing load on your box self-reports the reason.
- **G4 — the marketing screenshots run** (`npm run screenshots`, needs the built `.exe` + WebView2). Folded here from the closed #71 umbrella by the D3 decision (2026-07-06) — this is now the ONLY surviving piece of that task, unconditional, desktop-only.
- **G6 — (added 2026-07-06 with A1) the Windows AMD/Intel detection spot-check:** on the Windows box, `python -c "from llm_runner.runner.hardware import detect; print(detect())"` should list the real adapter name + VRAM from the registry route (only meaningful on an AMD/Intel-GPU Windows machine; the RTX 2070 box will just show the NVIDIA row as before).
- **G5 — the serving-stack box verifies (pass-2's missed-item find):** the SVM plan's two outstanding on-device checks — **the full RAG end-to-end** (Build index + Chat-with-book on the bundled runner with the chat model ALSO resident — the P3 §3d verify) and **the router-flag confirm on the pinned build** (P1g). Partially overlapped by G1 (a real Gemma load exercises the router spawn), but the full-RAG leg is its own check.

## H. Corrections this audit made (the ledger of fixed mistakes — so they stay fixed)

1. **Embedding serving = LAZY, FINAL.** The user took the recommendation; the pin-reconsideration is CLOSED keep-lazy. An intervening wrong "DECIDED EAGER" recording (agent confirmed a recollection without re-checking the documented record) was reverted; both the SVM impl plan §PIN RECONSIDERATION and the JW recap now carry the correction + the lesson (conflicting record vs recollection → surface the conflict, never silently rewrite).
2. **The engine-download bug is FIXED** (the user was right): live `GET /v1/ai/engine-config` → 200 · pinned `b9644` · 10 binary rows with real URLs; the engine installed on the user's box (the cudart evidence). Tracker corrected to done.
3. **The VRAM-budget planner is DONE** — shipped as the serving arbiter (`runner/arbiter.py` + budget-aware fit, `test_budget_aware_fit_uses_remaining`). Tracker corrected.
4. **"Curate model_recommendations rows" is OBSOLETE** — the recommendations table/API were deleted when recommendations collapsed to `quality_rank` (+ C2 carries the measured half). Tracker item removed.
5. **The old state-grid's "per-model tune save?" fork is RESOLVED** — Plan B built it (the per-(model, machine) tune layer). Its "json grammar" fork lives on as C1.
6. **The serving plan's "4b resident-awareness" is CLOSED-DROPPED** (the user's recorded call: the catalog uses Download/Set-as-default, no per-model residency controls) — was mislabeled "deferred".

## PASS-2 VERDICTS (independent re-verification — COMPLETE, all findings folded above)

Two adversarial rules-checker agents re-derived every item from code with orders to refute and to hunt for omissions. **The method worked — each found one wrong item and real omissions:**

- **Checker A (engine/stack/JW scope): 11 confirmed · 1 REFUTED · 1 missed.** REFUTED **E1** — the "JW still runs the legacy LLM gateway" claim was false (the pass-1 grep matched providerType string literals, not imports; the gateway file doesn't exist; all traffic verified on `/v1/ai/*` — E1 rewritten above to the true remainder: 3 stale comments + the stale JW `CLAUDE.md` §AI-providers paragraph). MISSED → folded: that doc/comment drift itself (now E1's content) + the out-of-scope ODT-lists footnote (E3). Citation fixes folded into A1/A2/A3/A4 (the hardware.py line drift, the OOM-only-retry precision, the test corroboration). Also confirmed: the runner+kit carry ZERO other NotImplementedError/stub surfaces beyond A4 — the outstanding list is not hiding silent stubs.
- **Checker B (JV/decisions/corrections scope): 15 confirmed · 1 REFUTED · 2 missed.** REFUTED **D2** — co-residence policy + JV coordination were DECIDED 2026-07-04 (design §7 is titled "Decisions — the user took the agent's recommendation"; the arbiter is built); the real remainder is the JV-side hook BUILD → moved to F4. MISSED → folded: **F5** (the JV Appearance knob-set gap) and **G5** (the SVM box-verifies). Confirmed every §H correction is recorded where claimed — including H1's LAZY-final embedding record in both the SVM plan and the JW recap — and sharpened D1/F1/G2 citations (the F1 symbol sits on `models.py:26` within the `:23-29` import; `storage_relocate` at `lib.rs:389`). Its two runtime-only asks (the live import repro + the engine-config curl) were verified statically by the checker + had been executed live in pass 1 — both passes together cover code AND runtime.

**Net: 26 of 28 claims confirmed as written; 2 refuted and corrected; 4 real additions (E1-cleanup content, E3, F4, F5, G5). Every item above now carries two independent evidence trails.**

## I. Master-plan tail — the 2026-06-28 MASTER-PLAN's outstanding items, folded 2026-07-08

> **PROVENANCE.** Before bannering the 513 KB `2026-06-28-MASTER-PLAN.md` fully historical (part
> of the user's 2026-07-08 context-cleanup go), the user asked *"is there anything in the master
> plan left undone?"* — this section is the audited answer, so the master never needs to be
> opened as a tracker again. Method: every row of the master's LIVE TASK TRACKER "Remaining" +
> "Open decisions · GPU-gated · research" tables plus the PART-2 Phase-F/DEFERRED text was
> checked against code or this ledger on 2026-07-08 (greps + file:line reads recorded per item).

**I0 — dispositions of the master's tracker rows (nothing to do; recorded so the verdict is
citable).** **T21** shared AI task queue → shipped, this ledger **C3**. **T23** json_schema/GBNF
→ shipped, **C1**. **T40** router-mode build → shipped, it IS the live serving architecture (the
2026-07-04 SVM implementation). **T41** residency/VRAM planner → shipped as the arbiter
(`runner/arbiter.py`; §H3). **T42** structured-output quality eval → folded into **C2**'s box
scope. **T50** measured benchmarks → **C2** (published re-grounding done) + **C9** (the Lab-A/B
research half) + **§G** (true on-box measurement). **T20** QuickSetup enhancements → all four
sub-items landed in evolved form under the user's later direction (RAM-gated fit · MoE-aware
pick · the embedding dropdown; the "Test→Compare deep-link" belonged to the dead job-grain
Compare design — and "Send to Tasks Lab" itself was deleted by the §7.1 lock 2026-07-08, see
the big-batch queue doc). **T22** shared LLM-UI views →
shipped in evolved shapes: the Usage tab (`ui/src/views/AiModelsArea.vue:141-171`, the full
`/v1/ai-usage` rollup + clear — verified 2026-07-08), RunnerStatus = the Local-engine panel,
DownloadStrip = the catalog/engine progress bars, ProviderSelect = the provider list +
`LuModelPicker`; the "role/job badges" and "Routing&Cost card" sub-items died with the
roles→Plan-A redesign. **T30/O1** `prefer_local_features` → ALIVE as an install-time per-app
hook (`llm/dispatch.py:117`, `install.py:73`, empty for JW) — recorded **fine-as-is** per the
folded 2026-07-08 recommendation the user approved; reopen only on a user ask. Also verified
2026-07-08: `PromptLab.vue` is now **load-bearing** (C1's json_schema editor — the master's
"remove unused PromptLab" cleanup line is dead), and `idb-keyval` is already out of JW's
`package.json` (that DEFERRED row is done).

- **I1 — the JW cleanup tail (the master's T24 / Phase-F cleanup bucket).** STATUS:
  **MECHANICAL LEGS DONE (2026-07-10); judgment legs remain.** Done: `htmlToText` (the count
  was actually **20** definitions, not the 19 recorded here — recount at the build) and
  `tailWords` (7) converged onto the ONE shared `src/renderer/src/services/text.js` (16 + 6
  call sites option-mapped with zero behavior change; four htmlToText variants + voiceDrift's
  HEAD-taking tailWords deliberately left where behavior genuinely differs — two of them
  suspected latent bugs, flagged for triage, see the queue doc's I1 BUILD RECORD); the
  tests-fail-in-isolation row was VERIFIED STALE — `test_plane2_params.py` (15) and
  `test_prompts.py` (22) both pass ALONE today, no fixture missing, row closed with no code
  change. REMAINING (judgment, a Fable window): the RULE-5 new-entity-popup audit (#34); a
  shared `runJsonAnalysis`; promoting the big CSS clones to `styles.css`; the
  `useEntityCrudView` composable idea; the gate ratchets (extend `check-shared-pickers`, jscpd
  ratchet, the i18n `SettingsView.startNew` key); triage of the writerAI/versionDiff
  no-strip pair + voiceDrift's HEAD-vs-tail; a text.test.js (needs a DOM env — vitest is
  node-env). ALSO OPEN, A USER DECISION (surfaced 2026-07-10; the deep-audit
  2026-06-20 A1 "fix the scene-mark drift" reconciliation is NOT closed by the
  convergence): should critique / entityExtraction / readerKnowledge /
  threadExtraction keep seeing scene-break marks in their LLM input
  (`stripSceneMarks:false`, today's behavior, deliberately preserved) or move to
  full-strip? The flip is one option flag per site now.
- **I2 — cloud prompt caching (the master's O2).** STATUS: **DECISION + BUILD, untouched** —
  the Anthropic/Gemini adapters send no prompt-caching hints; never built, never decided. A
  cloud-cost optimization only (the bundled runner has llama.cpp's own prefix cache); worth a
  decision only when cloud usage matters to the user.
- **I3 — Apple-Silicon fit/tune refinements.** STATUS: **NOT BUILT (platform gap, academic
  today)** — macOS detection + the Metal binary preference EXIST (`runner/hardware.py:51,413`
  → `runtimes["metal"]`, `runner/binary.py:52`), but the master's Apple specifics (unified-
  memory budget in fit, no `--n-cpu-moe` on Apple, the `iogpu.wired_limit_mb` note) were never
  built and there is no Mac anywhere in the project to verify against. Park until a Mac exists.
- **I4 — the "reclaim disk" cache/data panel** (the master's platform-settings remainder).
  STATUS: **BUILT (2026-07-10)** — shared `llm_runner/platform/disk_api.py` sizes endpoint
  (`GET /v1/disk/usage`; JV inherits by mounting the same factory), runner reclaim endpoints
  (spawn-logs clear · models-cache clear with the unload-first refusal), and the JW
  Settings→Storage "Disk usage" card. Full record: the queue doc's I4 DESIGN + I4 BUILD
  RECORD. Deliberate follow-up, not v1: per-model GGUF delete on the catalog surface.
- **I5 — the DEFERRED-until-needed parking lot (carried, still parked by design):** per-scene
  incremental snapshot writes · full per-entity write REST · RAG sqlite-vec ANN index · the
  spawn boot/splash UX · extracting the kit `common/` → a future `@delebash/ui` package · the
  llama-swap optional layer · the Tauri/package rename PR (track, don't churn). Two rows
  corrected while folding: `idb-keyval` removal is already DONE (gone from `package.json`),
  and the "dead Tauri `images_save` cleanup" premise is STALE — `images_save` is live and
  documented as the Tauri image path (JW `CLAUDE.md` §Image storage); strike that row unless
  a future audit re-establishes it. These wake on need, not on a list sweep.
- **I6 — the master's §G JustVoice tail beyond this ledger's F1–F5** (TTS Lab · the JV
  capture/dictation fix · the JV prompt-editor view · JV catalog drift rows). STATUS: **gated
  on F1** — all of it presupposes JV convergence onto the current shared stack; F1's own scope
  line ("full drift enumeration is part of the work") owns discovering the survivors. Recorded
  here so the names aren't lost; do not plan them separately before F1.

## J. IDEAS — under consideration (not yet committed work)

> Created 2026-07-08 per the discussion-F lock (big-batch queue doc §7.5): the user is holding
> the user-facing `ROADMAP.md` until ship and wants ONE place for ideas being considered. One
> line per idea; an idea gets **promoted** to a real lettered item (or a plan doc) when the user
> decides it — never built from this list directly. This section is part of THE ledger on
> purpose (the no-second-backlog rule).

- **J1 — customizable editor/context menus** (the user's big-batch item #52a; queue B5-8): let
  the user customize the scene editor's context menu + header AI menu contents/order.
- **J2 — multi-model co-residency VRAM budgeting** (from the 2026-07-08 router discussion,
  queue §7.6): for big-VRAM boxes running 2–3 resident models, the fit calculation must count
  already-resident models before sizing a load, plus an eviction policy; per-section switches
  already work — the gap is only the memory arithmetic. (The sleeping-child OOM incident on the
  user's box is the motivating failure class.)
- **J3 — "defaults drift" notice beyond the Tune modal** (optional follow-on to §7.6's
  Refresh-from-defaults): a passive indicator on catalog rows whose applied config has drifted
  from today's defaults. Only if the in-modal notice proves insufficient.
