# SPDX-License-Identifier: GPL-3.0-or-later
"""Auto-tune sweep (runner/autotune.py) — offline: the service is faked, so the
candidate ladder, winner pick, failure-skip, cancel, save and busy-guard logic
test without a GPU or a llama-server."""

import threading

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

    def load(self, model_id, overrides=None, job_id=None, switches=None):
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


def test_winner_is_best_measured_tps():
    # anchor 21 → candidates: baseline(21), 23, 20, 19. 20 measures fastest → wins.
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 25.0, "20": 33.0, "19": 31.0})
    st = _run_to_end(_tuner(svc), "m", BASE)
    assert st["status"] == "done"
    assert [t["label"] for t in st["trials"]] == ["baseline", "n-cpu-moe 23", "n-cpu-moe 20", "n-cpu-moe 19"]
    assert st["best"]["switches"]["n_cpu_moe"] == "20"
    assert st["best"]["tokensPerSec"] == 33.0
    # every trial ran with the embed ensured + a clean stop first (production-true floor)
    assert svc.embeds == len(st["trials"]) and svc.stops == len(st["trials"])


def test_failed_trial_is_recorded_and_skipped():
    # 19 OOMs at load — its trial records the error, the sweep continues, 21 wins.
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 22.0, "20": 25.0}, fail=("19",))
    st = _run_to_end(_tuner(svc), "m", BASE)
    assert st["status"] == "done"
    failed = [t for t in st["trials"] if not t["ok"]]
    assert len(failed) == 1 and "19" in failed[0]["error"]
    assert st["best"]["switches"]["n_cpu_moe"] == "21"


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


def test_save_on_done_writes_winner_verbatim():
    saved = {}
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 35.0, "20": 20.0, "19": 20.0})
    st = _run_to_end(_tuner(svc), "m", BASE,
                     save_fn=lambda mid, sw: saved.update({mid: sw}), save=True)
    assert st["status"] == "done" and st["saved"] is True
    assert saved["m"]["n_cpu_moe"] == "23"


def test_tie_band_prefers_higher_ncmoe_headroom():
    # 20 measures nominally fastest (30.5) but 23 sits within the 5% tie band (29.5)
    # — single measures carry ±10% MTP noise, so the tie resolves to the HIGHER
    # n-cpu-moe (more VRAM headroom at indistinguishable speed).
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 29.5, "20": 30.5, "19": 10.0})
    st = _run_to_end(_tuner(svc), "m", BASE)
    assert st["status"] == "done"
    assert st["best"]["switches"]["n_cpu_moe"] == "23"


def test_prunes_below_a_failed_ncmoe():
    # MoE VRAM need is monotonic: once 20 fails, 19 is SKIPPED (never loaded) —
    # the pruning avoids the slowest failure mode (the service's OOM-backoff churn,
    # live-observed 2026-07-06: ~5 min of 14-GB reload cycles before timing out).
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 25.0}, fail=("20",))
    st = _run_to_end(_tuner(svc), "m", BASE)
    assert st["status"] == "done"
    skipped = [t for t in st["trials"] if "skipped" in (t.get("error") or "")]
    assert len(skipped) == 1 and skipped[0]["label"] == "n-cpu-moe 19"
    assert len(svc.loads) == 3  # baseline + 23 + the failed 20; 19 never loaded


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
