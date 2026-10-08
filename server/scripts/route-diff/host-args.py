# SPDX-License-Identifier: MIT
"""Dump an app's `install_llm(...)` arguments as JSON for the route diff's Node host.

The Node host must mount the JavaScript kit exactly as the app mounts the Python one, so it
reads the app's own seed data (feature catalog, engine presets, model catalog, class tunes…)
from here instead of a re-typed copy. Run with the APP's interpreter:

    <app venv python> host-args.py docgen > docgen-args.json
"""

from __future__ import annotations

import json
import sys


def _plain(v):
    import dataclasses

    if hasattr(v, "model_dump"):
        return v.model_dump()
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return _plain(dataclasses.asdict(v))
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return v


def docgen() -> dict:
    from just_ai_i18n_docgen import app as a
    from just_ai_i18n_docgen.version import PRODUCT

    return {
        "featureCatalog": _plain(a.FEATURE_CATALOG),
        "featurePrompts": {},
        "enginePresets": _plain(a.DEFAULT_ENGINE_PRESETS),
        "featurePresets": _plain(a.DEFAULT_FEATURE_PRESETS),
        "defaultPresetId": a.DEFAULT_PRESET_ID,
        "modelCatalogExtra": _plain(a.MODEL_CATALOG),
        "classTunesSeed": _plain(a.CLASS_TUNES),
        "classTuneIdentity": _plain(a.CLASS_TUNE_IDENTITY),
        "product": PRODUCT,
    }


APPS = {"docgen": docgen}

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(APPS[sys.argv[1]](), indent=1, ensure_ascii=False))
