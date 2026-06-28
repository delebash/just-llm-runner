> ⛔ **NOT THE CURRENT PLAN.** The ONE current plan is `./2026-06-28-MASTER-PLAN.md` — everything is folded in there (✅ done + ⬜ outstanding, full detail). This doc is kept as **historical background only** (past plan / design / research / evidence). Read it for context; **plan from the master.**

# llama.cpp engine switches — what each does, why, when, for which models (2026-06-24)

Reference for the **shared** llama.cpp runner (`llm_runner/runner/`), consumed by
both JustVoice and JustWrite. Captures the deep research behind the manifest
`flagPresets`, the `Overrides` surface, and the per-model tuning + Compare UI we
still need to build. Saved in FULL detail (PRIORITY RULE #2 — handoffs need the
detail, not highlights). Every load-bearing claim is cited; nothing here is from
training-data memory (RULE #4).

> **Where this came from:** the user supplied docker commands + 5 screenshots
> from the YouTube video *"Run a 30B Model on a Cheap GPU | The Only Local AI
> Guide You Need"* (Codacus, `youtube.com/watch?v=SsUKTFSQoGM`) and asked: explain
> what each switch does and **why**, because the video shows the flags but doesn't
> explain them. The "why" is verified below against llama.cpp docs + independent
> benchmarks.

---

## TL;DR — the one mental model that explains all of it

There are **two regimes**, and almost every switch choice follows from which one
you're in:

| | **Dense model** (e.g. Qwen3.6-27B dense, Gemma 4 12B) | **MoE model** (e.g. Qwen3.6-**35B-A3B** = 35B total / 3.6B active) |
|---|---|---|
| Every token uses… | ALL weights | a small **active** subset (3.6B) + 8-of-256 routed experts |
| Fit a big model on a small card? | No — it must mostly fit in VRAM | **Yes — `--n-cpu-moe` offloads the huge expert weights to system RAM**, keeps the small active path + KV on GPU. 35B on 6 GB ≈ 30 tps. |
| Speculative decoding (MTP / ngram)? | **Helps** — MTP ≈ **+40%** (dense 27B: 10→14 tps) | **Hurts in llama.cpp** — RTX 3090: every spec variant was **slower** than baseline (135.7 → 121–131 tps) |
| The bottleneck is… | compute (so skip forward passes → spec wins) | **RAM bandwidth + expert loading** (so spec's extra expert loads cost more than they save) |

So: **MoE → lean on `--n-cpu-moe`, skip spec decoding. Dense → use MTP spec
decoding, and DON'T stack ngram on top.** Everything below is the detail.

---

## The source commands (verbatim, from the video)

**Model:** `bartowski/Qwen_Qwen3.6-35B-A3B-GGUF`, quant `Q4_K_M` — an MoE model.
Quant sources the video says to trust: **bartowski, unsloth, mradermacher, or the
official repo**; rule of thumb **"instruct, not base"**, pick a quant you trust,
and prefer GGUF for a budget GPU. (Example card shown: apache-2.0, GGUF, 262K
context.)

**A. Standard llama.cpp (stock build), 35B-A3B on a small card:**
```bash
llama-server -m qwen3.6-35b-a3b.gguf \
  -ngl 999 --n-cpu-moe 36 --no-mmap --mlock --ctx-size 128000
```

**B. TurboQuant fork (built from source, run in a CUDA container), bigger ctx:**
```bash
./build/bin/llama-server -m Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf \
  --port 8080 --host 0.0.0.0 \
  --cache-type-k turbo4 --cache-type-v turbo3 \
  --n-cpu-moe 36 -ngl 99 --no-mmap --mlock --jinja -c 256000
```

**C. The 6 GB budget-GPU config from the screenshots** (MTP-variant GGUF, but
note it is run WITHOUT spec flags — see §"speculative decoding"):
```bash
llama-server -m Qwen3.6-35B-A3B-MTP-UD-Q4_K_M.gguf \
  --n-cpu-moe 37 -ngl 99 --no-mmap --mlock \
  --cache-type-k q8_0 --cache-type-v q8_0 -c 8192
# observed: 16.2 tps, 37 of 48 layers offloaded to CPU
```

**D. Extra flags the video lists for DENSE models (speculative decoding):**
```bash
# dense 27B, no offload:
--spec-type draft-mtp --spec-draft-n-max 3            # MTP alone → +40%
# the video also showed stacking ngram, which BACKFIRED on Metal:
--spec-type ngram-mod --spec-ngram-mod-n-max 64       # MTP+ngram → 4.1 tps (worse)
```

---

## Per-switch reference

### Placement — `-ngl` / `--n-gpu-layers`
- **What:** how many transformer layers to load onto the GPU. `-ngl 999` (or `99`)
  = "all of them" (the number is just a ceiling above any real layer count).
- **Why:** GPU layers run far faster than CPU layers; you want as many on the GPU
  as VRAM allows.
- **When/which:** always set it. For **dense** models it's the main fit knob (fewer
  layers if you OOM). For **MoE**, set it high (`999`) and let `--n-cpu-moe` do the
  fitting instead (see below). Counter-intuitive MoE tip from the field: *don't*
  hand-tune `-ngl` down for MoE the way you would for dense — set it high and tune
  `--n-cpu-moe` ([mychen76](https://mychen76.medium.com/run-qwen3-6-35b-a3b-on-6gb-vram-using-llama-cpp-30-tps-a89032e5a60c)).

### MoE expert offload — `--n-cpu-moe N`  ⭐ the budget-GPU hero
- **What:** offload the **expert** weights of `N` layers to **CPU/system RAM**,
  keeping the attention + active path (and KV cache) on the GPU. Counts from the
  highest-numbered layers down. (Older equivalent: per-layer `-ot ...=CPU` regex;
  `--n-cpu-moe` is the clean shortcut.)
- **Why it works only for MoE:** MoE layers are mostly idle expert weights — only
  a few experts fire per token. You can park those big weights in RAM and stream
  just the active token's activation across PCIe for the CPU to compute. A **dense**
  layer has no separable "expert" weights, so `--n-cpu-moe` does nothing useful for
  it — a dense model that doesn't fit just spills to CPU and stays slow.
- **When/which:** MoE models on a card too small to hold the whole thing. Raise `N`
  until `llama-server` stops throwing CUDA-OOM. Real constraint becomes **system
  RAM**, not VRAM (the experts live in RAM): 35B-A3B needs ~24 GB RAM, runs ~30 tps
  on 6 GB VRAM, ~58–62 on 12 GB.
- **Mechanism (why it's not just "swap"):** the token's activation vector is sent
  VRAM→RAM over PCIe, the CPU does the expert math with weights resident in RAM,
  the result returns RAM→VRAM — the weights never move.
- Sources: [HF MoE-offload guide](https://huggingface.co/blog/Doctor-Shotgun/llamacpp-moe-offload-guide) ·
  [Understanding MoE offloading](https://dev.to/someoddcodeguy/understanding-moe-offloading-5co6) ·
  [oobabooga `--n-cpu-moe` issue](https://github.com/oobabooga/text-generation-webui/issues/7178) ·
  [235B-A22B offload](https://medium.com/@david.sanftenberg/gpu-poor-how-to-configure-offloading-for-the-qwen-3-235b-a22b-moe-model-using-llama-cpp-13dc15287bed)

### Memory residency — `--no-mmap` and `--mlock`
- **`--no-mmap`:** don't memory-map the GGUF from disk; read it fully into RAM up
  front. **Why:** when experts live in RAM and are hit every token, you don't want
  them paged from disk on demand — load once, keep resident. Trade-off: higher peak
  RAM + slower start.
- **`--mlock`:** lock those pages in RAM so the OS can't swap them out. **Why:**
  guarantees the CPU-resident experts stay in RAM (no page-out stalls mid-gen).
- **When/which:** the pair is standard for **MoE-offload on a memory-constrained
  box** — exactly the budget-GPU case. On a box with plenty of RAM headroom and a
  model that fits in VRAM, they matter less. In a **container** you must grant the
  memlock capability (`--cap-add IPC_LOCK` / raise `memlock` ulimit) or `--mlock`
  silently fails.

### Context length — `--ctx-size N` / `-c N`
- **What:** max tokens (prompt + generation) held in the KV cache.
- **Why it's a memory knob:** KV-cache VRAM grows linearly with context. Big
  context (128K, 256K) is expensive — which is the whole reason TurboQuant exists
  (below). The budget config drops to `-c 8192` to save memory; the TurboQuant
  config affords `-c 256000` *because* its KV cache is compressed.
- **When/which:** set to the real need. Our features: extraction/attribution over a
  chapter wants large-ish context; chat/brainstorm needs little. Note Qwen3.6 cards
  advertise up to 262K, but you pay for every token you enable.

### Attention kernel — `--flash-attn on`
- **What:** FlashAttention — a fused, memory-efficient attention kernel.
- **Why:** less KV-cache memory + faster attention, especially at long context.
  Effectively required to pair with quantized KV cache.
- **When/which:** on, basically always (it's in our `base` preset). Some old/odd
  hardware lacks support — then it falls back.

### KV-cache quantization — `--cache-type-k` / `--cache-type-v`
The KV cache can be stored at lower precision to fit more context in the same VRAM.
- **`q8_0` (standard, in-tree):** 8-bit KV. ~2× smaller than f16, negligible
  quality loss. **The safe default** — this is what our `base` preset uses, and
  what the 6 GB budget config uses. Needs `--flash-attn on`.
- **`turbo4` / `turbo3` (TurboQuant, FORK ONLY):** 3–4-bit KV via Walsh-Hadamard
  rotation + optimal (Lloyd-Max) codebooks (Google's TurboQuant paper, ICLR 2026).
  **Higher turbo number = MORE bits = LIGHTER compression**, so the ladder is
  `turbo4` (lightest) → `turbo3` → `turbo2` (heaviest). The cited **asymmetric
  sweet spot** is **K = `turbo4` (near-lossless), V = `turbo3` (~4.6× compressed)**
  — exactly command **B**. Net KV ~3–4× smaller than f16/f16, ~1% PPL loss → lets
  you push `-c` to 256K on memory that would otherwise cap far lower.
- **Why/when:** reach for TurboQuant ONLY when you need very long context on tight
  memory AND can build the fork. It is **experimental and sometimes SLOWER** —
  multiple users report regressions ([discussion #21829](https://github.com/ggml-org/llama.cpp/discussions/21829)).
  Default to `q8_0`; treat `turbo*` as an opt-in experiment to measure per machine.
- **Build note:** not in stock llama.cpp — build `TheTom/llama-cpp-turboquant`
  (branch `feature/turboquant-kv-cache`) from source; in our manifest it's flagged
  `experimental` + `fork`, and `compose_flags` does NOT emit it (it would have to
  come through `extra_flags` + a TurboQuant binary).
- Sources: [TurboQuant discussion #20969](https://github.com/ggml-org/llama.cpp/discussions/20969) ·
  [TheTom fork](https://github.com/TheTom/llama-cpp-turboquant) ·
  [turbo3/turbo4 + context](https://dasroot.net/posts/2026/04/turbo-quantization-llama-cpp-turbo3-turbo4-context-length/) ·
  [slower-for-me](https://github.com/ggml-org/llama.cpp/discussions/21829)

### Speculative decoding — `--spec-type …` (+ `--spec-draft-n-max`, `--spec-ngram-mod-n-max`)
- **What:** draft several tokens cheaply, then verify them in one pass with the
  main model — fewer full forward passes when drafts are accepted.
- **Valid `--spec-type` values** (verbatim from llama.cpp docs):
  `none | draft-simple | draft-mtp | ngram-cache | ngram-simple | ngram-map-k |
  ngram-map-k4v | ngram-mod`
  ([speculative.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md)).
  - **`draft-mtp`** — Multi-Token Prediction: the model's *own* extra prediction
    heads draft the tokens (no separate draft model). Needs an MTP-enabled GGUF
    (e.g. `unsloth/Qwen3.6-…-MTP-GGUF`).
  - **`ngram-mod`** — drafts from recent n-gram patterns in the text (no model);
    cheap but only wins on repetitive output.
- **Key flags:** `--spec-draft-n-max 3` = tokens drafted per step (default 3).
  `--spec-ngram-mod-n-max 64` = max n-gram length for ngram drafting (default 64).
  Docs note: *"MoEs require long drafts"*; *"dense models: can reduce
  `--spec-ngram-mod-n-min`"*.
- **⭐ WHEN IT HELPS vs HURTS — the thing the video doesn't explain:**
  - **DENSE models → MTP helps.** Video's dense 27B on an M5 MBP: baseline 10 tps
    → **MTP (`draft-mtp`, N=3) 14 tps (+40%)**, draft acceptance ~92.8%. (vLLM with
    MTP on a 3090 similarly ~+27.5%.)
  - **MoE A3B models → spec decoding HURTS in llama.cpp.** First public benchmark on
    a single RTX 3090 over 19 configs: **baseline 135.7 tps; ngram-mod 131.1
    (−3.4%); classic draft 121.1 (−10.8%); ngram-cache 119.1 (−12.2%)** — *no
    variant beat baseline*, even at ~100% draft acceptance
    ([thc1006 benchmark](https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090)).
    **Why:** A3B routes 8-of-256 experts/token; the "expert-saturation" point is
    ~94 tokens, far above the draft size (1–32). So each *drafted* token loads new
    expert slices, and the *verify* pass loads the **union** of all per-token expert
    sets — the extra expert loading costs more than the skipped forward passes buy.
    It's specific to llama.cpp's draft-then-verify (vLLM's MTP path does win on the
    same MoE).
  - **DON'T stack ngram on MTP.** Video's dense 27B: MTP alone +40%, but **MTP +
    `ngram-mod` collapsed to 4.1 tps** on Metal — the ngram verification overhead
    swamped the gain. One spec method at a time; measure.
- **Net rule for us:** enable `draft-mtp` for **dense** MTP-GGUF models; leave spec
  **off** for the 35B-A3B MoE (use `--n-cpu-moe` for *its* speed instead). The
  budget 6 GB config (command C) downloaded the MTP quant but runs it **without**
  `--spec-type` — consistent with this.
- Sources: [speculative.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md) ·
  [DataCamp MTP](https://www.datacamp.com/tutorial/multi-token-prediction-llama-cpp) ·
  [why MTP doesn't speed up (and the fix)](https://dev.to/alanwest/why-mtp-doesnt-speed-up-your-llamacpp-inference-and-how-to-actually-fix-it-2m2m) ·
  [A3B spec benchmark](https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090)

### Chat template — `--jinja`
- **What:** use the model's built-in Jinja chat template (from GGUF metadata) to
  format messages / tool calls, instead of llama.cpp's generic formatting.
- **Why/when:** newer models (Qwen3.6, tool-calling, thinking models) ship a
  specific template; `--jinja` makes roles, thinking tags, and tool calls render
  correctly. Turn it on for those models. (`-c`/`--ctx-size` are the same flag; both
  appear in the source commands.)

### Container memory lock — `IPC_LOCK`
- Not a llama.cpp flag — a **container capability**. `--mlock` inside Docker needs
  `--cap-add IPC_LOCK` (or a raised `memlock` ulimit); otherwise the lock fails and
  experts can be paged. Relevant to the TurboQuant "run in a CUDA container" path
  and our future Linux-CUDA docker runner.

---

## The FULL configurable surface (my own research, beyond the video) — mapped to our apps

The video showed ~12 flags. `llama-server` exposes far more, and the user asked for
**everything we can configure, with the reason OUR apps would need it**. Verified
from the official server flag list ([tools/server/README.md](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)).

**The key distinction nothing else states clearly — there are TWO config planes:**
1. **Load-time engine flags** — set once when the runner *spawns* `llama-server`
   for a model (fit / memory / context / KV / threading / batching). These are what
   the **per-model tuning UI + Compare columns** must expose; they go through
   `Overrides` → `compose_flags`.
2. **Per-request params** — sent in *each* OpenAI-compatible API call (sampling,
   JSON schema, reasoning budget, max tokens). These do **NOT** belong on the
   launch command — they belong in our **per-feature/per-action routing config**
   (where `temperature`/`maxTokens` already live). Putting sampling on the launch
   flags would wrongly freeze it for every feature sharing the model.

### Plane 1 — Load-time engine flags (the per-model tuning UI / Compare columns)

| Flag (short/long) | Default | What / why OUR apps need it |
|---|---|---|
| `-ngl / --n-gpu-layers N\|auto\|all` | model | Layers on GPU. Main dense-fit knob. (`auto`/`all` accepted.) |
| `-ncmoe / --n-cpu-moe N` | 0 | Offload first N layers' experts to CPU RAM. **The budget-GPU knob for the 35B-A3B attribution/extraction model.** |
| `-cmoe / --cpu-moe` | off | Offload ALL experts to CPU (extreme low-VRAM). |
| `-ctk / --cache-type-k`, `-ctv / --cache-type-v` | f16 | KV precision. We set `q8_0` (safe ~2×). `turbo*` = fork only. Long-chapter context shrinks here. |
| `-fa / --flash-attn on\|off\|auto` | auto | Fused attention; pairs with quantized KV. Leave `on`/`auto`. |
| `--no-mmap` | mmap on | Read whole GGUF into RAM (don't page from disk). **On for MoE-offload** so CPU experts don't disk-stall. |
| `--mlock` | off | Lock weights in RAM (no swap). Pair with `--no-mmap` on memory-tight boxes; needs `IPC_LOCK` in a container. |
| `-nkvo / --no-kv-offload` | KV on GPU | Keep KV in **system RAM** instead of VRAM — frees VRAM for more model layers at a speed cost. A fit lever when VRAM is the wall. |
| `-c / --ctx-size N` | model | Context window. Size to the task (chapter analysis = big; chat = small). Every token costs KV memory. |
| `-b / --batch-size N` | 2048 | Logical batch. **Bigger = faster prompt ingestion of our long chapter prompts** (prompt eval is batched). |
| `-ub / --ubatch-size N` | 512 | Physical batch (compute chunk). Tune with `-b` for prompt-eval speed vs memory; must be ≤ `-b`. |
| `-t / --threads N` | -1(auto) | CPU gen threads. **Directly affects MoE CPU-expert speed** — the offloaded experts run on these. Worth tuning on the user's box. |
| `-tb / --threads-batch N` | =threads | CPU threads for prompt/batch eval (long prompts). |
| `-np / --parallel N` | auto | Server slots = concurrent requests. **Our batch sweeps (attribute every line / extract every entity) + Compare's N columns** want >1; each slot costs context memory. |
| `-cb / --cont-batching` | on | Continuous batching — pack new requests into running batches. Keep on for the batch-sweep + Compare throughput. |
| `--cache-reuse N` | 0 | Reuse a prompt-prefix's KV across requests via KV-shifting. **Big win for us:** features reuse the SAME chapter/context prefix — reusing its KV skips re-ingesting it every call. |
| `-sm/-ts/-mg` (split-mode / tensor-split / main-gpu) | — | Multi-GPU split. Rare for our consumer target; expose only if a user has 2 GPUs. |
| `--spec-type` (+ `--spec-draft-n-max`, `--spec-ngram-mod-n-max`, `-md/--model-draft`) | none | Speculative decoding — **dense only** (see above); leave off for MoE. |

### Plane 1b — Context EXTENSION (advanced, only when a model's native ctx is too small)
`--rope-scaling {none,linear,yarn}`, `--rope-scale N`, `--rope-freq-base N`,
`--rope-freq-scale N`, `--yarn-orig-ctx/-ext-factor/-attn-factor/-beta-slow/-beta-fast`.
YaRN/RoPE stretch a model past its trained context. **When we'd need it:** a model
whose native window is shorter than a chapter we must analyze. Otherwise leave to
model defaults — wrong RoPE settings degrade quality. Expose as an "advanced
context" toggle, off by default.

### Plane 2 — Per-request params (our per-feature/per-action routing config)

| Param / flag | Default | What / why OUR apps need it |
|---|---|---|
| `--temp` / `temperature` | 0.80 | Randomness. **Prose/rewrite → higher; extraction/attribution → ~0** for determinism. Per-action already in routing. |
| `--top-k`, `--top-p`, `--min-p`, `--typical` | 40 / .95 / .05 | Truncation samplers. Tighter for structured tasks, looser for creative. |
| `--repeat-penalty` (+ `--repeat-last-n`), `--presence/--frequency-penalty`, `--dry-*`, `--xtc-*` | 1.0 / off | Anti-repetition. Useful for long prose; careful on structured output. |
| `--samplers "a;b;c"` | — | Sampler order. Advanced; default is fine. |
| `-j / --json-schema SCHEMA` **or** `--grammar` (GBNF) | — | **Constrained / structured output — this IS task #18.** For **speaker attribution & entity extraction**, pass a JSON schema (sent as `response_format` per request) so the model is forced to emit valid JSON. NOTE: the schema constrains output but is **not injected into the prompt** — still describe the shape in the prompt. |
| `--reasoning-format`, `--reasoning-budget N` | -1 | Thinking-model control. **"Thinking on" is what makes the A3B good at attribution** — but unbounded thinking is slow/costly; a budget caps it. Expose per-action (extraction can afford thinking; chat can't). |
| `-n / --predict N`, `--keep N` | -1 / 0 | Max new tokens / prompt tokens to retain. `maxTokens` already in routing. |

### Plane 3 — Server-level (the runner sets these once; not user-facing)
`--host`, `--port`, `--api-key`, `-np` slots, `--slots`/`--metrics`/`--props`
(monitoring), `--threads-http`, `--jinja`/`--chat-template` (per-model, plane 1),
`--no-webui`. The runner owns these; only `--jinja`/`--chat-template` and the
`-np` slot count are worth surfacing.

### What this means we should BUILD (consolidated)
- **Per-model tuning UI** exposes Plane 1: `n_cpu_moe`, `n_gpu_layers`, `ctx`,
  `cache-type-k/v`, `flash-attn`, `no-mmap`, `mlock`, `no-kv-offload`, `batch`/
  `ubatch`, `threads`/`threads-batch`, `parallel`, `cont-batching`, `cache-reuse`,
  `spec-type`(+n-max), `jinja` — with a **tokens/sec + VRAM/RAM readout**. (Advanced
  group: RoPE/YaRN, multi-GPU split.)
- **Per-action routing** exposes Plane 2: temperature + the truncation samplers,
  repeat penalties, `json-schema`/grammar (task #18), `reasoning-budget`, maxTokens.
- **Compare columns** = a Plane-1 set + a Plane-2 set + a model + a prompt, run on
  real text, ranked by tokens/sec · time · cost · quality (AI-stack Decision 23).
- Plumb all of Plane 1 through `POST /v1/llm-runner/load` `Overrides`; Plane 2 is
  already per-request through `/v1/ai/*`.

Sources: [server README (flag list)](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) ·
[batch vs ubatch](https://github.com/ggml-org/llama.cpp/discussions/6328) ·
[batching/throughput tuning](https://promptsicle.com/tips/boosting-llama-server-performance-with-batch-settings/) ·
[parallel inference params](https://github.com/ggml-org/llama.cpp/discussions/18308) ·
[GBNF grammars / JSON schema](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md) ·
[constrained decoding guide](https://www.aidancooper.co.uk/constrained-decoding/)

---

## The video's model curation ("MY GO-TOS" board) — discovery signal, not gospel

The same video doubles as a **per-task model recommendation board**. This is
exactly the "users don't know what model to pick" curation problem from
`justwrite-app/docs/plans/2026-06-24-local-model-recommendations.md` — captured
here as one cited community datapoint to fold into our recommendation set (overlay
with EQ-Bench / MTEB; don't treat one video as authoritative).

| Task | Video's pick | Our use |
|---|---|---|
| RAG · embedding | **Qwen3-Embedding** | JW "Ask the book" / RAG; JV none. Matches our MTEB note. |
| Coding · agentic | **Qwen3.6-35B-A3B** ("Ch3's 35B") | our attribution/extraction candidate (MoE-offload hero) |
| Agents | **GLM-4.7 Flash** ("hybrid attn? theory") | not in our catalog; note for evaluation |
| Writing | **gpt-oss** | prose/rewrite candidate (compare on EQ-Bench) |
| Multimodal | **Gemma 4** | JV/vision-adjacent; not a JW writing need |
| General chat | **Gemma 4 12B** | brainstorm/quick-draft tier |
| Vision | **Gemma 4 E2B / E4B** | not a JW need |

**Download hygiene the video stresses (worth surfacing in QuickSetup):** prefer
**instruct over base**; a **trusted quant uploader** (bartowski / unsloth /
mradermacher / official); **GGUF** for budget GPUs. Quant sources cross-ref our
recs doc + [Qwen3 lineup guide](https://baeseokjae.github.io/posts/qwen-3-full-lineup-guide-2026/).

---

## How this maps to OUR shared runner

### Current state (verified 2026-06-24)
- **`runner-manifest.json` `flagPresets`:**
  - `base`: `-ngl 999 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --mlock`
  - `mtp`: `--spec-type draft-mtp --spec-draft-n-max 3` (applied iff `model.mtp`)
  - `turboquant`: `{experimental, fork: TheTom/llama-cpp-turboquant, flags:
    [--cache-type-k turbo4 --cache-type-v turbo3]}` — **defined but not emitted**
    by `compose_flags`.
- **`process.py`:** `compute_fit` already derives `n_gpu_layers` + `n_cpu_moe`
  (MoE → offload the non-fitting layers) + `ctx_len`; `Overrides(n_gpu_layers,
  n_cpu_moe, ctx_len, extra_flags)` exists; `start_runner` has CUDA-OOM back-off
  (sheds `-ngl`, recomputes `--n-cpu-moe`). `compose_flags` emits base (+mtp if
  `model.mtp`) + `-ngl` + `--n-cpu-moe` (if >0) + `-m`/`--ctx-size`/host/port +
  `extra`.
- **`--no-mmap`** is **not** in any preset yet (the budget configs all use it —
  add it as an option).

### The gap — CLOSED 2026-06-24 (task #19, backend)
**Was:** `POST /v1/llm-runner/load` accepted only `{modelId}` and called
`service.load(model_id)` with a hardcoded `Overrides()` — so every switch existed
in the engine but **could not be tuned from the app** to measure speed.

**Now (backend done):** the full Plane-1 surface is plumbed end-to-end —
`LoadRequest` (camelCase contract, `schema.py`) → `Overrides` (expanded to all
engine flags, `process.py`) → `service.load(model_id, overrides)` (`lifecycle.py`)
→ `compute_fit` (fit knobs) + `compose_flags(..., overrides=)` (engine flags) →
`start_runner`. Verified: 98 tests pass (4 new merge tests) + ruff clean.

**Key design decision + WHY (so a future session can re-decide):** engine flags
**REPLACE** the matching `base`-preset flag (`_apply_engine_overrides` strips then
re-adds) instead of being appended as `extra_flags`. *Why:* appending
`--cache-type-k turbo4` after the base's `--cache-type-k q8_0` leaves llama-server
with the flag twice (ambiguous / last-wins-by-luck); replace = one unambiguous
value, and the GUI maps 1:1 to typed fields with validation. *What would change
this:* if llama-server ships a typed config endpoint, map to it instead of
composing CLI argv. (Presence flags like `--mlock`/`--no-mmap` use a filter, NOT
`_strip_flag`, because `_strip_flag` eats the FOLLOWING token — which for a
valueless flag is the next flag.)

**Still open here:** the per-model **tuning UI** (#20) + **Compare** (#21) that
drive this endpoint; turbo* still needs the fork binary (validation is light — the
spawn health/OOM back-off catches an unsupported KV type at runtime).

### Lifecycle — models vs switch-VALUES (CORRECTED 2026-06-24)
> **Correction (recorded per the why-rule):** an earlier version of this section
> claimed "swap = restart, no runtime API, llama-server is one-model-per-process."
> That was WRONG — a stale prior + shallow (confirmation-biased) research. Verified
> against the llama.cpp server README: llama.cpp has **router mode** (one server
> serves/swaps MANY models live). Corrected facts below so the design isn't built on
> a false premise.

**Two different things, two different costs:**
- **Switching MODELS = LIVE (router mode).** `llama-server --models-dir <dir>` and/or
  `--models-preset <ini>` (no `-m`) runs a router: routes each request by its `model`
  field, loads on demand, keeps up to `--models-max` (default 4) co-resident in VRAM
  — **no restart to change models**. Per-model settings (`n-gpu-layers`, `n-cpu-moe`,
  `c`, `cache-type`, `jinja`, …) come from the INI (`[*]` global + `[org/MODEL:QUANT]`
  overrides; keys = CLI args sans dashes).
  Sources: [server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) ·
  [glukhov](https://www.glukhov.org/llm-hosting/llama-cpp/llama-server-router-mode/).
- **Changing a SWITCH VALUE = still a (re)start.** Per-model params are fixed by the
  INI **at startup**; the only model API is `GET /v1/models` (no runtime param-change
  endpoint). So to A/B `n-cpu-moe 36` vs `37` on the SAME model you must (re)launch
  with the new value — exactly what #19 `/load`+`Overrides` (spawn with chosen flags)
  does. So #19 stays the right tool for **switch tuning**.
- **Plane-2 params** (temperature / top-p / max-tokens / json-schema /
  reasoning-budget) are **per-request** (`dispatch.chat` body) → no restart, ever.

**Router VRAM behavior (CORRECTED 2026-06-24 by the deep-research report
`2026-06-24-small-vram-multimodel-research.md`):** registered ≠ loaded — a model
loads into VRAM **lazily on first request**; up to `--models-max` (default **4**)
co-reside, each in its own **child process** (crash isolation). The router **DOES
auto-evict via LRU** at the `--models-max` COUNT cap (`unload_lru()` in
`server-models.cpp`, called from `load()`). **Nuance:** eviction triggers on the
COUNT, not VRAM pressure — a model bigger than *remaining* VRAM **errors** rather
than evicting (that's the #18939 OOM case). ⚠️ An earlier version of this note
wrongly said "router never auto-evicts" — that came from one forum thread (#18939)
and was overturned by source-code-verified multi-source research; don't repeat it.
For ONE model in VRAM, pass **`--models-max 1`** (forces evict-before-load);
`/models/unload` frees VRAM explicitly; llama-swap's per-model `ttl` does idle-unload.

**✅ VERIFIED EMPIRICALLY (2026-06-25 local test) — per-model INI switches DO apply
on hot-swap, router parent NOT restarted.** The user asked the exact question:
*"can we hot swap between models — say an MoE and a dense — with different switches,
as long as they're in the INI, WITHOUT restarting the server?"* I ran it directly
(this was previously only an inferred-from-source claim; now it's observed). Setup:
real `llama-server` **b9786** (latest release, Linux x64 CPU build), two tiny GGUFs
(Qwen2.5-0.5B-Instruct-Q4_K_M as `modelA`, SmolLM2-135M-Instruct-Q4_K_M as `modelB`),
a `--models-preset` INI giving each model **deliberately different switches**, started
with **no `-m`** + `--models-max 2`. (Test artifacts: `scratchpad/router-test/` —
`preset.ini`, `run-test.sh`, `router.log`.)

The INI (keys = CLI args sans dashes, `[*]` global + per-model section, exactly the
README contract):
```ini
version = 1
[*]
ctx-size = 768
[modelA]                       ; Qwen2.5-0.5B (dense)
model = …/qwen2.5-0.5b-instruct-q4_k_m.gguf
ctx-size = 2048
cache-type-k = q8_0
cache-type-v = q8_0
flash-attn = on
parallel = 1
[modelB]                       ; SmolLM2-135M — DIFFERENT switches
model = …/SmolLM2-135M-Instruct-Q4_K_M.gguf
ctx-size = 333
cache-type-k = f16
parallel = 2
```

Observed (verbatim `/proc/<pid>/cmdline`, router shell-PID **7375** throughout):
- **After boot:** ONE process (the router, PID 7375). `GET /v1/models` lists `modelA`,
  `modelB` both `status: unloaded`. → registered ≠ loaded; autoload is lazy.
- **Hit `modelA`** (chat request, `"model":"modelA"`) → router spawned a **child PID
  7400, PPID 7375**:
  `llama-server --host 127.0.0.1 --port 39163 --alias modelA --ctx-size 2048
  --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn on --model …qwen…q4_k_m.gguf
  --parallel 1` — **modelA's exact INI switches**. Returned `"Hello."`.
- **Hit `modelB`** → router spawned a **second child PID 7437, PPID 7375**:
  `llama-server --host 127.0.0.1 --port 39295 --alias modelB --ctx-size 333
  --cache-type-k f16 --model …SmolLM2…Q4_K_M.gguf --parallel 2` — **modelB's exact,
  DIFFERENT INI switches** (ctx 333 is impossible-as-a-default → proves the per-model
  value was applied). Returned `"Hello!"`.
- **Router PID 7375 unchanged across both loads** (`kill -0` confirmed alive); both
  children co-resident under it (`--models-max 2`); each child is a **separate
  `llama-server` process on its own auto-assigned port**.

**Conclusion (now directly verified, not inferred): YES.** Router mode runs each
model as its own child `llama-server` launched with **that model's** INI switches, on
demand, while the router parent stays up — so two models with different switch sets
(e.g. an MoE with `n-cpu-moe=N` and a dense with `n-gpu-layers=X`) hot-swap with no
router restart. **Caveat tested-around:** `--n-cpu-moe` itself is **GPU-only** and
this box is CPU-only, so I proved the *per-model-switch-application mechanism* with
`ctx-size`/`cache-type`/`flash-attn`/`parallel` instead; `n-cpu-moe` rides the same
INI→child-argv path (it's just another `key = value` line, confirmed present in
`--help` as `-ncmoe, --n-cpu-moe N`), so an MoE model's offload switch would be passed
to its child identically. **Switch-VALUE changes on the SAME model still need a child
(re)load** (the child's argv is fixed at its spawn) — unchanged from above; that's
what #19's `/load`+`Overrides` does. **`--models-max` is COUNT-based, not VRAM-aware**
(run-2 caveat stands): with `--models-max 1`, loading modelB would LRU-evict modelA;
a model bigger than *remaining* VRAM errors rather than evicting.

**Why we run RAW `llama-server` (not Ollama/LM Studio) — verified 2026-06-24:** the
MoE-expert CPU offload (`--n-cpu-moe`) that fits a 35B-A3B on 6 GB is the deciding
switch, and the GUIs don't reliably expose it. **Ollama** exposes `num_gpu`(≈ngl) /
`num_ctx` / `OLLAMA_KV_CACHE_TYPE` / flash-attn but has **no native `--n-cpu-moe`**
(open request [ollama#11772](https://github.com/ollama/ollama/issues/11772); only
whole-layer auto-offload). **LM Studio** exposes most core flags + HAD a real
`--n-cpu-moe` toggle ("Force Expert Weights onto CPU"), but **v0.4.0 regressed it** to
a less-effective layer slider ([lmstudio#1421](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1421)).
**llama-swap** ([repo](https://github.com/mostlygeek/llama-swap)) fronts ANY
OpenAI-compatible backend (llama.cpp/vLLM/tabbyAPI) with TTL unload, but native router
mode makes it redundant for our llama.cpp-only case.

**Our current runner vs router mode (architecture fork — deep-dive, task #27, don't
rush).** Today `RunnerService` (`lifecycle.py`) spawns ONE single-model `llama-server`
and stops it to switch (`LuModelCatalog.vue:156`). Router mode is the better fit for
**production model-serving** (live per-feature routing, per-model INI); #19's
spawn-with-overrides stays right for **switch tuning**. Reconcile before changing it.

**Consequences for #20/#21 (corrected):**
- #20 "apply a switch VALUE" = a model reload (show a reloading state). Changing the
  MODEL (not its switches) can be live via router.
- #21 Compare: **cloud columns = parallel; different-MODEL local columns can
  co-reside up to `--models-max` (VRAM permitting) via router; same-model
  different-SWITCH-VALUE columns = serial** (each needs a (re)start). NOT "all local
  columns serial," as I first wrote.

**Bundled llama.cpp vs Ollama (CORRECTED).** Both speak OpenAI HTTP. **Ollama** =
model-manager daemon (live swap, keep-alive eviction; hides low-level switches).
**`llama-server` is NO LONGER one-model-only** — its **router mode** also swaps
models live; the real remaining differences: llama.cpp exposes the FULL switch
surface (why we use it for tuning) but its per-model switches are INI/startup-fixed
(no runtime change), and it's ~1.5–1.8× faster
([itsfoss](https://itsfoss.com/llama-cpp/)). We support both as providers
(`llm/ollama.py` + bundled). [llama-swap](https://www.nijho.lt/post/llama-nixos/)
predates router mode and is now largely redundant with it.

**Implication for quick/accuracy + QuickSetup (#11), corrected:** two DIFFERENT
local models for quick vs accuracy is **fine via router mode** (both registered;
co-resident if `--models-max` ≥ 2 + VRAM allows, else a live router swap — NOT a
process restart). The earlier "reload thrash → don't" was the wrong-premise version.
Still useful on a tight GPU: prefer (a) one model + `think:true` for accuracy, or
(b) cloud-quick + local-accuracy, to avoid even router swaps.

### To build (the "expose everything configurable to the GUI" ask)
1. ✅ **Plumb `Overrides` through `/load`** (#19, done 2026-06-24) — `LoadRequest`
   accepts `nGpuLayers`, `nCpuMoe`, `ctxLen`, `cacheTypeK/V`, `flashAttn`, `noMmap`,
   `mlock`, `noKvOffload`, `batchSize`, `ubatchSize`, `threads`, `threadsBatch`,
   `parallel`, `contBatching`, `cacheReuse`, `specType`(+`specNMax`), `extraFlags`
   → `Overrides` → `compute_fit`/`compose_flags`/`start_runner`. `--no-mmap` /
   `--no-kv-offload` / `--no-cont-batching` are now composable.
2. **Per-local-model tuning UI** (in AI ▸ Providers, on the model card): sliders/
   inputs for `n_cpu_moe`, `n_gpu_layers`, `ctx`; toggles for flash-attn, no-mmap,
   mlock, KV type (q8_0/turbo*), spec (off/draft-mtp/ngram-mod) + n-max, jinja —
   with a **tokens/sec readout** so the user finds the fast split on THEIR machine.
3. **Switch testing = Compare columns, not a separate panel** (see AI-stack plan
   Decision 23): each Compare column = a model + a full switch set + prompt; run one
   action across columns; rank by tokens/sec · time · quality on real text. The
   per-model tuning UI sets a model's default switches; Compare A/Bs them.

### Which switches matter for which of OUR features
- **Attribution / extraction / critique (hard, structured):** these are where small
  dense models fail; the **35B-A3B MoE via `--n-cpu-moe`** is the budget pick →
  `-ngl 999 --n-cpu-moe <fit> --no-mmap --mlock`, KV `q8_0`, **spec OFF**, ctx sized
  to a chapter. (JV speaker_attribution is the same shape — shared runner.)
- **Prose / rewrite (dense, quality-led):** a dense MTP-GGUF → `draft-mtp` spec ON
  for speed; or route to cloud (Claude) where prose still leads.
- **RAG / "Ask the book":** modest ctx, q8_0, embeddings via Qwen3-Embedding /
  nomic-embed (separate from the chat model).
- **Brainstorm / quick drafts:** small dense (8–12B), nothing fancy.

---

## Open questions (for the user / to measure)
- Ship the TurboQuant fork at all, or stay stock llama.cpp + `q8_0`? (turbo* is
  experimental, sometimes slower, needs a source build — lean: stock default,
  turbo* as an advanced opt-in we measure.)
- Add `--no-mmap` to the `base` preset, or expose as a per-model toggle? (lean:
  toggle, default on for MoE-offload models.)
- Do we bother with the MTP quant for the 35B-A3B given spec doesn't help it in
  llama.cpp? (lean: prefer the plain `bartowski Q4_K_M` for A3B; reserve MTP quants
  for dense models where spec wins.)
