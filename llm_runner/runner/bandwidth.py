# SPDX-License-Identifier: MIT
"""Effective memory bandwidth per pool — the fit-redesign Phase 3 ladder (§5.5).

Bandwidth is a MACHINE property; models are interchangeable lenses on it. Three
sources, best first, each pool resolved independently:

  1. DERIVED from stored measurements — `BW_eff = tok/s × bytes/token`,
     pool-matched, and ONLY from rows whose launch config is KNOWN (switches
     recorded with the placement + ctx) and un-sped (no draft/spec flags, model
     not MTP — §13.14: flagless rows never qualify; token-level acceptance is
     not the speculation multiplier, so speculative rows are excluded outright).
     Already EFFECTIVE — no efficiency factor applies.
  2. DEVICE-REPORTED — NVIDIA: `nvidia-smi` bus width × mem clock × 2 (DDR),
     the device's own registers (2070 SUPER: 256 bit × 7001 MHz × 2 = 448 GB/s,
     matching the vendor spec). Apple: chip name → the published-spec table
     below. RAM (all platforms): a one-time C-speed copy probe (`bytes(buf)` is
     one memcpy — no Python-level loop), persisted as a machine measurement row
     so it runs once per box, self-healing after a Clear-history (§8.22).
     AMD/Intel dGPU: no reliable register path → source 3. RAW numbers — the
     seeded efficiency family (device ~0.6 · host ~0.15, err-slow low end)
     converts them to effective.
  3. SEEDED class-typical fallback — the `hardware_classes` bw columns (JEDEC
     arithmetic + vendor spec sheets, cited at the seed like licenses are),
     GUI-editable in the class editor, superseded by any higher source. RAW.

A pool that resolves NOWHERE stays None and the badge shows no band — an
unknown never becomes a number (§8.17's spirit).
"""

from __future__ import annotations

import logging
import platform
import subprocess
import time

from . import fit
from .hardware import _nvidia_query

log = logging.getLogger(__name__)

# The pseudo-model id the RAM copy probe's result is persisted under in the
# measurement history (the plan's "machine measurement row"): `tokensPerSec`
# carries GB/s — the label says so. Filtered from per-model views by never
# being a catalog id; deleted by Clear-history → the probe simply re-runs.
RAM_PROBE_MODEL_ID = "__machine_ram_bw__"
RAM_PROBE_LABEL = "RAM copy bandwidth probe (GB/s in tokensPerSec)"

# Apple-silicon UNIFIED-pool bandwidth, GB/s — Apple's own published specs
# (apple.com newsroom/tech-spec pages per chip). Facts like the JEDEC numbers,
# not tunables; a wrong entry is overridable via the class editor (source 3
# outranks nothing, but the user can also pin the class row and clear no
# measurements). Longest name wins the match (an "M1 Ultra" must not read as
# "M1"). Where one chip ships two memory configs the LOW one is seeded
# (err-slow, §8.17).
_APPLE_CHIP_BW_GBPS: tuple[tuple[str, float], ...] = (
    ("M1 Ultra", 800.0), ("M1 Max", 400.0), ("M1 Pro", 200.0), ("M1", 68.25),
    ("M2 Ultra", 800.0), ("M2 Max", 400.0), ("M2 Pro", 200.0), ("M2", 100.0),
    ("M3 Ultra", 800.0), ("M3 Max", 300.0), ("M3 Pro", 150.0), ("M3", 102.4),
    ("M4 Max", 410.0), ("M4 Pro", 273.0), ("M4", 120.0),
)


def nvidia_mem_bw_gbps() -> float | None:
    """Memory bandwidth of the largest-BW NVIDIA card from its own registers:
    bus width (bits) × memory clock (MHz) × 2 (DDR — nvidia-smi reports the
    half-rate clock for GDDR6/6X alike) ÷ 8 bits. None when nvidia-smi is
    absent or the fields are unreadable (old drivers)."""
    out = _nvidia_query("memory.bus.width,clocks.max.memory")
    if out is None:
        return None
    best = None
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 2:
            continue
        try:
            bus_bits, clock_mhz = float(parts[0]), float(parts[1])
        except ValueError:
            continue
        if bus_bits <= 0 or clock_mhz <= 0:
            continue
        gbps = bus_bits / 8.0 * clock_mhz * 2.0 / 1000.0
        best = max(best or 0.0, gbps)
    return best


def apple_pool_bw_gbps() -> float | None:
    """The unified pool's bandwidth from the chip name (macOS only) — the
    published-spec table above. None off-macOS or for an unlisted chip."""
    if not platform.system().lower().startswith("darwin"):
        return None
    try:
        brand = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception as e:  # noqa: BLE001 — detection must never raise
        log.debug("sysctl brand_string failed: %s", e)
        return None
    for chip, gbps in _APPLE_CHIP_BW_GBPS:
        if chip in brand:
            return gbps
    return None


def probe_ram_copy_gbps(size_mb: int = 256, repeats: int = 3) -> float | None:
    """One-shot system-RAM streaming probe: time `bytes(buf)` — a single C
    memcpy of `size_mb` — and report the bytes TOUCHED per second (read + write
    = 2 × size / elapsed), the spec-comparable convention (a DDR4-3200 dual
    box probes ~35-45 vs its 51.2 JEDEC — slightly conservative, the err-slow
    direction once the host efficiency factor applies). Best-of-`repeats`
    (minimum elapsed) rejects scheduler noise without overstating hardware.
    Runs in ~tens of ms + one buffer allocation; None on any failure."""
    try:
        # Repeating a really-written MB commits real pages (a bare bytearray(n)
        # may be lazily zero-mapped and would measure the page-fault path).
        buf = bytearray(b"\xa5" * (1 << 20)) * max(1, size_mb)
        best_s = None
        for _ in range(max(1, repeats)):
            t0 = time.perf_counter()
            copy = bytes(buf)
            dt = time.perf_counter() - t0
            del copy
            if dt > 0:
                best_s = dt if best_s is None else min(best_s, dt)
        if not best_s:
            return None
        return round(2.0 * len(buf) / best_s / 1e9, 2)
    except Exception as e:  # noqa: BLE001 — a probe failure must never raise
        log.debug("RAM copy probe failed: %s", e)
        return None


# ── Source 1: derivation from stored, config-known measurements ──────────────
# Rows arrive as plain dicts {model_id, machine_key, backend, tokens_per_sec,
# switches: {flag: value}}; per-model speed facts as
# {model_id: {n_layers, mtp, size_mb, non_expert_mb, active_expert_mb, kv_facts}}.
# The caller adapts its wire shapes — this stays pure.

_SPEC_FLAGS = ("model-draft", "spec-type", "spec-draft-n-max", "spec-ngram-mod-n-max")


def _row_ctx_bits(switches: dict) -> tuple[int, int]:
    """(ctx, cache_bits) from a row's recorded switches; ctx 0 = unknown."""
    raw = switches.get("ctx-size") or switches.get("ctx") or 0
    try:
        ctx = int(float(raw))
    except (TypeError, ValueError):
        ctx = 0
    return ctx, fit.cache_type_bits(str(switches.get("cache-type-k") or ""))


def _int_flag(switches: dict, name: str) -> int | None:
    raw = switches.get(name)
    if raw is None:
        return None
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return None


def _qualifying(rows: list[dict], facts_by_id: dict, machine_key: str, backend: str):
    """The shared derivation-rule filter (§13.8): this box, this backend (a
    legacy ""-backend row never qualifies — cross-backend numbers are not
    comparable), a real number, recorded switches (flagless never qualifies),
    un-sped (no draft/spec flags; MTP models excluded outright — built-in heads
    may have been armed outside the recorded switches), known ctx."""
    for row in rows:
        if row.get("machine_key") != machine_key or row.get("backend") != backend:
            continue
        tok_s = float(row.get("tokens_per_sec") or 0)
        sw = row.get("switches") or {}
        if tok_s <= 0 or not sw:
            continue
        if any(f in sw for f in _SPEC_FLAGS):
            continue
        sf = facts_by_id.get(row.get("model_id"))
        if not sf or sf.get("mtp"):
            continue
        ctx, bits = _row_ctx_bits(sw)
        if ctx <= 0:
            continue
        yield tok_s, sw, sf, ctx, bits


def derive_device_bw_gbps(
    rows: list[dict], facts_by_id: dict, *, machine_key: str, backend: str,
) -> float | None:
    """Device-pool effective bandwidth from FULL-OFFLOAD DENSE rows (every byte
    the pass touches lives on the device, so tok/s × bytes/pass IS the pool's
    effective rate). Max over qualifying rows — each run is a lower bound on
    the machine (something else may have bottlenecked it)."""
    best = None
    for tok_s, sw, sf, ctx, bits in _qualifying(rows, facts_by_id, machine_key, backend):
        if sf.get("active_expert_mb"):
            continue  # MoE rows are host evidence, handled below
        ngl = _int_flag(sw, "n-gpu-layers")
        if ngl is None or ngl < int(sf.get("n_layers") or 0) or (_int_flag(sw, "n-cpu-moe") or 0) > 0:
            continue
        bytes_mb = float(sf.get("size_mb") or 0) + fit.kv_mb_from_facts(sf.get("kv_facts") or {}, ctx, bits)
        if bytes_mb <= 0:
            continue
        best = max(best or 0.0, tok_s * bytes_mb / 1000.0)
    return best


def derive_host_bw_gbps(
    rows: list[dict], facts_by_id: dict, *, machine_key: str, backend: str,
    device_eff_gbps: float | None,
) -> float | None:
    """Host-pool effective bandwidth from ALL-EXPERTS-IN-RAM MoE rows: price the
    device leg at the resolved device bandwidth and attribute the remaining
    per-token time to the expert gather (the Appendix-B derivation — the device
    side was measured 'insensitive' there, so a seeded device number is fine).
    Needs a device estimate; rows whose device leg can't be priced are skipped."""
    if not device_eff_gbps or device_eff_gbps <= 0:
        return None
    best = None
    for tok_s, sw, sf, ctx, bits in _qualifying(rows, facts_by_id, machine_key, backend):
        host_mb = float(sf.get("active_expert_mb") or 0)
        if host_mb <= 0:
            continue
        n_layers = int(sf.get("n_layers") or 0)
        ngl, ncmoe = _int_flag(sw, "n-gpu-layers"), _int_flag(sw, "n-cpu-moe")
        if ngl is None or ncmoe is None or n_layers <= 0 or ngl < n_layers or ncmoe < n_layers:
            continue  # placement not the clean all-experts-host shape → config unknown
        dev_mb = float(sf.get("non_expert_mb") or 0) + fit.kv_mb_from_facts(sf.get("kv_facts") or {}, ctx, bits)
        remaining_s = 1.0 / tok_s - (dev_mb / 1000.0) / device_eff_gbps
        if remaining_s <= 0:
            continue  # device pricing ate the whole budget — not solvable from this row
        best = max(best or 0.0, host_mb / 1000.0 / remaining_s)
    return best


def resolve_effective_bw(
    *,
    rows: list[dict],
    facts_by_id: dict,
    machine_key: str,
    backend: str,
    is_macos: bool,
    class_vram_bw_gbps: float,
    class_ram_bw_gbps: float,
    probe_gbps: float | None,
    eff_device: float,
    eff_host: float,
) -> tuple[float | None, float | None]:
    """(device_eff_gbps, host_eff_gbps) down the ladder. Source-1 numbers are
    already effective; sources 2/3 are raw × the seeded efficiency family."""
    device_raw = (apple_pool_bw_gbps() if is_macos else nvidia_mem_bw_gbps()) or (class_vram_bw_gbps or None)
    device = derive_device_bw_gbps(rows, facts_by_id, machine_key=machine_key, backend=backend) \
        or (device_raw * eff_device if device_raw else None)
    host_raw = probe_gbps or (class_ram_bw_gbps or None)
    host = derive_host_bw_gbps(rows, facts_by_id, machine_key=machine_key, backend=backend,
                               device_eff_gbps=device) \
        or (host_raw * eff_host if host_raw else None)
    return device, host
