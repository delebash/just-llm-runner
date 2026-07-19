# dspark drafter detection + inherited-drafter shard/fp16 guard (2026-07-19)

## What changed

Two edits to `llm_runner/runner/models.py`, plus tests.

1. `classify_gguf_entries` now treats any `.gguf` whose path contains `dspark` as a
   draft file (alongside the existing `-MTP.gguf` / `MTP/` conventions). Both of a
   repo's `-dspark-*` files therefore land in `drafts` and neither leaks into the
   quant dropdown.
2. `_gguf_drafter_in_repo` (the tier-C inherited-MTP suggestion) no longer picks the
   smallest gguf blindly. It first filters the candidate list: split shards (path
   matching `-\d+-of-\d+\.gguf$`, case-insensitive) are excluded, and a file must
   carry a real Q/IQ quant token — BF16/F16/F32 and untokenised files are dropped.
   The smallest *surviving* file is returned; if none survive it returns `None`.

## Why

HF repo `prism-ml/Ternary-Bonsai-27B-gguf` ships its own drafters named
`Ternary-Bonsai-27B-dspark-Q4_1.gguf` and `Ternary-Bonsai-27B-dspark-bf16.gguf`.
Draft detection was name-keyed to the MTP convention only, so those files were not
recognised as drafts. With no draft found in its own repo, tier-C inheritance fired
and `_gguf_drafter_in_repo` was asked to suggest a borrowed drafter. Its
"smallest gguf wins" rule then picked `BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf`
from `unsloth/Qwen3.6-27B-MTP-GGUF` — a BF16 split-shard tail, which is the smallest
*file* but not a loadable model. A drafter is purely a speed device (the main model
validates every token), so a full-precision shard tail is exactly the wrong pick.

Fix A stops the bad inherited suggestion at the source; Fix B makes the own-repo
dspark drafters visible so tier-C inheritance never needs to fire for this repo.

## file:line

- `llm_runner/runner/models.py` — `classify_gguf_entries`: `is_draft` gains
  `or "dspark" in low`; the drafts-convention docstring note names the dspark
  convention (exhibit `prism-ml/Ternary-Bonsai-27B-gguf`).
- `llm_runner/runner/models.py` — new module constant `_SHARD_RE` and a rewritten
  `_gguf_drafter_in_repo` that filters shards + full-precision before the
  `min(..., key=_entry_size)` pick; docstring restated to "smallest QUANTIZED
  single-file gguf".
- `tests/test_models.py` — `BONSAI_TREE` fixture (real filenames) +
  `test_classify_bonsai_dspark_drafters`, `test_drafter_skips_shards_prefers_quant_single`,
  `test_drafter_none_when_only_shards_and_mmproj`, `test_drafter_picks_dspark_over_f16`.

## How to verify

From `E:\Dev\Web\just-llm-runner`:

```
python -m pytest tests/test_models.py    # the targeted file — 11 passed
python -m pytest                          # full suite
```

On this Windows box the run showed `580 passed, 1 skipped, 1 failed` — the one
failure being `test_hardware.py::test_pci_gpus_linux_lspci_name_match`, a documented
pre-existing known-bad unrelated to this change. Two other tests are on the
documented-ignorable list (they did NOT fail this run but may on other machines):
`test_lifecycle.py::test_ensure_model_ready_loads_then_returns` (known-bad) and
`test_lifecycle.py::test_ensure_model_ready_raises_on_failed_load` (flaky — rerun
with `-n 0` once). Any OTHER failure is a real regression.

## What reverses it

Revert the two edits in `llm_runner/runner/models.py` (drop `or "dspark" in low`,
delete `_SHARD_RE`, and restore `_gguf_drafter_in_repo`'s original body that returns
`min(ggufs, key=_entry_size)` over all non-mmproj ggufs) and remove the four added
tests + the `BONSAI_TREE`/`_GB` additions in `tests/test_models.py`. No schema, no
data, no wire-format change — pure detection logic.

## Not built (logged as an idea)

Fix C — a tier-C drafter *loadability* guard: verify the engine can actually load a
suggested drafter's architecture before offering it (e.g. `dspark` is unknown to
mainline llama.cpp, so even a correctly-quantized dspark gguf may not load). This is
NOT built here; it is logged as an idea in `justwrite-app/docs/IDEAS.md`.
