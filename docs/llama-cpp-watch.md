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
path is 403; `_fetch_latest_llamacpp_tag` in `llm_runner/runner/lifecycle.py` predates this finding). **But the
WebFetch tool reads the releases page fine** — it routes through Anthropic's fetch
infra, bypassing that github proxy — so the review CAN run from this environment:
- `WebFetch https://github.com/ggml-org/llama.cpp/releases` — newest ~10 builds;
  page older windows with `?page=2`, `?page=3`, … back to the `since` tag.
- `.../compare/<since>...<latest>` lists raw commits (finer-grained, much longer).
- The runner's *own* in-app check (`_fetch_latest_llamacpp_tag`, plain `requests`) still needs
  the user's box — it goes through the local proxy, so it 403s here.

**On the author's Windows box (verified 2026-09-19) everything is reachable directly** — the
403 above is the dev container's proxy, not GitHub. The method that reviewed 1,064 commits in
one sitting:
- `gh api repos/ggml-org/llama.cpp/releases/latest` and `…/releases?per_page=100&page=N` (the
  `gh` login gives 5,000 requests/hour; unauthenticated is 60).
- **Every commit title in the window, with its build tag:** a treeless clone (commits only, a
  few MB) in a scratch dir —
  `git clone --filter=tree:0 --no-checkout --single-branch --branch master https://github.com/ggml-org/llama.cpp`
  then `git log --reverse --format='%D|%ad|%s' --date=short <since>..HEAD`. Build number =
  commit count, so `bNNNN` decorates the commit. Read them ALL; titles such as "various bug
  fixes" hide things, so open the PR for anything near our surfaces.
- **Any file at any tag:** `curl -sfL https://raw.githubusercontent.com/ggml-org/llama.cpp/<tag>/<path>`.
  The files this review leaned on: `common/arg.cpp` (every flag), `common/preset.cpp`
  (`models.ini` keys), `tools/server/server-common.cpp` (request parsing),
  `tools/server/server-models.cpp` (router), `src/llama-model-loader.cpp`, `src/llama-model.cpp`,
  `src/llama-kv-cache-iswa.cpp`, `common/common.h`.
- `gh api repos/ggml-org/llama.cpp/pulls/<n> --jq '.title, .merged_at, .body'` for a PR's own
  words; `…/releases/tags/<tag> --jq '.assets[].name'` for the real download names.
- Upstream now writes **curated notes** on each stable release (`v0.4.0`, `v0.4.1`: API
  changes · New models · Core · Server). Read them, but they are not a substitute for the
  commit list — the flag removal that breaks us was one line in them.

## Current state

- **Pinned build:** `b10750` — `DEFAULT_PINNED_BUILD` in `llm_runner/runner/config.py`
  (line anchors in this doc went stale once — cite the SYMBOL, grep for the line).
  Bumped from `b9993` on **2026-09-19** (user: *"go pin b10750"*) after this review, a box
  test and a bisect. **Chosen by measurement, not recency**: b10750 is the LAST BUILD
  BEFORE `b10751` broke MTP speculative decoding (the warning at the top of the watch
  list). On the flagship it runs at **1.028 ×** the author's b10437 with the MTP draft, is
  output-EXACT, and produces byte-identical text to b10437 — and unlike b10437 it has an
  asset for EVERY platform row (it is past the b10398-b10581 Linux-AMD hole, which is why
  the faster-looking b10437 could never be the pin). All seven filenames re-verified
  against `gh api releases/tags/b10750` on 2026-09-19. Earlier: `b9899` → `b9993`
  2026-07-14 (Unit 2 engine bump).
  **The build on the author's disk is `b10437`** (installed through the in-app update on
  2026-08-15, the day upstream published it, while the check still worked) — every
  September 2026 measurement (speed truth, vram truth) is on that build. Both app DBs
  held the old pin `b9993` until the user updated them both to `b10750` on 2026-09-20, so
  pin and disk now agree in both apps. (`DEFAULT_PINNED_BUILD` only ever reaches fresh
  installs and "reset to defaults", never an existing database - that is why they diverged.)
- **Upstream changed its release scheme on 2026-08-21.** Every `bNNNN` build is now a
  **prerelease**; stable versions are semver tags (`v0.2.0` → `v0.4.1`), each carrying one
  asset, `nightly-tag.txt`, that names its build (`v0.4.1` → `b10964`). Upstream: `vX.Y.Z` =
  "stable … recommended for downstream distribution"; `b[NUM]` = "bleeding edge". The binaries
  still live on the `bNNNN` release.
- **The in-app binary-bump check was DEAD from 2026-08-21 — FIXED 2026-09-19.**
  `_fetch_latest_llamacpp_tag()` (`releases/latest`) answered `"v0.4.1"`, `binary.build_num`
  stripped that to `41`, and `41 > 10437` is false — so `update_check` reported "current"
  with no error and the Update button never rendered. Reproduced with the app's own
  functions, then fixed: `_fetch_latest_llamacpp_release()` follows the stable channel
  (tag → `nightly-tag.txt` → build) and `build_num` is STRICT, so a semver tag can never
  read as a build. Verified live: `{"latest":"b10964","latestStable":"v0.4.1",
  "updateAvailable":true}`. Plan + execution record:
  `docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md`. That check answers "is
  there a newer binary"; THIS ledger answers "is there anything worth adopting in our code".

## Watch list — forward-looking (not-yet-merged upstream we're tracking)

Distinct from the retrospective "Adoption candidates" below: things NOT yet in a
pinnable build that we want to be told about the moment they land.

- **⚠ MTP SPECULATIVE DECODING IS BROKEN from `b10751` onward — BISECTED 2026-09-19.**
  **First bad build `b10751` = `cuda: fuse MoE weighted expert reduction` (#25952).** It
  fuses the MoE combine tail into one CUDA kernel, changing the ORDER of floating-point
  accumulation over experts; the target's logits shift, the draft's argmax stops matching,
  acceptance halves (0.823 → 0.481) and the drafted output stops equalling the build's own
  greedy output. CUDA-only, MoE-only. On the flagship: b10964 runs at **0.784**, b11056 at
  **0.814** and **b11057 (head, measured) at 0.798** of b10437, while
  tying without a draft (0.995) — on those builds the draft is a NET LOSS. All three
  produce the SAME drafted sha `4683af3bc3b2`, so it is one regression, unchanged.
  **Do NOT pin b10964, b11056, or anything ≥ b10751 until upstream fixes it.**
  **The last good build is `b10750`**, and it BEATS the author's b10437: +draft 46.35 tok/s
  (**1.028×**), no draft 38.10, EXACT, byte-identical output to b10437, and every platform
  row resolves (it is past the b10398-b10581 Linux-AMD hole, so unlike b10437 it is viable
  as a default pin). Evidence + the 8 probed builds: `docs/dev/TASKS.md`, plan §9.
  **REPORTED UPSTREAM 2026-09-19: ggml-org/llama.cpp#29168** (bisect, the exactness test,
  the numbers, the one-commit attribution). **Watch for:** its resolution. Every pin bump from here re-measures before the pin moves.
- **RESOLVED 2026-09-19 — the Ternary Bonsai / Q2_0 item below.** CUDA Q2_0 (#25707) merged
  2026-07-30; the first build carrying it is **`b10192`**, so the author's installed `b10437`
  has it. Group size settled on g64 — the author already has
  `Ternary-Bonsai-27B-Q2_g64.gguf` in the shared cache. The "Then" step is now live (a 2070S
  Lab A/B vs Gemma 26B-A4B) and needs its own go. It cannot enter the catalog until the pin is
  ≥ `b10192` (a fresh install's `b9993` cannot run it on CUDA). The original entry is kept
  below as the record.
- **Next stable after `v0.4.1` (added 2026-09-19).** Landed upstream after the `b10964` cut and
  worth having: **Linux NVIDIA CUDA tarballs** (`b10969`+:
  `llama-<b>-bin-ubuntu-cuda-12.8-x64.tar.gz` plus a *build-tagged*
  `cudart-llama-<b>-bin-ubuntu-cuda-12.8-x64.tar.gz`, also `cuda-13.3` x64/arm64) — this retires
  our docker-only seam row and the Vulkan fallback for Linux+NVIDIA · **CUDA graphs for the MTP
  draft** (#28549, `b11007`, upstream "+4–5 %") · **graceful allocation-failure handling**
  (`b11036`, `b11040` — a cleaner signal for our OOM back-off) · the Windows CUDA 13 asset
  moving `13.3` → `13.4` (`b10977`). **Watch for:** the next `vX.Y.Z` on the releases page.
- **An opt-out for the machine-wide config file (added 2026-09-19).** Since `b10398` (#26118)
  every llama.cpp program reads `%PROGRAMDATA%\llama.cpp\config.ini` and
  `%APPDATA%\llama.cpp\config.ini` (`/etc/llama.cpp/config.ini`, `~/.config/llama.cpp/config.ini`)
  at the lowest precedence. There is **no flag or env var to disable it** (`b10437`, `b11056`
  source). Our launches inherit anything in it that we do not pass ourselves — an `api-key`
  line would 401 every request. **Watch for:** an opt-out; then pass it.
- **TTS inside llama.cpp (added 2026-09-19, for JustVoice).** `llama-tts` runs **Qwen3-TTS**
  (`b10270`, #26254 — the *Base* checkpoint only, i.e. clone from `--tts-speaker-file`; ten
  languages) and **Pocket-TTS** (`b10369`, #26871). CLI only: at `b11056` llama-server exposes
  `/v1/audio/transcriptions` and no speech endpoint. The Pocket PR names **Chatterbox** as a
  future target. **Watch for:** a server-side speech endpoint, and the VoiceDesign /
  CustomVoice checkpoints — without both this cannot replace a PyTorch engine.
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
  - **Cross-ref:** this repo's `docs/dev/IDEAS.md` → "Ternary Bonsai / Q2_0" (the
    runner owns the catalog; moved from JW's tracker in the 2026-08-04 campaign).

## Baseline — capabilities we already rely on (as of the b9899 pin)

Verified against upstream builds in code (so a reviewer knows what's already adopted):

- **b9644** — `POST /models/load` is asynchronous (2xx accepts; child loads in the
  background); per-model status is nested at `data[].status.value`; server-side
  `{"type":"json_schema","schema":…}` structured output; auto-offload of an
  over-fit model. Refs: `lifecycle.py:57,171,191,200,1722,1786`, `prompts.py:350`,
  `process.py:90,94,133`.
  **CORRECTION 2026-09-19 — the structured-output clause is WRONG for `b9993`+.** The server
  README documents that flat form, but `tools/server/server-common.cpp` (identical at `b9993`,
  `b10437`, `b10964`) reads a `json_schema` schema ONLY from the nested OpenAI form
  (`response_format.json_schema.schema`); the flat `schema` key is honoured only for
  `type: "json_object"`. **Observed** on `b10437`: flat = not enforced (the model answered with
  weather fields), nested = enforced. Our adapter (`openai_compat._adapt_response_format`)
  flattens on purpose, so every schema-carrying action runs unconstrained on the local engine
  today — one seeded action on the author's DBs (JustWrite `entitySweep`). Fix = Slice 0 of
  `docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md`.
- **The loading flags moved (recorded 2026-09-19).** `--load-mode` arrived at `b10105`
  (#20834) with `none|mmap|mlock|dio`; `b10145` (#26135) added `mmap+mlock` and made `mlock`
  mean lock WITHOUT mmap; `auto` became the default around `b10369` (#26081); `b10875`
  (#28334) **deleted** `--mlock`, `--mmap`/`--no-mmap`, `--direct-io`. From `b10105` the legacy
  flags ASSIGN one mode each — beside one another "only the last flag … will take effect" —
  so on `b10437` our `--mlock --no-mmap` pair is just `none`, and `--mlock` alone is no longer
  mmap + lock. Full table + the emit mapping: that plan's §3.3.
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
- **Placement rules the fit copies** (vram-truth plan 2026-09-19 §2.1) — on EVERY
  pin bump re-read and re-quote: `src/llama-model.cpp` `i_gpu_start = n_layer_all +
  1 − n_gpu_layers` / `act_gpu_layers` / "always keep [the input layer] on the CPU"
  (→ `fit.engine_gpu_blocks`, `process.engine_ngl_flag`); the tied-head
  `TENSOR_DUPLICATED` idiom (e.g. `src/models/gemma4.cpp`); `common/common.h`
  `LLM_FFN_EXPS_REGEX` (→ `gguf.EXPS_REGEX` — it gained `gate_up` since b6895);
  `llama-fit-params` `-fitp` output shape (the validation oracle). Then re-run the
  plan's Step 0b on one MoE + one dense model: predicted vs engine model-MiB < 1 %.
- **Binaries** — asset naming / CUDA-runtime companion changes affecting
  `DEFAULT_BINARIES` + `runtime_url` plumbing (`runner/download.py`, `runner/binary.py`).
  List the target's REAL names (`gh api …/releases/tags/<b> --jq '.assets[].name'`) and compare
  **every row**, not just the one the author's box uses: between `b9993` and `b11056` the
  Windows AMD, Linux AMD and Windows CUDA-13 names all changed and Linux AMD vanished for ~180
  builds, while the author's CUDA-12 row never moved.
- **Every flag we emit, against the target's `common/arg.cpp`** (added 2026-09-19 — the check
  that would have caught the `--mlock`/`--no-mmap` removal). The list lives in
  `process._VALUE_FLAGS` + the presence/spec branches of `process.overrides_to_pairs` + the
  router argv in `process.start_router`; grep each `"--flag"` in `arg.cpp` at the installed
  build, the target and latest. Once the plan's Slice 1 is in, `process.probe_argvs(<build>)`
  run against the real exe does this mechanically — **flags first, `--version` last**
  (`--version` first tests nothing: args parse in order and it exits on sight).
- **The release scheme itself** (added 2026-09-19) — is `releases/latest` still a `vX.Y.Z`
  tag carrying `nightly-tag.txt`? The in-app update check depends on it
  (`lifecycle._fetch_latest_llamacpp_release` once Slice 3 is in).
- **Request parsing we rely on** (added 2026-09-19) — re-read `oaicompat_chat_params_parse` in
  `tools/server/server-common.cpp` for `response_format`, `reasoning_budget_tokens` and
  `chat_template_kwargs`; trust the code over the README (they disagreed about the flat
  `json_schema` form for months). Once Slice 0 is in, run `scripts/check-structured-output.py`
  against the target build.
- **Bad build ranges** — before choosing a pin, search the window for regressions that were
  later fixed and keep the pin outside them. Known: `b10121`–`b10267` (macOS ≤ 15 binaries,
  #26375) · `b10398`–`b10581` (no Linux ROCm asset) · `b10741`–`b10748` (Gemma-4 assistant MTP
  draft, #28159 → #28183).

## Adoption candidates — open (from the 2026-09-19 review, b9993 → b11056)

1,064 commits read, plus the four stable releases' notes. **Three of these are defects in OUR
code, not upstream features** — they lead. Evidence, code and the build order for items 1–4
and 8: `docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md` (its §3 is the
receipt set; do not re-derive).

**1. The in-app update check is dead** (see Current state). Follow the stable channel.
**Must land AFTER 2 and 3** — today the dead check is the only thing stopping a user from
updating into an engine that rejects our flags.
**2. `--mlock` / `--no-mmap` are deleted from `b10875`** — and already mean something else on
`b10437`. Render `--load-mode` for engines ≥ `b10145`; add an install-time flag-acceptance
probe so a future removal can never brick an install again (the existing `--version` check
passes on any build, and the old engine is then swept).
**3. Upstream renamed download files** — resolve names from the target release's own asset
list per `(platform, gpu)`; refuse up front when this machine's row has none; restore the pin
when an install fails.
**4. Pin moved `b9993` → `b10750` (2026-09-19). The plan's target `b10964` was REFUSED by
the box test.** See the MTP warning at the top of the watch list: b10964 costs ~22 %
on the flagship's MTP path and its speculation is no longer exact. What the newer builds DO
buy, measured here: **+2.5 %** on the flagship with no draft (b11056 38.11 vs b10437 37.19)
— i.e. all the CUDA MoE work (#27621, #25952, #27978) nets to that on this card. The
non-speed gains are the better argument and still stand: CUDA `mmid`/`mmf` race fixes
(#28475), the f16 FA barrier fix (#27870), CUB argsort corruption (#28389), lower RAM peak
while loading (#27483), the router LRU-hang fix (#28539), `--kv-unified-per-slot` (#24124 —
bears on the parked slot-aware-KV item), Linux AMD downloads returning, and Linux NVIDIA
CUDA tarballs from b10969. Already in the author's `b10437` but NOT in the pin: CUDA graphs
on Turing/Volta (`b10042`), CUDA Q2_0 (`b10192`), MTP tensors loaded only when used
(`b10212`), the `fit` MTP-block counting (`b10152`, `b10284`).
**5. Real load progress — unblocks tracker item T5.** At `b10437`+ the router stores
`meta.progress` = `{stages:[…], current, value}` from the child's `cmd_child_to_router:state`
lines and broadcasts it on **`GET /models/sse`** (`status_change`); `GET /models` still omits
it — which is exactly why the 2026-07-17 probe found nothing. The author's log shows
`stages: ["text_model","spec_model"]` with a fractional `value`. Needs an SSE-in-the-load-thread
design. *Not checked at `b9993`.*
**6. Exact bytes for built-in-MTP rows.** `b10212` (#26296) skips a model's MTP tensors unless
`--spec-type draft-mtp` is on; our tensor-table reader always counts them. Rows:
`qwen3.6-27b`, `glm-4.5-air`. Overstates (safe). *Magnitude unmeasured.* Also: GLM-4.5-Air MTP
is only supported from `b10603` (#26534) while the catalog flags it `mtp: 1`.
**7. `--n-cpu-ffn`** (`b10645`, #26622) — dense analogue of `--n-cpu-moe`; a measured-spike
candidate for a dense model that does not fit.
**8. Structured output is sent in a form the engine ignores** — see the Baseline correction.
Independent of the build; a three-line fix.
**9. Small:** `--log-jsonl` (`b10823`) if we ever classify crashes from log text ·
speculative-decoding counters on `/metrics` (`b10282`) · release attestation (`b10502`).

**Checked, no effect on us:** sampler enum + default chain identical at `b9993`/`b10437`/
`b10964` · the eleven `--spec-type` names identical · every other emitted flag present at
`b10437`/`b10964`/`b11056` · the Windows router colour bug (#28747; our log has no ANSI
escapes) · CUB argsort (#28389; GPU sampling only) · BF16 fallback (#28846; AMD) ·
`preserve_reasoning` default (#28174; we send no reasoning history) · KV PRs #27392/#26180/
#27496/#28849 · the JSON-schema `\-` pattern bug (#29127; we use no `pattern`) · the
default-port notice · lazy tensor loading (#27794). **The rules the VRAM fit copies are
byte-identical at `b10964` and `b11056`** (`LLM_FFN_EXPS_REGEX`, `i_gpu_start`, the iSWA
`size_swa` line, auto `n_parallel = 4`).

## Adoption candidates — from the 2026-07-14 review, b9899 → b9993

*(Every build below is at or under `b9993`, so with the pin now at `b10750` all of these
backend fixes ship; the code-side ideas - b9986, b9967 - remain opportunistic.)*

None forces a code change; ranked by value to our surfaces. Only builds **>b9899**
(everything ≤ our pin is already in our build). Grounded to our code where noted.

**1. Bump the engine build `b9899` → `b9993` (highest leverage).** One pin bump pulls
in every backend perf + correctness fix below for free — same mechanism as the last
bump (`DEFAULT_PINNED_BUILD`, `llm_runner/runner/config.py`; precedent = the b9899
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

| 2026-09-19 | b9993 | b11056 (stable: `v0.4.1` = b10964) | b9994–b11056 — **all 1,064 commit titles read** (treeless clone) + the four stable releases' curated notes; ~40 PRs opened; source read at b9993 / b10105 / b10145 / b10437 / b10964 / b11056 | **Yes — three are defects in OUR code** | No code changed. Found: the in-app update check dead since upstream's 2026-08-21 release-scheme change (reproduced with the app's own functions) · `--mlock`/`--no-mmap` deleted at b10875 and already re-meant on b10437 · renamed release assets break updates for AMD rows · the adapter sends `json_schema` in a form the engine silently ignores (**observed** on b10437) · real load progress now on `/models/sse` (unblocks T5) · the Q2_0 watch item resolved (b10192). Two safe probes run on the author's real b10437 exe: flag acceptance before `--version` (unknown flag → exit 1) and the flat-vs-nested schema test (CPU only). Build plan written: `docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md` (Opus executes, per-slice go). Pin still b9993. |
| 2026-09-19 (same day) | — | — | — | — | **Plan EXECUTED (user: "go do it all").** Items 1, 2, 3 and 8 BUILT and gated; all three apps green; verified live against real GitHub and the real engine. **Item 4 (pin → b10964) REFUSED BY ITS OWN BOX TEST** — on the flagship's MTP path b10964 runs at 0.784 of b10437 and its speculative output is no longer exact; b11056 the same. |
| 2026-09-19 (same evening) | b10437 (good) | b10964 (bad) | 8 builds probed of the 318 between them, on draft acceptance | **Yes — culprit named** | **BISECT (user: "go bisect").** **First bad build `b10751` = `cuda: fuse MoE weighted expert reduction` (#25952)** — it fuses the MoE combine tail into one CUDA kernel, reordering float accumulation across experts, so acceptance halves (0.823 → 0.481) and drafted output stops equalling greedy. CUDA-only, MoE-only. Last good = **b10750**, which BEATS b10437 (1.028 ×, exact, byte-identical output) and has every platform asset. **Pin moved b9993 → b10750** (user: "go pin b10750"). Every test build deleted; the author's disk left as found. Open: report #25952 upstream; and the Update button still offers the stable b10964, which is bad. |

**Last reviewed:** `b11056` · 2026-09-19 (commit-log review); **b11057 landed after it and
was MEASURED, not reviewed** — its one commit is `chat : fix gemma4 required tool grammar`
(#29115), and it carries the MTP regression unchanged. **Pin: `b10750`** (moved this day, by measurement
— the last build before the MTP regression; see Current state). The author's disk is still
`b10437`. **Nothing ≥ b10751 may be pinned until #25952's regression is fixed upstream** —
b10964 (the current stable) and b11056 (head) both fail the speed-and-exactness gate.
