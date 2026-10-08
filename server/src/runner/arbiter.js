// SPDX-License-Identifier: MIT
// The thin in-process VRAM-budget arbiter (the port of llm_runner/runner/arbiter.py; design
// 2026-07-04-serving-vram-manager §5b/§7).
//
// Router mode's `--models-max` caps the co-resident CHILD COUNT but is NOT VRAM-aware, and
// nothing else arbitrates the one GPU across co-resident models. This module is that arbiter:
// a small in-process ledger of what is committed to VRAM plus the admission policy the
// RunnerService's `load()` consults before spawning a child — co-reside when the remaining
// budget holds (within `models_max`), else evict the least-recently-used non-pinned model.
//
// Policy it encodes (design §7.1): pin the tiny always-needed model resident (the embed —
// pinned in P3); TTL-warm the active big model (the router's `--sleep-idle-seconds` owns the
// real idle-TTL; the arbiter tracks a coarse last-use for LRU); co-reside additional models
// only if `fit`'s remaining budget allows, else swap the LRU.
//
// It USES `fit` (the VRAM estimate) + `hardware` (the one VRAM authority both apps read); it
// does NOT replace them. SHARED code: JW's runner and JV's `engines/manager` consult the SAME
// instance, so cross-kind (TTS↔STT↔LLM) budgeting is one in-process ledger with no IPC; each
// app process holds its OWN instance (cross-APP arbitration is out of scope, design §7.2).
//
// Cross-kind mechanics (the eviction-executor seam, JV vram-think §6 step 1): every
// reservation carries its `kind` ("llm" | "tts" | "stt") and an `evictFn` — the OWNER's
// evictor. The shared `makeRoom` picks LRU non-pinned victims whose kind is neither protected
// nor BUSY and whose evictFn exists, runs the owner's evictor, and releases on the attempt
// (the `_admit` termination lesson). Busy counters (`busyBegin`/`busyEnd`) implement Q1's
// never-evict-busy invariant: a streaming chat protects "llm", an in-flight synth protects
// "tts", a transcription protects "stt". Count caps are kind-scoped (`count("llm")`) so a
// resident TTS engine never eats a `models_max` llama.cpp child slot (P5-3).
//
// The reservation VRAM is the GPU-RESIDENT portion (`FitPlan.vramMb`), NOT the full weight
// size — a MoE offloads its experts to CPU RAM, so its VRAM footprint is far below its file
// size. Admission is a first-guess safety net; the spawn OOM back-off + the build's graceful
// CPU auto-offload are the real backstops, so a modest estimate error is fine.
//
// THE SLEEPING CHILD (fixed 2026-08-15). `--sleep-idle-seconds` idle-*unloads* a child — its
// VRAM is really gone — while the router still lists it as `sleeping`. The ledger used to keep
// booking that memory; a co-tenant that prices on MEASURED free memory (JustVoice's speech
// door must — the ledger cannot see other programs) then moved a TTS engine into the freed
// gigabytes, the ledger ended at 10.6 GB booked on an 8 GB card, and the child woke straight
// through the router with no admission anywhere. The fix is two-sided and both halves are
// needed:
//   * a reservation carries `asleep`; `syncSleeping()` reconciles it against the router's live
//     `GET /models` (RunnerService.reconcile_sleeping), and `committedMb` counts only AWAKE
//     reservations. A sleeping reservation is also never a VRAM-eviction victim: freeing
//     something that holds no memory cannot make room (the EVICT_MIN_MB lesson, same shape).
//   * the WAKE is admitted: RunnerService.ensure_model_ready runs `makeRoom` for what the child
//     takes back, so the wake evicts its co-tenant through the normal executor (with an
//     eviction event the user sees) instead of overcommitting. (history: arbiter.py)
//
// LIMITATIONS (recorded): real chat/embed traffic hits the router's `/v1` directly via the
// OpenAI-compat adapter, NOT through the RunnerService — so the LRU sees only load-time +
// `measure`/`tokenize` touches, not live inference. For JW's common 2-model case (pinned embed
// + one evictable chat) the order barely matters; the router-native TTL handles real
// idle-unload. The WAKE half is closed because dispatch's ensure-local hook runs before the
// adapter call; a request that reaches the router by some other path is not.
//
// ── The JS shape ────────────────────────────────────────────────────────────────────────
// Python's `threading.Lock` is dropped: no ledger section crosses an `await`. ASYNC are the
// methods that may DETECT hardware (`hardware.detect()` starts programs) or run an evictor:
// `_maxVramMb`, `remainingMb`, `makeRoom`, `snapshot` — pass `hw` when you have it, as the
// Python callers did. An evictor (`evictFn`, `selfEvict`) may be sync or async; the
// `hardwareFn` too. Everything else is synchronous. The dicts the arbiter hands out
// (`snapshot`, `eventsSince`, `reservationOf`) keep Python's snake_case keys — they are wire
// data (`GET /v1/llm-runner/resident`, JustVoice's `GET /v1/engines/vram`).

import { getLogger } from "../platform/log.js";
import { pySorted } from "../platform/py.js";
import * as hardware from "./hardware.js";

const log = getLogger("llm_runner.runner.arbiter");

// A VRAM-driven eviction skips reservations holding less than this — evicting a CPU-placed
// embed (~0–550 MB driver context) can't make a GPU model fit, but it DOES kill a warm child
// someone wants resident (the 2026-07-11 lesson, shared by `makeRoom` and lifecycle's
// `_admit`).
export const EVICT_MIN_MB = 600;

/** One ledger row (Python's `_Reservation`). */
export class _Reservation {
  constructor({ vramMb, pinned, seq, kind = "llm", evictFn = null, source = "computed", asleep = false }) {
    this.vramMb = vramMb;
    this.pinned = pinned;
    this.seq = seq; // monotonic use stamp — higher = more recently used (drives LRU eviction)
    this.kind = kind; // owner kind: "llm" | "tts" | "stt" — drives busy protection + kind-scoped counts
    // The OWNER's evictor. null = not evictable by `makeRoom` (foreign code has no safe way to
    // unload it; the pre-seam ledger-corruption scenario, vram-think pass 3).
    this.evictFn = evictFn;
    // Phase 5 (§13.1): where this number CAME FROM — "measured" (a real used-memory delta trued
    // it up) | "computed" (physics estimate) | "declared" (manifest/catalog price, e.g. a JV TTS
    // engine). Propagated on the snapshot so a consumer never presents a declared guess as
    // live truth.
    this.source = source;
    // ASLEEP (2026-08-15): the router idle-unloaded this child's weights, so the reservation
    // names memory the card is NOT currently holding. It stays in the ledger — the number is
    // what the child takes back when it wakes, and the wake admission needs it — but it is
    // excluded from `committedMb`.
    this.asleep = asleep;
  }
}

/** A key collection Python tested with `in` (set, list, dict keys) → a Set. */
function keySet(xs) {
  if (xs == null) return new Set();
  if (xs instanceof Set) return xs;
  if (xs instanceof Map) return new Set(xs.keys());
  if (typeof xs === "string" || Array.isArray(xs) || typeof xs[Symbol.iterator] === "function") return new Set(xs);
  return new Set(Object.keys(xs));
}

/**
 * In-process committed-VRAM ledger + co-residence policy. One instance per app process (the
 * runner's singleton via `getArbiter()`). All VRAM in MiB.
 *
 * `hw` is threaded through the query methods so a caller that already ran `hardware.detect()`
 * passes it once instead of re-detecting per call.
 */
export class VramArbiter {
  constructor(hardwareFn = () => hardware.detect()) {
    this._hardwareFn = hardwareFn;
    /** key → _Reservation, in first-reserve order (Python's dict). */
    this._reservations = new Map();
    this._seq = 0;
    // Busy counters per kind (never-evict-busy, Q1): >0 = an operation of that kind is in
    // flight, so its residents are not eviction victims.
    this._busy = new Map();
    // Eviction event ring (newest last, capped) — the toast feed. Recorded by `makeRoom` and
    // the runner's admission evictions; read by JV's GET /v1/engines/vram (eventsSince) so
    // swaps surface as toasts.
    this._events = [];
    this._eventSeq = 0;
  }

  /**
   * The budget pool (async: may detect). ARCH-AWARE since Phase 4 (fit-redesign §5.2): the
   * largest card's VRAM on a discrete box, the ONE shared pool (ramMb) on
   * integrated/unified/CPU-only boxes. Before this, a Mac/iGPU box totaled 0, remaining was
   * permanently 0, and every admission fell into the evict-then-proceed-with-warning path.
   * Claims on one-pool boxes are counted ONCE by construction: each reservation is a single
   * pool-delta number (mmap'd weights and the "GPU" allocation are the same physical bytes on
   * UMA — never two claims for one model).
   */
  async _maxVramMb(hw = null) {
    return hardware.budgetTotalMb(hw ?? (await this._hardwareFn()));
  }

  /**
   * Total VRAM currently HELD across the resident set — asleep reservations excluded
   * (2026-08-15): an idle-unloaded child's weights are really gone, and a ledger that keeps
   * booking them reports memory as taken that any co-tenant pricing on a measurement can
   * plainly see is free. `syncSleeping` maintains the flag; `bookedMb` is the with-sleepers
   * number for a caller that wants it.
   */
  committedMb() {
    let total = 0;
    for (const r of this._reservations.values()) if (!r.asleep) total += r.vramMb;
    return total;
  }

  /** Total VRAM reserved INCLUDING sleepers — what the resident set will hold once every
   * sleeping child has woken. The admission doors price on `committedMb`; this is for
   * reporting and for sizing a wake. */
  bookedMb() {
    let total = 0;
    for (const r of this._reservations.values()) total += r.vramMb;
    return total;
  }

  /**
   * Budget left after the committed-resident set (async: may detect). Arch-aware pool —
   * card VRAM on discrete, the shared pool on one-pool boxes. NO safety margin subtracted
   * here: `coarseFit`/`computeFit` subtract the margin themselves (one place), so this is the
   * raw detected budget minus committed. Never negative.
   */
  async remainingMb(hw = null) {
    const total = await this._maxVramMb(hw);
    return Math.max(0, total - this.committedMb());
  }

  // `can_coreside` was DELETED 2026-08-14: a ledger-only "does this fit?" with zero callers
  // whose answer ignored memory other programs hold — exactly the optimism admission stopped
  // trusting. Fit questions belong to the admission path (lifecycle._admit), which measures.

  /**
   * Number of reserved (resident) models, optionally one kind's. The runner's `models_max`
   * cap checks `count("llm")` — a resident TTS engine must not eat a llama.cpp child slot
   * (P5-3). null counts everything. (`count({kind})` is accepted too — Python's keyword form.)
   */
  count(kind = null) {
    if (kind !== null && typeof kind === "object") kind = kind.kind ?? null;
    if (kind == null) return this._reservations.size;
    let n = 0;
    for (const r of this._reservations.values()) if (r.kind === kind) n += 1;
    return n;
  }

  isReserved(key) {
    return this._reservations.has(key);
  }

  // ── the sleeping-child reconcile (2026-08-15) ─────────────────────────────

  /**
   * Re-align the `asleep` flag of every `kind` reservation with the router's LIVE sleeping
   * set. Kind-scoped because only llama.cpp children sleep — a JV speech engine is a process
   * that is either up or gone, and a caller passing the router's list must not silently wake
   * or sleep one. Called by `RunnerService.reconcile_sleeping` (which owns the `GET /models`
   * probe and its TTL) — never from inside a ledger query.
   */
  syncSleeping(sleepingKeys, { kind = "llm" } = {}) {
    const keys = keySet(sleepingKeys);
    for (const [k, r] of this._reservations) {
      if (r.kind === kind) r.asleep = keys.has(k);
    }
  }

  /** True when `key` is reserved but its child is idle-unloaded — the state in which a
   * "warm, already resident" fast path is a lie and the wake must be admitted
   * (`ensure_model_ready`). */
  isAsleep(key) {
    const r = this._reservations.get(key);
    return Boolean(r !== undefined && r.asleep);
  }

  /** Book `key`'s memory back at the moment its wake is admitted — before the router
   * reallocates, not after the next reconcile poll notices. Without this the ledger reports
   * the memory free for the whole gap and a co-tenant admission can take the room the wake
   * just made. No-op if not reserved. */
  markAwake(key) {
    const r = this._reservations.get(key);
    if (r !== undefined) {
      r.asleep = false;
      this._seq += 1;
      r.seq = this._seq;
    }
  }

  /**
   * Record (or replace) `key`'s VRAM reservation and mark it most-recently-used. A reserve is
   * an admission the caller has already made room for (via `makeRoom`); it always records,
   * returning true. `pinned` protects it from eviction (the tiny always-resident embed, P3).
   * `kind` tags the owner (busy protection + kind-scoped counts); `evictFn` is the owner's
   * evictor — without one, `makeRoom` can never pick this reservation. `source` (§13.1)
   * records the number's provenance — measured | computed | declared.
   */
  reserve(key, vramMb, { pinned = false, kind = "llm", evictFn = null, source = "computed" } = {}) {
    this._seq += 1;
    this._reservations.set(
      key,
      // Python's max(0, vram_mb): 0 unless the number is > 0 (NaN included).
      new _Reservation({ vramMb: vramMb > 0 ? vramMb : 0, pinned, seq: this._seq, kind, evictFn, source: source || "computed" }),
    );
    return true;
  }

  /** Drop `key`'s reservation (on unload / a failed-or-cancelled load). Idempotent. */
  release(key) {
    this._reservations.delete(key);
  }

  /** Mark `key` most-recently-used (a generate/measure kept it warm) so it isn't the next LRU
   * eviction victim. No-op if not reserved. */
  touch(key) {
    const r = this._reservations.get(key);
    if (r !== undefined) {
      this._seq += 1;
      r.seq = this._seq;
    }
  }

  /** Re-align every reservation's pinned flag with the LIVE pinned set (the routing default
   * embed). Pins were stamped at load time and never re-checked, so a REPLACED embed kept its
   * stale pin and deflected a count-cap eviction onto the chat model (2026-07-12: switching
   * the embed 0.6B→4B evicted Gemma). Called before every admission so protection always
   * follows the CURRENT default. */
  syncPins(pinnedKeys) {
    const keys = keySet(pinnedKeys);
    for (const [k, r] of this._reservations) r.pinned = keys.has(k);
  }

  /**
   * The least-recently-used NON-pinned reserved key, or null if nothing is evictable (empty,
   * every reservation pinned, or only `exclude` remains). `exclude` keeps the model currently
   * being (re)loaded from evicting itself.
   *
   * `minMb` (2026-07-11): for a VRAM-driven eviction, skip reservations holding less than
   * this — evicting a CPU-placed embed (~0–550 MB driver context) can't make a GPU model fit,
   * but it DOES kill the warm embed child the RAG rail wants resident. A COUNT-driven eviction
   * passes 0 (a child must go regardless of how little VRAM it holds).
   *
   * `among` (2026-07-12): restrict candidates to this key set — the embed-swap pass evicts a
   * REPLACED embed before anything else touches the chat model.
   *
   * `kind` (2026-08-09): restrict candidates to one owner kind — the runner's count-cap
   * eviction only ever removes its OWN llama.cpp children, never a TTS/STT engine.
   *
   * ASLEEP (2026-08-15): a sleeping child is skipped by a VRAM-driven eviction for the same
   * reason `minMb` exists — it holds nothing, so killing it cannot make room. A COUNT-driven
   * eviction (minMb 0) still takes it: there the goal is a free child slot, which a sleeper
   * does occupy.
   */
  pickEvict({ exclude = null, minMb = 0, among = null, kind = null } = {}) {
    const amongSet = among == null ? null : keySet(among);
    let best = null;
    for (const [k, r] of this._reservations) {
      if (
        !r.pinned &&
        k !== exclude &&
        r.vramMb >= minMb &&
        !(r.asleep && minMb > 0) &&
        (amongSet === null || amongSet.has(k)) &&
        (kind == null || r.kind === kind)
      ) {
        if (best === null || r.seq < best[0]) best = [r.seq, k];
      }
    }
    return best ? best[1] : null;
  }

  // ── busy protection (Q1's never-evict-busy) ───────────────────────────────

  /** An operation of `kind` is in flight (a chat streaming, a line synthesizing, a
   * transcription running) — its residents are not eviction victims until the matching
   * `busyEnd`. Counter semantics: overlapping operations stack. */
  busyBegin(kind) {
    this._busy.set(kind, (this._busy.get(kind) ?? 0) + 1);
  }

  busyEnd(kind) {
    const n = (this._busy.get(kind) ?? 0) - 1;
    if (n > 0) this._busy.set(kind, n);
    else this._busy.delete(kind);
  }

  /** The kinds with an operation in flight (a Set). */
  busyKinds() {
    const out = new Set();
    for (const [k, n] of this._busy) if (n > 0) out.add(k);
    return out;
  }

  // ── the shared admission executor (vram-think §6 step 1) ──────────────────

  /**
   * Evict LRU victims until `neededMb` fits the remaining budget, or nothing evictable
   * remains — resolves false then, and the CALLER decides proceed-with-warning (the runner's
   * MoE/fit-placed loads have spawn safety nets) vs honest refusal (TTS/STT have none).
   *
   * A victim must be non-pinned, hold >= `minMb` (see `pickEvict`), be evictable (carry an
   * `evictFn` — or belong to the CALLER's own `selfKind`, whose `selfEvict(key)` covers
   * reservations recorded without one), and belong to a kind that is neither in
   * `protectedKinds` nor BUSY (`busyKinds` — the invariant is enforced here so no caller can
   * forget it). The reservation is released on the ATTEMPT, so the loop always terminates
   * (`_admit`'s 2026-07-06 lesson). `reason` names the beneficiary for the eviction-event
   * toast ("loading luxtts").
   */
  async makeRoom(
    neededMb,
    { exclude = null, protectedKinds = [], hardware: hw = null, minMb = EVICT_MIN_MB, reason = "", selfKind = null, selfEvict = null } = {},
  ) {
    if (neededMb <= 0) return true;
    const box = hw != null ? hw : await this._hardwareFn();
    for (;;) {
      if (neededMb <= (await this.remainingMb(box))) return true;
      const protectedSet = new Set([...keySet(protectedKinds), ...this.busyKinds()]);
      let victim = null;
      for (const [k, r] of this._reservations) {
        if (
          !r.pinned &&
          k !== exclude &&
          r.vramMb >= minMb &&
          !r.asleep && // holds nothing — evicting it frees nothing
          !protectedSet.has(r.kind) &&
          (r.evictFn != null || (selfEvict != null && r.kind === selfKind))
        ) {
          if (victim === null || r.seq < victim[0]) victim = [r.seq, k, r];
        }
      }
      if (victim === null) return false;
      const [, key, res] = victim;
      log.info(`arbiter make_room: evict LRU ${key} (${res.kind}, ${res.vramMb} MB)${reason ? ` — ${reason}` : ""}`);
      try {
        if (res.evictFn != null) await res.evictFn();
        else await selfEvict(key);
      } catch (e) {
        // a failed unload usually means already gone
        log.warning(`arbiter make_room: evictor for ${key} failed`, e);
      }
      this.release(key);
      this.recordEviction(key, res.kind, reason);
    }
  }

  // ── eviction events (the toast feed, Q3: event-driven honesty) ────────────

  /** Append one eviction to the ring (cap 50). Called by `makeRoom` and by the runner's own
   * admission evictions so BOTH directions surface. */
  recordEviction(victimKey, victimKind, reason = "") {
    this._eventSeq += 1;
    this._events.push({
      seq: this._eventSeq,
      at: Math.trunc(Date.now() / 1000),
      victim_key: victimKey,
      victim_kind: victimKind,
      reason: reason || "",
    });
    if (this._events.length > 50) this._events.splice(0, this._events.length - 50);
  }

  /** Eviction events newer than `seq` (oldest first) — the client keeps the last seq it has
   * toasted and asks for the rest. */
  eventsSince(seq = 0) {
    return this._events.filter((e) => e.seq > seq).map((e) => ({ ...e }));
  }

  /**
   * The budget view for `GET /v1/llm-runner/resident` (async: may detect, and reads the
   * measured pool): committed + remaining budget + each reservation's footprint
   * (least-recently-used first). Read-only.
   *
   * ARCH-AWARE (Phase 4, §5.2): `mem_arch` names the box's memory architecture and the `*_mb`
   * numbers are the BUDGET POOL's — on a discrete box that is the card's VRAM (the historical
   * meaning); on integrated/unified boxes it is the one shared pool, each claim counted once.
   * Consumers label "VRAM" vs "Memory" off `mem_arch`; the key names keep their historical
   * spelling so every existing reader stays wired.
   */
  async snapshot(hw = null) {
    const reservations = [...this._reservations]
      .sort((a, b) => a[1].seq - b[1].seq)
      .map(([k, r]) => ({ key: k, vram_mb: r.vramMb, pinned: r.pinned, kind: r.kind, source: r.source, asleep: r.asleep }));
    // Committed = what is HELD (sleepers excluded, 2026-08-15). `booked_mb` rides alongside so
    // a display can say "6.5 GB booked, 0 held right now" rather than either number
    // pretending to be both.
    const committed = this.committedMb();
    const booked = this.bookedMb();
    const busy = pySorted([...this.busyKinds()]);
    const box = hw ?? (await this._hardwareFn());
    const total = await this._maxVramMb(box);
    // MEASURED occupancy (2026-08-14) — what the card actually holds, including programs we do
    // not manage. `committed_mb` is only what WE booked, and a strip that labelled it "VRAM
    // used" read 0.0/8.0 on a card holding 2 GB of browser. Cached probe (the display polls
    // this every couple of seconds); null on an unmeasurable box, where consumers fall back to
    // the ledger.
    let used;
    try {
      used = await hardware.usedPoolMb();
    } catch {
      used = null; // the budget view must never fail on a probe
    }
    return {
      mem_arch: hardware.memArch(box),
      vram_total_mb: total,
      used_mb: used ?? null,
      committed_mb: committed,
      booked_mb: booked,
      remaining_mb: Math.max(0, total - committed),
      reservations,
      busy_kinds: busy,
    };
  }

  /** The VRAM reserved for `key`, or null if not reserved (for the /resident per-model view). */
  reservedMb(key) {
    const r = this._reservations.get(key);
    return r !== undefined ? r.vramMb : null;
  }

  /** The full reservation view for `key` (vram_mb + provenance + kind), or null — the claim
   * resolver's resident-live arm (§6.2 arm 1, with §13.1's source so a declared-priced
   * reservation never reads as measured truth). */
  reservationOf(key) {
    const r = this._reservations.get(key);
    if (r === undefined) return null;
    return { vram_mb: r.vramMb, source: r.source, kind: r.kind, pinned: r.pinned, asleep: r.asleep };
  }

  /** Drop all reservations (a full teardown / test reset). */
  clear() {
    this._reservations.clear();
    this._seq = 0;
    this._busy.clear();
    this._events.length = 0;
    this._eventSeq = 0;
  }
}

let arbiter = null;

/** Process-wide singleton (the per-app ledger, design §7.2). The runner and JV's
 * `engines/manager` share THIS instance so cross-kind VRAM is one ledger. */
export function getArbiter() {
  arbiter ??= new VramArbiter();
  return arbiter;
}

/** Swap the singleton (tests inject a fake-hardware arbiter; null resets). */
export function setArbiter(a) {
  arbiter = a ?? null;
}
