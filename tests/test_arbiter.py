# SPDX-License-Identifier: MIT
"""VramArbiter — the in-process VRAM-budget ledger (P2). Pure unit tests: a fake hardware_fn
supplies a fixed VRAM total so committed/remaining/eviction are deterministic (no GPU needed)."""

from types import SimpleNamespace

from llm_runner.runner.arbiter import VramArbiter


def _hw(vram_mb):
    return SimpleNamespace(gpus=[SimpleNamespace(vram_mb=vram_mb)])


def _arb(vram_mb=8000):
    return VramArbiter(hardware_fn=lambda: _hw(vram_mb))


def test_reserve_committed_remaining():
    a = _arb(8000)
    assert a.committed_mb() == 0 and a.remaining_mb() == 8000
    a.reserve("chat", 5000)
    assert a.committed_mb() == 5000 and a.remaining_mb() == 3000
    a.reserve("embed", 500)
    assert a.committed_mb() == 5500 and a.remaining_mb() == 2500
    assert a.count() == 2


def test_release_is_idempotent():
    a = _arb(8000)
    a.reserve("chat", 5000)
    a.release("chat")
    a.release("chat")  # no-op, no crash
    assert a.committed_mb() == 0 and a.count() == 0


def test_reserve_replaces_same_key():
    a = _arb(8000)
    a.reserve("chat", 5000)
    a.reserve("chat", 6000)  # a re-tune REPLACES, does not add
    assert a.committed_mb() == 6000 and a.count() == 1


def test_can_coreside():
    a = _arb(8000)
    a.reserve("chat", 6000)
    assert a.can_coreside(2000) is True     # 2000 <= 2000 remaining
    assert a.can_coreside(2001) is False


def test_remaining_never_negative():
    a = _arb(1000)
    a.reserve("big", 5000)  # over-committed (an over-fit that CPU-auto-offloaded)
    assert a.remaining_mb() == 0
    assert a.can_coreside(1) is False


def test_negative_reservation_clamped():
    a = _arb(8000)
    a.reserve("degenerate", -500)  # a degenerate fit estimate → clamp to 0, never negative committed
    assert a.committed_mb() == 0


def test_pick_evict_is_lru():
    a = _arb(8000)
    a.reserve("a", 100)   # oldest
    a.reserve("b", 100)
    a.reserve("c", 100)   # newest
    assert a.pick_evict() == "a"   # least-recently-used
    a.touch("a")                   # a is now most-recent
    assert a.pick_evict() == "b"   # b is now the LRU


def test_pick_evict_skips_pinned():
    a = _arb(8000)
    a.reserve("embed", 500, pinned=True)   # oldest, but pinned
    a.reserve("chat", 5000)
    assert a.pick_evict() == "chat"        # the pinned embed is never the victim
    a.release("chat")
    assert a.pick_evict() is None          # only the pinned one left → nothing evictable


def test_pick_evict_exclude():
    a = _arb(8000)
    a.reserve("a", 100)  # older
    a.reserve("b", 100)
    assert a.pick_evict(exclude="a") == "b"   # exclude the model being (re)loaded from its own eviction
    a.reserve("only", 100)
    a.release("a")
    a.release("b")
    assert a.pick_evict(exclude="only") is None


def test_touch_noop_when_absent():
    a = _arb(8000)
    a.touch("missing")  # no crash, no reservation created
    assert a.count() == 0


def test_snapshot_and_reserved_mb():
    a = _arb(8000)
    a.reserve("chat", 5000)
    a.reserve("embed", 500, pinned=True)
    snap = a.snapshot()
    assert snap["vram_total_mb"] == 8000
    assert snap["committed_mb"] == 5500
    assert snap["remaining_mb"] == 2500
    assert [r["key"] for r in snap["reservations"]] == ["chat", "embed"]  # LRU order (chat first)
    assert snap["reservations"][1]["pinned"] is True
    assert a.reserved_mb("chat") == 5000
    assert a.reserved_mb("nope") is None


def test_clear():
    a = _arb(8000)
    a.reserve("chat", 5000)
    a.clear()
    assert a.committed_mb() == 0 and a.count() == 0


def test_cpu_only_box_zero_budget():
    a = _arb(0)  # no GPU
    assert a.remaining_mb() == 0
    assert a.can_coreside(1) is False


def test_pick_evict_min_mb_skips_small_reservations():
    # 2026-07-11: VRAM-driven eviction skips ~zero-VRAM victims (a CPU-placed embed's
    # driver-context crumbs) — freeing them can't make a GPU model fit, but it kills
    # the warm embed child. min_mb=0 (the count-driven path) keeps the old behavior.
    a = _arb(8000)
    a.reserve("tiny", 44)     # oldest → LRU, but sub-threshold
    a.reserve("big", 4000)
    assert a.pick_evict(min_mb=600) == "big"   # LRU says "tiny"; the threshold skips it
    a.release("big")
    assert a.pick_evict(min_mb=600) is None    # only the tiny one left → nothing evictable
    assert a.pick_evict() == "tiny"            # count-driven (min_mb=0) still picks it


def test_sync_pins_realigns_to_current_default():
    # 2026-07-12: pins were stamped at load time and never re-checked — a REPLACED embed
    # kept its stale pin and deflected a count-cap eviction onto the chat model.
    a = _arb(8000)
    a.reserve("old-embed", 500, pinned=True)   # was the default when it loaded
    a.reserve("new-embed", 500)
    a.sync_pins({"new-embed"})                 # the default moved
    assert a.pick_evict() == "old-embed"       # stale pin cleared → evictable
    a.release("old-embed")
    assert a.pick_evict() is None              # the CURRENT default is now the pinned one


def test_pick_evict_among_restricts_candidates():
    # The embed-swap pass evicts a REPLACED embed before anything else (2026-07-12).
    a = _arb(8000)
    a.reserve("chat", 5000)         # LRU — the default pick without `among`
    a.reserve("stale-embed", 550)
    assert a.pick_evict(among={"stale-embed"}) == "stale-embed"
    assert a.pick_evict(among={"absent"}) is None
    assert a.pick_evict() == "chat"
