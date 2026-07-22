# CPU-only band — the box test (2026-07-19)

**Status: RECIPE — waiting for the box run.** This doc is written to be executed by a
local Claude session on the user's Windows machine (RTX 2070 Super 8 GB · 32 GB RAM).
It produces NUMBERS ONLY — no product change, no copy change, no catalog change
happens from the box session. The numbers come back here (fill the results table),
and the product decision is taken in a normal session afterwards.

## Why

The user asked whether a no-dGPU machine can run local models well enough to write
with — "probably most users won't even have a dedicated gpu." A Google-AI answer
claimed dense 7B/14B on CPU is comfortable; our fact-check found otherwise on the
points that matter. **The full claim-by-claim verification with sources is
`2026-07-19-cpu-inference-research.md` (same folder) — read it first.** The short
version:

- **Generation** speeds are roughly as claimed for small/MoE models (30B-A3B-class
  MoE: ~12–15 tok/s pure-CPU on 32 GB boxes) but optimistic for dense 12–14B
  (~1–8 tok/s depending on RAM bandwidth; DDR4 desktops sit low).
- **The omission: prompt processing.** CPU prefill is 16–53× slower than GPU at long
  context. Our features stuff chapters + RAG into the prompt, so time-to-first-token
  (TTFT) — not typing speed — is the real constraint. LocalProse's CPU tiers cap
  context at 4k/8k for exactly this reason.
- Dense-14B-partial-offload on an 8 GB card (Google's "fix") lives near the bottom
  of the offload cliff — our shipped answer for that hardware is already better
  (`qwen3.6-35b-a3b-mtp` with `n_cpu_moe 21`, the tested 2070S tune).

**The decision this feeds:** whether to add a **CPU chat band** to fit/QuickSetup
(the `tier: "cpu"` concept already exists for embeddings) with a context cap and
honest per-feature expectations — and if so, soften the no-GPU empty state
(currently: "generating on the CPU alone is too slow for writing," runner `54fcfff`).
If the numbers are bad, the current no-GPU → online-provider routing stands.

## What to measure

For every leg: **pp** (prompt-processing tok/s) at 512 / 2048 / 8192 prompt tokens,
**tg** (generation tok/s, 128 tokens), and **peak RAM** (Task Manager, working set).
Derive TTFT ≈ prompt_tokens ÷ pp. Threads = physical cores.

> **AUTOMATED 2026-07-19 — prefer the bench harness over doing this by hand.**
> `cd justwrite-app && npm run bench -- --config scripts/bench/configs/cpu-band.json`
> runs every leg below (llama-bench matrix + the feature legs through the real app
> against the tutorial book) and writes `bench-results/<run-id>/summary.md` with this
> doc's table already filled in, plus the captured feature outputs for the prose sniff.
> Add `--tauri` to watch it in the real app window. Legs A and C need their models
> downloaded first. Harness docs: `justwrite-app/docs/bench.md`. The manual recipe below
> stays valid — and is still the fallback if the harness is unavailable.

Preferred tool: `llama-bench.exe` from the installed engine folder (the b9993
distribution under the data root's engine cache — same folder as `llama-server.exe`;
if `llama-bench.exe` is absent in that zip, fall back to timing `llama-server`
completions directly with a stopwatch on TTFT + tok/s from its logs). Model GGUFs are
already under the data root's models folder for anything the app has downloaded.

```
llama-bench -m <model.gguf> -ngl 0 -t <physical-cores> -p 512,2048,8192 -n 128
```

~~`-ngl 0` forces pure CPU even on the CUDA build.~~ **CORRECTED 2026-07-22 (pass-1
plan T10): that claim was wrong** — the 2026-07-06 on-box measurement
(`justwrite-app/docs/plans/2026-07-06-llamacpp-config-tuning-2070s.md:176`) shows a
CUDA-build child at ngl 0 still GPU-offloads large-batch matmuls (bulk-embed 3.2 s vs
22–33 s with `--device none`), so prefill reads falsely fast. A true pure-CPU
measurement requires the CPU engine build (the 2026-07-22 runs used
`llama-b10083-bin-win-cpu-x64`; setup in the recovery doc §2). Close other RAM-heavy
apps first; run each leg twice, keep the second (warm cache).

## Legs

| Leg | Model | Why |
|---|---|---|
| **A** | `qwen3.6-35b-a3b-mtp` (UD-Q4_K_XL, ~22.9 GB) — pure CPU (`-ngl 0`) | Smallest active params in catalog (A3.6B) → best-case CPU generation. Needs ~24 GB free RAM — 32 GB box only. |
| **B** | One 26B-A4B MoE — `gryphe-styletune-v2` or `gemma-4-26b-a4b-uncensored` (Q4_K_M, ~16.8–17.2 GB) — pure CPU | The A4B class; smaller RAM footprint than A. |
| **C** | `gemma-4-12b-qat` (UD-Q4_K_XL, ~6.7 GB) — pure CPU | The dense control — what the Google answer recommended. Also the only catalog chat model that fits a 16 GB-RAM laptop. |
| **D** (optional) | A ~4B QAT of the same family — NOT in the seed; Smart Add from HF (verify the exact repo on the box, don't guess) | The LocalProse CPU-tier class; the true floor for weak laptops. |
| **E** (optional) | Ternary Bonsai-27B `_Q2_0_g64.gguf` (~6.7 GB, mainline conversion) — pure CPU | CPU support IS merged in ≤ b9913 (< our b9993 pin); only CUDA is still open. Designed for CPU — worth a datapoint + a prose sniff. |
| **Baseline** | `qwen3.6-35b-a3b-mtp` on the GPU tune (`-ngl 99 --n-cpu-moe 21`; if llama-bench lacks `--n-cpu-moe`, read tok/s from the app's Logs panel on a normal load instead) | What the same box does today — the bar every CPU leg is compared against. |

## Results (fill in on the box)

| Leg | pp512 | pp2048 | pp8192 | tg128 | TTFT@2k | TTFT@8k | peak RAM |
|---|---|---|---|---|---|---|---|
| A qwen3.6 CPU | | | | | | | |
| B 26B-A4B CPU | | | | | | | |
| C 12B dense CPU | | | | | | | |
| D 4B QAT CPU | | | | | | | |
| E Bonsai CPU | | | | | | | |
| Baseline GPU tune | | | | | | | |

## Reading the numbers (guidance, not law — the user decides)

- **tg ≥ ~8 tok/s AND TTFT@2k ≤ ~20 s** → a CPU band is viable for short-context
  features (rewrite, brainstorm, character fill) with a ctx cap; propose the band.
- **tg 4–8** → "patient mode" territory — discuss whether a clearly-labelled slower
  tier is worth shipping.
- **tg < 4 or TTFT@2k > ~45 s** → the current empty-state copy stands as written.
- The **pp8192 row** decides chat-with-book/sweeps separately — those can stay
  GPU/online-only even if a CPU band ships (sweeps are batch jobs and could tolerate
  more than chat can).
- **Interpretation caveats:** this DDR4 desktop is a mid proxy — modern LPDDR5X
  laptops have MORE bandwidth, old DDR4 laptops less. And RAM floors gate the band's
  model choice for real users: C (~6.7 GB) fits 16 GB machines; A/B need 24–32 GB.

## Out of scope for the box session

No changes to seed, fit, QuickSetup, or the empty-state copy. Numbers + prose
impressions into this doc, commit, push. The product decision happens after.
