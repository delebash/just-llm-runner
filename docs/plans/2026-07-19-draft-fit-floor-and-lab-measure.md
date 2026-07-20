# Draft-aware VRAM fit · draft-pick floor · Lab draft measure (2026-07-19)

> **STATUS: BUILT 2026-07-19 — see the RECORD at the bottom, which is authoritative
> where it differs from the spec above.** Authored by Fable from the 2026-07-19
> draft-pick discussion; every decision was USER-RESOLVED (their word: "i will tak your
> rec on decisions and d4 build"), then executed by Opus in the main window. The spec
> text is kept verbatim as the brief that was approved — read the RECORD for what
> actually shipped, the two wording deviations, and the A6 engine finding.

## Why (the findings, each verified at file:line on 2026-07-19)

1. **`compute_fit` ignores the draft model entirely.** `process.py:304-381`: the VRAM
   budget is `max_vram_mb − safety_margin`; KV is counted for the MAIN model via the
   oobabooga regression; nothing subtracts `ov.model_draft`. The draft becomes a bare
   `--model-draft` flag (`process.py:129`, no draft-layers flag emitted), and llama.cpp
   fully offloads a draft by default — so an MTP model's draft weights + its KV silently
   eat VRAM the fit already promised to main layers. Same defect class as the #274
   embed co-load incident. The user's ruling: *"fits needs to reserve correct margin
   for context/kv … this detection system must work well."*

2. **The draft-pick rule was right but justified by anecdote.** The real reasoning,
   with our own numbers: the MTP preset seeds `spec_n_max=2` (γ, user-measured;
   `seed.py:380-383`). Every drafted token re-reads the draft's weights, so a cycle
   costs `γ·draft_bytes + main_verify_bytes` of memory traffic — on every hardware
   class including CPU-only (token generation is bandwidth-bound everywhere). Draft
   bits never change output (the main model verifies every token); they can only raise
   the acceptance rate. Illustrative, γ=2, Gemma's draft rows (Q4_0≈0.24 GB /
   BF16≈0.86 GB):

   | Main model            | Q4_0 cycle | BF16 cycle | acceptance BF16 needs just to TIE |
   |-----------------------|-----------|------------|-----------------------------------|
   | dense ~15 GB verify   | 15.5 GB   | 16.7 GB (+8%)  | ~75% → ~82%                   |
   | MoE ~4 GB active      | 4.5 GB    | 5.7 GB (+28%)  | ~75% → ~98% (unreachable)     |
   | CPU-only              | same ratios, slower absolute | same | same              |

   Published work runs the same direction (ML-SpecQD, arXiv 2503.13565: up to 2×
   speedup over a BF16-draft baseline by 4-bit-quantizing the draft). So: **smallest
   adequate quant wins everywhere; "largest that fits" was considered and REJECTED**
   (it would burn tok/s on big cards and steal main-model layers on small ones). The
   asymmetry vs the main-quant pre-pick is principled: main quant = QUALITY knob →
   maximize under VRAM; draft = OVERHEAD knob → minimize at adequate fidelity.
   Where bigger genuinely wins is different PARAMETER-COUNT drafters (acceptance jumps
   5–15 pts) — machine-dependent, borderline at γ=2 → measured, not derived (Part B).

3. **No measured evidence surface for drafts.** The AutoTuner already runs one
   MTP-specific alternative trial (`_spec_alt`, `autotune.py:149-158`, A9) — the draft
   A/B extends that same sweep; no new machine.

## Resolved decisions

- **D1** — pick = smallest draft that is 4-bit-or-better (floor), fit subtracts the
  draft. NOT largest-that-fits. *(adopted)*
- **D2** — the draft fit term = the marginal regression cost incl. the draft's own KV
  at the chosen ctx; single-pass ctx (see A2). *(adopted)*
- **D3** — wire key name `q4OrBetter`. *(adopted)*
- **D4** — the Lab draft measure is **BUILT** (Part B), not just logged. *(user: "d4 build")*
- **D5** — the coarse catalog badge (`coarse_fit` / `api.py:34`) stays draft-blind
  (pre-download band; a 0.2–0.9 GB draft sits inside its error bars). RAM-side draft
  accounting for CPU-only likewise skipped. *(adopted, flagged)*

---

## PART A — fit + floor (~60 min)

### A1. `fit.py` — marginal-cost helper

Add `marginal_vram_mb(**kw) -> float` = `max(0.0, estimate_vram_mb(**kw) - _C5)`,
next to `estimate_vram_mb` (`fit.py:181-188`). Docstring: `_C5` (≈1.5 GB, `fit.py:127`)
is the regression's one-per-in-use-GPU base offset; a SECOND model in the same process
pays only the marginal slope, so the base is counted once (by the main model).
**Test:** marginal == estimate − `_C5` exactly; floored at 0 for a tiny input.

### A2. `compute_fit` (`process.py:304-381`) — subtract the draft

New keyword-only params `draft_meta: GgufMeta | None = None, draft_bytes: int = 0`.
Order (single pass, no iteration):

1. `ctx_len` from the UNdiminished budget exactly as today (`:336-345`).
2. When `draft_meta` is set and budget > 0:
   `draft_mb = fit.marginal_vram_mb(size_mb=draft_bytes/1e6, n_layers=draft_meta.block_count,
   n_kv_heads=<same fallback rule as :328 — draft_meta.n_kv_heads or max(1, draft_meta.embedding_length // 128)>,
   embedding_dim=draft_meta.embedding_length, ctx_size=ctx_len, cache_type=cache_type,
   gpu_layers=draft_meta.block_count)` — all draft layers, because we emit no
   draft-layers flag and llama.cpp fully offloads the draft by default. The draft's
   own KV at the chosen ctx is thereby inside the term (the user's KV-margin ruling).
3. The layer split (`:351-359`) and the forward `vram_mb` (`:370-373`) run on
   `budget − draft_mb` (floored at 0).

ctx is chosen slightly optimistically (step 1 didn't see the draft); the spawn
probe-and-back-off nets that residual, per `compute_fit`'s own docstring. CPU-only:
budget already ≤ 0 → term no-op, `n_gpu=0` as today.
**Tests:** (a) constrained budget + draft → strictly fewer `n_gpu_layers` than without;
(b) `draft_bytes=0` → byte-identical FitPlan to today (regression pin); (c) budget 0
(CPU-only) unchanged with a draft present.

### A3. The three call sites pass the draft

- **Load:** `ov.model_draft` is set at `lifecycle.py:1537` BEFORE the `compute_fit` at
  `:1543`. When set: `draft_path = Path(ov.model_draft)`;
  `compute_fit(..., draft_meta=self._read_meta(draft_path), draft_bytes=draft_path.stat().st_size)`.
- **Router ini emitter:** same at its `compute_fit` (`:1854`), after its cached-draft
  resolve/strip block (`:1843-1849`) — `ov.model_draft` is set there iff the draft is
  on disk.
- **`preview_fit`** (`:986-1005`): resolve the cached draft the same way the emitter
  does (`_wants_draft(ov, model)` + `_cached_draft_path(model, self._cache_root / "hf")`
  — verify the helper's exact signature and mirror the emitter verbatim) so the Tune
  modal preview matches spawn truth; draft not cached → no term.

**Tests:** load-path fit sees the draft (fake meta; assert fewer layers); preview with
a fake cached draft < preview without.

### A4. The pick floor — ONE Python predicate, both pickers, comments rewritten

- New `_q4_or_better(quant: str) -> bool` in `models.py` next to `_quant_matches`
  (`:126-132`): true when the token's leading Q-digit ≥ 4 after stripping `UD-`/`I`
  prefixes (`Q4_*`, `IQ4_*`, `Q5/Q6/Q8`, and `BF16/F16/F32` all true; `Q2/Q3/IQ2/IQ3/
  PQ2_0`-class and no-token false).
- `classify_gguf_entries` (`:137-179`): each drafts row (`:170`) gains
  `"q4OrBetter": _q4_or_better(quant)`.
- UI pre-select (`LuModelCatalog.vue:405-410`): sort candidates by
  (`q4OrBetter` desc, `sizeMb` asc) and pick `[0]` — none-above-floor repos fall back
  to smallest overall by construction. Rewrite the `:405-407` comment: a draft is a
  SPEED device only; each drafted token re-reads the draft's weights (γ×bytes per
  cycle) so small wins on every box; the floor guards the acceptance-collapse end;
  largest-that-fits rejected → this doc.
- Tier-C picker `_gguf_drafter_in_repo` (`models.py:272-304`): among its surviving
  candidates (already Q/IQ-only + shard-free), prefer the `_q4_or_better` subset's
  smallest; else smallest overall (fallback preserved). Extend the docstring the same
  way.

**Tests:** Q2_K smaller than Q4_0 → Q4_0 wins in BOTH pickers (classify flag asserted;
picker unit test); Q2-only repo → Q2 (fallback proven); the flag on the BONSAI_TREE
fixture rows (dspark-Q4_1 true).

### A5. Docs (same change — R4)

- `justwrite-app/docs/models.md`: extend the MTP/Download material — the draft is
  pre-picked smallest-at-4-bit-or-better because a draft only affects speed, never
  quality (the main model verifies every token); bigger drafts cost bandwidth every
  step; the dropdown still lists every draft file; Tune & measure times the
  alternatives on your machine; the VRAM fit reserves room for the set draft. Match
  the file's existing voice.
- One pointer line at the end of `docs/plans/2026-07-19-dspark-drafter-detection.md`:
  "Follow-on (fit term + pick floor + Lab draft measure): `2026-07-19-draft-fit-floor-and-lab-measure.md`."

### A6. One verify step, recorded not assumed

Check the pinned llama-server's draft-context behavior (`llama-server --help` on the
installed engine binary if present; else the pinned build's docs): does the draft get
the main `--ctx-size` by default, or its own smaller default? Either answer is safe
(same-ctx → term exact; smaller → term conservative), but RECORD the finding in this
doc's RECORD section. Do not block on it.

---

## PART B — the Lab draft measure (D4, ~75 min)

**Shape: a new trial phase inside the EXISTING `AutoTuner` sweep** (`autotune.py:266-424`)
— after the `_spec_alt` phase (`:388-393`), budget-gated and cancel-checked exactly like
the phases above it, using the existing `_try`. No new sweep machine, no new UI surface:
`TuneMeasureModal` renders `state.trials` rows generically, so the draft rows appear in
the existing grid (VERIFY that when touching — if the modal filters labels or chokes on
an extra key, make the minimal render allowance, still no new surface).

### B0. Pre-flight verify

`_switches_to_overrides` must map a `model_draft` switch → `ov.model_draft` (expected —
`process.py:88-91` documents the raw-switch power-user escape). If the mapping is
missing, add it with a test. Also confirm `svc.load(model_id, switches=...)` passes
ad-hoc switches through (it does for the sweep today, `autotune.py:235`).

### B1. Candidates

Gate = resolved base switches say `spec_type == "draft-mtp"` (the `_spec_alt` gate,
`:155`). Catalog row via `svc.catalog()` (as `preview_fit` does, `lifecycle.py:991`).
`draft_repo = m.mtp_draft_repo or m.hf_repo`; candidates =
`classify_gguf_entries(list_repo_ggufs(draft_repo))["drafts"]` minus the currently
configured `m.mtp_draft_file` (the baseline trial already measures it). Order:
`q4OrBetter` first, then size ascending; **cap 4 alternates** (pathological repos).
Any listing/network error → skip the phase silently (discovery is advisory — the
tier-C precedent, `models.py:315`) and let the sweep finish normally.

### B2. The acquire door

New public `RunnerService.acquire_draft_file(repo: str, file: str, cancel_check=None) -> Path`
— a thin wrapper over the SAME one-acquire path `_run_load`/`_run_download` use
(`_acquire_model` with `cache_root=self._cache_root / "hf"` +
`download_kwargs(self._config_fn())`), returning the snapshot path to `file`;
`FileNotFoundError` if absent after acquire (mirror the existing fail-loud check).
The tuner calls it per candidate BEFORE the trial, with
`cancel_check=lambda: self._cancel` and `detail="downloading draft <name>…"`.
A download failure records a failed trial row (error string), never kills the sweep.
Disk note for the record: alternates land in the normal HF cache next to the
configured draft — no new cleanup class (delete-model-cache semantics unchanged).

### B3. The trials

1. `"no draft (spec off)"` — `_merged(base, {"spec_type": "none", **batch512})`. A
   NORMAL candidate: `spec_type=none` is a legitimate, saveable tune row (the
   documented MTP opt-OUT, `llm/db.py:332-334`). On a CPU-only box this is the trial
   that answers whether speculative decoding pays there at all (the user's CPU-only
   ask — measured, not argued).
2. Per alternate (≤4): `"draft <quant-or-basename> (<size> GB)"` —
   `_merged(base, {"model_draft": str(path), **batch512})`, and the trial row carries
   `"informational": True`.

### B4. Winner + save discipline

- `_pick_winner` (`:184-205`): rows with `informational` are EXCLUDED from the
  explicit-candidate set — a draft-FILE trial can never become `best` and can never be
  saved (a `model_draft` tune row would pin an absolute path; the durable form of that
  choice is the catalog's `mtp_draft_*` fields, which stay user-set via the Edit-model
  dropdown — v1 is an EVIDENCE surface, per the seed principle: the machine supplies
  measurements, the user supplies choices).
- The `"no draft (spec off)"` trial participates normally under strict-beat; if it
  wins with `save=True`, `{spec_type: "none"}` persists — correct and intended.
- **Test-pinned invariant: no `model_draft` key ever reaches `save_fn`.**
- Flagged follow-on (NOT built): a one-click "use this draft" that writes the catalog
  row from a winning informational trial.

### B5. Tests (offline, fake service — the existing autotune-test pattern)

(1) MTP base with listed alternates → the phase emits "no draft" + per-alternate rows,
acquire called per alternate BEFORE its load; (2) non-MTP base → no phase; (3)
informational rows never win/never reach `save_fn` even when fastest; (4) "no draft"
CAN win and saves `spec_type=none` under strict-beat; (5) budget tripped → phase
skipped, sweep completes; (6) listing raises → phase skipped, sweep completes; (7)
cancel during an alternate download aborts promptly (cancel_check honored).

---

## Builder constraints (binding)

- **Known-bad tests on this Windows box** (MORNING_RECAP): `test_hardware.py::test_pci_gpus_linux_lspci_name_match`,
  `test_lifecycle.py::test_ensure_model_ready_loads_then_returns` (known-bad),
  `test_ensure_model_ready_raises_on_failed_load` (flaky, under suspicion — rerun `-n 0`
  once). **Any OTHER failure is a real regression — don't wave a fourth through.**
- **Never touch the user's live `:1420` / `:17495`.** Any probe uses an isolated
  server + temp data dir.
- **cwd footgun:** never chain `cd` in compound commands; explicit absolute paths /
  `git -C` per command.
- **Verification:** full `python -m pytest` (runner) + `npm run build:vite` from
  `justwrite-app` (kit compiles) + **ONE rules-checker on the final diff** (spawned
  Opus subagent — the main-session voluntary cadence).
- **Commits:** runner — Part A and Part B may be one commit each or one combined
  (builder's call, smallest honest units); JW — `docs/models.md` (+ the TASKS.md line
  flip to shipped). Terse messages; the record lands HERE, not in the commit body.

## RECORD (executed 2026-07-19)

**Built as specced, both parts.** Two deviations from the spec's letter, both noted
below (A2's `vram_mb` wording; the lifecycle tests asserting wiring rather than a
numeric delta). No decision was taken that the spec did not already settle.

### What changed · why · file:line

**Part A — the draft's VRAM**

- `llm_runner/runner/fit.py:190-211` — new `marginal_vram_mb(...)` = `estimate_vram_mb(...) - _C5`,
  floored at 0. `_C5` (≈1.5 GB) is the fitted per-IN-USE-GPU base constant (CUDA
  context + compute buffers): it is paid ONCE, by whichever model puts the GPU to work.
  Charging it twice would double-count ~1.5 GB and shed main-model layers for nothing.
- `llm_runner/runner/process.py:304-334` (signature + docstring), `:360-386` (the term),
  `:404-419` (the reservation) — `compute_fit` gains keyword-only
  `draft_meta` / `draft_bytes`. Order is exactly the spec's: ctx is chosen against the
  UNdiminished budget, then `draft_marginal_mb` is subtracted, then the layer split runs
  on `main_budget_mb`. **Deviation from the spec's wording:** the spec said the forward
  `vram_mb` should "run on budget − draft_mb", which does not typecheck (that call takes
  gpu_layers, not a budget). Implemented per its evident intent — `vram_mb` (what the
  VRAM ARBITER reserves) now equals main-estimate **+** the draft's marginal cost, so the
  reservation matches what the process actually holds; under-reporting it would let a
  co-resident admission over-book by exactly the draft's size, which is the #274 defect
  this change exists to close. The `n_gpu == 0 but a draft is present` branch reserves
  the draft's FULL estimate (it is then the only GPU tenant, so it pays the base itself).
- `llm_runner/runner/lifecycle.py:1246-1265` — new `_draft_fit_inputs(ov)`, THE one
  reader of `(draft_meta, draft_bytes)`, keyed on `ov.model_draft`. Shared by all three
  fit sites so none can count what another misses. Best-effort: an unreadable header
  yields no term rather than failing a load (the fail-loud acquire already covers a
  genuinely missing draft, and the spawn OOM back-off is the net).
- The three call sites: active load `lifecycle.py:1585-1590`, router `.ini` emitter
  `:1897-1901`, and `preview_fit` `:1017-1030` — the last also gained the emitter's
  cached-draft resolve (`_wants_draft` + `_cached_draft_path`) so the Tune modal's
  preview matches spawn truth instead of silently ignoring the draft.

**Part A — the pick floor**

- `llm_runner/runner/models.py:137-155` — new `_q4_or_better(quant)`. True for Q4/IQ4 and
  above incl. BF16/F16/F32; false for Q2/Q3/IQ2/IQ3, the `PQ2_0` class (a leading P is a
  format marker, not a bit-width) and an empty token.
- `models.py:196-197` — each `drafts` row carries `q4OrBetter`, so the UI orders by the
  server's predicate instead of re-deriving the rule.
- `llm/model_catalog_api.py:131-147` — `RepoDraftRow` declares `q4OrBetter`. **This one
  line is what makes the whole UI floor real**, and it was MISSING in the first cut: the
  `/model-catalog/list-files` route carries `response_model=ListFilesResponse`, and
  Pydantic's default `extra="ignore"` silently drops any key the row model doesn't name —
  so the flag arrived in the browser as `undefined`, the sort's first key was constant,
  and the pre-select quietly fell back to smallest-wins-with-no-floor: exactly the
  behaviour A4 exists to replace. Caught by the rules-checker, not by the tests, because
  every test called `classify_gguf_entries` in-process and never crossed the wire. The
  docstring now says so, and `test_draft_floor_flag_survives_the_wire_model` pins the hop.
- `models.py:305-345` — `_gguf_drafter_in_repo` now returns the smallest candidate AT the
  floor, falling back to smallest overall when none clears it. It also carries each
  candidate's quant token alongside its entry, which removed a redundant second regex
  search at the end (one source for the token).
- `ui/src/components/LuModelCatalog.vue:405-420` — the pre-select sorts
  (`q4OrBetter` desc, `sizeMb` asc). The comment now states the REASON (a draft is a
  speed device only; γ×bytes of extra traffic per cycle; it steals VRAM from main
  layers; the floor guards the collapse end; largest-that-fits considered and rejected)
  instead of the old one-box anecdote.

**Part B — the Lab draft measure (D4)**

- `llm_runner/runner/lifecycle.py:1224-1249` — new public `acquire_draft_file(repo, file,
  cancel_check, on_progress)`: now **THE single draft-fetch body**, called by BOTH the
  sweep and `_acquire_and_identify`'s configured-draft leg (`:1478-1483`, which lost its
  inline copy). The first cut left the two side by side — same `_acquire_model` call, same
  snapshot join, same fail-loud `FileNotFoundError` — sharing only the innermost helper;
  the rules-checker called that correctly as R3 (a copy is the thing that drifts). One
  body now owns the whole rule. Alternates land in the normal HF cache, so disk-reclaim
  semantics are unchanged.
- `llm_runner/runner/autotune.py:399-423` — `_draft_alternates`: gated on
  `spec_type == "draft-mtp"`, excludes the CONFIGURED draft (the baseline already
  measures it), orders by the shared floor-then-size rule, caps at `_DRAFT_ALT_CAP = 4`.
  Listing failures are advisory — logged, phase skipped, sweep completes.
- `autotune.py:425-471` — `_draft_phase`: one **saveable** `"no draft (spec off)"` trial
  (`spec_type=none` is the documented MTP opt-OUT) plus one **informational** trial per
  alternate, each acquired before its own load. Runs LAST, because it is the only phase
  that may download. `autotune.py:512-517` wires it in after the `spec-n` phase, behind
  the same budget gate and `cancelled()` check as every other phase.
- `autotune.py:225-232` — `_try` gains keyword-only `extra`, seeding extra keys at row
  CREATION. Patching the row after `_push_trial` would have been observable half-written
  by a concurrent `status()` poll; this closes that race by construction.
- `autotune.py:194-199, 210` — `_pick_winner` excludes `informational` rows from the
  explicit-candidate set. A draft-FILE trial therefore can never win and can never be
  saved: a `model_draft` tune row would pin an absolute cache path, while the durable
  home for that choice is the catalog's `mtp_draft_*` fields, which the user sets in the
  Edit-model form (the seed principle — machine measures, user chooses).

**One adjacent correction (R2, found while enumerating draft sites)**

- `lifecycle.py:2181-2196` — the draft-crash back-off comment claimed dropping MTP "is
  ONLY ever a deliberate FIT decision for a draft that doesn't fit VRAM (made in
  compute_fit)". `compute_fit` has never made that decision — it returns a FitPlan with
  no spec fields and could not. The comment is corrected to state what is true now: the
  draft's VRAM IS charged, so an unfittable draft sheds MAIN-model layers rather than
  silently disabling speculation, and the only automatic strip is the emitter's loud
  missing-draft one. Comment only; no behaviour change.

**Docs**

- `justwrite-app/docs/models.md` — the Add-a-model paragraph now explains the
  smallest-at-4-bit pre-select in user terms (a draft can never change what the model
  writes, so small is right on every machine, big card included) and states that the fit
  reserves memory for it; the Tune & measure paragraph documents the spec-off trial and
  the informational draft trials, and points at Edit → MTP draft as where a winner is
  made durable.
- `docs/plans/2026-07-19-dspark-drafter-detection.md` — follow-on pointer at the end.

### How verified

- `python -m pytest` (full runner suite, final): **612 passed, 1 skipped, 3 failed** —
  the three documented known-bad on this Windows box
  (`test_hardware.py::test_pci_gpus_linux_lspci_name_match`,
  `test_lifecycle.py::test_ensure_model_ready_loads_then_returns`,
  `test_lifecycle.py::test_ensure_model_ready_raises_on_failed_load`). No fourth. New
  tests: 2 in `test_fit.py`, 4 in `test_runner.py`, 5 in `test_models.py`, 2 in
  `test_lifecycle.py`, 9 in `test_autotune.py`.
- **Both new escapes were PROVEN to fire**, not assumed. Temporarily dropping
  `cancel_check=` from the sweep's acquire call turns
  `test_cancel_DURING_a_draft_download_aborts_that_fetch` red (the fake completes the
  download); temporarily removing `q4OrBetter` from `RepoDraftRow` turns
  `test_draft_floor_flag_survives_the_wire_model` red (`KeyError`). Both were then
  restored and the suite re-run.
- **The flaky test is no longer flaky — it is BROKEN, and not by this change.** It failed
  serially (`-n 0`) here, so parallelism is not the cause; it then failed IDENTICALLY
  (`Timed out preparing … after 10s` where `failed to load` was expected) in a clean
  `git worktree` at unmodified HEAD 921f9cb. Pre-existing, proven, not mine. It should be
  pinned or quarantined rather than waved through again (`docs/TASKS.md` already tracks it).
- `python -m ruff check llm_runner tests` — clean. `npx biome check` on the changed
  `.vue` — clean. `npm run build:vite` from justwrite-app — built (kit compiles).
- **ONE rules-checker (Opus) on the final diff — verdict FAIL, 4 findings, all four
  fixed and re-verified.** Worth recording because three of them were invisible to a
  green suite: **(R4)** the `RepoDraftRow` wire strip above, which made the headline
  feature a no-op in the browser while every test passed; **(R2)** comments calling
  b10068 "the pinned build" when the pin is b9993 (`config.py:49`) and b10068 is merely
  what is installed here; **(R5)** the cancel test asserted only that nothing downloaded
  after a cancel that landed BEFORE the phase — it passed with the cancel token removed,
  so it proved nothing; it is now split into a between-trials test and a real
  during-download abort; **(R3)** `acquire_draft_file` duplicating the draft leg. Its
  non-scored notes were also taken: `test_fit_without_a_draft_is_byte_identical` was a
  tautology (defaults vs explicitly-passed defaults) and now pins literal FitPlan values;
  the `_q4_or_better` docstring no longer claims the two pickers "cannot drift" (they
  differ on full precision, deliberately); and the `_KV_CTX_SHARE` comment now admits the
  share covers main + draft KV together.
- No renderer smoke: the one UI change is a pre-select ORDERING inside an existing
  handler, with no new markup or route — the compile check plus the server-side predicate
  tests cover it. The user's own box check is the ordering itself (below).

### The A6 finding (recorded, as required)

Read from a real binary, not from memory:
`…/ai-cache/llamacpp/b10068/cuda12/llama-server.exe --help`.

**Caveat the rules-checker forced, and it matters:** b10068 is what happens to be
INSTALLED on this box. The **pin is `b9993`** (`config.py:49`, bumped 2026-07-14), which
is what a fresh install gets. These facts were NOT re-read on b9993 — that binary isn't
here — though upstream's server README agrees with them. Every comment now says
"installed b10068 (the pin is b9993)" rather than calling b10068 pinned.

- `--spec-draft-ngl, -ngld, --gpu-layers-draft` → **default `auto`**, NOT `all`. My first
  comments said llama.cpp "offloads it whole"; wrong, corrected at `process.py:376-381`.
  Charging ALL the draft's layers is now justified as the CONSERVATIVE direction
  (over-reserving costs at most one main layer; under-reserving is what OOMs), not as a
  claim about the engine's default.
- **No draft-specific context flag in that build** (no `--ctx-size-draft` / `-cd`;
  confirmed independently against the upstream server README), so the draft rides the
  main `ctx-size` — what the fit term assumes. Load-bearing enough that the b9993
  re-read is a real residual gap, not a formality: if the pin DID have a smaller draft-ctx
  default, the term would merely be conservative rather than wrong.
- The build also exposes `--spec-draft-type-k/-v` (draft KV cache type). We set neither,
  so the draft inherits the main cache type — which is what the term uses.

### What reverses it

Revert the commit(s). No schema, no on-disk cache layout, no persisted data changes
shape. The ONE wire change is additive and backward-compatible: `q4OrBetter` is a new
optional field on `RepoDraftRow` (`ListFilesResponse`), defaulting to `False` — an older
client ignores it and sorts by size, the pre-2026-07-19 behaviour. (An earlier draft of
this record claimed "no wire format" change at all; that was wrong, and wrong in the
direction that hid the bug above.) `informational` is an additive key on a transient
trial row. Tune rows are untouched — the draft phase is barred from writing any, by test.

### Flagged / not built

- **The spec's own D5 stands:** the coarse pre-download badge (`coarse_fit` / `api.py:34`)
  stays draft-blind, and CPU-only RAM-side draft accounting is not modelled.
- **Alternates are only found where draft DETECTION already looks.** `_draft_alternates`
  reuses `classify_gguf_entries`' `drafts` list, which is name-keyed (`MTP/` dir,
  `-MTP.gguf`, `dspark`). A model whose drafter is a plainly-named file in a separate
  assistant repo — the seeded `gryphe-styletune-v2`, whose draft is
  `…-assistant-Q8_0.gguf` — therefore yields NO alternates, and its draft phase runs the
  spec-off trial only. This is the pre-existing detection rule (the Add/Edit form's draft
  dropdown has the identical blind spot), not a regression, and it degrades quietly. A
  fix belongs in detection ("any GGUF in a designated draft repo is a draft candidate"),
  which is outside this spec.
- **A winning informational trial is shown but not actionable in one click** — the user
  must set the draft on the model in Edit. The spec named this as the deliberate v1 stop;
  the follow-on would be a "use this draft" button writing the catalog row.
- **Engine facts not re-read on the PIN.** `-ngld auto` and the absence of a draft-ctx
  flag come from the installed b10068; the pinned build is b9993. One `--help` on a b9993
  binary closes it.
- **✅ Box-checked good on the real box (2026-07-20, user).** Both looks are done: (1) the
  draft rows in the Tune & measure trial strip (labels `draft <file> (N.N GB)` read well,
  strip width fine) and (2) the Add-model form's draft pre-select on a repo shipping a
  sub-4-bit draft (the floor picks the expected quant, not the smallest file). **Note (2)
  was not a nicety:** the wire-strip bug above made that exact pre-select silently wrong
  while the whole suite was green — one look at the form caught what no test did. Closed in
  `justwrite-app/docs/TASKS.md`.
- **Unrelated, but proven this session:** `test_ensure_model_ready_raises_on_failed_load`
  is deterministically failing at HEAD (see above) — it needs its own fix, not a waiver.
