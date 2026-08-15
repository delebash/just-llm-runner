# SPDX-License-Identifier: MIT
"""The "Other apps" breakdown — who is holding GPU memory.

Every probe is monkeypatched with REAL captured output, so this runs on a box
with no GPU. The samples below were taken from an RTX 2070 SUPER on Windows
2026-08-15 and are trimmed, not invented — the parsers are the whole risk here
(typeperf emits a wide quoted-CSV header plus trailing prose, and the pid lives
inside a counter instance name).

The property these tests exist to defend is the counter CHOICE. Windows offers
`Dedicated Usage` and `Local Usage` per process, and the obvious one is wrong:
measured against a deliberate 2.0 GB allocation, both named that process at
2,139 MB, but `Dedicated Usage` summed to 9,325 MB on a card holding 2,851 MB
(it charges a shared surface to every process referencing it, so `dwm.exe`
alone read 6,671 MB) while `Local Usage` summed to 2,567 MB. A future edit
that "simplifies" this back to the sibling counter used by the single-pid
probe would produce a list that adds up to more than the hardware.
"""

from __future__ import annotations

import pytest

from llm_runner.runner import hardware as hw


# Two adapters (two luids), one pid appearing on both, trailing typeperf prose.
TYPEPERF_SAMPLE = (
    '"(PDH-CSV 4.0)"'
    ',"\\\\PC\\GPU Process Memory(pid_1792_luid_0x00000000_0x0000F0A6_phys_0)\\Local Usage"'
    ',"\\\\PC\\GPU Process Memory(pid_1792_luid_0x00000000_0x0001060A_phys_0)\\Local Usage"'
    ',"\\\\PC\\GPU Process Memory(pid_17028_luid_0x00000000_0x0000F0A6_phys_0)\\Local Usage"'
    ',"\\\\PC\\GPU Process Memory(pid_4_luid_0x00000000_0x0000F0A6_phys_0)\\Local Usage"\n'
    '"08/15/2026 04:54:45.227","6971219968.000000","1048576.000000","6796083200.000000","0.000000"\n'
    "\n"
    "Exiting, please wait...                         \n"
    "The command completed successfully.\n"
)

NVIDIA_SAMPLE = "1792, 512\n17028, 6481\n"
# What an NVIDIA card under Windows-WDDM actually prints: process rows, no numbers.
NVIDIA_WDDM_SAMPLE = "1792, [N/A]\n8124, [N/A]\n"


class _Ran:
    def __init__(self, stdout: str) -> None:
        self.stdout = stdout


def _windows(monkeypatch, *, typeperf_out: str, argv_sink: list | None = None) -> None:
    monkeypatch.setattr(hw, "platform_key", lambda: "windows")
    monkeypatch.setattr(hw.shutil, "which", lambda c: f"/x/{c}")

    def _run(argv, *a, **k):
        if argv_sink is not None:
            argv_sink.append(list(argv))
        return _Ran(typeperf_out)

    monkeypatch.setattr(hw.subprocess, "run", _run)


def test_windows_arm_reads_local_usage_not_dedicated(monkeypatch):
    """THE regression guard. `Dedicated Usage` names an individual process
    correctly but charges shared surfaces to every referencing process, so the
    column sums past the card (9,325 MB measured on a card holding 2,851 MB).
    `Local Usage` gave the identical figure for the real consumer and a
    coherent 2,567 MB total. Do not "unify" this with the single-pid probe."""
    seen: list[list[str]] = []
    _windows(monkeypatch, typeperf_out=TYPEPERF_SAMPLE, argv_sink=seen)
    hw._windows_gpu_process_rows()
    counter = next(a for a in seen[0] if "GPU Process Memory" in a)
    assert counter.endswith(r"\Local Usage"), counter
    assert "Dedicated" not in counter


# ── The Windows counter arm ───────────────────────────────────────────────


def test_windows_rows_sum_per_pid_across_adapters(monkeypatch):
    """A pid appears once per adapter; the reduction must match the single-pid
    door so a process's number is the same wherever it is shown."""
    _windows(monkeypatch, typeperf_out=TYPEPERF_SAMPLE)
    rows = hw._windows_gpu_process_rows()
    assert rows is not None
    # 6971219968 + 1048576 bytes → 6647 + 1 MiB
    assert rows[1792] == 6971219968 // (1024 * 1024) + 1
    assert rows[17028] == 6796083200 // (1024 * 1024)
    # A zero-holding pid is dropped by gpu_processes, but the row parser keeps it.
    assert rows.get(4) == 0


def test_trailing_prose_does_not_break_the_parse(monkeypatch):
    """typeperf appends unquoted status lines after the CSV. Matching the data
    row on WIDTH (not position) is what keeps them out."""
    _windows(monkeypatch, typeperf_out=TYPEPERF_SAMPLE)
    assert hw._windows_gpu_process_rows()


def test_localized_windows_reads_as_unmeasurable_not_empty(monkeypatch):
    """Localized Windows localizes counter names — typeperf errors and nothing
    parses. That must be None (unknown), never {} (nothing is using the GPU)."""
    _windows(monkeypatch, typeperf_out="Error: The specified counter path is invalid.\n")
    assert hw._windows_gpu_process_rows() is None


def test_non_windows_declines_the_counter_arm(monkeypatch):
    monkeypatch.setattr(hw, "platform_key", lambda: "linux")
    assert hw._windows_gpu_process_rows() is None


# ── The nvidia-smi arm ────────────────────────────────────────────────────


def test_nvidia_rows_parse(monkeypatch):
    monkeypatch.setattr(hw.shutil, "which", lambda c: "/x/nvidia-smi")
    monkeypatch.setattr(hw.subprocess, "run", lambda *a, **k: _Ran(NVIDIA_SAMPLE))
    assert hw._nvidia_gpu_process_rows() == {1792: 512, 17028: 6481}


def test_nvidia_na_under_wddm_falls_through(monkeypatch):
    """THE reason the Windows arm exists. nvidia-smi lists the processes but
    prints [N/A] for memory on a consumer WDDM card; returning None is what
    hands over to the counter arm instead of reporting a GPU with no users."""
    monkeypatch.setattr(hw.shutil, "which", lambda c: "/x/nvidia-smi")
    monkeypatch.setattr(hw.subprocess, "run", lambda *a, **k: _Ran(NVIDIA_WDDM_SAMPLE))
    assert hw._nvidia_gpu_process_rows() is None


# ── The assembled answer ──────────────────────────────────────────────────


@pytest.fixture()
def _no_cache():
    hw._gpu_procs_cache = None
    yield
    hw._gpu_procs_cache = None


def test_windows_answer_is_additive(monkeypatch, _no_cache):
    """True only because the arm reads `Local Usage` — pinned by
    `test_windows_arm_reads_local_usage_not_dedicated` above."""
    monkeypatch.setattr(hw, "_nvidia_gpu_process_rows", lambda: None)
    _windows(monkeypatch, typeperf_out=TYPEPERF_SAMPLE)
    monkeypatch.setattr(hw, "_pid_name_map", lambda: {1792: "dwm.exe", 17028: "llama-server.exe"})
    monkeypatch.setattr(hw, "process_tree_pids", lambda pid: [pid, 17028])

    out = hw.gpu_processes(fresh=True)
    assert out is not None
    assert out["source"] == "windows-counters"
    assert out["additive"] is True
    names = [p["name"] for p in out["processes"]]
    assert names == ["dwm.exe", "llama-server.exe"], "biggest first"
    # pid 4 held zero and must not appear.
    assert all(p["pid"] != 4 for p in out["processes"])
    # Our own tree is attributable so the reader can separate it out.
    assert [p["own"] for p in out["processes"]] == [False, True]


def test_nvidia_answer_is_additive(monkeypatch, _no_cache):
    monkeypatch.setattr(hw.shutil, "which", lambda c: "/x/nvidia-smi")
    monkeypatch.setattr(hw.subprocess, "run", lambda *a, **k: _Ran(NVIDIA_SAMPLE))
    monkeypatch.setattr(hw, "_pid_name_map", lambda: {})
    monkeypatch.setattr(hw, "process_tree_pids", lambda pid: [pid])

    out = hw.gpu_processes(fresh=True)
    assert out["source"] == "nvidia-smi"
    assert out["additive"] is True
    # No name available → the UI falls back to the pid, so an empty string here
    # is the contract, not a bug.
    assert out["processes"][0]["name"] == ""


def test_no_arm_available_is_none_not_empty(monkeypatch, _no_cache):
    """AMD boxes have no per-process arm at all. None means 'cannot know';
    an empty list would claim the GPU is idle."""
    monkeypatch.setattr(hw, "_nvidia_gpu_process_rows", lambda: None)
    monkeypatch.setattr(hw, "_windows_gpu_process_rows", lambda: None)
    assert hw.gpu_processes(fresh=True) is None


def test_result_is_ttl_cached(monkeypatch, _no_cache):
    """The panel can be reopened or double-clicked; two ~1 s probes for one
    question is exactly what the cache is for."""
    calls = {"n": 0}

    def _once():
        calls["n"] += 1
        return {4242: 64}

    monkeypatch.setattr(hw, "_nvidia_gpu_process_rows", _once)
    monkeypatch.setattr(hw, "_pid_name_map", lambda: {4242: "x.exe"})
    monkeypatch.setattr(hw, "process_tree_pids", lambda pid: [pid])

    hw.gpu_processes(fresh=True)
    hw.gpu_processes()
    hw.gpu_processes()
    assert calls["n"] == 1

    hw.gpu_processes(fresh=True)
    assert calls["n"] == 2, "fresh=True must bypass the cache"
