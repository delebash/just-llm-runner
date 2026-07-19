# llama.cpp upstream watch — review ledger

**Purpose.** A durable anchor + running log so "check llama.cpp since our last
update" has a precise starting point and a place to record findings. This is the
*adoption* watch — "what changed upstream that's worth pulling into our adapter /
config / knob code" — NOT the in-app binary-bump check, which already exists
(see below). Manual by design (2026-07-14 decision: ledger-only, user-driven).

## How to use

Say **"check llama.cpp since our last update"**. The reviewer (me) then:
1. Reads the **Last reviewed** tag below (the `since` anchor).
2. Pulls the release notes between that tag and the latest upstream tag.
3. Runs the **Review checklist** against them and flags anything worth adopting.
4. Appends a row to the **Review log** and bumps **Last reviewed**.

**How the reviewer reaches upstream (verified 2026-07-14).** The block is GitHub
**repo-scoping**, not the network policy: `curl`, the `api.github.com` REST path,
and the scoped GitHub MCP all return **403** for `ggml-org` (the proxy injects a
token scoped to the delebash repos — `api.github.com` root is 200, the ggml-org
path is 403; `llm_runner/runner/lifecycle.py:299` predates this finding). **But the
WebFetch tool reads the releases page fine** — it routes through Anthropic's fetch
infra, bypassing that github proxy — so the review CAN run from this environment:
- `WebFetch https://github.com/ggml-org/llama.cpp/releases` — newest ~10 builds;
  page older windows with `?page=2`, `?page=3`, … back to the `since` tag.
- `.../compare/<since>...<latest>` lists raw commits (finer-grained, much longer).
- The runner's *own* in-app check (`lifecycle.py:296`, plain `requests`) still needs
  the user's box — it goes through the local proxy, so it 403s here.

## Current state

- **Pinned build:** `b9993` — `llm_runner/runner/config.py:39` (`DEFAULT_PINNED_BUILD`).
  Bumped from `b9899` on 2026-07-14 (Unit 2 engine bump; every `DEFAULT_BINARIES` filename
  re-verified against b9993's real asset list via `gh api releases/tags/b9993`). Upstream
  latest at the bump was `b10012` (unreviewed — b9993 chosen deliberately).
- **In-app binary-bump check already exists** (separate from this ledger): the app,
  running on the user's box, calls `_fetch_latest_llamacpp_tag()`
  (`llm_runner/runner/lifecycle.py:296-306` → `releases/latest`) and `update_check`
  (A5) compares it to the pin and offers an "update" in the UI. That answers
  "is there a newer binary"; THIS ledger answers "is there anything worth adopting
  in our code".

## Watch list — forward-looking (not-yet-merged upstream we're tracking)

Distinct from the retrospective "Adoption candidates" below: things NOT yet in a
pinnable build that we want to be told about the moment they land.

- **Ternary Bonsai / Q2_0 CUDA support (added 2026-07-19).**
  - **What:** PrismML's Ternary Bonsai models (Qwen3.6-27B ternary, ~1.71 bits/weight,
    ~6.7 GB deployed, Apache-2.0, 262k ctx) need the **Q2_0** quant type. Upstream status
    (2026-07-19): CPU (#24448) + Metal (#25419) + **Vulkan (#25430)** Q2_0 merged — this is
    the `b9913` "new Q2_0 quant type" line noted in the Adoption candidates — but **CUDA
    (#25707) is still an OPEN PR**, so there is no NVIDIA path on mainline yet, and PrismML's
    own docs say stock builds can't run it (GPU today = their fork, which we'd never ship).
  - **Watch for:** the **CUDA Q2_0 PR merging into a pinnable release**
    (https://github.com/ggml-org/llama.cpp/pull/25707), plus the group-size churn settling
    (fork's g128 files → mainline standardized on g64, `_Q2_0_g64.gguf`, renames pending).
  - **Then:** promote the IDEAS item → a **2070S Lab A/B vs Gemma 26B-A4B** for the 8 GB
    class (evidence-not-press-release — the catalog law). 27B-class quality resident on an
    8 GB card would be a real contender for that rung.
  - **Cross-ref:** `justwrite-app/docs/IDEAS.md` → "Ternary Bonsai-27B" · the
    whole-system tracker `justwrite-app/docs/TASKS.md`.

## Baseline — capabilities we already rely on (as of the b9899 pin)

Verified against upstream builds in code (so a reviewer knows what's already adopted):

- **b9644** — `POST /models/load` is asynchronous (2xx accepts; child loads in the
  background); per-model status is nested at `data[].status.value`; server-side
  `{"type":"json_schema","schema":…}` structured output; auto-offload of an
  over-fit model. Refs: `lifecycle.py:57,171,191,200,1722,1786`, `prompts.py:350`,
  `process.py:90,94,133`.
- **b9870** — tensor-placement behavior our launch profile assumes; ctx is always
  emitted (ctx policy is ours). Refs: `openai_compat.py:108`, `process.py:112`.
- **Sampler order** — our `DEFAULT_SAMPLER_ORDER` tracks llama.cpp's 9-name set
  (penalties + `top_n_sigma` included).
- Build-tag parsing (`"b9929" → 9929`): `llm_runner/runner/binary.py:101`.
- **b9982 (adopted at the b9993 bump, 2026-07-14)** — per-request reasoning budget. The
  server chat endpoint reads request-body key **`reasoning_budget_tokens`** (alias
  `thinking_budget_tokens`), grepped from source `tools/server/server-common.cpp`
  (`int reasoning_budget = json_value(body, "reasoning_budget_tokens", …)`). Semantics
  (`common/common.h`): `-1` = unlimited/disabled, `0` = suppress thinking, `N>0` = cap at N
  tokens. The body value OVERRIDES the `--reasoning-budget` launch flag unconditionally (no
  `launch==-1` gate — `tests/test-chat.cpp::test_reasoning_budget_tokens_per_request`). This
  is the key **U2-T5** emits so the built-in runner honors low/med/high; our launch profile
  stops emitting `--reasoning-budget` (leaves the engine default -1) and sends the resolved
  number per request.

## Review checklist (run every review)

- **Samplers / params** — new or renamed sampler/penalty knobs; changes to defaults
  or to the sampler-order vocabulary (→ `DEFAULT_SAMPLER_ORDER`, knob catalog).
- **Server API** — `/models/load`, `/completion`, `/props`, `/v1/*` shape/semantics
  (esp. anything our `lifecycle.py` / `openai_compat.py` assumes: async load, nested
  status, error shapes).
- **Structured output** — `json_schema` / GBNF grammar support changes.
- **GGUF / quant / format** — new quant types, metadata keys, or format bumps that
  affect `runner/gguf_remote.py`, fit estimation, or the catalog.
- **Model architectures** — newly supported arches (catalog / detection relevance).
- **Perf / memory flags** — cache types (`--cache-type-*`), offload/`-ngl`, mmap/mlock,
  batching, speculative decode — anything that changes our switch defaults.
- **Breaking changes** — any switch we set that upstream renamed/removed/re-defaulted.
- **Binaries** — asset naming / CUDA-runtime companion changes affecting
  `DEFAULT_BINARIES` + `runtime_url` plumbing (`runner/download.py`, `runner/binary.py`).

## Adoption candidates — open (from the 2026-07-14 review, b9899 → b9993)

None forces a code change; ranked by value to our surfaces. Only builds **>b9899**
(everything ≤ our pin is already in our build). Grounded to our code where noted.

**1. Bump the engine build `b9899` → `b9993` (highest leverage).** One pin bump pulls
in every backend perf + correctness fix below for free — same mechanism as the last
bump (`DEFAULT_PINNED_BUILD`, `llm_runner/runner/config.py:39`; precedent = the b9899
bump). Needs a box test (binary download + a load). NOT done here — flagged for your word.

**2. Reasoning / thinking — strongest cluster, with a real gap it fixes.** Our
low/medium/high effort is translated per provider (Ollama → native `think` level,
`ollama.py:95`; Anthropic → `budget_tokens` 1024/4096/8192, `anthropic.py:80`; OpenAI
clouds → `reasoning_effort`, `openai_compat.py:125`), **BUT the built-in llama.cpp
runner ignores the level** — it sends only on/off `enable_thinking` and discards effort
(`openai_compat.py:117-119`). So low/med/high is a **no-op on the local provider today**
(on/off works + is box-verified, `openai_compat.py:107-112`).
- **b9982** — server now honors a *per-request reasoning budget* → THE fix that lets us
  map effort→budget on the local runner (mirror the Anthropic 1024/4096/8192 map) so
  low/med/high finally does something locally. Requires the engine bump (#1).
- **b9986** — chat-template reasoning-leak fix (force-opened bare templates) → may
  remove reasoning-model output we currently post-process.
- **b9945** — thinking-probe moved inside the init try/catch (robustness).

**3. VRAM / KV-cache correctness (our fit VRAM query; quantized KV `cache-type q8_0`):**
- **b9974** — CUDA: no crash querying memory on a device with no free VRAM → hardens
  our NVIDIA fit path directly.
- **b9905** — fix quantized kv-cache for DeepSeek-V4 → we run quantized KV; verify.
- **b9908** — server enforces a prompt-cache RAM limit · **b9948** — CUDA
  top_k/argsort use smaller temp buffers (VRAM headroom).

**4. Sampling params (our 9-name order):** **b9967** — server now accepts *null*
sampling params → confirm our adapter can omit params without tripping the old reject.

**5. Streaming / progress:** **b9909** timings+progress on the stream · **b9923** SSE
replay buffer · **b9971** server_stream refactor (watch for streaming regressions).

**6. Spec-decode / draft models (a knob):** **b9910** draft fit-vs-load fix · **b9964**
no duplicate spec-model downloads · **b9993/b9990** new-arch spec-decode (Hunyuan3, Minimax2).

**7. Misc correctness:** **b9917** tokenizer OOB-read fix · **b9975** gguf rejects empty
metadata keys · **b9913** new Q2_0 quant type (catalog enumeration).

**Backend perf — free on the engine bump, no code for us:** NVIDIA b9992 (Blackwell),
b9911 (NVFP4), b9937 · AMD Vulkan b9932 (GCN FA), b9929 (small GPUs) · Intel SYCL b9985
(fused top-k MoE), b9984, b9901.

## Review log

| Date reviewed | `since` tag | Latest tag seen | New builds | Relevant? | Action |
|---|---|---|---|---|---|
| 2026-07-14 | b9899 (pin) | b9993 | b9900–b9993 (releases pp.1–10) | Yes | Full review done via WebFetch. Candidates recorded above; nothing forces a change. Top flag: engine bump b9899→b9993 (awaits box test + your word). |
| 2026-07-14 | b9993 | b10012 | — | — | **Engine bump EXECUTED** b9899→b9993 (Unit 2, user "do the bump and do it all"): adoption candidates #1 (bump) + #2 (per-request reasoning-budget key `reasoning_budget_tokens`, grepped from source) taken; assets re-verified via `gh api releases/tags/b9993`. Upstream latest = b10012 (unreviewed; b9993 chosen deliberately). Box test (b9993 download + model load + a local High chat watching thinking stop at the cap) = the Unit-2 acceptance step. |

**Last reviewed:** `b9993` · 2026-07-14 (pin now b9993).
