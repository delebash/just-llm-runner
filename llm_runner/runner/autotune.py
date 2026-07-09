# SPDX-License-Identifier: GPL-3.0-or-later
"""Auto-tune — a small measured sweep that finds a model's fastest launch config
on THIS box (2026-07-06, from the JW llamacpp tuning session — the manual
methodology in justwrite-app/docs/plans/2026-07-06-llamacpp-config-tuning-2070s.md,
downscaled to a one-click job).

WHAT it does: a short sequence of real load→measure trials against the resident
router — first settle batch/ubatch (512/512 vs the resolved baseline; measured
8.6× TTFT there), then walk `n-cpu-moe` around the fit/tune anchor (the winner is
usually within ±2 of it). Winner = highest measured decode tok/s (VRAM breaks
ties). Every trial runs with the configured embed co-resident (`ensure_embedding`
first) because the CPU-embed child holds real VRAM and shifts the MoE floor —
measuring without it finds configs that OOM in production.

WHAT it does NOT do: hunt the absolute OOM floor (the load path's own OOM
back-off would silently shed layers and corrupt the reading — a trial that
back-offs simply measures slower and loses), sweep threads (measured flat on
the reference box), or auto-save (the caller decides: the Tune modal fills
the grid for review; QuickSetup passes save=True). MTP bases DO get one spec-n
alternative trial (A9, 2026-07-06).

BENCH-METHOD CAVEAT (on-box incident 3, 2026-07-06): a verbatim-repeated prompt
hits llama's prompt cache and TTFT collapses to decode-only — `measure` reads
DECODE tok/s (cache-insensitive), which is why the sweep compares decode rates;
any future TTFT-shaped trial must cache-bust its prompt head per run (see the
ab-test doc's cache-busted variant).

Layering: this module owns the MECHANICS (service-driving sweep + job state).
The ROUTER FACTORY takes the llm-layer's `resolve_switches` + `save_tune`
callables via DI (mounted by `llm.install.install_llm`), so the runner never
imports llm stores — same seam as `make_catalog_router`.
"""

from __future__ import annotations

import logging
import threading
import time

from fastapi import APIRouter, HTTPException

from .lifecycle import get_service

log = logging.getLogger(__name__)

_POLL_INTERVAL = 1.0
_LOAD_TIMEOUT = 240.0    # per-trial cap — a candidate stuck in the service's OOM-backoff churn is a FAIL, not a wait
_MEASURE_TOKENS = 192    # live-validated 2026-07-06: 96-token measures sat inside the ±10% MTP noise band; 192 discriminates
_TIE_BAND = 0.95         # trials within 5% of the best are TIES → prefer the higher n-cpu-moe (VRAM headroom over noise)
_WALK_STEP = 2           # 1b-F5: the n-cpu-moe walk stride — probe ±2 around the anchor, then keep stepping
_WALK_MAX_TRIALS = 12    # explicit-ncmoe trial budget: covers a 37→21-style journey (8 steps) with slack


def _merged(base: dict, delta: dict) -> dict:
    out = {k: str(v) for k, v in (base or {}).items() if v not in (None, "")}
    out.update({k: str(v) for k, v in delta.items()})
    return out


def _int_of(switches: dict, key: str) -> int | None:
    try:
        return int(str(switches.get(key, "")).strip())
    except (TypeError, ValueError):
        return None


class AutoTuner:
    """One process-wide sweep job (engine-install pattern: background thread +
    a state dict the GET endpoint returns verbatim). `service_fn`/`sleep`/`now`
    are injection points so the sweep tests offline."""

    def __init__(self, service_fn=get_service, *, sleep=time.sleep, now=time.monotonic):
        self._service_fn = service_fn
        self._sleep = sleep
        self._now = now
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._cancel = False
        self._gen = 0  # sweep generation — a new start() supersedes an old run's teardown
        self._budget_deadline: float | None = None  # optional time box (quick tune)
        self._budget_hit = False                    # sticky: the cap tripped
        self._budget_aborted_load = False           # the cap aborted a load IN FLIGHT
        self._record_fn = None                      # optional measurement-history sink (llm layer, DI)
        self._state: dict = {"status": "idle", "modelId": "", "detail": "", "error": "",
                             "trials": [], "best": None, "saved": False, "budgetSeconds": 0}

    # ── public surface (endpoint-shaped) ─────────────────────────────────────

    def status(self) -> dict:
        with self._lock:
            return {**self._state, "trials": list(self._state["trials"])}

    def cancel(self) -> dict:
        with self._lock:
            if self._state["status"] == "running":
                self._cancel = True
                # Prompt now, not "after the current trial": _wait_running observes
                # this flag and aborts the in-flight load wait (see _run/_wait_running).
                self._state["detail"] = "stopping…"
        return self.status()

    def start(self, model_id: str, base_switches: dict, *, save_fn=None, save: bool = False,
              budget_seconds: float = 0, record_fn=None) -> dict:
        with self._lock:
            if self._state["status"] == "running":
                return {**self._state, "ok": False, "error": "an auto-tune is already running"}
            self._cancel = False
            self._gen += 1  # supersede any prior run still tearing down (see `cancelled`)
            # Measurement-history sink (#142 rows 5+6): every OK trial is a real
            # measurement, recorded as it lands. Best-effort — see _try.
            self._record_fn = record_fn
            # Optional time box (the QuickSetup "~2-min quick tune", 2026-07-07): once
            # exhausted, the sweep stops scheduling trials and finishes with the best
            # result so far — checked at the same seams as the cancel flag. 0 = uncapped.
            budget = max(0.0, float(budget_seconds or 0))
            self._budget_deadline = (self._now() + budget) if budget else None
            self._budget_hit = False
            self._budget_aborted_load = False
            self._state = {"status": "running", "modelId": model_id, "detail": "starting…",
                           "error": "", "trials": [], "best": None, "saved": False,
                           "budgetSeconds": budget}
            self._thread = threading.Thread(
                target=self._run, args=(model_id, dict(base_switches or {}), save_fn, save),
                daemon=True,
            )
            self._thread.start()
        return self.status()

    def _budget_over(self) -> bool:
        """True once the optional time budget is exhausted. Sticky — the first trip
        latches `_budget_hit` so every later check (incl. the prune guard) agrees."""
        if self._budget_hit:
            return True
        if self._budget_deadline is not None and self._now() >= self._budget_deadline:
            self._budget_hit = True
            return True
        return False

    # ── the sweep ─────────────────────────────────────────────────────────────

    def _set(self, **kw) -> None:
        with self._lock:
            self._state.update(kw)

    def _push_trial(self, row: dict) -> None:
        with self._lock:
            self._state["trials"].append(row)

    @staticmethod
    def _spec_alt(base: dict) -> int | None:
        """The ONE alternative spec-n trial for MTP models (A9: the optimal speculation
        depth is hardware-conditioned — the draft/target speed ratio changes when the
        target runs fully on-GPU). Gate = the resolved `spec_type`; 2↔3 around the
        current value; None for non-MTP bases (no trial)."""
        if str((base or {}).get("spec_type") or "") != "draft-mtp":
            return None
        cur = _int_of(base, "spec_n_max") or 3
        return 3 if cur == 2 else 2

    def _wait_running(self, svc, model_id: str) -> tuple[bool, str]:
        deadline = self._now() + _LOAD_TIMEOUT
        while self._now() < deadline:
            # A cancel must ABORT the in-flight load wait, not run out the 240s cap.
            # Without this the cancel only lands at the NEXT trial boundary, so a cancel
            # while a trial is loading hangs the user for minutes (the reported "cant
            # cance tune … it hangs"). Cheap, lock-free bool read (same as cancelled()).
            if self._cancel:
                return False, "cancelled"
            # The time box aborts an in-flight load the same way — otherwise a slow
            # trial load could run a "~2-min" quick tune out to the 240s cap. The
            # aborted-load flag tells the finish path to tear down + restore (the
            # router would otherwise keep chewing the trial's switches after done).
            if self._budget_over():
                self._budget_aborted_load = True
                return False, "time budget reached"
            st = svc.status()
            if st.get("modelId") == model_id and st.get("status") == "running":
                return True, ""
            if st.get("status") == "error":
                return False, st.get("error") or "load failed"
            self._sleep(_POLL_INTERVAL)
        return False, "load timed out"

    @staticmethod
    def _pick_winner(trials: list[dict]) -> dict | None:
        """1b-F5 STRICT-BEAT rule. The `baseline` trial is the model's CURRENT launch —
        a tune's explicit values, or (untuned) the engine-fit placement with no explicit
        knobs. An explicit candidate wins ONLY by beating the baseline strictly beyond
        the tie band: a tie must never overwrite the baseline, because saving a tying
        explicit value would permanently disable the engine's fit over an equal-or-
        better placement. Ties AMONG explicit candidates still resolve to the highest
        n-cpu-moe (VRAM headroom over ±10% MTP noise, live-validated 2026-07-06)."""
        ok = [t for t in trials if t["ok"]]
        if not ok:
            return None
        baseline = next((t for t in ok if t["label"] == "baseline"), None)
        explicit = [t for t in ok if t["label"] != "baseline"]
        if not explicit:
            return baseline
        top = max(t["tokensPerSec"] for t in explicit)
        tied = [t for t in explicit if t["tokensPerSec"] >= top * _TIE_BAND]
        best = max(tied, key=lambda t: (_int_of(t["switches"], "n_cpu_moe") or -1, t["tokensPerSec"]))
        if baseline is not None and not (best["tokensPerSec"] * _TIE_BAND > baseline["tokensPerSec"]):
            return baseline
        return best

    def _try(self, svc, model_id: str, label: str, switches: dict, failed_ncmoe: list[int]) -> dict:
        """One load→measure trial, pushed to the live trial list. Monotonic MoE prune:
        an n-cpu-moe below an already-failed value is recorded as skipped, never tried
        (below a failed value never fits — the slowest failure mode avoided)."""
        # QC-22 fast-path: a cancel that landed between trials must not start the
        # next one — the old path still ran svc.stop() + fired the loads (all
        # post-cancel wasted work queuing on the router lock the teardown then
        # waits behind). Return WITHOUT touching the service and WITHOUT pushing
        # a row (the sweep is ending; a phantom per-phase "cancelled" row would
        # clutter the trial list) — the caller's `cancelled()` check ends the run.
        if self._cancel:
            return {"label": label, "ok": False, "tokensPerSec": 0.0, "vramTotalMb": 0,
                    "error": "cancelled", "switches": switches}
        cand_ncmoe = _int_of(switches, "n_cpu_moe")
        if cand_ncmoe is not None and any(cand_ncmoe < f for f in failed_ncmoe):
            trial = {"label": label, "ok": False, "tokensPerSec": 0.0, "vramTotalMb": 0,
                     "error": "skipped — a higher n-cpu-moe already failed", "switches": switches}
            self._push_trial(trial)
            return trial
        self._set(detail=f"trying {label}…")
        trial = {"label": label, "ok": False, "tokensPerSec": 0.0,
                 "vramTotalMb": 0, "error": "", "switches": switches}
        try:
            svc.stop()  # clean slate per trial — deterministic VRAM
            try:
                svc.ensure_embedding()  # co-resident embed = production-true floor
            except Exception:  # noqa: BLE001 — no embed configured is fine
                pass
            svc.load(model_id, switches=switches)
            ok, err = self._wait_running(svc, model_id)
            if not ok:
                trial["error"] = err
            elif self._cancel:
                trial["error"] = "cancelled"  # loaded, but a cancel landed — skip the measure
            else:
                res = svc.measure(model_id=model_id, max_tokens=_MEASURE_TOKENS)
                if not res.get("ok"):
                    trial["error"] = res.get("error") or "measure failed"
                else:
                    trial.update(ok=True, tokensPerSec=res.get("tokensPerSec") or 0.0,
                                 vramTotalMb=res.get("vramTotalMb") or 0)
        except Exception as exc:  # noqa: BLE001 — a broken trial must not kill the sweep
            trial["error"] = str(exc)
        self._push_trial(trial)
        # Persist the measurement (#142 rows 5+6): an OK trial is a real number —
        # record it in the history as it lands. Best-effort: a history-write
        # failure must never kill (or even mark) the sweep.
        if trial["ok"] and self._record_fn is not None:
            try:
                self._record_fn(model_id, trial)
            except Exception:  # noqa: BLE001 — history is an enrichment
                log.warning("auto-tune measurement record failed", exc_info=True)
        # A CANCELLED or BUDGET-STOPPED trial is NOT a fit failure — never let it
        # poison the monotonic n-cpu-moe prune (below-a-failed-value skip); the
        # sweep is stopping anyway.
        if not trial["ok"] and cand_ncmoe is not None and not self._cancel and not self._budget_hit:
            failed_ncmoe.append(cand_ncmoe)
        return trial

    def _run(self, model_id: str, base: dict, save_fn, save: bool) -> None:
        """The 1b-F5 sweep shape: baseline (the CURRENT launch — tuned explicit values,
        or on an untuned box the engine-fit placement) → batch settle → the bounded
        n-cpu-moe WALK (probe the anchor when untried + ±2 around it, then keep stepping
        in the improving direction while decode tok/s improves, ≤ `_WALK_MAX_TRIALS`
        explicit trials) → the one spec-n alternative for MTP models. The winner comes
        from the strict-beat rule; a baseline win saves NOTHING (an untuned box keeps
        the engine's fit; a tuned box keeps its tune)."""
        svc = self._service_fn()
        gen = self._gen  # this run's generation — compared in `cancelled` (see below)
        failed_ncmoe: list[int] = []  # MoE VRAM need is monotonic: below a failed value never fits
        try:
            def budget_restore() -> None:
                # The time box aborted a trial load IN FLIGHT — the router is still
                # chewing that trial's switches. Tear down + restore the applied model
                # with its DB-resolved switches (the ROUND-9 cancel teardown) so a
                # finished quick tune never leaves a dangling trial load serving. A cap
                # that landed at a clean trial boundary skips this and leaves the last
                # trial resident, exactly like an uncapped run's normal finish.
                try:
                    svc.stop()
                except Exception:  # noqa: BLE001 — teardown is best-effort
                    log.warning("auto-tune budget stop failed", exc_info=True)
                try:
                    svc.load(model_id)
                except Exception:  # noqa: BLE001 — restore is best-effort
                    log.warning("auto-tune budget restore load failed", exc_info=True)

            def cancelled() -> bool:
                if not self._cancel:
                    return False
                # TERMINAL STATE FIRST (QC-22, 2026-07-09: "stopping the optimize pc
                # does not work"). svc.stop() serializes on the service's router lock,
                # which any in-flight trial-load thread holds through its bounded-but-
                # slow spawn/confirm legs — with a failing box (the user's "baseline —
                # failed" screenshot) several queued load threads starve the teardown
                # for what reads as forever, and the old order only wrote "cancelled"
                # AFTER it. Writing the state first unsticks the UI (the QuickSetup
                # band stops polling on any non-running status) while the teardown
                # below still runs to completion.
                self._set(status="cancelled", detail="cancelled")
                if gen != self._gen:
                    # A newer sweep already start()ed (state-first makes that legal):
                    # the service now belongs to IT — this run's teardown would knock
                    # down the new run's trial, so skip it (the new run's own per-trial
                    # svc.stop() supplies the clean slate).
                    return True
                # Free the VRAM the in-flight/last trial holds — otherwise the model
                # (+ the co-resident embed) stays resident under TRIAL switches and the
                # user's NEXT load (a fresh Quick Setup) contends on the router and
                # appears to hang (the reported "rerun … load model into vram it
                # hangs"). A cancel means "stop AND let go of the GPU", not just "stop
                # looping". Then RESTORE the applied model with its DB-resolved
                # switches (async load) — before this fix the last trial's model
                # happened to stay resident, so a plain teardown would regress the
                # skip-then-write path.
                try:
                    svc.stop()
                except Exception:  # noqa: BLE001 — teardown is best-effort
                    log.warning("auto-tune cancel: stop failed", exc_info=True)
                try:
                    svc.load(model_id)
                except Exception:  # noqa: BLE001 — restore is best-effort
                    log.warning("auto-tune cancel: restore load failed", exc_info=True)
                return True

            batch512 = {"batch_size": "512", "ubatch_size": "512"}
            self._try(svc, model_id, "baseline", _merged(base, {}), failed_ncmoe)
            if cancelled():
                return
            # Every phase below gates on the time box: once it trips, no NEW trial is
            # scheduled and the run falls through to the winner-pick with what it has.
            if not self._budget_over() and (
                _int_of(base, "batch_size") != 512 or _int_of(base, "ubatch_size") != 512
            ):
                self._try(svc, model_id, "batch 512/512", _merged(base, batch512), failed_ncmoe)
                if cancelled():
                    return

            pv = svc.preview_fit(model_id, base)
            if pv.get("ok") and pv.get("isMoe") and not self._budget_over():
                block = int(pv.get("blockCount") or 0)
                anchor = _int_of(base, "n_cpu_moe")
                anchor_untried = anchor is None  # untuned: the baseline was FIT-placed, not the anchor
                if anchor is None:
                    anchor = int(pv.get("nCpuMoe") or block)
                results: dict[int, float] = {}
                budget = _WALK_MAX_TRIALS

                def walk_try(n: int) -> bool:
                    nonlocal budget
                    if budget <= 0 or self._budget_over() or n in results or not (0 <= n <= block):
                        return False
                    budget -= 1
                    t = self._try(svc, model_id, f"n-cpu-moe {n}",
                                  _merged(base, {"n_cpu_moe": str(n), **batch512}), failed_ncmoe)
                    results[n] = t["tokensPerSec"] if t["ok"] else 0.0
                    return t["ok"]

                if anchor_untried:
                    walk_try(anchor)
                    if cancelled():
                        return
                for d in (+_WALK_STEP, -_WALK_STEP):  # direction probes
                    walk_try(anchor + d)
                    if cancelled():
                        return
                up = results.get(anchor + _WALK_STEP, 0.0)
                down = results.get(anchor - _WALK_STEP, 0.0)
                d = _WALK_STEP if up >= down else -_WALK_STEP
                cur = anchor + d
                while results.get(cur, 0.0) > 0.0:
                    prev = results.get(cur, 0.0)
                    nxt = cur + d
                    if not walk_try(nxt):
                        break
                    if cancelled():
                        return
                    if results.get(nxt, 0.0) <= prev:
                        break
                    cur = nxt

            alt = self._spec_alt(base)
            if alt is not None and not self._budget_over():
                self._try(svc, model_id, f"spec-n {alt}",
                          _merged(base, {"spec_n_max": str(alt), **batch512}), failed_ncmoe)
                if cancelled():
                    return

            best = self._pick_winner(self.status()["trials"])
            if best is None:
                # (the cap can trip before ANY trial succeeded — restore, then the
                # honest error state)
                if self._budget_aborted_load:
                    budget_restore()
                self._set(status="error", error="no trial succeeded", detail="")
                return
            saved = False
            detail = ""
            if best["label"] == "baseline":
                # Strict-beat: the current launch stands — save nothing.
                detail = "current launch is already best — nothing saved"
            elif save and save_fn is not None:
                try:
                    save_fn(model_id, best["switches"])
                    saved = True
                except Exception as exc:  # noqa: BLE001 — a save failure must not void the sweep
                    log.warning("auto-tune save failed", exc_info=True)
                    self._set(error=f"tuned OK but save failed: {exc}")
            if self._budget_hit:
                # Restore runs AFTER the save above, so a just-saved tune is already
                # in the resolution the restore load resolves with.
                if self._budget_aborted_load:
                    budget_restore()
                detail = f"time budget reached — {detail or 'kept the best result so far'}"
            self._set(status="done", detail=detail, best=best, saved=saved)
        except Exception as exc:  # noqa: BLE001 — job boundary
            log.exception("auto-tune failed")
            self._set(status="error", error=str(exc), detail="")


_tuner: AutoTuner | None = None


def get_tuner() -> AutoTuner:
    global _tuner
    if _tuner is None:
        _tuner = AutoTuner()
    return _tuner


def make_autotune_router(resolve_switches, save_tune, *,
                         record_measurement=None, tuner_fn=get_tuner) -> APIRouter:
    """The auto-tune REST surface. `resolve_switches(model_id) -> dict` and
    `save_tune(model_id, switches: dict) -> None` come from the llm layer
    (install_llm) — the runner drives loads/measures, the host owns the switch
    resolution + tune persistence (same DI seam as make_catalog_router).
    `record_measurement(model_id, trial: dict) -> None` (optional, same seam) is
    the measurement-history sink — every OK trial persists (#142 rows 5+6)."""
    r = APIRouter(tags=["llm-runner"])

    @r.post("/v1/llm-runner/auto-tune", summary="Start a measured launch-config sweep for a model")
    async def start(body: dict) -> dict:
        model_id = str((body or {}).get("modelId") or "")
        if not model_id:
            raise HTTPException(status_code=400, detail="modelId required")
        save = bool((body or {}).get("save") or False)
        # Optional time box (seconds) — the QuickSetup quick tune passes ~120; the
        # full sweep omits it. Bad input → uncapped (never a 400 for an enrichment).
        try:
            budget_seconds = float((body or {}).get("budgetSeconds") or 0)
        except (TypeError, ValueError):
            budget_seconds = 0
        base = resolve_switches(model_id) or {}
        return tuner_fn().start(model_id, base, save_fn=save_tune, save=save,
                                budget_seconds=budget_seconds,
                                record_fn=record_measurement)

    @r.get("/v1/llm-runner/auto-tune", summary="Auto-tune job status + trials + winner")
    async def status() -> dict:
        return tuner_fn().status()

    @r.post("/v1/llm-runner/auto-tune/cancel", summary="Cancel the sweep — aborts the trial in flight")
    async def cancel() -> dict:
        return tuner_fn().cancel()

    return r
