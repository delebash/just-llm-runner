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


# ── the 2026-08-09 eviction-executor seam (JV vram-think §6 step 1) ─────────


def test_count_and_pick_evict_are_kind_scoped():
    # P5-3: a resident TTS engine must not eat a models_max llama.cpp child slot,
    # and a count-cap eviction only ever removes the runner's OWN children.
    a = _arb(8000)
    a.reserve("chat", 4000)                          # kind defaults to "llm"
    a.reserve("tts:luxtts", 1024, kind="tts", evict_fn=lambda: None)
    assert a.count() == 2
    assert a.count(kind="llm") == 1
    assert a.count(kind="tts") == 1
    assert a.pick_evict(kind="llm") == "chat"        # never the TTS engine
    a.release("chat")
    assert a.pick_evict(kind="llm") is None


def test_busy_counters_stack_and_clear():
    a = _arb(8000)
    assert a.busy_kinds() == set()
    a.busy_begin("tts")
    a.busy_begin("tts")                              # overlapping synth lines stack
    a.busy_begin("llm")
    assert a.busy_kinds() == {"tts", "llm"}
    a.busy_end("tts")
    assert a.busy_kinds() == {"tts", "llm"}          # one line still in flight
    a.busy_end("tts")
    a.busy_end("llm")
    assert a.busy_kinds() == set()
    a.busy_end("llm")                                # underflow is a no-op, no crash
    assert a.busy_kinds() == set()


def test_make_room_executes_the_owners_evictor_lru_first():
    a = _arb(8000)
    killed = []
    a.reserve("old", 5000, evict_fn=lambda: killed.append("old"))     # LRU
    a.reserve("new", 2000, evict_fn=lambda: killed.append("new"))
    assert a.make_room(3000) is True                 # 1000 free + 5000 from "old"
    assert killed == ["old"]                         # LRU died; "new" untouched
    assert a.is_reserved("new") and not a.is_reserved("old")


def test_make_room_skips_busy_kinds():
    # Q1's never-evict-busy: a mid-synth TTS engine is untouchable, so the
    # admission reports False and the caller decides warn-vs-refuse.
    a = _arb(8000)
    a.reserve("tts:luxtts", 7000, kind="tts", evict_fn=lambda: None)
    a.busy_begin("tts")
    assert a.make_room(3000) is False
    assert a.is_reserved("tts:luxtts")
    a.busy_end("tts")
    assert a.make_room(3000) is True                 # idle again → evictable


def test_make_room_requires_an_evictor_for_foreign_kinds():
    # The pass-3 ledger-corruption scenario: without a registered evictor,
    # foreign code has NO safe way to unload a reservation — never pick it.
    a = _arb(8000)
    a.reserve("tts:luxtts", 7000, kind="tts")        # no evict_fn
    assert a.make_room(3000) is False
    assert a.is_reserved("tts:luxtts")


def test_make_room_self_evict_covers_own_kind_without_evict_fn():
    # The runner's _admit knows how to unload its OWN children even when a
    # reservation predates the seam (tests, legacy rows).
    a = _arb(8000)
    a.reserve("chat", 7000)                          # llm, no evict_fn
    killed = []
    assert a.make_room(3000, self_kind="llm", self_evict=killed.append) is True
    assert killed == ["chat"]
    assert not a.is_reserved("chat")


def test_make_room_releases_on_a_failed_evictor():
    # Release-on-attempt (the _admit termination lesson): a raising evictor
    # still frees the ledger row, so the loop can't spin on the same victim.
    a = _arb(8000)

    def _boom():
        raise RuntimeError("child already gone")

    a.reserve("old", 5000, evict_fn=_boom)
    assert a.make_room(4000) is True
    assert not a.is_reserved("old")


def test_make_room_respects_protected_kinds_and_min_mb():
    a = _arb(8000)
    a.reserve("stt:whisper", 1500, kind="stt", evict_fn=lambda: None)
    a.reserve("tiny", 100, kind="llm", evict_fn=lambda: None)
    # stt protected by the caller; the tiny llm row is under EVICT_MIN_MB.
    assert a.make_room(7000, protected_kinds={"stt"}) is False
    assert a.is_reserved("stt:whisper") and a.is_reserved("tiny")


def test_snapshot_carries_kind_and_busy():
    a = _arb(8000)
    a.reserve("chat", 5000)
    a.reserve("tts:luxtts", 1024, kind="tts", evict_fn=lambda: None)
    a.busy_begin("tts")
    snap = a.snapshot()
    kinds = {r["key"]: r["kind"] for r in snap["reservations"]}
    assert kinds == {"chat": "llm", "tts:luxtts": "tts"}
    assert snap["busy_kinds"] == ["tts"]
    a.busy_end("tts")


def test_eviction_events_ring_and_since():
    a = _arb(8000)
    a.reserve("old", 5000, evict_fn=lambda: None)
    a.make_room(4000, reason="loading luxtts")
    events = a.events_since(0)
    assert len(events) == 1
    e = events[0]
    assert e["victim_key"] == "old" and e["victim_kind"] == "llm"
    assert e["reason"] == "loading luxtts" and e["seq"] == 1
    assert a.events_since(e["seq"]) == []            # the client's cursor advances
    a.clear()
    assert a.events_since(0) == []
