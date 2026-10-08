// SPDX-License-Identifier: MIT
// DbUsageSink — persists the shared LLM usage ledger to the shared `llm_usage` table
// (wired via usage.js `setLedger`, done by `installLlm`); the port of llm/usage_sink.py.
// Any app that installs the shared LLM stack gets DB-backed usage that survives restarts
// — nothing per-app. The in-memory `UsageLedger` (usage.js) is the default until a host
// installs.
//
// `entry` is usage.js's `UsageEntry` — Python's dataclass, so its snake field names
// (`prompt_tokens`, `duration_ms`, `provider_id`, `at` in epoch seconds).

import { randomUUID } from "node:crypto";
import { pyInt } from "../platform/py.js";
import { pyJson } from "../platform/pyjson.js";
import * as db from "./db.js";
import { costFor } from "./pricing.js";

/** UsageSink (record/snapshot/clear) over the shared `llm_usage` table. */
export class DbUsageSink {
  record(entry) {
    if (!db.isConfigured()) return;
    const meta = { durationMs: entry.duration_ms, ok: entry.ok };
    if (entry.error) meta.error = entry.error;
    try {
      db.session().insert("llm_usage", {
        id: `u_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        at: pyInt((entry.at || Date.now() / 1000) * 1000), // epoch ms
        feature: entry.feature,
        provider_id: entry.provider_id ?? null,
        model: entry.model ?? null,
        prompt_tokens: Math.max(0, entry.prompt_tokens),
        completion_tokens: Math.max(0, entry.completion_tokens),
        cost: costFor(entry.model, entry.prompt_tokens, entry.completion_tokens),
        meta: pyJson(meta),
      });
    } catch {
      // never let a usage write break a feature call
    }
  }

  /**
   * Shared-shape snapshot (powers /v1/ai-usage): calls + tokens + cost per feature AND per
   * provider, totals, and a recent log. Cost is the per-row cost recorded via
   * `pricing.costFor`.
   */
  snapshot() {
    const empty = {
      by_feature: {},
      by_provider: {},
      recent: [],
      total_calls: 0,
      total_cost: 0.0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
    };
    if (!db.isConfigured()) return empty;
    const rows = db.session().all("select * from llm_usage order by at desc", [], "llm_usage");
    const byFeature = {};
    const byProvider = {};
    let totalCost = 0;
    let totalP = 0;
    let totalC = 0;
    for (const r of rows) {
      byFeature[r.feature] ??= { calls: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, duration_ms: 0, cost: 0.0 };
      const pkey = r.provider_id || "—";
      byProvider[pkey] ??= { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0.0 };
      for (const bucket of [byFeature[r.feature], byProvider[pkey]]) {
        bucket.calls += 1;
        bucket.prompt_tokens += r.prompt_tokens || 0;
        bucket.completion_tokens += r.completion_tokens || 0;
        bucket.cost += r.cost || 0.0;
      }
      totalCost += r.cost || 0.0;
      totalP += r.prompt_tokens || 0;
      totalC += r.completion_tokens || 0;
    }
    const recent = rows.slice(0, 30).map((r) => ({
      feature: r.feature,
      model: r.model,
      provider_id: r.provider_id,
      prompt_tokens: r.prompt_tokens,
      completion_tokens: r.completion_tokens,
      at: (r.at || 0) / 1000,
    }));
    return {
      by_feature: byFeature,
      by_provider: byProvider,
      recent,
      total_calls: rows.length,
      total_cost: totalCost,
      total_prompt_tokens: totalP,
      total_completion_tokens: totalC,
    };
  }

  clear() {
    if (!db.isConfigured()) return;
    db.session().run("delete from llm_usage");
  }
}
