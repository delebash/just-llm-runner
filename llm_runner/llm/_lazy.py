# SPDX-License-Identifier: MIT
"""Deferred module imports for the heavy cloud-vendor SDKs.

WHY THIS EXISTS (measured 2026-07-24). `registry.load_from_configs()` constructs an adapter
for EVERY configured provider at server start, and each cloud adapter imported its vendor SDK
at module scope. From the server's own log, one boot spent:

    openai   +586 ms      (openai_sdk.py  `import openai`)
    claude   +584 ms      (anthropic.py   `import anthropic`)
    gemini   +918 ms      (gemini.py      `from google import genai`)

— 2,088 ms of a ~4,100 ms cold start, importing SDKs for providers that usually have no API
key and are never called in that session. The #16 work had already made the CLIENTS lazy
(`self._client = None`, built in `_ensure_client`); the heavy MODULE import was the half left
on the boot path.

WHY A PROXY rather than moving imports into each function: the adapters reference their SDK in
`except` clauses (`except openai.APIStatusError as e:`) and in call expressions across ~29
sites. A proxy defers the import to first ATTRIBUTE ACCESS, so every one of those call sites
stays exactly as written — the deferral is one line per adapter, not a rewrite of its error
handling. `except <expr>` is evaluated when an exception is raised, by which point the adapter
has already built its client (and therefore imported the SDK), so the proxy is a cached lookup
there, never a surprise import inside error handling.

TRADE-OFF, stated: a missing SDK now raises at first attribute access instead of at import
time. That is already handled — `registry.load_from_configs` catches per-provider construction
failures and logs "provider X skipped at boot", and dispatch surfaces adapter errors per
request. The failure moves from "every boot, for SDKs you may not use" to "the request that
actually needed it".
"""

from __future__ import annotations

import importlib
from typing import Any


class _LazyModule:
    """Imports `module_name` on the first attribute access, then caches it.

    Only `__getattr__` is customised, and Python calls it solely for attributes not found
    through the normal path — so the instance's own `_module_name` / `_module` are read
    directly and never trigger the import.
    """

    __slots__ = ("_module_name", "_module")

    def __init__(self, module_name: str) -> None:
        object.__setattr__(self, "_module_name", module_name)
        object.__setattr__(self, "_module", None)

    def __getattr__(self, attr: str) -> Any:
        mod = object.__getattribute__(self, "_module")
        if mod is None:
            mod = importlib.import_module(object.__getattribute__(self, "_module_name"))
            object.__setattr__(self, "_module", mod)
        return getattr(mod, attr)

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        loaded = object.__getattribute__(self, "_module") is not None
        name = object.__getattribute__(self, "_module_name")
        return f"<lazy module {name!r} {'loaded' if loaded else 'not yet imported'}>"


def lazy_module(module_name: str) -> Any:
    """A stand-in for `import module_name` that defers the real import to first use.

    Swap `import openai` for `openai = lazy_module("openai")` and every `openai.X` call site
    keeps working unchanged.
    """
    return _LazyModule(module_name)
