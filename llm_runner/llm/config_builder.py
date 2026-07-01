# SPDX-License-Identifier: GPL-3.0-or-later
"""build_llm_config — the dispatch-time `LLMConfig`, built from the shared stores.
Replaces BOTH apps' per-app `config.py`. Reads providers + routing (default +
explicit per-feature pins) from the shared stores into the dispatch view.
`prefer_local_features` is the only optional per-app input (the set of features
that should default to the local runner, e.g. JustVoice's speaker_attribution)."""

from __future__ import annotations

from collections.abc import Iterable

from . import stores
from .schema import FeaturePinConfig, LLMConfig


def build_llm_config(prefer_local_features: Iterable[str] | None = None) -> LLMConfig:
    routing = stores.get_routing_store().get_routing()
    providers = list(stores.get_provider_store().list())
    # Explicit per-feature pins (provider+model).
    feature_pins = [
        FeaturePinConfig(feature=key, providerId=p.providerId, model=p.model)
        for key, p in routing.pins.items()
        if p.providerId
    ]
    return LLMConfig(
        providers=providers,
        feature_pins=feature_pins,
        prefer_local_features=set(prefer_local_features or ()),
    )
