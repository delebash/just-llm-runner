# The REAL-ROUTER integration smoke (2026-07-22 pass-1 plan T8).
#
# WHY: the 650+ runner tests fake the router (`_service_for` injects router_load/
# router_models), so five integration defects (pass-1 plan §, recovery doc §8) sat
# green while the real Python↔router↔child stack broke. This module runs the REAL
# installed engine + REAL router + ONE small real model and asserts OBSERVED truth
# (the child's reported n_ctx, the router's /models, the emitted models.ini) against
# what was REQUESTED.
#
# GATING (flagged default 3, user-blessed): runs ONLY when BOTH are set —
#     JW_REALROUTER=1                  (explicit opt-in; never part of default runs)
#     JUSTWRITE_DATA_DIR=<data root>   (the app data root holding ai-cache/{hf,llamacpp})
# plus an installed engine exe, the smoke model's weights on disk, and :8080 free
# (the router's port — NEVER run while the app is up).
#
# Run:  JW_REALROUTER=1 JUSTWRITE_DATA_DIR=... python -m pytest -m realrouter -n 0 -v
# (-n 0: ONE router; xdist parallelism would race it.)
#
# Model (flagged default 4): qwen3-embedding-4b — small (2.5 GB), loads in seconds on
# any engine variant, already on disk on the dev box. Lifecycle verbs are model-agnostic.

import os
import re
import socket
import subprocess
import time
from pathlib import Path

import pytest

from llm_runner.runner.lifecycle import RunnerService
from llm_runner.runner.schema import ModelEntry

pytestmark = pytest.mark.realrouter

_DATA_DIR = os.environ.get("JUSTWRITE_DATA_DIR", "")
_ENABLED = os.environ.get("JW_REALROUTER") == "1"

EMBED_ID = "qwen3-embedding-4b"
EMBED_REPO = "Qwen/Qwen3-Embedding-4B-GGUF"
EMBED_QUANT = "Q4_K_M"

# Emit-only rows for the MTP-rule case (never loaded; sections emit for on-disk models).
BONSAI = dict(id="ternary-bonsai-27b-q2-g64", hf_repo="prism-ml/Ternary-Bonsai-27B-gguf",
              quant="Q2_g64")
GEMMA = dict(id="gemma-4-26b-a4b-qat", hf_repo="unsloth/gemma-4-26B-A4B-it-qat-GGUF",
             quant="UD-Q4_K_XL", mtp_draft_file="MTP/mtp-gemma-4-26B-A4B-it-Q4_0.gguf")


def _cache_root() -> Path:
    return Path(_DATA_DIR) / "ai-cache"


def _find_engine_exe() -> Path | None:
    """The installed llama-server exe — any build/variant dir (the smoke tests the
    ROUTER lifecycle, not binary selection, so resolution is explicit + simple)."""
    base = _cache_root() / "llamacpp"
    if not base.is_dir():
        return None
    for exe in sorted(base.glob("*/*/llama-server.exe")) + sorted(base.glob("*/llama-server.exe")):
        return exe
    return None


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _snapshot_gguf(repo: str, name_fragment: str) -> Path | None:
    d = _cache_root() / "hf" / ("models--" + repo.replace("/", "--")) / "snapshots"
    if not d.is_dir():
        return None
    for f in d.rglob("*.gguf"):
        if name_fragment.lower() in f.name.lower() and "mtp" not in f.name.lower():
            return f
    return None


def _entry(**kw) -> ModelEntry:
    base = dict(name=kw.get("id", "m"), tier="mid")
    base.update(kw)
    return ModelEntry(**base)


_skip = None
if not _ENABLED:
    _skip = "JW_REALROUTER != 1 (explicit opt-in required)"
elif not _DATA_DIR or not _cache_root().is_dir():
    _skip = "JUSTWRITE_DATA_DIR unset or has no ai-cache/"
elif _find_engine_exe() is None:
    _skip = "no installed llama-server engine under ai-cache/llamacpp"
elif _snapshot_gguf(EMBED_REPO, EMBED_QUANT) is None:
    _skip = f"smoke model {EMBED_ID} not on disk"
elif not _port_free(8080):
    _skip = "port 8080 busy — never run the smoke beside a live router/app"
if _skip:
    pytestmark = [pytest.mark.realrouter, pytest.mark.skip(reason=_skip)]


@pytest.fixture()
def svc():
    exe = _find_engine_exe()
    catalog = [
        _entry(id=EMBED_ID, hf_repo=EMBED_REPO, quant=EMBED_QUANT, embedding=True,
               pooling="last"),
        _entry(**BONSAI),
        _entry(**GEMMA),
    ]

    def _no_download(*a, **k):
        raise AssertionError("the smoke must never download — every case uses on-disk weights")

    service = RunnerService(
        _cache_root(),
        catalog_fn=lambda: catalog,
        acquire_binary=lambda *a, **k: exe,
        acquired_exe=lambda *a, **k: exe,
        acquire_model=_no_download,
        switches_fn=lambda mid: {},
        embedding_ids_fn=lambda: {EMBED_ID},
    )
    try:
        yield service
    finally:
        service.stop()  # full teardown — kill the router + children
        time.sleep(1.0)


def _wait(pred, timeout_s: float, interval: float = 0.5):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(interval)
    return pred()


def _resident_row(service, mid):
    return next((m for m in service.resident().get("models", []) if m["id"] == mid), None)


def _loaded(service, mid):
    row = _resident_row(service, mid) or {}
    return row.get("status") in ("loaded", "sleeping")


def _ini_text(service) -> str:
    return (_cache_root() / "llamacpp" / "models.ini").read_text(encoding="utf-8")


def _section(ini: str, model_id: str) -> str:
    assert f"[{model_id}]" in ini, f"no [{model_id}] section:\n{ini}"
    return ini.split(f"[{model_id}]")[1].split("\n[")[0]


def test_load_applies_ephemeral_ctx_and_coload_emit_preserves_it(svc):
    # Case 1 (ephemeral ctx observed on the REAL child) + case 2 (defect C: a later
    # no-override emit — the exact mechanism that reverted qwen 8192→131072 — must
    # keep the loaded-with section, and the unchanged text must NOT bounce the child).
    svc.load(EMBED_ID, switches={"ctx_len": "4096"})
    assert _wait(lambda: _loaded(svc, EMBED_ID), 120), svc.status()
    row = _resident_row(svc, EMBED_ID)
    assert row["n_ctx"] == 4096, row                       # the CHILD's own truth
    assert "ctx-size = 4096" in _section(_ini_text(svc), EMBED_ID)

    with svc._router_lock:                                  # the documented second emit
        svc._emit_ini(override=None)
    assert "ctx-size = 4096" in _section(_ini_text(svc), EMBED_ID)
    row = _resident_row(svc, EMBED_ID)
    assert row is not None and row["n_ctx"] == 4096         # no bounce, child untouched


def test_switch_change_reflected_on_reload(svc):
    # Case 6: a Lab-style re-load with a DIFFERENT ephemeral ctx is a real re-load
    # and the child reports the new value.
    svc.load(EMBED_ID, switches={"ctx_len": "4096"})
    assert _wait(lambda: _loaded(svc, EMBED_ID), 120), svc.status()
    svc.load(EMBED_ID, switches={"ctx_len": "2048"})
    assert _wait(lambda: (_resident_row(svc, EMBED_ID) or {}).get("n_ctx") == 2048, 120), \
        _resident_row(svc, EMBED_ID)


def test_double_load_is_idempotent(svc):
    # Case 5 (defect E): a second plain load of a resident model neither errors nor
    # spawns a second child.
    svc.load(EMBED_ID)
    assert _wait(lambda: _loaded(svc, EMBED_ID), 120), svc.status()
    svc.load(EMBED_ID)
    time.sleep(2.0)
    rows = [m for m in svc.resident()["models"] if m["id"] == EMBED_ID]
    assert len(rows) == 1 and rows[0]["status"] in ("loaded", "sleeping")
    assert not (svc._resident.get(EMBED_ID) or {}).get("error")


def test_stop_stays_stopped(svc):
    # Case 3 (defect D): an explicit stop sticks — 45 s with no reappearance, and a
    # zombie-style ensure inside the tombstone window REFUSES.
    svc.load(EMBED_ID)
    assert _wait(lambda: _loaded(svc, EMBED_ID), 120), svc.status()
    svc.stop(EMBED_ID)
    with pytest.raises(RuntimeError, match="just stopped"):
        svc.ensure_model_ready(EMBED_ID, timeout_s=5.0)
    assert not _wait(lambda: _loaded(svc, EMBED_ID), 45), "the model came BACK after stop"


def test_unknown_model_fails_fast_and_visibly(svc):
    # Case 4 (defects A/B): the bonsai incident — an unknown id must surface as a
    # visible error within seconds, never a silent 30-minute wait.
    t0 = time.monotonic()
    svc.load("no-such-model")
    assert _wait(lambda: (svc.status().get("status") == "error"
                          and "unknown model" in (svc.status().get("error") or "")), 10), \
        svc.status()
    assert time.monotonic() - t0 < 10


def test_mtp_emit_rule(svc):
    # Case 7 (the user's MTP rule): bonsai (mtp off, no draft fields) emits NO spec
    # lines; gemma (own downloaded draft) emits a model-draft path that EXISTS.
    svc.load(EMBED_ID)  # any load emits the full ini (sections for on-disk models)
    assert _wait(lambda: _loaded(svc, EMBED_ID), 120), svc.status()
    ini = _ini_text(svc)
    if f"[{BONSAI['id']}]" in ini:
        b = _section(ini, BONSAI["id"])
        assert "model-draft" not in b and "spec-type" not in b, b
    else:
        pytest.skip("bonsai weights not on disk — no section to assert on")
    if f"[{GEMMA['id']}]" in ini:
        g = _section(ini, GEMMA["id"])
        m = re.search(r"model-draft = (.+)", g)
        if m:
            assert Path(m.group(1).strip()).exists(), "emitted a model-draft that is not on disk"


def test_mlock_parity_router_vs_standalone(svc):
    # Case 8 (defect G — RESOLVED by the T7 bisection, 2026-07-22): --mlock through
    # the ROUTER locks exactly as it does standalone. The incident's 998s were never
    # the router/spawn context — they are the --mlock + --no-mmap COMBINATION (an
    # upstream llama.cpp allocation-shape bug; see the xfail case below). The
    # originally-planned xfail (flagged default 2) is removed because parity
    # genuinely holds.
    exe = _find_engine_exe()
    gguf = _snapshot_gguf(EMBED_REPO, EMBED_QUANT)
    proc = subprocess.Popen(
        [str(exe), "-m", str(gguf), "--mlock", "-c", "512", "--port", "8091",
         "--host", "127.0.0.1"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
        errors="replace",
    )
    try:
        out = []
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if line:
                out.append(line)
            if "model loaded" in line or "listening on" in line:
                break
        standalone_ok = not any("VirtualLock" in line for line in out)
    finally:
        proc.kill()
    assert standalone_ok, "standalone --mlock failed to lock — box regression"

    svc.load(EMBED_ID, switches={"mlock": "true"})
    assert _wait(lambda: _loaded(svc, EMBED_ID), 120), svc.status()
    log_path = getattr(svc, "_last_log_path", None)
    assert log_path and Path(log_path).exists(), "no router log to check"
    router_log = Path(log_path).read_text(encoding="utf-8", errors="replace")
    assert "failed to VirtualLock" not in router_log, \
        "router child failed VirtualLock while standalone locked fine (defect G)"


def test_mlock_no_mmap_pair_is_stripped_on_windows(svc):
    # Defect G's ACTUAL breakage, isolated (T7 bisection) + THE (b) FIX (user decision
    # 2026-07-22, no upstream report): --mlock beside --no-mmap can never lock on
    # Windows (standalone A/B: mlock alone = locks; the pair = VirtualLock 998 —
    # llama.cpp's no-mmap buffer isn't lockable). The strip rule
    # (`_strip_inert_mlock`) removes mlock from the pair at the merge, so the child
    # neither attempts nor warns, and the emitted section is truthful.
    if os.name != "nt":
        pytest.skip("the strip rule is Windows-only")
    svc.load(EMBED_ID, switches={"mlock": "true", "no_mmap": "true"})
    assert _wait(lambda: _loaded(svc, EMBED_ID), 120), svc.status()
    section = _section(_ini_text(svc), EMBED_ID)
    assert "no-mmap = true" in section
    assert "mlock = " not in section, section               # stripped from the pair
    log_path = getattr(svc, "_last_log_path", None)
    assert log_path and Path(log_path).exists(), "no router log to check"
    router_log = Path(log_path).read_text(encoding="utf-8", errors="replace")
    assert "failed to VirtualLock" not in router_log
