# SPDX-License-Identifier: MIT
"""Online-provider model-list cleanup — the config-driven ruleset (#8, 2026-07-20).

An online provider's `/v1/models` dump is mostly noise for a writing/voice app: OpenAI
returns 400+ ids (image / realtime / audio / tts / whisper / moderation / legacy chat),
Gemini returns imagen / veo / lyria / tts / image variants. The app uses ONLY chat +
embedding models. This module classifies + prunes that list by DATA (per-provider-TYPE
rules), never hardcoded logic.

THE AGING CONTRACT (read before editing the seeds):
  • The DESIGNED failure mode is UNDER-filtering: when a provider ships a NEW noise
    family the seeds don't know yet, its ids appear as noise until the seed updates.
    That is acceptable and self-healing (a seed bump reaches unmodified installs).
  • OVER-filtering must be impossible BY ACCIDENT. Every drop is an ANCHORED regex with
    a deliberate boundary — there is NO bare-prefix mechanism. A prefix "gpt-4" would
    silently swallow a future flagship "gpt-45"; `^gpt-4($|[.o-])` drops the gpt-4/4o
    legacy family and spares "gpt-45"/"gpt-5". A user's escape hatches are always
    present: `?all=1` (show everything), free-text model entry, and editable rules.
  • OpenAI's list endpoint carries NO capability metadata, so NAME rules are the only
    tool there. Gemini stays metadata-first (its adapter's D7 `supported_actions`
    filter drops veo/imagen/lyria/aqa before these rules ever run); the name rules
    below only prune the residue Google still tags as generateContent/embedContent.

The rules are stored as ONE seeded JSON document ("model_list_rules") in the existing
runner-settings store (see stores.get_model_list_rules / seed.seed_model_list_rules),
GET/PUT-editable at /v1/ai/model-list-rules. Per-INSTANCE overrides (two providers of
the same type needing different rules — e.g. OpenRouter vs a local LM Studio, both
openai-compat) are OUT of scope for now; rules are keyed by provider TYPE.
"""

from __future__ import annotations

import copy
import logging
import re
from dataclasses import dataclass

log = logging.getLogger(__name__)

# Bump this when the seed rules below change so an UNMODIFIED stored doc refreshes to
# the new seed on the next boot (seed.seed_model_list_rules); a user-edited doc is kept.
SEED_VERSION = 1

# Per-provider-TYPE rules. Anchored regexes ONLY (no bare prefixes — see the module
# docstring). `embedPatterns` re-buckets an id as an EMBEDDING model; `dropPatterns`
# hides it; `collapseDated` folds `-YYYY-MM-DD` snapshots under their bare alias.
SEED_RULES: dict[str, dict] = {
    "openai": {
        "collapseDated": True,
        "embedPatterns": [r"^text-embedding-"],
        "dropPatterns": [
            # legacy chat generations — anchored so gpt-5+/gpt-45 survive; o-series KEPT
            # (reasoning models, they match none of these).
            r"^gpt-3\.5",
            r"^gpt-4($|[.o-])",
            r"^chatgpt-",
            # non-chat families: image / realtime / audio / tts / transcription /
            # moderation / video / tools / legacy completions.
            r"^gpt-image",
            r"^gpt-live",
            r"^gpt-realtime",
            r"^gpt-audio",
            r"^sora",
            r"^dall-e",
            r"^tts-",
            r"^whisper",
            r"^omni-moderation",
            r"^text-moderation",
            r"^computer-use",
            r"^davinci",
            r"^babbage",
            # preview / instant snapshots of any family
            r"-preview(-|$)",
            r"-instant(-|$)",
        ],
    },
    "gemini": {
        # Gemini ships new models PREVIEW-first (e.g. a 3.5 Pro lands as -preview before
        # GA), so a blanket -preview drop would hide the NEWEST model — deliberately absent.
        "collapseDated": False,
        "embedPatterns": [r"^text-embedding-", r"^embedding-", r"^gemini-embedding-"],
        "dropPatterns": [
            r"^imagen-",
            r"^veo-",
            r"^lyria-",
            r"^aqa$",
            r"^learnlm-",
            r"^gemini-1\.0",
            r"^gemini-1\.5",
            r"^gemini-2\.0",  # 2.0 retired 2026-06
            r"-tts(-|$)",
            r"-live(-|$)",
            r"-image(-|$)",
            r"-exp(-|$)",
        ],
    },
    # Anthropic's list endpoint is already curated/clean; it exposes no embeddings.
    "anthropic": {"collapseDated": False, "embedPatterns": [], "dropPatterns": []},
    # openai-compat is the BYO universe (LM Studio / OpenRouter-compat / vLLM / a
    # self-hosted box): the id space is unknowable, so drop NOTHING (over-filter-safe)
    # and only preserve today's /embed/i split so an embedding model still lands in the
    # embed bucket. Users edit these per install.
    "openai-compat": {"collapseDated": False, "embedPatterns": [r"embed"], "dropPatterns": []},
    # The other metered-cloud types: no drops seeded (their lists are already close to
    # chat-only) — under-filter until a seed says otherwise; classify embeddings only.
    "deepseek": {"collapseDated": False, "embedPatterns": [r"embed"], "dropPatterns": []},
    "openrouter": {"collapseDated": False, "embedPatterns": [r"embed"], "dropPatterns": []},
    "xai": {"collapseDated": False, "embedPatterns": [r"embed"], "dropPatterns": []},
    "mistral": {"collapseDated": False, "embedPatterns": [r"embed"], "dropPatterns": []},
}


def seed_doc() -> dict:
    """The factory rules document — {seedVersion, rules}. A deep copy so a caller (the
    store, a reset) can never mutate the module seed."""
    return {"seedVersion": SEED_VERSION, "rules": copy.deepcopy(SEED_RULES)}


@dataclass
class FilterResult:
    models: list[str]       # chat ids, post drop + dated-collapse
    embeddings: list[str]   # embedding ids (classified out of the chat list)
    hidden_count: int       # raw - shown (drops + snapshots folded under an alias)


_DATED = re.compile(r"-\d{4}-\d{2}-\d{2}$")
_warned_patterns: set[str] = set()


def _compile(patterns: list[str] | None) -> list[re.Pattern]:
    """Compile user-editable patterns defensively: an invalid regex is SKIPPED (warned
    once), never a 500 — under-filter beats crashing the picker."""
    out: list[re.Pattern] = []
    for p in patterns or []:
        try:
            out.append(re.compile(p))
        except re.error as e:
            if p not in _warned_patterns:
                _warned_patterns.add(p)
                log.warning("model-list-rules: skipping invalid regex %r (%s)", p, e)
    return out


def _dedup(xs: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in xs:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _collapse_dated(ids: list[str]) -> list[str]:
    """Fold `-YYYY-MM-DD` snapshots under their bare alias. For each base: emit the bare
    alias IF it was itself fetched, else the NEWEST dated snapshot verbatim. NEVER emit
    an id that was not in the fetched list. First-appearance order is preserved."""
    present = set(ids)
    groups: dict[str, list[str]] = {}
    order: list[str] = []
    for mid in ids:
        base = _DATED.sub("", mid)
        if base not in groups:
            groups[base] = []
            order.append(base)
        groups[base].append(mid)
    out: list[str] = []
    for base in order:
        if base in present:
            out.append(base)  # the bare alias was fetched → prefer it
            continue
        dated = [m for m in groups[base] if _DATED.search(m)]
        # YYYY-MM-DD sorts lexicographically → max() is the newest snapshot.
        out.append(max(dated) if dated else groups[base][0])
    return out


def apply_rules(ids: list[str], rule: dict | None, *, show_all: bool = False) -> FilterResult:
    """Split a provider's raw model-id list into chat + embedding buckets per `rule`
    (the provider TYPE's rule dict, or None = passthrough). `show_all` bypasses every
    rule (the picker's "show all" escape hatch): everything is returned as chat, nothing
    hidden. Classification wins over dropping — an id matched as an embedding is kept in
    the embed bucket even if it also matches a drop pattern."""
    raw = [i for i in (ids or []) if i]
    if show_all or not rule:
        return FilterResult(models=_dedup(raw), embeddings=[], hidden_count=0)

    embed_rx = _compile(rule.get("embedPatterns"))
    drop_rx = _compile(rule.get("dropPatterns"))

    embeddings: list[str] = []
    chat: list[str] = []
    for mid in raw:
        if any(rx.search(mid) for rx in embed_rx):
            embeddings.append(mid)
            continue
        if any(rx.search(mid) for rx in drop_rx):
            continue  # hidden noise
        chat.append(mid)

    if rule.get("collapseDated"):
        chat = _collapse_dated(chat)

    embeddings = _dedup(embeddings)
    chat = _dedup(chat)
    hidden = len(_dedup(raw)) - len(chat) - len(embeddings)
    return FilterResult(models=chat, embeddings=embeddings, hidden_count=max(0, hidden))
