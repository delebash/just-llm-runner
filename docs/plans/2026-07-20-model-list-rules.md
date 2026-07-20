# Online-provider model-list cleanup — the config-driven ruleset (#8)

**Shipped 2026-07-20.** An online provider's `/v1/models` dump is mostly noise for a
writing/voice app: OpenAI returns 400+ ids (image / realtime / audio / tts / whisper /
moderation / legacy chat), Gemini returns imagen / veo / lyria / tts / image variants. The
just-shipped ProviderForm autoload lands all of it in the pickers automatically. The app
uses ONLY chat + embedding models. This unit classifies + prunes that list by DATA
(per-provider-TYPE rules), never hardcoded logic, and hands the pickers a clean split.

## The mechanism (v2 design — 2026-07-20 rethink)

- **ONE drop mechanism: `dropPatterns` — a list of ANCHORED regexes.** There is no
  bare-prefix field. A prefix `gpt-4` would silently swallow a future flagship `gpt-45`;
  every drop carries a deliberate anchor/boundary (`^gpt-4($|[.o-])` drops the gpt-4/4o
  legacy family and SPARES `gpt-45`/`gpt-5`). This makes over-filtering impossible by
  accident (see the aging contract).
- Each provider TYPE's rule is `{embedPatterns, dropPatterns, collapseDated}`:
  `embedPatterns` re-buckets an id as an EMBEDDING model; `dropPatterns` hides it;
  `collapseDated` folds `-YYYY-MM-DD` snapshots under their bare alias.
- **Storage: ONE seeded JSON document (`model_list_rules`) in the existing
  runner-settings store** — `{seedVersion, rules: {providerType: {…}}}`, keyed by TYPE.
  NOT a new table/router; it mirrors how `default_preset_id` is stored + seeded (a
  `RunnerSetting` row). `built_in` is the unmodified-signal: a seeded/reset doc is
  `built_in=True` (a seed bump refreshes it in place); a user PUT flips it `False` so a
  reseed never clobbers it. GET/PUT + a reset-to-seed action at
  `/v1/ai/model-list-rules` (same settings-endpoint shape as engine-config).
- **Applied at the ENDPOINT, not the adapters.** `list_provider_models` +
  `probe_provider_models` (api.py) call the rule engine via an injected resolver seam
  (`set_model_list_rules_resolver`, the `set_embed_template_resolver` DI pattern);
  install.py wires it over the store. A provider TYPE with no rules row passes through
  unchanged; the built-in `local-llamacpp` bypasses entirely (never hide a downloaded
  model). Gemini's adapter D7 `supported_actions` filter STAYS in the adapter
  (capability-metadata-driven); the name rules only prune the residue on top.
- **Wire shape (back-compatible):** `{"models": [chat ids], "embeddings": [embedding
  ids], "hiddenCount": N}`; `?all=1` (or the probe's `all: true`) returns the raw
  unfiltered list (everything as `models`, `hiddenCount` 0). Existing consumers reading
  `r.models` keep working and simply get the clean chat list.

## The pipeline (per fetched id list)

1. **classify** — an id matching any `embedPatterns` → the embeddings bucket
   (classification wins over dropping: an embed id is kept even if it also matches a drop).
2. **drop** — a remaining id matching any `dropPatterns` → hidden.
3. **collapseDated** (if set) — group the chat survivors by base (id minus a trailing
   `-YYYY-MM-DD`); emit the bare alias IF it was itself fetched, else the NEWEST dated
   snapshot verbatim. NEVER emit an id that was not in the fetched list.
4. **regex safety** — every pattern compiles under try/except; an invalid one is skipped
   (warned once), never a 500. `hiddenCount = raw − chat − embeddings`.

## The seeds (DATA — patterns, editable later; no model-id allowlist)

- **openai** — `collapseDated`; drop the legacy chat generations (anchored so gpt-5+/gpt-45
  survive) + the non-chat families (image / realtime / audio / tts / transcription /
  moderation / video / tools / legacy completions) + `-preview`/`-instant` snapshots;
  classify `^text-embedding-`.
- **gemini** — drop imagen / veo / lyria / aqa / learnlm + the retired 1.0/1.5/2.0
  generations + `-tts`/`-live`/`-image`/`-exp` variants; classify the embedding families.
- **anthropic** — empty (its list endpoint is already curated; no embeddings).
- **openai-compat** — classify `embed` only, drop NOTHING (the BYO universe — LM Studio /
  OpenRouter-compat / vLLM — is unknowable, so it must be over-filter-safe).
- **deepseek / openrouter / xai / mistral** — classify `embed` only, no drops (their lists
  are already close to chat-only; under-filter until a seed says otherwise).

### Judgment calls (verified against upstream docs 2026-07-20, not recall)

- **o-series reasoning models are KEPT.** They match none of the OpenAI drops; the anchored
  `^gpt-4(…)` is precisely why they (and any `gpt-45`/`gpt-5`) survive.
- **NO blanket `-preview` drop for Gemini.** Gemini ships new models PREVIEW-first (a new
  Pro/Flash lands as `-preview` before GA), so a blanket drop would hide the NEWEST model.
  OpenAI, which promotes GA aliases, DOES drop `-preview`.
- **openai-compat classifies but never drops.** This preserves today's `/embed/i` split
  for LM Studio while guaranteeing a locally-loaded model is never hidden.

## The aging contract (design intent — keep it when editing seeds)

- The DESIGNED failure mode is **under-filtering**: a new noise family the seeds don't know
  yet appears as noise until the seed updates. Acceptable + self-healing (a `SEED_VERSION`
  bump refreshes every unmodified install).
- **Over-filtering must be impossible by accident**: anchored regexes only, a `?all=1`
  escape hatch, free-text model entry, and editable rules. OpenAI's `/v1/models` carries no
  capability metadata, so NAME rules are the only tool there; Gemini stays metadata-first.

## Client (kit)

- `useProviderModels` caches the full `{models, embeddings, hiddenCount}` record;
  `modelsFor()` returns chat ids (every picker improves for free), `embeddingsFor()` /
  `hiddenCountFor()` expose the rest; `refreshModels(id, {all:true})` refetches `?all=1`.
- `ProviderForm`'s embedding dropdown switches to the `embeddings` array; a muted
  "N models hidden — show all" affordance appears when `hiddenCount > 0` and refetches
  the raw list for the session. The `/embed/i` guess stays only as a client-side FALLBACK
  for local/unruled providers (ollama, LM Studio) that get no server split.
- `LuModelPicker`'s embedding-kind list uses `embeddingsFor()` with the same fallback.

## Future work (out of scope now)

- **Per-INSTANCE rule overrides.** Rules are keyed by provider TYPE. Two providers of the
  same type that need different rules (OpenRouter vs a local LM Studio, both openai-compat)
  would need per-instance overrides — matters only in that case; deferred.
- **OpenRouter richer filter.** OpenRouter's native `/api/v1/models` exposes
  `output_modalities`, a capability signal richer than name rules — a future metadata-first
  path for that provider.

## Verification

- Runner pytest: 25 new tests in `tests/test_model_list_rules.py` (rule engine —
  classification / anchored drops / anchor-doesn't-swallow-a-flagship / dated-collapse
  three ways / invalid-regex resilience / show-all / hiddenCount; endpoints applying the
  SHIPPED seeds to 30-id OpenAI + Gemini fixtures + `?all=1` bypass; store seed / user-edit
  / reset / seed-refresh + the CRUD router). `test_llm_api.py` updated for the new wire
  shape. ruff clean.
- Kit gates via JustWrite: `build:vite`, vitest (408), headless smoke (every route +
  provider form, zero JS errors).
- Scratchpad probe (`model-list-probe.mjs`): stubs the models endpoint with a 30-id split
  fixture, opens the provider Edit form, asserts the chat dropdown shows only the 6 clean
  ids, the "22 models hidden — show all" affordance renders, and clicking it refetches
  `?all=1` so the dropped ids reappear. 7/7, zero JS errors.
