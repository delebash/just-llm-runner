# One acquire path — Download fetches the MTP draft too (2026-07-19)

> ✅ **CLOSED (docs campaign 2026-08-04)** — shipped. History/evidence only; live work: `docs/dev/TASKS.md`.

## What changed

The catalog **Download** button now acquires a model's external MTP draft GGUF, not
just the main weights — the exact bytes the **Load** path acquires. There is now ONE
acquire path (`_acquire_and_identify`) covering main + draft for both download and load;
the load path no longer holds a second, inline draft-acquire block. The router `.ini`
emitter keeps its "strip `spec-type` when the draft is missing" safety, but it is now
**loud** — it logs a WARNING naming the model instead of silently dropping to no-MTP. The
catalog badge ("Downloaded ✓") is computed from a new `RunnerService.model_downloaded`
that counts the draft when the resolved config wants it.

Concretely:

- **`_wants_draft(ov, model)`** — a new module-level predicate: `ov` selects
  `spec-type = draft-mtp`, no explicit `model_draft` was set, and the catalog model
  declares a `mtp_draft_file`. THE one needs-its-draft test, shared by its three
  consumers (acquire · ini-emit · badge).
- **`_acquire_and_identify`** gains keyword-only `overrides` / `on_progress_draft` /
  `reset_progress`; when `_wants_draft` holds it acquires the draft via the SAME path and
  returns a 3-tuple `(model, gguf, draft_path_or_None)`. The fail-loud existence check
  (`FileNotFoundError` when the snapshot lacks the draft) is preserved verbatim.
- **`_run_load`** deletes its inline draft block and passes `overrides=ov` +
  the two draft callbacks to the shared function; `if draft_path: ov.model_draft = str(draft_path)`.
- **`_run_download`** resolves `ov = _switches_to_overrides(switches_fn(id) or {})`
  (a pure DB read — the "engine not required to download" promise still holds) and passes
  the same params; its `cancel_check` now covers both legs.
- **Router `.ini` emitter** uses `_wants_draft(ov, m)` and, on the missing-draft branch,
  logs `log.warning(... "MTP is OFF for this router section; Re-download the model ...")`
  before stripping `spec_type`/`spec_n_max`.
- **`RunnerService.model_downloaded(m, hf_cache)`** = `is_cached(main)` AND
  (`not _wants_draft` OR the cached draft path exists); the `/models` endpoint calls it
  instead of a raw `is_cached`.

## Why

- **The download/load split.** Download fetched only the main weights (`_acquire_and_identify`),
  while load additionally acquired the draft inline. So an MTP model's first load did a
  surprise multi-hundred-MB fetch that "Download" implied was already done.
- **The lying badge.** `/models` marked a model "Downloaded ✓" on the main GGUF alone —
  true for a plain model, false for an MTP model still missing its draft.
- **The silent strip.** The `.ini` emitter stripped `spec-type` for a draft-less section
  with no trace, so a config that asked for MTP quietly ran without it and nobody knew why.

## File:line

- `llm_runner/runner/lifecycle.py`
  - `_wants_draft` — new predicate at **:291**.
  - `_acquire_and_identify` — new kw params + draft acquire + 3-tuple return, **:1380** (draft block at **:1424**).
  - `model_downloaded` — new method at **:1224**.
  - `_run_load` — inline draft block deleted; shared-acquire call at **:1531**.
  - Router `.ini` emitter — `_wants_draft` + loud strip WARNING at **:1833**.
  - `_run_download` — `ov` resolve + draft callbacks at **:2189**.
- `llm_runner/runner/api.py` — `/models` listing calls `service.model_downloaded(m, hf_cache)`
  (was `is_cached`); the now-unused `from .models import is_cached` removed.

## How to verify

- `python -m pytest tests/test_lifecycle.py` — new tests:
  `test_download_acquires_both_legs_for_mtp` (two acquire calls in order + the
  "MTP draft model" phase), `test_download_single_acquire_when_no_draft_wanted`,
  `test_download_cancel_during_draft_leg_returns_to_idle`,
  `test_ini_emit_strip_warns_when_draft_missing` (caplog proves the WARNING fires),
  `test_model_downloaded_false_when_wanted_draft_missing_then_true`,
  `test_model_downloaded_true_when_draft_not_wanted`. The load-path guarantees stay
  pinned by the pre-existing `test_load_acquires_declared_draft_and_emits_model_draft`
  and `test_load_fails_loud_when_declared_draft_missing`.
- `tests/test_runner_models.py` — `_FakeService` gained `model_downloaded` (returns False:
  nothing on disk); the three `api.is_cached` monkeypatches were dropped.
- Full `python -m pytest` — green apart from the box's known-bad
  `test_hardware.py::test_pci_gpus_linux_lspci_name_match`,
  `test_lifecycle.py::test_ensure_model_ready_loads_then_returns`, and the flaky
  `test_lifecycle.py::test_ensure_model_ready_raises_on_failed_load`.

## What reverses it

Revert this commit. The old shape returns: `_acquire_and_identify` back to a 2-tuple,
the inline draft block back in `_run_load`, `_run_download` back to main-weights only,
the `.ini` emitter's inline draft condition (silent strip) restored, and `/models` back
to a raw `is_cached`. No schema or on-disk-cache format changed, so no data migration.

## Flag

**Silent-drop remedied as a warning-log ONLY** (coordinator recommendation, shipped
flagged): the missing-draft `.ini` strip now logs a WARNING but there is **no
row-status surfacing** — the catalog row does not show a "MTP unavailable, re-download"
state. That UX affordance was considered and deliberately not built here.
