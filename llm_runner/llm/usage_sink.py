# SPDX-License-Identifier: MIT
"""DbUsageSink — persists the shared LLM usage ledger to the shared `llm_usage`
table (wired via `set_ledger`, done by `install_llm`). Any app that installs the
shared LLM stack gets DB-backed usage that survives restarts — nothing per-app.
The in-memory `UsageLedger` (usage.py) is the default until a host installs.
"""

from __future__ import annotations

import json
import time
import uuid

from . import db
from .pricing import cost_for


class DbUsageSink:
    """UsageSink (record/snapshot/clear) over the shared `llm_usage` table."""

    def record(self, entry) -> None:  # entry: llm_runner.llm.usage.UsageEntry
        if db._SessionLocal is None:
            return
        meta = {"durationMs": entry.duration_ms, "ok": entry.ok}
        if entry.error:
            meta["error"] = entry.error
        s = db.session()
        try:
            s.add(db.LlmUsage(
                id=f"u_{uuid.uuid4().hex[:12]}",
                at=int((entry.at or time.time()) * 1000),  # epoch ms
                feature=entry.feature,
                provider_id=entry.provider_id,
                model=entry.model,
                prompt_tokens=max(0, entry.prompt_tokens),
                completion_tokens=max(0, entry.completion_tokens),
                cost=cost_for(entry.model, entry.prompt_tokens, entry.completion_tokens),
                meta=json.dumps(meta),
            ))
            s.commit()
        except Exception:  # never let a usage write break a feature call
            s.rollback()
        finally:
            s.close()

    def snapshot(self) -> dict:
        """Shared-shape snapshot (powers /v1/ai-usage): calls + tokens + cost per
        feature AND per provider, totals, and a recent log. Cost is the per-row
        cost recorded via `pricing.cost_for`."""
        empty = {
            "by_feature": {}, "by_provider": {}, "recent": [], "total_calls": 0,
            "total_cost": 0.0, "total_prompt_tokens": 0, "total_completion_tokens": 0,
        }
        if db._SessionLocal is None:
            return empty
        s = db.session()
        try:
            rows = s.query(db.LlmUsage).order_by(db.LlmUsage.at.desc()).all()
        finally:
            s.close()
        by_feature: dict[str, dict] = {}
        by_provider: dict[str, dict] = {}
        total_cost = total_p = total_c = 0
        for r in rows:
            agg = by_feature.setdefault(
                r.feature,
                {"calls": 0, "errors": 0, "prompt_tokens": 0, "completion_tokens": 0, "duration_ms": 0, "cost": 0.0},
            )
            pagg = by_provider.setdefault(
                r.provider_id or "—",
                {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0},
            )
            for bucket in (agg, pagg):
                bucket["calls"] += 1
                bucket["prompt_tokens"] += r.prompt_tokens or 0
                bucket["completion_tokens"] += r.completion_tokens or 0
                bucket["cost"] += r.cost or 0.0
            total_cost += r.cost or 0.0
            total_p += r.prompt_tokens or 0
            total_c += r.completion_tokens or 0
        recent = [
            {
                "feature": r.feature, "model": r.model, "provider_id": r.provider_id,
                "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens,
                "at": (r.at or 0) / 1000,
            }
            for r in rows[:30]
        ]
        return {
            "by_feature": by_feature, "by_provider": by_provider, "recent": recent,
            "total_calls": len(rows), "total_cost": total_cost,
            "total_prompt_tokens": total_p, "total_completion_tokens": total_c,
        }

    def clear(self) -> None:
        if db._SessionLocal is None:
            return
        s = db.session()
        try:
            s.query(db.LlmUsage).delete(synchronize_session=False)
            s.commit()
        finally:
            s.close()
