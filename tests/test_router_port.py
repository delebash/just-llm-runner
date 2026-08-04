# SPDX-License-Identifier: MIT
"""The router port is ALLOCATED, and the local adapter FOLLOWS it (2026-08-03).

The incident these are written against: every family app spawned its llama-server
router on the same hardcoded :8080. On a box running two of them the second app's
child could not bind — and the spawn's `/health` probe passed anyway, because that
port was answered by the FIRST app's router. JustWrite's `POST /models/load
'gemma-4-26b-a4b-qat'` reached just_ai_i18n_docgen's engine, which knows that model
under a different id, and answered 404 in 31 ms. It reads exactly like a corrupt
install; it was a shared constant.

Two halves, both needed: the spawn takes a port nobody holds (health-by-port is not
identity), and the `local-llamacpp` adapter asks the live service where to send a
request instead of trusting the port seeded on its provider row.
"""

import socket
from types import SimpleNamespace

import pytest

from llm_runner.llm import dispatch
from llm_runner.llm.openai_compat import OpenAICompatAdapter
from llm_runner.runner.lifecycle import RunnerService
from llm_runner.runner.process import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    NoFreePortError,
    _port_is_free,
    find_free_port,
)


# ── allocation ───────────────────────────────────────────────────────────────

def test_prefers_the_preferred_port_when_it_is_free():
    # A box running ONE app must keep behaving exactly as before — :8080, no scan.
    assert find_free_port(DEFAULT_HOST, DEFAULT_PORT, _is_free=lambda h, p: True) == DEFAULT_PORT


def test_skips_ports_that_are_taken():
    taken = {8080, 8081}
    assert find_free_port("127.0.0.1", 8080, _is_free=lambda h, p: p not in taken) == 8082


def test_raises_when_the_whole_range_is_held():
    with pytest.raises(NoFreePortError) as e:
        find_free_port("127.0.0.1", 8080, span=4, _is_free=lambda h, p: False)
    assert "8080-8083" in str(e.value)


def test_a_really_held_port_reads_as_taken():
    """The bind-probe against a REAL socket — the fake above only proves the loop.
    A connect-probe would answer 'is anyone listening', which is a different (and
    wrong) question: a bound-but-not-listening socket still blocks llama-server."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    try:
        assert _port_is_free("127.0.0.1", port) is False
        assert find_free_port("127.0.0.1", port, span=8) > port
    finally:
        s.close()


def test_spawn_uses_the_allocated_port_not_the_constant(tmp_path):
    """The bite: with the port hardcoded at the spawn site this fails with 8080."""
    seen = {}

    def capture(exe, **kw):
        seen.update(kw)
        return SimpleNamespace(url=f"http://{kw['host']}:{kw['port']}",
                               is_alive=lambda: True, stop=lambda: None)

    svc = RunnerService(tmp_path, start_router=capture, find_port=lambda h, p: 8137)
    svc._spawn_router(tmp_path / "llama-server.exe", svc._config_fn())

    assert seen["port"] == 8137
    assert svc.router_url() == "http://127.0.0.1:8137"


def test_router_url_is_empty_while_nothing_is_running(tmp_path):
    # "" is what makes the adapter refuse to guess — it must never be a stale URL.
    svc = RunnerService(tmp_path)
    assert svc.router_url() == ""

    svc._router = SimpleNamespace(url="http://127.0.0.1:8137",
                                  is_alive=lambda: False, stop=lambda: None)
    assert svc.router_url() == ""


# ── the adapter follows it ───────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clear_seam():
    yield
    dispatch.set_local_runner_base_url(None)


def _adapter(provider_type="local-llamacpp", base_url=""):
    return OpenAICompatAdapter("p", provider_type=provider_type, api_key="",
                               base_url=base_url)


def test_local_adapter_targets_the_live_router():
    dispatch.set_local_runner_base_url(lambda: "http://127.0.0.1:8137")
    # The provider row still carries the seeded :8080 — and is overruled by the
    # running engine, which is the entire point.
    a = _adapter(base_url="http://127.0.0.1:8080/v1")
    assert a._api_base == "http://127.0.0.1:8137/v1"


def test_local_adapter_refuses_to_guess_when_the_engine_is_down():
    """Falling back to the configured port is the ORIGINAL defect: :8080 may well
    answer — as somebody else's engine — so a down router must fail loudly."""
    dispatch.set_local_runner_base_url(lambda: "")
    a = _adapter(base_url="http://127.0.0.1:8080/v1")
    with pytest.raises(RuntimeError) as e:
        _ = a._api_base
    assert "isn't running" in str(e.value)


def test_local_adapter_keeps_its_configured_url_with_no_runner_wired():
    # Standalone host / adapter unit tests: nothing changes off the runner path.
    a = _adapter(base_url="http://127.0.0.1:9999/v1")
    assert a._api_base == "http://127.0.0.1:9999/v1"


def test_a_user_endpoint_is_never_hijacked():
    """`openai-compat` is a URL the USER chose (LM Studio, vLLM, a self-hosted box).
    The seam resolves the BUNDLED runner only."""
    dispatch.set_local_runner_base_url(lambda: "http://127.0.0.1:8137")
    a = _adapter(provider_type="openai-compat", base_url="http://192.168.1.5:1234/v1")
    assert a._api_base == "http://192.168.1.5:1234/v1"
