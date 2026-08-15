# SPDX-License-Identifier: MIT
"""THE family data-location policy — one implementation, every app.

The user's ruling (2026-08-14, after JustVoice drifted): *"none of the apps
should have anything stored in [an OS app-data folder]... absolutely no data
for any of these apps should be stored anywhere but where the user has set the
storage directory, which by default will be the install directory for the
app"* and *"don't hardcode anything — app-data is not banned, what is banned
is anything that the user has not decided"*.

So the policy, in strict order:

1. **The user's explicit choice** — the app's data-dir env var (which the
   desktop shell also uses to hand down a `Change folder` selection, and
   headless `--data-dir` sets). Always wins, no questions.
2. **Beside the app** — a `data/` folder in the install directory: next to
   the frozen executable for a packaged build, next to the source checkout
   root in development (Tauri dev = `src-tauri/target/debug/data`, which the
   shell resolves; the Python side mirrors the shape for headless runs).
   This is the DEFAULT: portable, visible, deletable, and nothing lands in a
   hidden per-user folder the user never chose.
3. **The OS app-data dir** — ONLY when the install directory is not writable
   (Program Files, a read-only bundle, a system Python). Not a preference:
   the last resort that keeps a locked-down install from failing outright.

Each app's `paths.py` is a thin call into `resolve_data_dir` — the shape may
never be re-implemented per app (that divergence is exactly what produced
JustVoice writing to Roaming while JustWrite ran portable, and cost an audit
to find). The desktop shells implement the identical ladder in Rust because
they must resolve the root BEFORE the server exists; keep the two in
lock-step.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _is_writable(directory: Path) -> bool:
    """Can we actually create files here? Probe, never guess — a path can
    exist and still be read-only (Program Files, a mounted bundle)."""
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    probe = directory / ".llm_runner_write_probe"
    try:
        probe.write_bytes(b"x")
    except OSError:
        return False
    try:
        probe.unlink()
    except OSError:
        pass
    return True


def to_data_relative(path: Path | str, data_dir: Path) -> str:
    """The string to STORE for a media file (user ruling 2026-08-14).

    A file inside the data root is stored RELATIVE to it, POSIX-style, so the
    row survives the user moving their data folder — the whole point of the
    Change-folder verb, which used to copy the files and leave every absolute
    row pointing at the deleted original. It also makes a backup restore onto
    another machine (or another drive) resolve.

    A path OUTSIDE the data root keeps its absolute form: it is not ours to
    relocate, and rewriting it would break the reference.
    """
    p = Path(path)
    try:
        return p.resolve().relative_to(Path(data_dir).resolve()).as_posix()
    except (ValueError, OSError):
        return str(p)


def from_data_relative(stored: str, data_dir: Path) -> Path:
    """Resolve a stored media path back to a real one.

    Absolute values pass through unchanged — that covers both deliberately
    external files and rows written before the relative-path rule, so no
    migration is needed and nothing breaks in place.
    """
    p = Path(stored)
    return p if p.is_absolute() else Path(data_dir) / p


def install_dir(source_root: Path | None = None) -> Path | None:
    """The app's install directory: the frozen executable's folder when
    packaged (PyInstaller sets `sys.frozen`), else the caller's source
    checkout root. None when neither is knowable."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(source_root).resolve() if source_root is not None else None


def resolve_data_dir(
    *,
    app_name: str,
    env_var: str,
    source_root: Path | None = None,
    env: dict[str, str] | None = None,
) -> Path:
    """The family data root for `app_name` per the module policy.

    `env_var` — the app's data-dir variable (`JUSTVOICE_DATA_DIR`,
    `JUSTWRITE_DATA_DIR`): the user's/shell's explicit choice.
    `source_root` — the app's checkout root, used in development when the
    process is not frozen (an app passes its own; the kit cannot guess it).
    `env` — override the environment (tests).
    """
    environ = os.environ if env is None else env
    chosen = (environ.get(env_var) or "").strip()
    if chosen:
        return Path(chosen)

    base = install_dir(source_root)
    if base is not None:
        candidate = base / "data"
        if _is_writable(candidate):
            return candidate

    # Last resort only — a non-writable install (see the module docstring).
    import platformdirs

    return Path(platformdirs.user_data_dir(app_name))
