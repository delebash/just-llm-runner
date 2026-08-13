# The fit redesign — debate ledger (companion to `2026-08-09-fit-redesign.md`)

**Purpose:** the design doc keeps the survivors; this keeps the ARGUMENT — every claim,
who killed or confirmed it, and why — so no future session re-derives or re-litigates.
Consensus was reached 2026-08-13. The plan (+ its §13 amendments) is the executable
truth; this file is the reasoning record.

**Provenance:** designed 2026-08-09 in session `31626313-…` (justwrite-app cwd,
00:26–03:18 local, Fable/Opus alternating, cut off mid-tool-call). Recovered 2026-08-13
from the transcript (`~/.claude/projects/E--Dev-Web-justwrite-app/31626313-….jsonl`),
then continued for ~8 more alternating rounds in the recovery session, including
read-only probes on the real GGUFs and the recorded bench rows (plan Appendix B).

---

## 1. The 2026-08-09 rounds — claim → verdict

| # | pass | claim | verdict |
|---|---|---|---|
| 1 | Opus 04:32 | quant ghost · MoE "Won't fit" · 8/33 vs 99/21 | HOLDS → §1.4/§1.2 |
| 2 | Fable 04:39 | link-owned floors before MoE-aware floors clobber curated 4096 | HOLDS (trap later DISSOLVED by facts-not-floors, §13.11) |
| 2 | Fable 04:39 | `start_server` clobbers ncmoe | WRONG FILE — `start_runner`, dormant; the LIVE bug is the router shed (§1.7) |
| 3 | Opus 04:47 | calibration number is a guess and load-bearing — compute first | HOLDS — forced the probes |
| 4 | Opus 04:57 | every seeded "Fits" is hand-typed (est 24,501 vs typed 6,000 in one row) | HOLDS → §1.2 |
| 4 | Opus 04:57 | `est_vram_mb` meaning frozen (embed co-load 2026-07-11) | HOLDS → §8.5 |
| 5 | Fable 05:08 | rung-snap = calibration gate | KILLED (Opus 05:16): n=1 with the Qwen counterexample. Snap survives as display law only |
| 5 | Fable 05:08 | shed fix is a PRECONDITION of the joint solve (solver 20 vs measured 21) | KILLED by the draft-charged probe: WITH the 252 MB draft the solver reads 21@16k/22@32k — exact-to-conservative. Shed real but independent |
| 6 | Opus 05:16 | raise `safety_margin_mb` to ~1300 as calibration | DEAD with the above |
| 7 | Opus 05:29 | RAM gate can never pass on the box it names (32,690 vs 32,768) | HOLDS — the catch of the thread → §1.3 |
| 7 | Opus 05:29 | scale size_mb into the regression for MoE floors | SELF-KILLED — negative slope a=−1.24, out of domain → first-principles |
| 8 | Fable 05:44 | reuse `snap_ram_gb`, don't invent a tolerance | HOLDS → §4 0.1 (now marked temporary, §13.5) |
| 8 | Fable 05:44 | floor precedence NOT settled; seed regeneration rides with it | HOLDS → §8.13 |
| 9 | Opus 05:51 | fit math has zero `mem_arch` concept; 16 GB iGPU with 2 GB carve → tie → 12 → still fails 16,384 | HOLDS → the architecture arm §5.2; residual resolved by raw-to-raw (§13.5) |
| 10 | Opus 05:55 | "the system doesn't account for architecture" | OVERCLAIM (user-corrected): class keys/tunes carry it and WIN at launch; the defect is the estimate VETOING measurement |
| 10 | Opus 05:59 | drop the `m.fit` veto for class-config models | WITHDRAWN then RESTORED re-keyed on THIS-box evidence, placed LATE → §7.4 |
| 11 | Opus 05:59 | replace the fitted regression outright | DOWNGRADED (Fable 06:05): best-validated thing we own IN domain → CI oracle, physics runtime |
| 11 | Opus 05:59 | the true-up measures truth and throws it away | HOLDS → §6.1 persistence |
| 12 | Fable 06:05 | untuned models are ENGINE-placed; only ctx is ours | HOLDS — reordered ctx cap into Phase 0 (§1.6) |
| 12 | Fable 06:05 | scratch term hand-wavy; probes hardest where needed; contamination control needed | HOLDS — landed 2026-08-13 as §13.6/§13.2 (was dropped from the doc in the 03:00 write) |
| 13 | Opus 06:16 | "five authorities collapse, mostly deletion" | OVERSTATED, self-corrected: two merge; compute_fit stays a thin caller |
| 13 | Opus 06:16 | GLM proves floors carry SPEED, not memory | HOLDS → §1.8, forced the badge ruling |
| 14 | Opus 06:25 | ship (a) feasibility now, (c) bands later | KILLED by the user ("easy way out") → (c) ships WITH the collapse |
| 15 | Opus 06:49 | new claim-resolver fn; new true-up table | SELF-KILLED ×2 — extend-don't-parallel → grow preview_fit; extend model_measurements |
| 15 | Opus 06:49 | `vram_total_mb` is the CARD total — JV's measured arm has NO source | HOLDS → §6.1 |
| 16 | Opus 06:56 | persistence gates the JV wiring | CORRECTED — physics gates; persistence enriches. Ladder has 4 arms; resident-live already works |

## 2. The 2026-08-13 recovery rounds

| # | pass | claim | verdict |
|---|---|---|---|
| 17 | Fable | the alternation STOPPED at 06:05 — the back half (speed bands, resolver, persistence, §8.13–16 wording) was Opus-only, never counter-reviewed | HOLDS — this is what the recovery rounds reviewed |
| 17 | Fable | §5.5's 0.55 RAM constant derives from the flagless llama-bench 13.37 the session itself ruled junk | HOLDS, then STRENGTHENED by probe (see 20) |
| 17 | Fable | snap retires when floors go raw; retirement gated on invalidation | SUPERSEDED — both the coupling AND Opus's per-row conditional gate were overdesign; the no-migrations rule (user resets) kills all legacy nursing → §13.5 |
| 17 | Fable | resolver arm-1 presents manifest-priced TTS reservations as live truth | HOLDS → provenance field §13.1 |
| 17 | Fable | fingerprint ≠ plane-1 (threads in, no_kv_offload semantics) | HOLDS, verified against seed.py → fit_relevant marker §13.3 |
| 18 | Opus | speed constant not merely mis-derived — UNDERIVABLE until Phase 1's byte model exists; Phase 3 consumes Phase 1 | HOLDS → §13.15 |
| 18 | Opus | scratch: keep analytic FORM, learn one COEFFICIENT (Fable's learned-absolute didn't transfer) | HOLDS → §13.6 |
| 18 | Opus | tight-never-no: bounds disagree ⇒ "tight", never "no" — the general principle | HOLDS → R1 |
| 18 | Opus | MTP models under-predicted; seed an acceptance factor | Phenomenon HOLDS; mechanism CUT (acceptance spread 0.47–0.91) → predict un-sped, measured corrects (§13.7) |
| 19 | user | "are you overdesigning this?" (llmfit comparison) | RIGHT — killed the snap bridge, the ctx-adjust hybrid, the acceptance factor; ladder rungs reclassified as display copy (user's own 2026-07-27 decree), not fit machinery |
| 19 | Opus | facts-not-floors: store immutable header facts, compute verdicts fresh — deletes invalidation, the floor cache, dual semantics | HOLDS → R3 (full spec §13.11); Opus deleted its own invalidation-stamp item to make it |
| 19 | Fable | three pins: wire shape unchanged · embeds keep curated floors · est_vram_mb stored | Pins 1–2 HOLD (pin 1 + Opus's canonical-membership addition); pin 3 REVERSED — Fable came around to computed-fresh (R4) |
| 19 | Fable | RAM co-residency unbudgeted on discrete (user's CPU question exposed it) | HOLDS → {vram_mb, ram_mb} claims §13.12; Opus's mmap caveat → display-only REC (R2) |
| 20 | probes | VRAM factor 0.59 (12B, clean) · RAM factor 0.10–0.22 (three derivations converge) · "same machine constant" DEAD · laptop sweep 1.53× same-config spread = not calibration-grade · ncmoe-0-wins survives · 0.41 GB/layer measured ≈ physics 0.446 (9%) — the core MoE term ALREADY validated in the dev doc | Settled the last inter-model dispute BY DATA → §5.5 corrected, §13.8/13.9 |
| 20 | Fable | Opus's 12B 0.66 correction wrong — llama-bench has no `-c`; ctx never applied | HOLDS (the doc's own line 86 warning) → §13.13 |
| 20 | user | "why did you read archive?" | RIGHT — measured-performance.md (dev doc) had everything, richer; dev-docs-first; kit dev-doc gap on the fit-authority story → §13.13 |
| 21 | Opus | §13.11's fact set cannot compute KV (kv_mb_at_ctx needs two per-layer ARRAYS); three scalars (Wb/Gb/sliding_window) collapse it exactly | VERIFIED by Fable against gguf.py:179-187 — byte-identical, covers uniform models (Wb=0) → §13.11 completed |
| 21 | Opus | §5.5's GLM ~1.5 tok/s reads as probe output but is a catalog-params estimate (file not on disk) | HOLDS — labelled in place |
| 22 | user | "a user should always be able to run any model they want with any settings they want" | RULING §8.23 — the FIT_RUNNABLE picker/dropdown veto (shipped long BEFORE the redesign; consumers verified) comes out of every picker; verdicts inform, never gate; recommendations may still prefer; engine attempt stays the final authority → §13.16 |

## 3. Final state

- **Consensus: COMPLETE (2026-08-13).** All inter-model disputes closed, the last by
  probe data. §8 DECIDED items 1–16 (user, 2026-08-09) untouched; JV Q1–Q8 untouched.
- **All rulings DECIDED by the user 2026-08-13** ("i agree with all six recs go record
  them" + the round-22 ruling) → plan §8.17–23: tight-never-no + err-slow · RAM claims
  display-only · facts-not-floors · est_vram_mb computed fresh · floor ctx 4096 ·
  one clear button · verdicts-inform-never-gate. **§9 is empty. Only per-phase "go"s
  remain — Phase 0's was given 2026-08-13 ("then code").**
- **The user's meta-verdicts that shaped the design:** don't narrow to my machines ·
  don't take the easy way out · user-editable means GUI · hand-rolling is fine if it's
  the correct fix · don't overdesign (the llmfit challenge) · dev docs before archive.
- Nothing is committed in any repo unless the user asks.

## 4. Standing process constraints (verbatim-critical)

Go-gate: the literal word "go" before any code/change step; each phase its own go.
Discussion mode = prose only, no popups. Never own a decision — recommend, the user
picks. Verify in code, never guess; upstream facts checked on the web, never recalled.
Every pass SAVES its results (this file + the plan) — the 2026-08-09 loss must not
repeat.
