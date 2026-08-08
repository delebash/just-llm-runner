# SPDX-License-Identifier: MIT
"""Which engine + model caches exist on this box, so a second family app can offer
to SHARE one instead of downloading the same gigabytes again.

Measured on the author's box 2026-08-03: JustWrite and just_ai_i18n_docgen each kept
their own `<data>/ai-cache`, holding the SAME artifact twice — `unsloth/
gemma-4-26B-A4B-it-qat-GGUF @ UD-Q4_K_XL`, snapshot `7b92b5b2…`, **14,249,047,104
bytes in both** — plus two full llama.cpp installs (`ggml-cuda.dll` alone is 533 MB
each). Identical, content-addressed gigabytes duplicated, while the one genuinely
exclusive resource — the router port — was the thing they shared. Both halves are
now the other way round (see `process.find_free_port` for the port half).

WHY A REGISTRY AND NOT A SCAN: an app's data dir can be anywhere — `%LOCALAPPDATA%`
for an installed build, `src-tauri/target/debug/data` for a dev run — so no scan
finds them all. Each app writes one line about itself here at boot; discovery is
then reading that file. It records WHERE a cache is, never what is in it.

Nothing here may raise into boot: a missing, unreadable or corrupt registry means
"no siblings known", which is exactly the state of a machine with one app on it.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)

_FILENAME = "caches.json"
_VERSION = 1
_HOME_ENV = "JUST_AI_HOME"


def _writes_allowed() -> bool:
    """False inside a test run that hasn't pointed `JUST_AI_HOME` somewhere safe.

    Found the hard way, minutes after this shipped: app suites call `install_llm`
    with a tmp data dir, so pytest runs in THREE repos wrote their
    `pytest-of-<user>/pytest-305/…` cache paths into the author's real registry —
    and, keyed by product at the time, erased JustWrite's genuine row on the way.

    The guard is here rather than in each suite's conftest deliberately. This is a
    machine-wide file that any consumer's tests can reach, including a stranger's app
    we will never see; "every suite remembers to set an env var" is the same
    protected-by-luck pattern that has cost this codebase a dependency, a placeholder
    and a shared port. An explicit `JUST_AI_HOME` always wins, so a test that means
    to exercise the registry still can."""
    return bool(os.environ.get(_HOME_ENV)) or "PYTEST_CURRENT_TEST" not in os.environ


def _ephemeral(root) -> bool:
    """True when `root` lives under the OS temp dir — a scratch install, not a cache.

    Smoke gates snapshot an app into `%TEMP%` and boot a real server there, and that
    server registers itself like any other boot. The 2026-08-08 ghost: a surviving
    `jw-smoke-*` scratch stayed in the registry, Quick Setup offered it as a real
    sibling ("JustWrite Server already has the engine"), pre-selected "share", and one
    proceed click repointed a 248 GB install at a Temp dir — the next model download
    landed there while the real cache sat full. A cache root the OS is allowed to
    sweep is never worth registering or offering.

    An explicit `JUST_AI_HOME` opts out of the check wherever it is applied: a harness
    that redirects the family home has already isolated its registry, and the suite's
    tests point tmp roots at a tmp home deliberately."""
    try:
        return Path(root).resolve().is_relative_to(Path(tempfile.gettempdir()).resolve())
    except OSError:
        return False


def _ephemeral_blocked(root) -> bool:
    """The check above, minus the `JUST_AI_HOME` escape."""
    return not os.environ.get(_HOME_ENV) and _ephemeral(root)


def family_home() -> Path:
    """The one place the family keeps cross-app facts. Deliberately NOT inside any
    app's data dir — the whole point is that it outlives the app that wrote it.

    `JUST_AI_HOME` overrides it — see `_writes_allowed` for why that matters."""
    override = os.environ.get(_HOME_ENV)
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
        return Path(base) / "just-ai"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "just-ai"
    base = os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")
    return Path(base) / "just-ai"


def default_shared_cache() -> Path:
    """The cache root an app gets if the user chooses "share" with no sibling to
    point at — a family location rather than any one app's data dir."""
    return family_home() / "ai-cache"


def _registry_path() -> Path:
    return family_home() / _FILENAME


def _read(prune: bool = True) -> list[dict]:
    """Known entries, DROPPING any whose cache root has since been deleted — or
    lives under the OS temp dir (`_ephemeral`: a scratch row an older registry may
    still carry; refusing them at write time is not enough for a file that already
    has one).

    Pruning matters because an entry is a claim about the disk, not a subscription:
    an uninstalled app, a relocated data root, or a throwaway run leaves a path that
    no longer exists, and offering a user "share JustWrite's 0 B cache" is worse than
    saying nothing. Cheap — one `is_dir` per row on a file with a handful of rows."""
    try:
        raw = json.loads(_registry_path().read_text(encoding="utf-8"))
        entries = raw.get("apps") if isinstance(raw, dict) else None
        rows = [e for e in (entries or []) if isinstance(e, dict) and e.get("cacheRoot")]
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        log.warning("cache registry unreadable — treating this box as having no siblings",
                    exc_info=True)
        return []
    return [e for e in rows if not prune
            or (Path(e["cacheRoot"]).is_dir() and not _ephemeral_blocked(e["cacheRoot"]))]


def register(product: str, cache_root, data_dir=None) -> None:
    """Record (or refresh) this app's cache location. Best-effort by contract — a
    read-only or missing family home must not stop a boot.

    KEYED BY (product, dataDir) — the INSTALL, which is the thing that has one cache.

    Not product alone: a dev build and a release build are two installs of one app, and
    that key let whichever booted last erase the other's row (which is how a pytest run
    with a tmp data dir replaced the real JustWrite entry). Not (product, cacheRoot)
    either, though it was the first fix: an install that RE-POINTS its cache then leaves
    its old row behind, claiming to cache somewhere it no longer does — seen live, one
    app listed against two roots after a single switch. The data dir identifies the
    install; the cache root is only what that install currently says about itself."""
    if not product or not cache_root or not _writes_allowed():
        return
    if _ephemeral_blocked(cache_root):
        log.debug("not registering %s — a cache under the OS temp dir is a scratch "
                  "install, not a sibling worth offering", cache_root)
        return
    where = str(Path(data_dir)) if data_dir else ""
    entry = {
        "product": product,
        "cacheRoot": str(Path(cache_root)),
        "dataDir": where,
        "lastSeen": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    apps = [e for e in _read()
            if not (e.get("product") == product and (e.get("dataDir") or "") == where)]
    apps.append(entry)
    path = _registry_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": _VERSION, "apps": apps}, indent=2),
                       encoding="utf-8")
        os.replace(tmp, path)   # atomic: two apps booting together can't leave half a file
    except OSError:
        log.warning("could not record this app's cache root in %s", path, exc_info=True)


def summarize(root) -> dict:
    """What is actually in a cache root: engine builds, cached model repos, bytes.
    The wizard shows this so "share" is a decision about real contents, not a path."""
    root = Path(root)
    builds: list[str] = []
    models: list[str] = []
    total = 0
    llamacpp = root / "llamacpp"
    if llamacpp.is_dir():
        builds = sorted(d.name for d in llamacpp.iterdir() if d.is_dir() and d.name != "logs")
    hf = root / "hf"
    if hf.is_dir():
        # The HF layout is `models--<owner>--<repo>`; render it back as `owner/repo`.
        models = sorted(d.name.replace("models--", "", 1).replace("--", "/")
                        for d in hf.iterdir() if d.is_dir() and d.name.startswith("models--"))
    if root.is_dir():
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                try:
                    total += (Path(dirpath) / name).stat().st_size
                except OSError:
                    continue
    return {"root": str(root), "exists": root.is_dir(), "engineBuilds": builds,
            "models": models, "bytes": total}


def discover(exclude=None) -> list[dict]:
    """Every cache root this box knows about except the excluded ones, summarized.

    `exclude` takes one path or several — a caller normally excludes BOTH the cache in
    use and its own private one, because it presents "keep my own" itself. Passing only
    the current root listed the app's own cache twice the moment it started sharing
    (seen live, 2026-08-03): the registry still held its own row from boot.

    Roots are de-duplicated, so two apps sharing one cache offer it once."""
    if exclude is None:
        excluded = set()
    elif isinstance(exclude, (str, Path)):
        excluded = {str(Path(exclude))}
    else:
        excluded = {str(Path(p)) for p in exclude if p}
    out: list[dict] = []
    seen: set[str] = set(excluded)
    for e in _read():
        root = str(Path(e["cacheRoot"]))
        if root in seen:
            continue
        seen.add(root)
        out.append({**summarize(root), "product": e.get("product", ""),
                    "lastSeen": e.get("lastSeen", "")})
    shared = str(default_shared_cache())
    if shared not in seen and Path(shared).is_dir():
        out.append({**summarize(shared), "product": "", "lastSeen": ""})
    return out
