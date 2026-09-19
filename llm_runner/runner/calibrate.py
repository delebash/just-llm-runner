# SPDX-License-Identifier: MIT
"""The one-minute speed check — llama.cpp measures how fast THIS box streams
MoE expert bytes, so predictions stop resting on a memcpy probe × a factor.

Design + evidence: docs/plans/2026-09-19-speed-truth-and-calibrated-pick.md
§6 (the mechanism), §11.4 (the spike that proved it: 27.5 GB/s on the author's
box predicted the flagship's measured un-sped speed within 5 % — 25.3 vs 26.6
tok/s — where probe × 0.40 said 8.4).

WHAT it does: downloads one small MoE GGUF from the kit's own GitHub release
(sha-pinned; the runner_setting `calib_*` rows name it), then launches the
installed llama-server on it twice — everything on the GPU (pass A), then the
routed experts forced into system RAM (pass B). Per token, pass A costs
overhead + GPU bytes; pass B costs the same plus the expert bytes read from RAM;
so `t_B − t_A` isolates the expert stream and cancels the fixed overhead that
dominates a model this small (plan §6 "why the delta"). host GB/s = the file's
active-expert MB per token / that delta. A GPU-less box runs one pass and
prices every byte from RAM. The result persists as the `__machine_moe_bw__`
pseudo-row (build-stamped label) — the ladder rung between real-model
derivation and the memcpy probe (`bandwidth.resolve_effective_bw`).

WHAT it does NOT do: run on its own (Quick setup offers it, the user clicks),
run on one-pool machines (Metal / unified / integrated — there is no second
pool to measure), or feed per-model history (a pseudo-model id never matches a
catalog row).

Timing comes from llama.cpp's own response `timings` (predicted_ms /
predicted_n), never wall clock: an antivirus scan of a freshly downloaded file
lands in wall time and nowhere else. Every child goes through the ONE spawn
seam (`process._spawn_child` — the Windows kill-on-close Job Object).
"""

from __future__ import annotations

import hashlib
import logging
import statistics
import subprocess
import threading
import time
from pathlib import Path

import requests
from fastapi import APIRouter

from .bandwidth import MOE_PROBE_MODEL_ID, moe_probe_label
from .download import DownloadCancelled, download_kwargs, stream_download
from .hardware import detect, machine_key, mem_arch
from .lifecycle import get_service
from .process import DEFAULT_HOST, _close_job, _default_health, _spawn_child, find_free_port

log = logging.getLogger(__name__)

# Method constants (the autotune.py precedent — how the measurement is taken,
# not operator tunables). Validated on the author's box 2026-09-19: 3 × 160
# tokens after one warm-up held a 3.5 % / 6.1 % spread (plan §11.4).
_RUNS = 3
_TOKENS = 160
_CTX = 2048
_PROMPT = "Write a long, detailed story about a lighthouse keeper."
_HEALTH_TIMEOUT = 120.0   # a 0.8 GB model loads in ~3 s; this is for a slow disk + AV scan
_REQUEST_TIMEOUT = 120.0
_ENGINE_WAIT = 900.0      # Quick setup may still be installing the engine in parallel
_MIN_DELTA_FRAC = 0.2     # t_B − t_A must be ≥ 20 % of t_B, else the reading is noise
_MAX_SPREAD = 0.15        # any run > 15 % from its pass median → no stable reading


def check_mode(hardware) -> tuple[str, str]:
    """("two-pass" | "one-pass" | "", reason). The same one-pool condition as
    the speed model (`api.py` `_speed`): an integrated/unified box with a GPU —
    or any Mac — has ONE memory pool, so there is no split to measure."""
    arch = mem_arch(hardware)
    one_pool = arch in ("integrated", "unified") and (bool(hardware.gpus) or hardware.platform == "macos")
    if one_pool:
        return "", "this machine's graphics share system memory — there is no second memory pool to measure"
    if not hardware.gpus:
        return "one-pass", ""
    return "two-pass", ""


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


class Cancelled(Exception):
    pass


class Calibrator:
    """One process-wide speed-check job (the AutoTuner shape: background thread
    + a state dict the GET endpoint returns verbatim). `service_fn` /
    `hardware_fn` / `popen` / `http_post` / `sleep` are injection points so the
    job tests offline."""

    def __init__(self, service_fn=get_service, *, hardware_fn=detect, popen=subprocess.Popen,
                 http_post=None, health=_default_health, sleep=time.sleep, now=time.monotonic):
        self._service_fn = service_fn
        self._hardware_fn = hardware_fn
        self._popen = popen
        self._http_post = http_post or (lambda url, body: requests.post(
            url, json=body, timeout=_REQUEST_TIMEOUT).json())
        self._health = health
        self._sleep = sleep
        self._now = now
        self._lock = threading.Lock()
        self._cancel = False
        self._thread: threading.Thread | None = None
        self._state: dict = self._fresh("idle")

    @staticmethod
    def _fresh(status: str) -> dict:
        return {"status": status, "phase": "", "detail": "", "error": "",
                "done": 0, "total": 0, "gbps": None, "passes": {}}

    # ── public surface (endpoint-shaped) ─────────────────────────────────────

    def status(self) -> dict:
        with self._lock:
            return {**self._state, "passes": dict(self._state["passes"])}

    def cancel(self) -> dict:
        with self._lock:
            if self._state["status"] == "running":
                self._cancel = True
                self._state["detail"] = "stopping…"
        return self.status()

    def start(self) -> dict:
        with self._lock:
            if self._state["status"] == "running":
                return {**self._state, "ok": False, "error": "a speed check is already running"}
            self._cancel = False
            self._state = {**self._fresh("running"), "detail": "starting…"}
            self._thread = threading.Thread(target=self._run, name="llm-runner-speed-check", daemon=True)
            self._thread.start()
        return self.status()

    # ── the job ───────────────────────────────────────────────────────────────

    def _set(self, **kw) -> None:
        with self._lock:
            self._state.update(kw)

    def _check_cancel(self) -> None:
        if self._cancel:
            raise Cancelled()

    def _run(self) -> None:
        try:
            self._run_inner()
        except Cancelled:
            self._set(status="cancelled", phase="", detail="")
        except Exception as exc:  # noqa: BLE001 — job boundary
            log.exception("speed check failed")
            self._set(status="error", phase="", detail="", error=str(exc))

    def _run_inner(self) -> None:
        svc = self._service_fn()
        cfg = svc.config()
        hardware = self._hardware_fn()
        mode, reason = check_mode(hardware)
        if not mode:
            raise RuntimeError(f"The speed check doesn't apply here: {reason}.")
        url, sha = (cfg.calib_model_url or "").strip(), (cfg.calib_model_sha256 or "").strip().lower()
        if not url or len(sha) != 64:
            raise RuntimeError("No speed-check model is configured (Engine binaries → Speed-check model).")
        active_mb = float(cfg.calib_active_expert_mb or 0)
        nonexpert_mb = float(cfg.calib_nonexpert_mb or 0)
        if active_mb <= 0:
            raise RuntimeError("The speed-check model's expert size is not set (Engine binaries → Speed-check model).")

        model = self._ensure_model(svc, cfg, url, sha)
        exe = self._wait_for_engine(svc)
        build = svc.installed_build() or ""
        # A clean GPU — the autotune precedent (svc.stop() before each trial):
        # a resident model would share the card and the passes would measure it.
        svc.stop()
        self._check_cancel()

        passes: dict = {}
        if mode == "two-pass":
            self._set(phase="pass-a", detail="Measuring with everything on the graphics card…")
            passes["a"] = self._pass(svc, exe, model, ["-ngl", "99"], "a")
            self._set(passes=dict(passes), phase="pass-b",
                      detail="Measuring with the model's experts in system memory…")
            passes["b"] = self._pass(svc, exe, model, ["-ngl", "99", "--n-cpu-moe", "999"], "b")
            t_a, t_b = passes["a"]["medianMs"], passes["b"]["medianMs"]
            delta = t_b - t_a
            if delta < _MIN_DELTA_FRAC * t_b:
                raise RuntimeError(
                    f"The two measurements were too close to tell apart ({t_a:.2f} vs {t_b:.2f} ms "
                    "per token) — estimates stay in use.")
            gbps = active_mb / delta  # MB per ms ≡ GB per s
        else:
            self._set(phase="pass-a", detail="Measuring on the processor…")
            passes["a"] = self._pass(svc, exe, model, ["-ngl", "0"], "a")
            gbps = (active_mb + nonexpert_mb) / passes["a"]["medianMs"]

        mkey = machine_key(hardware)
        if not svc.record_machine_probe(gbps, mkey, MOE_PROBE_MODEL_ID, moe_probe_label(build)):
            raise RuntimeError("The speed check measured this machine but has nowhere to save it.")
        log.info("speed check: %.2f GB/s host expert stream (%s, build %s) — passes %s",
                 gbps, mode, build, passes)
        self._set(status="done", phase="", detail="", gbps=round(gbps, 2), passes=dict(passes))

    def _ensure_model(self, svc, cfg, url: str, sha: str) -> Path:
        dest = Path(svc.cache_root) / "calib" / f"{sha}.gguf"
        if dest.exists() and sha256_of(dest) == sha:
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        size = int(cfg.calib_model_size_bytes or 0)
        self._set(phase="download", detail="Downloading the test model…", done=0, total=size)

        def _progress(done: int, total: int | None) -> None:
            self._set(done=int(done), total=int(total or size))

        try:
            stream_download(url, dest, on_progress=_progress, cancel_check=lambda: self._cancel,
                            **download_kwargs(cfg))
        except DownloadCancelled:
            raise Cancelled() from None
        self._set(detail="Checking the download…")
        got = sha256_of(dest)
        if got != sha:
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"The test model didn't match its checksum (got {got[:12]}…) — "
                               "it was deleted; run the check again.")
        return dest

    def _wait_for_engine(self, svc) -> Path:
        exe = svc.installed_exe()
        if exe is not None:
            return exe
        self._set(phase="engine", detail="Waiting for the engine to finish installing…")
        deadline = self._now() + _ENGINE_WAIT
        while self._now() < deadline:
            self._check_cancel()
            self._sleep(1.0)
            exe = svc.installed_exe()
            if exe is not None:
                return exe
        raise RuntimeError("The engine isn't installed — install it, then run the check again.")

    def _pass(self, svc, exe: Path, model: Path, flags: list[str], name: str) -> dict:
        port = find_free_port(DEFAULT_HOST)
        base = f"http://{DEFAULT_HOST}:{port}"
        argv = [str(exe), "-m", str(model), "--host", DEFAULT_HOST, "--port", str(port),
                "-c", str(_CTX), *flags]
        log_path = Path(svc.runtime_root) / "logs" / f"speed-check-pass-{name}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "w", encoding="utf-8") as logf:
            proc, job = _spawn_child(self._popen, argv, logf)
            try:
                deadline = self._now() + _HEALTH_TIMEOUT
                while not self._health(base):
                    self._check_cancel()
                    if proc.poll() is not None:
                        raise RuntimeError(f"The engine stopped while loading the test model — see {log_path}.")
                    if self._now() > deadline:
                        raise RuntimeError("The engine took too long to load the test model.")
                    self._sleep(0.3)
                body = {"messages": [{"role": "user", "content": _PROMPT}], "max_tokens": _TOKENS,
                        "stream": False, "temperature": 0.7, "ignore_eos": True}
                self._http_post(base + "/v1/chat/completions", body)  # warm-up, discarded
                per_tok: list[float] = []
                for _ in range(_RUNS):
                    self._check_cancel()
                    t = (self._http_post(base + "/v1/chat/completions", body) or {}).get("timings") or {}
                    n, ms = int(t.get("predicted_n") or 0), float(t.get("predicted_ms") or 0.0)
                    if n <= 0 or ms <= 0:
                        raise RuntimeError("The engine returned no timing data — this engine build "
                                           "can't run the speed check.")
                    per_tok.append(ms / n)
            finally:
                try:
                    proc.terminate()
                    proc.wait(timeout=15)
                except Exception:  # noqa: BLE001 — _close_job below is the guarantee
                    pass
                _close_job(job)
        median = statistics.median(per_tok)
        spread = max(abs(x - median) / median for x in per_tok)
        if spread > _MAX_SPREAD:
            raise RuntimeError(f"The readings varied too much ({spread * 100:.0f} %) to trust — "
                               "close other heavy programs and run the check again.")
        return {"medianMs": round(median, 3), "perTokenMs": [round(x, 3) for x in per_tok],
                "spread": round(spread, 3)}


_calibrator: Calibrator | None = None


def get_calibrator() -> Calibrator:
    global _calibrator
    if _calibrator is None:
        _calibrator = Calibrator()
    return _calibrator


def make_calibrate_router(*, calibrator_fn=get_calibrator, service_fn=get_service,
                          hardware_fn=detect) -> APIRouter:
    """The speed-check REST surface — start / status / cancel (the auto-tune
    shape). GET also answers what Quick setup needs to decide whether to OFFER
    the check: does it apply to this machine, is a test model configured, and
    has this machine already been measured on the engine build on disk."""
    r = APIRouter(tags=["llm-runner"])

    @r.post("/v1/llm-runner/calibrate", summary="Start the one-minute speed check")
    async def start() -> dict:
        return calibrator_fn().start()

    @r.get("/v1/llm-runner/calibrate", summary="Speed check: status, and whether it applies here")
    async def status() -> dict:
        st = calibrator_fn().status()
        svc = service_fn()
        cfg = svc.config()
        hardware = hardware_fn()
        mode, reason = check_mode(hardware)
        measured = svc.host_moe_bw_gbps(machine_key(hardware))
        return {**st, "mode": mode, "reason": reason,
                "configured": bool((cfg.calib_model_url or "").strip() and cfg.calib_model_sha256),
                "sizeBytes": int(cfg.calib_model_size_bytes or 0),
                "measuredGbps": measured}

    @r.post("/v1/llm-runner/calibrate/cancel", summary="Cancel the speed check")
    async def cancel() -> dict:
        return calibrator_fn().cancel()

    return r
