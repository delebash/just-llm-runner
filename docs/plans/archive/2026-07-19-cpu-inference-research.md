# CPU-only inference — the fact-check behind the box test (2026-07-19)

**What this is.** The user pasted a Google-AI answer claiming a dense 7B/14B runs
comfortably on CPU ("5–15 tok/s for 7B, 3–7 for 14B, partial offload fixes an 8 GB
card") and asked whether to believe it and whether JustWrite should offer a CPU-only
path — "probably most users won't even have a dedicated gpu." This doc records the
verification (web sources, per the upstream-audit hard rule — never training-data
recall) so the WHY behind the CPU-band decision is durable. The test it motivates:
`2026-07-19-cpu-only-band-test.md`.

## Claim-by-claim verdict

| Google's claim | Verdict | Evidence |
|---|---|---|
| The user's slow 14B on the RTX 2070S was VRAM overflow into system RAM (8 GB card, ~9 GB model → 1–2 tok/s) | **Correct.** The overflow cliff is real and severe. | [VRAM offload cliff benchmark](https://inventivehq.com/blog/vram-offload-cliff-gpu-layers-benchmark): same model/quant measured ~43 tok/s full-GPU vs ~2.9 tok/s spilled — ~15×. |
| 7B Q4 on CPU: 5–15 tok/s | Roughly right on a modern desktop; laptop CPUs land at the low end. Generation is memory-bandwidth-bound (dual-channel DDR4 ≈ 45–50 GB/s; DDR5-6000 ≈ 90 GB/s). | [Best CPU for LLMs 2026](https://www.mayhemcode.com/2026/06/best-cpu-for-llms-in-2026-what-actually.html) |
| Dense 14B pure CPU: 3–7 tok/s, "smooth and usable" | **Optimistic.** Published numbers spread ~5–8 on fast DDR5 down to **1–3 tok/s** for dense 12B on typical desktops. A DDR4 desktop sits ~3–4 — watchable, not pleasant. | Same source + [Gemma 4 hardware guide](https://gemma4-ai.com/blog/gemma4-hardware) |
| Partial offload on an 8 GB card → 8–12 tok/s on a 14B | **Overstated.** Even 10–12 GB cards top out ~12.5 tok/s; a 14B at any partial `-ngl` "lives near the bottom of the cliff." On 8 GB expect mid-single digits. | [n-gpu-layers tuning guide 2026](https://bmdpat.com/blog/llama-cpp-n-gpu-layers-tuning-guide-2026) |
| Q4_K_M keeps ~95–98% of quality | Standard perplexity-based claim, roughly right; QAT models do better still at the same footprint. | (uncontested; matches the QAT model cards) |
| Model picks: Mistral-Nemo-12B, Llama-3-8B, Hermes 7B/8B | **Stale — 2024-era.** Our curated catalog is two generations past this. | seed.py ladder, re-verified via HF API 2026-07-06 |
| "Chat with your book might feel slow" (prompt reading) | **Massively understated — this is the headline, not a footnote.** See below. | [ik_llama.cpp CPU prefill discussion](https://github.com/ikawrakow/ik_llama.cpp/discussions/25) |

## The two things Google missed

**1. Prompt processing (prefill) is the real constraint, not generation.** CPU
prefill is **16–53× slower than GPU** at long context. Generation speed describes
typing speed *after* the model has read the prompt — but JustWrite's features stuff
chapters + RAG + character sheets into the prompt. An 8k-token prompt at CPU-prefill
rates means minutes of silence before the first word. This is why the QuickSetup
no-GPU empty state (runner `54fcfff`) says CPU is "too slow for writing" — true for
our context-heavy features (chat-with-book, sweeps, critiques), NOT true for
short-context ones (rewrite a paragraph, brainstorm, character profile from a short
description). LocalProse's CPU tiers cap context at 4k/8k for exactly this reason —
the cap is a prefill mitigation, not a quality choice.
([prefill config guide](https://omniforge.online/blog/your-local-llm-is-slow-because-of-five-config-flags) —
batch size 2048 gives 2–3× prefill; flash-attn on CPU is ~26% SLOWER, don't enable it there.)

**2. The right CPU model shape is small-active MoE, not dense 7–14B.** Per-token
cost scales with ACTIVE params. A 30B-A3B-class MoE generates **12–15 tok/s
pure-CPU on 32 GB boxes** ([Qwen3-30B-A3B reports](https://apxml.com/models/qwen3-30b-a3b)),
and ~2B-class models hit ~26 tok/s
([Gemma 4 on-device comparison](https://sudoall.com/gemma-4-31b-apple-silicon-local-guide/)) —
while a dense 14B crawls. Our catalog already leans this way (`qwen3.6-35b-a3b-mtp`
A3.6B; two 26B-A4B tunes), and Ternary Bonsai-27B's CPU path is ALREADY MERGED in
mainline (≤ b9913 < our b9993 pin — only CUDA #25707 is still open), making it a
legitimate CPU-only candidate despite the CUDA watch.

## What this means

- **The user's own box (2070S 8 GB + 32 GB):** nothing pure-CPU beats the shipped
  `qwen3.6-35b-a3b-mtp` GPU tune (`n_cpu_moe 21`, the tested 2070S floor). The
  Google answer solves a problem this box doesn't have.
- **The product (no-dGPU users):** the premise is right — most laptops have no
  dedicated GPU — and modern CPU numbers for the RIGHT model shape are better than
  our empty-state copy assumes. Whether a CPU chat band ships is decided by the box
  test's measured prefill + generation at realistic prompt sizes, not by this
  research alone. Recipe + decision thresholds: `2026-07-19-cpu-only-band-test.md`.
- **RAM floors gate the band:** the MoE legs need 24–32 GB total RAM; only the
  12B-dense (~6.7 GB file) and a ~4B QAT fit 16 GB laptops. The band's floor model
  matters more than the 32 GB test box suggests.

## Sources

- https://inventivehq.com/blog/vram-offload-cliff-gpu-layers-benchmark
- https://bmdpat.com/blog/llama-cpp-n-gpu-layers-tuning-guide-2026
- https://github.com/ikawrakow/ik_llama.cpp/discussions/25
- https://www.mayhemcode.com/2026/06/best-cpu-for-llms-in-2026-what-actually.html
- https://apxml.com/models/qwen3-30b-a3b
- https://gemma4-ai.com/blog/gemma4-hardware
- https://sudoall.com/gemma-4-31b-apple-silicon-local-guide/
- https://omniforge.online/blog/your-local-llm-is-slow-because-of-five-config-flags
