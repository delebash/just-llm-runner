# SPDX-License-Identifier: MIT
"""P2 — the thin in-process VRAM-budget arbiter (design 2026-07-04-serving-vram-manager §5b/§7).

Router mode's `--models-max` caps the co-resident CHILD COUNT but is NOT VRAM-aware, and nothing
else arbitrates the one GPU across co-resident models. This module is that arbiter: a small
in-process ledger of what is committed to VRAM plus the admission policy the RunnerService's
`load()` consults before spawning a child — co-reside when the remaining budget holds (within
`models_max`), else evict the least-recently-used non-pinned model.

Policy it encodes (design §7.1): pin the tiny always-needed model resident (the embed — pinned
in P3); TTL-warm the active big model (the router's `--sleep-idle-seconds` owns the real idle-TTL;
the arbiter tracks a coarse last-use for LRU); co-reside additional models only if `fit.py`'s
remaining budget allows, else swap the LRU.

It USES `fit.py` (the VRAM estimate) + `hardware.py` (the one VRAM authority both apps read); it
does NOT replace them. SHARED code: JW's runner and — since the 2026-08-09 VRAM wiring — JV's
`engines/manager.py` consult the SAME instance, so cross-kind (TTS↔STT↔LLM) budgeting is one
in-process ledger with no IPC; each app process holds its OWN instance (cross-APP arbitration is
out of scope, design §7.2).

Cross-kind mechanics (the eviction-executor seam, JV vram-think §6 step 1): every reservation
carries its `kind` ("llm" | "tts" | "stt") and an `evict_fn` — the OWNER's evictor, callable from
any thread (the runner's re-acquires `_router_lock`, JV's takes the engine-manager locks). The
shared `make_room` picks LRU non-pinned victims whose kind is neither protected nor BUSY and whose
evict_fn exists, executes the owner's evictor outside the ledger lock, and releases on the attempt
(the `_admit` termination lesson). Busy counters (`busy_begin`/`busy_end`) implement Q1's
never-evict-busy invariant: a streaming chat protects "llm", an in-flight synth protects "tts", a
transcription protects "stt". Count caps are kind-scoped (`count(kind=...)`) so a resident TTS
engine never eats a `models_max` llama.cpp child slot (P5-3).

The reservation VRAM is the GPU-RESIDENT portion (`fit.estimate_vram_mb` at the chosen ngl, carried
on `FitPlan.vram_mb`), NOT the full weight size — a MoE offloads its experts to CPU RAM, so its VRAM
footprint is far below its file size. Admission is a first-guess safety net; the spawn OOM back-off +
the build's graceful CPU auto-offload are the real backstops, so a modest estimate error is fine.

LIMITATIONS (recorded):
  * Real chat/embed generate traffic hits the router's `:8080/v1` directly via the OpenAI-compat
    adapter, NOT through the RunnerService — so the arbiter's LRU sees only load-time +
    `measure`/`tokenize` touches, not live inference. For JW's common 2-model case (pinned embed +
    one evictable chat) the LRU order barely matters; the router-native TTL handles real idle-unload.
    A usage-aware LRU (reading a router last-use field, if the pinned build exposes one) is a later
    refinement.
  * `--sleep-idle-seconds` idle-*unloads* a child (frees its VRAM) while the router still lists it
    as `sleeping`; the arbiter KEEPS the reservation (it can't see the sleep and the child reloads
    on the next request). So after models sleep, `committed_mb` OVER-counts and `remaining_mb`
    UNDER-counts — conservative (it never lets an admission OOM), but the reported budget is tighter
    than reality. Reconciling committed against the live `GET /models` sleeping set is a P2+ refinement.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from .hardware import budget_total_mb as _hw_budget_total, detect as _detect, mem_arch as _mem_arch

log = logging.getLogger(__name__)

# A VRAM-driven eviction skips reservations holding less than this — evicting a
# CPU-placed embed (~0–550 MB driver context) can't make a GPU model fit, but it
# DOES kill a warm child someone wants resident (the 2026-07-11 lesson, moved
# here from lifecycle so `make_room` and `_admit` share one threshold).
EVICT_MIN_MB = 600


@dataclass
class _Reservation:
    vram_mb: int
    pinned: bool
    seq: int  # monotonic use stamp — higher = more recently used (drives LRU eviction)
    kind: str = "llm"  # owner kind: "llm" | "tts" | "stt" — drives busy protection + kind-scoped counts
    # The OWNER's evictor — must be callable from ANY thread (it takes the owner's
    # own locks). None = not evictable by `make_room` (foreign code has no safe way
    # to unload it; the pre-seam ledger-corruption scenario, vram-think pass 3).
    evict_fn: Callable[[], None] | None = field(default=None, compare=False)


class VramArbiter:
    """In-process committed-VRAM ledger + co-residence policy. Thread-safe. One instance per app
    process (the runner's singleton via `get_arbiter()`). All VRAM in MiB.

    `hw` is threaded through the query methods so a caller that already ran `hardware.detect()` (a
    subprocess) passes it once instead of re-detecting per call — never hold `_lock` across a detect."""

    def __init__(self, hardware_fn=_detect):
        self._hardware_fn = hardware_fn
        self._reservations: dict[str, _Reservation] = {}
        self._seq = 0
        self._lock = threading.Lock()
        # Busy counters per kind (never-evict-busy, Q1): >0 = an operation of
        # that kind is in flight, so its residents are not eviction victims.
        self._busy: dict[str, int] = {}
        # Eviction event ring (newest last, capped) — the toast feed. Recorded
        # by `make_room` and the runner's admission evictions; read by JV's
        # GET /v1/engines/vram (events_since) so swaps surface as toasts.
        self._events: list[dict] = []
        self._event_seq = 0

    def _max_vram_mb(self, hw=None) -> int:
        # ARCH-AWARE since Phase 4 (fit-redesign §5.2): the ledger's denominator
        # is the budget pool — the largest card's VRAM on a discrete box, the ONE
        # shared pool (ram_mb) on integrated/unified/CPU-only boxes. Before this,
        # a Mac/iGPU box totaled 0, remaining was permanently 0, and every
        # admission fell into the evict-then-proceed-with-warning path. Claims on
        # one-pool boxes are counted ONCE by construction: each reservation is a
        # single pool-delta number (mmap'd weights and the "GPU" allocation are
        # the same physical bytes on UMA — never two claims for one model).
        return _hw_budget_total(hw or self._hardware_fn())

    def committed_mb(self) -> int:
        """Total VRAM currently reserved across the resident set."""
        with self._lock:
            return sum(r.vram_mb for r in self._reservations.values())

    def remaining_mb(self, hw=None) -> int:
        """Budget left after the committed-resident set (arch-aware pool since Phase 4 —
        card VRAM on discrete, the shared pool on one-pool boxes). NO safety margin
        subtracted here: `coarse_fit`/`compute_fit` subtract the margin themselves (one
        place), so this is the raw detected budget minus committed. Never negative."""
        return max(0, self._max_vram_mb(hw) - self.committed_mb())

    def can_coreside(self, vram_mb: int, hw=None) -> bool:
        """Does a model needing `vram_mb` fit the remaining budget as-is (no eviction)?"""
        return vram_mb <= self.remaining_mb(hw)

    def count(self, kind: str | None = None) -> int:
        """Number of reserved (resident) models, optionally one kind's. The runner's
        `models_max` cap checks `count(kind="llm")` — a resident TTS engine must not
        eat a llama.cpp child slot (P5-3). `None` counts everything (back-compat)."""
        with self._lock:
            if kind is None:
                return len(self._reservations)
            return sum(1 for r in self._reservations.values() if r.kind == kind)

    def is_reserved(self, key: str) -> bool:
        with self._lock:
            return key in self._reservations

    def reserve(
        self,
        key: str,
        vram_mb: int,
        *,
        pinned: bool = False,
        kind: str = "llm",
        evict_fn: Callable[[], None] | None = None,
    ) -> bool:
        """Record (or replace) `key`'s VRAM reservation and mark it most-recently-used. A reserve
        is an admission the caller has already made room for (via `can_coreside`/`make_room`); it
        always records, returning True. `pinned` protects it from eviction (the tiny always-resident
        embed, P3). `kind` tags the owner (busy protection + kind-scoped counts); `evict_fn` is the
        owner's any-thread evictor — without one, `make_room` can never pick this reservation."""
        with self._lock:
            self._seq += 1
            self._reservations[key] = _Reservation(
                vram_mb=max(0, vram_mb), pinned=pinned, seq=self._seq, kind=kind, evict_fn=evict_fn
            )
            return True

    def release(self, key: str) -> None:
        """Drop `key`'s reservation (on unload / a failed-or-cancelled load). Idempotent."""
        with self._lock:
            self._reservations.pop(key, None)

    def touch(self, key: str) -> None:
        """Mark `key` most-recently-used (a generate/measure kept it warm) so it isn't the next LRU
        eviction victim. No-op if not reserved."""
        with self._lock:
            r = self._reservations.get(key)
            if r is not None:
                self._seq += 1
                r.seq = self._seq

    def sync_pins(self, pinned_keys) -> None:
        """Re-align every reservation's pinned flag with the LIVE pinned set (the routing
        default embed). Pins were stamped at load time and never re-checked, so a REPLACED
        embed kept its stale pin and deflected a count-cap eviction onto the chat model
        (2026-07-12: switching the embed 0.6B→4B evicted Gemma). Called before every
        admission so protection always follows the CURRENT default."""
        keys = set(pinned_keys or ())
        with self._lock:
            for k, r in self._reservations.items():
                r.pinned = k in keys

    def pick_evict(
        self, exclude: str | None = None, min_mb: int = 0, among=None, kind: str | None = None
    ) -> str | None:
        """The least-recently-used NON-pinned reserved key, or None if nothing is evictable (empty,
        every reservation pinned, or only `exclude` remains). `exclude` keeps the model currently
        being (re)loaded from evicting itself.

        `min_mb` (2026-07-11): for a VRAM-driven eviction, skip reservations holding less than
        this — evicting a CPU-placed embed (~0–550 MB driver context) can't make a GPU model
        fit, but it DOES kill the warm embed child the RAG rail wants resident (observed live:
        a chat-model admission evicted the CPU 4B for nothing). A COUNT-driven eviction passes
        0 (a child must go regardless of how little VRAM it holds).

        `among` (2026-07-12): restrict candidates to this key set — the embed-swap pass
        evicts a REPLACED embed before anything else touches the chat model.

        `kind` (2026-08-09): restrict candidates to one owner kind — the runner's count-cap
        eviction only ever removes its OWN llama.cpp children, never a TTS/STT engine."""
        with self._lock:
            cands = [
                (r.seq, k) for k, r in self._reservations.items()
                if not r.pinned and k != exclude and r.vram_mb >= min_mb
                and (among is None or k in among)
                and (kind is None or r.kind == kind)
            ]
            return min(cands)[1] if cands else None

    # ── busy protection (Q1's never-evict-busy) ───────────────────────────────

    def busy_begin(self, kind: str) -> None:
        """An operation of `kind` is in flight (a chat streaming, a line synthesizing,
        a transcription running) — its residents are not eviction victims until the
        matching `busy_end`. Counter semantics: overlapping operations stack."""
        with self._lock:
            self._busy[kind] = self._busy.get(kind, 0) + 1

    def busy_end(self, kind: str) -> None:
        with self._lock:
            n = self._busy.get(kind, 0) - 1
            if n > 0:
                self._busy[kind] = n
            else:
                self._busy.pop(kind, None)

    def busy_kinds(self) -> set[str]:
        with self._lock:
            return {k for k, n in self._busy.items() if n > 0}

    # ── the shared admission executor (vram-think §6 step 1) ──────────────────

    def make_room(
        self,
        needed_mb: int,
        *,
        exclude: str | None = None,
        protected_kinds=(),
        hardware=None,
        min_mb: int = EVICT_MIN_MB,
        reason: str = "",
        self_kind: str | None = None,
        self_evict: Callable[[str], None] | None = None,
    ) -> bool:
        """Evict LRU victims until `needed_mb` fits the remaining budget, or nothing
        evictable remains — returns False then, and the CALLER decides
        proceed-with-warning (the runner's MoE/fit-placed loads have spawn safety
        nets) vs honest refusal (TTS/STT have none).

        A victim must be non-pinned, hold >= `min_mb` (see `pick_evict`), be
        evictable (carry an `evict_fn` — or belong to the CALLER's own `self_kind`,
        whose `self_evict(key)` covers reservations recorded without one), and
        belong to a kind that is neither in `protected_kinds` nor BUSY
        (`busy_kinds` — the invariant is enforced here so no caller can forget it).
        The owner's evictor runs OUTSIDE the ledger lock (it takes the owner's
        locks); the reservation is released on the ATTEMPT, so the loop always
        terminates (`_admit`'s 2026-07-06 lesson). `reason` names the beneficiary
        for the eviction-event toast ("loading luxtts")."""
        if needed_mb <= 0:
            return True
        hw = hardware if hardware is not None else self._hardware_fn()
        while True:
            if needed_mb <= self.remaining_mb(hw):
                return True
            protected = set(protected_kinds or ()) | self.busy_kinds()
            with self._lock:
                cands = [
                    (r.seq, k, r) for k, r in self._reservations.items()
                    if not r.pinned and k != exclude and r.vram_mb >= min_mb
                    and r.kind not in protected
                    and (r.evict_fn is not None
                         or (self_evict is not None and r.kind == self_kind))
                ]
                victim = min(cands, key=lambda c: c[0]) if cands else None
            if victim is None:
                return False
            _seq, key, res = victim
            log.info("arbiter make_room: evict LRU %s (%s, %d MB)%s", key, res.kind,
                     res.vram_mb, f" — {reason}" if reason else "")
            try:
                if res.evict_fn is not None:
                    res.evict_fn()
                else:
                    self_evict(key)
            except Exception:  # noqa: BLE001 — a failed unload usually means already gone
                log.warning("arbiter make_room: evictor for %s failed", key, exc_info=True)
            self.release(key)
            self.record_eviction(key, res.kind, reason)

    # ── eviction events (the toast feed, Q3: event-driven honesty) ────────────

    def record_eviction(self, victim_key: str, victim_kind: str, reason: str = "") -> None:
        """Append one eviction to the ring (cap 50). Called by `make_room` and by the
        runner's own admission evictions so BOTH directions surface."""
        with self._lock:
            self._event_seq += 1
            self._events.append({
                "seq": self._event_seq,
                "at": int(time.time()),
                "victim_key": victim_key,
                "victim_kind": victim_kind,
                "reason": reason or "",
            })
            del self._events[:-50]

    def events_since(self, seq: int = 0) -> list[dict]:
        """Eviction events newer than `seq` (oldest first) — the client keeps the
        last seq it has toasted and asks for the rest."""
        with self._lock:
            return [dict(e) for e in self._events if e["seq"] > seq]

    def snapshot(self, hw=None) -> dict:
        """The budget view for `GET /v1/llm-runner/resident`: committed + remaining budget + each
        reservation's footprint (least-recently-used first). Read-only.

        ARCH-AWARE (Phase 4, §5.2): `mem_arch` names the box's memory architecture and the
        `*_mb` numbers are the BUDGET POOL's — on a discrete box that is the card's VRAM
        (the historical meaning, unchanged); on integrated/unified boxes it is the one
        shared pool, each claim counted once. Consumers (the engine panel's budget line,
        the future JV strip — §6.7) label "VRAM" vs "Memory" off `mem_arch`; the key names
        keep their historical spelling so every existing reader stays wired."""
        with self._lock:
            reservations = [
                {"key": k, "vram_mb": r.vram_mb, "pinned": r.pinned, "kind": r.kind}
                for k, r in sorted(self._reservations.items(), key=lambda kv: kv[1].seq)
            ]
            committed = sum(r.vram_mb for r in self._reservations.values())
            busy = sorted(k for k, n in self._busy.items() if n > 0)
        hw = hw or self._hardware_fn()
        total = self._max_vram_mb(hw)
        return {
            "mem_arch": _mem_arch(hw),
            "vram_total_mb": total,
            "committed_mb": committed,
            "remaining_mb": max(0, total - committed),
            "reservations": reservations,
            "busy_kinds": busy,
        }

    def reserved_mb(self, key: str) -> int | None:
        """The VRAM reserved for `key`, or None if not reserved (for the /resident per-model view)."""
        with self._lock:
            r = self._reservations.get(key)
            return r.vram_mb if r is not None else None

    def clear(self) -> None:
        """Drop all reservations (a full teardown / test reset)."""
        with self._lock:
            self._reservations.clear()
            self._seq = 0
            self._busy.clear()
            self._events.clear()
            self._event_seq = 0


_arbiter: VramArbiter | None = None


def get_arbiter() -> VramArbiter:
    """Process-wide singleton (the per-app ledger, design §7.2). The runner — and, in the future JV
    plan, JV's `engines/manager.py` — share THIS instance so cross-kind VRAM is one ledger."""
    global _arbiter
    if _arbiter is None:
        _arbiter = VramArbiter()
    return _arbiter


def set_arbiter(arbiter: VramArbiter | None) -> None:
    """Swap the singleton (tests inject a fake-hardware arbiter; None resets)."""
    global _arbiter
    _arbiter = arbiter
