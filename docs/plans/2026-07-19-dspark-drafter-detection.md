# dspark drafter detection + inherited-drafter shard/fp16 guard (2026-07-19)

> ✅ **CLOSED (docs campaign 2026-08-04)** — landed (models.py _ENGINE_UNSUPPORTED_ARCHS). History/evidence only; live work: `docs/dev/TASKS.md`.

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

---

# quant tokens are word-bounded — PQ2_0 is its own quant, not Q2_0 (2026-07-19, follow-up)

## What changed

Three edits to `llm_runner/runner/models.py`, plus tests.

1. `_QUANT_RE` gained a leading word-boundary lookbehind `(?<![A-Za-z0-9])` and its Q
   family widened from `I?Q` to `[IP]?Q`. So `Ternary-Bonsai-27B-PQ2_0.gguf` now yields
   the whole token **`PQ2_0`** (its own quant row) instead of the tail `Q2_0` merged
   into the real Q2_0 row. The widened `[IP]?Q` is required — without it the anchored
   regex would find NO token in a `PQ2_0` name and the file would vanish from the quant
   dropdown.
2. New shared helper `_quant_matches(quant, path)` — case-insensitive, boundary-aware
   (`(?<![a-z0-9_])` … `(?![a-z0-9_])`). It replaced the plain `q in path.lower()`
   substring match in ALL THREE snapshot/tree quant resolvers — `select_files`,
   `cached_gguf_path`, and `RunnerService._main_gguf` (the LIVE load-path resolver in
   `lifecycle.py`; a rules-checker caught this third site — a plain substring there would
   sort a co-cached `…-PQ2_0.gguf` ahead of `…-Q2_0.gguf` and load the WRONG weights). So
   quant "Q2_0" no longer selects/resolves/loads a `PQ2_0` or a `Q2_0_g64` file. mmproj
   name-fragment matching is untouched.
3. `classify_gguf_entries` kind classification: verified unchanged — a `PQ2_0` token
   classifies as kind "Q" (`removeprefix("UD-")` leaves "PQ2_0"; not IQ; contains Q).

## Why

`_QUANT_RE` was unanchored, so "PQ2_0" matched as its "Q2_0" tail and the PQ2_0 file
merged into the Q2_0 quant row. Separately, `select_files` and `cached_gguf_path` used a
plain `q in path.lower()` substring test, so quant "Q2_0" also matched `PQ2_0` files (and
would match a `Q2_0_g64`-named file) — the wrong file(s) selected/resolved. Real exhibit:
`prism-ml/Ternary-Bonsai-27B-gguf` ships both `-PQ2_0.gguf` and `-Q2_0.gguf`.

## file:line

- `llm_runner/runner/models.py:118-123` — `_QUANT_RE` comment + pattern
  `(?<![A-Za-z0-9])(?:UD-)?(?:[IP]?Q\d[A-Za-z0-9_]*|BF16|F16|F32)`.
- `llm_runner/runner/models.py:126-132` — new `_quant_matches` helper.
- `llm_runner/runner/models.py:100-103` — `select_files` uses `_quant_matches` (docstring
  at 88-96 updated).
- `llm_runner/runner/models.py` — `cached_gguf_path` uses `_quant_matches` in its
  `rglob("*.gguf")` filter.
- `llm_runner/runner/lifecycle.py:41` — import adds `_quant_matches`; `_main_gguf`
  (`~1182`) uses it instead of `quant.lower() in p.name.lower()`.
- `tests/test_models.py` — bonsai classify test extended (PQ2_0/Q2_0 two distinct rows) +
  `test_select_files_pq2_0_and_q2_0_dont_cross_match`,
  `test_select_files_q2_0_excludes_longer_g64_token`,
  `test_cached_gguf_path_word_bounded_quant`.
- `tests/test_lifecycle.py` — `test_main_gguf_resolves_quant_word_bounded` (Q2_0 wins
  over a co-cached PQ2_0 on the load path).

## How to verify

```
python -m pytest tests/test_models.py    # 16 passed
python -m pytest                          # 584 passed, 1 skipped, 2 failed (both on the ignore list)
```

The two full-suite failures are the documented known-bad/flaky pair:
`test_hardware.py::test_pci_gpus_linux_lspci_name_match` (known-bad on this box) and
`test_lifecycle.py::test_ensure_model_ready_raises_on_failed_load` (documented flaky — it
failed twice earlier today). Any OTHER failure is a real regression.

## What reverses it

Revert the `models.py` edits: restore `_QUANT_RE` to
`(?:UD-)?(?:I?Q\d[A-Za-z0-9_]*|BF16|F16|F32)`, delete `_quant_matches`, and put the plain
`q in …lower()` substring tests back in `select_files` + `cached_gguf_path`. In
`lifecycle.py` drop the `_quant_matches` import and restore `_main_gguf`'s substring
match. Remove the four added tests + the bonsai-test additions. No schema, no data, no
wire-format change — pure matching logic.

---

**Follow-on (2026-07-19):** the draft-pick rule this doc leaves at "smallest wins" gained
a 4-bit FLOOR, the VRAM fit learned to charge the draft, and Tune & measure gained draft
trials — `archive/2026-07-19-draft-fit-floor-and-lab-measure.md`.
