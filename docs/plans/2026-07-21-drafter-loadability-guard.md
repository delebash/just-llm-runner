# Drafter loadability guard — don't offer/auto-enable an MTP draft our engine can't load (2026-07-21)

Builds the deferred **Fix C** (`justwrite-app/docs/IDEAS.md:107` "Tier-C drafter
loadability guard"), and closes the wider gap the user actually hit: the
**"Load model info from HF"** inspect path auto-pre-picks a repo's own draft and
auto-enables MTP **without checking the draft's architecture is loadable**.

## The bug (verified at file:line, 2026-07-21)

Exhibit repo `prism-ml/Ternary-Bonsai-27B-gguf` ships its own speculative-decode
drafter `Ternary-Bonsai-27B-dspark-Q4_1.gguf`. Its GGUF architecture is **`dspark`**,
which mainline llama.cpp (our pin, `config.py`) does not know — the loader aborts with
`unknown model architecture: 'dspark'` (`process.py:489`; the card claims the speedup on
the CUDA serving path only). Yet:

- `classify_gguf_entries` (`models.py:198`) detects the dspark file as a *draft*
  (name-keyed) and returns it in `drafts` with no loadability signal.
- The Add-model form pre-picks the smallest at-floor draft (`LuModelCatalog.vue:416-420`)
  and `onDraftPick` (`:442`) sets `mtp = true`. So on the user's box the form arms an
  MTP config (`spec_type=draft-mtp` + `--model-draft …dspark…`) that **cannot load**.
- Tier-C's borrowed-drafter picker `_gguf_drafter_in_repo` (`models.py:303`) would
  likewise *suggest* a dspark file if one appeared in a probed repo — the original Fix C.

Load time already fails fast on the unknown arch (`process.py:489,498`; lifecycle treats
it unfixable, no engine bounce). The gap is **pre-download**: the inspect/pre-pick
silently arming a config that can't load, with no explanation to the user.

## Decision — deny-set, filename-keyed (Approach A), header-read-ready

- **Deny-set, not allow-set.** We cannot durably enumerate every arch the engine *does*
  support (version-dependent, high-maintenance; an allow-list would false-block every
  future arch). We *can* record the ones proven to fail. Start: `("dspark",)`. New break
  → one line. (No existing supported-arch list in the runner — grep found only
  `_MTP_ARCH_FAMILIES` at `models.py:228`, an unrelated concept.)
- **Signal = filename token** (the publisher's `-dspark-` convention). Zero new network,
  keeps the PURE classifier pure, catches 100% of the known case. A GGUF header-arch read
  is the general upgrade if a mis-named unsupported drafter ever appears — the row carries
  the matched token so that upgrade is a drop-in. (User picked "your rec" over the
  header-read after the A/B fork was presented.)
- **One source of truth** (server-side, T3): a `drafts` row carries `loadable` +
  `unsupportedArch`; the pre-pick, the dropdown, and the tier-C picker all consume it.

## Tasks

### T1 — Server deny-set + helper (`llm_runner/runner/models.py`)

Near `_q4_or_better` (~`:155`): `_ENGINE_UNSUPPORTED_ARCHS = ("dspark",)` +
`_unsupported_arch_in_name(path) -> str` (the matched token, case-insensitive, or `""`).
Docstring states WHY deny-not-allow and the filename-vs-header choice + the `process.py:489`
load-time exhibit.

**Acceptance:** `_unsupported_arch_in_name("…-dspark-Q4_1.gguf") == "dspark"`; `""` for a
normal `MTP/m-Q4_0-MTP.gguf`.

### T2 — Stamp each draft row (`classify_gguf_entries`, `models.py:199-201`)

Each `drafts` row gains `"loadable": not bad, "unsupportedArch": bad` where
`bad = _unsupported_arch_in_name(path)`. Update the docstring drafts-row shape (`:179`).
Stays a PURE name/size classifier — no network added.

**Acceptance:** the two dspark rows in `BONSAI_TREE` → `loadable=False,
unsupportedArch="dspark"`; a normal MTP draft → `loadable=True, unsupportedArch=""`.

### T3 — Tier-C picker excludes the arch (`_gguf_drafter_in_repo`, `models.py:325-339`)

In the candidate loop, after the fp16 exclusion: `if _unsupported_arch_in_name(path):
continue  # engine can't load this arch`. Extend the docstring. **This is Fix C.**

**Acceptance:** a repo of only `…-dspark-Q4_1.gguf` + `…-F16.gguf` → `None` (dspark
excluded, F16 fp16-excluded); `…-dspark-Q4_1` beside a loadable `…-Q4_K_M` → the Q4_K_M.
(The existing `test_drafter_picks_dspark_over_f16` flips from "picks dspark" to "skips
dspark" — the intended semantic change; rewrite it.)

### T4 — Wire model (`llm_runner/llm/model_catalog_api.py`, `RepoDraftRow` `:131`)

Add `loadable: bool = True` and `unsupportedArch: str = ""` with the SAME warning comment
`q4OrBetter` carries — declared here or Pydantic's `extra="ignore"` strips them before the
browser sees them (the 2026-07-19 wire-strip incident).

**Acceptance:** a wire test (mirror `test_draft_floor_flag_survives_the_wire_model`) proves
both fields survive the `classify → ListFilesResponse` hop.

### T5 — Client pre-pick filters to loadable (`LuModelCatalog.vue:416-420`)

Filter `r.drafts` to `d.loadable !== false` BEFORE the 4-bit ranking; empty → no pre-pick,
so `mtp` stays off (no built-in MTP for the Bonsai). Comment: loadability is the floor
BELOW the 4-bit floor — the engine can't load the arch, so it is never a candidate.

### T6 — Dropdown annotates the unloadable option (`draftOptions`, `LuModelCatalog.vue:377-383`)

Suffix an unloadable option's label with ` — {unsupportedArch} not supported by your
engine`. (UiSelect has no per-option `disabled`; annotate rather than widen the kit. The
option stays selectable — a power user who forces it hits the existing load-time fail-fast.)

### T7 — Honest note when the repo's only drafts are unloadable (`LuModelCatalog.vue`)

`onlyUnsupportedDrafts` computed (`listing.drafts` non-empty AND every row `loadable ===
false`). A muted one-liner after the MTP checkbox (`.lu-mm-caps`, ~`:1088`): "This repo's
draft uses an architecture your engine can't load (dspark) — MTP left off." Prevents a
silent gap for a model whose card advertises MTP (JV design rule: show the resolved truth,
never an unexplained empty state).

### T8 — Docs (same change, T11)

- Close `justwrite-app/docs/IDEAS.md:107` (Fix C shipped → this doc).
- One user-facing line in `justwrite-app/docs/models.md` MTP material: a draft whose
  architecture the engine can't load (e.g. dspark) is left off, not silently armed.

## Tests (`tests/test_models.py`)

- Extend `test_classify_bonsai_dspark_drafters` — assert `loadable`/`unsupportedArch` on
  the dspark rows and a `loadable=True` control.
- Rewrite `test_drafter_picks_dspark_over_f16` → `test_drafter_skips_unsupported_dspark`
  (None) + a "dspark beside a loadable quant → the quant" case.
- New `test_loadable_flag_survives_the_wire_model` mirroring the q4OrBetter wire test.

## Verify

`python -m pytest tests/test_models.py` then full `python -m pytest` (runner) — the three
documented known-bad Windows failures only. `npm run build:vite` from `justwrite-app` (kit
compiles). ONE rules-checker on the plan, ONE on the final diff.

## What reverses it

Revert the `models.py` + `model_catalog_api.py` + `LuModelCatalog.vue` edits and the tests.
Additive, backward-compatible wire fields (default `True`/`""`); no schema, no on-disk, no
persisted-data change. An older client ignores `loadable` and pre-picks as before.
