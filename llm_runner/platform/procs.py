# SPDX-License-Identifier: MIT
"""Starting an external program — always with no console to inherit.

Every program a family server starts goes through here (2026-10-07, lifted from
JustVoice, where it was found). A child started on Windows without
CREATE_NO_WINDOW inherits the server's console. When the shell that started the
app is gone, that console has no host, and Windows cannot start the child at
all: exit 0xC0000142. On 2026-10-07 that failed every chapter's mastering
("ffmpeg failed (exit 3221225794)") and blinded this kit's own hardware
detection — nvidia-smi could not start, so no GPU was found, no llama.cpp build
matched and the engine read "not installed" — while the programs already
started with the flag (the speech runtime, llama-server's own console) kept
working. Reproduced outside the app: a process whose console host was killed
starts ffmpeg → 0xc0000142 without the flag, exit 0 with it; `detect()` there →
no GPU, with a live console → the RTX 2070 SUPER. With the flag the child gets
a hidden console of its own. Elsewhere the flag is 0.

Each wrapper calls `subprocess` at call time, so a test that patches
`subprocess.run` / `subprocess.Popen` still reaches the fake.
"""

from __future__ import annotations

import subprocess
import sys

NO_CONSOLE = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

#: Windows' "the program could not start" (STATUS_DLL_INIT_FAILED), as an exit code.
CANT_START = 0xC0000142


def run(argv, **kw):
    """`subprocess.run`, with no console to inherit."""
    return subprocess.run(argv, creationflags=NO_CONSOLE, **kw)


def check_output(argv, **kw):
    """`subprocess.check_output`, with no console to inherit."""
    return subprocess.check_output(argv, creationflags=NO_CONSOLE, **kw)


def popen(argv, **kw):
    """`subprocess.Popen`, with no console to inherit."""
    return subprocess.Popen(argv, creationflags=NO_CONSOLE, **kw)


def failed(name: str, returncode: int, stderr: bytes | None) -> str:
    """What a failed run says: the program's own words, or — when it never
    started — that, rather than a bare Windows code."""
    if (returncode & 0xFFFFFFFF) == CANT_START:
        return f"{name} could not start (Windows error 0xC0000142)"
    err = (stderr or b"").decode("utf-8", errors="ignore").strip()[-1500:]
    return f"{name} failed (exit {returncode}){': ' + err if err else ''}"
