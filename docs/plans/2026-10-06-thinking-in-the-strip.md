<!-- SPDX-License-Identifier: MIT -->
# 2026-10-06 · The model's thinking reaches the AI task strip

The user, 2026-10-06: "your rec go", on the lean as shown — "Lean: yes. Send it as its own kind
of stream message, so the strip says "thinking…" with a token count during that wait, and the
done speed counts all the tokens. It touches every AI stream in all three apps, so I'd first
bring you the plan with the table of every caller it affects." This page is that plan.
**Status: BUILT 2026-10-06** — the build's go ("go on rest your rec") answered §5 as leaned, all
four yes; what was checked live is in TASKS "The model's thinking reaches the AI task strip".

## 1 · What it is

While a model thinks, its task strip says **thinking…** with a live token count, instead of an
empty wait that reads *first token in 27 s*. When the answer starts, the strip looks as it does
today. The token count and tok/s count thinking and answer together — the way the model's own
usage counts them — so the live figure and the done figure agree. On the user's box, Analyze would
read about 49 tok/s throughout, not ~28 live and 122 at done. The thinking text itself is shown
nowhere; the panel's preview stays the answer.

Nothing changes for a call without thinking (the second look, Discover's scan, every think-off
preset): llama.cpp sends no thinking deltas for them.

## 2 · Facts (receipts)

- llama.cpp streams thinking as `delta.reasoning_content`, one delta per token, before the
  answer's `delta.content`. Live probe 2026-10-06 against the running app's engine (gemma-4-26b-a4b-qat,
  `enable_thinking: true`, budget 200): delta keys `{role: 1, reasoning_content: 199, content: 1}`,
  the first thinking token at 1.07 s, usage `completion_tokens` 205 — thinking included.
- The kit drops it: `llm/openai_compat.py:291` reads only `delta.content`; `StreamDelta`
  (`llm/base.py:40-62`) has no field for it. Never built — `git log -S"reasoning_content" --
  llm_runner` is empty. JustWrite's 2026-07-20 plan (`justwrite-app/docs/plans/archive/
  2026-07-20-mtp-verify-think-ab-bench.md` T2) planned this plumb for the Bench; it was not built.
- The adapter covers two provider types: `registry.py:87 if pt in ("openai-compat",
  "local-llamacpp"):` → `OpenAICompatAdapter`. The cloud adapters (Anthropic, Gemini, OpenAI SDK)
  and Ollama have their own thinking shapes — out of scope (§5 Q3).
- The kit turns thinking on for the local runner with `chat_template_kwargs.enable_thinking`
  plus `reasoning_budget_tokens` (`openai_compat.py:156-158`). JustVoice's Analyze runs
  `p_extract_reasoned` (think on, budget 1024, `seed_presets.py:52`).
- An old client ignores a frame it doesn't know: `client.js` `requestStream` branches only on
  `error` / `done` / `delta` (truthy) / `progress` / `step`. And today's `/v1/ai/stream` emitter
  would send a thinking delta as `{"delta": ""}`, which that same `if (frame.delta)` skips.

## 3 · The build — three slices

**K1 · kit server.** `StreamDelta.reasoning: str = ""`. `openai_compat.stream_chat` yields
`StreamDelta(reasoning=…)` for each `delta.reasoning_content`. The kit's own `/v1/ai/stream`
(`prompts.py` `stream_feature`) emits `{"thinking": "<text>"}` for it — a sixth frame beside
delta / progress / step / done / `[DONE]`.

**K2 · kit client.** `requestStream` calls `onThinking(text)` per thinking frame, never
`onDelta`. `runAiFeatureStream` and `runAiEndpointStream` pass it to the task handle
(`handle.onThinking`), and a thinking frame counts as "something arrived" for the stream→run
fallback. The task store's `_recordThinking`: the first token of any kind sets `firstDeltaAt`;
every thinking token refreshes `lastDeltaAt` / `deltaCount` (so freshness keeps working through a
long think), clears the prefill bar, sets `status: "streaming"`, adds to `thinkingChars`, and
marks `thinking: true` until the first answer delta clears it. `taskTps` and the token label
count `(chars + thinkingChars) ÷ 4` while running. The strip shows **thinking…** while
`thinking` is true; the panel's phase reads *Thinking*.

**J1 · JustVoice.** The two streaming consumers forward thinking: `pipeline.py` `call` and
`second_look.py` `_ask` gain `on_thinking` beside `on_delta` (threaded through `analyze_scene`
and `second_look`), and the two SSE endpoints put `{"thinking": t}` on the queue
(`extraction_api.py:697`, `:956`). JustWrite needs no code: its features stream through the
kit's `/v1/ai/stream` and `runAiFeatureStream`, so K1 + K2 reach it. docgen runs no streams.

**Docs.** Kit `RESEARCH.md` §3 (five frames → six, and the thinking fact); JV
`docs/ai-features.md` "AI tasks" (the strip's *thinking…*); JustWrite's user docs if they
describe the strip's numbers (checked at build time).

## 4 · What each change touches (the blast radius)

Every row is a grep run on 2026-10-06, pasted as it came back (trimmed to the matching lines).

| Change | Callers · producers · exceptions on the path |
|---|---|
| **`StreamDelta.reasoning`** (additive field, default "") | Producers — every adapter yield: `anthropic.py:256 yield StreamDelta(text=chunk)` · `gemini.py:252 yield StreamDelta(text=piece)` · `ollama.py:200 yield StreamDelta(text=chunk)` · `openai_compat.py:287 yield StreamDelta(progress=…)`, `:293 yield StreamDelta(text=chunk)` · `openai_sdk.py:374`, `:418 yield StreamDelta(text=piece)` · each adapter's done yield. Consumers — `dispatch.py:408 for delta in adapter.stream_chat(` (stamps `model` on done, yields every delta on — passes thinking through untouched) · `prompts.py:763 for delta in stream_chat(` (the `/v1/ai/stream` emitter, `:788 elif delta.progress is not None:` / `:791 frame = {"delta": delta.text}` — **the exception: its `else` takes anything not done/progress as text**, so K1 adds the thinking branch before it) · JV `pipeline.py:531 for delta in stream_feature(` → `:542 elif delta.text:` (skips a thinking delta today) · JV `second_look.py:227 for delta in stream_feature(` → `elif delta.text:` (same). Tests constructing it by keyword (unaffected): kit `tests/test_llm_dispatch.py:52-54`, `tests/test_prompts.py:114-117`, `:733-734`; JW `server/tests/test_ai_features.py:31-33`. |
| **`openai_compat.stream_chat` yields thinking** | Its provider types: `registry.py:87 if pt in ("openai-compat", "local-llamacpp"):`. Its one caller: `dispatch.py:408`. The request side is untouched (`openai_compat.py:156-158` `enable_thinking` / `reasoning_budget_tokens`). Exception: a think-off call gets no `reasoning_content` from llama.cpp, so it streams exactly as today. |
| **`{"thinking"}` frame from `/v1/ai/stream`** | The emitter: `prompts.py:724 async def stream_feature(body: RunRequest):` (JW and JV both mount it via `install_llm` — JV `app.py:253`, JW `app.py:197`). Its client: `aiFeature.js:142 usage = await requestStream("/v1/ai/stream", body, (delta) => {`. JW's callers of `runAiFeatureStream` (all unchanged — their `onDelta` keeps getting only the answer): `writerAI.js:126,167,184`, `rag/chat.js:193`, `rag/characterChat.js:138`, `AiView.vue:35`; and via those, `RichEditor.vue:643,674,720,765,1441`, `ChatPanel.vue:378`, `AnalysisView.vue:198`, `benchHook.js:179,216,241,355` (the Bench's `onFirstToken` rides `onDelta` — it keeps timing the ANSWER's first token). Kit Lab: `ConfigColumn.vue:560` (its readout `:564-568` computes tok/s from `completionTokens` ÷ total ms — unaffected). |
| **JV's endpoints emit `{"thinking"}`** | `extraction_api.py:697 on_delta=lambda t: q.put({"delta": t}),` (Analyze) · `:956` (🔎 Second look). The parameter chain to thread `on_thinking` beside `on_delta`: `pipeline.py:442` (`_attribute` signature), `:521-543` (`call`), `:607` (`analyze_scene` param), `:683`, `:787` (into the second look) · `second_look.py:159`, `:193`, `:218-232` (`_ask`), `:237`, `:252`. Their client: `chapterRun.js:209 result = await runAiEndpointStream({`, `:225`. |
| **`requestStream` gains `onThinking`** | `client.js:160 export async function requestStream(path, body, onDelta, { signal, onProgress, onStep } = {})`. Its callers: `aiFeature.js:142` and `appTask.js` `runAiEndpointStream` (`requestStream(url, body, (delta) => {`). No app calls it directly (grep of JV/JW/docgen `src`: none). |
| **The task store records thinking** (`_recordThinking`; `firstDeltaAt` / `lastDeltaAt` / `deltaCount` move on thinking tokens too) | Every reader of those fields: `AiTaskStrip.vue:76-77` (first token), `:85` (`taskTps`), `tokensLabel` · `AiStatusPanel.vue:95-97` (`firstTokenMs`), `:100-101` (`taskTps`), the last-token-ago readout · `streamFreshness.js:26-40` (`freshnessOf` — the mean gap now spans thinking + answer tokens) · `runStats.js` `taskTps`. App readers: none (grep of JV/JW/docgen `src` for `firstDeltaAt\|deltaCount\|lastDeltaAt` → only JW's tests below and a comment at `IndexBuildModal.vue:95`, whose heartbeat calls `handle.onDelta("", null)` — unchanged). Tests on this path, which must keep passing: JW `src/services/aiFeature.test.js:281-287` (prefill), `src/services/streamFreshness.test.js:18-21`. The kit's UI has no test files. |
| **The strip and panel show it** | `AiTaskStrip.vue:118-125` (the stats row: prefill, elapsed, first token, tokens, tok/s, freshness) · `AiStatusPanel.vue:110-112` (`phaseLabel: connecting / streaming`), `:184-192` (first, tok/s). Every page with a strip reads these two components — no copy elsewhere (grep of app `src` for "first token in": none). docgen uses the store (`HomeView.vue:23 const aiTasks = useAiTasksStore();`) but streams nothing. |

## 5 · Questions before the build

1. *First token in …* — measured to the first THINKING token (it is the model's first token;
   the strip then says *thinking…*), not to the first answer token.
   Lean: yes.
2. One token count and one tok/s for thinking and answer together — what the model's usage
   counts, so live and done agree.
   Lean: yes.
3. Local only: llama.cpp and openai-compat servers. Cloud thinking (Anthropic, Gemini, OpenAI)
   and Ollama are a follow-up, each with its own shape.
   Lean: yes — the local runner is where the wait is.
4. The panel shows the phase *Thinking* and the same numbers; the thinking TEXT is shown
   nowhere (the preview stays the answer).
   Lean: yes.
