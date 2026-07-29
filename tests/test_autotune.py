# SPDX-License-Identifier: MIT
"""Auto-tune sweep (runner/autotune.py) — offline: the service is faked, so the
candidate ladder, winner pick, failure-skip, cancel, save and busy-guard logic
test without a GPU or a llama-server."""

import threading
from types import SimpleNamespace

from llm_runner.runner.autotune import AutoTuner


class FakeService:
    """Scripted load/measure: tok/s per n_cpu_moe value; a value in `fail` never
    reaches running. Mirrors the real surface the sweep drives."""

    def __init__(self, *, tps_by_ncmoe=None, fail=(), block=30, is_moe=True):
        self.tps_by_ncmoe = tps_by_ncmoe or {}
        self.fail = set(str(f) for f in fail)
        self.block = block
        self.is_moe = is_moe
        self.loads = []          # every switches dict passed to load()
        self._current = None     # (model_id, ncmoe) of the "resident" model
        self.stops = 0
        self.embeds = 0

    def preview_fit(self, model_id, switches=None):
        return {"ok": True, "blockCount": self.block, "isMoe": self.is_moe,
                "nGpuLayers": 99, "nCpuMoe": self.block, "ctxLen": 8192}

    def stop(self, model_id=None):
        self.stops += 1
        self._current = None

    def ensure_embedding(self):
        self.embeds += 1
        return {"ok": True}

    def load(self, model_id, overrides=None, job_id=None, switches=None, trigger="api"):
        self.loads.append(dict(switches or {}))
        self._current = (model_id, str((switches or {}).get("n_cpu_moe", "")))
        return {"status": "starting"}

    def status(self):
        if self._current is None:
            return {"status": "idle"}
        mid, ncmoe = self._current
        if ncmoe in self.fail:
            return {"status": "error", "error": f"OOM at n_cpu_moe {ncmoe}", "modelId": mid}
        return {"status": "running", "modelId": mid}

    def measure(self, *, model_id=None, max_tokens=0, **kw):
        _, ncmoe = self._current
        tps = self.tps_by_ncmoe.get(ncmoe or "base", 10.0)
        return {"ok": True, "tokensPerSec": tps, "completionTokens": max_tokens,
                "ms": 1000.0, "vramTotalMb": 7000}


def _run_to_end(tuner, *args, **kw):
    st = tuner.start(*args, **kw)
    assert st["status"] == "running"
    tuner._thread.join(timeout=10)
    return tuner.status()


def _tuner(svc):
    return AutoTuner(service_fn=lambda: svc, sleep=lambda s: None)


BASE = {"n_cpu_moe": "21", "batch_size": "512", "ubatch_size": "512", "threads": "8"}


def test_walk_steps_while_improving_and_strict_beats_baseline():
    # Tuned anchor 21 (in BASE → the baseline already measures it): probes 23 and 19;
    # 19 improves on 23 → walk continues DOWN while improving (17 better, 15 worse →
    # stop). Winner = 17 (strictly beats the 30.0 baseline beyond the 5% band).
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 28.0, "19": 33.0, "17": 36.0, "15": 35.0})
    st = _run_to_end(_tuner(svc), "m", BASE)
    assert st["status"] == "done"
    assert [t["label"] for t in st["trials"]] == [
        "baseline", "n-cpu-moe 23", "n-cpu-moe 19", "n-cpu-moe 17", "n-cpu-moe 15"]
    assert st["best"]["switches"]["n_cpu_moe"] == "17"
    assert st["best"]["tokensPerSec"] == 36.0
    # every trial ran with the embed ensured + a clean stop first (production-true floor)
    assert svc.embeds == len(st["trials"]) and svc.stops == len(st["trials"])


def test_strict_beat_a_tying_explicit_never_overwrites_baseline():
    # 1b-F5: 19 TIES the baseline within the 5% band (30.9 vs 30.0) — the baseline
    # stands, and NOTHING is saved (a tying explicit value would permanently disable
    # the engine's fit / clobber the existing tune for zero measured gain).
    saves = []
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 25.0, "19": 30.9, "17": 30.0})
    st = _run_to_end(_tuner(svc), "m", BASE, save_fn=lambda mid, sw: saves.append(sw), save=True)
    assert st["status"] == "done"
    assert st["best"]["label"] == "baseline"
    assert st["saved"] is False and saves == []
    assert "nothing saved" in st["detail"]


def test_untuned_base_probes_the_computed_anchor_explicitly():
    # Untuned base (no n_cpu_moe): the baseline is the FIT-placed launch, so the
    # computed anchor (preview nCpuMoe=30) is untried → probed explicitly first.
    svc = FakeService(tps_by_ncmoe={"base": 20.0, "30": 21.0, "28": 22.0, "26": 21.0})
    st = _run_to_end(_tuner(svc), "m", {"batch_size": "512", "ubatch_size": "512"})
    labels = [t["label"] for t in st["trials"]]
    assert labels[0] == "baseline" and labels[1] == "n-cpu-moe 30"


def test_spec_n_alternative_tried_for_mtp_base_only():
    # A9: an MTP base (spec_type=draft-mtp, spec_n 2) gets ONE spec-n 3 trial; the
    # winner still obeys strict-beat. A non-MTP base gets no spec-n trial (covered
    # by the label sweep in the other tests).
    base = dict(BASE, spec_type="draft-mtp", spec_n_max="2")
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "19": 20.0})
    st = _run_to_end(_tuner(svc), "m", base)
    labels = [t["label"] for t in st["trials"]]
    assert "spec-n 3" in labels


def test_failed_trial_is_recorded_and_baseline_wins():
    # 19 OOMs at load — its trial records the error (tok/s 0 ends that direction),
    # no explicit candidate strictly beats the baseline → the baseline wins.
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 22.0}, fail=("19",))
    st = _run_to_end(_tuner(svc), "m", BASE)
    assert st["status"] == "done"
    failed = [t for t in st["trials"] if not t["ok"]]
    assert len(failed) == 1 and "19" in failed[0]["error"]
    assert st["best"]["label"] == "baseline"


def test_batch_variant_added_when_baseline_differs():
    base = {"n_cpu_moe": "21", "batch_size": "64", "ubatch_size": "32"}
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "20": 20.0, "19": 20.0})
    st = _run_to_end(_tuner(svc), "m", base)
    labels = [t["label"] for t in st["trials"]]
    assert labels[1] == "batch 512/512"
    # the ladder candidates carry 512/512 (the measured-better batch), not the 64/32 base
    ladder = [t for t in st["trials"] if t["label"].startswith("n-cpu-moe")]
    assert all(t["switches"]["batch_size"] == "512" for t in ladder)


def test_dense_model_sweeps_batch_only():
    svc = FakeService(is_moe=False, tps_by_ncmoe={"": 40.0, "base": 40.0})
    st = _run_to_end(_tuner(svc), "m", {"batch_size": "64", "ubatch_size": "32"})
    assert st["status"] == "done"
    assert [t["label"] for t in st["trials"]] == ["baseline", "batch 512/512"]


def test_cancel_stops_between_trials():
    svc = FakeService(tps_by_ncmoe={"21": 30.0})
    tuner = _tuner(svc)
    # cancel the moment the first trial lands (the push happens before the next loop check)
    orig = tuner._push_trial

    def push_and_cancel(row):
        orig(row)
        tuner._cancel = True

    tuner._push_trial = push_and_cancel
    st = _run_to_end(tuner, "m", BASE)
    assert st["status"] == "cancelled"
    assert len(st["trials"]) == 1


def test_cancel_state_lands_before_a_blocked_teardown():
    # QC-22 ("stopping the optimize pc does not work"): the teardown's svc.stop()
    # can block behind the service's router lock for minutes on a failing box —
    # the terminal state must land BEFORE it, so the UI ("stopping…") unsticks
    # even while the teardown is still waiting.
    import time

    gate = threading.Event()

    class BlockingStopService(FakeService):
        def stop(self, model_id=None):
            super().stop(model_id)
            if self.stops > 1:  # the baseline trial's clean-slate stop passes; the teardown blocks
                gate.wait(timeout=5)

    svc = BlockingStopService(tps_by_ncmoe={"21": 30.0})
    tuner = _tuner(svc)
    orig = tuner._push_trial

    def push_and_cancel(row):
        orig(row)
        tuner._cancel = True

    tuner._push_trial = push_and_cancel
    tuner.start("m", BASE)
    for _ in range(500):  # the state write precedes the blocked stop — poll it in
        if tuner.status()["status"] == "cancelled":
            break
        time.sleep(0.01)
    assert tuner.status()["status"] == "cancelled"   # unstuck WHILE the teardown blocks
    assert tuner._thread.is_alive()                  # the teardown really is still blocked
    assert len(tuner.status()["trials"]) == 1
    gate.set()
    tuner._thread.join(timeout=10)
    assert svc.loads[-1] == {}                       # the restore load still fired after


def test_cancel_between_trials_skips_service_work():
    # QC-22: a cancel that lands between trials must not START the next one —
    # the fast-path returns before svc.stop()/load(), so the teardown never
    # queues behind post-cancel trial work.
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 25.0, "19": 25.0})
    tuner = _tuner(svc)
    orig_preview = svc.preview_fit

    def preview_and_cancel(model_id, switches=None):
        tuner._cancel = True  # lands after the baseline, before the ncmoe walk
        return orig_preview(model_id, switches)

    svc.preview_fit = preview_and_cancel
    st = _run_to_end(tuner, "m", BASE)
    assert st["status"] == "cancelled"
    assert [t["label"] for t in st["trials"]] == ["baseline"]  # no walk trial ever pushed
    assert svc.stops == 2            # baseline's clean slate + the teardown — no walk stops
    assert svc.embeds == 1           # only the baseline trial touched the service
    assert svc.loads == [dict(BASE), {}]  # baseline load + the bare restore, nothing else


def test_restart_during_teardown_is_accepted_and_old_teardown_skipped():
    # QC-22 generation guard: state-first makes a restart legal while the old
    # run still tears down — the old run must then SKIP its teardown (it would
    # knock down the new run's trial) and never overwrite the new run's state.
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 25.0, "19": 25.0})
    tuner = _tuner(svc)
    orig_push = tuner._push_trial

    def push_and_cancel(row):
        orig_push(row)
        tuner._cancel = True

    tuner._push_trial = push_and_cancel
    orig_set = tuner._set
    restarted = []

    def set_and_restart(**kw):
        orig_set(**kw)
        if kw.get("status") == "cancelled" and not restarted:
            restarted.append(tuner._thread)          # the OLD thread, to join later
            tuner._push_trial = orig_push            # the new run must run to completion
            tuner.start("m2", BASE)                  # races in right after the state write

    tuner._set = set_and_restart
    tuner.start("m", BASE)
    import time

    for _ in range(500):  # wait for the hook to have restarted (it runs on the old thread)
        if restarted:
            break
        time.sleep(0.01)
    assert restarted, "the cancel state write never fired"
    restarted[0].join(timeout=10)   # the old thread
    tuner._thread.join(timeout=10)  # now the NEW run's thread
    st = tuner.status()
    assert st["status"] == "done" and st["modelId"] == "m2"  # the new run owned the state
    assert {} not in svc.loads  # the old run's bare restore load was SKIPPED (gen guard)


def test_save_on_done_writes_winner_verbatim():
    saved = {}
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 35.0, "20": 20.0, "19": 20.0})
    st = _run_to_end(_tuner(svc), "m", BASE,
                     save_fn=lambda mid, sw: saved.update({mid: sw}), save=True)
    assert st["status"] == "done" and st["saved"] is True
    assert saved["m"]["n_cpu_moe"] == "23"


def test_tie_band_prefers_higher_ncmoe_headroom_among_explicit():
    # 19 measures nominally fastest (36.0) but 23 sits within the 5% tie band (34.5)
    # — single measures carry ±10% MTP noise, so the tie AMONG EXPLICIT candidates
    # resolves to the HIGHER n-cpu-moe (more VRAM headroom at indistinguishable
    # speed). Both strictly beat the 25.0 baseline, so the save proceeds.
    svc = FakeService(tps_by_ncmoe={"21": 25.0, "23": 34.5, "19": 36.0, "17": 30.0})
    st = _run_to_end(_tuner(svc), "m", BASE)
    assert st["status"] == "done"
    assert st["best"]["switches"]["n_cpu_moe"] == "23"


def test_walk_stops_at_a_failed_ncmoe_never_below():
    # MoE VRAM need is monotonic: 19 fails → the down-walk STOPS — nothing below 19
    # is ever loaded (the walk breaks on failure; the `_try` prune remains a
    # defensive backstop for any future multi-direction candidates).
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 25.0}, fail=("19",))
    st = _run_to_end(_tuner(svc), "m", BASE)
    assert st["status"] == "done"
    tried = [t["label"] for t in st["trials"]]
    assert "n-cpu-moe 17" not in tried and "n-cpu-moe 15" not in tried
    # down probe failed (0.0) → the walk goes UP instead (25, worse → stop):
    # baseline + 23 + the failed 19 + 25 — and never anything below the failure.
    assert len(svc.loads) == 4


def test_busy_guard_rejects_second_start():
    svc = FakeService(tps_by_ncmoe={"21": 30.0})
    tuner = _tuner(svc)
    gate = threading.Event()
    svc_measure = svc.measure

    def slow_measure(**kw):
        gate.wait(timeout=5)
        return svc_measure(**kw)

    svc.measure = slow_measure
    tuner.start("m", BASE)
    second = tuner.start("m", BASE)
    assert second.get("ok") is False and "already running" in second["error"]
    gate.set()
    tuner._thread.join(timeout=10)
    assert tuner.status()["status"] == "done"


# ── D4: the draft phase — spec-off + the draft-file A/B (2026-07-19) ──────────

_MTP_BASE = dict(BASE, spec_type="draft-mtp", spec_n_max="2")


class DraftService(FakeService):
    """FakeService + the catalog row, acquire door and per-trial-KIND speeds the draft
    phase drives. `draft_tps`/`spec_off_tps` key off the trial's OWN switches (the
    n_cpu_moe-keyed script can't distinguish these — every draft trial carries the
    base's n_cpu_moe)."""

    def __init__(self, *, configured="MTP/cur-Q4_0-MTP.gguf", acquire_error=None,
                 draft_tps=None, spec_off_tps=None, **kw):
        super().__init__(**kw)
        self.configured = configured
        self.acquire_error = acquire_error
        self.draft_tps = draft_tps
        self.spec_off_tps = spec_off_tps
        self.acquired = []       # (repo, file) per acquire_draft_file call
        self.events = []         # interleaved "acquire:<file>" / "load:<what>"

    def catalog(self):
        return [SimpleNamespace(id="m", hf_repo="org/main-GGUF", mtp_draft_repo="",
                                mtp_draft_file=self.configured)]

    def acquire_draft_file(self, repo, file, cancel_check=None):
        if cancel_check is not None and cancel_check():
            raise RuntimeError("cancelled")
        if self.acquire_error:
            raise RuntimeError(self.acquire_error)
        self.acquired.append((repo, file))
        self.events.append(f"acquire:{file}")
        return f"/cache/{file}"

    def load(self, model_id, overrides=None, job_id=None, switches=None, trigger="api"):
        sw = dict(switches or {})
        self.events.append(f"load:{sw.get('model_draft') or sw.get('spec_type') or 'base'}")
        return super().load(model_id, overrides, job_id, switches, trigger)

    def measure(self, *, model_id=None, max_tokens=0, **kw):
        sw = self.loads[-1] if self.loads else {}
        forced = (self.draft_tps if sw.get("model_draft") else
                  self.spec_off_tps if sw.get("spec_type") == "none" else None)
        if forced is None:
            return super().measure(model_id=model_id, max_tokens=max_tokens, **kw)
        return {"ok": True, "tokensPerSec": forced, "completionTokens": max_tokens,
                "ms": 1000.0, "vramTotalMb": 7000}


def _listing(monkeypatch, drafts, *, raises=None):
    def fake(repo, revision="main"):
        if raises:
            raise raises
        return {"quants": [], "drafts": drafts}

    monkeypatch.setattr("llm_runner.runner.autotune.list_repo_ggufs", fake)


def test_draft_phase_measures_spec_off_and_each_alternate(monkeypatch):
    # An MTP base gets the saveable spec-off trial plus one row per alternate draft
    # FILE, each DOWNLOADED before its own load, ordered by the shared pick rule
    # (the q4OrBetter floor first, then smallest). The configured draft is skipped —
    # the baseline already measures it.
    _listing(monkeypatch, [
        {"path": "MTP/cur-Q4_0-MTP.gguf", "sizeMb": 240, "q4OrBetter": True},   # configured
        {"path": "MTP/alt-Q2_K-MTP.gguf", "sizeMb": 100, "q4OrBetter": False},  # smallest, below floor
        {"path": "MTP/alt-BF16-MTP.gguf", "sizeMb": 880, "q4OrBetter": True},
    ])
    svc = DraftService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "19": 20.0})
    st = _run_to_end(_tuner(svc), "m", _MTP_BASE)
    assert st["status"] == "done"
    labels = [t["label"] for t in st["trials"]]
    assert "no draft (spec off)" in labels
    assert "draft alt-BF16-MTP.gguf (0.9 GB)" in labels
    assert "draft alt-Q2_K-MTP.gguf (0.1 GB)" in labels
    # the configured draft is never re-fetched or re-measured
    assert [f for _r, f in svc.acquired] == ["MTP/alt-BF16-MTP.gguf", "MTP/alt-Q2_K-MTP.gguf"]
    # …and every acquire precedes ITS load (download, then measure)
    assert svc.events.index("acquire:MTP/alt-BF16-MTP.gguf") < svc.events.index("load:/cache/MTP/alt-BF16-MTP.gguf")


def test_draft_phase_skips_an_unloadable_dspark_alternate(monkeypatch):
    # T9 (2026-07-21): an alternate whose arch the engine can't load (loadable=False, e.g.
    # dspark) must never be A/B'd — it would only DOWNLOAD then fail-load. The same one-source
    # `loadable` flag classify_gguf_entries stamps gates the Lab sweep too, so a dspark sibling
    # is never fetched. (Rows without the key stay included — backward-compatible.)
    _listing(monkeypatch, [
        {"path": "MTP/alt-Q4_0-MTP.gguf", "sizeMb": 100, "q4OrBetter": True, "loadable": True},
        {"path": "repo-dspark-Q4_1.gguf", "sizeMb": 90, "q4OrBetter": True,
         "loadable": False, "unsupportedArch": "dspark"},
    ])
    svc = DraftService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "19": 20.0})
    st = _run_to_end(_tuner(svc), "m", _MTP_BASE)
    assert st["status"] == "done"
    labels = [t["label"] for t in st["trials"]]
    assert "draft alt-Q4_0-MTP.gguf (0.1 GB)" in labels        # the loadable alternate runs
    assert not any("dspark" in lbl for lbl in labels)          # the dspark one is never trialed
    assert all("dspark" not in f for _r, f in svc.acquired)    # …and never downloaded


def test_no_draft_phase_without_spec_draft_mtp(monkeypatch):
    _listing(monkeypatch, [{"path": "MTP/alt-Q4_0-MTP.gguf", "sizeMb": 100, "q4OrBetter": True}])
    svc = DraftService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "19": 20.0})
    st = _run_to_end(_tuner(svc), "m", BASE)  # no spec_type
    assert not any("draft" in t["label"] for t in st["trials"])
    assert svc.acquired == []


def test_draft_file_trials_never_win_and_never_save(monkeypatch):
    # THE save-discipline invariant: an informational draft-FILE trial is the fastest
    # thing measured and STILL cannot become the winner — a model_draft tune row would
    # pin an absolute cache path. No `model_draft` key may ever reach save_fn.
    _listing(monkeypatch, [{"path": "MTP/alt-BF16-MTP.gguf", "sizeMb": 880, "q4OrBetter": True}])
    saves = []
    svc = DraftService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "19": 20.0},
                       draft_tps=99.0)   # the alternate draft is far and away fastest
    st = _run_to_end(_tuner(svc), "m", _MTP_BASE,
                     save_fn=lambda mid, sw: saves.append(sw), save=True)
    fastest = max(st["trials"], key=lambda t: t["tokensPerSec"])
    assert fastest["label"].startswith("draft ") and fastest["informational"] is True
    assert st["best"]["label"] != fastest["label"]
    assert all("model_draft" not in sw for sw in saves)


def test_spec_off_can_win_and_saves_the_opt_out(monkeypatch):
    # The other half: "no draft (spec off)" is a NORMAL candidate. When drafting turns
    # out not to pay on this box, it wins under strict-beat and spec_type=none persists
    # (the documented MTP opt-OUT) — the CPU-only question, answered by measurement.
    _listing(monkeypatch, [])
    saves = []
    svc = DraftService(tps_by_ncmoe={"21": 10.0, "23": 9.0, "19": 9.0},
                       spec_off_tps=40.0)   # drafting does NOT pay on this box
    st = _run_to_end(_tuner(svc), "m", _MTP_BASE,
                     save_fn=lambda mid, sw: saves.append(sw), save=True)
    assert st["best"]["label"] == "no draft (spec off)"
    assert st["saved"] is True and saves[-1]["spec_type"] == "none"


def test_draft_phase_skipped_when_the_budget_is_gone(monkeypatch):
    # The time box gates this phase like every other: no new trial is scheduled and
    # nothing downloads once the cap trips — the sweep still finishes DONE.
    _listing(monkeypatch, [{"path": "MTP/alt-Q4_0-MTP.gguf", "sizeMb": 100, "q4OrBetter": True}])
    clock = {"t": 0.0}
    svc = DraftService(tps_by_ncmoe={"21": 30.0, "23": 40.0, "19": 20.0})
    orig = svc.measure

    def timed(**kw):
        clock["t"] += 6.0
        return orig(**kw)

    svc.measure = timed
    st = _run_to_end(_clocked_tuner(svc, clock), "m", _MTP_BASE, budget_seconds=10)
    assert st["status"] == "done"
    assert not any("draft" in t["label"] for t in st["trials"])
    assert svc.acquired == []


def test_draft_listing_failure_skips_the_alternates_only(monkeypatch):
    # Discovery is ADVISORY (the tier-C precedent): a dead HF listing costs the
    # alternates, not the sweep — and spec-off, which needs no network, still runs.
    _listing(monkeypatch, [], raises=RuntimeError("HF down"))
    svc = DraftService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "19": 20.0})
    st = _run_to_end(_tuner(svc), "m", _MTP_BASE)
    assert st["status"] == "done"
    assert "no draft (spec off)" in [t["label"] for t in st["trials"]]
    assert not any(t["label"].startswith("draft ") for t in st["trials"])


def test_draft_acquire_failure_is_one_row_not_the_sweep(monkeypatch):
    _listing(monkeypatch, [{"path": "MTP/alt-Q4_0-MTP.gguf", "sizeMb": 100, "q4OrBetter": True}])
    svc = DraftService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "19": 20.0},
                       acquire_error="404 from the hub")
    st = _run_to_end(_tuner(svc), "m", _MTP_BASE)
    assert st["status"] == "done"
    row = next(t for t in st["trials"] if t["label"].startswith("draft "))
    assert row["ok"] is False and "404" in row["error"] and row["informational"] is True


def test_cancel_between_trials_never_starts_a_draft_download(monkeypatch):
    # A cancel that lands BEFORE the alternates must not begin fetching one.
    _listing(monkeypatch, [{"path": "MTP/alt-Q4_0-MTP.gguf", "sizeMb": 100, "q4OrBetter": True}])
    svc = DraftService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "19": 20.0})
    tuner = _tuner(svc)
    orig = tuner._push_trial

    def push_and_cancel(row):
        orig(row)
        if row["label"] == "no draft (spec off)":
            tuner._cancel = True   # cancel right before the alternates would download

    tuner._push_trial = push_and_cancel
    st = _run_to_end(tuner, "m", _MTP_BASE)
    assert st["status"] == "cancelled"
    assert svc.acquired == []      # nothing downloaded after the cancel


def test_cancel_DURING_a_draft_download_aborts_that_fetch(monkeypatch):
    # THE escape proven to FIRE: the acquire door is handed the sweep's cancel token, so
    # a Stop pressed mid-download aborts THAT fetch instead of finishing a multi-hundred-
    # MB file first. Drop `cancel_check=` from _draft_phase's acquire call and this goes
    # red two ways — the fake completes the download (svc.acquired grows) and no failed
    # draft row is ever recorded.
    _listing(monkeypatch, [{"path": "MTP/alt-Q4_0-MTP.gguf", "sizeMb": 100, "q4OrBetter": True}])
    svc = DraftService(tps_by_ncmoe={"21": 30.0, "23": 20.0, "19": 20.0})
    tuner = _tuner(svc)

    def cancel_midway(repo, file, cancel_check=None):
        tuner._cancel = True                        # the user hits Stop mid-download
        if cancel_check is not None and cancel_check():
            raise RuntimeError("download cancelled")
        svc.acquired.append((repo, file))           # no token → the fetch runs to the end
        return f"/cache/{file}"

    svc.acquire_draft_file = cancel_midway
    st = _run_to_end(tuner, "m", _MTP_BASE)
    assert st["status"] == "cancelled"
    assert svc.acquired == []                       # aborted, not completed
    row = next(t for t in st["trials"] if t["label"].startswith("draft "))
    assert row["ok"] is False and "cancelled" in row["error"] and row["informational"] is True


# ── the time box (budget_seconds — the QuickSetup ~2-min quick tune, 2026-07-07) ──

def _clocked_tuner(svc, clock):
    return AutoTuner(service_fn=lambda: svc, sleep=lambda s: None, now=lambda: clock["t"])


def test_budget_stops_scheduling_and_keeps_best_so_far():
    # Each measure "costs" 6s on the fake clock; a 10s budget lets baseline + ONE
    # explicit trial run, then trips at the next walk_try — the run finishes DONE
    # with the best of what completed (23 @ 40 beats the 30 baseline).
    clock = {"t": 0.0}
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 40.0, "19": 45.0, "17": 50.0})
    orig_measure = svc.measure

    def timed_measure(**kw):
        clock["t"] += 6.0
        return orig_measure(**kw)

    svc.measure = timed_measure
    st = _run_to_end(_clocked_tuner(svc, clock), "m", BASE, budget_seconds=10)
    assert st["status"] == "done" and st["budgetSeconds"] == 10
    assert st["detail"].startswith("time budget reached")
    # baseline + n-cpu-moe 23 only — 19/17 (faster in the script) were never tried
    assert [t["label"] for t in st["trials"]] == ["baseline", "n-cpu-moe 23"]
    assert st["best"]["switches"]["n_cpu_moe"] == "23"


def test_budget_aborts_an_inflight_load_and_restores():
    # The load never reaches running; the tuner's poll sleep advances the clock, so
    # the 5s budget trips INSIDE _wait_running (not the 240s cap). No trial ever
    # succeeded → the honest error state — and the dangling trial load is torn down
    # + the applied model restored (stop + a bare load), the ROUND-9 teardown.
    clock = {"t": 0.0}

    class StuckService(FakeService):
        def status(self):
            return {"status": "starting"} if self._current else {"status": "idle"}

    svc = StuckService()
    tuner = AutoTuner(service_fn=lambda: svc, now=lambda: clock["t"],
                      sleep=lambda s: clock.__setitem__("t", clock["t"] + 1.0))
    st = _run_to_end(tuner, "m", BASE, budget_seconds=5)
    assert st["status"] == "error" and st["error"] == "no trial succeeded"
    assert st["trials"][0]["error"] == "time budget reached"
    # trial stop + the budget teardown stop; the restore load carries NO switches
    assert svc.stops == 2
    assert svc.loads[-1] == {}


def test_budget_abort_never_poisons_the_ncmoe_prune():
    # A budget-aborted n-cpu-moe trial is NOT a fit failure: nothing lands in the
    # monotonic prune list, so a later (uncapped) sweep may try lower values again.
    clock = {"t": 0.0}
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 28.0})
    orig_measure = svc.measure

    def timed_measure(**kw):
        clock["t"] += 6.0
        return orig_measure(**kw)

    svc.measure = timed_measure
    tuner = _clocked_tuner(svc, clock)
    failed_seen = []
    orig_try = tuner._try

    def spy_try(svc_, mid, label, switches, failed_ncmoe):
        failed_seen.append(list(failed_ncmoe))
        return orig_try(svc_, mid, label, switches, failed_ncmoe)

    tuner._try = spy_try
    st = _run_to_end(tuner, "m", BASE, budget_seconds=10)
    assert st["status"] == "done"
    assert all(f == [] for f in failed_seen)  # the prune list stayed empty throughout


def test_budget_zero_means_uncapped():
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 25.0, "19": 25.0})
    st = _run_to_end(_tuner(svc), "m", BASE, budget_seconds=0)
    assert st["status"] == "done" and st["budgetSeconds"] == 0
    assert "time budget" not in (st["detail"] or "")
