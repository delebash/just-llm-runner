# Thinking-budget design discussion — state save (2026-07-14, evening)

**⛔ SUPERSEDED (2026-07-14) — DECISION MADE. DO NOT USE THIS DOC FOR STATE; DO NOT
RE-OPEN B vs C.** This was an open-discussion snapshot from the evening of 2026-07-14.
The design was RESOLVED and the plan APPROVED the same day (user: *"i agree to your 5
recs go"*) + a 3-lens rules-checker panel returned PASS. The local rule landed on
`effective = min(level, hardware cap)` — what this doc called **candidate C**. The
authoritative, current design + build plan is
**`2026-07-14-feature-override-and-reasoning-plan.md`** (its ▶ NEXT SESSION / UNIT 2
§U2-T1→T10 block is the exact instructions). This file is kept ONLY as history of how
the decision was reached; nothing live should point here.

---

_(original open-discussion snapshot below, retained for history)_

## How this started

The llama.cpp upstream review (`docs/llama-cpp-watch.md`, review b9899→b9993,
pushed as `f0c4e0a`) surfaced b9982 ("per-request reasoning budget honored in
completions"). While explaining it, we discovered and verified that the app's
per-task Reasoning levels (Off/Low/Medium/High) are DISCARDED by the built-in
local provider — `llm_runner/llm/openai_compat.py:117-119` sends only the on/off
`chat_template_kwargs.enable_thinking` toggle and returns, dropping the effort
string. On cloud providers the levels work. That asymmetry opened a long design
discussion about where "how much thinking" should live, which is still open.

## What the user has DECIDED (their words, not to be re-litigated)

The Low/Medium/High levels exist on tasks and map to numbers — "we already
decided low medium high, those map to a number, that is fine." Thinking on/off
lives with the task ("i think the thinking on and off does live with task").
Decision 1a: the tested value stops being a launch flag (the exact final shape of
where the value lives and how it is enforced is part of the open question below —
the user's instinct that the internal/launch cap existed for a hardware reason was
validated by the history and must be honored by whatever design lands). Decision
3A: the model catalog gains a `thinking` capability column (like `mtp` at
`db.py:89` and `embedding` at `db.py:127`) marking which models can reason at all
— in scope for the eventual change. The UI must never lie about what is in effect
(the current display bug below is a bug regardless of which design wins). The
hardware-tested value must stay connected to how much thinking actually happens —
several of my proposals died specifically for breaking that connection.

## The OPEN question (the crux, unresolved)

"How much thinking" fuses two different quantities. First: how much deliberation
the WORK deserves — a property of the task, hardware- and provider-independent,
and the only currency the cloud providers speak, so the level must live on the
task no matter what (the same task can route to Claude tomorrow; the user's own
example: Claude Code itself exposes model + effort pickers — you choose deserved
effort there because the serving hardware makes any level affordable). Second:
what a thinking token costs to run HERE — on cloud that is money plus modest
latency, which is why "online models can have any level from low to high" (user's
words); on local it is wall-clock through the box's measured speed (the user's
2070S measured ~29 tok/s; High=8192 ≈ 4.7 minutes). The old launch cap of 1024
encoded the affordability side, tested, for one box. The open decision is ONLY:
what happens on a LOCAL run when a task's level meets the hardware bound. Three
candidate rules were scored against the user's own four scenarios (which function
as acceptance tests for any candidate):

- The LOOP scenario: a user who knows nothing of the hardware testing sets chat
  to High on a slow box and gets multi-minute "not working" behavior. Any design
  where a task-side pick silently exceeds the tested bound fails this.
- The 2048 DISPLAY-HONESTY scenario: if the hardware value is an arbitrary number
  (2048), any attempt to display it AS a level word lies (it is no named level,
  and Medium/High would clamp to the same 2048 while showing different words).
- The ONE-PLACE requirement: the old cap's virtue was ONE hardware-scoped value
  that automatically bounded anything think-enabled, present and future — no
  per-task setup ("per task is not hardware... I'd have to set it in many
  places").
- The DRIFT scenario: change the hardware value from 4096 to 1024 and restart —
  nothing task-side may keep showing a stale word/number; whatever the task
  displays must read the current hardware value at use time, never store a copy.

Candidate A (level wins locally, time estimates merely warn): passes display
honesty and drift, FAILS the loop scenario, and worse, orphans the tested value
entirely (no role), violating the stay-connected requirement. Candidate B (locally
the ONLY "how much" is the hardware number; the task control is on/off when the
route is local, levels apply on cloud routes): passes loop, honesty (the number
itself is displayed), one-place, and drift; its cost is a provider-shaped picker
(Off/On+number local, Off/Low/Med/High cloud). Candidate C (both: level = the
ask, hardware = the bound, effective = min(level_number, hardware_number), clamp
ALWAYS displayed, e.g. "High 8192 → 2048 on this hardware"): passes loop,
one-place, drift; display honesty holds only if every clamp is shown, and on a
slow box Medium/High/default legitimately collapse to the same effective number —
the user flagged that collapse as confusing; the counter-view is that it is the
truth of that box. The user has NOT chosen between B and C (A is effectively dead
by their scenarios). My earlier attempts to declare each of these "final" in turn
were rejected — the choice is the user's, at their pace.

## Verified facts (all in code this session, file:line)

Provider matrix: Anthropic maps level→budget_tokens {low:1024, med:4096,
high:8192} (`anthropic.py:80`); OpenAI-family clouds pass `reasoning_effort`
(`openai_compat.py:125`, defaulting "" → "medium" when think is on); Ollama passes
the level natively and also accepts "max" (`ollama.py:92-95`); the built-in local
provider discards the level (`openai_compat.py:117-119`). The launch emission that
would be retired: the `reasoning_budget` knob becomes `--reasoning-budget` at
`runner/process.py:130` (semantics documented at `process.py:92-94`: -1 unlimited,
0 = no thinking, N>0 caps with the budget message injected). The tested hardware
value: the ONE seeded class tune (`seed.py:393-399`, Gemma 26B on vram8|ram32)
carries `reasoning_budget: "1024"` at `seed.py:397`; the 1024's origin is the
author's own box/latency preference (`seed.py:348-349`); the base bundle
deliberately carries NO budget (user decision 2026-07-06, `seed.py:345-352`, base
switches at `seed.py:358`). Every other hardware class currently ships NO budget
at all (one seeded row total). Task seeds: exactly ONE task in JustWrite thinks —
grounded book-chat, key `chat`, `"think": True` at
`justwrite-app/server/justwrite_server/seed_feature_prompts.py:945` (decision
comment at :938-944; characterChat deliberately False; the JSON⇒no-think guardrail
at `ConfigColumn.vue:51`). The prompt seeder is INSERT-ONLY (`seed.py:1143-1144` —
existing rows are skipped forever; think IS mapped on insert at `seed.py:1148`), so
a DB whose `chat` row predates 2026-07-06 (commit `f6f8167`) never received
think=True. The container dev DB (born 2026-07-06) HAS it: `('chat', 1, '')`
verified by direct SQLite query. The UI display bug: the Reasoning picker renders
ONLY the level string (`ConfigColumn.vue:500-502` — empty level displays "Off"
even when think=1) and REGENERATES think from the level on save
(`ConfigColumn.vue:341` — `think: !!c.reasoningEffort`), so the seeded think=True
is invisible in the UI and would be erased by the first save. The user's
screenshot (Grounded chat, Reasoning: Off, built-in provider) matches this
exactly. Measured decode speed exists per (model, machine) for pricing displays:
`ModelMeasurement.tokens_per_sec` at `db.py:418`. Stale comments to sweep in any
eventual change: `openai_compat.py:111` (claims the cap is emitted for every local
model — false since 2026-07-06) and `seed_feature_prompts.py:940` (says the cap
lives in the base bundle — it lives in the Gemma class tune).

## Upstream facts (llama.cpp) — verified vs still unverified

Verified from source/discussion: `common/reasoning-budget.cpp` is ONE sampler
mechanism taking one number; the CLI flag `--reasoning-budget` sets the internal
`reasoning_budget` server variable; a per-request body key exists (discussion
#21445 quotes `if (reasoning_budget == -1 && body.contains("thinking_budget_tokens"))`
— i.e. pre-b9982 the request key only applies when the launch value is -1);
release b9982 (PR #23116) claims the per-request value now wins. Three web
summaries gave three different request-key spellings (`reasoning_budget`,
`reasoning_budget_tokens`, `thinking_budget_tokens`) — the EXACT key MUST be
grepped from the pinned server source at build time, never trusted from summaries
(the user's rule: verify in code). Note: if the adapter computes the final number
itself (as candidates B and C both imply — one resolved number per request, launch
always -1), the b9982 launch-vs-request precedence stops being load-bearing; the
pre-b9982 gate condition (launch at -1) is satisfied by construction. Whether the
request key exists at all at the current pin b9899 is UNVERIFIED. The engine
bump b9899→b9993 remains attractive for its other fixes (see
`docs/llama-cpp-watch.md` — reasoning-leak fix b9986, VRAM-query crash fix b9974,
quantized-KV fix b9905, null-sampling-params b9967, and the rest of the review).

## Corrections log (mistakes made and fixed this session — do not repeat)

I claimed "the live system has zero thinking tasks" from a buggy query (my script
only listed rows for tables with an `action` column; `feature_prompts` keys by
`key`) — the honest re-query showed `chat` think=1. I treated the seed source as
the live state without checking the DB. I declared "final designs" repeatedly and
was rightly stopped — including one over-rotation that removed the Low/Med/High
words from the local control entirely, contradicting the user's standing decision
that the levels stay. I invented a silent "treated as Medium" fallback that would
have ignored the user's tested value. The lesson the user stated and I accepted:
no rushing, no guessing, verify in code, the user steers.

## Bugs/facts to address REGARDLESS of which design wins

The UI truth bug (picker shows "Off" for a thinking task; save erases the flag).
The insert-only seed gap (the user's production box may lack `chat` think=1 —
settle with one query on their box: `SELECT key, think FROM feature_prompts WHERE
key='chat';`). The two stale comments. The model `thinking` capability column
(3A). The `thinking` column is likely seed/user-owned, NOT auto-detectable by
Read-from-HF (it is a chat-template property, not a GGUF header field) — a
documented parity exception to the user's DECREE #143, unless template-sniffing
at inspect time proves workable during the build.

## Next step (tomorrow)

The user chooses between candidates B and C (or reframes) — then, on their go, a
full plan doc (real plan protocol: plan mode, task entries, rules-checker panel)
covering: the exact request key verified from pinned source, adapter wiring
(off→0; on→the resolved number), retiring the launch emission, the UI truth fix,
the 3A column + seeds, migration (visible, preserving the tested 1024's effect),
tests for every combo, and the stale-comment sweep. Nothing is built until the
user approves the plan.
