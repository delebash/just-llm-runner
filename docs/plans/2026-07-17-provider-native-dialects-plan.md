# Provider layer → official vendor SDKs — 2026-07-17 plan v2 (the SDK pivot)

**This version SUPERSEDES the wire-dialect plan that previously lived in this file**
(hand-rolled Interactions/Responses HTTP + SSE parsers). The user's standing ruling
(2026-07-17, after the ecosystem survey): **adopt the official vendor SDKs** —
`openai` · `anthropic` · `google-genai` — behind the EXISTING adapter Protocol;
local llama.cpp + Ollama stay on our own adapters. What carries over from the
superseded plan (which passed a 3-lens panel): the seed flips, the reasoning-map
cascade-delete, the #12 key-field rework, the param-profile idea, the STOP protocol.
What drops: all hand-rolled wire code (SSE parsers, stream kernel, header builders) —
the SDKs own the wire.

**Executor: an Opus builder. This plan is the complete spec — execute exactly; it
pre-rules every decision. Anything not covered: STOP, record the finding in the
handoff section of the plan-doc copy, report back. NEVER decide alone. On approval
this file replaces `just-llm-runner/docs/plans/2026-07-17-provider-native-dialects-plan.md`
and is executed from there.**

**Grounding: every file:line below was read live 2026-07-17 (planner, this session).
Every SDK fact comes from the LIVE PROOF below — real API calls with the user's key
(never printed, never persisted) + installed-package introspection, not docs.**

**PANEL RECORD v2: this SDK plan passed its own fresh 3-lens panel (architecture-fit ·
reuse · grounding — three independent Opus checkers against live code) after folding
every finding; folds are ◆-marked. Verdicts: architecture PASS-WITH-FIXES (3 MAJOR —
the two compat tests that construct type "openai", the ProviderForm reasoning-column
drift, the JV reveal-route requirement) · reuse PASS-WITH-FIXES (2 MAJOR — promote
`_build_messages` + `_split_system` to base.py instead of minting third copies) ·
grounding PASS-WITH-FIXES (1 MAJOR — the alias default was unproven; RESOLVED by a
live probe, proof item 7). Plus the planner's own second pass: the frozen-bundle
note, the `test_plane2_params.py` enumeration, the dead compat reasoning branch, the
`-1` budget test case, two builder offline-introspection steps, and the CC
response_format downgrade rules.**

## 0 · Context — why

- The trigger bug: Gemini chat died `400 Unknown name "min_p"` — preset sampler rows
  flow provider-blind into `extra` (`prompts.py:348-411`), `seed.py:123-127` types
  claude+gemini as `"openai-compat"`, and `OpenAICompatAdapter` merges `extra`
  verbatim (`openai_compat.py:159-160`, `:218-220`). Google hard-rejects unknown
  fields.
- The user's architecture ruling (2026-07-17): stop hand-maintaining per-provider
  wire code; use the official SDKs. Survey verdict (recorded in the todos memory):
  LiteLLM runner-up (supply-chain incident 3/2026, ~28MB, duplicates house systems);
  aisuite/PydanticAI/Mirascope/LangChain wrong shape; any-llm/Vercel-py too young.
  Official SDKs win: vendors track their own API churn, typed params kill the
  unknown-field bug class at the boundary.
- New live finding (this proof): **the user's key cannot use 2.5-generation Gemini
  models at all** — `404 "This model models/gemini-2.5-flash is no longer available
  to new users"`. The working tier is 3.x (`gemini-3.1-flash-lite` proven end-to-end).
  Any plan step or doc that assumed `gemini-2.5-*` is dead; defaults must not bake in
  a 2.5 id.

## 0.5 · LIVE PROOF (2026-07-17, this session — the ground truth for every snippet)

Proof artifacts (ABSOLUTE paths — they live in the planning session's scratchpad,
which a fresh executor session does NOT share):
- Venv (all three SDKs installed; usable for the offline introspection steps):
  `C:\Users\danel\AppData\Local\Temp\claude\E--Dev-Web-justwrite-app\595455d1-253f-4297-bd34-fb9c6695961a\scratchpad\gproof-venv`
  (python at `…\gproof-venv\Scripts\python.exe`). If it's gone (temp cleanup),
  recreate anywhere temp: `python -m venv` + `pip install google-genai openai
  anthropic` at the pins below.
- Captures:
  `C:\Users\danel\AppData\Local\Temp\claude\E--Dev-Web-justwrite-app\595455d1-253f-4297-bd34-fb9c6695961a\scratchpad\captures\`
  — `models.json`, `chat-create.json`, `chat-stream.json`, `thinking-matrix.json`,
  `structured-response_json_schema.json`, `structured-response_schema.json`,
  `embed.json`. The builder copies these into
  `just-llm-runner/tests/fixtures/gemini-sdk/` (key material scrubbed at write
  time; before committing, grep the copies for `AIza` — any hit = STOP).

**Pinned versions: `google-genai==2.12.1`, `openai==2.46.0`, `anthropic==0.117.0`**
(transitives: httpx 0.28.1, pydantic 2.13.4).

Proven live against the real API (model `gemini-3.1-flash-lite` unless noted):

1. **Chat**: `client.models.generate_content(model=…, contents="…",
   config=types.GenerateContentConfig(max_output_tokens=…, temperature=…,
   system_instruction=…))` → `r.text`; usage = `r.usage_metadata` with
   `prompt_token_count` / `candidates_token_count` / `total_token_count`
   (+ `thoughts_token_count` when thinking); `r.candidates[0].finish_reason` is the
   `FinishReason` enum (`.name` == `"STOP"`, `"MAX_TOKENS"`, …).
2. **Stream**: `client.models.generate_content_stream(…)` yields chunk objects;
   text at `chunk.candidates[0].content.parts[*].text`; `usage_metadata` present on
   chunks — the FINAL chunk's values are authoritative.
3. **Thinking acceptance (the held-ruling table)** — every cell live:
   | model | thinking_budget=256 | =0 | thinking_level=minimal | =low | =high |
   |---|---|---|---|---|---|
   | gemini-3.1-flash-lite | OK (144 thought tok) | OK (off) | OK (0 thought tok) | OK (144) | OK (88) |
   | gemini-3.1-pro-preview | 429 quota (free tier has no 3.x-pro headroom) | — | — | — | — |
   **Both dialects work on the 3.x tier. Today's NUMERIC map rows are speakable as-is.**
4. **Structured output**: the REAL entitySweep schema
   (`justwrite-app/server/justwrite_server/seed_feature_prompts.py:227-248`) passes
   as a raw JSON Schema via `GenerateContentConfig(response_mime_type=
   "application/json", response_json_schema=<dict>)` → valid JSON with all three
   keys. (`response_schema` also worked; `response_json_schema` is the raw-JSON-Schema
   field and is the one we use.)
5. **Embeddings**: `client.models.embed_content(model="gemini-embedding-001",
   contents=[…], config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"))` →
   `[e.values for e in r.embeddings]`, 3072 dims; `task_type="RETRIEVAL_QUERY"` +
   `output_dimensionality=768` honored (768 back). Batch (2 texts) works.
6. **SDK surfaces (introspected on the installed packages)**:
   - `genai.Client(api_key=…, http_options=types.HttpOptions(base_url=…, timeout=<ms>))`
     — ctor params verified; `HttpOptions` has `base_url` + `timeout` (+ `retry_options`).
   - `types.ThinkingConfig` fields: `include_thoughts`, `thinking_budget`, `thinking_level`.
   - `types.GenerateContentConfig` has typed: `top_p`, `top_k`, `seed`,
     `presence_penalty`, `frequency_penalty`, `stop_sequences`, `system_instruction`,
     `max_output_tokens`, `temperature`, `response_mime_type`, `response_json_schema`,
     `response_schema`, `thinking_config`.
   - The SDK's `client.interactions` exists but is request-object plumbing
     (`create(request=…)` demanding a nested body; plain kwargs rejected —
     captured error). Decision D2 below.
   - `openai==2.46.0`: `client.responses.create` typed params include `input`,
     `instructions`, `max_output_tokens`, `reasoning`, `store`, `text`,
     `temperature`, `top_p`, `stream`, `metadata`, `extra_body`.
     `client.chat.completions.create` typed params include `max_tokens`,
     `reasoning_effort`, `seed`, `stop`, `response_format`, `presence_penalty`,
     `frequency_penalty`, `logit_bias`, `stream_options`, `extra_body`.
     `client.embeddings.create(input=…, model=…, dimensions=…)`. `client.models.list()`.
     Ctor: `api_key`, `base_url`, `timeout`, `max_retries`, `default_headers`.
   - `anthropic==0.117.0`: `client.messages.create` typed params include
     `max_tokens` (required), `system`, `temperature`, `top_p`, `top_k`,
     `stop_sequences`, `stream`, `thinking`, `output_config`, `metadata`,
     `extra_body`. `client.models.list()` exists. Ctor: `api_key`, `base_url`,
     `timeout`, `max_retries`, `default_headers`.

7. ◆ **The alias default resolves** (folded from the grounding lens's MAJOR — "listed
   ≠ callable" was its own §0 lesson): a live `generate_content` on
   `gemini-flash-lite-latest` returned "OK." + usage on this key. The C2
   `DEFAULT_MODEL` is therefore proven, not list-inferred, and being an alias it
   tracks Google's current flash-lite tier instead of rotting like the dated
   `gemini-2.5-flash` default did.

**OpenAI + Anthropic ship tests-green but live-unverified** (OpenAI key unfunded;
no live Anthropic spend authorized) — same accepted caveat as the superseded plan.

## 0.7 · DECISIONS this plan applies (each with the evidence; the user's plan-OK rules them)

- **D1 — Adapter split.** Official SDKs for the true clouds; OUR httpx adapters stay
  for everything local: `local-llamacpp` + generic `openai-compat` stay on
  `openai_compat.py` UNCHANGED (the generic type's population is llama.cpp-family
  local servers — LM Studio / Local engine chips, `useProviderConnect.js:16,18`;
  pass-through incl. the `samplers` order array + llama-server's `prompt_progress`
  frames must survive byte-identical, and the file must exist for `local-llamacpp`
  anyway, so generic riding it adds zero code). `ollama.py` unchanged.
- **D2 — Gemini speaks `generate_content`/`generate_content_stream`** (the SDK's
  first-class typed surface), NOT the SDK's `interactions` plumbing. Evidence: proof
  items 1-5 all ride it (thinking + JSON Schema + system + usage + streaming);
  the interactions surface in 2.12.1 is awkward request-object plumbing (proof 6).
  The pre-pivot "Interactions API" ruling was about which RAW WIRE dialect to
  hand-maintain — the SDK pivot dissolves that question: Google evolves the wire
  inside the SDK. Statelessness: `generate_content` has no `store` concept and
  creates no server-side interaction object — the never-persist ruling is satisfied
  by construction. The user pressed "better or just easier?" (2026-07-17) and the
  re-derivation stands WITHOUT the ease arguments (plumbing/less-code struck):
  every Interactions benefit (auto memory, anchored persona) rides `store:true`,
  which the user's own never-persist ruling forbids — under store:false the
  surfaces are functionally identical for chat; the multi-provider RAG pipeline
  must exist app-side regardless (local models have no server memory; personas
  live in the project DB and must stay live-editable); and generate_content is
  live-proven where Interactions' config surface is not. Named cost: Google's
  "recommended for new projects" points at Interactions — if that ever forces a
  move, the swap is this ONE adapter file behind the Protocol.
  **[RULED 2026-07-17, the user verbatim after the re-derivation: "so use
  generate_content".]**
- **D3 — OpenAI speaks the Responses API** via `client.responses` (typed
  `max_output_tokens` / `reasoning.effort` / `store=False` / `text.format`) —
  unchanged from the pre-pivot ruling, now SDK-typed.
- **D4 — xAI + Mistral join as dedicated types** `"xai"` / `"mistral"` on the SDK
  chat-completions path (their real APIs are OpenAI-shaped):
  `https://api.x.ai/v1` · `https://api.mistral.ai/v1`.
- **D5 — Reasoning-param emission is per-type**: `EMIT_EFFORT_TYPES = {"openai",
  "openrouter"}` (openai → Responses `reasoning={"effort": w}`; openrouter → CC
  `reasoning_effort=w` — documented accepted). `deepseek`/`xai`/`mistral` NEVER emit
  an effort param (DeepSeek has no such param — the reasoner model itself thinks;
  xAI's support varies by model generation; Mistral 422-rejects unknown params).
  Their thinking = model default. Seeds: `REASONING_MAP_TYPE_SEEDS` gains
  `"xai"` and `"mistral"` rows, all five levels `("", None)` (honest: nothing to
  emit); `_TYPE_ALIAS` (`reasoning_map_api.py:69`) keeps deepseek→openai (rows are
  harmless data; the adapter emission gate governs).
  ◆ **The Reasoning-levels editor must tell the same story** (architecture-lens
  MAJOR — a third parallel source otherwise): `ProviderForm.vue:183-186` decides
  column visibility via `NUMBER_ONLY_TYPES = {"local-llamacpp","gemini"}` /
  `WORD_ONLY_TYPES = {"openai","openai-compat","deepseek","openrouter","ollama"}`.
  In C4.2: move `deepseek` OUT of `WORD_ONLY_TYPES` and add a third set
  `MODEL_DEFAULT_TYPES = {"deepseek","xai","mistral"}` for which the editor shows
  NO columns, just the line "This provider runs thinking at the model's own
  default — no per-level control." (matches D5's emission truth; a user must never
  edit a value nothing sends). `openai-compat`/`ollama`/`openai`/`openrouter`
  column behavior unchanged.
- **D6 — Gemini thinking (the user's HELD mapping ruling, resolved WITH the probe)**:
  RECOMMENDED **(A) keep today's NUMERIC seed rows unchanged** — the proof shows
  `thinking_budget` numbers work as-is on the 3.x tier (table above), so NO reseed,
  no migration, the Reasoning-levels editor keeps meaning what it says. Adapter
  emission: think-off → omit thinkingConfig entirely (model default — today's
  behavior); think-on + map row has a WORD → `thinking_level=word`; think-on +
  numeric → `thinking_budget=n`. ◆ Under (A) the word branch is FORWARD-COMPAT and
  currently unreachable (architecture-lens note): gemini's rows are numeric and the
  editor hides gemini's word column (`ProviderForm.vue:183` `NUMBER_ONLY_TYPES`),
  so no word can be fed today — comment the branch as such. (Alternative (B):
  reseed gemini rows to words minimal/low/medium/high — rejected: gains nothing the
  probe shows, loses the proven -1 dynamic + the user's tuned numbers.)
  **[RULED 2026-07-17: (A) keep numeric rows — the user, verbatim: "also keep
  numeric rows" + "unless the interactions sdk changes that". The qualifier is
  binding: the numeric choice rides the generate_content surface; if the adapter
  ever swaps to the SDK's interactions surface (which speaks thinking_level
  words), the mapping REOPENS for a fresh ruling — record this in the adapter's
  thinking comment + docs/models.md.]**
- **D7 — Gemini `models()` filters to usable ids**: keep only models whose
  `supported_actions` include `generateContent` or `embedContent` (drops veo/imagen/
  lyria/aqa/robotics noise — 54 → ~30; the #8 model-list-noise complaint). The
  chat/embed split in the form (`ProviderForm.vue:82-84` regex) keeps working.
- **D8 — Anthropic `models()` goes live-with-fallback**: try `client.models.list()`
  (the real `/v1/models` endpoint — exists since 2025; today's curated-list comment
  `anthropic.py:244-248` is stale), fall back to the current curated list
  (`anthropic.py:249-258` verbatim) on ANY error so the works-without-a-key behavior
  survives.
- **D9 — SDK client config**: every SDK client gets the provider's
  `timeoutSeconds` + `max_retries=2` (the openai/anthropic SDK default — first
  retry behavior we've ever had on clouds; note in docs) and the cfg base_url
  (passed verbatim when non-empty; equals-default is harmless).
- **D10 — Error surface preserved**: adapters keep raising
  `RuntimeError(f"{provider_type} {status}: {detail[:400]}")` (and
  `"{provider_type} stream {status}: …"` / `"{provider_type} request failed: {e}"`)
  so the JW error envelope + friendly-error mapping keep parsing. SDK exceptions map:
  `APIStatusError` → status + `e.message`/`str(e)`; connection/timeout errors →
  the `request failed` form.

## 1 · Preconditions (in order, FIRST)

1. **Commit the finished, test-green, uncommitted #5/#9/#10 work** (predates this
   plan):
   - runner commit A — `ui/src/components/LuRunnerEngine.vue`,
     `llm_runner/runner/config.py`, `llm_runner/llm/runner_config_api.py`,
     `llm_runner/runner/download.py`, `tests/test_download.py`:
     `feat(engine): download settings — section header + 1-16/0-10 caps (#9 #10)`.
   - runner commit B — `ui/src/common/services/streamFreshness.js` (new),
     `ui/src/stores/aiTasks.js`, `ui/src/components/AiTaskStrip.vue`,
     `ui/src/components/AiStatusPanel.vue`:
     `feat(tasks): rate-relative stalling classifier (#5)`.
   - JW commit — `src/renderer/src/services/__tests__/streamFreshness.test.js` (new):
     `test: pin the rate-relative freshness classifier (#5)`.
   Gate: `python -m pytest tests/test_download.py -q` (runner) + `npm run test:unit`
   (JW) — green as of 2026-07-17; red now = STOP.
2. Never touch the user's live ports (1420/17495). No live cloud calls in tests —
   fakes only (the live proof already happened).
3. Branch `claude/admiring-galileo-il3q0o`, both repos. Nothing is pushed.
4. Ignore `build/lib/llm_runner/**` (stale artifact); live source is `llm_runner/`.
5. Install the new deps into the runner's dev env before running tests:
   `pip install -e .` (or `pip install google-genai openai anthropic`) in whatever
   env `python -m pytest` uses on this box. If pytest can't import a new SDK: STOP.

## 2 · Target adapter map (end state)

| provider_type | Adapter | Backing | Chat dialect | embed() |
|---|---|---|---|---|
| `local-llamacpp` | `openai_compat.py` | httpx (ours) | chat-completions + prompt_progress + reasoning_budget_tokens | `/embeddings` |
| `openai-compat` | `openai_compat.py` | httpx (ours) | chat-completions, pass-through | `/embeddings` |
| `ollama` | `ollama.py` | httpx (ours) | native `/api/chat` options | `/api/embed` |
| `openai` | **NEW `openai_sdk.py`** | `openai` SDK | **Responses API** | `client.embeddings` |
| `deepseek` | `openai_sdk.py` | `openai` SDK + base_url | chat-completions | `client.embeddings` |
| `openrouter` | `openai_sdk.py` | `openai` SDK + base_url | chat-completions | `client.embeddings` |
| `xai` *(new)* | `openai_sdk.py` | `openai` SDK + base_url | chat-completions | `client.embeddings` |
| `mistral` *(new)* | `openai_sdk.py` | `openai` SDK + base_url | chat-completions | `client.embeddings` |
| `gemini` | `gemini.py` **rewritten** | `google-genai` SDK | `generate_content(+_stream)` | `embed_content` + task_type |
| `anthropic` | `anthropic.py` **rewritten** | `anthropic` SDK | `messages.create(+stream=True)` | none |

Registry (`registry.py:70-118`) end state: `anthropic`/`ollama`/`gemini` branches keep
their shapes (constructor contract unchanged:
`(cfg.id, api_key=…, base_url=…, default_model=…, timeout_seconds=…)`);
the `:87` tuple becomes `("openai-compat", "local-llamacpp")` → `OpenAICompatAdapter`;
NEW branch `("openai", "deepseek", "openrouter", "xai", "mistral")` →
`OpenAISDKAdapter` (same kwargs + `provider_type=pt`).

## 3 · C1 — dependencies, seeds, chips, cascade-delete

### C1.1 deps — `just-llm-runner/pyproject.toml:10-15`
Append to `dependencies`:
```toml
    # Official vendor SDKs (user ruling 2026-07-17 — the SDK pivot; versions are the
    # live-proof pins): they own each cloud's wire format + retries. Local adapters
    # (llama.cpp/Ollama/generic compat) deliberately stay on httpx.
    "openai>=2.46",
    "anthropic>=0.117",
    "google-genai>=2.12",
```
Update the `:8-9` "Deliberately light deps — NO ML" comment honestly: still no
torch/transformers; the three vendor SDKs add ~15-25 MB installed (google-genai pulls
google-auth + websockets) — accepted by the ruling. JustVoice inherits the deps when
it reinstalls the runner (F1 handoff note).

### C1.2 seeds — `llm_runner/llm/seed.py:116-132` `DEFAULT_PROVIDERS`
1. `claude` row → `"provider_type": "anthropic"`, `"base_url": "https://api.anthropic.com"`.
2. `gemini` row → `"provider_type": "gemini"`, `"base_url": "https://generativelanguage.googleapis.com"`.
3. `openai-compat-local` row → id UNCHANGED (insert-if-missing is by id), `"name":
   "Ollama (local)"`, `"provider_type": "ollama"`, `"base_url": "http://localhost:11434"`
   — **`/v1` REMOVED** (the native adapter appends `/api/chat`; keeping `/v1` yields
   `…/v1/api/chat`, broken — `ollama.py:26,120,165`).
4. `openai` row: UNCHANGED. (xAI/Mistral rows land in C4 with their registry
   branch. ◆ Precise reason, architecture-lens correction: the seeder would insert
   the DB row regardless — it's adapter CONSTRUCTION that boot-skips
   (`registry.py:128-131`) — and the map seeder would fill openai-aliased WORD rows
   for types whose honest seeds don't exist until C4. Deferral avoids both the
   unregistered row in the UI and the wrong-shape map rows.)
Migration = the user's ruled **"I'll re-add them"** flow: delete provider in UI →
restart → seed recreates with the native type → paste key. NO heal code.

### C1.3 chips — `ui/src/composables/useProviderConnect.js`
- `:22` OpenRouter chip `"openai-compat"` → `"openrouter"` (mistyped today).
- (xAI/Mistral chips + `ONLINE_ONLY_TYPES` additions land in C4.)

### C1.4 — **cascade-delete the provider's reasoning-map rows** (carried CRITICAL)
`stores.py:101-109` `ProviderStore.remove` deletes ONLY the provider row;
`ReasoningMap` has no FK to `llm_providers` (`db.py:235-246`), and map reseed is
fill-if-missing (`seed.py:616-625`) — so on the user's box the gemini rows seeded via
the openai-compat ALIAS (WORD rows) would SURVIVE delete+re-add and poison the retyped
provider. Fix inside the same `remove` transaction:
```python
    def remove(self, provider_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.LlmProvider, provider_id)
            if row is not None:
                s.query(db.ReasoningMap).filter(
                    db.ReasoningMap.provider_id == provider_id
                ).delete()
                s.delete(row)
                s.commit()
        finally:
            s.close()
```
(Adjust the filter column name to the actual `db.ReasoningMap` model — read
`db.py:235-246` first; if the column differs, use what the model defines.)
After delete→restart, reseed lands the NEW type's rows: gemini → the numeric rows
(D6-A), claude → anthropic word+budget rows, ollama-local → ollama word rows.

### C1.5 tests (fires-proof, red-then-green)
- NEW `tests/test_seed_providers.py`: pin id/type/base_url of ALL `DEFAULT_PROVIDERS`
  rows against the NEW values (inline seed-pin idiom, `test_config.py:71-73`
  precedent). Write the assertions first, watch them fail on the old seed, flip, green.
- Cascade fires-proof: create a provider + its map rows in a temp store → `remove` →
  assert the map rows are gone (this test FAILS on today's `remove`).
- **JW `server/tests/test_seed.py:52`** asserts
  `by_id["claude"]["providerType"] == "openai-compat"` — flip to the native types in
  the SAME commit (it breaks otherwise; the coupling is real —
  `test_seed.py:23` imports the runner's `DEFAULT_PROVIDERS` directly). ◆ Also
  update the now-false comment directly above it (`test_seed.py:49-50`:
  "claude/gemini stay openai-compat until the native adapters are verified") in the
  same commit.
Commit C1: `feat(llm): SDK deps + native seed types + reasoning-map cascade delete (#15)`.

## 4 · C2 — shared base.py helpers + `gemini.py` rewritten onto google-genai

### ◆ C2.0 — promote the shared adapter helpers to `base.py` FIRST (reuse-lens MAJORs)
`base.py` is the established shared-helper home (`pop_reasoning`, `base.py:60-74`).
Add, next to it:
1. `build_chat_messages(messages, system) -> list[dict]` — the OpenAI-shape message
   builder. It ALREADY exists as byte-identical copies at `openai_compat.py:92-101`
   and `ollama.py:57-66`; migrate BOTH to call the shared one in this same commit
   (behavior-neutral — their existing tests stay green UNCHANGED, which is the
   proof) and the new `openai_sdk.py` CC path consumes it from day one.
2. `split_system(messages, system) -> tuple[str | None, list[LLMMessage]]` — the
   system-sweep (collect `system` kwarg + system-role turns, join `"\n\n"`, return
   the non-system remainder as `LLMMessage`s). Source of truth: anthropic's
   `_split_system` (`anthropic.py:60-76`, effectively pure). Consumers: anthropic
   (dict-ifies the remainder), gemini C2.2 (maps to Content/Part), openai-Responses
   C4.1 (maps to the input array). Anthropic's method becomes a thin call.
3. `select_allowed(extra, allowed: set, renames: dict | None = None) -> dict` — the
   sampler-allowlist filter (keep keys in `allowed`, apply `renames`; `extra=None`
   → `{}`). Used by anthropic `_map_extra`, gemini `_build_config`, and
   `openai_sdk`'s profiles. Response_format/thinking handling stays per-adapter
   (genuinely different).
4. `adapter_http_error(provider_type, status, detail, *, stream=False) ->
   RuntimeError` — formats the D10 contract strings in ONE place (`{ptype}
   {status}: {detail[:400]}` / `{ptype} stream {status}: …`; a `status=None`
   overload yields `{ptype} request failed: {detail}`). Each adapter's `except`
   extracts its SDK's status/detail and raises this. (Grounded softener: JW's
   `friendlyAiError`, kit `ui/src/services/aiErrors.js:46-60`, only regex-scans for
   a 3-digit status — but the plan treats the strings as a contract, so single-source
   them.)
Tests: a small `tests/test_base_helpers.py` pinning all four (messages shape ·
sweep + remainder · allowlist + rename · all three error forms). The compat/ollama
migration is proven by their untouched existing tests.

Full-file rewrite of `gemini.py`. Keep: module docstring updated,
`DEFAULT_BASE_URL`, class name `GeminiAdapter`, constructor contract,
`provider_type = "gemini"`. Change `DEFAULT_MODEL` → `"gemini-flash-lite-latest"`
(the 2.5 default is new-user-blocked; ◆ the alias is PROVEN live — proof item 7).
Delete: `_ROLE_MAP`/`_build_payload`/`_GEN_KEYS` httpx plumbing.

### C2.1 constructor
```python
from google import genai
from google.genai import types as gtypes

def __init__(self, provider_id, *, api_key, base_url="", default_model="", timeout_seconds=60):
    self.provider_id = provider_id
    self.provider_type = "gemini"
    self.default_model = default_model or DEFAULT_MODEL
    http_options = gtypes.HttpOptions(timeout=timeout_seconds * 1000)  # ms
    if base_url:
        http_options.base_url = base_url.rstrip("/")
    self._client = genai.Client(api_key=api_key or "", http_options=http_options)
```
(SDK import at module top — the registry already lazy-imports the MODULE per branch
(`registry.py:108-117`), so a missing pip package degrades to a logged boot-skip via
`load_from_configs`, `registry.py:121-131`.)

### C2.2 the pure config builder (the testable core — house static-helper pattern)
```python
@staticmethod
def _build_config(*, system, temperature, max_tokens, think, effort, budget, extra):
    """Map the house call contract → GenerateContentConfig kwargs. Typed fields
    only — anything Gemini doesn't speak is dropped HERE (the min_p-400 fix)."""
    cfg: dict = {}
    if system:
        cfg["system_instruction"] = system
    if temperature is not None:
        cfg["temperature"] = temperature
    if max_tokens is not None:
        cfg["max_output_tokens"] = max_tokens
    # ◆ the shared allowlist filter (C2.0) — Gemini's typed sampler set + the
    # stop rename; everything else (min_p, mirostat*, samplers order, …) drops here.
    cfg.update(select_allowed(
        extra,
        {"top_p", "top_k", "seed", "presence_penalty", "frequency_penalty", "stop"},
        renames={"stop": "stop_sequences"},
    ))
    rf = (extra or {}).get("response_format")
    if isinstance(rf, dict) and rf.get("type") in ("json_object", "json", "json_schema"):
        cfg["response_mime_type"] = "application/json"
        schema = (rf.get("json_schema") or {}).get("schema")
        if rf.get("type") == "json_schema" and isinstance(schema, dict):
            cfg["response_json_schema"] = schema  # raw JSON Schema — proof item 4
    # Thinking (D6-A): off → OMIT (model default, today's semantics); on → speak
    # whichever form the resolved map row carries (both proven, proof item 3).
    if think:
        if effort in ("minimal", "low", "medium", "high"):
            cfg["thinking_config"] = gtypes.ThinkingConfig(thinking_level=effort)
        elif budget is not None:
            cfg["thinking_config"] = gtypes.ThinkingConfig(thinking_budget=budget)
    return cfg
```
`chat()`/`stream_chat()` call `extra, effort, budget = pop_reasoning(extra)` first
(unchanged), then ◆ `sys_text, turns = split_system(messages, system)` (the C2.0
helper — replaces today's inline sweep `gemini.py:71-84`), then
`config = gtypes.GenerateContentConfig(**self._build_config(...))` with
`system=sys_text`. Messages: build `contents` from the remainder —
`[gtypes.Content(role=("model" if m.role == "assistant" else "user"), parts=[gtypes.Part(text=m.content)]) for m in turns]`.
◆ Builder offline-verify FIRST (no network): one
`python -c "from google.genai import types; print(types.Content(role='user', parts=[types.Part(text='x')]))"`
proving the Content/Part construction form before writing the adapter — record the
result in a code comment (the probe only exercised string contents).

### C2.3 chat / stream / models / ping / errors
- `chat()`: `r = self._client.models.generate_content(model=(model or
  self.default_model).removeprefix("models/"), contents=contents, config=cfg)`.
  Parse: text = `"".join(p.text or "" for p in r.candidates[0].content.parts)` when
  candidates present else `""` (do NOT use `r.text` — it can raise/warn on non-text
  parts); finish_reason = `r.candidates[0].finish_reason.name.lower()` mapped
  `{"max_tokens": "length", "stop": "stop"}` (else the lowered name); usage from
  `r.usage_metadata`: `prompt_tokens=prompt_token_count or 0`,
  `completion_tokens=candidates_token_count or 0`; `raw=r.model_dump(exclude_none=True)`.
- `stream_chat()`: iterate `generate_content_stream(...)`; per chunk yield
  `StreamDelta(text=…)` for non-empty part text; track the latest non-None
  `usage_metadata` (final chunk authoritative — proof item 2); after the loop yield
  `StreamDelta(done=True, prompt_tokens=…, completion_tokens=…)`.
- `models()`: `self._client.models.list()`; keep ids whose `supported_actions`
  include `generateContent` or `embedContent` (D7; treat missing/None
  supported_actions as KEEP), strip the `models/` prefix. On any exception → `[]`
  (today's contract, `gemini.py:233-251`).
- `embed()` (NEW — the protocol gains it, C5):
  ```python
  _TASK_MAP = {"document": "RETRIEVAL_DOCUMENT", "query": "RETRIEVAL_QUERY"}
  def embed(self, texts, *, model=None, task_type=""):
      m = (model or "gemini-embedding-001").removeprefix("models/")
      cfg = gtypes.EmbedContentConfig(task_type=self._TASK_MAP[task_type]) \
          if task_type in self._TASK_MAP else None
      r = self._client.models.embed_content(model=m, contents=list(texts), config=cfg)
      return [list(e.values) for e in r.embeddings]
  ```
  wrapped in the D10 error mapping.
- `ping()`: a `models.list` call in try/except → `True` on success; on an API error
  with a status code return `code < 500`; `False` on transport errors.
- Errors (D10, via the ◆ C2.0 `adapter_http_error` helper):
  ```python
  from google.genai import errors as gerrors
  except gerrors.APIError as e:
      raise adapter_http_error("gemini", e.code, str(e), stream=<bool>) from e
  except Exception as e:
      raise adapter_http_error("gemini", None, str(e)) from e
  ```
  (VERIFY the exact exception surface with one
  `python -c "from google.genai import errors; print([n for n in dir(errors) if not n.startswith('_')])"`
  before writing — if `APIError` lacks `.code`, use its documented status attr.
  Do NOT guess silently — record what introspection showed in the code comment.)

### C2.4 tests — rewrite the gemini portions of `tests/test_adapter_extra.py`
Fake client pattern (replaces `_FakeStreamClient` for gemini): a hand-stub object
graph assigned onto `adapter._client`:
```python
class _FakeGenai:
    def __init__(self, response):
        self.models = self  # flat: fake .models.generate_content etc.
        self._response = response
        self.last = {}
    def generate_content(self, *, model, contents, config):
        self.last = {"model": model, "contents": contents, "config": config}
        return self._response
```
◆ The kwargs-capture idiom + the fixture loader live ONCE in a new
`tests/_sdk_fakes.py` (reuse-lens: `KwargsCapture` base — records `self.last` —
plus `load_fixture(name)`); the per-SDK fakes here and in C3/C4 are thin
subclasses, extending the `_FakeStreamClient`/`FakeEmbedAdapter` convention rather
than minting three inline patterns.
Response stubs: build REAL `gtypes.GenerateContentResponse.model_validate({...})`
from the committed fixture JSONs (`tests/fixtures/gemini-sdk/chat-create.json` etc.)
so the parse tests pin the live-captured shapes.
Cover: config-builder mapping (top_p/stop→stop_sequences/seed kept; **min_p +
mirostat + samplers-array dropped** — the trigger bug, red-first against a
naive-merge assertion) · response_json_schema set for json_schema + mime-only for
json_object · thinking off→absent / word→thinking_level / number→thinking_budget
◆ **including budget=-1 passing through verbatim** (the documented dynamic value —
today's case `test_adapter_extra.py:112` must survive the rewrite) · chat parse
(text/usage/finish MAX_TOKENS→length) · stream assembly + final-chunk usage ·
models() action filter + prefix strip · embed request (model default, task_type
mapping, "" omits) + vector extraction · error mapping (`gemini 4xx:`).
The OLD `test_gemini_extra_maps_to_generationconfig_and_drops_unsupported` +
`_apply_extra`-based tests are REPLACED by the `_build_config` equivalents.
Commit C2: `feat(gemini): official google-genai SDK adapter (#15)`.

## 5 · C3 — `anthropic.py` rewritten onto the anthropic SDK

Full-file rewrite preserving ALL current behavior logic. Keep verbatim:
`DEFAULT_BASE_URL`, `DEFAULT_MODEL`, `_split_system` (:60-76), the model-generation
split constants `_ADAPTIVE_SUBSTRINGS`/`_ALWAYS_THINKS_SUBSTRINGS` (:84-85),
`_apply_reasoning` (:87-111 — the adaptive/legacy/always-thinks logic including the
max_tokens bump and sampler pops), `_map_extra` upgraded to an ALLOWLIST ◆ built on
the C2.0 shared filter, preserving today's None-for-empty return contract
(`test_plane2_params.py:94` pins `_map_extra(None) is None`):
```python
@staticmethod
def _map_extra(extra):
    """Allowlist — Anthropic's typed params only (top_p/top_k/metadata) + the
    stop→stop_sequences rename. Everything else (min_p, mirostat*, dry_*, xtc_*,
    seed, samplers, response_format) is DROPPED — the Messages API has none of them."""
    out = select_allowed(extra, {"top_p", "top_k", "metadata", "stop"},
                         renames={"stop": "stop_sequences"})
    return out or None
```
◆ Touched-test enumeration (planner second pass — unfiltered):
`test_plane2_params.py:92-95` (stop rename ✓ · None ✓ · top_p ✓ — all still pass)
and `:138-146` (response_format strip — still passes: the allowlist drops it). Any
OTHER assertion there that expects a now-dropped key to pass through goes red →
update red-first in this commit and list it in the handoff.
- Constructor: `anthropic.Anthropic(api_key=api_key or "", base_url=self._base_url,
  timeout=timeout_seconds, max_retries=2)`; drop `_headers`/`ANTHROPIC_VERSION`
  (SDK owns the version header). `_split_system` becomes a thin call to the ◆ C2.0
  `split_system` (dict-ifying the remainder).
- `chat()`: build kwargs dict (model/messages/max_tokens (`:147` default-4096
  semantics)/temperature-if-not-None/system-if-any) + `_map_extra` merge +
  `_apply_reasoning(kwargs, think, effort, budget, model)` (same mutation contract —
  it sets `thinking`/`output_config`, pops temperature/top_p/top_k) →
  `msg = self._client.messages.create(**kwargs)`. Parse: text = concat of
  `blk.text for blk in msg.content if blk.type == "text"`; finish =
  `msg.stop_reason or "stop"`; usage `msg.usage.input_tokens/output_tokens`;
  `raw=msg.model_dump()`.
- `stream_chat()`: `events = self._client.messages.create(**kwargs, stream=True)`
  iterating SDK events — `event.type == "content_block_delta"` and
  `event.delta.type == "text_delta"` → yield `StreamDelta(text=event.delta.text)`;
  `"message_start"` → pt from `event.message.usage.input_tokens`;
  `"message_delta"` → ct from `event.usage.output_tokens`; then the done frame.
  (Same event names as today's hand parser `anthropic.py:230-241` — the SDK yields
  them typed.)
- `models()` (D8): try `[m.id for m in self._client.models.list()]`, on ANY
  exception return the current curated list (`:249-258` verbatim).
- `ping()`: keep the 1-token `messages.create` probe (`max_tokens=1`), via SDK,
  `True` unless a ≥500/transport error (map `anthropic.APIStatusError.status_code`).
- Errors (D10): via ◆ `adapter_http_error("anthropic", e.status_code, str(e),
  stream=<bool>)` for `anthropic.APIStatusError`; `(…, None, str(e))` for
  `APIConnectionError`/other.
- Tests: the existing anthropic reasoning tests in `test_adapter_extra.py` (static
  `_apply_reasoning` on dicts) survive UNCHANGED — that is the proof the logic
  carried. Add: `_map_extra` allowlist (mirostat/min_p/seed dropped, top_k kept —
  red-first on today's pass-through `_map_extra`) · chat kwargs assembly via a fake
  `messages.create` capturing kwargs · stream event parse over hand-built stubs ·
  models() fallback fires when list raises.
Commit C3: `feat(anthropic): official anthropic SDK adapter (#15)`.

## 6 · C4 — NEW `openai_sdk.py` + xAI/Mistral + registry rewire

### C4.1 the adapter
New file `llm_runner/llm/openai_sdk.py`, class `OpenAISDKAdapter`. Constructor
contract identical to compat's (`provider_id, provider_type, *, api_key, base_url,
default_model, timeout_seconds`); defaults dict:
```python
PROVIDER_DEFAULTS = {
    "openai":     {"base_url": "https://api.openai.com/v1",    "default_model": "gpt-4o-mini"},
    "deepseek":   {"base_url": "https://api.deepseek.com/v1",  "default_model": "deepseek-chat"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1", "default_model": "openai/gpt-4o-mini"},
    "xai":        {"base_url": "https://api.x.ai/v1",          "default_model": ""},
    "mistral":    {"base_url": "https://api.mistral.ai/v1",    "default_model": ""},
}
```
Client: `openai.OpenAI(api_key=api_key or "sk-no-key", base_url=self._base_url,
timeout=timeout_seconds, max_retries=2)`.

Param profiles (the min_p-400 fix on the SDK path) — allowlists over `extra`
AFTER `pop_reasoning`:
```python
TYPE_PARAM_PROFILES = {
    # typed CC params each cloud documents; everything else in extra is dropped.
    "deepseek":   {"top_p", "stop", "seed", "presence_penalty", "frequency_penalty", "response_format"},
    "openrouter": {"top_p", "stop", "seed", "presence_penalty", "frequency_penalty",
                   "response_format", "top_k", "min_p", "repeat_penalty"},
    "xai":        {"top_p", "stop", "seed", "presence_penalty", "frequency_penalty", "response_format"},
    "mistral":    {"top_p", "stop", "presence_penalty", "frequency_penalty", "response_format", "seed"},
}
EMIT_EFFORT_TYPES = {"openai", "openrouter"}  # D5
```
Delivery on the chat-completions path: typed kwargs for `top_p/stop/seed/
presence_penalty/frequency_penalty/response_format` (all typed — proof item 6);
`extra_body` ONLY for openrouter's `top_k`/`min_p`/`repetition_penalty` (rename
`repeat_penalty → repetition_penalty`, OpenRouter's documented name) — and for
mistral rename `seed → random_seed` via `extra_body` (Mistral's name). BUILD-TIME
VERIFY-STEP (doc fetch, no live call): OpenRouter's `reasoning_effort` alias +
Mistral's `random_seed` — record both findings in code comments; if either
contradicts this table, STOP.

◆ Builder offline-verify FIRST (no network, folds the planner's second pass): one
`python -c` listing the event-class names in `openai.types.responses` (e.g.
`ResponseTextDeltaEvent`, `ResponseCompletedEvent`) and their `type` string values —
the stream parser below pins to what THAT shows, recorded in a code comment; the
P0b-era doc-derived names are the expectation, introspection is the authority.

- **Responses path (`provider_type == "openai"`)** — `chat()`/`stream_chat()`:
  - input: single user turn + no history → plain string; else
    `[{"role": m.role, "content": [{"type": ("output_text" if m.role == "assistant" else "input_text"), "text": m.content}]} …]`
    (system-role messages sweep into `instructions` via the ◆ C2.0 `split_system`).
  - `client.responses.create(model=…, input=…, instructions=…,
    max_output_tokens=max_tokens, temperature=…(when not None), store=False,
    …profile-filtered top_p…, reasoning=({"effort": effort} if think and effort
    else omitted), text=(formats below), stream=…)`.
  - `text` formats: json_schema-carrying feature → `{"format": {"type":
    "json_schema", "name": ((rf.get("json_schema") or {}).get("name") or "response"),
    "strict": False, "schema": schema}}` (**strict always False** — our schemas
    don't meet strict's every-key-required rule; pre-ruled, never mutate the
    schema); json_object-only → `{"format": {"type": "json_object"}}`.
  - Non-stream parse: `r.output_text` (SDK aggregation property), usage
    `r.usage.input_tokens/output_tokens`; `r.status == "incomplete"` +
    `r.incomplete_details.reason == "max_output_tokens"` → finish `"length"`,
    else `"stop"`.
  - Stream: iterate events; `event.type == "response.output_text.delta"` →
    `StreamDelta(text=event.delta)`; `"response.completed"` → usage off
    `event.response.usage`; `"response.failed"`/`"error"` → raise the D10 stream
    error. IGNORE all other event types.
  - If the API 400s `temperature` on a reasoning model: pop temperature, retry
    ONCE, log one WARNING (new mechanism, none exists to reuse — carried ruling).
- **CC path (deepseek/openrouter/xai/mistral)**: `client.chat.completions.create(
  model, messages=build_chat_messages(messages, system) (◆ the C2.0 helper),
  temperature(when not None), max_tokens, stream,
  stream_options={"include_usage": True} when streaming,
  reasoning_effort=(effort if think and effort and pt in EMIT_EFFORT_TYPES else omitted),
  **typed-profile-kwargs, extra_body=(dict or omitted))`.
  ◆ response_format nuance (planner second pass): `deepseek` documents json_object
  ONLY — a `json_schema` response_format DOWNGRADES to `{"type": "json_object"}`
  there (today it would 400 the same run, so this is a strict improvement);
  `xai`/`mistral` document real json_schema structured outputs → pass through;
  `openrouter` forwards per-model → pass through. Part of the same BUILD-TIME
  doc-verify step as the param names; contradiction → STOP.
  Parse mirrors compat's (`choices[0].message.content`, usage, finish_reason;
  stream: `chunk.choices[*].delta.content` + final usage frame guarded for empty
  choices — `openai_compat.py:242-259` semantics).
- `embed()`: `client.embeddings.create(input=list(texts), model=model or
  self.default_model)` → `[list(d.embedding) for d in r.data]` (SDK returns
  index-ordered). Accepts+ignores `task_type=""` (C5).
- `models()`: `[m.id for m in self._client.models.list()]`, `[]` on error.
  `ping()`: models call, `True` unless ≥500/transport (via `APIStatusError.status_code`).
- Errors (D10): via ◆ `adapter_http_error(self.provider_type, e.status_code,
  str(e), stream=<bool>)` for `openai.APIStatusError`; `(…, None, str(e))` for
  `APIConnectionError`/other.
- ◆ Consciously accepted repeat (reuse-lens, ruled here): the 3-line
  base_url/default_model resolve from `PROVIDER_DEFAULTS`
  (`openai_compat.py:74-76` pattern) is REPEATED in this file, not extracted — the
  DATA legitimately splits and a helper for 3 lines over 2 files is
  over-abstraction.

### C4.2 registry + types + compat trim + UI
◆ **This subsection is THE complete type-vocabulary checklist** (reuse-lens: ~8
parallel lists; a missed one ships a half-typed provider — check each off):
registry branches · `openai_sdk.PROVIDER_DEFAULTS` · `provider_api.PROVIDER_TYPES`
· `seed.DEFAULT_PROVIDERS` · `REASONING_MAP_TYPE_SEEDS` · `schema.py:34` type
comment · `useProviderConnect` PRESETS + `ONLINE_ONLY_TYPES` · `ProviderForm`
dropdown + reasoning-column sets (D5's editor reconcile).
- `registry.py`: the tuple at `:87` → `("openai-compat", "local-llamacpp")`; add
  the `OpenAISDKAdapter` branch for `("openai", "deepseek", "openrouter", "xai",
  "mistral")` (lazy import, same kwargs). ◆ Branch anchors for precision: anthropic
  `:77-86` (import `:78`), compat `:87-97` (import `:88`), ollama `:98-107`
  (import `:99`), gemini `:108-117` (import `:109`).
- `openai_compat.py`: `PROVIDER_DEFAULTS` (:26-51) drops the `openai`/`deepseek`/
  `openrouter` entries (they moved) — keeps `openai-compat` + `local-llamacpp`;
  update the class docstring (:55-58, clouds no longer served here).
  ◆ **Delete the now-dead cloud-reasoning branch** (all three lenses converged):
  `_apply_reasoning`'s `elif effort: body["reasoning_effort"] = effort`
  (`openai_compat.py:122-123`) is unreachable for both remaining types
  (`local-llamacpp` returns at `:114-117`; `openai-compat` hits `:120-121`) — a
  dead parallel to `openai_sdk`'s live emission. Remove it + its docstring line;
  everything else UNCHANGED (the local paths keep prompt_progress + pass-through).
- ◆ `schema.py:34`: extend the `providerType` doc comment with `"xai" | "mistral"`.
- `provider_api.py:27-39` `PROVIDER_TYPES` += `"xai"`, `"mistral"`.
- Seeds (`seed.py` `DEFAULT_PROVIDERS`) +=
  ```python
    {"id": "xai", "name": "xAI (Grok)",
     "provider_type": "xai", "base_url": "https://api.x.ai/v1", "local": False},
    {"id": "mistral", "name": "Mistral",
     "provider_type": "mistral", "base_url": "https://api.mistral.ai/v1", "local": False},
  ```
- `reasoning_map_api.py:39-64` `REASONING_MAP_TYPE_SEEDS` += `"xai"` and
  `"mistral"` entries, all five levels `("", None)` with a D5 comment; fix the stale
  coupling comments (:37-38 registry line refs; :66-68 alias note now points at
  `openai_sdk.py`).
- UI: `useProviderConnect.js` `PROVIDER_PRESETS` += `["xAI (Grok)",
  "https://api.x.ai/v1", "xai", false]`, `["Mistral", "https://api.mistral.ai/v1",
  "mistral", false]`; `ONLINE_ONLY_TYPES` (:30) += `"xai"`, `"mistral"`.
  `ProviderForm.vue:57-65` `PROVIDER_TYPES` dropdown += `{value: "xai", label:
  "xAI (Grok)"}`, `{value: "mistral", label: "Mistral"}`.
- Reasoning-map sanity: `seed_rows_for_type` (`reasoning_map_api.py:72-77`) picks
  the new explicit entries (no alias needed for xai/mistral).
- ◆ Durable drift-guard (reuse-lens): add ONE comment line at `seed.py`
  DEFAULT_KNOBS' plane-2 sampler subsection (~:519) — "cloud delivery of any knob
  here is gated by the per-type allowlists: openai_sdk.TYPE_PARAM_PROFILES ·
  anthropic._map_extra · gemini._build_config; ollama + local pass everything" —
  so a future sampler knob gets considered against them.

### C4.3 tests
`test_adapter_extra.py` additions: profile filtering per type (openrouter KEEPS
min_p/top_k + renames repeat_penalty; deepseek/xai DROP min_p; mistral renames seed
via extra_body; the `samplers` order array NEVER survives on any SDK type — each
red-first where today's compat would have passed it) · reasoning emission (openai →
`reasoning={"effort": w}`; openrouter → `reasoning_effort`; deepseek/xai/mistral →
absent even with a word + think-on) · `store=False` in every Responses call ·
responses input building (string vs turn array; instructions) · strict:False
json_schema + json_object formats · incomplete→length · temperature-retry-once ·
CC stream parse + usage frame · embed extraction. Fakes: thin subclasses of ◆
`tests/_sdk_fakes.py` (C2.4) assigned onto `adapter._client`.
`test_llm_dispatch.py`: registry constructs `OpenAISDKAdapter` for all five types;
compat with type `"openai"` and no base_url now raises ValueError
(`openai_compat.py:78-82` — its defaults entry is gone).
◆ **Two existing tests break at CONSTRUCTION and must be repurposed in this commit**
(architecture-lens MAJOR — both build `OpenAICompatAdapter` with type `"openai"`,
whose defaults entry C4.2 removes):
- `test_adapter_extra.py:116-145` `test_openai_compat_reasoning_cloud_vs_local` —
  the cloud-"openai"-word premise is obsolete (that emission now lives in
  `openai_sdk`, covered above). Rewrite to cover compat's two REMAINING types only
  (`local-llamacpp` budget/toggle + `openai-compat` enable_thinking), dropping the
  `reasoning_effort` assertion with the dead branch.
- `test_adapter_extra.py:210,215-223` `test_stream_chat_return_progress_only_for_builtin`
  — its `("openai", False)` loop row becomes `("openai-compat", False)` (same
  intent: a non-builtin type gets no `return_progress`; compat's `openai-compat`
  default base_url keeps construction valid).
Commit C4: `feat(llm): official openai SDK adapter — Responses + CC clouds, xAI + Mistral (#15 #14)`.

## 7 · C5 — embeddings task_type (universal param) + api wiring

- `base.py:128` Protocol: `def embed(self, texts, *, model=None, task_type=""):`
  — docstring: task side `"document" | "query" | ""`; adapters without a native
  task concept ignore it (the `think` kwarg precedent, `base.py:93,102-104`).
- Add the ignored `task_type=""` kwarg to `openai_compat.py:275` embed,
  `ollama.py` embed (~:200), and `openai_sdk.py` embed. Gemini consumes it (C2).
- `api.py:248`: `vectors = embed(texts, model=body.model or None,
  task_type=body.taskType)` — UNCONDITIONAL (no signature sniffing).
- Note (unchanged behavior): `_apply_embed_template` (`api.py:219-230`) still runs
  first — a Gemini embed model has no template row, so texts pass through; both
  mechanisms coexist by design. ◆ Fix the `api.py:238` docstring in this commit:
  "non-embedding providers (Anthropic/Gemini) report a clear 400" → drop "Gemini"
  (it embeds now); Anthropic remains the 400 example.
- Tests (`tests/test_llm_api.py`, FakeEmbedAdapter precedent `:102`): route passes
  taskType through; a fake adapter records it; gemini mapping covered in C2 tests.
  ◆ `FakeEmbedAdapter.embed` (`test_llm_api.py:105`) MUST gain `task_type=""` in
  this commit — the unconditional pass-through otherwise TypeErrors
  `test_embeddings_via_registry` (:109-116) (grounding-lens find; the
  no-embed FakeAdapter at `test_llm_dispatch.py:35` is unaffected).
Commit C5: `feat(llm): task_type-aware embeddings protocol (#15)`.

## 8 · C6 — #12 FULL: the key is a normal password field (carried, anchors re-verified today)

Root cause (verified today): `ProviderForm.vue:42` — `draft.apiKey` always inits
`""` ("write-only; '' preserves the stored key"); the `••••••••` is a PLACEHOLDER
(`:239-240`), the hint block sits at `:243-245`; Fetch (`:86-98`, call `:90`) and
Test (`:101-118`, call `:104`) send that empty key → the draft-probe builds a
keyless adapter (`api.py:161-193`, `:183`). Save keep-semantics are correct
(`provider_api.py:182`: `""` keeps, `null` clears).

1. **Server — key reveal is a POST** (a GET would be world-readable: bearer auth off
   by default (`auth.py:81-86`), `CsrfOriginMiddleware` guards mutating methods only
   (`csrf.py:24-61`), CORS default allow-all (`app.py:124-130`)). In
   `make_provider_router` (`provider_api.py:140-206`), using the router's
   `get_store()` closure:
   ```python
   @router.post("/v1/llm-providers/{provider_id}/key/reveal")
   async def reveal_llm_provider_key(provider_id: str) -> dict:
       cfg = get_store().get(provider_id)
       if cfg is None:
           raise HTTPException(status_code=404, detail=f"LLM provider {provider_id}")
       return {"apiKey": cfg.apiKey or ""}
   ```
   Never log the key (the error envelope logs only method+path, `app.py:98`; add no
   success logging).
   ◆ **The route is SHARED and its safety is a per-mounting-app property**
   (architecture-lens MAJOR — a REQUIREMENT, not an FYI): the origin guard lives in
   the HOST (JW's `CsrfOriginMiddleware`), not the router. In this commit the
   builder must READ JustVoice's server for an equivalent origin-check middleware:
   found + mounted → record the file:line evidence in the handoff and ship the
   route unconditionally; NOT found → register the reveal route only under a new
   `make_provider_router(get_store, allow_key_reveal=False)` opt-in that JW's
   `install.py:122` call site sets True (JV then inherits the SAFE default). Either
   way the handoff states which branch fired. (Mitigating context: JV currently
   cannot mount today's runner at all — ledger F1 — so the risk window is nil, but
   a credential endpoint verifies, never infers.)
2. **Kit component `UiSecretInput`** (new, `ui/src/common/components/`): wraps
   `UiInput` (never forks) with `:type` flipping `password` ↔ `text` on an eye
   toggle. Kit `Icon` already has `Eye` (`Icon.vue:40`) — add ONLY `EyeOff`
   (existing glyph pattern). ◆ Citation corrected by the reuse lens: `UiNumber`
   renders its own `<input class="ui-input …">` reusing the CSS class
   (`UiNumber.vue:120-137`), it does NOT wrap the `UiInput` component — this
   component genuinely wraps `<UiInput>` (which exposes `type` + focus/el,
   `UiInput.vue:13,29-33`), a cleaner shape than the precedent.
3. **ProviderForm.vue**: the key field becomes `UiSecretInput`. On OPEN of a saved
   provider with `hasApiKey`: `revealKey(providerId)` (new helper in
   `useProviderConnect.js` — POST the route above) → on success set
   `draft.apiKey = key; revealLoaded = true` and REMOVE the placeholder sentinel +
   "leave blank to keep" hint (`:239-245`) on this path. **Key-wipe guard**: Save
   sends `apiKey: draft.apiKey || (revealLoaded ? null : "")` — empty clears ONLY
   when the reveal succeeded; on reveal failure the form falls back to today's
   ""-keeps semantics + keeps the hint. Fetch/Test: UNCHANGED code paths — they now
   naturally carry the key (the bug dies as a consequence; ONE mechanism).
4. Tests: server — reveal returns the stored key, 404s unknown (`tests/
   test_llm_api.py` FakeStore pattern). Form — extend the JW vitest mount coverage
   (`LuFeatureChip.save.test.js` jsdom precedent) or a source pin
   (`chipPopoverStacking` precedent): ProviderForm wires `UiSecretInput` + the
   reveal fetch; fires-proof: the old placeholder sentinel is GONE on the success
   path (source pin failing on today's file); the key-wipe guard both ways
   (reveal-FAIL + untouched Save → `""`; reveal-OK + cleared → `null`).
Commit C6: `feat(providers): saved key in a password field with eye reveal; Fetch/Test carry it (#12)`.

## 9 · C7 — verification, docs, handoff

1. Runner: full `python -m pytest tests/ -q` + `ruff check .` — green minus the 3
   pre-existing Windows-box failures (lspci colon-path + 2× ensure_model_ready,
   proven pre-existing by stash-run 2026-07-17; a FOURTH failure is yours).
2. JW: `npm run test:unit` + `npm run build:vite` + `npm run test:server`.
3. Renderer gate: attempt the headless smoke per JW CLAUDE.md; on THIS Windows box
   if the Playwright chromium is absent, record "smoke: SKIPPED — no local
   chromium; UI delta covered by vitest mounts + the user's box check" in the
   handoff (honest partial), not silence.
4. ONE rules-checker on the final combined diff (contracts tier).
5. Docs in the SAME wave: JW `docs/models.md` providers section (native types; the
   delete→restart→re-add flow; Ollama-native note; xAI/Mistral; the 2.5-tier
   new-user-block note + 3.x default; thinking = model default until turned on) +
   `MORNING_RECAP.md` pointer paragraph (shas · plan doc path · what's open).
6. Handoff appended to the plan-doc copy: per-phase shas · every deviation the STOP
   protocol fired on · the OpenRouter/Mistral doc-verify results · the C6 JV
   origin-guard verdict (evidence file:line, or the opt-in branch taken) · the
   JustVoice notes (deps arrive on reinstall; reveal route inherited;
   `llm_roles_api.py:51` string-set unaffected) · ◆ the frozen-bundle note
   (planner second pass): the packaged JW server is a PyInstaller bundle whose
   deps flow transitively from the runner's pyproject via the `bundle` extra
   (`server/pyproject.toml:22,28-31`) — the three SDKs ride in automatically, but
   the NEXT packaged build must be smoke-tested (google-genai's google-auth/
   websockets sometimes need PyInstaller hidden-import hooks); dev is unaffected.

**The user's box-check list (the user runs it):**
> **✅ Box-checked good 2026-07-20 (user).** The re-add flow for Gemini / Claude / Ollama
> and the #12 key mask/reveal all pass on the real box. STILL OPEN: OpenAI, xAI and Mistral
> are live-unverified until funded keys exist — connect them then. Closed (except the
> funded-key remainder) in `justwrite-app/docs/TASKS.md`.
- Delete the Gemini provider → restart → row reappears typed `gemini` → paste key →
  Fetch lists BARE 3.x ids (no `models/` prefix, no veo/imagen noise) → chat streams
  on a 3.x model · entitySweep returns valid JSON · Ask-the-book rebuild works on
  `gemini-embedding-001` · thinking follows the preset (numbers, D6-A).
- Same delete-restart-repaste for Claude → Fetch shows models (live list, curated
  fallback keyless) · chat needs a funded key.
- Same for Ollama (local) → chat works AND a preset `min_p` change alters sampling.
- OpenAI: nothing to re-add; live-verify awaits a funded key. xAI/Mistral: rows
  appear after restart; connect when the user has keys.
- #12: open a saved provider → key sits masked in the field · eye reveals · Fetch and
  Test work WITHOUT touching the field · clearing + Save removes the key.

## 10 · Escalation (STOP means stop)

STOP and report when: an SDK surface differs from a proof item above (param missing,
exception class absent) · any pre-existing test breaks unrelated to your diff · a
fires-proof cannot fail-before/pass-after · anything would put a stored key in a log
line · the OpenRouter/Mistral doc-verify contradicts the profile table · a phase
exceeds 2× its budget · `pip install` of an SDK fails in the test env.

## 11 · Budget & rollback

Preconditions 20m · C1 1h · C2 2.5h (◆ +the base.py helper promotion + the two
existing-copy migrations) · C3 1.5h · C4 3h (◆ +the editor column sets + the two
test repurposes) · C5 30m · C6 1.75h (◆ +the JV origin-guard verify) · C7 1h —
**total ~11.5h.** One commit per phase; each reverts independently. Seeds are
insert-if-missing — revert + delete-and-re-add restores prior provider state. No
data migrations. The reveal route is one commit (C6) — reverting restores write-only
keys. Dep revert = the pyproject lines + pip uninstall.

---

## BUILD RECORD — builder 1 (Preconditions · C1 · C2)

Executed 2026-07-17, Windows box, branch `claude/admiring-galileo-il3q0o`, both repos.
Nothing pushed. All product-code commits cleared the delegated commit-gate via a genuine
rules-checker `VERDICT: PASS` read from this builder's own transcript; the two test-only
commits escaped as low-risk. Every commit subject is the plan's verbatim string (a
standard `Co-Authored-By` trailer is the only added line).

### Shipped, per phase — commit shas

- **Preconditions** (runner + JW):
  - runner **`70dc9c5`** `feat(engine): download settings — section header + 1-16/0-10 caps (#9 #10)` (LuRunnerEngine.vue, config.py, runner_config_api.py, download.py, tests/test_download.py).
  - runner **`6f23b7d`** `feat(tasks): rate-relative stalling classifier (#5)` (streamFreshness.js NEW, aiTasks.js, AiTaskStrip.vue, AiStatusPanel.vue).
  - JW **`86a27d6`** `test: pin the rate-relative freshness classifier (#5)` (streamFreshness.test.js NEW).
  - §1.5 SDKs installed into the pytest env (`E:\Python310`, py 3.10.11) + import-verified.
- **C1** (§3): runner **`05013c5`** `feat(llm): SDK deps + native seed types + reasoning-map cascade delete (#15)` (pyproject.toml deps+comment, seed.py DEFAULT_PROVIDERS retype, stores.py cascade-delete, useProviderConnect.js OpenRouter chip fix, tests/test_seed_providers.py NEW). Paired JW **`34fd0f7`** `test(seed): native provider types follow the runner seed flip (#15 C1)` (server/tests/test_seed.py:52 claude→anthropic + comment :49-50).
- **C2** (§4): runner **`a9fe7fd`** `feat(gemini): official google-genai SDK adapter (#15)` (base.py +4 helpers, gemini.py full SDK rewrite, openai_compat.py + ollama.py migrated to build_chat_messages, tests/_sdk_fakes.py NEW, tests/test_base_helpers.py NEW, tests/test_adapter_extra.py gemini portions rewritten, 7 fixtures under tests/fixtures/gemini-sdk/).

### Fires-proof (red-BEFORE / green-AFTER — both states actually run)

- **C1 seed-pin + cascade** (`tests/test_seed_providers.py`): RED before the seed.py/stores.py
  changes — both tests failed (old seed values; cascade left 5 leftover ReasoningMap rows).
  GREEN after — 2 passed.
- **C1 cross-repo coupling** (`JW server/tests/test_seed.py`): RED after the runner seed flip
  (`test_seed_creates_providers_but_no_demo` failed on the claude==openai-compat assertion),
  GREEN after flipping to `anthropic` — 9 passed.
- **C2 min_p-400 trigger bug** (`test_gemini_build_config_maps_typed_and_drops_unsupported`):
  RED with a `cfg.update(extra or {})` naive-merge injected into `_build_config`
  (min_p/mirostat/samplers/raw-stop leaked), GREEN after reverting the injection.

### Test-suite results (honest)

- Runner precondition gate `pytest tests/test_download.py`: **13 passed**. JW `npm run test:unit`: **202 passed**.
- C1: `test_seed_providers.py`+`test_shared_storage.py`+`test_provider_api.py`+`test_reasoning.py` **32 passed**. JW `test_seed.py` **9 passed**.
- C2: `test_base_helpers.py`+`test_adapter_extra.py` **24 passed**. Compat/ollama migration behavior-neutral proof: `test_adapter_extra`+`test_llm_dispatch`+`test_llm_api`+`test_plane2_params` **49 passed** (their existing tests untouched, green).
- **FULL runner suite** `pytest tests/` after C2: **547 passed, 2 failed, 1 skipped**. `ruff check` on all changed files: **clean**.
- **Pre-existing failures (NOT mine):** only **2**, not the plan's predicted 3 —
  `tests/test_hardware.py::test_pci_gpus_linux_lspci_name_match` (lspci OSError on Windows) and
  `tests/test_lifecycle.py::test_ensure_model_ready_raises_on_failed_load`. The plan said "2×
  ensure_model_ready"; in fact only ONE of the four `ensure_model_ready` tests fails (the other
  three pass). Confirmed pre-existing by stashing the C1 python changes and re-running — both
  still failed. **No fourth/new failure appeared at any point.** Both modules are untouched by
  builder 1.

### Offline-verify results (C2, proof venv `…\scratchpad\gproof-venv`, google-genai==2.12.1)

- **Content/Part construction (C2.2):** `types.Content(role='user', parts=[types.Part(text='x')])`
  constructs cleanly. Recorded in `gemini.py._contents` comment.
- **google.genai errors surface (C2.3):** module exposes `APIError`, `ClientError`, `ServerError`,
  `FunctionInvocationError`, `UnknownApiResponseError`, … **`APIError` has NO class-level `.code`**,
  but INSTANCES carry `.code` (int HTTP status, from `__init__(code:int, response_json, response=None)`),
  `.status` (e.g. "NOT_FOUND"), `.message`. So the plan's `e.code` works on instances — used as
  written. Also verified `Model.supported_actions` exists, `EmbedContentResponse.embeddings[].values`
  yields the vector, `ThinkingConfig(thinking_level=…)`/`(thinking_budget=-1)` and
  `EmbedContentConfig(task_type=…)` construct.

### Deviations / decisions (none required a STOP — all mechanical, within the plan)

1. **Exact SDK pins installed** (`google-genai==2.12.1`, `openai==2.46.0`, `anthropic==0.117.0`)
   rather than the unpinned `pip install` — matches the §0.5 live-proof surfaces the snippets
   were transcribed from; within the pyproject `>=` ranges.
2. **Fixture cleaning:** raw captures FAILED `GenerateContentResponse.model_validate` because
   `thought_signature` was serialized as a Python bytes-repr string (a capture artifact, not
   valid base64). Stripped `thought_signature` (and `sdk_http_response` header noise) from the
   committed fixtures so they validate; the parse tests use only text/finish/usage, none of the
   stripped fields. Re-grepped the committed copies for `AIza` → clean.
3. **`extra["stop"]` shape:** verified normalized to a LIST upstream (`prompts.py:403-410`) BEFORE
   any adapter, so gemini's `stop_sequences` (the SDK requires a list, stricter than the old httpx
   path) is satisfied with no coercion. (Caught a smoke that used a string; the real path is a list.)
4. **Left uncommitted, NOT builder 1's (outside the plan's exact file lists):** runner
   `docs/plans/2026-07-06-outstanding-master-plan.md` (a forward-looking "F6 — online TTS for JV"
   ledger note the user added 2026-07-17, unrelated to #5/#9/#10, in neither commit A nor B's file
   list) + this plan doc (untracked). JW `PROXYAI.md` (untracked, unrelated). None touched.

### What builder 2 (C3) + builder 3 (C4/C5) MUST know

- **base.py now owns the 4 shared helpers** (`build_chat_messages`, `split_system`,
  `select_allowed`, `adapter_http_error`). C3 anthropic: make `_split_system` a thin call to
  `base.split_system` (dict-ify the remainder), `_map_extra` an allowlist over `select_allowed`,
  and errors via `adapter_http_error`. C4 openai_sdk: `build_chat_messages` (CC path) +
  `split_system` (Responses input) + `select_allowed` (profiles) + `adapter_http_error`.
- **`tests/_sdk_fakes.py`** exists: `KwargsCapture` (records `self.last` via `_capture(**kwargs)`)
  + `load_fixture("<dir>/<name>.json")`. Build per-SDK fakes as thin subclasses (gemini's
  `_FakeGenaiModels` in test_adapter_extra.py is the template).
- **base.py `LLMAdapter.embed` Protocol still has NO `task_type`** — that is C5's job (I did not
  touch it). gemini's `embed(…, task_type="")` is already a superset; until C5 wires `api.py`,
  it's called without task_type and defaults to "".
- **In `test_adapter_extra.py` I did NOT touch** `test_openai_compat_reasoning_cloud_vs_local`
  (still constructs `OpenAICompatAdapter("p","openai",…)`) or
  `test_stream_chat_return_progress_only_for_builtin` (its `("openai", False)` row). Both PASS today
  because compat still carries the `openai` default. **C4.2 removes `openai` from compat's
  PROVIDER_DEFAULTS + the dead `_apply_reasoning` cloud branch, so C4 must repurpose both tests**
  (plan §6 C4.3) — they will break at construction otherwise.
- **gemini.py `DEFAULT_MODEL = "gemini-flash-lite-latest"`** (2.5 tier is new-user-blocked). The
  D6-A thinking-surface REOPEN note lives in the gemini.py module docstring.
- Ollama seed row now `http://localhost:11434` (NO `/v1`) + type `ollama`; claude→`anthropic`
  (`https://api.anthropic.com`), gemini→`gemini` (`https://generativelanguage.googleapis.com`).

---

## BUILD RECORD — builder 2 (C3 · C4)

Executed 2026-07-17, Windows box, branch `claude/admiring-galileo-il3q0o`, both repos.
Nothing pushed. Both product-code commits cleared the delegated commit-gate via a genuine
rules-checker `VERDICT: PASS` read from this builder's own transcript. Every commit subject is
the plan's verbatim string (`Co-Authored-By` trailer only added line). pytest env = `E:\Python310`
(py 3.10.11), SDKs `anthropic==0.117.0` · `openai==2.46.0` · `google-genai==2.12.1`.

### Shipped, per phase — commit shas

- **C3** (§5): runner **`e05e5b5`** `feat(anthropic): official anthropic SDK adapter (#15)`
  (anthropic.py full SDK rewrite — kept `_apply_reasoning`/generation-split verbatim, `_split_system`
  → thin `base.split_system`, `_map_extra` → `base.select_allowed` allowlist, D8 live-with-fallback
  models(), D10 errors, ping via SDK, NO embed (clean-400 preserved); tests/test_adapter_extra.py
  anthropic block added).
- **C4** (§6): runner **`8a1f8d9`** `feat(llm): official openai SDK adapter — Responses + CC clouds,
  xAI + Mistral (#15 #14)` (openai_sdk.py NEW; openai_compat.py PROVIDER_DEFAULTS trim + docstring +
  DEAD cloud reasoning branch deleted; registry rewire; schema/provider_api/seed/reasoning_map_api
  vocabulary; ui useProviderConnect + ProviderForm dropdown + D5 column reconcile; seed drift-guard
  comment; tests: openai_sdk block + 2 repurposed tests + dispatch tests + seed-pin xai/mistral).

### Fires-proof (red-BEFORE / green-AFTER — both states actually run)

- **C3 `_map_extra` allowlist** (`test_anthropic_map_extra_is_an_allowlist`): RED against the old
  pass-through `_map_extra` — min_p/mirostat/samplers/seed (4 keys) leaked through; GREEN after the
  allowlist rewrite (only top_p/top_k/metadata + stop→stop_sequences survive).
- **C4 two repurposed tests** (`test_openai_compat_reasoning_*`, `test_stream_chat_return_progress_
  only_for_builtin`): RED — both broke at CONSTRUCTION (`OpenAICompatAdapter("p","openai",…)` now
  raises ValueError since compat's "openai" defaults entry is removed); GREEN after repurposing to
  compat's two remaining types (local-llamacpp + openai-compat).
- **C4 min_p-400 drop on the SDK path** (`test_openai_sdk_cc_profiles_filter_and_rename`): RED with a
  naive `kept = dict(extra or {})` merge injected into `_cc_params` — mirostat + the samplers order
  array leaked; GREEN after reverting to `select_allowed(extra, TYPE_PARAM_PROFILES[pt])`.

### Test-suite results (honest, vs the 2-failure baseline)

- **C3** targeted (`test_adapter_extra`+`test_plane2_params`+`test_llm_dispatch`+`test_llm_api`):
  **61 passed**. FULL runner suite after C3: **553 passed, 1 failed, 1 skipped** (only the lspci
  baseline; `test_ensure_model_ready_raises_on_failed_load` PASSED that run). ruff on changed files: clean.
- **C4** targeted (`test_adapter_extra`+`test_llm_dispatch`+`test_plane2_params`+`test_seed_providers`
  +`test_reasoning`): **88 passed**. FULL runner suite after C4: **565 passed, 3 failed, 1 skipped**.
  ruff on all 10 changed runner files: **clean**.
- **The 3 failures are NOT mine — all in `tests/test_hardware.py` + `tests/test_lifecycle.py`, which
  my diff never touches.** `test_pci_gpus_linux_lspci_name_match` = the known Windows lspci-colon-path
  baseline. The two `ensure_model_ready` lifecycle tests are the flaky set builder 1 flagged (failing
  subset varies run-to-run). **Proven not mine by STASH: with ALL C4 changes stashed the lifecycle
  tests STILL fail** (`RuntimeError: model 'test-model' failed to load` inside `lifecycle.py:2135`,
  untouched code). No new/fourth failure from my adapter diff at any point.

### BUILD-TIME verify steps (both required by §6 — results verbatim)

1. **openai Responses event-class introspection** (`openai==2.46.0`, this session): stream `type`
   strings — `ResponseTextDeltaEvent`=`'response.output_text.delta'` (`.delta` str) ·
   `ResponseCompletedEvent`=`'response.completed'` (`.response.usage`) · `ResponseFailedEvent`=
   `'response.failed'` · `ResponseErrorEvent`=`'error'` · `ResponseIncompleteEvent`=
   `'response.incomplete'`. Non-stream: `Response.output_text` is an aggregation **property**;
   `Response.usage`→`ResponseUsage(input_tokens/output_tokens)`; `Response.status` +
   `Response.incomplete_details.reason`. `openai.APIStatusError` instance carries `.status_code`
   (constructed a 404 → `.status_code == 404`); `openai.APIConnectionError` present (no status_code
   → D10 None form). All create/embeddings typed params confirmed present. → the stream parser + parse
   pin exactly to these (recorded in `openai_sdk.py:15-28`).
2. **OpenRouter/Mistral/DeepSeek/xAI doc-verify** (official docs, no live call — all 5 CONFIRMED, no
   contradiction → no STOP): OpenRouter documents `reasoning_effort` AND the samplers `top_k`/`min_p`/
   `repetition_penalty` (openrouter.ai/docs/api-reference/parameters); Mistral uses `random_seed` (NOT
   `seed`) and supports a real `json_schema` `response_format` (docs.mistral.ai/api); DeepSeek's
   `response_format` is `json_object` ONLY, no `json_schema` (api-docs.deepseek.com); xAI supports
   `json_schema` (docs.x.ai/docs/guides/structured-outputs). → matches `TYPE_PARAM_PROFILES` +
   `TYPE_EXTRA_BODY_RENAMES` + the deepseek downgrade / xai+mistral pass-through (recorded in
   `openai_sdk.py:22-28`, `:80-83`).

### STOP / deviation — ONE finding (pre-existing, NOT in my scope; §10 "a pre-existing test breaks unrelated to your diff")

**Keyless `gemini` provider fails to CONSTRUCT on a box with no `GEMINI_API_KEY`/`GOOGLE_API_KEY` env
var — breaks JW `server/tests/test_seed.py::test_seed_creates_providers_but_no_demo` (the
`assert all(p["registered"])` line).** Root cause is **builder 1's C2 gemini constructor**
(`gemini.py:82` `genai.Client(api_key=api_key or "", …)`): `google-genai==2.12.1` raises
`ValueError: No API key was provided` when the api_key is an empty string AND no env key is present.
Builder 1's shell had a gemini key exported from the live-proof session, so the env fallback made
`genai.Client(api_key="")` construct → their "JW test_seed.py 9 passed". On a clean box it raises →
`_sync_register` logs boot-skip → gemini `registered=False` → the JW assertion fails.
- **Proven NOT mine:** with ALL C4 changes STASHED the JW test STILL fails; and with a fake
  `GEMINI_API_KEY` set it goes **9 passed** WITH my xai/mistral additions in place (so my additions
  register cleanly and are cross-repo clean; the sole cause is keyless-gemini construct).
- **Did NOT fix it** — it is builder 1's C2 file, a different phase, and the fix is a small design
  choice I must not make alone (per §10 / "never own decisions"). **Suggested fix for the coordinator
  to route to builder 1 / rule on:** mirror the pattern this plan already blesses elsewhere — anthropic
  uses `api_key or ""` (SDK tolerates empty) and openai_sdk uses `api_key or "sk-no-key"`; gemini's
  constructor should pass a non-empty placeholder (e.g. `api_key=api_key or "no-key"`) so a keyless
  seeded gemini constructs + registers (real calls still 401/403 without a key, and models()/ping()
  already swallow errors). This is a **C7 blocker** — the JW server suite is red on any box without a
  gemini env key until it's addressed.

### What builder 3 (C5 · C6 · C7) MUST know

- **openai_sdk.py `embed(self, texts, *, model=None, task_type="")` already accepts+ignores
  `task_type`** (C4.1 wrote it in). C5 still owns adding `task_type=""` to `openai_compat.py` +
  `ollama.py` embeds and the `base.py` Protocol + `api.py:248` unconditional pass-through. anthropic
  deliberately has **no** `embed` (clean-400 via `api.py` getattr) — do not add one in C5.
- **The gemini keyless-construct STOP above is a C7 blocker.** C7's full JW `test:server` will be red
  on this box until gemini's constructor tolerates a keyless build (or a `GEMINI_API_KEY` env is set).
  Fold the fix (or its ruling) before the C7 verification pass, else C7 cannot report the JW suite green.
- **`test_llm_dispatch.py` gained** `test_registry_constructs_openai_sdk_for_all_five_types` +
  `test_registry_compat_openai_without_base_url_raises`. **`test_adapter_extra.py` fakes**: the openai
  fakes (`_FakeResponses`/`_FakeChatCompletions`/`_FakeEmbeddings`/`_FakeOpenAIClient`, thin
  `KwargsCapture` subclasses) live inline there alongside anthropic's `_FakeAnthropic` — reuse them.
- **Renderer gate (C7):** the ProviderForm.vue D5 column change (deepseek → MODEL_DEFAULT_TYPES, the
  "runs at the model's own default" line, xai/mistral dropdown) is UNVERIFIED in a rendered UI (no
  headless smoke run this phase — the runner UI has its own harness, not the JW one). C7 should render
  the provider form for a deepseek/xai/mistral type and confirm the reasoning popup shows the line, not
  empty columns. vitest/JW-smoke did not cover this runner-UI file.
- **Vocabulary is complete for xai/mistral** across: registry · openai_sdk.PROVIDER_DEFAULTS/PROFILES ·
  provider_api.PROVIDER_TYPES · seed.DEFAULT_PROVIDERS · REASONING_MAP_TYPE_SEEDS · schema doc ·
  useProviderConnect (PRESETS + ONLINE_ONLY_TYPES) · ProviderForm (dropdown + columns). The C6 #12
  key-reveal work + C7 docs (`docs/models.md` xai/mistral + the delete→restart→re-add flow) remain open.

---

## BUILD RECORD — builder 3 (PRE-FIX · C5 · C6 · C7)

Executed 2026-07-17, Windows box, branch `claude/admiring-galileo-il3q0o`, both repos. Nothing
pushed. Every product-code commit cleared the delegated commit-gate via a genuine rules-checker
`VERDICT: PASS` read from THIS builder's own transcript; the test-only + doc-only commits escaped
as low-risk / exempt. pytest env = `E:\Python310` (py 3.10.11), SDKs `google-genai==2.12.1` ·
`openai==2.46.0` · `anthropic==0.117.0`. Commit subjects are the plan's verbatim strings
(`Co-Authored-By` trailer only added line); phases with no plan-verbatim string (pre-fix, the
paired JW/docs/fix commits) use the coordinator's given message or a descriptive one.

### Shipped, per phase — commit shas

- **PRE-FIX** (coordinator-ruled, builder 2's STOP): runner **`95ea74e`**
  `fix(gemini): keyless construct — dummy key, the C4.1 sk-no-key device (#15)` — `gemini.py:87`
  `genai.Client(api_key=api_key or "no-key", …)` (was `or ""`, which `google-genai==2.12.1` raises
  `ValueError: No API key was provided` on with no env key) + the fires-proof test.
- **C5** (§7): runner **`0bc8e49`** `feat(llm): task_type-aware embeddings protocol (#15)` —
  base.py Protocol `embed(…, task_type="")` + docstring (also corrected the stale "Gemini omits
  embed" line — Gemini embeds now); `openai_compat.py` + `ollama.py` embeds accept+ignore
  task_type; `api.py` unconditional `embed(task_type=body.taskType)` + the route docstring drops
  "Gemini"; `test_llm_api.py` FakeEmbedAdapter + a new pass-through test. (openai_sdk already had
  it; anthropic has NO embed on purpose.)
- **C5 whole-job fix** (found in C7 verification — the plan's C5 enumeration MISSED a second fake
  embed adapter): runner **`83ea80e`** `test(embed): RecordingEmbedAdapter accepts task_type — C5
  whole-job (#15)` — `tests/test_embed_templates.py:30`. Test-only.
- **C6** (§8, #12): runner **`d3a6aee`** `feat(providers): saved key in a password field with eye
  reveal; Fetch/Test carry it (#12)` — `provider_api.py` opt-in POST `/key/reveal` route (gated by
  new `make_provider_router(get_store, allow_key_reveal=False)`); `install.py` threads
  `install_llm(allow_key_reveal=False)`; kit `UiSecretInput.vue` (NEW, wraps UiInput) + `EyeOff`
  glyph in `Icon.vue` + `common/index.js` export; `useProviderConnect.js` `revealKey` helper;
  `ProviderForm.vue` reveal-on-open + UiSecretInput + key-wipe guard; `test_provider_api.py` reveal
  + gating tests. Paired JW **`541b50b`** `feat(providers): opt in to key reveal + mount-pin the
  key-wipe guard (#12 C6)` — `server/app.py` `install_llm(allow_key_reveal=True)` +
  `ProviderForm.keyReveal.test.js` (jsdom mount).
- **C7** (§9): JW **`d61a749`** `test(providers): mount-verify the D5 reasoning-column reconcile
  renders (#15 C4 C7)` (`ProviderForm.reasoningColumns.test.js` — closes builder 2's unrendered-D5
  flag) + JW **`5c47423`** `docs: native provider types, #12 key reveal, delete-restart-readd +
  recap pointer (#15 #12 C7)` (`docs/models.md` providers section + `MORNING_RECAP.md` GO pointer).

### Fires-proof (red-BEFORE / green-AFTER — both states actually run)

- **PRE-FIX** (`test_gemini_constructs_keyless_when_no_env_key`, env cleared via `monkeypatch.delenv`):
  RED on `or ""` (ValueError), GREEN on `or "no-key"`. DOWNSTREAM proof both states run: JW
  `server/tests/test_seed.py` with `GEMINI_API_KEY`/`GOOGLE_API_KEY` UNSET — **1 failed** (the
  `all(registered)` line) before, **9 passed** after.
- **C5** (`test_embeddings_passes_task_type_through`): RED with `api.py` passing only `model=` (the
  fake never saw the side), GREEN after the unconditional `task_type=body.taskType` pass.
- **C6 gating** (`test_key_reveal_absent_by_default` — the JV-safe-default guard): RED with the
  route ungated (`if True or allow_key_reveal` → the credential route leaks at default OFF), GREEN
  gated. Plus `test_key_reveal_opt_in_returns_stored_key` GREEN (returns the key; 404 unknown).
- **C6 key-wipe guard** (JW `ProviderForm.keyReveal.test.js`, PATCH-body capture): the "reveal-OK +
  cleared → apiKey null" case RED with the old `isNew ? null : ""` formula (sent `""`), GREEN with
  `revealLoaded ? null : ""`. Both ways proven (reveal-FAIL + untouched → `""`).
- **C7 embed-fake** (the 3 `test_embed_templates.py` regressions): RED (TypeError — the fake lacked
  task_type), GREEN after it accepts+ignores it.

### JV origin-guard verdict (the §8.1 ◆ requirement) — **NOT FOUND → opt-in branch taken**

Read JustVoice's live server (`E:\Dev\Web\JustVioce\server\justvoice\app.py`, folder is typo'd
"JustVioce"): it mounts `make_provider_router(get_provider_store)` **directly at :200** (NOT via
`install_llm`), and its middleware stack is a CONDITIONAL `CORSMiddleware` (`:161-169`) +
`BearerAuthMiddleware` (`:173`) — **no `CsrfOriginMiddleware`-equivalent origin guard on mutating
methods**. JW mounts `CsrfOriginMiddleware` at `justwrite-app/server/justwrite_server/app.py:134`.
Per the plan's decision rule → NOT FOUND → the opt-in branch: `make_provider_router(get_store,
allow_key_reveal=False)` default; JW opts IN, JV inherits the safe default (its direct call gets
False, so the credential route is simply ABSENT there — proven by `test_key_reveal_absent_by_default`).
**Plan-wording nuance (a deviation from the literal text, faithful to its intent — NOT a STOP):**
the plan said "JW's `install.py:122` call site sets True", but `install.py` is the SHARED runner
install both apps' routers flow through (JW via `install_llm`; JV does NOT use `install_llm` at
all). Hardcoding True at `install.py:122` would give JV True (unsafe) — contradicting the plan's
own stated goal. So `allow_key_reveal` was threaded through `install_llm`'s signature (default
False); JW's `install_llm(allow_key_reveal=True)` opts in, JV's direct `make_provider_router(...)`
call inherits False. This achieves the plan's exact intent ("JV inherits the SAFE default"); the
final combined rules-checker independently confirmed it is strictly safer than the literal reading
and faithful to the ruled decision.

### Test-suite results (honest, vs the 2-failure baseline)

- **Runner FULL** `pytest tests/` (final): **570 passed, 2 failed, 1 skipped**. ruff `check .`:
  **clean**. The 2 failures are the documented baseline — `test_hardware.py::test_pci_gpus_linux_lspci_name_match`
  (lspci `OSError` on Windows) + `test_lifecycle.py::test_ensure_model_ready_raises_on_failed_load`
  (the flaky lifecycle test builders 1+2 stash-proved pre-existing). **My diff touches neither
  `test_hardware.py` nor `test_lifecycle.py`/`lifecycle.py`.** Baseline delta = **0** — the 3
  `test_embed_templates.py` regressions I introduced in C5 (the second fake embed adapter) were
  found + fixed (`83ea80e`) before the final run.
- **JW**: `npm run test:unit` **209 passed** (202 pre-feature + 4 key-reveal mount + 3 D5 column
  mount) · `npm run test:server` (env cleared) **110 passed** · `npm run build:vite` **green** ·
  biome **clean**.
- **Renderer headless smoke: NOT RUN (honest skip).** The smoke needs a booted server + dev:vite on
  the user's live :17495/:1420, which the HARD RULES forbid touching; and this is a Windows box, not
  the Linux dev container the smoke's `findChrome()` targets. The ProviderForm renderer delta
  (UiSecretInput reveal field + the D5 column reconcile) is covered by the two JW vitest MOUNTS +
  `build:vite` compile + biome — plus the user's box check for the visual/LOOK confirmation.

### Rules-checker verdict on the FINAL COMBINED diff (contracts tier)

**`VERDICT: PASS`, no failures.** One checker (Opus, `subagent_type rules-checker`) over the whole
feature — runner `05013c5^..HEAD` (8 commits, 35 files) + JW `34fd0f7^..HEAD` (6 files). It
independently verified all five contract seams hold with NO cross-builder drift: the adapter
Protocol constructor/embed uniformity (anthropic has no embed, `api.py` getattr-400 holds); the D10
error-string contract routing through `adapter_http_error` so the kit's `friendlyAiError` regex
parses all shapes; xai/mistral vocabulary complete across all nine lists; the POST-not-GET,
never-logged, opt-in credential route; and the seed retype ↔ JW test_seed coupling + the gemini
keyless-register fix. Non-blocking notes it raised (both addressed): the missing builder-3 record
(this section) and the deferred visual LOOK (the user's box check).

### Docs updated (same wave, §9.5)

- JW `docs/models.md` — new providers note after the connect-a-provider paragraph: the native SDK
  types + xAI/Mistral; the masked-key **eye reveal** (Fetch/Test carry it, clearing+Save removes
  it); Gemini's **3.x flash-lite** default + the 2.5-tier new-user block + bare-id/noise-filtered
  Fetch; thinking = model default until turned on (DeepSeek/xAI/Mistral always model-default); and
  the **delete → restart → re-add → paste key** migration flow for pre-existing Claude/Gemini/Ollama
  rows.
- JW `MORNING_RECAP.md` — a GO (2026-07-17) pointer paragraph: what shipped, all shas (runner + JW),
  and the OPEN box-check list.

### Frozen-bundle note (§9.6, planner second pass) — carried forward

The packaged JW server is a PyInstaller bundle; the runner rides in via the `bundle` extra
(`justwrite-app/server/pyproject.toml:31` — `llm-runner @ git+…@claude/admiring-galileo-il3q0o`;
context at `:17-23`), so the three vendor SDKs arrive transitively with NO manual bundle change.
**But the NEXT packaged build must be smoke-tested** — `google-genai` pulls `google-auth` +
`websockets`, which sometimes need PyInstaller hidden-import hooks. **Dev is unaffected** (editable
install). JustVoice inherits the three SDK deps whenever it reinstalls the runner (F1 handoff);
`llm_roles_api.py:51`'s string-set is unaffected; the key-reveal route is NOT inherited by JV (safe
default).

### What remains OPEN for the user's box check

The plan's §9 box-check list stands (the user runs it): delete→restart→re-add each of
**Gemini / Claude / Ollama-local**, paste key, **Fetch** → chat streams · entitySweep returns JSON ·
Ask-the-book rebuilds on `gemini-embedding-001` · thinking follows the preset (Gemini numeric rows,
D6-A). **#12**: open a saved provider → key sits masked · the **eye** reveals · **Fetch/Test work
WITHOUT retyping** · clearing + Save removes the key. **xAI / Mistral** rows appear after restart;
connect when the user has keys. **OpenAI / xAI / Mistral ship tests-green, live-unverified** (no
funded keys authorized). Plus the visual **LOOK** the builders could not run headless: eyeball the
eye-toggle placement in the key field and the "runs at the model's own default" line for
deepseek/xai/mistral (both are vitest-mount-verified for CONTENT, not pixels).

### STOP / deviations (none required a STOP — all mechanical or plan-intent-faithful)

1. **The `install.py` threading nuance** (recorded in the JV-verdict section above) — a deviation
   from the plan's LITERAL "install.py:122 sets True", faithful to its explicit intent ("JV inherits
   the SAFE default"); rules-checker-confirmed strictly safer + faithful.
2. **The C5 whole-job gap** — the plan's C5 enumeration named only `test_llm_api.py`'s
   FakeEmbedAdapter; a SECOND fake (`test_embed_templates.py`'s RecordingEmbedAdapter) also needed
   `task_type`. Found in C7 full-suite verification, fixed (`83ea80e`). An enumeration gap, not a
   design decision.
3. **Two cosmetic self-catches during execution** (both fixed before commit, recorded for honesty):
   a duplicated comment block in `gemini.py` from a revert/re-apply cycle (rules-checker flagged; my
   revert-to-prove-RED then re-apply doubled it) and a stale `api.py:248` line-ref in a C5 test
   comment (dropped the brittle number). Neither shipped.

## FOLLOW-UP — #16 lazy SDK-client construction (2026-07-18, main session, coordinator-built)

The dummy keys the builders introduced (`"no-key"` gemini, `"sk-no-key"` openai_sdk) were a
wart the user flagged ("i would not design something that has to have a dummy key"). Removed
by making all three SDK adapters build their client LAZILY (`_ensure_client()` on first real
call) instead of eagerly in `__init__` — verified live in the proof venv that
`genai.Client(api_key="")` and `openai.OpenAI(api_key="")` RAISE at construction (hence the
dummies) while `anthropic.Anthropic(api_key="")` constructs fine. Deferring the build lets a
keyless seeded row register with no placeholder; the first real call surfaces the SDK's own
no-key error via `adapter_http_error(..., None, ...)` ("{type} request failed …"), and
`models()`/`ping()` keep degrading to `[]`/`False`. `_ensure_client()` respects an already-set
`self._client`, so the 40 fake-client tests are unchanged. anthropic joins the lazy shape for
uniformity. Commit: runner `69d764f`. Fires-proof: 3 new `test_*_lazy_*` (RED on the old eager
`_client is None` assertion → GREEN). Full runner pytest 572✓/2-baseline; JW `test_seed` green
with ALL provider env keys cleared (the real proof — keyless rows register with neither a dummy
nor an env key). ONE rules-checker on the diff: PASS. Queued follow-up recorded as todo #16 done.
