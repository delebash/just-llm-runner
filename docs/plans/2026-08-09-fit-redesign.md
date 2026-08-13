# The fit redesign — one physical truth for "does this model run here"

**Date:** 2026-08-09 · **Status:** designed in full, awaiting per-phase go
**Designed by:** a full-day adversarial session (Fable + Opus, 6+ ordered re-passes, every
claim code-verified with file:line, three read-only probes run on the real GGUF headers on
the author's box). **Executor:** Opus, against THIS document — the design work is done;
do not re-derive it. When a file:line here has drifted, the anchor is the quoted
identifier/comment, not the number.

**The one-sentence diagnosis:** the system contains FIVE authorities on "does this model
fit this machine" — pairwise inconsistent, fixed at different times to different
standards, with no test anywhere that any two agree — and the only one users see
pre-download (the badge) is the weakest. Every "Fits" ever shown on a seeded model was a
hand-typed floor; every hand-added MoE gets a MoE-blind formula and a false "Won't fit".

---

## 0. Process rules for the executor (standing, from the user — violations have burned days)

- **go-gate:** the literal word "go" before ANY code/change/research step. Plan/read only
  until then. Each phase below needs its own go unless the user says otherwise.
- **Discussion mode = prose only.** No AskUserQuestion/ExitPlanMode popups while discussing.
- **Never own a decision.** The OPEN RULINGS (§9) are asked before their phase, never
  defaulted. Recommendations are listed; the user picks.
- **Extend, don't parallel.** Every mechanism here extends a named existing one. If you
  find yourself writing a new table/function beside an existing one, stop — this document
  probably names the extension point.
- **Names must match behaviour** — rename in the same commit when meaning changes; never
  reinterpret a stored field (the `vram_total_mb` trap, §6.3).
- **Nothing hardcoded** — every new number (cap, thresholds, bandwidths, ladders) is a DB
  row or seeded fact, GUI-editable ("user-editable" MEANS a GUI control, not a DB row).
- **Verify in code, not docs** — this doc's claims were verified 2026-08-09; re-verify
  reachability before building on any of them if time has passed.
- JW gates: `npm run test:fast`, headless smoke for renderer changes
  (`tests/smoke/headless-smoke.js` — IS the renderer gate), `i18n:report` MISSING=0.
  Runner gate: full pytest. Never bare `python` in scripts (use `scripts/py.js` in JW).
  Never test scripts inside the repo (scratchpad). Never touch live :1420/:17495.
- Biome doesn't format — match file style, no bulk reformat. User docs (`docs/*.md` root
  in JW/JV) ship in-app — a user-visible change updates its doc in the same commit.

---

## 1. Evidence index — what is broken, with proof

All numbers measured 2026-08-09 on the author's box (RTX 2070S 8 GB, 32 GB DDR4-3200,
`DEFAULT_SAFETY_MARGIN_MB = 1024`, budget 8192−1024 = 7168) via read-only probes calling
the runner's own functions on the real cached GGUFs.

### 1.1 The five fit authorities (the structural defect)

| # | authority | where | standard |
|---|---|---|---|
| 1 | `coarse_fit` badge | `runner/fit.py:75` | params×quant OR hand floor |
| 2 | `est_vram_mb_from_meta` | `llm/identity.py:168` | full-GPU regression, 8K ctx, f16 KV — **no MoE term** |
| 3 | `compute_fit` | `runner/process.py:354` | regression + `moe_gpu_size_share` + iSWA KV (2026-07-24 gold check) |
| 4 | engine `--fit` | 1b fit-by-omission | upstream placement (untuned launches) |
| 5 | hand `min_vram_mb` floors | seed rows | human judgment, row by row |

No consistency test exists: `compute_fit` appears 37× in tests, all synthetic meta.
The curated rows + the user's own tuned boxes made every *exercised* path correct —
"accidentally correct everywhere anyone looked, wrong everywhere else."

### 1.2 Probe results (the real headers)

**Qwen3.6-35B-A3B UD-Q4_K_M** (22,663,387,424 B · 41 layers · 2 KV heads · head_count 16
· embed 2048 · trained ctx 262144 · 256 experts · `expert_byte_share()` = **0.9846**):
- today's floor path: est **24,307 MB** ("Needs 23.7 GB VRAM") — fiction
- computed launch, no tune: **ctx 131072 · ngl 8 · ncmoe 33** (the user's screenshot)
- joint solve (§5.7) @ctx 32768: ngl 41, **ncmoe 32** → 6,825 MB (fits)
- max-offload regression slope: size/layer 8.50 − C0 17.995 + kv 8.25 → **a = −1.24
  MB/layer — NEGATIVE, out of domain** (`estimate_vram_mb` has no `a<=0` guard;
  `max_gpu_layers` does, fit.py:262). Regression floor 1,465 vs first-principles 2,204
  (+739 — regression is LOW, the dangerous direction for a floor).

**Gemma-4-26B-A4B-QAT UD-Q4_K_XL** (14,249,047,104 B · 30 layers · 16 KV heads · embed
2816 · 128 experts · share **0.9389** · iSWA: `kv_mb_at_ctx` real):
- today's floor path: est **17,713 MB** — byte-equal to the seeded `est_vram_mb: 17713`
  (one-source verified). Hand floor `min_vram_mb: 4096` is the ONLY reason the flagship
  isn't "Won't fit" on its own tuned box (ratio 17713/7168 = 2.47).
- max-offload slope a = +23.62 (in domain, barely). Regression floor 2,248 vs
  first-principles **2,765** (+517).
- joint solve **with the MTP draft charged** (252 MB draft, 4 layers;
  `marginal_vram_mb` = 880 MB @32k, 552 @16k): ctx 16384 → **ncmoe 21 = measured**;
  ctx 32768 → ncmoe 22 (one conservative). WITHOUT the draft: 20 — which the box measured
  as OOM ("n_cpu_moe 21 — the tested floor; 20 OOMs; the sweep's 23"). **Draft charging is
  essential to calibration — an early pass omitted it and mis-called the solver
  optimistic.**

### 1.3 The RAM gate can never pass on the box it names

`coarse_fit` fit.py:97-101: `ram_mb < min_ram_override → "no"`, fires BEFORE the VRAM
check. Floors are nominal rungs (`est_ram_mb_from_bytes`: fileMB(1e6) + 4096 headroom,
snapped UP `_RAM_RUNGS_GB = (8,10,12,16,24,32,48,64,96,128)`); detected RAM is physical
minus firmware reserve. This box: **32,690 detected vs 32,768 rung — 78 MB short, 0.24%,
fails forever**. Probed: `min_ram 32690 → OK, 32768 → NO`. Shipped victims: E4B floor
8192 on 8 GB laptops (its stated target), 12B 12288 on 12 GB boxes, 26B 24576 on 24 GB
boxes; ANY 21 GB-file model → 32768 floor → fails every 32 GB box. Cause: the 2026-07-27
binary-snap was applied to STORAGE; the comparison never learned. The old decimal floors
(32,000) passed by accident.

**Proof the fix is an alignment, not a choice:** class membership already compares
nominal-to-nominal (`classTunes.js:133` `cls.ramGb * 1024` vs floor) — `coarse_fit` is
the only surface comparing rung-to-detected. And `snap_ram_gb` (`hardware.py:154`,
`_RAM_LADDER = (2,3,4,6,8,12,16,24,32,...)`, nearest, ties-take-lower, docstring names
"OEM-reserve jitter") is why the SAME screen says "PC class … 32 GB RAM". Route the gate
through it. (Platform note: shortfall is platform-variable — Windows ~0.2-0.5%, Linux
MemTotal excludes more, macOS hw.memsize exact — the ladder absorbs all of it; a
tolerance constant would not. Carve-out honesty: 13.7 GB usable snaps to 12, not 16.)

### 1.4 The quant-change ghost (the user's screenshot #1)

`LuModelCatalog.vue onQuantPick` (~647) stores the string + clears `sizeBytes` — nothing
else. Name/description/floors/est/sizeLabel keep the previously-inspected quant's
identity. How the user got IQ1: `loadRepoFiles` pre-pick (~624-627) = "largest quant whose
FILE SIZE fits VRAM, else the smallest" — file-size-vs-VRAM is MoE-blind, nothing in a
35B repo "fits" 8 GB, fallback picked `quants[0]` = UD-IQ1_M (ascending sort,
`models.py:258`). Then `inspectLink` read the IQ1 header and wrote everything. Re-reading
with Q4 selected fixed name/description but NOT floors — lines ~703/707 are
fill-when-blank (`if (!e.minVramMb && r.estVramMb)`), which cannot distinguish a typed
value from a stale auto-fill. Decree #143: "if user clicks read from file all fields
should be updated" — the floors violate it.

### 1.5 The ctx handout (cheap KV punished)

`compute_fit` process.py:397-406: untuned ctx = min(trained, `kv_affordable`), share
`_KV_CTX_SHARE = 0.5`. Qwen's 2 KV heads → cheap KV → **131,072 granted** → ~2.7 GB KV
before any weights. Every measured tune on all three machines pinned **32768** (5/5).
DECIDED (§8): cap, not pin — `min(trained, affordable, cap)`.

### 1.6 What actually launches untuned models (corrects the whole session's early framing)

1b fit-by-omission (`overrides_to_pairs` process.py ~210): a None fit knob is NOT
rendered → the child's own `--fit` places tensors; **ctx is ALWAYS rendered (ours)**.
`lifecycle.py:1949-53`: `n_gpu_layers=fit.n_gpu_layers if fit.ngl_explicit else None`.
1b-F4: explicit computed placement only as the RETRY after an engine-placed load fails.
So the computed split's real consumers: the arbiter **reservation** (`FitPlan.vram_mb`),
the Tune modal's "Computed for this PC" (via `preview_fit` → resolved-defaults `computed`
rows, `model_catalog_api.py:295-324`), the retry path, and **autotune** ("the auto-tune
sweep anchors its n-cpu-moe candidates on this" — `preview_fit` docstring). The Apply
trap: a user hitting Apply on the displayed 8/33 pins the bad split as explicit. The
2026-07-25 Qwen removal verdict: app legs ran engine-placed at OUR poisoned ctx 131k;
llama-bench legs ran with NO placement flags at all (args verified: `-m -p -n -r -o`
only) — nothing tested a correct config; one llama-bench row is junk
(pp512 90.2 / pp2048 90.5 / pp8192 **239.9** — non-monotonic, not physical).

### 1.7 The shed moves the wrong knob for MoE

Router back-off `_router_load_with_backoff` (lifecycle.py ~2728):
`n_cpu_moe = max(0, fit.block_count - ngl) if fit.is_moe else entry.n_cpu_moe` — the
first OOM shed discards a tuned ncmoe (21 → 4 at ngl 26) and REDUCES expert offload while
shedding layers; strictly worse each retry. The draft-failure path 30 lines above already
tells users to "raise n_cpu_moe" — the codebase knows the correct lever. (`start_runner`
process.py:872 has the same formula on every attempt incl. the first, but has NO callers
outside tests + the package export — dormant, fix as hygiene.)

### 1.8 The floors' dual semantics (the GLM proof)

Membership calls them "usability floors". Dense rows: curated ≈ physics (12B 8192,
"39.1 tok/s at ngl 99"). MoE flagship: curated 4096 ≈ max-offload physics snapped
(2,765 → 4 GB rung). **GLM-4.5-Air breaks the pattern**: curated 12,288 vs max-offload
physics ~3-4 GB — the curator priced SPEED (106B-A12B ≈ 7 GB active/token over ~28 GB/s
effective RAM → **~4.4 tok/s predicted**). Pure physics floors flip GLM to "Fits" on an
8 GB/64 GB box where it crawls. Hence §5.5: the badge ships physics feasibility AND a
speed band TOGETHER — no window where GLM reads a bare "Fits".

### 1.9 What the measured tunes really are (5 measured + 8 extrapolated)

13 class-tune rows (JW `seed_presets.py:831-946`, JV mirror `:103-158`). MEASURED (5):
- 26B @ dgpu-vram8|ram32 — ngl 99 / ncmoe 21 / ctx 32768 / b512 / ub512 / threads 8
  (20 OOMs, sweep said 23)
- 26B @ igpu-mem32 — ngl 99 / **ncmoe 0** ("UMA one-pool — sweep proved offload
  pointless"; evidence `bench/results/laptop-core-ultra-7/kit/results-2.jsonl`
  ncmoe 0/8/16/24 sweep)
- E4B @ igpu-mem16 — ngl 99 / flash_attn off / ub 512, 9.8 tok/s (Iris Xe;
  `laptop-iris-xe-16gb/speed-kit-2026-07-24` fa×ub sweep)
- 12B @ dgpu-vram8|ram16 — ngl 99, 39.1 tok/s
- gryphe @ dgpu-vram8|ram32 — spec_type none (3 seeds/arm, 11.36 vs 11.42 — an A/B
  verdict, NOT a fit outcome)

8 remaining rows = 2026-07-25 per-band survey RECOMMENDATIONS (vram12/16/24 classes
nobody owns). **10 of 13 rows pin ngl 99; the computed path has never agreed with any of
them** (it computes 8-9). The 5 measured rows become the regression gate (§7.2) —
placement knobs only (ngl/ncmoe/ctx); spec_type/fa rows excluded (unreproducible by fit).

### 1.10 The Qwen record, corrected for the record

Never tuned (no class-tune row ever existed). The 2026-07-22 head-to-head:
`leg.json` shows ctx **131072**, `committedMb: 0`, `vramMb: null`, peak RSS 24.4 GB,
14.4 tok/s (MTP acceptance 0.7667 — *better* than Gemma's 0.6687). Removal verdict rests
on a pathological ctx + naive llama-bench placement. Re-test is OPTIONAL (user: don't
worry unless it shapes fit — it doesn't); if ever run, pin `-ngl`/`--n-cpu-moe`
explicitly and re-add the row through the FIXED Add flow as a live test of Phases 0-2.

---

## 2. The design in one paragraph

One **physics module** answers device-need/host-need at whatever fidelity the facts allow
(manifest → cached header facts → header+config), architecture-aware via `mem_arch`
(discrete = two pools; integrated/unified = one). The **floors become its cached output**
(chat rows only), written by the three existing writers. The **badge** = physics
feasibility × a **speed band** (bytes-per-token ÷ pool bandwidth). The **regression stays
as a test oracle** on its dense-CUDA domain, never runtime code out of domain.
**Placement stays the engine's** (`--fit`, the 1b design — correct, untouched).
**Measurement outranks estimate**: the true-up persists into `model_measurements`
(new honestly-named column), config-fingerprint-matched, and a **claim resolver** grown
from `preview_fit` serves every consumer (badge, reservation, embed leftover, JV's
future strip) through one four-arm ladder: resident-live → persisted-measured → computed
→ declared.

---

## 3. Verified consumer map (the blast radius — do not rediscover this)

**Floors (`min_vram_mb`/`min_ram_mb`) consumers:**
| consumer | file | effect of value change |
|---|---|---|
| badge | `runner/api.py:57-72` → `fit.coarse_fit` | the fix itself |
| class membership | `ui/src/classTunes.js:131-141` (`modelBelongsToClass`: both floors required; integrated both ≤ pool; discrete RAM hard gate + VRAM ratio ≤1.5; top band 24 open-ended) | chips + class library shift → **user re-validation required** (see below) |
| embed GPU/CPU placement | `lifecycle.py:2140-2153 embed_placement` (tier "cpu" never GPU; else curated floor ≤ static leftover) | **must not shift — embeds out of scope** |
| embed auto-pick | `modelPick.js:134-143 pickBestEmbedId` (minVram ≤ leftover) | same guard |
| QuickSetup leftover | `QuickSetup.vue:211` (est-first, floor fallback) | unchanged if est frozen |
| "Needs X GB" row + hover + LuClassTunes floor-notes | `LuModelCatalog.vue:1188`, `fitTitle` ~301, `LuClassTunes.vue:125-128` | display values change (ladder snap, §5.6) |

**`est_vram_mb` consumers (name + semantics FROZEN = "full-residency want"):**
`_embed_gpu_leftover_mb` lifecycle.py:2063-2100 (the 2026-07-25 ruling: est-else-floor —
floor made mid cards too generous to the embed); `useCatalogMeta.js:87-91 estVramById`;
`QuickSetup.vue:206-211`. Physics full-residency for the flagship ≈ same ~17 GB —
**pin with a stability test** (§7.5).

**Pinned truth table:** JW `src/components/classMembership.test.js` — the 9-model ×
12-class table the user personally validated 2026-07-26, near-miss margins documented in
its comments. Floor changes MUST go through the user via this test failing with named
rows — that is its charter, not an obstacle.

**Wire schema: unchanged in v1.** All columns exist (`db.py:112,162`; `CatalogRow`;
`RecommendedFor` schema.py:85-86). Changes are values + writers.

**The three floor writers (all exist):** `inspectLink` (LuModelCatalog ~703-707,
fill-when-blank → becomes link-owned overwrite), `set_derived` at download
(`identity.py:100-130`, writes est today → gains floors), and
`scripts/refresh-seed-facts.py` (regenerates seed header-facts incl. `est_vram_mb` via
the SAME `inspect_model_from_link` — floors are one field away). Audit sibling:
`scripts/seed-facts-audit.py` (AST-parse, network-gated, run at any seed change).

**JW/JV renderers:** no direct floor use outside the kit (JW's only floor test is
classMembership.test.js; JV renderer none — verified by grep).

---

## 4. Phase 0 — the quick lane (independent small fixes; can land in parallel with everything)

Each item: file, change, test. All four fix the user's original screenshots.

**0.1 RAM gate alignment.** `fit.coarse_fit` compares `snap_ram_gb(ram_mb) * 1024` (or
the caller passes snapped) against `min_ram_override`. Reuse `hardware.py:154 snap_ram_gb`
— do NOT invent a tolerance. Test: 32,690-detected box passes a 32,768 floor; a
13.7 GB-usable box (snaps to 12) still fails a 16,384 floor. Check `coarse_fit`'s
CPU-branch RAM check (fit.py:93) gets the same treatment.

**0.2 `a <= 0` guard in `estimate_vram_mb`** (fit.py:192-200) — mirror
`max_gpu_layers`'s degenerate-slope branch; raise/clamp rather than return garbage.
Test: Qwen-shaped inputs at full expert strip.

**0.3 Quant-pick re-reads everything.** `onQuantPick` → clear derived facts AND re-run
the same inspect (repo+quant known; header range-read, cheap). Stale-response guard: a
request token per pick, last-write-wins (user flipping quants fast must never get an
older read's fields). Name/description: regenerate ONLY if the field still equals what
`composedName()`/`composedDescription()` last produced (snapshot-compare — a user-typed
name is never clobbered). Floors become link-owned in `inspectLink` (overwrite, not
fill-when-blank) — **but only land this after Phase 1** (link-owned floors with the
MoE-blind estimator would let one Read-from-link clobber the curated Gemma 4096 with a
~16 GB full-offload estimate and kill the flagship on its own box; `seed.py:763` is
fill-when-None so a reseed would NOT repair it).

**0.4 ≥4-bit auto-pick fallback.** Server: add `q4OrBetter` (`_q4_or_better`,
`models.py:159` — exists for drafts) to QUANT rows in `classify_gguf_entries`
(models.py:205-258; the docstring's own "one predicate, server-side" rule). UI fallback:
nothing fits → smallest quant at ≥4-bit → only then truly smallest. (On MoE repos where
file-size-fitness always fails, this lands Q4_K_M — the right answer by accident.)

**0.5 ctx cap.** `compute_fit` ctx arm becomes `min(trained, kv_affordable, cap)`.
Cap value **32768** (DECIDED — 5/5 measured tunes). Home: a `runner_config` row beside
`safety_margin_mb` + a GUI field in `LuRunnerBinaries.vue` (precedent: safetyMarginMb
input line ~152, PUT "__settings"). NOT a switch-bundle value (a bundle is a PIN — would
force 32k onto smaller-trained models; a cap composes through min()). Label plainly:
"Default context cap — the most context an untuned model gets automatically; a tune's
explicit context always overrides."

---

## 5. Phase 1-3 — the physics module, floors-as-cache, speed bands

### 5.1 The physics module (grow `runner/fit.py`; the regression becomes a test oracle)

Terms, all computable from `GgufMeta` + launch config:
- **device weights**: file bytes × placement share — reuse `moe_gpu_size_share`
  semantics (overlap = min(ncmoe, ngl), `expert_byte_share()` from header dims,
  gguf.py:120-149 — returns 0.0 honestly when dims absent → no discount);
- **KV at ctx**: exact — generalize `kv_mb_at_ctx` (iSWA already exact) to the uniform
  case (layers × kv_heads × head_dims × cache_bits); one KV source for floors, fit,
  affordable-ctx, and the resolver's ctx-adjust (§6.5);
- **scratch/compute buffers**: ubatch × hidden × layers × dtype-scaled — calibrate
  against the three machines' measured footprints before trusting (this is the
  hand-wavy term; the oracle test bounds it);
- **runtime overhead**: per-backend DB-seeded rows (cuda/vulkan/rocm/metal), conservative
  starts, self-corrected by persisted true-ups (§6). `_C5`≈1516 and
  `_DRIVER_CTX_MB`≈549 are CUDA-flavored — they become the cuda row's seeds, not
  universal constants.

**The regression-as-oracle test:** for the seeded DENSE headers (its fitted domain), the
physics estimate must agree with `estimate_vram_mb` within a stated band (pick the band
from the 3-machine calibration; record it in the test). The 19,500-measurement
calibration keeps working for us as CI, not as runtime code. `compute_fit` switches to
the physics terms; the 2026-07-24 gold check (booked 19,758→6,456 vs measured 6.5-7.9)
must still pass as a pinned case.

### 5.2 Architecture arm (fused with detection fix)

`mem_arch` (hardware.py:123-139) is correct and UNCONSUMED by fit. Consume it:
- **discrete**: device floor = non-expert weights + KV + overhead (max-offload:
  ncmoe = n_layers is DEFINITIONAL for a floor); host floor = whole file + headroom
  (existing `est_ram_mb_from_bytes` rule — already MoE-correct);
- **integrated/unified**: ONE pool — floor = whole model + overhead; min_vram/min_ram
  stop being two numbers (display: one "Needs N GB memory" line on one-pool boxes);
- **macOS detection**: `detect()` gives Macs NO GPU row (`_gpu_scan` gated
  `elif plat in ("windows","linux")`) → max_vram 0 → "cpu" badge + ctx clamped to 4096
  (kv_affordable(0) → ladder floor) while Metal's own fit places fine. Fix: unified boxes
  carry honest pool facts (pool size, metal runtime), NEVER a fabricated VRAM number;
  fit reads the pool through the arch arm. Multi-GPU: `max_vram_mb` = largest single
  card is DELIBERATE (no tensor-split emission) — document, don't "fix", never sum.
- **arbiter snapshot** (`lifecycle.resident` → committed/remaining/total): must go
  arch-aware too — on one-pool boxes the denominators are the POOL and claims must be
  counted ONCE (mmap'd file + GPU allocation are the same physical RAM on UMA;
  the JV strip will read this snapshot — §6.7).

### 5.3 Floors become cached physics output (chat rows ONLY)

- `est_vram_mb_from_meta` → the module's full-residency term (values ≈ unchanged by
  construction; stability test pins the flagship ≈ 17.7 GB so the embed guard can't move).
- The floor writer: max-offload device floor (discrete) / pool floor (one-pool), stored
  RAW (see §5.6), written by all three writers (§3). `coarse_fit` reads the cached
  floors uniformly; its params×quant fallback remains for manifest-only rows, and a MoE
  with NO floor bands "unknown", never "no" (`FIT_RUNNABLE` modelPick.js:27 — unknown is
  outside it, row still sorts under DOESN'T FIT, but stops lying).
- **Scope guard:** EMBED rows untouched (decimal floors are deliberate
  wizard-steering; `embed_placement` gates GPU on them — recompute would put embeds on
  the GPU beside the flagship = the 2026-07-11 crash re-opened).
- Seed regeneration: extend `refresh-seed-facts.py` to floors; regenerate BOTH app seeds
  (JW `seed_presets.py`, JV `seed_presets.py`) in the same change (seed == detection).
  **DECIDED §8.13**: computed overwrites curated; curated values survive as test
  expectations (e.g. flagship-floor≈4096-snapped).
- Membership re-validation WITH THE USER via classMembership.test.js (its charter).
  Note from analysis: with current 12 classes, MoE membership is RAM-gated so most sets
  survive; dense floors ≈ unchanged — expect small-to-zero drift, but the user validates.

### 5.4 What the badge promises (DECIDED: physics feasibility × speed band, shipped together)

The pre-download row answers four questions; three are covered (quality = Bench column +
notes; size; memory = floors). **Speed exists NOWHERE today** (verified: BENCH is a
published-quality rank, `benchLabel` ~349-350; measured tok/s only post-load in the Tune
modal history). Hand-added rows have no curator prose. So the badge gains the speed band
— option (c) — in the SAME release as the physics floors; an (a)-only interim would flip
GLM to a bare "Fits" (a new lie while fixing the old one).

### 5.5 The speed model

`decode ceiling ≈ bytes-touched-per-token ÷ effective bandwidth of the pool those bytes
live in; slowest pool wins.` bytes/token per FORWARD PASS: dense = whole file; MoE =
non-expert bytes + active-expert share (file × expert_byte_share × used/total experts)
split by placement — PLUS a KV-read term at the LIVE context (iSWA-aware; 26B: 545 MB
@16k, 881 MB @32k — speed is context-dependent).

**CORRECTED 2026-08-13 (probe, Appendix B) — the original derivation here was wrong.**
The "same machine constant on both pools" story is DEAD. Measured on the author's box:
- **VRAM (device-compute) factor ≈ 0.59 of spec** — 12B dense 6.716 GB × 39.1 pass/s
  = 262.6 GB/s vs 448 spec. (Clean: llama-bench, no drafter, near-zero ctx — llama-bench
  has NO `-c` flag, so class-row ctx NEVER applies to its rows.)
- **CPU/RAM factor ≈ 0.10–0.22 of spec** — three independent derivations converge:
  app leg 28.6 tok/s MTP-corrected (multiplier 1.67→≤10.6 GB/s, 2.5→≤6.9); the
  ncmoe-30 sweep row (~5–6); bare llama-bench 11.47 (~6.7). Spec 51.2. The old 0.55
  paired the flagless llama-bench 13.37 with full-active bytes — a config that never ran.
- The two pools are DIFFERENT PHYSICAL PROCESSES (streamed device reads vs scattered
  expert gather + CPU FFN). Seed **two efficiency families**: device-compute ~0.6,
  host-CPU ~0.15 (low end — see err-slow below). Never one shared constant.
- GLM re-predicted at the corrected constant: ~1.5 tok/s — band unchanged (painful).
  (ESTIMATE from catalog params, 106B-A12B — GLM's file is not on disk; every other
  number in this section came from real headers.)

**Derivation rule (BW from stored measurements — source 1 below):** only rows whose
launch config is KNOWN (fingerprint present or bench flags recorded); bytes/token split
by that config's placement; speculative rows EXCLUDED unless divided by the run-length
multiplier — token-level acceptance is NOT the multiplier (measured mean accepted run
1.94–2.83 → ~2.9–3.8 tokens/pass vs acceptance 0.6687); flagless rows never qualify.

**Err-slow, never fast:** speed predictions take the conservative end; over-predicting
is the GLM lie with the opposite sign. Under-prediction self-corrects at first load.

**Honest limit (stated, not hidden):** one calibration point per pool per machine today;
no cross-model validation exists yet. The laptop sweep's identical-config spread is
1.53× (ncmoe 32/40/48 ≥ 30 layers = same placement; 5.32/7.95/8.15 tok/s) — those rows
are tuning-grade, NOT calibration-grade.

**Effective-bandwidth source ladder (a MACHINE property; models are interchangeable
lenses):**
1. **Derived from stored measurements** — `BW_eff = tok/s × bytes/token`, pool-matched;
   works today on any box that ever measured; accumulates automatically.
2. **Device-reported** — NVIDIA: NVML bus width × mem clock (computed from the device's
   own registers); Apple: chip-name → published-spec table (~15 chips, citable);
   RAM (all platforms): a one-time ~2 s C-speed copy probe (`bytes(buffer)` — the loop is
   C memcpy; NOT a Python-level loop), stored as a machine measurement row; the probe's
   efficiency factor calibrated ONCE against the measured-model path on the three known
   machines before ship. AMD/Intel dGPU: no reliable register path → source 3.
3. **Seeded class-typical fallback** — JEDEC arithmetic (DDR4-3200 dual = 51.2 GB/s is a
   standard, not an opinion) + vendor spec sheets per class band; cited in seed comments
   like licenses are; additive columns on `hardware_classes`; GUI-editable in the class
   editor; superseded by the first measurement. NEVER hand-tuned per model.

Bands replace precision. (The old "±2× error rarely crosses a band" claim is STRUCK —
it was never measured, and the 1.53× same-config spread eats most of it.) Display: the
fit chip gains the band ("Fits · ~fast" / "Fits · slow"); the row shows measured tok/s
once any real measurement exists (measurement outranks estimate). MTP models may show
"may run faster with speculative decoding" off `is_mtp` (a capability flag we already
parse) — never a seeded acceptance number (measured spread 0.47–0.91 across 17 requests;
no constant could be right). Thresholds: **DECIDED §8.14** — ~8 tok/s "comfortable"
line (reading speed), seeded + GUI-editable, bands fast/fine/slow/painful.

### 5.6 Display ladders (DECIDED: store raw, snap at display only)

The 2026-07-27 ruling ("no decimal capacities") was RIGHT about display and WRONG about
storage (storage-snap broke the RAM gate). So: DB stores raw computed MB; the row's
"Needs" line snaps UP a ladder of sizes real hardware ships; the hover keeps the raw
estimate (`fitTitle` already prints it). VRAM display ladder — **DECIDED §8.15**:
**3·4·6·8·10·11·12·16·20·24·32·48**
(1060-3GB · 1650 · 2060 · 2070S-class · 3080 · 1080 Ti · 3060/4070 · 4080 ·
7900 XT/RTX 4000 Ada · 3090/4090 · 5090 · RTX 6000 Ada). RAM display reuses
`_RAM_LADDER`. `_VRAM_BANDS` (4,6,8,12,16,24) is the
class-matching ladder (down-snap) — a DIFFERENT job, untouched. A wrong display rung
mislabels but can never misroute (display-only) — low-risk, no migration to change.

### 5.7 The joint MoE solve + the shed (Phase 6 — shed lands first or same commit)

- **Shed direction** (the net under the wire; calibration is n=1): in
  `_router_load_with_backoff`, a MoE OOM at ngl=n_layers RAISES ncmoe by the step first;
  shed ngl only after ncmoe maxes. Fix the dormant `start_runner` formula as hygiene.
- **Joint solve** in `compute_fit`'s MoE arm: pin ngl = n_layers, walk the smallest
  ncmoe whose FORWARD physics estimate (draft-charged, iSWA-KV) fits the budget;
  monotone, closed-form-or-tiny-loop. Consumers inherit: reservation, preview/Tune
  display (the Apply trap dies — the displayed split becomes the good one), 1b-F4 retry,
  autotune anchors.
- **Acceptance gate (§7.2)**: the 5 measured rows' placement knobs reproduced within
  tolerance — 26B@8GB: ncmoe ∈ [21,23] at ctx 32768 with draft (≥21 because 20 OOMs);
  26B@igpu-mem32: ncmoe 0 (one-pool arm); 12B/E4B: full offload (ngl=all).

---

## 6. Phase 4-5 — persistence and the claim resolver (the JV bridge)

### 6.1 Why (the JV finding)

JV's VRAM-manager wiring (JustVioce `docs/dev/TASKS.md` "VRAM: STOP AND THINK", think doc
`docs/plans/2026-08-08-vram-think.md`, Q1-Q8 ruled, Stage 1 SynthScheduler BUILT, wiring
gated) consumes claims at its center: the budget strip's LLM claim line names
"measurements record `vram_total_mb`; `compute_fit` prices an on-disk gguf" as its two
verified sources. **Both arms are broken today**: `vram_total_mb` is the CARD TOTAL
(`_default_measure_sample` lifecycle.py:164-171 — deliberate, docstring: "TOTALS…
per-process USED VRAM/RAM is a GPU-box refinement — inject a richer sampler there" — a
designed seam, never filled; bench legs prove it: every row `vramTotalMb: 8192`), and
`compute_fit` is the fiction Phase 1 fixes. The only true footprint (the true-up delta,
`_trued_up_vram_mb` lifecycle.py:2044 — measured-first, inverted 2026-07-11) lives in an
in-memory `_Reservation` and dies with the process. **Physics gates the wiring; persistence
creates the measured arm.**

### 6.2 The four-arm claim ladder (grow `preview_fit` — lifecycle.py:1247; no new function)

```
resident-live      (router per-model vramMb — leg.json evidence 6397 — + arbiter reservation; EXISTS)
→ persisted-measured (config-fingerprint-matched; NEW — §6.3)
→ computed          (physics; on-disk → preview_fit path; not-downloaded → cached floors)
→ declared          (catalog floor / engine manifest vram_min_mb via HOST-INJECTED per-kind fns)
```
DI precedent: `catalog_fn` (install), `record_measurement` sink (autotune router,
autotune.py:536-542). The kit owns precedence; JV injects its engine manifests
(`vram_min_mb`, `cpu_adequate`, `gpu_runtimes` — Q2's decided facts); JW injects nothing
new. `kind` ∈ llm|tts|stt (arbiter `_Reservation.kind` exists). A claim follows the
RESOLVED DEVICE: engine resolved to cpu → 0; LLM at ngl 0 → 0 (compute_fit already).

### 6.3 Persistence = extend `model_measurements` (db.py:438-470) — NOT a new table

- New `source` value `'load'`; new column **`vram_model_mb`** (the true-up footprint) —
  NEVER reinterpret `vram_total_mb` (names-must-match; adjacent numbers, different
  meanings). Additive schema (create_all picks it up; no reset).
- Rows carry the launch switches (MeasurementSwitch children exist) — the fingerprint.
- `kind` column defaulted 'llm': **DECIDED §8.16** — added now (cheap, doesn't foreclose
  engines; Q5's CUT of engine measure-after-load STANDS — nothing here resurrects it).
- Speed UIs (Measure history, Lab compare) filter `source ∈ (tune, autotune)`; autotune
  only WRITES via its sink, never reads history — no logic pollution.
- Clear-history: **OPEN RULING (e)** (rec: one button clears all incl. footprints; the
  claim falls back to computed and self-heals next load).

### 6.4 Config fingerprint (no new list)

The VRAM-relevant subset = knob_catalog's existing plane-1 "COMMON (fit & memory)"
classification (ctx_len, cache_type_k/v, n_cpu_moe, n_gpu_layers, flash_attn,
batch/ubatch — read the classification, don't hardcode). Match on that subset only.

### 6.5 The ctx-adjust hybrid (the one designed-clever bit)

Commonest fingerprint miss = ctx. Physics KV is exact, so:
`claim = measured_base − KV(ctx_measured) + KV(ctx_requested)` when everything else
matches; else fall to computed. Plain fallback beneath the cleverness.

### 6.6 Consumers unify

`_embed_gpu_leftover_mb` consumes the resolver (its est-else-floor chain retires into the
ladder; POLICY — chat-first, static-not-live — stays in lifecycle, host-side).
JV's `/v1/engines/vram` (UNBUILT — only the arbiter.py:98 comment exists) consumes it
from day one when the wiring resumes.

### 6.7 JV constraints (all verified 2026-08-09)

- Fit redesign lands BEFORE the JV wiring; their Q1-Q8 rulings ALL STAND untouched.
- Co-residence policy NEVER enters the physics module (JW chat-first vs JV task-shaped
  resident sets: stt+llm dictation — whisper auto-loads 1500 MB cuda manifest; tts-first
  narration; warm-boot flip is the wiring's LAST step).
- The `cpu` band stays first-class (JV `cpu_adequate` engines; JW tier-cpu embeds).
- Contact surface: JV's eviction-executor seam refactors `_admit`/`make_room`; this plan
  touches `preview_fit`/`_embed_gpu_leftover_mb`/`_router_load_with_backoff` — disjoint
  FUNCTIONS, same `lifecycle.py` (merge-level contact only). `models_max` is already
  kind-scoped (`arbiter.count(kind="llm")`).

---

## 7. Phase 7 — gates, precedence, and the tests that make rot impossible

**7.1 Regression oracle** — physics vs the oobabooga regression on seeded dense headers,
within the calibrated band (dense-CUDA is its fitted domain; out-of-domain use is what
this plan removes).

**7.2 The 5-row measured gate** — computed placement reproduces §1.9's measured rows
(placement knobs only). FAILS TODAY BY DESIGN (ngl 99 vs computed 8-9) until Phase 6.

**7.3 The uncurated-path acceptance test** — fresh DB, NO seed rows, hand-add a MoE by
link on a simulated 8 GB/32 GB box (fake HF via fixtures): assert the badge, floors, ctx,
and split come out sane. This is the test that would have caught every defect in this
document. (Harness precedents: `scripts/check-clean-install.py`,
`scripts/dev-seed-test-model.py`, install-test fixtures.)

**7.4 Evidence-keyed recommendation precedence** — `pickByClassConfig`
(modelPick.js:98-108) currently lets the estimate veto measured class configs
(`FIT_RUNNABLE.has(m.fit)` filter). Replace the veto-key with THIS-box evidence
(measurements/tunes/persisted footprints for this machine_key), NOT seeded class configs
(8 of 13 are extrapolations). Deliberately LATE (after physics) so it never masks the
formula bug. (2026-08-13, §8.23: the veto is removed from every PICKER outright —
this item survives as recommendation RANKING only.)

**7.5 Stability pins** — est_vram flagship ≈17.7 GB (embed-guard protection);
the 2026-07-24 gold-check case; RAM-gate rung cases; a≤0 guard case.

**7.6 Docs (same commits as their features)** — user docs: the badge's new band, the
"Needs" line, the ctx cap field, Quant behavior on the Add form (JW/JV `docs/` roots +
toc.json for new pages); dev docs: architecture-notes' fit section rewritten to ONE
authority + oracle; measured-performance gains the bandwidth constants.

---

## 8. DECIDED (this session — do not re-open)

1. ctx cap **32768**, home `runner_config` + GUI field beside safety margin. Bundle pin
   rejected (pin ≠ cap).
2. Ladders: **store raw, snap at display**; 2026-07-27 display ruling upheld; its
   storage application was the bug.
3. Badge = physics feasibility × speed band, **shipped together** (no GLM-lies window).
4. The regression becomes a test oracle; floors are first-principles; `a≤0` guarded.
5. `est_vram_mb` name + semantics frozen (embed co-load ruling 2026-07-25 depends on it).
6. Embeds entirely out of scope.
7. Multi-GPU stays largest-single-card (documented deliberate; never sum without
   tensor-split emission).
8. Placement stays the engine's (1b); our computed split serves
   reservation/display/retry/autotune.
9. Persistence extends `model_measurements`; resolver grows `preview_fit`; nothing new
   stands beside either.
10. Fit redesign precedes the JV VRAM wiring; Q1-Q8 stand.
11. Shed-direction fix lands before/with the joint solve.
12. Process: each phase gets its own go.
13. **Floor regeneration precedence** (user 2026-08-09 "your rec"): computed overwrites
    curated; curated values become test expectations; both app seeds regenerated in the
    same change (seed == detection holds at the floor columns).
14. **Speed-band thresholds** (same ruling): ~8 tok/s comfortable line; bands
    fast/fine/slow/painful; seeded + GUI-editable (start values, tunable in GUI later).
15. **VRAM display ladder** (same ruling): 3·4·6·8·10·11·12·16·20·24·32·48 — rung exists
    iff a real product shipped it.
16. **`kind` column** (same ruling): added NOW, defaulted 'llm', additive schema.
17. **tight-never-no + err-slow-never-fast** (user 2026-08-13, "i agree with all six
    recs"): an UNVERIFIED number may never exclude a model — verdict computed at both
    overhead bounds, disagreement ⇒ "tight", never "no"; speed predictions take the
    slow end and self-correct at first measured load. The original complaint, as a rule.
18. **RAM claims display-only in v1** (same ruling): claims carry `{vram_mb, ram_mb}`;
    the JV strip DISPLAYS the RAM sum, never enforces it (mmap'd weights are evictable —
    a summed ledger over-counts; enforcement would false-refuse). Enforcement revisited
    only on evidence, keyed on mlock/no_mmap.
19. **facts-not-floors** (same ruling): §13.11 replaces §5.3 — immutable header facts
    stored as additive columns, every derived number computed fresh at read; seeds
    regenerate to facts (user resets once); EMBED floors stay curated (§8.6).
20. **`est_vram_mb` computed fresh** (same ruling): storage goes; name + semantics stay
    frozen (§8.5); the flagship ≈17.7 GB stability test pins the embed guard.
21. **Floor reference ctx = 4096** (same ruling): the canonical floor prices KV at
    minimal-usable context ("can it run at all"); the fit verdict prices the
    requested/capped config. A seeded fact, never a literal.
22. **Clear-history: one button clears all, footprints included** (same ruling —
    closes 2026-08-09's open (e)): claims fall back to computed and self-heal on the
    next load. Predictable beats clever.
23a. **GLM's ram64 membership loss ACCEPTED** (user 2026-08-13, "your rec" — the
    Phase 2 membership re-validation): the physics RAM floor (71,817 = 67.7 GB
    file + headroom) honestly exceeds a 64 GB box; the curated 65,536 was
    fitted-to-class. GLM leaves the class-recommendation chips, stays in the
    catalog with a per-box badge, stays runnable (§8.23). The other SEVEN models'
    computed sets came out byte-identical to the user's 2026-07-26 table —
    the physics reproduces the curator (qwen: 36 MB apart).
23. **Verdicts inform, never gate** (user 2026-08-13: "a user should always be able
    to run any model they want with any settings they want"): the fit verdict must
    never prevent selection or launch. `FIT_RUNNABLE` stops filtering pickers and
    dropdowns — every model selectable everywhere; picking a "no" row shows the honest
    warning; the engine's own load attempt + back-off is the final authority.
    Auto-picks and recommendations may still PREFER runnable (a default, not a gate);
    catalog section grouping stays (display). Pinned by §7.3: a "no"-badged model is
    selectable and launchable. Supersedes §7.4's veto half (it survives as ranking
    only). Spec: §13.16; lands with Phase 3's badge work (the warning needs the band).

## 9. OPEN RULINGS

**NONE. All six 2026-08-13 rulings (R1–R5 + e) were DECIDED by the user on 2026-08-13**
("i agree with all six recs go record them") and recorded as **§8.17–8.22**. Nothing in
this plan awaits a design ruling; only the per-phase "go"s remain (§0 process rule).

## 10. DO-NOT list (adversarially rejected — with the reason)

- Don't scale `size_mb` into the regression for floors (out-of-domain; negative slope).
- Don't make floors link-owned before the physics floor exists (clobbers curated Gemma
  4096 → flagship "Won't fit" on its own box; reseed won't repair — seed.py:763
  fill-when-None).
- Don't put the ctx cap in a switch bundle (pin ≠ cap).
- Don't recompute or touch EMBED floors (wizard-steering by design; embed_placement
  gates on them).
- Don't change `est_vram_mb`'s name or meaning.
- Don't reinterpret `vram_total_mb` (card total, deliberate) — new column, new name.
- Don't build a new true-up table (extend model_measurements) or a new resolver function
  (grow preview_fit).
- Don't do naive measured-first (config fingerprint or nothing — a 21-ncmoe footprint
  must not price a 131k-ctx load).
- Don't sum multi-GPU VRAM; don't fabricate a VRAM number for unified boxes.
- Don't key recommendation precedence on seeded class configs (8/13 unmeasured) — use
  this-box evidence.
- Don't drop the "cpu" band or bake co-residence policy into the physics module.
- Don't resurrect Q5's cut (engine measure-after-load) — the schema merely doesn't
  foreclose it.
- Don't snap STORED floors (display only). Don't hardcode cap/thresholds/bandwidths/
  ladders (DB + GUI).
- Don't trust `start_runner`'s per-attempt ncmoe recompute as live (no callers) — fix as
  hygiene, don't build on it.
- Don't re-run the Qwen head-to-head as part of this work (user: only if it shapes fit —
  it doesn't). If ever re-run: pin placement flags; llama-bench with no flags measured
  driver oversubscription, and its pp8192 239.9 row is junk.

## 11. Execution order (each phase = its own go, its own gates)

```
Phase 0  quick lane: RAM gate · a≤0 guard · quant re-read+token · ≥4-bit fallback · ctx cap+GUI
Phase 1  physics module + arch arm + macOS detection honesty + oracle test
Phase 2  floors-as-cache (chat rows) + regeneration (decided §8.13) + ladders (§8.15)
         + membership re-validation WITH USER
Phase 3  speed bands (thresholds decided §8.14) + bandwidth ladder (measure-derived →
         device → seeded) + badge display + measured-replaces-predicted
Phase 4  per-backend used_vram probes (Metal/ROCm/Vulkan best-effort) + arbiter snapshot
         arch-awareness
Phase 5  persistence (vram_model_mb · source 'load' · kind col §8.16 · fingerprint ·
         ctx-adjust) [RULING e] + claim resolver (4 arms, DI declared)
         + _embed_gpu_leftover_mb consumes it
Phase 6  shed direction → joint MoE solve → 5-row measured gate green
Phase 7  evidence-keyed precedence + uncurated-path acceptance test + docs + JV handoff
         (their wiring unblocks; their TASKS updated)
```

Gates every phase: runner pytest full · JW `test:fast` · smoke for renderer-visible
changes · `i18n:report` MISSING=0 · the new §7 tests as they land · seed-facts audit on
any seed change. Known-bad on the author's Windows box (don't chase):
`test_pci_gpus_linux_lspci_name_match`, `test_ensure_model_ready_loads_then_returns`
(fail), `test_ensure_model_ready_raises_on_failed_load` (flaky). A fourth failure is real.

---

## 12. Handoff state (written 2026-08-09, immediately before session compact)

- This plan + tracker items in all three repos are ON DISK, **UNCOMMITTED** (user has
  not asked for a commit): runner `docs/plans/2026-08-09-fit-redesign.md` +
  `docs/dev/TASKS.md`; JW `docs/dev/TASKS.md`; JV `docs/dev/TASKS.md`. A memory
  pointer exists (`fit-redesign-plan` in the JW project memory).
- NO code has been changed anywhere. All probes were read-only, run from the session
  scratchpad (now gone — reproductions below).
- Executor: Opus, per the user (Fable weekly budget exhausted). NEXT ACTION: ask the
  user for the **Phase 0 go** (§4), then execute §11 phase by phase, one go each.
- The ONE open ruling is §9(e) — ask it before Phase 5, not before.

**2026-08-13 status:** the session above was cut off and recovered from its transcript;
the adversarial passes then CONTINUED in a new session (Fable/Opus alternation, 8 more
rounds incl. read-only probes on the real GGUFs + the recorded bench rows) and reached
FULL CONSENSUS. Everything closed is in **§13** (amendments — read it WITH each section
it amends); the corrected speed constants are in §5.5 + Appendix B. All six remaining
rulings were DECIDED by the user 2026-08-13 → **§8.17–8.22**; §9 is empty. The
reasoning record (who overturned what, why) lives in the companion
`2026-08-09-fit-redesign-debate.md`. **Phase 0 BUILT 2026-08-13** (go: "then code";
all five items; gates green — kit ruff + 787 pytest, JW test:fast 128, i18n, smoke;
details in the kit tracker). Everything committed + pushed 2026-08-13 on the
user's "commit everything" (kit: Phase 0 + the eviction seam in one commit —
lifecycle.py entangled them; JW: docs + the stale-test fix; JV: the Script-tab
batch). **Phase 1 BUILT 2026-08-13** — physics booking + arch arm + oracle live.
**Phase 2 BUILT + BLESSED 2026-08-13** — facts-not-floors end to end: facts
columns + extractor (byte-identical KV pin) · three writers · computed-fresh
floors/est through the one door · form floor inputs retired · seeds regenerated
LIVE from HF (chat floors deleted; embeds keep) · the snap retired (raw-to-raw)
· display ladder · membership re-validated WITH the user (7/8 identical;
GLM ram64 loss ruled §8.23a) · embed-guard decisions verified unchanged.
REMAINING for the user: the data reset (stale rung floors until then — accepted).
**The desktop checkpoint RAN 2026-08-13** and caught four live bugs (all fixed —
the wire-stripped q4OrBetter, the quant family order, the borrowed-MTP auto-arm,
the 18 GB "drafter"; full detail + the Qwen -MTP-variant-repo knowledge in the
kit tracker). Desktop items all pass. REMAINING: laptops glance + the reset.
**Phase 3 BUILT 2026-08-13** (go: "compact complete go phase 3") — the full
stage detail lives in the kit tracker's fit item; the shape:
- SPEED MODEL (§5.5 corrected/§13.8): `fit.active_bytes_per_pass_mb` (26B
  871+836 / 12B 6716 pinned) · `fit.kv_mb_from_facts` MOVED to fit.py
  (identity delegates — one source) · `fit.speed_bytes_split` (canonical
  placement; one-pool; dense spill; budget-0 → all host) ·
  `fit.predict_decode_tok_s` (serial pool sum — the conservative end of
  "slowest pool wins", the Appendix-B derivation shape; a byte-carrying pool
  with no bandwidth → None, NEVER a guess) · `fit.speed_band` (§8.14).
- BANDWIDTH LADDER (`runner/bandwidth.py`, new): source 1 derived from
  config-known un-sped measurement rows (flagless/spec/MTP rows excluded —
  §13.14; backend+machine matched; device from full-offload dense, host by
  pricing the device leg and solving the remainder); source 2 nvidia-smi
  bus×clock×2 (=448.06 on a 2070S) + the Apple chip table + the RAM copy
  probe (one-time, persisted as measurement row `__machine_ram_bw__`,
  Clear-history → re-probes); source 3 hardware_classes additive
  `vram_bw_gbps`/`ram_bw_gbps` (JEDEC/vendor-cited seeds, slowest common
  card per band; class-editor editable; `ensure` seeds new classes too).
  Efficiency families seeded runner_setting `bw_eff_device` 0.6 /
  `bw_eff_host` 0.15 (source-1 numbers bypass them). One-pool boxes price
  metal at the device family, iGPU/CPU at the host family.
- WIRE: ModelEntry gains size_bytes/trained_ctx/experts/physics_facts;
  RunnerModelInfo gains speedBand/predTokS/measuredTokS; api.py computes
  feasibility × band together at the CAPPED ctx; measured (newest, this
  machine+backend) outranks predicted for the value AND the band;
  MeasurementRow gains `backend` (was DB-stamped, wire-stripped — the
  documented Pydantic class, now declared); three new configure_service
  seams (measurements_fn/class_bw_fn/record_probe_fn).
- §8.23 VETO REMOVAL (§13.16): slotOptions → pure `buildSlotOptions` in
  modelPick.js, NO fit filter, badge+band on labels, `fitWarning` copy under
  a "no" pick; QuickSetup embedOptions unfiltered (annotated); grouping +
  every auto-pick KEPT as recommendations. §7.3 pinned in JW vitest
  (slotOptions.test.js — a "no" row IS in the dropdown).
- GUI (§13.17 AS AMENDED): margin + ctx cap MOVED into LuRunnerEngine's
  Loaded-models knobs; RAM headroom + the three band-threshold fields join
  them (EngineConfig GET/PUT + reset defaults); LuRunnerBinaries keeps only
  pinned build + URLs. Chip shows "Fits · ~fine" (~ = predicted; measured
  drops it); row shows measured tok/s; hover carries the speed sentence +
  the §13.7 MTP rider.
- Gates: kit ruff + 813/10 · biome (kit ui) · JW test:fast 128 + vitest 5
  (new file) + i18n benign-only + build:vite · JV build:vite + smoke PASSED
  (all views, 0 JS errors) · check-family 0 violations · JW smoke RUN BY
  THE USER 2026-08-13, no errors (it had refused while their app held port
  1420). ALL Phase 3 gates green. User docs shipped same-change: JW
  models.md (band, veto removal, knob move, class-bw fields) + JV
  ai-features.md (new section). Live-review polish same day: .lu-fit
  white-space:nowrap (the chip is atomic) + the bottom band DISPLAYS
  "very slow" (SPEED_BAND_LABEL — wire vocabulary unchanged).
NEXT ACTION: laptops glance · data reset · then the DELIBERATE CHECKPOINT
before Phases 4-6 (§11 — probes + arbiter arch-awareness · persistence +
claim resolver · shed + joint solve), each on its own go.

## Appendix A — verification probes (reproduce §1.2's numbers; originals were scratchpad-only)

Run from the JW repo root via `node scripts/py.js <file>` with the file in the session
scratchpad (NEVER inside a repo). GGUFs (author's box):
`E:\Dev\Web\justwrite-app\src-tauri\target\debug\data\ai-cache\hf\` →
`models--unsloth--Qwen3.6-35B-A3B-MTP-GGUF/snapshots/5bc3.../Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`,
`models--unsloth--gemma-4-26B-A4B-it-qat-GGUF/snapshots/7b92.../gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf`
(+ its `MTP/mtp-gemma-4-26B-A4B-it-Q4_0.gguf` draft, 252 MB, 4 layers).

```python
import sys; from pathlib import Path
sys.path.insert(0, r"E:\Dev\Web\just-llm-runner")
from llm_runner.runner.gguf import read_gguf_metadata
from llm_runner.runner import fit
from llm_runner.runner.config import DEFAULT_SAFETY_MARGIN_MB
from llm_runner.llm.identity import est_vram_mb_from_meta, est_ram_mb_from_bytes
BUDGET = 8192 - DEFAULT_SAFETY_MARGIN_MB   # 7168 on the author's box

meta = read_gguf_metadata(Path(GGUF)); total = Path(GGUF).stat().st_size
share = meta.expert_byte_share()           # Qwen 0.9846 · Gemma 0.9389

# (1) today's floor (the MoE-blind lie): est_vram_mb_from_meta(meta, total)
#     -> Qwen 24,307 · Gemma 17,713 (== seeded est_vram_mb)
# (2) computed launch today: cache=fit.cache_type_bits("q8_0");
#     ctx=min(meta.context_length, fit.kv_affordable(vram_budget_mb=BUDGET,
#       n_layers=meta.block_count, n_kv_heads=meta.n_kv_heads, cache_type=cache))
#     ngl=fit.max_gpu_layers(size_mb=total/1e6, n_layers=meta.block_count,
#       n_kv_heads=meta.n_kv_heads, embedding_dim=meta.embedding_length,
#       ctx_size=ctx, cache_type=cache, vram_budget_mb=BUDGET)
#     -> Qwen ctx 131072/ngl 8/ncmoe 33 · Gemma ctx 16384/ngl 9/ncmoe 21
# (3) slope decomposition (the out-of-domain proof), max offload (ncmoe=n_layers):
#     ms=fit.moe_gpu_size_share(n_layers=L, gpu_layers=L, n_cpu_moe=L, expert_share=share)
#     a = (total/1e6*ms)/L - 17.99552795246051 + kv_per_layer
#     kv_per_layer = meta.kv_mb_at_ctx(ctx,bits)/L if iSWA else
#                    3.148552680382576e-05 * fit.kv_bytes_per_token(kv_heads,bits) * ctx
#     -> Qwen a = -1.24 (NEGATIVE) · Gemma a = +23.62
#     first-principles floor = total/1e6*ms + KV_whole + 1516.52
#     -> Qwen 2,204 · Gemma 2,765 (regression gave 1,465 / 2,248 — LOW)
# (4) joint solve, DRAFT-CHARGED (Gemma): d=read draft meta;
#     dmarg=fit.marginal_vram_mb(size_mb=dbytes/1e6, n_layers=4, n_kv_heads=...,
#       embedding_dim=..., ctx_size=ctx, cache_type=cache, gpu_layers=4)  # 880@32k, 552@16k
#     walk nc=0..L: forward fit.estimate_vram_mb(size_mb=total/1e6*ms(nc), ...,
#       gpu_layers=L, kv_mb=meta.kv_mb_at_ctx(ctx,cache)) <= BUDGET-dmarg
#     -> ctx16384: nc 21 (=measured floor) · ctx32768: nc 22 · NO-draft: 20 (measured OOM)
# (5) RAM gate: fit.coarse_fit(..., min_ram_override=32768, ram_mb=detected 32,690)
#     -> "no" on the very box the rung names; 32690 -> ok. Fix = snap_ram_gb.
```

Speed-model validation: SUPERSEDED 2026-08-13 — the 26B line here paired the flagless
llama-bench 13.37 with full-active bytes (invalid config). Corrected constants +
derivation rule: §5.5; reproduction: Appendix B.
Bench-leg forensics (`bench/results/desktop-rtx-2070s/bench/2026-07-22_03-28-55-gpu/`):
Qwen leg ctx 131072, committedMb 0, vramMb null, peak RSS 24.4 GB, MTP acc 0.7667;
llama-bench args had NO placement flags; pp512 90.2 / pp2048 90.5 / pp8192 239.9
(non-monotonic = junk row).

---

## 13. The 2026-08-13 consensus amendments (post-recovery adversarial rounds)

The 2026-08-09 session was cut off; a new session recovered its transcript and ran ~8
more Fable/Opus alternating rounds, including probes on the real GGUFs and the recorded
bench rows. This section is the FULL closed set — read each item WITH the section it
amends. Reasoning record: `2026-08-09-fit-redesign-debate.md`. Every §8 DECIDED ruling
and every JV Q1–Q8 ruling survived untouched. Items marked CLOSED are model-consensus,
executable under the normal per-phase go; items needing the user are in §9.

### 13.1 CLOSED — reservation provenance (amends §6.2; Phase 5)
`_Reservation` gains `source: "measured" | "declared" | "computed"`, set at `reserve()`
and propagated by the resolver. Why: a TTS reservation is manifest-priced (Q5 cut the
engine true-up), so arm-1 "resident-live" would present a declared guess as live truth
on JV's strip. Verified: the field does not exist today (arbiter.py `_Reservation`:
vram_mb/pinned/seq/kind/evict_fn).

### 13.2 CLOSED — measured-arm hygiene (amends §6.3; Phase 5)
- Resolver takes the MEDIAN over fingerprint-matched `source='load'` rows.
- Retention: keep-latest-K per (model_id, machine, fingerprint); K a seeded fact
  (start 3). Without this, 'load' rows grow unboundedly.
- A single matched row is usable but provenance-flagged low-confidence.
- Honest fallback, stated in code comments: no per-backend probe → conservative seeded
  overhead that never self-corrects — still functional, never fatal.
- Overhead rows are keyed (backend × machine) and stamped with the ENGINE BUILD
  (measurements already stamp backend); an engine-pin bump triggers recalibration.

### 13.3 CLOSED — the config fingerprint is NOT plane-1 (amends §6.4; Phase 5)
Verified: plane-1 "COMMON (fit & memory)" actually contains `ctx_len, flash_attn,
cache_type_k, cache_type_v, n_cpu_moe, n_gpu_layers, mlock, no_mmap, no_kv_offload,
batch_size, ubatch_size, threads, threads_batch, parallel` — §6.4's parenthetical list
was wrong about its own source. `threads`/`threads_batch` are fit-irrelevant (spurious
fingerprint misses); `mlock`/`no_mmap` affect RAM residency mode, not the VRAM
footprint; `no_kv_offload` and `parallel` ARE VRAM-relevant and were missing from the
plan's list. Mechanism: a seeded `fit_relevant` boolean on knob_catalog rows; the
fingerprint = the fit_relevant set = `ctx_len, cache_type_k, cache_type_v, flash_attn,
n_cpu_moe, n_gpu_layers, no_kv_offload, parallel, batch_size, ubatch_size`. A
fingerprint miss falls back to computed (safe direction — quality loss, not a lie).

### 13.4 CUT — the ctx-adjust hybrid (removes §6.5; Phase 5)
Fingerprint miss → computed, full stop. The KV-adjust cleverness assumed only KV varies
with ctx (scratch varies too) and its value was speculative. Revisit only on evidence of
chronic ctx-only misses in real usage.

### 13.5 CUT — the snap bridge and all legacy-row nursing (amends §4 0.1 + §5.6)
The family's pre-release rule stands: seeds-only changes, no one-time migrations, the
user resets; stale rows until the next reset are the accepted cost. Consequences:
- Phase 0.1's `snap_ram_gb` routing is a TEMPORARY one-liner for today's rung-stored
  floors. It is DELETED in Phase 2 when floors go raw (or die per R3) + seeds
  regenerate + the user resets. End state: **raw-to-raw comparison, no snapping in the
  gate** — the 32,690-vs-32,768 class of bug becomes unrepresentable.
- NO per-row conditional gates, NO version-stamp-driven self-healing of legacy floors.
  (The invalidation-stamp machinery discussed mid-debate is DEAD — subsumed by R3:
  facts are immutable, nothing cached goes stale.)
- `snap_ram_gb` itself stays for CLASS matching — different job, untouched.

### 13.6 CLOSED — scratch keeps its analytic FORM, learns one COEFFICIENT (amends §5.1)
Scratch/compute-buffer term = known form (ubatch × hidden × layers × dtype-scaled) × a
learned coefficient per (backend, machine) — seeded conservative, corrected by
persisted true-ups, recalibrated on engine-pin bump. A learned absolute magnitude would
not transfer across models/configs; a learned coefficient does. The per-backend
overhead rows (§5.1) seed: cuda from `_C5`≈1516 + `_DRIVER_CTX_MB`≈549; vulkan/rocm =
cuda + documented margin; metal = documented conservative one-pool constant. All
provenance-flagged 'seed-guess'; all self-correct on first load.

### 13.7 CUT — the MTP acceptance factor (amends §5.5)
No seeded per-model acceptance constant (measured spread 0.47–0.91 across 17 requests).
Speed predicts un-sped; the first measured load replaces it. Optional rider: the row
hover may note "may run faster with speculative decoding" off `is_mtp`.

### 13.8 CLOSED — the speed constants + derivation rule (rewrites §5.5 — done in place)
See §5.5 (corrected 2026-08-13) + Appendix B. Summary for the seeder: device-compute
family ≈0.6 of spec; host-CPU family 0.10–0.22 (seed the LOW end per err-slow); the
byte model carries non-expert + active-expert + KV(live ctx); BW derivation only from
config-known, speculation-corrected rows. The "±2× rarely crosses a band" claim is
struck. Honest limit: one calibration point per pool per machine today.

### 13.9 CLOSED — the 0.41 GB/layer pinned test (adds to §7.5)
JW `docs/dev/measured-performance.md` records ≈0.41 GB VRAM per expert layer moved
(the 26B ncmoe sweep). Physics: 14.25 GB × expert_byte_share 0.9389 ÷ 30 layers =
0.446 GB/layer — within 9%. This is a MEASURED validation of the redesign's central
term, recorded before the redesign existed. Pin it: §7.5 gains
`test_expert_layer_marginal_matches_measured` (physics vs 0.41, tolerance ~15%),
sourced to that doc.

### 13.10 CLOSED — arch-arm tests on mocked hardware (adds to §7)
No Macs needed: mock `detect()` snapshots for {discrete, integrated, unified} ×
{dense, MoE}, asserting (a) the floor path (two pools vs one), (b) the ctx path (no
4096 clamp from a fabricated 0-VRAM), (c) the arbiter snapshot accounting (one-pool
claims counted once). Today `unified` appears ONLY in test_hardware_class.py key
formatting — this closes the gap that let the discrete-only fit rule stay invisible.

### 13.11 DECIDED §8.19 — facts-not-floors, the full spec (replaces §5.3)
Store the model file's IMMUTABLE FACTS as additive `model_catalog` columns; compute
every derived number fresh at read time. The facts (all already parsed by gguf.py):
`block_count, n_kv_heads, head_count, embedding_length, expert_used_count,
expert_byte_share` (float; `experts`/`size_bytes`/`trained_ctx`/`architecture` already
exist as columns) — **plus the three KV scalars** (2026-08-13 completion; without them
the fact set cannot compute KV, and floors would come out silently LOW):
`kv_windowed_bytes_per_token` (Σ windowed layers: kv_heads_i × ((key_length_swa or
key_length) + (value_length_swa or value_length))), `kv_global_bytes_per_token`
(Σ global layers: kv_heads_i × (key_length + value_length)), and `sliding_window`.
Then `KV(ctx, bits) = [Wb × min(ctx, sliding_window) + Gb × ctx] × bits/8` — verified
BYTE-IDENTICAL to `kv_mb_at_ctx`'s loop (gguf.py:179-187), collapses its two per-layer
arrays, and covers uniform-attention models for free (Wb=0) — the §5.1 generalization.
**The rule that keeps this honest:** a stored fact may be DERIVED (like
expert_byte_share) but must be a config-independent, immutable property of the FILE —
never a cached verdict. Writers: the SAME three (inspectLink, set_derived, seed refresh) —
they already write size_bytes; facts are the same motion. Seeds regenerate to carry
facts; curated CHAT floors die from the seed; **EMBED rows keep curated floors as the
explicit-override case** (wizard-steering, `embed_placement` gates on them — §8.6
unchanged). The server computes `min_vram_mb`/`min_ram_mb`/`est_vram_mb` into the
catalog RESPONSE (wire shape unchanged → renderer, classMembership.test.js, QuickSetup,
pickBestEmbedId untouched). Membership uses CANONICAL discrete-shaped numbers (it
classifies "which machines is this model for"); the arch arm applies to the LOCAL fit
verdict only. Fidelity ladder unchanged: manifest-only rows → params×quant band.
What this deletes: the invalidation stamp, the three-writer floor cache, the
stored-value dual-semantics disease, and Phase 0.3's "only after Phase 1" trap
(nothing stored to clobber; embeds protected). §8.13's WORDING updates under R3: seeds
regenerate to FACTS; "curated values become test expectations" survives as physics-vs-
old-curated pinned tests (flagship floor ≈4096-snapped, GLM handled by the speed band).

### 13.12 CLOSED shape · policy DECIDED §8.18 — RAM claims (amends §6.2)
Claims carry `{vram_mb, ram_mb}` — the physics computes both. New gap it closes: RAM
co-residency was unbudgeted on discrete boxes (a CPU TTS + MoE expert spill + OS can
exceed the box with every per-model gate passing; one-pool boxes were already covered
by the arch-aware snapshot). The mmap caveat (weights are mmap'd → evictable → a summed
ledger OVER-counts) is why enforcement is dangerous — hence §8.18: DISPLAY-ONLY in v1,
enforcement only on evidence (mlock/no_mmap-keyed). Ledger/display land in the
JV wiring, not here; only the claim SHAPE is this plan's.

### 13.13 CLOSED — small law items
- The RAM floor's `+4096` headroom constant becomes a seeded fact (nothing-hardcoded).
- The floor's reference ctx is a seeded fact (value = R5).
- 12B VRAM constant stays ~0.59: its 39.1 was llama-bench (`b10107 quick screen`),
  which has NO `-c` flag — class-row ctx never applies to llama-bench rows.
- Dev-docs-first: the measurements were ALL in `justwrite-app/docs/dev/
  measured-performance.md` (richer than the archive copies). Read dev docs before
  archive. Kit dev-doc GAP: the June fit-estimator decision (evaluate gguf-parser →
  keep fit.py — now superseded by this redesign) exists only in an archived plan;
  §7.6's docs pass writes the one-authority story into `docs/dev/serving-design.md`.

### 13.14 New DO-NOTs (extends §10)
- Don't nurse legacy rows through migrations — pre-release, the user resets.
- Don't derive bandwidth from flagless or speculative measurements.
- Don't treat token-level acceptance as the speculation multiplier (mean accepted RUN
  is the multiplier; the leg counters cannot recover cycles).
- Don't apply a class row's ctx to llama-bench rows (no `-c` flag).
- Don't seed a per-model acceptance constant.
- Don't let an unverified overhead produce "no" — bounds disagree ⇒ "tight" (R1).

### 13.15 Phase-order effects (amends §11; order itself unchanged)
Phase 0: 0.1 snap marked temporary (deleted Phase 2); 0.3's after-Phase-1 caveat
dissolves under §8.19. Phase 2: seeds regenerate to facts (§8.19–21 all decided); the
snap retires; membership re-validation WITH the user unchanged. Phase 3: consumes
Phase 1's byte model (the speed calibration CANNOT precede it — it needs the byte
accounting); §8.17 governs the badge; §8.23's veto removal (13.16) lands here too.
Phase 5: 13.1–13.4 land here; §8.18 + §8.22 govern. Phase 6-7: 13.9/13.10 tests join
the gates. (All rulings decided 2026-08-13 — §8.17-23; no ruling gates any phase now,
only its "go".)

### 13.16 DECIDED §8.23 — the fit veto comes out of the pickers (Phase 3)
Verified `FIT_RUNNABLE` consumers (2026-08-13): `modelPick.js:57` auto-pick (KEEP —
recommendation) · `:105` pickByClassConfig (KEEP — recommendation; §7.4's re-key now
applies to its RANKING only) · `:135` pickBestEmbedId (KEEP — auto-pick) ·
`LuModelCatalog.vue:181-182` section grouping (KEEP — display) · `:792` embed dropdown
(REMOVE the filter) · the chat-slot dropdowns (REMOVE — every model listed, badge/band
as label, honest warning copy on selecting a "no" row). §7.3 gains the pin: a
"no"-badged model is selectable AND launchable. The engine attempt + back-off stays the
final authority (1b unchanged).

### 13.17 GUI pins (the 2026-08-13 usability review)
- The model card's Min-VRAM/Min-RAM INPUTS retire with §8.19 — the user never types a
  floor; "Needs" is computed display. User-visible → its user-docs line lands in the
  same change (§7.6).
- The band-thresholds GUI surface (§8.14's "GUI-editable") is NAMED now: the runner
  settings panel beside safety margin + ctx cap (`LuRunnerBinaries`) — never "later".
- The RAM headroom seeded fact (§13.13) gets a field in the same panel, same save path.
- The standing shape: the user INPUTS nothing required — link → read → verdict.
  Overrides = quant picker · Tune & measure (outranks everything) · the panel knobs.
- **AMENDED at the Phase 3 go (user 2026-08-13, verbatim: "move the margin and cap
  nd the new fields under loaded models where Models kept loaded at once live, not
  under engine binaries")**: the home for VRAM safety margin + ctx cap + the two new
  Phase-3 fields (band thresholds · RAM headroom) is `LuRunnerEngine`'s knobs group —
  the Loaded-models card where "Models kept loaded at once" lives — NOT
  `LuRunnerBinaries`. The binaries panel keeps only the pinned build + URL rows.
  Same save path either way (`PUT /v1/ai/engine-config`, partial body).

---

## Appendix B — the 2026-08-13 probes (reproduce §5.5's corrected constants)

Read-only; run from the JW repo root via `node scripts/py.js <file>`. Model files under
`justwrite-app/src-tauri/target/debug/data/ai-cache/hf/` (26B flagship UD-Q4_K_XL
14,249,047,104 B; 12B UD-Q4_K_XL 6,716,356,800 B; MTP draft 251,937,728 B).

```
# Header facts (read_gguf_metadata, llm_runner.runner.gguf):
#   26B: 30 layers · 16 kv-heads · embed 2816 · experts 128 used 8 ·
#        expert_byte_share() = 0.9389
#   12B: 48 layers · 16 kv-heads · embed 3840 · dense
# Per-pass bytes: 26B = 0.871 (non-expert) + 0.836 (active experts) = 1.707 GB;
#   12B = 6.716 GB (whole file)
# KV read (kv_mb_at_ctx, f16): 26B 231/294/545/881 MB @ 1k/4k/16k/32k;
#   12B 352/403/604/872 MB
# VRAM constant: 39.1 tok/s × 6.716 GB = 262.6 GB/s ÷ 448 spec = 0.59
#   (llama-bench b10107, no drafter, default ctx)
# RAM constant, app leg (28.6 tok/s, ncmoe 21/30, ctx 16k, draft charged, VRAM side
#   priced 254–448 GB/s — insensitive):
#   multiplier 1.00 → ≤18.3 GB/s (0.36) · 1.67 → ≤10.6 (0.21) · 2.00 → ≤8.8 (0.17)
#   · 2.50 → ≤6.9 (0.14)
#   leg.json: draftN 163, draftNAccepted 109, draftAcceptance 0.6687; dev doc:
#   "mean accepted run 1.94–2.83" → tokens/pass ~2.9–3.8 → true value nearer the low end
# Cross-checks: ncmoe-30 sweep row (22.3 tok/s tg, all experts in RAM, MTP on)
#   → ~5–6 GB/s; dev doc "bare-GGUF llama-bench 11.47" → ~6.7 GB/s
# Core Ultra 7 sweep (results-2.jsonl, llama-bench, NO drafter, Vulkan iGPU):
#   ncmoe 0 → 10.98 tok/s (fastest — offload HURTS on one pool; seeded ncmoe 0 correct)
#   ncmoe 32/40/48 (≥30 layers = IDENTICAL config) → 5.32/7.95/8.15 = 1.53× spread
#   → tuning-grade data, not calibration-grade
```
