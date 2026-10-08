// SPDX-License-Identifier: MIT
// Port of tests/test_arbiter.py — VramArbiter, the in-process VRAM-budget ledger (P2). Pure
// unit tests: a fake hardwareFn supplies a fixed VRAM total so committed/remaining/eviction
// are deterministic (no GPU needed).
//
// JS shape: `remainingMb`, `makeRoom` and `snapshot` are async (they may detect hardware);
// the fake HardwareInfo uses the camelCase fields (`ramMb`, `gpus[].vramMb`). `snapshot`'s
// measured `used_mb` probe (`hardware.usedPoolMb`, real nvidia-smi in the Python run) is
// spied to null in every test, so the suite never starts a program — no assertion reads it.
import { beforeEach, expect, test, vi } from "vitest";
import { VramArbiter } from "../src/runner/arbiter.js";
import * as hardware from "../src/runner/hardware.js";

beforeEach(() => {
  vi.spyOn(hardware, "usedPoolMb").mockResolvedValue(null);
});

/** A discrete-box fake by default (cuda runtime → memArch 'discrete', so the ledger totals
 * stay the card's VRAM — the historical numbers every test below pins). The Phase-4 arch
 * tests build one-pool shapes explicitly. */
function hw(vramMb, { platform = "windows", ramMb = 32768, runtimes = null } = {}) {
  return { platform, ramMb, runtimes: runtimes ?? { cuda: true }, gpus: [{ vramMb }] };
}

const arb = (vramMb = 8000) => new VramArbiter(() => hw(vramMb));

test("reserve_committed_remaining", async () => {
  const a = arb(8000);
  expect(a.committedMb()).toBe(0);
  expect(await a.remainingMb()).toBe(8000);
  a.reserve("chat", 5000);
  expect(a.committedMb()).toBe(5000);
  expect(await a.remainingMb()).toBe(3000);
  a.reserve("embed", 500);
  expect(a.committedMb()).toBe(5500);
  expect(await a.remainingMb()).toBe(2500);
  expect(a.count()).toBe(2);
});

test("release_is_idempotent", () => {
  const a = arb(8000);
  a.reserve("chat", 5000);
  a.release("chat");
  a.release("chat"); // no-op, no crash
  expect(a.committedMb()).toBe(0);
  expect(a.count()).toBe(0);
});

test("reserve_replaces_same_key", () => {
  const a = arb(8000);
  a.reserve("chat", 5000);
  a.reserve("chat", 6000); // a re-tune REPLACES, does not add
  expect(a.committedMb()).toBe(6000);
  expect(a.count()).toBe(1);
});

test("remaining_never_negative", async () => {
  const a = arb(1000);
  a.reserve("big", 5000); // over-committed (an over-fit that CPU-auto-offloaded)
  expect(await a.remainingMb()).toBe(0);
  expect(1 > (await a.remainingMb())).toBe(true); // nothing more fits the ledger
});

test("negative_reservation_clamped", () => {
  const a = arb(8000);
  a.reserve("degenerate", -500); // a degenerate fit estimate → clamp to 0, never negative committed
  expect(a.committedMb()).toBe(0);
});

test("pick_evict_is_lru", () => {
  const a = arb(8000);
  a.reserve("a", 100); // oldest
  a.reserve("b", 100);
  a.reserve("c", 100); // newest
  expect(a.pickEvict()).toBe("a"); // least-recently-used
  a.touch("a"); // a is now most-recent
  expect(a.pickEvict()).toBe("b"); // b is now the LRU
});

test("pick_evict_skips_pinned", () => {
  const a = arb(8000);
  a.reserve("embed", 500, { pinned: true }); // oldest, but pinned
  a.reserve("chat", 5000);
  expect(a.pickEvict()).toBe("chat"); // the pinned embed is never the victim
  a.release("chat");
  expect(a.pickEvict()).toBeNull(); // only the pinned one left → nothing evictable
});

test("pick_evict_exclude", () => {
  const a = arb(8000);
  a.reserve("a", 100); // older
  a.reserve("b", 100);
  expect(a.pickEvict({ exclude: "a" })).toBe("b"); // exclude the model being (re)loaded from its own eviction
  a.reserve("only", 100);
  a.release("a");
  a.release("b");
  expect(a.pickEvict({ exclude: "only" })).toBeNull();
});

test("touch_noop_when_absent", () => {
  const a = arb(8000);
  a.touch("missing"); // no crash, no reservation created
  expect(a.count()).toBe(0);
});

test("snapshot_and_reserved_mb", async () => {
  const a = arb(8000);
  a.reserve("chat", 5000);
  a.reserve("embed", 500, { pinned: true });
  const snap = await a.snapshot();
  expect(snap.vram_total_mb).toBe(8000);
  expect(snap.committed_mb).toBe(5500);
  expect(snap.remaining_mb).toBe(2500);
  expect(snap.reservations.map((r) => r.key)).toEqual(["chat", "embed"]); // LRU order (chat first)
  expect(snap.reservations[1].pinned).toBe(true);
  expect(a.reservedMb("chat")).toBe(5000);
  expect(a.reservedMb("nope")).toBeNull();
});

test("clear", () => {
  const a = arb(8000);
  a.reserve("chat", 5000);
  a.clear();
  expect(a.committedMb()).toBe(0);
  expect(a.count()).toBe(0);
});

test("cpu_only_box_zero_budget", async () => {
  const a = arb(0); // no GPU
  expect(await a.remainingMb()).toBe(0);
  expect(1 > (await a.remainingMb())).toBe(true); // nothing more fits the ledger
});

test("pick_evict_min_mb_skips_small_reservations", () => {
  // 2026-07-11: VRAM-driven eviction skips ~zero-VRAM victims (a CPU-placed embed's
  // driver-context crumbs) — freeing them can't make a GPU model fit, but it kills the warm
  // embed child. minMb=0 (the count-driven path) keeps the old behavior.
  const a = arb(8000);
  a.reserve("tiny", 44); // oldest → LRU, but sub-threshold
  a.reserve("big", 4000);
  expect(a.pickEvict({ minMb: 600 })).toBe("big"); // LRU says "tiny"; the threshold skips it
  a.release("big");
  expect(a.pickEvict({ minMb: 600 })).toBeNull(); // only the tiny one left → nothing evictable
  expect(a.pickEvict()).toBe("tiny"); // count-driven (minMb=0) still picks it
});

test("sync_pins_realigns_to_current_default", () => {
  // 2026-07-12: pins were stamped at load time and never re-checked — a REPLACED embed kept
  // its stale pin and deflected a count-cap eviction onto the chat model.
  const a = arb(8000);
  a.reserve("old-embed", 500, { pinned: true }); // was the default when it loaded
  a.reserve("new-embed", 500);
  a.syncPins(new Set(["new-embed"])); // the default moved
  expect(a.pickEvict()).toBe("old-embed"); // stale pin cleared → evictable
  a.release("old-embed");
  expect(a.pickEvict()).toBeNull(); // the CURRENT default is now the pinned one
});

test("pick_evict_among_restricts_candidates", () => {
  // The embed-swap pass evicts a REPLACED embed before anything else (2026-07-12).
  const a = arb(8000);
  a.reserve("chat", 5000); // LRU — the default pick without `among`
  a.reserve("stale-embed", 550);
  expect(a.pickEvict({ among: new Set(["stale-embed"]) })).toBe("stale-embed");
  expect(a.pickEvict({ among: new Set(["absent"]) })).toBeNull();
  expect(a.pickEvict()).toBe("chat");
});

// ── the 2026-08-09 eviction-executor seam (JV vram-think §6 step 1) ─────────

test("count_and_pick_evict_are_kind_scoped", () => {
  // P5-3: a resident TTS engine must not eat a models_max llama.cpp child slot, and a
  // count-cap eviction only ever removes the runner's OWN children.
  const a = arb(8000);
  a.reserve("chat", 4000); // kind defaults to "llm"
  a.reserve("tts:luxtts", 1024, { kind: "tts", evictFn: () => {} });
  expect(a.count()).toBe(2);
  expect(a.count("llm")).toBe(1);
  expect(a.count({ kind: "tts" })).toBe(1); // Python's keyword form
  expect(a.pickEvict({ kind: "llm" })).toBe("chat"); // never the TTS engine
  a.release("chat");
  expect(a.pickEvict({ kind: "llm" })).toBeNull();
});

test("busy_counters_stack_and_clear", () => {
  const a = arb(8000);
  expect(a.busyKinds()).toEqual(new Set());
  a.busyBegin("tts");
  a.busyBegin("tts"); // overlapping synth lines stack
  a.busyBegin("llm");
  expect(a.busyKinds()).toEqual(new Set(["tts", "llm"]));
  a.busyEnd("tts");
  expect(a.busyKinds()).toEqual(new Set(["tts", "llm"])); // one line still in flight
  a.busyEnd("tts");
  a.busyEnd("llm");
  expect(a.busyKinds()).toEqual(new Set());
  a.busyEnd("llm"); // underflow is a no-op, no crash
  expect(a.busyKinds()).toEqual(new Set());
});

test("make_room_executes_the_owners_evictor_lru_first", async () => {
  const a = arb(8000);
  const killed = [];
  a.reserve("old", 5000, { evictFn: () => killed.push("old") }); // LRU
  a.reserve("new", 2000, { evictFn: () => killed.push("new") });
  expect(await a.makeRoom(3000)).toBe(true); // 1000 free + 5000 from "old"
  expect(killed).toEqual(["old"]); // LRU died; "new" untouched
  expect(a.isReserved("new")).toBe(true);
  expect(a.isReserved("old")).toBe(false);
});

test("make_room_skips_busy_kinds", async () => {
  // Q1's never-evict-busy: a mid-synth TTS engine is untouchable, so the admission reports
  // false and the caller decides warn-vs-refuse.
  const a = arb(8000);
  a.reserve("tts:luxtts", 7000, { kind: "tts", evictFn: () => {} });
  a.busyBegin("tts");
  expect(await a.makeRoom(3000)).toBe(false);
  expect(a.isReserved("tts:luxtts")).toBe(true);
  a.busyEnd("tts");
  expect(await a.makeRoom(3000)).toBe(true); // idle again → evictable
});

test("make_room_requires_an_evictor_for_foreign_kinds", async () => {
  // The pass-3 ledger-corruption scenario: without a registered evictor, foreign code has NO
  // safe way to unload a reservation — never pick it.
  const a = arb(8000);
  a.reserve("tts:luxtts", 7000, { kind: "tts" }); // no evictFn
  expect(await a.makeRoom(3000)).toBe(false);
  expect(a.isReserved("tts:luxtts")).toBe(true);
});

test("make_room_self_evict_covers_own_kind_without_evict_fn", async () => {
  // The runner's _admit knows how to unload its OWN children even when a reservation
  // predates the seam (tests, legacy rows).
  const a = arb(8000);
  a.reserve("chat", 7000); // llm, no evictFn
  const killed = [];
  expect(await a.makeRoom(3000, { selfKind: "llm", selfEvict: (k) => killed.push(k) })).toBe(true);
  expect(killed).toEqual(["chat"]);
  expect(a.isReserved("chat")).toBe(false);
});

test("make_room_releases_on_a_failed_evictor", async () => {
  // Release-on-attempt (the _admit termination lesson): a raising evictor still frees the
  // ledger row, so the loop can't spin on the same victim.
  const a = arb(8000);
  const boom = () => {
    throw new Error("child already gone");
  };
  a.reserve("old", 5000, { evictFn: boom });
  expect(await a.makeRoom(4000)).toBe(true);
  expect(a.isReserved("old")).toBe(false);
});

test("make_room_respects_protected_kinds_and_min_mb", async () => {
  const a = arb(8000);
  a.reserve("stt:whisper", 1500, { kind: "stt", evictFn: () => {} });
  a.reserve("tiny", 100, { kind: "llm", evictFn: () => {} });
  // stt protected by the caller; the tiny llm row is under EVICT_MIN_MB.
  expect(await a.makeRoom(7000, { protectedKinds: new Set(["stt"]) })).toBe(false);
  expect(a.isReserved("stt:whisper")).toBe(true);
  expect(a.isReserved("tiny")).toBe(true);
});

test("snapshot_carries_kind_and_busy", async () => {
  const a = arb(8000);
  a.reserve("chat", 5000);
  a.reserve("tts:luxtts", 1024, { kind: "tts", evictFn: () => {} });
  a.busyBegin("tts");
  const snap = await a.snapshot();
  const kinds = Object.fromEntries(snap.reservations.map((r) => [r.key, r.kind]));
  expect(kinds).toEqual({ chat: "llm", "tts:luxtts": "tts" });
  expect(snap.busy_kinds).toEqual(["tts"]);
  a.busyEnd("tts");
});

test("eviction_events_ring_and_since", async () => {
  const a = arb(8000);
  a.reserve("old", 5000, { evictFn: () => {} });
  await a.makeRoom(4000, { reason: "loading luxtts" });
  const events = a.eventsSince(0);
  expect(events.length).toBe(1);
  const e = events[0];
  expect(e.victim_key).toBe("old");
  expect(e.victim_kind).toBe("llm");
  expect(e.reason).toBe("loading luxtts");
  expect(e.seq).toBe(1);
  expect(a.eventsSince(e.seq)).toEqual([]); // the client's cursor advances
  a.clear();
  expect(a.eventsSince(0)).toEqual([]);
});

// ── Phase 4 (fit-redesign §5.2/§13.10c): the ledger goes ARCH-AWARE ──────────

/** An integrated/unified shape: no cuda runtime, no >=4 GB dedicated card — memArch resolves
 * 'integrated' ('unified' when platform='macos', which has no GPU row at all — the real
 * detect() shape). */
function onePoolHw(ramMb = 32768, { platform = "windows", gpus = true } = {}) {
  const rows = gpus && platform !== "macos" ? [{ vramMb: null }] : [];
  return { platform, ramMb, runtimes: platform === "macos" ? { metal: true } : { vulkan: true }, gpus: rows };
}

test("one_pool_budget_is_the_pool_and_claims_count_once", async () => {
  // The §13.10(c) pin. Before Phase 4 a one-pool box totaled 0: remaining was permanently 0
  // and every admission fell into evict-then-warn. Now the denominator is the POOL, and one
  // reservation = one pool-delta number — counted once (mmap'd weights + "GPU" allocation are
  // the same bytes on UMA).
  const a = new VramArbiter(() => onePoolHw(32768));
  let snap = await a.snapshot();
  expect(snap.mem_arch).toBe("integrated");
  expect(snap.vram_total_mb).toBe(32768);
  a.reserve("e4b", 5000);
  snap = await a.snapshot();
  expect(snap.committed_mb).toBe(5000); // once, not double-booked
  expect(snap.remaining_mb).toBe(32768 - 5000);
  expect(20000 <= (await a.remainingMb())).toBe(true); // the pool admits a co-load
});

test("unified_mac_budget_is_the_pool", async () => {
  const a = new VramArbiter(() => onePoolHw(65536, { platform: "macos" }));
  const snap = await a.snapshot();
  expect(snap.mem_arch).toBe("unified");
  expect(snap.vram_total_mb).toBe(65536);
  expect(await a.remainingMb()).toBe(65536);
});

test("discrete_budget_stays_the_card", async () => {
  // The historical meaning is UNCHANGED on discrete boxes — card VRAM, not RAM.
  const a = arb(8000);
  const snap = await a.snapshot();
  expect(snap.mem_arch).toBe("discrete");
  expect(snap.vram_total_mb).toBe(8000);
  expect(await a.remainingMb()).toBe(8000); // never the 32 GB RAM the fake also carries
});

// ── the sleeping child (2026-08-15) ──────────────────────────────────────────
// A router-idle-unloaded child holds no VRAM. The ledger used to keep booking it, which made
// `committedMb` a fiction — and because JustVoice's speech door prices on a MEASURED probe
// (it must; the ledger cannot see other programs), that door walked into the freed memory
// with the booking still standing and the ledger ended 10.6 GB deep on an 8 GB card. These
// pin both halves of the fix.

test("sleeping_reservation_is_not_committed", async () => {
  const a = arb(8000);
  a.reserve("chat", 6000, { kind: "llm", evictFn: () => {} });
  expect(a.committedMb()).toBe(6000);
  expect(await a.remainingMb()).toBe(2000);
  a.syncSleeping(new Set(["chat"]));
  // Held = 0, booked = 6000. The card really is free; say so.
  expect(a.committedMb()).toBe(0);
  expect(await a.remainingMb()).toBe(8000);
  expect(a.bookedMb()).toBe(6000);
  expect(a.isAsleep("chat")).toBe(true);
});

test("sync_sleeping_wakes_what_the_router_no_longer_lists", () => {
  const a = arb(8000);
  a.reserve("chat", 6000, { kind: "llm", evictFn: () => {} });
  a.syncSleeping(new Set(["chat"]));
  a.syncSleeping(new Set()); // the router reports it loaded again
  expect(a.isAsleep("chat")).toBe(false);
  expect(a.committedMb()).toBe(6000);
});

test("sync_sleeping_never_touches_another_kind", () => {
  // Only llama.cpp children sleep. A speech engine is up or gone, and the router's list must
  // not be able to mark one asleep by omission.
  const a = arb(8000);
  a.reserve("tts:chatterbox", 4400, { kind: "tts", evictFn: () => {} });
  a.syncSleeping(new Set(["chat"]));
  expect(a.isAsleep("tts:chatterbox")).toBe(false);
  expect(a.committedMb()).toBe(4400);
});

test("vram_eviction_skips_a_sleeper_but_a_count_eviction_takes_it", () => {
  // Killing something that holds nothing cannot make room — the EVICT_MIN_MB lesson, same
  // shape. A COUNT-driven eviction (minMb 0) still takes it: there the goal is a free child
  // slot, which a sleeper does occupy.
  const a = arb(8000);
  a.reserve("sleeper", 6000, { kind: "llm", evictFn: () => {} });
  a.syncSleeping(new Set(["sleeper"]));
  expect(a.pickEvict({ minMb: 600 })).toBeNull();
  expect(a.pickEvict({ minMb: 0 })).toBe("sleeper");
});

test("make_room_never_picks_a_sleeper_as_victim", async () => {
  const killed = [];
  const a = arb(8000);
  a.reserve("sleeper", 5000, { kind: "llm", evictFn: () => killed.push("sleeper") });
  a.reserve("tts:chatterbox", 4400, { kind: "tts", evictFn: () => killed.push("tts") });
  a.syncSleeping(new Set(["sleeper"]));
  // 8000 total, 4400 held by the TTS engine → 3600 remain. A 5000 MB wake needs the TTS out;
  // the sleeper is not a candidate, however stale its LRU stamp.
  expect(await a.makeRoom(5000, { exclude: "sleeper" })).toBe(true);
  expect(killed).toEqual(["tts"]);
});

test("mark_awake_books_the_memory_back_immediately", async () => {
  // Between making room and the router refilling it there is a gap; if the ledger still
  // called the model asleep, a co-tenant admission could take the room the wake just made.
  const a = arb(8000);
  a.reserve("chat", 6000, { kind: "llm", evictFn: () => {} });
  a.syncSleeping(new Set(["chat"]));
  a.markAwake("chat");
  expect(a.isAsleep("chat")).toBe(false);
  expect(a.committedMb()).toBe(6000);
  expect(await a.remainingMb()).toBe(2000);
});

test("snapshot_reports_asleep_and_both_totals", async () => {
  const a = arb(8000);
  a.reserve("chat", 6000, { kind: "llm", evictFn: () => {} });
  a.reserve("tts:kokoro", 700, { kind: "tts", evictFn: () => {} });
  a.syncSleeping(new Set(["chat"]));
  const snap = await a.snapshot();
  expect(snap.committed_mb).toBe(700); // what the card holds
  expect(snap.booked_mb).toBe(6700); // what it holds once the sleeper wakes
  const rows = Object.fromEntries(snap.reservations.map((r) => [r.key, r]));
  expect(rows.chat.asleep).toBe(true);
  expect(rows["tts:kokoro"].asleep).toBe(false);
  expect(a.reservationOf("chat").asleep).toBe(true);
});

test("a_fresh_reserve_clears_the_sleep_flag", () => {
  // reserve() is an upsert used by the post-load true-up — a model that just loaded is awake
  // by definition, whatever the last probe said.
  const a = arb(8000);
  a.reserve("chat", 6000, { kind: "llm", evictFn: () => {} });
  a.syncSleeping(new Set(["chat"]));
  a.reserve("chat", 6100, { kind: "llm", evictFn: () => {} });
  expect(a.isAsleep("chat")).toBe(false);
  expect(a.committedMb()).toBe(6100);
});
