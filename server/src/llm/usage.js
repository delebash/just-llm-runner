// SPDX-License-Identifier: MIT
// AI usage ledger — tokens + duration per feature (the port of llm/usage.py).
//
// Every dispatch chat() call records one entry: feature, model, prompt / completion
// tokens, wall time, ok/error. In-memory ring (capped) + totals-by-feature; powers
// Settings → AI usage. A host swaps in a persistent sink with `setLedger` (install_llm
// wires the DB-backed one, usage_sink.js).
//
// UsageEntry is a Python dataclass whose `asdict()` IS the wire (`recent` in
// /v1/ai-usage), so it keeps its snake field names, in Python's field order.

const LOG_CAP = 200;

export function UsageEntry({
  feature,
  model,
  prompt_tokens,
  completion_tokens,
  duration_ms,
  ok,
  error = null,
  provider_id = null,
  at = Date.now() / 1000,
}) {
  return { feature, model, prompt_tokens, completion_tokens, duration_ms, ok, error, provider_id, at };
}

/**
 * The usage sink contract (Python's `UsageSink` Protocol): `record(entry)`, `snapshot()`,
 * `clear()`. The default is the in-memory UsageLedger; a host can swap in a persistent
 * backend via `setLedger` so server-side dispatch usage survives restarts.
 */
export class UsageLedger {
  constructor() {
    this._log = []; // a deque(maxlen=200)
  }

  record(entry) {
    this._log.push(entry);
    if (this._log.length > LOG_CAP) this._log.shift();
  }

  snapshot() {
    const entries = [...this._log];
    const by_feature = {};
    const by_provider = {};
    let totalP = 0;
    let totalC = 0;
    for (const e of entries) {
      if (!Object.hasOwn(by_feature, e.feature)) {
        by_feature[e.feature] = { calls: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, duration_ms: 0, cost: 0.0 };
      }
      const agg = by_feature[e.feature];
      agg.calls += 1;
      agg.errors += e.ok ? 0 : 1;
      agg.prompt_tokens += e.prompt_tokens;
      agg.completion_tokens += e.completion_tokens;
      agg.duration_ms += e.duration_ms;
      const pid = e.provider_id || "—";
      if (!Object.hasOwn(by_provider, pid)) {
        by_provider[pid] = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0.0 };
      }
      const pagg = by_provider[pid];
      pagg.calls += 1;
      pagg.prompt_tokens += e.prompt_tokens;
      pagg.completion_tokens += e.completion_tokens;
      totalP += e.prompt_tokens;
      totalC += e.completion_tokens;
    }
    // The in-memory ledger has no pricing table → cost is 0 here; a host sink with
    // pricing (the DB sink) fills cost in its own snapshot.
    return {
      by_feature,
      by_provider,
      recent: entries
        .slice(-30)
        .reverse()
        .map((e) => UsageEntry(e)),
      total_calls: entries.length,
      total_cost: 0.0,
      total_prompt_tokens: totalP,
      total_completion_tokens: totalC,
    };
  }

  clear() {
    this._log.length = 0;
  }
}

let ledger = new UsageLedger();

export function getLedger() {
  return ledger;
}

/** Replace the process usage sink — host wiring at boot (install_llm sets the DB-backed
 * sink so server-side dispatch usage joins the persistent ledger). */
export function setLedger(sink) {
  ledger = sink;
}
