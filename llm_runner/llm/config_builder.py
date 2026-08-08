# SPDX-License-Identifier: MIT
"""build_llm_config — the dispatch-time `LLMConfig`, built from the shared stores.
Replaces BOTH apps' per-app `config.py`. Reads the providers into the dispatch view.
`prefer_local_features` is the only optional per-app input (the set of features that
should default to the local runner, e.g. JustVoice's speaker_attribution).

The feature-pin layer retired 2026-08-08 (decided 2026-07-15): the ACTION's engine
preset carries provider+model, so the dispatch view is providers +
`prefer_local_features` and nothing else."""

from __future__ import annotations

from collections.abc import Iterable

from . import stores
from .schema import LLMConfig


def build_llm_config(prefer_local_features: Iterable[str] | None = None) -> LLMConfig:
    providers = list(stores.get_provider_store().list())
    return LLMConfig(
        providers=providers,
        prefer_local_features=set(prefer_local_features or ()),
    )
