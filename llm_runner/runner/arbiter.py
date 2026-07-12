# SPDX-License-Identifier: GPL-3.0-or-later
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
does NOT replace them. SHARED code: JW's runner is the only consumer today; in the future
JV-convergence plan JV's `engines/manager.py` consults the SAME arbiter, so cross-kind (TTS↔LLM)
budgeting is one in-process ledger with no IPC — but each app process holds its OWN instance
(cross-APP arbitration is out of scope, design §7.2).

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

import threading
from dataclasses import dataclass

from .hardware import detect as _detect, max_vram_mb as _hw_max_vram


@dataclass
class _Reservation:
    vram_mb: int
    pinned: bool
    seq: int  # monotonic use stamp — higher = more recently used (drives LRU eviction)


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

    def _max_vram_mb(self, hw=None) -> int:
        return _hw_max_vram(hw or self._hardware_fn())

    def committed_mb(self) -> int:
        """Total VRAM currently reserved across the resident set."""
        with self._lock:
            return sum(r.vram_mb for r in self._reservations.values())

    def remaining_mb(self, hw=None) -> int:
        """GPU VRAM left after the committed-resident set — the budget fed to `coarse_fit` for
        budget-aware Fit (design §5c). NO safety margin subtracted here: `coarse_fit`/`compute_fit`
        subtract the margin themselves (one place), so this is raw detected VRAM minus committed.
        Never negative."""
        return max(0, self._max_vram_mb(hw) - self.committed_mb())

    def can_coreside(self, vram_mb: int, hw=None) -> bool:
        """Does a model needing `vram_mb` fit the remaining budget as-is (no eviction)?"""
        return vram_mb <= self.remaining_mb(hw)

    def count(self) -> int:
        """Number of reserved (resident) models — checked against `models_max`."""
        with self._lock:
            return len(self._reservations)

    def is_reserved(self, key: str) -> bool:
        with self._lock:
            return key in self._reservations

    def reserve(self, key: str, vram_mb: int, *, pinned: bool = False) -> bool:
        """Record (or replace) `key`'s VRAM reservation and mark it most-recently-used. A reserve
        is an admission the caller has already made room for (via `can_coreside`/`pick_evict`); it
        always records, returning True. `pinned` protects it from eviction (the tiny always-resident
        embed, P3)."""
        with self._lock:
            self._seq += 1
            self._reservations[key] = _Reservation(vram_mb=max(0, vram_mb), pinned=pinned, seq=self._seq)
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

    def pick_evict(self, exclude: str | None = None, min_mb: int = 0, among=None) -> str | None:
        """The least-recently-used NON-pinned reserved key, or None if nothing is evictable (empty,
        every reservation pinned, or only `exclude` remains). `exclude` keeps the model currently
        being (re)loaded from evicting itself.

        `min_mb` (2026-07-11): for a VRAM-driven eviction, skip reservations holding less than
        this — evicting a CPU-placed embed (~0–550 MB driver context) can't make a GPU model
        fit, but it DOES kill the warm embed child the RAG rail wants resident (observed live:
        a chat-model admission evicted the CPU 4B for nothing). A COUNT-driven eviction passes
        0 (a child must go regardless of how little VRAM it holds).

        `among` (2026-07-12): restrict candidates to this key set — the embed-swap pass
        evicts a REPLACED embed before anything else touches the chat model."""
        with self._lock:
            cands = [
                (r.seq, k) for k, r in self._reservations.items()
                if not r.pinned and k != exclude and r.vram_mb >= min_mb
                and (among is None or k in among)
            ]
            return min(cands)[1] if cands else None

    def snapshot(self, hw=None) -> dict:
        """The budget view for `GET /v1/llm-runner/resident`: committed + remaining VRAM + each
        reservation's footprint (least-recently-used first). Read-only."""
        with self._lock:
            reservations = [
                {"key": k, "vram_mb": r.vram_mb, "pinned": r.pinned}
                for k, r in sorted(self._reservations.items(), key=lambda kv: kv[1].seq)
            ]
            committed = sum(r.vram_mb for r in self._reservations.values())
        total = self._max_vram_mb(hw)
        return {
            "vram_total_mb": total,
            "committed_mb": committed,
            "remaining_mb": max(0, total - committed),
            "reservations": reservations,
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
