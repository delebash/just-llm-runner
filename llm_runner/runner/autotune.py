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
back-offs simply measures slower and loses), sweep threads/spec (measured flat
on the reference box), or auto-save (the caller decides: the Tune modal fills
the grid for review; QuickSetup passes save=True).

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
        self._state: dict = {"status": "idle", "modelId": "", "detail": "", "error": "",
                             "trials": [], "best": None, "saved": False}

    # ── public surface (endpoint-shaped) ─────────────────────────────────────

    def status(self) -> dict:
        with self._lock:
            return {**self._state, "trials": list(self._state["trials"])}

    def cancel(self) -> dict:
        with self._lock:
            if self._state["status"] == "running":
                self._cancel = True
                self._state["detail"] = "cancelling after the current trial…"
        return self.status()

    def start(self, model_id: str, base_switches: dict, *, save_fn=None, save: bool = False) -> dict:
        with self._lock:
            if self._state["status"] == "running":
                return {**self._state, "ok": False, "error": "an auto-tune is already running"}
            self._cancel = False
            self._state = {"status": "running", "modelId": model_id, "detail": "starting…",
                           "error": "", "trials": [], "best": None, "saved": False}
            self._thread = threading.Thread(
                target=self._run, args=(model_id, dict(base_switches or {}), save_fn, save),
                daemon=True,
            )
            self._thread.start()
        return self.status()

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
        if not trial["ok"] and cand_ncmoe is not None:
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
        failed_ncmoe: list[int] = []  # MoE VRAM need is monotonic: below a failed value never fits
        try:
            def cancelled() -> bool:
                if self._cancel:
                    self._set(status="cancelled", detail="cancelled")
                    return True
                return False

            batch512 = {"batch_size": "512", "ubatch_size": "512"}
            self._try(svc, model_id, "baseline", _merged(base, {}), failed_ncmoe)
            if cancelled():
                return
            if _int_of(base, "batch_size") != 512 or _int_of(base, "ubatch_size") != 512:
                self._try(svc, model_id, "batch 512/512", _merged(base, batch512), failed_ncmoe)
                if cancelled():
                    return

            pv = svc.preview_fit(model_id, base)
            if pv.get("ok") and pv.get("isMoe"):
                block = int(pv.get("blockCount") or 0)
                anchor = _int_of(base, "n_cpu_moe")
                anchor_untried = anchor is None  # untuned: the baseline was FIT-placed, not the anchor
                if anchor is None:
                    anchor = int(pv.get("nCpuMoe") or block)
                results: dict[int, float] = {}
                budget = _WALK_MAX_TRIALS

                def walk_try(n: int) -> bool:
                    nonlocal budget
                    if budget <= 0 or n in results or not (0 <= n <= block):
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
            if alt is not None:
                self._try(svc, model_id, f"spec-n {alt}",
                          _merged(base, {"spec_n_max": str(alt), **batch512}), failed_ncmoe)
                if cancelled():
                    return

            best = self._pick_winner(self.status()["trials"])
            if best is None:
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


def make_autotune_router(resolve_switches, save_tune, *, tuner_fn=get_tuner) -> APIRouter:
    """The auto-tune REST surface. `resolve_switches(model_id) -> dict` and
    `save_tune(model_id, switches: dict) -> None` come from the llm layer
    (install_llm) — the runner drives loads/measures, the host owns the switch
    resolution + tune persistence (same DI seam as make_catalog_router)."""
    r = APIRouter(tags=["llm-runner"])

    @r.post("/v1/llm-runner/auto-tune", summary="Start a measured launch-config sweep for a model")
    async def start(body: dict) -> dict:
        model_id = str((body or {}).get("modelId") or "")
        if not model_id:
            raise HTTPException(status_code=400, detail="modelId required")
        save = bool((body or {}).get("save") or False)
        base = resolve_switches(model_id) or {}
        return tuner_fn().start(model_id, base, save_fn=save_tune, save=save)

    @r.get("/v1/llm-runner/auto-tune", summary="Auto-tune job status + trials + winner")
    async def status() -> dict:
        return tuner_fn().status()

    @r.post("/v1/llm-runner/auto-tune/cancel", summary="Cancel after the current trial")
    async def cancel() -> dict:
        return tuner_fn().cancel()

    return r
