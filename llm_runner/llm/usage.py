# SPDX-License-Identifier: MIT
"""AI usage ledger — tokens + duration per feature.

Every dispatch.chat() call records one entry: feature, model, prompt /
completion tokens, wall time, ok/error. In-memory ring (capped) +
totals-by-feature; powers Settings → AI usage. Lifted verbatim from
JustVoice `server/justvoice/engines/llm/usage.py` into the shared
`llm_runner` package (2026-06-21 AI-stack convergence).
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import Protocol

_LOG_CAP = 200


@dataclass
class UsageEntry:
    feature: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    duration_ms: int
    ok: bool
    error: str | None = None
    provider_id: str | None = None
    at: float = field(default_factory=time.time)


class UsageSink(Protocol):
    """Pluggable usage store. The default is the in-memory `UsageLedger`; a host
    can swap in a persistent backend (e.g. a DB table) via `set_ledger` so
    server-side dispatch usage survives restarts. JustVoice keeps the in-memory
    default; JustWrite plugs in a sink over its `LlmUsage` table."""

    def record(self, entry: "UsageEntry") -> None: ...
    def snapshot(self) -> dict: ...
    def clear(self) -> None: ...


class UsageLedger:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._log: deque[UsageEntry] = deque(maxlen=_LOG_CAP)

    def record(self, entry: UsageEntry) -> None:
        with self._lock:
            self._log.append(entry)

    def snapshot(self) -> dict:
        with self._lock:
            entries = list(self._log)
        by_feature: dict[str, dict] = {}
        by_provider: dict[str, dict] = {}
        total_p = total_c = 0
        for e in entries:
            agg = by_feature.setdefault(
                e.feature,
                {"calls": 0, "errors": 0, "prompt_tokens": 0, "completion_tokens": 0, "duration_ms": 0, "cost": 0.0},
            )
            agg["calls"] += 1
            agg["errors"] += 0 if e.ok else 1
            agg["prompt_tokens"] += e.prompt_tokens
            agg["completion_tokens"] += e.completion_tokens
            agg["duration_ms"] += e.duration_ms
            pagg = by_provider.setdefault(
                e.provider_id or "—",
                {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0},
            )
            pagg["calls"] += 1
            pagg["prompt_tokens"] += e.prompt_tokens
            pagg["completion_tokens"] += e.completion_tokens
            total_p += e.prompt_tokens
            total_c += e.completion_tokens
        # The in-memory ledger has no pricing table → cost is 0 here; a host sink
        # with pricing (e.g. JustWrite's) fills cost in its own snapshot.
        return {
            "by_feature": by_feature,
            "by_provider": by_provider,
            "recent": [asdict(e) for e in reversed(entries[-30:])],
            "total_calls": len(entries),
            "total_cost": 0.0,
            "total_prompt_tokens": total_p,
            "total_completion_tokens": total_c,
        }

    def clear(self) -> None:
        with self._lock:
            self._log.clear()


_ledger: UsageSink = UsageLedger()


def get_ledger() -> UsageSink:
    return _ledger


def set_ledger(sink: UsageSink) -> None:
    """Replace the process usage sink — host wiring at boot. JustWrite sets a
    DB-backed sink so server-side dispatch usage joins its persistent ledger."""
    global _ledger
    _ledger = sink
