# SPDX-License-Identifier: GPL-3.0-or-later
"""build_llm_config — the dispatch-time `LLMConfig`, built from the shared stores.
Replaces BOTH apps' per-app `config.py`. Reads providers + routing + the
feature→job map from the shared stores and resolves feature → job → model into
the dispatch view (job-native; no roles). `prefer_local_features` is the only
optional per-app input (the set of features that should default to the local
runner, e.g. JustVoice's speaker_attribution)."""

from __future__ import annotations

from collections.abc import Iterable

from . import stores
from .schema import FeaturePinConfig, LLMConfig, LLMJobTarget


def build_llm_config(prefer_local_features: Iterable[str] | None = None) -> LLMConfig:
    routing = stores.get_routing_store().get_routing()
    providers = list(stores.get_provider_store().list())
    # Explicit per-feature pins (provider+model) — inherit-the-job is no pin.
    feature_pins = [
        FeaturePinConfig(feature=key, providerId=p.providerId, model=p.model)
        for key, p in routing.pins.items()
        if p.providerId
    ]
    # The job→model map + the feature→job classification.
    jobs = {
        jid: LLMJobTarget(providerId=t.providerId, model=t.model)
        for jid, t in routing.jobs.items()
        if t.providerId
    }
    feature_jobs = {fj.featureKey: fj.jobId for fj in stores.get_feature_job_store().list()}
    return LLMConfig(
        providers=providers,
        feature_pins=feature_pins,
        jobs=jobs,
        feature_jobs=feature_jobs,
        prefer_local_features=set(prefer_local_features or ()),
    )
