# Speed truth and the calibrated pick

**Date:** 2026-09-19 · **Status:** DESIGNED — items 1–2 free-standing, spike gates items 3–4
**Executor:** Opus, against THIS document (user: *"write up so opus doesnt have to
think much"*). The design work is done; do not re-derive it.
**Origin:** the JV session of 2026-09-19 ("why does our default model show a fit
of slow?"). Every file:line below was verified that day — code reads plus the
running app (port 17494) plus the box's live DB. When a line number has
drifted, the anchor is the quoted identifier or comment, never the number.
**This document is self-contained** — the executor needs no session
transcript: the knife-edge reproduction is Appendix A, the box's evidence is
Appendix B, and every reuse point below is named to its real symbol.

---

## §0 What this is

Four user-visible outcomes, in ship order:

1. **After Quick setup, the chosen model's speed is measured, not guessed.**
   The chip reads "Measured on this PC: 11.3 tok/s" — a real number that
   includes the MTP draft speed-up the physics prediction deliberately omits.
2. **A prediction that lands within a hair of a band boundary shows the
   number, not a possibly-wrong word.** "Fits · ~7.9 tok/s" instead of a
   "slow"/"fine" coin-flip.
3. **On hardware with no curated class preset, Quick setup offers a clearly
   explained, skippable one-minute speed check**: a small test model
   (~0.8 GB, downloaded once from OUR GitHub release, never from Hugging
   Face) runs briefly two ways and measures how fast the box really streams
   model bytes — the number that decides whether big models crawl.
4. **On those same uncurated boxes, the recommended-model pick refuses models
   predicted below reading speed**, with a grace margin so a hair-miss never
   swaps a flagship for a far dumber model. Curated boxes: pick unchanged.

**Why a better guess cannot fix this** (the knife edge, measured): the
flagship on the author's box predicts 7.9 tok/s against a fine-line of 8.0.
The box's host-effective bandwidth window across independent derivations is
6.9–10.6 GB/s — it straddles the line, so any single-number probe lands on
either side run to run (RAM probe readings: 19.01 on 08-13 → "fine"; 18.59 on
08-21 and 18.37 on 09-19 → "slow"; "fine" needs ≥ 18.67). Hence: measure the
model we chose (item 1), be honest at boundaries (item 2), and measure the
machine before choosing on unknown hardware (items 3–4).

---

## §1 Decision record (verbatim, 2026-09-19)

- *"i think a 1 minute calibration test is fine if it gives us better resutls"*
  — and it must *"work on any platform"*.
- *"maybe in quick setup we auto run the qucik tune and measure"* — resolved
  into item 1 (the 15-second measure IS the auto piece; the 10-minute sweep
  stays explicit-only — the 2026-07-07 ruling *"Apply never auto-starts it"*
  in `QuickSetup.vue` STANDS and is untouched by this program).
- *"3 the user needs to be able to opt out of this setup we need to preset it
  to them clearly what this is why it is recommeneded and allow them to skip,
  write of the plan doc i will have opus execute the code and test, write up
  so opus doesnt have to think much, i take your recs"*
- *"download the test guff to the github repo, the setup can then download it
  from there on first run that way we dont have to worry if hugging face
  removes the test guff"* — mechanism corrected in-session: GitHub rejects
  >100 MB files in a repo; the vehicle is a **GitHub Release asset** (2 GB
  cap, Range-supported, the same mechanism the kit already uses for llama.cpp
  builds). `delebash/just-llm-runner` verified **PUBLIC** 2026-09-19
  (`gh repo view --json visibility`), so release downloads need no auth.

**The rulings, as taken ("i take your recs"):**

| # | Ruling |
|---|---|
| 1 | Pick floor = the existing `band_fine_toks` (8.0, already a seeded, GUI-editable setting) × (1 − `speed_floor_grace`); grace seeded **0.2** → threshold 6.4. A model with no prediction passes (unknown never becomes a veto). |
| 2 | **No MTP uplift constant in the pick.** The grace margin covers it; the fit plan's §13.7 cut (acceptance spread 0.47–0.91) stands. |
| 3 | Auto-measure rows carry source **"measure"**, shown in the measurement-history panel. |
| 4 | The calibration is an **opt-in card**: plain copy on what it is and why, Run / Skip buttons, cancellable mid-run. |
| 5 | The test GGUF ships from a **GitHub Release** on `delebash/just-llm-runner` (tag `calib-v1`), sha256-pinned, Apache-2.0 text + attribution in the release notes. HF appears only in the spike. |

**Design decision inside ruling 4 (flag to the user if ever revisited):** the
card is offered **only when no class tune matched this box** — that is
exactly when calibration can change the pick (`pickByClassConfig`
short-circuits everything on curated boxes, `modelPick.js:164`). Known
hardware sees Quick setup exactly as today.

---

## §2 Ground truth (all verified 2026-09-19)

**How today's band is made** — `api.py` `_speed()` (`runner/api.py:322-350`):
per-model byte split (`fit.speed_bytes_split`) priced by two effective
bandwidths from `resolve_effective_bw` (`bandwidth.py:294`, **sole caller
`api.py:297`**), then `fit.speed_band(meas or tok, …)` — a measured row
outranks the prediction at display (`measured_by_id`, `api.py:308-313`, **no
source filter**, any row with `tokens_per_sec > 0` on this machine+backend).

**The ladder** (`resolve_effective_bw`): measurement-derived
(`derive_device_bw_gbps` :245 / `derive_host_bw_gbps` :266) → device
registers/class seed × `bw_eff_device 0.6` → RAM memcpy probe ×
`bw_eff_host_probe 0.40` → class seed × `bw_eff_host 0.15`. The memcpy probe
runs ONCE per box and persists (`lifecycle.py:674 host_probe_bw_gbps`;
pseudo-row `__machine_ram_bw__`, `bandwidth.py:48`) — so predictions are
stable within one install; the knife edge flips across installs/boxes.

**Derivation hygiene** (`_qualifying`, `bandwidth.py:221`): rows qualify only
with this machine_key + backend, tok/s > 0, **recorded switches (flagless
never qualifies)**, no spec/draft flags, **MTP models excluded outright**,
known ctx. Consequence used by item 1: an auto-measure row with empty
switches is derivation-inert — display-only, by design.
`derive_device_bw_gbps` wants full-offload DENSE rows — so on boxes whose
pick is a dense fully-resident model, item 1's row feeds device derivation
for free.

**Recording doors:** UI `recordMeasurement` (`ui/src/measurements.js:29` →
`POST /v1/ai/model-measurements`; server accepts arbitrary `source`,
`model_measurements_api.py:106`; store stamps backend itself,
`stores.py:1345-1360`). History list filter is **client-side**:
`listMeasurements` keeps `source ∈ {tune, autotune}` (`measurements.js:21-23`)
— the panel itself already renders any non-autotune row as "measured"
(`LuMeasureHistory.vue:111-113`).

**Measure door:** `lifecycle.measure()` (`lifecycle.py:1542`) probes the
RESIDENT model via `_default_measure_probe` (`lifecycle.py:146` — works
against any llama-server URL). It requires the model resident and returns
`{ok: False, error: "no model running — load one first"}` otherwise, with a
router-is-the-authority reconciliation for a stale internal ledger
(`lifecycle.py:1552-1560`). Exposed as `POST /v1/llm-runner/measure`
(`api.py:582`); the Tune modal's usage shows the response fields consumed:
`res.tokensPerSec`, `res.vramTotalMb` (`TuneMeasureModal.vue:379-380`).
**⚠ `_default_measure_probe`'s decode_ms is WALL CLOCK** (`t0 =
time.monotonic()` around the POST, `lifecycle.py:155-157`) — good enough for
a resident 13-GB model where decode dominates, WRONG for calibration (item 3
brings its own probe). The response DOES carry llama.cpp's own `timings`
object on the pinned build — `lifecycle.py:161` already reads
`payload.get("timings")` for `draft_n`/`draft_n_accepted`, which is live (the
MTP acceptance signal works), so `timings.predicted_n` / `predicted_ms` are
available.

**Binary + dirs:** the llama-server exe lifecycle spawns resolves through
`llm_runner/runner/binary.py` — `acquired_server_exe` (the path),
`binary_dir` (the runner-managed builds root), `select_binary`,
`acquire_binary` (imported at `lifecycle.py:27-36`). GGUF header reading:
`class GgufMeta` (`llm_runner/runner/gguf.py:55`), `expert_byte_share()`
(`gguf.py:120`); the identity path shows the fact-building usage
(`identity.py:97`).

**Quick setup internals** (`ui/src/views/QuickSetup.vue`): step machine
`const step = ref("detect")` — values `detect | confirm | apply | done`
plus `configured` (:57, :437). Catalog-join accessors come from
`useCatalogMeta()` (:158 — supplies `classTuneRefs`, `myClassKey`,
`qualityById`, …). The pick (:262-276 `bestFittingId`) delegates to
`recommendedModelId` with `runnable: FIT_GPU` ("chat picks never land on a
CPU-spill model (user decision)") — and its comment pins that the wizard and
the catalog's "Recommended for this PC" badge call the SAME function, so any
pick change must ride that shared rule, never fork. Copy doors: card BODY
text goes in `quickSetupCopy` (`quickSetupCopy.js:14`, host-overridable via
`configureQuickSetupCopy:33`); BUTTON labels are canon and live in
`familyLabels.quickSetup` — "labels translate canon, copy carries voice;
neither may smuggle the other" (the file's own contract, :1-9).

**UI payload-root exposure gap:** `useRunnerModels.js` exposes only `models`
and `vramMb` (:51, :295) from the /models root — items 2/4 must also export
the new root fields (`bandFineToks`, `speedFloorGrace`) as computeds there;
components never re-fetch the payload themselves.

**The pick chain:** `recommendedModelId` (`modelPick.js:244`) =
`pickByClassConfig` (:164, curated short-circuit, `ranHere` evidence beats
the estimate veto) else `pickBestModel` (:114) with `isFastEnough` (:98,
fit-shape only — **speed band is display-only today**). Consumers:
`LuModelCatalog.vue:471`, `QuickSetup.vue:266`. Chip: `speedBandLabel`
(`modelPick.js:50`) — already renders predictions as `~fine` and measured as
`fast` (pinned by JW `slotOptions.test.js:48-50`); the MTP hover line "May
run faster with speculative decoding (MTP)" shows only when
`!m.measuredTokS` (`LuModelCatalog.vue:310`).

**/models root payload today** (live curl 2026-09-19): `vramMb, ramMb,
safetyMarginMb, catalogWired` — items 2/4 extend this root.

**Pseudo-row precedents:** `__machine_ram_bw__` (GB/s stored in
`tokens_per_sec`, written `install.py:531` zone) and `__overhead__` with a
**build-stamped label** `f"physics-overhead {build}"`
(`lifecycle.py:2508-2510`) so an engine pin bump recalibrates by label
non-match. The keep-K prune covers `'load'` + `__overhead__` rows only
(`stores.py:1433`) — new `"measure"` rows are append-only, user-cleared
(accepted: one per Quick setup run).

**Live seeds on the box:** `band_fast_toks 20 / band_fine_toks 8 /
band_slow_toks 2 · bw_eff_device 0.6 · bw_eff_host 0.15 ·
bw_eff_host_probe 0.40` (runner_setting, built_in=1).

---

## §3 NOT — rejected, with reasons (stays rejected)

- **NVML / rocm-smi register probing** — vendor-bound, dies on
  macOS/ROCm/iGPU; the register query already failed on the author's driver.
- **Synthetic random-weight GGUF generated locally** — zero download and
  air-gap-friendly, but needs a GGUF writer coupled to llama.cpp's arch
  expectations: a new maintenance surface with its own drift failure mode.
- **A hidden catalog row for the test model** — leaks into every picker,
  chip, and /models consumer across three apps; the pseudo-row convention
  exists for exactly this.
- **An MTP uplift constant in the pick** — fit plan §13.7 cut it; measured
  acceptance 0.47–0.91 makes any constant a fiction.
- **Stateful band hysteresis** — predictions are stable within a DB lifetime
  (the probe persists); the flip is across installs. Dead-zone display is
  stateless and more honest.
- **Auto-running the sweep in Apply** — the 2026-07-07 ruling stands; each
  trial is a full unload→reload→measure, 10+ minutes total.
- **Hosting the GGUF in-tree** (100 MB repo limit) **or via Git LFS**
  (bandwidth quota) — Release asset instead.
- **HF as the shipped download source** — third-party quantizer repos get
  deleted and re-uploaded in place (user ruling 2026-09-19).

---

## §4 Item 1 — measure the model Apply just loaded

**IS:** the moment Quick setup finishes loading the chosen chat model, a
~15-second background measurement runs once and persists; the catalog chip
then shows the measured number (with MTP active — the number users actually
get) instead of "~slow"/"~fine".

**Mechanism** (all UI-side; zero server change):
- `QuickSetup.vue` — in the Apply completion path (after
  `step.value = "done"`), fire-and-forget:
  `POST /v1/llm-runner/measure` (primary = the just-loaded model), then on
  `res.ok`: `recordMeasurement(pick.value.default, res.tokensPerSec,
  { vramTotalMb: res.vramTotalMb || 0, switches: {}, source: "measure",
  label: "first-run measure" })` (`measurements.js:29`). Never `await` it
  before showing "done"; `.catch(() => {})` — a failed measure must never
  fail setup. Do not run when nothing was loaded (the no-fitting-model path).
  Call it immediately after the chat load completed — `measure()` refuses
  when nothing is resident (§2's measure-door receipt), and right after
  Apply the just-loaded model IS the primary.
- Empty `switches` keeps the row out of bandwidth derivation
  (`_qualifying` drops flagless rows — §2); the chip still picks it up
  because `measured_by_id` has no source filter.
- `measurements.js` `listMeasurements`: add `"measure"` to the source filter
  so the row appears in history (`LuMeasureHistory.vue` already labels
  non-autotune rows "measured").
- Idempotence: re-running Quick setup adds another row — append-only history
  is the store's design; acceptable.

**Out of scope:** measuring on every later load (warm-boot would eat it at
startup and queue ahead of the user's first request). Tune & measure stays
the manual door.

**Tests:** JW `slotOptions.test.js` already pins measured-drops-the-tilde;
add none server-side. Manual acceptance: run Quick setup on the dev box →
history shows the "measure" row → chip reads "Measured on this PC: N tok/s"
and the MTP hover line is gone.

---

## §5 Item 2 — dead-zone honesty on the chip

**IS:** a *predicted* band within ±10 % of a boundary shows
"Fits · ~7.9 tok/s" instead of a word. Measured numbers keep their word
(a real measurement near a line is honestly that speed).

**Mechanism:**
- Server (`api.py` `_speed()`, the `(band, pred, meas)` return at
  `api.py:346-350`): when `meas` is None and, for ANY of the three
  thresholds T ∈ {fast, fine, slow}, `|pred − T| / T ≤ band_deadzone_frac`,
  return band `""` (predTokS still ships). New seeded runner_setting
  `band_deadzone_frac = 0.10`: seed it beside the `band_*_toks` rows, add to
  the `set_setting` whitelist (`runner_config_api.py:115`), add a knobs-GUI
  field in the Loaded-models group beside the three band fields, Save
  round-trips it (the group's existing pattern).
- UI (`modelPick.js` `speedBandLabel:50`): when `!m.speedBand && m.predTokS > 0`
  → return `` `~${m.predTokS} tok/s` ``. Rows without header facts have
  `predTokS` null → chip stays plain-feasibility, unchanged.

**Tests:** kit pytest — dead-zone pins (pred 7.9, fine 8, frac 0.10 → band
""; pred 7.1 → "slow"; measured 7.9 → "slow" WITH measuredTokS). JW
`slotOptions.test.js` — `{speedBand:"", predTokS:7.9}` → `"~7.9 tok/s"`.

---

## §6 Item 3 — the one-minute speed check (SPIKE-GATED, §8)

**IS:** on a box with **no matching class tune**, Quick setup shows a card
between hardware detect and the model pick. Production copy (app name via
`quickSetupCopy`, `quickSetupCopy.js:14` / `configureQuickSetupCopy:33`;
size token from the seeded `calib_model_size_mb`):

> **Check this PC's real AI speed?**
> No preset matches this hardware, so the recommendation below would come
> from estimates. A one-minute check downloads a small test model (0.8 GB,
> one time), runs it briefly two ways, and measures how fast this PC really
> moves model data — the number that decides which models run at reading
> speed. Skip it and {app} estimates from hardware specs instead.
>
> **[Run the 1-minute check]**  [Skip — use estimates]

Never shown when a class tune matched (§1 design decision) and not offered on
one-pool boxes with a fast device (macOS/unified — the two-pool problem this
measures does not exist there; `mem_arch`/`one_pool`, `api.py:283-284`).
CPU-only boxes ARE offered it (single pass, see below). Closing the wizard
mid-run cancel-confirms, the `attemptClose` optimize precedent.

**Curated detection + step wiring** (exact): curated ⇔
`pickByClassConfig(classTuneRefs.value, myClassKey.value, fitting.value,
{ fitSet: FIT_GPU, qualityOf, isEmbed, isUseLimited: useLimitedOf })`
returns a non-empty id — the same accessors `bestFittingId()` already binds
(`QuickSetup.vue:262-276`; refs from `useCatalogMeta()`, :158). Step machine:
detect-completion goes to a NEW step value `"calibrate"` when
`!curated && !onePool && deviceFast` (else `"confirm"` as today); Skip →
`"confirm"`; job done → refetch `/models` (predictions now calibrated),
recompute the pick, → `"confirm"`. The `"configured"` re-entry path (:437)
is untouched. Card body copy = new `quickSetupCopy` keys; the two button
labels = `familyLabels.quickSetup` (the copy/labels contract, §2).

**Why the delta yields HOST bandwidth only — do not "improve" this:** per
token, pass A costs `t_A = overhead + dev_bytes/dev_BW`; on a ~1 GB model
the overhead term (kernel launches, attention, sampling) dominates the
~2 ms memory term, so `t_A` alone cannot give `dev_BW` — that is WHY the
absolute tok/s of a tiny model must never be read as bandwidth. Pass B costs
`t_B = overhead + non_expert/dev_BW + expert_bytes/host_BW`, so
`t_B − t_A ≈ expert_bytes/host_BW`: the overhead AND the device term cancel,
leaving the one number we need. Device bandwidth arrives later, free, from
the first full-offload DENSE model measured on the box
(`derive_device_bw_gbps`, §2). Residual bias: pass B's extra CPU scheduling
makes the delta slightly overstate expert cost → host_BW slightly
understated → err-slow, the fit plan's own direction (§8.17).

**Hosting (ruling 5):** release tag `calib-v1` on `delebash/just-llm-runner`
(PUBLIC), asset = the exact spike-verified GGUF, release notes = Apache-2.0
text + attribution (IBM's model, the quantizer's conversion). Seeded
runner_settings: `calib_model_url`, `calib_model_sha256`,
`calib_model_size_mb` (nothing hardcoded; whitelist + settings surface like
`pinned_build`). sha256 verified after download; mismatch = failed check →
fall back, never block setup.

**Mechanism** (new `llm_runner/runner/calibrate.py`, job shape mirrored from
`autotune.py`'s single-background-job + status/cancel pattern):
1. **Download** `calib_model_url` → a `calib/` sibling under the runner's
   own root (`binary_dir()`'s parent, `runner/binary.py` — deliberately NOT
   the HF model cache: the shared-cache choice happens inside Quick setup
   itself, and the calibration must not depend on that ordering; the runner
   root exists as soon as the engine does) via `stream_download`
   (`download.py:358` — progress, cancel, resume, Range segments;
   `download_kwargs:130`). Verify sha256 = `calib_model_sha256`; skip the
   download when the file already exists with the right sha.
2. **Facts off the file**: `GgufMeta` (`runner/gguf.py:55`;
   `expert_byte_share()` :120 — usage pattern at `identity.py:97`), then
   `(non_expert_mb, active_expert_mb) = fit.active_bytes_per_pass_mb(…)` —
   the same function the fit uses; no second byte model.
3. **Pass A** — spawn a bare llama-server child on the file:
   `acquired_server_exe` (`runner/binary.py`, the exact exe lifecycle
   spawns), `find_free_port` (`process.py:68`), literal argv
   `-m <file> --host 127.0.0.1 --port P -ngl 99 -c 2048` (compose it
   literally — do NOT route through `compose_flags`, which is catalog/knob
   driven); health via `_default_health` (`process.py:678`). Probe with a
   NEW `_calib_probe(url, max_tokens=160)` in calibrate.py: POST
   `/v1/chat/completions` `{messages, max_tokens, stream: false}` and read
   the response `timings` → per-token ms = `predicted_ms / predicted_n`.
   **Never `_default_measure_probe`'s ms — that is wall clock** (§2's ⚠;
   AV scans of a fresh file poison wall time; `timings` is proven present
   on the pinned build, `lifecycle.py:161`). 3 requests, median → `tA`.
   Kill the child by PID.
4. **Pass B** — same + `--n-cpu-moe 999`. Median → `tB`.
5. **Derive:** `host_gbps = active_expert_mb / (tB − tA)` (MB/ms ≡ GB/s).
   Guards: `(tB − tA) ≥ 0.2 × tB` else the run is noise → discard; 3-run
   spread ≤ ±15 % else fail-soft (no row, card reports "couldn't get a stable
   reading — using estimates"). CPU-only box: single pass,
   `host_gbps = (non_expert_mb + active_expert_mb + kv) / t` — the memory
   term dominates without a fast device.
6. **Record** the pseudo-row: `ModelMeasurementStore.record(model_id=
   "__machine_moe_bw__", source="probe", label=f"moe-stream probe {build}",
   tokens_per_sec=host_gbps, kind="llm")` — constant beside
   `RAM_PROBE_MODEL_ID` (`bandwidth.py:48`), build-stamped label per the
   `__overhead__` convention (engine upgrade → recalibration by label
   non-match). Clear-history deletes it → the card re-offers (self-heal).
7. **Ladder:** `resolve_effective_bw` (`bandwidth.py:294`) gains
   `moe_probe_gbps`: `host = derive_host_bw_gbps(…) or moe_probe_gbps or
   probe_gbps × eff_host_probe or class_ram_bw × eff_host`. The service reads
   the pseudo-row the way `host_probe_bw_gbps` does (`lifecycle.py:674`) but
   **never auto-kicks** — Quick-setup-driven only. Sole caller `api.py:297`
   passes it through.
8. **API:** `POST /v1/llm-runner/calibrate` (start) · `GET` (status: `{status,
   phase: download|pass-a|pass-b, progress, gbps?, error}`) · `POST
   …/calibrate/cancel` — the auto-tune endpoint/polling shape.
9. **UI:** the card drives the job with the Apply-style task rows
   (`chatTask`/`engineTask` pattern) — "downloading test model… 412 of
   822 MB" → "measuring (GPU pass)…" → "measuring (streaming pass)…". Done →
   refetch `/models` (predictions now calibrated) and recompute the pick
   BEFORE the confirm screen. Fail/skip → today's flow exactly. Needs the
   engine installed first: on Run, install-if-needed with its own bar (the
   Apply engine path, reused), the model download running in parallel.

**Tests:** pytest — derivation math pin (synthetic tA/tB/facts → expected
GB/s; the delta guard; the spread guard); ladder-rung order pin (moe row
beats memcpy probe, loses to real-model-derived); label build-stamp pin.
UI covered by the JV/JW gates + a manual card walk.

---

## §7 Item 4 — the floor in the fallback pick

**IS:** on uncurated boxes, `pickBestModel` refuses models predicted below
`band_fine_toks × (1 − speed_floor_grace)` (8.0 × 0.8 = 6.4). The flagship
at 7.9 passes with room; a 3.3 tok/s dense-partial does not. Curated boxes
never reach this code path.

**Why the grace margin is not optional — the measured trap on the author's
box** (live /models, Appendix B): a HARD floor at 8.0 would judge
`gemma-4-26b-a4b-qat` (pred 7.9, quality_rank 5 — the flagship) as too slow
and hand the recommendation to `gemma-4-e4b-qat` (pred 25.9, quality_rank
23) — a catastrophic quality drop bought by a 0.1 tok/s rounding error.
With grace 0.2 the threshold is 6.4 and the flagship stays picked. Any
future tuning of the grace must re-check this exact case.

**Mechanism:**
- `api.py` /models root gains `bandFineToks` + `speedFloorGrace` (beside
  `vramMb/ramMb/safetyMarginMb/catalogWired`). New seeded runner_setting
  `speed_floor_grace = 0.2` + `set_setting` whitelist
  (`runner_config_api.py:115`) + knobs-GUI field with Save round-trip.
- `useRunnerModels.js` exports both as computeds (it exposes only `models` +
  `vramMb` today, :51/:295 — §2's exposure gap).
- `modelPick.js` `pickBestModel:114` — the fastEnough filter additionally
  requires: `s == null || s >= opts.speedFloor` where
  `s = m.measuredTokS ?? m.predTokS`. Null passes (unknown never vetoes —
  the fit plan's §8.17 spirit). `recommendedModelId:244` gains the
  pass-through `speedFloor` opt and forwards it to `pickBestModel` — the
  wizard (`QuickSetup.vue:266`) and the catalog badge
  (`LuModelCatalog.vue:471`) bind it from the payload root, so both consume
  the ONE rule and can never disagree (the `bestFittingId` comment's own
  invariant). `pickByClassConfig` untouched. The §10 fallback (nothing fast
  enough → best runnable) keeps the pick non-empty.

**Tests:** `scripts/verify-model-pick.mjs` gains: pred 7.9, floor 6.4 → stays
picked · pred 5.0 → next quality above floor wins · everything below floor →
fallback still returns non-empty · predTokS null passes · measured outranks
predicted in the comparison. JW `slotOptions.test.js` untouched (no veto in
the OPTIONS — §8.23 stands; the floor lives in the pick only).

---

## §8 Item 0 — the spike (BLOCKS items 3–4; items 1–2 do not wait)

Scratchpad, dev box, ~1 hour:
1. **Web-verify the candidate.** 2026-09-19 search receipts (candidates
   found, none yet verified beyond title/size/license):
   `bartowski/granite-3.0-1b-a400m-instruct-GGUF` (Q4_K_M available) ·
   `itlwas/granite-3.1-1b-a400m-base-Q4_K_M-GGUF` (822 MB, Apache-2.0) ·
   `QuantFactory/granite-3.0-1b-a400m-instruct-GGUF` (describes the model as
   sparse MoE) · `ibm-granite/granite-4.0-1b-GGUF` (OFFICIAL org — but
   verify granite-4.0-1b is actually MoE before preferring it; if dense it
   is useless here). **Prefer an INSTRUCT variant**: the probe drives
   `/v1/chat/completions`, which needs a chat template — a BASE model may
   lack one and derail the probe. Re-verify: Apache-2.0 · ungated (the
   no-auth law) · the granitemoe arch runs on the PINNED llama.cpp build.
2. **Download once** from HF to the scratchpad.
3. **Facts check:** `GgufMeta` on the file → expert fields present;
   `fit.active_bytes_per_pass_mb` returns a non-zero expert leg.
4. **Both passes by hand** (§6 steps 3–5 flags; 3 × 160 tokens; the timings
   math, never wall clock).
5. **Acceptance:** derived host GB/s ∈ **[5, 13]** (the box's known measured
   window 6.9–10.6 with margin) AND 3-run spread ≤ ±15 %.
   **PASS →** the user uploads the exact verified file:
   `gh release create calib-v1 <file> --repo delebash/just-llm-runner
   --title "Calibration model v1" --notes "<Apache-2.0 text + attribution>"`,
   then record the asset URL + sha256 here and in the seeds.
   **FAIL →** items 3–4 stop and the failure is reported with numbers;
   items 1–2 unaffected.

---

## §9 Blast radius (pasted greps, 2026-09-19)

**A — chip + pick consumers** (`grep -rn "recordMeasurement|speedBandLabel|
pickBestModel|recommendedModelId|isFastEnough|buildSlotOptions"` over kit ui,
JV src, JW src):
```
modelPick.js:50 speedBandLabel · :79 buildSlotOptions (:84 uses band) · :98 isFastEnough
modelPick.js:114 pickBestModel (:119 fastEnough) · :244 recommendedModelId (:249 → pickBestModel)
LuModelCatalog.vue:30 imports · :471 recommendedId · :900 buildSlotOptions · :1347 chip render
TuneMeasureModal.vue:36/:379 recordMeasurement · measurements.js:29 def
QuickSetup.vue:30 imports · :266 recommendedModelId(fitting…)
justwrite-app src/components/slotOptions.test.js:11-54 — pins "~fine"(pred) vs "fast"(measured), veto-out §8.23
JV src: no direct imports (consumes the kit components)
```
**B — bandwidth ladder:** `resolve_effective_bw` def `bandwidth.py:294`;
**sole caller `api.py:297`**. Pseudo-rows: `RAM_PROBE_MODEL_ID`
`bandwidth.py:48`; `__overhead__` writer `lifecycle.py:2508-2510` (label
`physics-overhead {build}`); prune scope `stores.py:1433` (`'load'` +
`__overhead__` only).
**C — measurement writers/readers:** POST door `model_measurements_api.py:98-113`
(source free-form, comment :39 says `tune | autotune | probe`); store
`stores.py:1345-1360` (stamps backend itself); history filter
`measurements.js:21-23` (`tune|autotune` — gains `measure`); panel tag
`LuMeasureHistory.vue:111-113` (non-autotune renders "measured" already);
band display `api.py:308-313 measured_by_id` (no source filter — item 1's row
is picked up with zero changes).
**D — exceptions already on the path:** `_qualifying` `bandwidth.py:221`
excludes flagless / spec-flagged / MTP / unknown-ctx rows (item 1's row is
derivation-inert by the flagless rule); JW `slotOptions.test.js:48-50` pins
the tilde convention item 2 extends; the 2026-07-07 explicit-only sweep
ruling (QuickSetup.vue optimize block comment) is untouched.
**E — producers/deletions:** nothing is deleted or overwritten. Behavior
changes to existing outputs, each with its consumers listed above: band `""`
in the dead zone (consumers: `speedBandLabel` sites, row A) and the floor in
`pickBestModel` (consumers: `LuModelCatalog.vue:471`, `QuickSetup.vue:266`
via `recommendedModelId` — curated path short-circuits before it).

---

## §10 Execution order · gates · docs · data

**Order:** Item 1 → Item 2 → Spike (§8) → Item 3 → Item 4. Each item its own
go in the executing session.
**Gates, every item:** kit `ruff check .` + pytest · biome (kit ui) · JW
`npm run test:fast` + vitest + build · JV `npm run build:vite` + smoke with
`--data-dir src-tauri/target/debug/data` (the kit is consumed as source —
kit edits gate all three suites). Pick changes additionally:
`node scripts/verify-model-pick.mjs`.
**Docs, same change as the code (the docs law):** JW `docs/ai-providers.md`
(chip + Quick setup sections) · JV `docs/ai-features.md` +
`docs/quick-setup.md` · kit `docs/dev/serving-design.md` (the new ladder
rung, one paragraph). The release notes carry the model's license.
**Data:** no migrations — new seeded settings + append-only measurement rows
only (the no-migrations rule holds).

---

## §11 Execution record (2026-09-19, same day — go: *"commit push and go code"*)

### 11.1 Item 1 — BUILT
- `ui/src/views/QuickSetup.vue`: `measureAfterApply(modelId)`, fired
  un-awaited from the end of `finishApply()`. **One deviation from §4, a
  hardening:** the measure call names the model —
  `POST /v1/llm-runner/measure?model_id=<id>` (the endpoint's own query param,
  `api.py:582-589`) — because `measure()` otherwise probes "the most recently
  loaded", and the row must be recorded against the model actually probed.
  Then `recordMeasurement(…, {switches: {}, source: "measure", label:
  "first-run measure"})` and `refresh()` from `useRunnerModels.js` so the chip
  flips without waiting for the next poll.
- `ui/src/measurements.js`: `SPEED_SOURCES = {tune, autotune, measure}` —
  the history filter's one door.
- Verified NOT affected (receipts): `derive_tune_source`
  (`model_tunes_api.py:86-97`) only reads measurements to label an
  already-saved tune; `modelHasTunes` (`modelApply.js:90`) reads the tune
  store, not measurements — a `measure` row can never make a model look tuned.

### 11.2 Item 2 — BUILT
- Setting chain (the `bw_eff_host_probe` template, every link):
  `runner/config.py` `DEFAULT_BAND_DEADZONE_FRAC = 0.10` · `runner/schema.py`
  `band_deadzone_frac` · `llm/seed.py` row + import · `llm/stores.py` reset
  list + `build_runner_config` loader + `EngineConfig` build + both imports ·
  `llm/runner_config_api.py` GET field, PUT field, setter clamped to
  [0, 0.5], protocol comment.
- Rule: `fit.in_band_deadzone()` (pure, beside `speed_band`) called in
  `api.py` `_speed()` only when `meas` is None.
- UI: `modelPick.js` `speedBandLabel` — no band + prediction →
  `~N tok/s`; `LuRunnerEngine.vue` — "Show the number within (%)" field in
  the Speed bands group (stored as a fraction, edited as a percent).
- Tests: `test_fit.py::test_band_deadzone_brackets_every_threshold`;
  `test_runner_models.py::test_prediction_in_the_dead_zone_ships_no_word` +
  `::test_a_measured_speed_near_a_line_keeps_its_word`; the two pre-existing
  band-MAPPING pins now run with the dead zone off (`_NO_DEADZONE` — their
  ~8.7 fixture sits inside ±10 % of 8.0, an intended change); JW
  `slotOptions.test.js` gains the "~7.9 tok/s" case.
- **Docs home correction:** the chip + Quick Setup prose lives in JW
  `docs/models.md` (not `ai-providers.md`, as §10 guessed) — written there.
  JV `docs/ai-features.md` + `docs/quick-setup.md`, kit
  `docs/dev/serving-design.md` (fit section) also updated.

### 11.3 Gates (items 1–2)
kit ruff clean · kit pytest **914 passed / 10 skipped / 0 failed** · biome
clean on the 4 changed kit UI files (run from `ui/`, where `biome.json`
lives) · JW `test:fast`: vitest **579/579**, vite build, JW server pytest
**128 passed** · JV `test:unit` **67/67** · JV `build:vite` · JV smoke with
`--data-dir src-tauri/target/debug/data` **all views, zero JS errors**.
**Rendered on the real data dir** (headless UI, 8741): flagship chip reads
**"Fits · ~7.9 tok/s"** on one line, its hover "Estimated speed: ~7.9 tok/s";
General model picker "Recommended · Fits · ~7.9 tok/s"; 12B "Tight · ~slow"
(3.3, far from a line) and E4B "Fits · ~fast" (25.9) keep their words; the
Speed bands group shows 20 · 8 · 2 · **10**. Not exercised: Item 1 end to end
through a real Quick-setup Apply (the user's walk — §4's manual acceptance).

### 11.4 The spike (§8) — RAN; FAILED its written acceptance; the premise was wrong

**Candidate verified (HF API, no auth, 2026-09-19):**
`bartowski/granite-3.1-1b-a400m-instruct-GGUF`, file
`granite-3.1-1b-a400m-instruct-Q4_K_M.gguf`, **821,847,360 bytes**, sha256
**`3a2ec1c2a78cb29d901e29bbf5162dcd03381e13803d2cbdcff838d4d08142eb`**
(downloaded; local sha256 matches the LFS oid). Repo card license
apache-2.0, `gated: False`; upstream `ibm-granite/granite-3.1-1b-a400m-instruct`
apache-2.0, ungated, `GraniteMoeForCausalLM` / `granitemoe`. No official
ibm-granite GGUF exists for this line (HF search `1b-a400m` + `gguf`, 40
repos). `ibm-granite/granite-4.0-1b` REJECTED — its card: "decoder-only
dense transformer". Q4_K_M chosen: same Q4_K kernel family as the flagship's
UD-Q4_K_XL.

**Two passes** (scratchpad `spike.py`; `b10437/cuda12/llama-server.exe` from
the shared cache; `-ngl 99 -c 2048`; 1 warm-up + 3 × 160 tokens,
`ignore_eos`; per-token ms from response `timings`; llama-server default
`n_threads = 8` on this 16-thread box):

```
pass A (all GPU):        per-token ms [2.651, 2.668, 2.761] -> median 2.668  (375 tok/s)
pass B (experts on CPU): per-token ms [9.320, 9.244, 9.886] -> median 9.320  (107 tok/s)
delta 6.652 ms/token (guard >= 0.2 x tB: OK) · spread A 3.5 %, B 6.1 % (guard <= 15 %: OK)
both passes incl. loads: 27.4 s wall
```

**DEFECT FOUND — `GgufMeta.expert_byte_share()` returns 0.0 for granitemoe**
(`runner/gguf.py:137` requires `expert_feed_forward_length > 0`). Granitemoe
header: `feed_forward_length 512`, `expert_feed_forward_length` ABSENT — the
Mixtral-style convention, where `feed_forward_length` IS the per-expert FFN
and there is no dense FFN. So the kit's byte model reads this MoE (and by the
same rule any Mixtral-style MoE) as dense: `active_bytes_per_pass_mb` →
(821.8, 0.0).

**Exact bytes instead** (tensor table via the `gguf` PyPI reader, installed
into the scratchpad only): 242 tensors, total 820.1 MB, `*_exps` **731.4 MB**
(share 0.8918), token_embd/output 41.3 MB → **active experts 182.8 MB/token**
(8 of 32) → **host = 182.8 / 6.652 = 27.5 GB/s** — outside the written
acceptance band [5, 13] → **FAIL as written.**

**Pass C — the ground truth that overturns the band's premise.** The
flagship itself, same flags (`-ngl 99 --n-cpu-moe 999 -c 4096`, no draft —
the server log shows no spec lines; its own eval line: 38.8 ms/token):

```
flagship exact bytes (tensor table): total 14233 MB · experts 12846 MB (share 0.9026) ·
  active experts 802.9 MB/token (8 of 128) · non-expert 1387 MB
pass C: per-token ms [38.747, 37.443, 37.649] -> median 37.65 ms = 26.6 tok/s
predicted with the tiny-MoE calibration (27.49 GB/s): 39.5 ms = 25.3 tok/s   (within 5 %)
predicted with memcpy probe x 0.40      (7.35 GB/s): 119.6 ms =  8.4 tok/s   (3.2x too slow)
host GB/s implied by pass C (device leg 1387 MB @ 134.4): 29.4
```

**What this means:**
1. **The calibration TRANSFERS** — a 27-second measurement on an 0.8 GB MoE
   predicted the 14 GB flagship's un-sped speed within 5 %.
2. **The acceptance band [5, 13] was anchored on stale evidence** — the fit
   plan's 2026-08-13 "measured host window 6.9–10.6 GB/s" does not hold on
   today's engine (b10437): the flagship's host leg measures ~29 GB/s.
3. **Today's chip is wrong by ~3×, not by a hair.** Pass C is the SLOWEST
   honest placement (every expert on CPU); the app's real launch puts some
   experts on the GPU, so the app is faster still — un-sped, before MTP. The
   flagship on this box is "fast", and the seeded `bw_eff_host_probe = 0.40`
   is ~3.7× too low for this build (27.5 / 18.37 ≈ 1.5 would reproduce it).
4. `expert_byte_share` also OVERSTATES the flagship: header 0.9389 vs exact
   0.9026 (err-slow, ~4 %).

### 11.5 DECIDED 2026-09-19 — *"your rec on all four, go"* (the four recs below, as written)
- **(a) Acceptance:** replace §8's band [5, 13] with the pass-C test
  ("calibration predicts the flagship's measured un-sped speed within 15 %")
  → items 3–4 proceed. Rec: yes — pass C is the direct test the band only
  approximated.
- **(b) Calibration model bytes:** the calibration file is sha-pinned, so its
  active-expert bytes are a constant — seed `calib_model_active_expert_mb =
  182.8` beside `calib_model_sha256` (exact, no parser, no heuristic). Rec:
  yes. Separately, fix `expert_byte_share()` for Mixtral-style arches
  (`expert_feed_forward_length` absent → per-expert FFN =
  `feed_forward_length`, no dense FFN): it changes fit/booking for every such
  catalog row, so it is its own item with its own blast radius, NOT folded in.
- **(c) The probe factor:** `bw_eff_host_probe = 0.40` under-reads this box
  ~3.7× on b10437. Options: re-seed it (one number; every user's estimate
  moves), or leave the memcpy rung as the pessimistic fallback and let
  calibration (item 3) and measurement (item 1) supersede it. Rec: the
  latter now; re-seed only with evidence from more than one box.
- **(d) Publish:** the verified file + sha above are what goes to release
  `calib-v1` — outward-facing, the user runs or approves the
  `gh release create` in §8.

### 11.6 (d) Published
`gh release create calib-v1` on `delebash/just-llm-runner` —
https://github.com/delebash/just-llm-runner/releases/tag/calib-v1. Assets:
`granite-3.1-1b-a400m-instruct-Q4_K_M.gguf` (821,847,360 bytes — the
verified file) + `LICENSE-Apache-2.0.txt` (the official text,
apache.org). Upstream has no NOTICE or LICENSE file (license declared in the
model card), so none to carry. Notes: purpose, sha256, attribution (IBM
model; bartowski quantization; redistributed unmodified). Anonymous
`curl -I` on the asset: `200`, `Content-Length: 821847360`,
`Accept-Ranges: bytes` (the segmented downloader works against it).

### 11.7 Item 3 — BUILT
- **Settings** (the same chain as §11.2, every link): `calib_model_url` ·
  `calib_model_sha256` · `calib_model_size_bytes` · `calib_active_expert_mb`
  (182.8) · `calib_nonexpert_mb` (88.7 — added beyond §6: the one-pass
  CPU-only derivation needs the whole per-token byte count). GUI: a
  "Speed-check model" block in `LuRunnerBinaries.vue` beside the pinned build;
  the PUT refuses a non-http(s) URL and a sha that is not 64 hex characters
  (a malformed sha would fail every future check).
- **Ladder:** `bandwidth.py` `MOE_PROBE_MODEL_ID = "__machine_moe_bw__"`,
  `moe_probe_label(build)`; `resolve_effective_bw(…, moe_probe_gbps)` —
  derivation → check → memcpy × 0.40 → class seed. Service:
  `host_moe_bw_gbps(mkey)` (label must equal this build's — else absent;
  NEVER auto-runs), `record_machine_probe` (the RAM probe's `record_probe_fn`
  seam), `installed_build()`, `installed_exe()`. `api.py` passes the rung.
- **The job:** `runner/calibrate.py` — `Calibrator` (the AutoTuner shape) +
  `make_calibrate_router` (`POST/GET /v1/llm-runner/calibrate`,
  `POST …/cancel`; GET also returns `mode`, `reason`, `configured`,
  `sizeBytes`, `measuredGbps` so Quick setup can decide whether to offer).
  Mounted in `llm/install.py` beside auto-tune.
- **Deviations from §6, each forced by code read on the day:**
  1. **File location** `<cache_root>/calib/<sha>.gguf`, not a "runner root":
     `binary.binary_dir()` is `<cache_root>/llamacpp/<build>`, so the engine
     itself lives in the (possibly shared) cache root, whose docstring says
     everything under it is content-addressed — `calib/<sha>.gguf` is.
     Spawn logs go to `runtime_root/logs/speed-check-pass-{a,b}.log`
     (app-private by that property's own contract).
  2. **Every child goes through `process._spawn_child`** (the Windows
     kill-on-close Job Object, spawn retries, clean errors) and
     `_close_job` — the process module forbids ad-hoc `Popen`.
  3. **`svc.stop()` before the passes** — the autotune precedent (a clean
     GPU per trial); a resident model would share the card and be measured.
  4. **The job waits up to 15 min for the engine exe** — Quick setup may be
     installing it in parallel (Run starts `engineTask` when needed).
  5. **Timing** from response `timings` (`predicted_ms / predicted_n`); a
     response without them is an error ("this engine build can't run the
     speed check"), never a wall-clock fallback.
- **Quick setup** (`QuickSetup.vue`): a `calibrate` step between detect and
  confirm. Offered only when ALL hold: nothing configured, something fits
  (`fitting`), NOT curated (`pickByClassConfig` with the wizard's own
  accessors returns ""), and the server says `mode` set + `configured` + no
  `measuredGbps`. A run already in flight is adopted. Done → re-read
  `/models`, recompute the pre-fill (`bestFittingId()`), re-fit an embed the
  wizard itself filled. Skip cancels a running check and goes to confirm.
  X/Esc disabled while it runs (the optimize precedent); the poll stops when
  the modal closes.
- **Labels** (canon, `familyContract.js` `quickSetup`): `checkTitle`,
  `checkRunButton`, `checkSkipButton`, `checkRetryButton`,
  `checkContinueButton` — and JW's `familyLabelsFeed.js` + `en.json` +
  `es.json` (JW localizes every Quick-setup label; a kit-only label would
  have rendered English inside JW's Spanish UI, the 2026-08-05 audit's gap).
  **Copy** (voice, `quickSetupCopy.js`): `checkBody` ({size} via the kit's
  `fmtBytes` — "784 MB", 1024-based like every download bar), `checkSkipNote`,
  `checkDoneNote`. Rendered once with "the recommendation **below**" — wrong
  on a screen that has none below; fixed to "on the next screen".

### 11.8 Item 4 — BUILT
`modelPick.js`: `clearsSpeedFloor(model, floor)` (measured else predicted;
no number passes) inside `pickBestModel`'s fast-enough filter;
`speedFloorOf(payload)`; `recommendedModelId` forwards `speedFloor` to the
§10 fallback ONLY. `/models` root ships `bandFineToks` + `speedFloorGrace`;
`useRunnerModels.js` exports `speedFloor`; the wizard (`bestFittingId`) and
the catalog badge (`LuModelCatalog.vue` `recommendedId`) both pass it.
Setting `speed_floor_grace` (0.2) through the chain; GUI "Recommend down to
(% under Fine)" in the Speed bands group. **Noticed, not changed
(pre-existing):** the badge calls `recommendedModelId` without
`runnable: FIT_GPU` while the wizard passes it (and pre-filters to
`fitting`), so the two can still differ on a CPU-spill-only box — the
"can never disagree" comment in `bestFittingId` over-claims.

### 11.9 Verification (items 3–4)
- **The real job, end to end on the author's box** (scratchpad driver; the
  real `Calibrator` class, only the recorder in-memory so the user's DB was
  not written): download from the `calib-v1` release through
  `stream_download` (~9 s) → sha verified → both passes via `_spawn_child`:
  pass A `[2.618, 2.611, 2.618]` ms/token (spread 0.3 %), pass B
  `[8.882, 8.676, 8.889]` (2.3 %) → **29.18 GB/s**, recorded as
  `('NVIDIA GeForce RTX 2070 SUPER|8192|16c|31g', '__machine_moe_bw__',
  'moe-stream probe b10437')` — **24 s total, download included**. File
  landed at `<shared cache>/calib/3a2ec1c2…08142eb.gguf`, 821,847,360 bytes.
  29.18 predicts the flagship at ~26.4 tok/s un-sped; pass C measured 26.6.
- **Tests:** `tests/test_calibrate.py` (8 — replays the spike's real
  numbers: two-pass → 27.48 GB/s + build-stamped row; one-pass; the delta
  guard; the spread guard; one-pool refused; checksum mismatch deletes the
  file; no engine → clean failure) · `test_bandwidth.py` rung order (the
  check beats the probe; a qualifying real-model MoE row at pass C's 26.6
  beats the check) · `test_runner_models.py` (payload root carries the floor
  inputs; the check's 29.18 moves the flagship to "fast") ·
  `verify-model-pick.mjs` **56/56** incl. the author's-box trap (hard 8.0 →
  e4b; graced 6.4 → flagship) and "class config outranks the floor".
- **Rendered** (headless UI on the real data dir; for the card, three
  responses stubbed IN THE BROWSER ONLY — engine presets empty, catalog class
  refs emptied, so the wizard sees an unconfigured uncurated box; the check's
  own status was the server's real one): title + body + skip note + Skip /
  Run render; **Skip → JV's confirm step, 0 POSTs to /calibrate**. Speed
  bands group: 20 · 8 · 2 · 10 · 20. Speed-check model block: the five seeded
  values; URL/sha fields first rendered ~185 px (the label column shrank the
  input) — fixed with `.lu-engbin-field--path` (the kit's `--w-path` width).
- **Gates (final tree, all four items):** kit ruff clean · kit pytest **925
  passed / 10 skipped / 0 failed** · `verify-model-pick.mjs` 56/56 · biome
  clean on the 9 changed kit UI files · JW `test:fast`: vitest **579/579**,
  build, JW server **128 passed** · JV `test:unit` 67/67 · JV `build:vite` ·
  JV server **741 passed** · JV smoke (real data dir) all views, zero JS
  errors · `check-family`: no new violation (the one it reports —
  `src/views/lora/DatasetTab.vue` hand-rolling `a.download` — predates this
  work, `572a087`, 2026-08-21).
- **Not exercised:** the check through a REAL uncurated Quick-setup Run (no
  such box here — the author's box is curated, and running it on the gate
  server would write a measured row into the user's real DB); Item 1 through
  a real Apply. Both are the user's walk.

---

## Appendix A — the knife edge, reproducible (run 2026-09-19)

From the kit checkout root. The facts dict is the flagship's live catalog
row (Appendix B); the functions are the kit's own — if this script and the
app disagree, the app changed, not the box.

```python
import sys; sys.path.insert(0, ".")
from llm_runner.runner import fit
facts = dict(block_count=30, n_kv_heads=16, head_count=16, embedding_length=2816,
             expert_used_count=8, expert_byte_share=0.9388753056234719,
             kv_windowed_bytes_per_token=102400.0, kv_global_bytes_per_token=10240.0,
             sliding_window=1024)
ne, ae = fit.active_bytes_per_pass_mb(size_mb=14249047104/1e6,
        expert_byte_share=facts["expert_byte_share"], experts_total=128, expert_used=8)
kv = fit.kv_mb_from_facts(facts, 32768)
dev_mb, host_mb = fit.speed_bytes_split(non_expert_mb=ne, active_expert_mb=ae, kv_mb=kv,
        one_pool=False, weight_budget_mb=max(0.0, 8192 - 1024 - fit.PHYSICS_OVERHEAD_MB["cuda"]))
dev_bw = 224.0 * 0.6   # class seed x bw_eff_device (register read fails on this driver)
p = lambda probe: fit.predict_decode_tok_s(device_mb=dev_mb, host_mb=host_mb,
        device_bw_gbps=dev_bw, host_bw_gbps=probe*0.40)
for probe, when in ((18.37, "2026-09-19 fresh DB"), (18.59, "2026-08-21"), (19.01, "2026-08-13 calibration")):
    t = p(probe)
    print(f"probe {probe} ({when}) -> {t:.2f} tok/s -> {fit.speed_band(t, fast=20, fine=8, slow=2)}")
```

Output on the author's box, 2026-09-19:

```
per token: GPU reads 1752 MB at 134.4 GB/s, CPU reads 836 MB
probe 18.37 GB/s (2026-09-19 fresh DB)    -> CPU 7.35 GB/s -> 7.88 tok/s -> slow
probe 18.59 GB/s (2026-08-21)             -> CPU 7.44 GB/s -> 7.97 tok/s -> slow
probe 19.01 GB/s (2026-08-13 calibration) -> CPU 7.60 GB/s -> 8.13 tok/s -> fine
'fine' needs a probe of 18.67 GB/s or more
```

Readings: the host pool is 113.7 of 127 ms per token (~90 %) — host
bandwidth decides the band, which is why item 3 calibrates the host pool
only. A ±2 % probe wobble crosses the line — why item 2 exists. The 0.40 was
calibrated ON the 19.01 reading (fit plan §5.5 + `config.py:93` comment), so
the knife edge is not a bug in any one number: the box's true un-sped speed
IS ≈8.

## Appendix B — the box evidence (live reads, 2026-09-19)

**Machine:** `machine_key = "NVIDIA GeForce RTX 2070 SUPER|8192|16c|31g"`,
backend cuda, class `dgpu-vram8|ram32` (class seeds: vram_bw 224.0,
ram_bw 51.2 GB/s). `nvidia-smi --query-gpu=memory.bus.width` → "not a valid
field" on this driver, so the device rung falls to the class seed.

**Flagship catalog facts** (`model_catalog` row `gemma-4-26b-a4b-qat`):
size_bytes 14249047104 · experts 128 · expert_used_count 8 ·
expert_byte_share 0.9388753056234719 · block_count 30 · n_kv_heads 16 ·
head_count 16 · embedding_length 2816 · kv_windowed 102400.0 /
kv_global 10240.0 bytes/token · sliding_window 1024 · trained_ctx 262144 ·
quality_rank 5 · MTP draft `MTP/mtp-gemma-4-26B-A4B-it-Q4_0.gguf`.

**Live `/v1/llm-runner/models`** (port 17494):

```
gemma-4-26b-a4b-qat  fit ok     speedBand slow  predTokS 7.9   measuredTokS None  quality 5
gemma-4-12b-qat      fit tight  speedBand slow  predTokS 3.3   measuredTokS None  quality 22
gemma-4-e4b-qat      fit ok     speedBand fast  predTokS 25.9  measuredTokS None  quality 23
root: vramMb 8192 · ramMb 32690 · safetyMarginMb 1024 · catalogWired true
```

**Live seeds** (`runner_setting`, built_in=1): band_fast_toks 20 ·
band_fine_toks 8 · band_slow_toks 2 · bw_eff_device 0.6 · bw_eff_host 0.15 ·
bw_eff_host_probe 0.40 · ctx_cap_tokens 32768.

**Probe-row history** (`model_measurements`, `__machine_ram_bw__`): 19.01
GB/s (2026-08-13, the reading the 0.40 factor was calibrated on) · 18.59
(2026-08-21) · 18.37 (2026-09-19, fresh DB after the speech-clean reset).
The host-effective window "6.9–10.6 GB/s" is the fit plan's own measured
range for this box (fit-redesign §5.5 corrected + Appendix B; quoted in
`config.py:93`'s comment block) — the spike's [5, 13] acceptance band is
that window with margin.

**Load-footprint rows on the fresh DB** (proof Phase 5 records footprint
only — the gap item 1 closes): `gemma-4-26b-a4b-qat` source='load',
tokens_per_sec **0.0**, vram_model_mb 6745 (2026-09-19 12:39) ·
`__overhead__` source='probe', label `physics-overhead b9993`,
vram_model_mb 1089.
