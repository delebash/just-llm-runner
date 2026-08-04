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
- **T5 (real VRAM-load %) is NOT BUILT** — the 2026-07-17 probe showed `progress`
  ABSENT from the router's `GET /models` loading status (`{value, args, preset}`
  only); the honest indeterminate sweep stays. **Re-run the probe at every engine
  pin bump** — upstream documents a `status.progress` shape. (Tracked.)

## Known limitations (standing, by design or unfixed)

- The arbiter's LRU sees load-time + measure/tokenize touches, NOT live generate
  traffic.
- `--sleep-idle-seconds` unloads the child while the arbiter KEEPS the reservation
  → `committed_mb` over-counts after sleep (conservative by choice). A SLEEPING
  child is NOT VRAM-free, and direct-to-router clients bypass the arbiter entirely.
- An evict-then-failed-load leaves the victim evicted (collateral).
- The multi-click unload/reload oddity was never diagnosed — the plan's own ruling:
  observe once with timestamps, REPORT BACK, don't fix blind. (Tracked.)
