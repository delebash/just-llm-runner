# Serving design — router, arbiter, cancel (the distilled record)

Distilled 2026-08-04 by the docs campaign from the SVM design + implementation pair
and the load-cancel plan, all now in `../plans/archive/`. What shipped lives in
`llm_runner/runner/`; this doc keeps the design intent, the invariants, and the
open edges.

## The shape

- **Router mode** (llama.cpp): the router is a SUPERVISOR spawning one
  `llama-server` child per model. The DB is the single source of truth; `models.ini`
  is a generated artifact (`emit_models_ini`), and every entry carries a FITTING
  per-model placement — never a blanket `ngl=999` (verified failure: the engine
  aborts fit when the user pre-sets it).
- **The engine's eviction is count-based (`--models-max`), NOT VRAM-aware** — that
  residual gap is why `runner/arbiter.py` exists: `VramArbiter` tracks reservations
  across the shared router AND a host's other engines, co-resides when the budget
  fits, else evicts the LRU non-pinned before load. A reservation is the
  GPU-RESIDENT VRAM (`FitPlan.vram_mb`), not the file size; `n_gpu == 0 → 0 MB`
  (plus the measured-true-up lesson: an ngl-0 load still costs ~549 MB CUDA context).
- **Resident-set policy** (P4 design; 4a shipped, 4b closed-dropped): pin the tiny
  always-needed model (embeds, `reserve(pinned=True)`), TTL-warm the active big
  model (`--sleep-idle-seconds`), co-reside extra big models only when the remaining
  budget fits, else swap the LRU. Embeds co-reside via `ensure_embedding()` +
  `POST /v1/llm-runner/ensure-embedding`.
- **The port is allocated, never assumed** — `find_free_port` at spawn, the live
  port on `RunnerService.router_url()`; health-by-port is not identity (the
  two-apps-one-box lesson in CLAUDE.md).
- **Flag SPELLINGS follow the engine build, and an install must prove it accepts them**
  (2026-09-19, plan `../plans/2026-09-19-engine-update-safety-and-stable-channel.md`).
  Upstream REMOVES flags: b10875 deleted `--mlock` and `--mmap`/`--no-mmap` in favour of
  `--load-mode`, and an unknown flag is fatal (`arg.cpp` throws; through the router's
  preset file `preset.cpp` throws "option not recognized"). So: the kit's switches stay
  `mlock`/`no_mmap` everywhere (DB, seeds, UI, tunes, fingerprints) and only the EMITTED
  flag changes, at `process.LOAD_MODE_MIN_BUILD` (b10145 — the first build with
  `mmap+mlock`); `_emit_ini` renders for the exe that will READ the file, never for
  `_active_server_exe`, which `stop()` does not clear and which names the swept build
  after an update. `binary._verify_exe_accepts_flags` runs `process.probe_argvs(build)`
  against the STAGED exe before the swap — flags first, `--version` last, since args parse
  in order — so a build that refuses our argv never replaces a working engine. Measured
  on b10437: our old `--mlock --no-mmap` pair resolved to `load_mode = none`, i.e. the
  lock had been silently lost on every model since b10105.
- **The update check follows upstream's STABLE channel** (same plan). Since 2026-08-21
  every `bNNNN` is a prerelease and `releases/latest` answers a semver tag whose one asset,
  `nightly-tag.txt`, names the build. `binary.build_num` is STRICT (`b\d+` → -1 otherwise)
  because the old digit-strip read "v0.4.1" as 41 and the check reported "you are current",
  silently, for a month. Download names are resolved from the target release's OWN asset
  list (`binary.resolve_release_assets` + `GET /v1/llm-runner/engine/resolve-assets`), not
  by substituting a tag — upstream renames them (Windows AMD hip-radeon → rocm-7.14 →
  rocm-10.0; Linux AMD absent for ~180 builds). The runner still NEVER writes the pin; the
  UI does, and rolls it back when the install does not land on the target.
- **A newer engine is not assumed to be better — it is measured.** The 2026-09-19 box test
  REFUSED the plan's b9993 -> b10964 pin move: without a draft the builds tie (0.995), but
  with the flagship's MTP draft b10964 runs at 0.784 of b10437 AND its speculative output no
  longer equals its own greedy output (b10437's does). A bisect named the cause — b10751,
  `cuda: fuse MoE weighted expert reduction` (#25952), one commit, CUDA-only, MoE-only,
  reordering float accumulation across experts. Still broken at b11057 (head), and reported
  upstream as ggml-org/llama.cpp#29168. **The pin went to `b10750`** — the last good build,
  which also beat b10437 (1.028x, output byte-identical) and, unlike it, has an asset for
  every platform. Any pin move runs that test first; `scripts/check-structured-output.py` is
  the matching correctness probe.

## Cancel + progress (the load-cancel plan, shipped through T4)

- Never announce a download that isn't happening: `detail="preparing"` until the
  real progress callback writes the phase; cached files fire no download phase.
- Cancel is a `threading.Event` the load thread honors at checkpoints — including
  one IMMEDIATELY before `_admit` (so a doomed load never evicts an innocent
  resident) and a post-spawn silent unload of the just-spawned child. The router op
  itself is not interruptible mid-spawn; the wire says `stopping`/`cancelling`
  (`stopping` deliberately overrides even an ACTIVE listing).
- Unload is confirm-based: poll `GET /models` bounded ~5 s; final removal is a
  compare-and-pop under the lock.
- One control everywhere: `loadPhases.js` (`friendlyPhase`) + `useRunnerModels`'s
  `taskFor(modelId)` feed the ONE `DownloadBar`.
- **T5 (real VRAM-load %) is NOT BUILT, but the DATA now exists** — the 2026-07-17 probe
  showed `progress` ABSENT from the router's `GET /models` loading status (`{value, args,
  preset}` only), so the honest indeterminate sweep stays. The 2026-09-19 pin-bump re-probe
  found it on a DIFFERENT door: at b10437+ the router stores the child's
  `cmd_child_to_router:state` payload as `meta.progress` = `{stages, current, value}` and
  broadcasts it on **`GET /models/sse`** as a `status_change` event; `GET /models` still
  omits it. Unblocked, not designed — consuming SSE inside the load thread, and its cancel
  interplay, is the open part. (Tracked.)

## Fit — one physical authority (the 2026-08 redesign, §7.6's record)

Written at Phase 7 of the fit redesign (`../plans/2026-08-09-fit-redesign.md` —
the full evidence index, rulings, and per-phase record; this section is the
standing distillation).

- **One authority: `runner/fit.py` physics over stored header FACTS.** A model's
  immutable file facts (layer/head counts, the two KV scalars + window, expert
  byte share, size) are stored as `model_catalog` columns by the three writers
  (inspect-by-link, download identify, seed refresh); every derived number —
  the Min-VRAM/Min-RAM floors, the est, the catalog badge, the speed band, the
  forward VRAM booking, the untuned split — is COMPUTED FRESH at read from
  those facts. Nothing derived is ever stored (facts-not-floors, §8.19): improve
  the physics and every row improves on the next read. Before the redesign there
  were FIVE fit authorities (badge · floor estimator · compute_fit · the
  engine's `--fit` · hand-curated floors) with no consistency tests between
  them; hand-added MoEs got a MoE-blind formula and read "Won't fit" on boxes
  that ran them.
- **The split is the joint solve** (`fit.moe_joint_split`, Phase 6): an untuned
  two-pool MoE pins ngl = all layers and walks the smallest expert-offload that
  fits the draft-charged physics; every other untuned arm tries physics-full-
  offload first. The measured class tunes (ngl 99 / ncmoe 21 on the author's
  box) are reproduced by computation now — `tests/test_fit_acceptance.py` is
  the five-row gate.
- **The oobabooga regression survives in exactly two roles**: the CI oracle on
  its fitted dense-CUDA domain (`test_regression_oracle_dense_domain` pins
  physics/regression agreement there) and the inverse chooser for PARTIAL dense
  offload. It no longer prices floors, bookings, drafts, or MoEs (its fitted
  −18 MB/layer credit goes negative on max-offload MoEs — §1.2's a = −1.24).
- **Verdicts inform, never gate (§8.23).** No picker, dropdown, or load path
  consults the fit verdict as a veto — the badge + speed band ride the labels,
  a "no" pick shows an honest warning, and the engine's own load attempt +
  probe-and-back-off (ncmoe-first for MoEs since Phase 6) stays the final
  authority. Recommendation RANKING may prefer runnable, but THIS-box evidence
  (`ranHere` — any persisted measurement/tune/load-footprint row for this
  machine_key) outranks the estimate's veto (§7.4-as-ranking).
- **The speed band is honest at its edges** (speed-truth plan
  `../plans/2026-09-19-speed-truth-and-calibrated-pick.md`). A PREDICTION within
  `band_deadzone_frac` (seeded 0.10, GUI-editable) of any band threshold ships
  band `""` with `predTokS` set, and the chip shows "~7.9 tok/s" instead of a
  word the next probe reading could flip (`fit.in_band_deadzone`). A measured
  speed always keeps its word. Quick setup measures the model it just loaded
  (source `measure`, empty switches — display truth, never bandwidth-derivation
  input, because flagless rows never qualify) so the model a user set up shows
  a real number, MTP included.
- **Weights are counted from the file's tensor table, in MiB** (vram-truth
  plan `../plans/2026-09-19-vram-truth-exact-bytes-units-offload.md`). The
  reader sizes every tensor by OFFSET DELTA (no quant-type table) and sorts it
  by llama.cpp's own placement: routed experts by the engine's regex
  (`gguf.EXPS_REGEX` = b10437 `LLM_FFN_EXPS_REGEX`) vs the rest of each block;
  the output side incl. a tied head's DUPLICATED vocab table; the input table
  (always CPU). `fit.placed_weight_mib` + `engine_gpu_blocks` reproduce
  `llama-fit-params -fitp on` to < 1 MiB on 11 configs. The header formula
  `expert_byte_share()` is the fallback only. ONE unit: every VRAM figure is
  MiB (budgets and measurements always were); the SPEED path stays decimal MB
  against decimal GB/s (`kv_mb_from_facts(…, unit=1e6)`). The EMITTED `-ngl`
  goes through `process.engine_ngl_flag`: llama.cpp counts the output layer,
  so "every block" renders n + 1 (measured +5.94 % tok/s on the 26B) — the
  kit's own `n_gpu_layers` (tunes, fingerprints, the OOM shed) never sees the
  +1. `__overhead__` rows are stamped `<build on disk> <PHYSICS_VERSION>`.
- **The host-bandwidth ladder has a measured rung** (speed-truth plan, §6): real-model
  derivation → **the one-minute speed check** (`runner/calibrate.py`,
  pseudo-row `__machine_moe_bw__`, label build-stamped `moe-stream probe
  <build>` so an engine upgrade re-offers it) → the memcpy probe ×
  `bw_eff_host_probe` → the class seed × `bw_eff_host`. The check runs the
  installed llama-server on a sha-pinned MoE GGUF from the kit's own GitHub
  release (`calib-v1`), all-on-GPU then experts-in-RAM, and takes
  `active-expert MB / (t_B − t_A)` from llama.cpp's own `timings` — the delta
  cancels the fixed per-token overhead that dominates a model that small.
  Evidence: on the author's box it read 29.18 GB/s and predicts the flagship's
  measured un-sped speed within 1 %; the probe × 0.40 rung said 8.4 tok/s for
  a model that runs 26.6 (plan §11.4). Quick setup offers it only where no
  class preset matched (`pickByClassConfig` short-circuits every curated box)
  and never on one-pool machines. The fallback pick (`pickBestModel`) also
  applies a speed floor, `band_fine_toks × (1 − speed_floor_grace)`, to
  measured-else-predicted tok/s; unknown speeds pass.
- **Claims come from the four-arm resolver** grown into `preview_fit` (Phase 5):
  resident reservation → persisted-measured median (fingerprint-matched, this
  machine + backend) → computed physics with the learned `__overhead__`
  coefficient → declared est. Every claim carries provenance
  (measured|computed|declared) so no consumer mistakes an estimate for truth.
- **History note (the June 2026 decision, previously recorded only in an
  archived plan):** gguf-parser-go was evaluated as a replacement fit estimator
  and `fit.py` was kept. That decision is SUPERSEDED by this redesign —
  `fit.py` grew the first-principles physics itself, and the external-tool
  question is closed.
- **The one-pool ruling (2026-08-13, post-redesign):** on one-pool boxes the
  ledger tracks POOL OCCUPANCY, not device placement. Phase 4 made the
  arbiter's denominator arch-aware but the BOOKING kept its pre-Phase-4
  carve-out clamp (`min(booked, max_vram_mb)` — 0–128 MB on iGPU boxes, so
  admission never engaged, the claim line read ~0, and the `__overhead__`
  calibration recorded garbage; both the clamp's comment and its own test
  said "until Phase 4" and the debt was never collected). The clamp's ceiling
  is now `budget_total_mb` (identical on discrete by construction), the two
  carve-out-era test pins are re-pinned to pool truth, and a new pin asserts
  a one-pool booking equals the same physics a pool-sized discrete card would
  book. The same ruling's app half: a JV managed-engine load on a one-pool
  box books its declared `vram_min_mb` whichever device it resolves (CPU and
  GPU are the same physical bytes there); discrete keeps
  cpu-resolves-books-nothing. Recorded gaps: GPU-less CPU-only boxes still
  book 0 (the fit's `one_pool` arm excludes them by design), and
  `configure_service(declared_claim_fn=…)` is DEAD plumbing — assigned, read
  nowhere, and `preview_fit` resolves catalog ids only; JV prices its engines
  from its own manifests instead. Delete or complete it when it next blocks.

## Known limitations (standing, by design or unfixed)

- The arbiter's LRU sees load-time + measure/tokenize touches, NOT live generate
  traffic.
- `--sleep-idle-seconds` unloads the child while the arbiter KEEPS the reservation
  → `committed_mb` over-counts after sleep (conservative by choice). A SLEEPING
  child is NOT VRAM-free, and direct-to-router clients bypass the arbiter entirely.
- An evict-then-failed-load leaves the victim evicted (collateral).
- The multi-click unload/reload oddity was never diagnosed — the plan's own ruling:
  observe once with timestamps, REPORT BACK, don't fix blind. (Tracked.)
