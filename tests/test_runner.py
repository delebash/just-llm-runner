# SPDX-License-Identifier: MIT
"""VRAM-fit, flag composition, and spawn + probe-and-back-off. The subprocess
and health probe are injected, so this runs anywhere (no GPU, no llama-server
binary, no model).

Post-A7: there is no runner-manifest. `compute_fit` takes the VRAM safety margin
directly (default), and `compose_flags` renders PURELY from the resolved
`Overrides` (the base + type (moe|dense) flag defaults arrive in `Overrides`, resolved
from the DB `switch_presets` by the runner's switches_fn) + the computed fit knobs."""

from __future__ import annotations

import pytest

from llm_runner.runner.gguf import GgufMeta
from llm_runner.runner.process import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    FitPlan,
    ModelIniEntry,
    Overrides,
    Runner,
    RunnerStartError,
    _tail_file,
    compose_flags,
    compose_router_argv,
    compute_fit,
    emit_models_ini,
    overrides_to_pairs,
    render_argv,
    render_ini,
    start_runner,
)
from llm_runner.runner.schema import GpuInfo, HardwareInfo

# layer_bytes = 10 GB / 10 layers = 1 GB/layer → clean fit arithmetic.
_TEN_GB = 10_000_000_000


def _hw(vram_mb=None):
    gpus = [GpuInfo(vendor="NVIDIA", name="test", vram_mb=vram_mb)] if vram_mb else []
    return HardwareInfo(
        os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
        gpus=gpus, runtimes={"cuda": True} if vram_mb else {},
    )


def _meta(block_count=10, dim=1000, expert_count=0):
    return GgufMeta(
        architecture="qwen3moe" if expert_count else "llama",
        block_count=block_count, embedding_length=dim, expert_count=expert_count,
    )


# ── compute_fit ───────────────────────────────────────────────────────────────

def test_fit_cpu_only_no_gpu():
    fit = compute_fit(_meta(), _TEN_GB, _hw(vram_mb=None))
    assert fit.n_gpu_layers == 0
    assert fit.n_cpu_moe == 0


def test_fit_large_gpu_all_layers():
    fit = compute_fit(_meta(block_count=10), _TEN_GB, _hw(vram_mb=24000))
    assert fit.n_gpu_layers == 10  # everything fits


def test_fit_small_gpu_moe_offloads_rest():
    # 10 GB model on an 8 GB GPU → only some layers fit; the oobabooga formula
    # (incl. base CUDA overhead) sets how many, and the MoE rest offloads to CPU.
    fit = compute_fit(_meta(block_count=10, expert_count=128), _TEN_GB, _hw(vram_mb=8192))
    assert fit.is_moe
    assert 0 < fit.n_gpu_layers < 10                 # partial fit
    assert fit.n_cpu_moe == 10 - fit.n_gpu_layers    # the rest offloads to CPU


def test_fit_ncmoe_discounts_the_reservation():
    """The ncmoe-aware reservation (2026-07-24 — the 2026-07-11 incident's item 2):
    an ncmoe'd MoE reserves what actually lands on the GPU, not the whole file
    (Gemma 26B at ngl 30/ncmoe 21 booked 20.6 GB against a measured ~6.5 GB, so
    every admission cried "over budget"). Same explicit split with vs without the
    expert dims in the header — the discounted reservation must be a small
    fraction; a header without expert dims keeps the exact old (undiscounted)
    number, and an ncmoe-0 MoE is untouched."""
    from llm_runner.runner.process import Overrides

    ov = Overrides(n_gpu_layers=30, n_cpu_moe=21, ctx_len=4096)
    expert_meta = GgufMeta(
        architecture="g", block_count=48, embedding_length=2048, expert_count=128,
        head_count=16, head_count_kv=4, expert_feed_forward_length=1024,
    )
    nodims_meta = GgufMeta(
        architecture="g", block_count=48, embedding_length=2048, expert_count=128,
        head_count=16, head_count_kv=4,
    )
    discounted = compute_fit(expert_meta, 13_300_000_000, _hw(vram_mb=8192), ov)
    undiscounted = compute_fit(nodims_meta, 13_300_000_000, _hw(vram_mb=8192), ov)
    assert discounted.n_gpu_layers == undiscounted.n_gpu_layers == 30
    # e > 0.9 and 21/30 layers stripped → the weight term collapses to ~1/3;
    # the old number is the full-file booking (the 20.6-GB class of estimate).
    assert discounted.vram_mb < undiscounted.vram_mb * 0.55
    assert undiscounted.vram_mb > 8000   # the old fiction: far over an 8 GB card
    # ncmoe 0 → byte-identical to the undiscounted estimate (no behavior change).
    ov0 = Overrides(n_gpu_layers=30, n_cpu_moe=0, ctx_len=4096)
    assert compute_fit(expert_meta, 13_300_000_000, _hw(vram_mb=8192), ov0).vram_mb == \
        compute_fit(nodims_meta, 13_300_000_000, _hw(vram_mb=8192), ov0).vram_mb


def test_fit_overrides_win():
    fit = compute_fit(
        _meta(block_count=40, expert_count=8), _TEN_GB, _hw(vram_mb=24000),
        overrides=Overrides(n_gpu_layers=5, n_cpu_moe=2, ctx_len=8192),
    )
    assert fit.n_gpu_layers == 5
    assert fit.n_cpu_moe == 2
    assert fit.ctx_len == 8192


def test_fit_safety_margin_shrinks_budget():
    # A larger margin reserves more VRAM → no more layers fit than a small margin.
    tight = compute_fit(_meta(block_count=10), _TEN_GB, _hw(vram_mb=8192), safety_margin_mb=6000)
    loose = compute_fit(_meta(block_count=10), _TEN_GB, _hw(vram_mb=8192), safety_margin_mb=512)
    assert tight.n_gpu_layers <= loose.n_gpu_layers


# ── the speculative-decode draft's share of the budget (2026-07-19) ───────────

_ONE_GB = 1_000_000_000  # a Gemma-class external MTP draft file


def test_fit_draft_takes_layers_from_the_main_split():
    # llama.cpp fully offloads a `--model-draft` GGUF (we emit no draft-layers flag),
    # so its weights + KV must come off the budget BEFORE the main split — otherwise
    # the draft silently steals layers the fit already promised to the main model.
    args = (_meta(block_count=10), _TEN_GB, _hw(vram_mb=8192))
    without = compute_fit(*args)
    with_draft = compute_fit(*args, draft_meta=_meta(block_count=4), draft_bytes=_ONE_GB)
    assert 0 < with_draft.n_gpu_layers < without.n_gpu_layers


def test_fit_reservation_counts_the_draft():
    # fit.vram_mb is what the VRAM arbiter reserves. With the split PINNED identical,
    # the only delta is the draft — if it were missing, a co-resident admission would
    # over-book by exactly the draft's size (the #274 co-load defect).
    args = (_meta(block_count=10), _TEN_GB, _hw(vram_mb=24000))
    pinned = dict(overrides=Overrides(n_gpu_layers=4))
    bare = compute_fit(*args, **pinned)
    with_draft = compute_fit(*args, **pinned, draft_meta=_meta(block_count=4),
                             draft_bytes=_ONE_GB)
    assert with_draft.n_gpu_layers == bare.n_gpu_layers == 4  # same split…
    assert with_draft.vram_mb > bare.vram_mb                  # …more VRAM held


def test_fit_without_a_draft_is_byte_identical():
    # Regression pin with LITERAL values — the pre-2026-07-19 plan for a 10 GB MoE on an
    # 8 GB card. Comparing the defaults against explicitly-passed defaults would be a
    # tautology that could not catch an arithmetic slip; these numbers can.
    args = (_meta(block_count=10, expert_count=128), _TEN_GB, _hw(vram_mb=8192))
    plan = compute_fit(*args)
    assert (plan.n_gpu_layers, plan.n_cpu_moe, plan.ctx_len, plan.vram_mb) == (4, 6, 4096, 6432)
    # …and a draft SIZE with no draft meta is inert (the meta is what arms the term).
    assert compute_fit(*args, draft_bytes=_ONE_GB) == plan


def test_fit_draft_is_a_no_op_on_a_cpu_only_box():
    # No GPU → no VRAM budget to charge, so a declared draft changes nothing (it rides
    # in RAM there, inside the coarse band's error bars — deliberately not modelled).
    args = (_meta(block_count=10), _TEN_GB, _hw(vram_mb=None))
    assert compute_fit(*args) == compute_fit(*args, draft_meta=_meta(block_count=4),
                                             draft_bytes=_ONE_GB)


# ── compose_flags (renders from Overrides + fit knobs; no manifest preset) ─────

def test_compose_flags_sets_ngl_and_moe(tmp_path):
    flags = compose_flags(
        tmp_path / "model.gguf", n_gpu_layers=20, n_cpu_moe=4, ctx_len=4096, port=9999,
    )
    assert flags.count("-ngl") == 1
    assert flags[flags.index("-ngl") + 1] == "20"
    assert flags[flags.index("--n-cpu-moe") + 1] == "4"
    assert flags[flags.index("-m") + 1].endswith("model.gguf")
    assert flags[flags.index("--port") + 1] == "9999"
    assert flags[flags.index("--ctx-size") + 1] == "4096"


def test_compose_flags_omits_moe_when_zero(tmp_path):
    flags = compose_flags(tmp_path / "m.gguf", n_gpu_layers=0, n_cpu_moe=0, ctx_len=2048)
    assert "--n-cpu-moe" not in flags  # omitted when 0
    assert flags[flags.index("-ngl") + 1] == "0"


def test_compose_flags_base_preset_via_overrides(tmp_path):
    # The DB `base` preset reaches the spawn as Overrides → rendered onto empty.
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(cache_type_k="q8_0", cache_type_v="q8_0", flash_attn="on",
                            mlock=True, threads=8, batch_size=1024),
    )
    assert flags.count("--cache-type-k") == 1
    assert flags[flags.index("--cache-type-k") + 1] == "q8_0"
    assert flags[flags.index("--cache-type-v") + 1] == "q8_0"
    assert flags[flags.index("--flash-attn") + 1] == "on"
    assert "--mlock" in flags
    assert flags[flags.index("--threads") + 1] == "8"
    assert flags[flags.index("--batch-size") + 1] == "1024"


def test_compose_flags_presence_overrides(tmp_path):
    # Presence flags add/remove cleanly (no value-eating).
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(mlock=False, no_mmap=True, no_kv_offload=True, cont_batching=False),
    )
    assert "--mlock" not in flags          # mlock=False → not present
    assert "--no-mmap" in flags            # added
    assert "--no-kv-offload" in flags      # added
    assert "--no-cont-batching" in flags   # cont-batching disabled
    assert flags[flags.index("-ngl") + 1] == "10"


def test_compose_flags_spec_draft_mtp(tmp_path):
    # A user's MTP opt-in arrives as Overrides(spec_type=draft-mtp) for MTP models (Phase 3).
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(spec_type="draft-mtp", spec_n_max=3),
    )
    assert flags[flags.index("--spec-type") + 1] == "draft-mtp"
    assert flags[flags.index("--spec-draft-n-max") + 1] == "3"


def test_compose_flags_spec_none_clears(tmp_path):
    # spec_type="none" (the MoE preset) emits no spec flags.
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(spec_type="none"),
    )
    assert "--spec-type" not in flags
    assert "--spec-draft-n-max" not in flags


def test_compose_flags_spec_ngram(tmp_path):
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(spec_type="ngram-mod", spec_n_max=64),
    )
    assert flags[flags.index("--spec-type") + 1] == "ngram-mod"
    assert flags[flags.index("--spec-ngram-mod-n-max") + 1] == "64"


def test_switches_to_overrides_routes_unknown_to_extra_flags():
    # Known keys → typed Overrides fields; any other key → a raw passthrough flag
    # in extra_flags (the "new llama.cpp flag, no code" escape the KnobGrid uses).
    from llm_runner.runner.lifecycle import _switches_to_overrides

    ov = _switches_to_overrides({
        "n_cpu_moe": "8",          # known → typed int field
        "flash_attn": "on",        # known → typed value field
        "--top-n-sigma": "0.05",   # unknown → raw flag + value
        "--some-bool-flag": "",    # unknown valueless → just the flag token
    })
    assert ov.n_cpu_moe == 8
    assert ov.flash_attn == "on"
    assert ov.extra_flags == ["--top-n-sigma", "0.05", "--some-bool-flag"]


def test_compose_flags_extra_flags_passthrough(tmp_path):
    # extra_flags reach the spawned argv verbatim (after the typed overrides).
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(extra_flags=["--top-n-sigma", "0.05"]),
    )
    assert flags[flags.index("--top-n-sigma") + 1] == "0.05"


# ── the shared flag intermediate (overrides_to_pairs → render_argv / render_ini) ──
# One normalized (flag, value) list feeds BOTH the spawn argv and the router .ini, so
# they can never drift. These pin: the fit knobs + engine flags + presence + inversions;
# that render_argv of the pairs is exactly the argv prefix compose_flags emits; and the
# ini rendering (`key = value` / `key = true`).

def test_overrides_to_pairs_fit_engine_presence_and_inversions():
    ov = Overrides(
        flash_attn="on", threads=8, mlock=True, no_mmap=True,
        cont_batching=False, context_shift=True, spec_type="draft-mtp", spec_n_max=3,
    )
    d = dict(overrides_to_pairs(ov, n_gpu_layers=20, n_cpu_moe=4, ctx_len=4096))
    assert d["n-gpu-layers"] == "20" and d["n-cpu-moe"] == "4" and d["ctx-size"] == "4096"
    assert d["flash-attn"] == "on" and d["threads"] == "8"
    assert d["mlock"] is None and d["no-mmap"] is None      # presence flags
    assert d["no-cont-batching"] is None                    # cont_batching=False → the OFF switch
    assert d["context-shift"] is None and "no-context-shift" not in d  # context_shift=True → the ON flag
    assert d["spec-type"] == "draft-mtp" and d["spec-draft-n-max"] == "3"


def test_overrides_to_pairs_omits_moe_when_zero_and_spec_none_clears():
    d = dict(overrides_to_pairs(Overrides(spec_type="none"), n_gpu_layers=0, n_cpu_moe=0, ctx_len=2048))
    assert "n-cpu-moe" not in d          # 0 → omitted
    assert "spec-type" not in d          # "none" → cleared
    assert d["n-gpu-layers"] == "0"


def test_render_argv_is_exact_argv_prefix_of_compose_flags(tmp_path):
    # The .ini path and the spawn path share ONE renderer: render_argv(pairs) must be
    # exactly the leading argv compose_flags emits for the same overrides + fit.
    ov = Overrides(flash_attn="on", cache_type_k="q8_0", mlock=True, cont_batching=False)
    argv = render_argv(overrides_to_pairs(ov, n_gpu_layers=10, n_cpu_moe=2, ctx_len=4096))
    composed = compose_flags(tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=2, ctx_len=4096, overrides=ov)
    assert composed[: len(argv)] == argv                    # render_argv output IS the prefix
    assert composed[len(argv):] == ["-m", str(tmp_path / "m.gguf"),
                                    "--host", DEFAULT_HOST, "--port", str(DEFAULT_PORT)]


def test_render_ini_emits_key_value_and_bare_true():
    ov = Overrides(flash_attn="on", mlock=True, cont_batching=False)
    lines = set(render_ini(overrides_to_pairs(ov, n_gpu_layers=20, n_cpu_moe=0, ctx_len=4096)).splitlines())
    assert {"n-gpu-layers = 20", "ctx-size = 4096", "flash-attn = on"} <= lines
    assert "mlock = true" in lines and "no-cont-batching = true" in lines  # presence → `= true`
    assert not any(line.startswith("n-cpu-moe") for line in lines)          # omitted when 0


def test_overrides_to_pairs_new_flags_render_in_both_paths():
    # model-draft (Gemma-style external MTP) rides the ONE shared pairs list, so the spawn
    # argv and the router .ini get it from the same source. The reasoning-budget flags are
    # RETIRED from the launch profile (U2-T4, 2026-07-14): even set on Overrides they no
    # longer render — the engine launches at -1 and the per-request `reasoning_budget_tokens`
    # (from the ONE resolver) carries the hardware cap instead.
    msg = "Taking user constraints into account, I will now output the solution."
    ov = Overrides(
        spec_type="draft-mtp", spec_n_max=2, model_draft="/models/MTP/g-Q4_0-MTP.gguf",
        reasoning_budget=1024, reasoning_budget_message=msg,
    )
    pairs = overrides_to_pairs(ov, n_gpu_layers=99, n_cpu_moe=37, ctx_len=32768)
    d = dict(pairs)
    assert d["model-draft"] == "/models/MTP/g-Q4_0-MTP.gguf"
    assert d["spec-type"] == "draft-mtp" and d["spec-draft-n-max"] == "2"
    # reasoning-budget + its message RETIRED as launch flags — not emitted even when set.
    assert "reasoning-budget" not in d and "reasoning-budget-message" not in d
    argv = render_argv(pairs)
    assert argv[argv.index("--model-draft") + 1] == "/models/MTP/g-Q4_0-MTP.gguf"
    assert "--reasoning-budget" not in argv and "--reasoning-budget-message" not in argv
    ini_lines = render_ini(pairs).splitlines()
    assert not any(line.startswith("reasoning-budget") for line in ini_lines)


def test_new_flags_absent_when_unset():
    d = dict(overrides_to_pairs(Overrides(), n_gpu_layers=1, n_cpu_moe=0, ctx_len=2048))
    assert "model-draft" not in d
    assert "reasoning-budget" not in d and "reasoning-budget-message" not in d


# ── router mode: emit_models_ini + compose_router_argv ─────────────────────────

def test_emit_models_ini_chat_and_embed_sections():
    ini = emit_models_ini([
        ModelIniEntry("chat", "/m/chat.gguf", n_gpu_layers=20, n_cpu_moe=4, ctx_len=4096,
                      overrides=Overrides(flash_attn="on", mlock=True)),
        ModelIniEntry("embed", "/m/embed.gguf", n_gpu_layers=99, n_cpu_moe=0, ctx_len=2048,
                      embeddings=True, pooling="last", load_on_startup=True),
    ])
    assert "[chat]" in ini and "[embed]" in ini
    assert "model = /m/chat.gguf" in ini
    assert "n-gpu-layers = 20" in ini and "n-cpu-moe = 4" in ini
    assert "flash-attn = on" in ini and "mlock = true" in ini
    embed_block = ini.split("[embed]")[1]
    # pooling is per-model now (#119): the entry carries it explicitly (here "last" for a
    # decoder-based embed like qwen3), NOT a hardcoded "mean".
    assert "embeddings = true" in embed_block and "pooling = last" in embed_block
    assert "load-on-startup = true" in embed_block
    chat_block = ini.split("[chat]")[1].split("[embed]")[0]
    assert "embeddings = true" not in chat_block and "load-on-startup" not in chat_block


def test_emit_models_ini_omits_pooling_when_unset():
    # pooling="" (the default) → NO `pooling =` line, so llama.cpp reads the GGUF's
    # pooling_type (#119). The runner sets it per-model from the catalog; unset = omit.
    ini = emit_models_ini([
        ModelIniEntry("embed", "/m/embed.gguf", n_gpu_layers=99, n_cpu_moe=0, ctx_len=2048,
                      embeddings=True),
    ])
    embed_block = ini.split("[embed]")[1]
    assert "embeddings = true" in embed_block
    assert "pooling" not in embed_block   # unset → omitted, not forced to mean


def test_emit_models_ini_renders_extra_flags():
    ini = emit_models_ini([
        ModelIniEntry("m", "/m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
                      overrides=Overrides(extra_flags=["--top-n-sigma", "0.05", "--some-toggle"])),
    ])
    assert "top-n-sigma = 0.05" in ini      # value flag parsed
    assert "some-toggle = true" in ini      # bare toggle → = true


def test_emit_models_ini_empty_is_empty_string():
    assert emit_models_ini([]) == ""


def test_compose_router_argv_no_model_flag():
    argv = compose_router_argv(models_dir="/hf", models_preset="/x/models.ini",
                               models_max=2, sleep_idle_seconds=900, port=8080)
    assert "-m" not in argv                 # ROUTER mode: no single model
    assert argv[argv.index("--models-preset") + 1] == "/x/models.ini"
    assert argv[argv.index("--models-max") + 1] == "2"
    assert argv[argv.index("--sleep-idle-seconds") + 1] == "900"
    assert argv[argv.index("--models-dir") + 1] == "/hf"


def test_compose_router_argv_omits_ttl_when_unset():
    argv = compose_router_argv(models_dir="/hf", models_preset="/x.ini")
    assert "--sleep-idle-seconds" not in argv   # None → omitted (upstream default -1 = off)


def test_overrides_to_pairs_context_shift_false_and_none():
    # The old dual-flag emitted exactly ONE of --context-shift / --no-context-shift when
    # set, and NEITHER when None. Pin both to lock the refactor's equivalence.
    false_pairs = overrides_to_pairs(Overrides(context_shift=False), n_gpu_layers=1, n_cpu_moe=0, ctx_len=2048)
    d_false = dict(false_pairs)
    assert d_false["no-context-shift"] is None and "context-shift" not in d_false
    argv_false = render_argv(false_pairs)
    assert "--no-context-shift" in argv_false and "--context-shift" not in argv_false
    assert "no-context-shift = true" in render_ini(false_pairs)
    d_none = dict(overrides_to_pairs(Overrides(), n_gpu_layers=1, n_cpu_moe=0, ctx_len=2048))
    assert "context-shift" not in d_none and "no-context-shift" not in d_none  # None → NEITHER


def test_overrides_to_pairs_spec_type_without_n_max():
    d = dict(overrides_to_pairs(Overrides(spec_type="draft-mtp"), n_gpu_layers=1, n_cpu_moe=0, ctx_len=2048))
    assert d["spec-type"] == "draft-mtp"
    assert "spec-draft-n-max" not in d and "spec-ngram-mod-n-max" not in d


def test_emit_models_ini_extra_flag_negative_value():
    # A negative-number VALUE must be consumed as the flag's value, not split as a flag.
    ini = emit_models_ini([
        ModelIniEntry("m", "/m.gguf", n_gpu_layers=1, n_cpu_moe=0, ctx_len=2048,
                      overrides=Overrides(extra_flags=["--dry-multiplier", "-0.5", "--bare"])),
    ])
    assert "dry-multiplier = -0.5" in ini    # negative value kept with its flag
    assert "bare = true" in ini              # trailing bare toggle
    assert "-0.5 = true" not in ini          # NOT misparsed as its own flag


# ── start_runner (probe + OOM back-off; subprocess injected) ───────────────────

class _FakeProc:
    def __init__(self, exit_code=None, output=""):
        self._code = exit_code  # None == still running
        self._output = output
        self.killed = False

    def poll(self):
        return self._code

    def communicate(self, timeout=None):
        return (self._output, None)

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return self._code

    def terminate(self):
        pass


def _fit():
    return FitPlan(n_gpu_layers=20, n_cpu_moe=0, ctx_len=4096, block_count=48, is_moe=True)


def test_start_runner_healthy_first_try():
    fit = _fit()
    spawned = []

    def popen(argv, **k):
        spawned.append(argv)
        return _FakeProc(exit_code=None)  # alive

    r = start_runner(
        "llama-server", "m.gguf", fit,
        _popen=popen, _health=lambda u: True, _sleep=lambda s: None,
    )
    assert isinstance(r, Runner) and r.is_alive()
    assert r.n_gpu_layers == 20
    assert len(spawned) == 1


def test_start_runner_backs_off_on_oom():
    fit = _fit()
    procs = [
        _FakeProc(exit_code=1, output="ggml_cuda: CUDA error: out of memory"),  # OOM exit
        _FakeProc(exit_code=None),                                              # then healthy
    ]
    state = {"n": 0}

    def popen(argv, **k):
        p = procs[state["n"]]
        state["n"] += 1
        return p

    r = start_runner(
        "llama-server", "m.gguf", fit, backoff_step=4,
        _popen=popen, _health=lambda u: state["n"] >= 2, _sleep=lambda s: None,
    )
    assert state["n"] == 2          # spawned twice
    assert r.n_gpu_layers == 16     # 20 − 4
    assert r.n_cpu_moe == fit.block_count - 16  # MoE offload recomputed on back-off
    assert procs[0].killed          # first attempt cleaned up


def test_start_runner_raises_on_non_oom():
    fit = _fit()

    def popen(argv, **k):
        return _FakeProc(exit_code=1, output="fatal: model file not found")

    with pytest.raises(RunnerStartError):
        start_runner(
            "llama-server", "m.gguf", fit,
            _popen=popen, _health=lambda u: False, _sleep=lambda s: None,
        )


# ── spawn diagnostics (log file + exit code + tail) ────────────────────────────

def test_tail_file_returns_last_lines(tmp_path):
    p = tmp_path / "runner.log"
    p.write_text("\n".join(f"line {i}" for i in range(100)))
    assert _tail_file(p, max_lines=3).splitlines() == ["line 97", "line 98", "line 99"]
    assert _tail_file(tmp_path / "nope.log") == ""  # missing → empty, not a crash


def test_start_runner_error_reports_exit_code():
    # A self-exited llama-server (e.g. a missing DLL on Windows) surfaces its exit
    # code + captured output, not a bare "failed".
    def popen(argv, **k):
        return _FakeProc(exit_code=3221225781, output="error while loading shared libraries")

    with pytest.raises(RunnerStartError) as ei:
        start_runner("llama-server", "m.gguf", _fit(),
                     _popen=popen, _health=lambda u: False, _sleep=lambda s: None)
    msg = str(ei.value)
    assert "exit 3221225781" in msg
    assert "error while loading shared libraries" in msg


def test_start_runner_hang_reports_still_running():
    # A hang (never healthy, never exits) reports "still running" — the case the
    # old empty-tail message could not distinguish from a crash.
    times = iter([0.0, 0.0, 1000.0])  # deadline calc, first check, then past deadline

    def popen(argv, **k):
        return _FakeProc(exit_code=None, output="")  # alive the whole time

    with pytest.raises(RunnerStartError) as ei:
        start_runner("llama-server", "m.gguf", _fit(),
                     _popen=popen, _health=lambda u: False, _sleep=lambda s: None,
                     _now=lambda: next(times))
    assert "still running" in str(ei.value)


def test_start_runner_redirects_to_log_and_cites_path(tmp_path):
    # With log_path set, output is redirected to that file and the failure cites
    # the log path so the user can open it.
    log_path = tmp_path / "logs" / "runner.log"

    def popen(argv, **k):
        assert "stdout" in k  # redirected to the file, not a pipe we drain
        return _FakeProc(exit_code=1, output="")

    with pytest.raises(RunnerStartError) as ei:
        start_runner("llama-server", "m.gguf", _fit(), log_path=log_path,
                     _popen=popen, _health=lambda u: False, _sleep=lambda s: None)
    assert f"[log: {log_path}]" in str(ei.value)
    assert log_path.exists()  # start_runner created the dir + opened the file


def test_start_runner_backs_off_on_oom_via_log(tmp_path):
    # On the file-redirect path (the one _run_load actually uses), the OOM signal
    # is read from the LOG-FILE tail, not a pipe. First attempt writes an OOM line
    # into the redirected log → back-off → second attempt healthy.
    log_path = tmp_path / "logs" / "runner.log"
    procs = [_FakeProc(exit_code=1), _FakeProc(exit_code=None)]  # OOM exit, then alive
    state = {"n": 0}

    def popen(argv, **k):
        if state["n"] == 0:
            k["stdout"].write(b"ggml_cuda: CUDA error: out of memory")  # into the log file
            k["stdout"].flush()
        p = procs[state["n"]]
        state["n"] += 1
        return p

    r = start_runner("llama-server", "m.gguf", _fit(), backoff_step=4, log_path=log_path,
                     _popen=popen, _health=lambda u: state["n"] >= 2, _sleep=lambda s: None)
    assert state["n"] == 2           # spawned twice: the log-tail OOM drove the retry
    assert r.n_gpu_layers == 16      # 20 − 4


# ── 1b fit-by-omission: None fit knobs render nothing; ctx policy stays ours ──

def test_overrides_to_pairs_omits_none_fit_knobs():
    # An untuned model emits NO placement flags — the engine's default `--fit`
    # (in-pin since b9870) places tensors; ctx-size is ALWAYS ours to pin.
    d = dict(overrides_to_pairs(Overrides(), n_gpu_layers=None, n_cpu_moe=None, ctx_len=8192))
    assert "n-gpu-layers" not in d and "n-cpu-moe" not in d
    assert d["ctx-size"] == "8192"


def test_overrides_to_pairs_explicit_zero_ngl_still_renders():
    # ngl=0 (explicit CPU-only) is a VALUE, not an omission.
    d = dict(overrides_to_pairs(Overrides(), n_gpu_layers=0, n_cpu_moe=None, ctx_len=4096))
    assert d["n-gpu-layers"] == "0"


def test_compute_fit_explicit_flags_follow_overrides():
    explicit = compute_fit(
        _meta(block_count=30, expert_count=128), _TEN_GB, _hw(vram_mb=8192),
        Overrides(n_gpu_layers=99, n_cpu_moe=21, ctx_len=32768),
    )
    assert explicit.ngl_explicit and explicit.ncmoe_explicit and explicit.ctx_explicit
    assert explicit.ctx_len == 32768
    computed = compute_fit(_meta(block_count=30, expert_count=128), _TEN_GB, _hw(vram_mb=8192))
    assert not computed.ngl_explicit and not computed.ncmoe_explicit and not computed.ctx_explicit


def test_computed_ctx_caps_at_trained_window():
    # A huge card cannot push ctx past the model's trained window.
    meta = _meta(block_count=10)
    meta.context_length = 8192
    plan = compute_fit(meta, _TEN_GB, _hw(vram_mb=96000))
    assert plan.ctx_len <= 8192


def test_kv_affordable_bounds_and_monotonic():
    from llm_runner.runner import fit as fitmod
    floor = fitmod.kv_affordable(vram_budget_mb=0, n_layers=30, n_kv_heads=8, cache_type=8)
    roof = fitmod.kv_affordable(vram_budget_mb=1e9, n_layers=30, n_kv_heads=8, cache_type=8)
    assert floor == 4096 and roof == 262144
    prev = 0
    for budget in (0, 1000, 4000, 16000, 64000):
        ctx = fitmod.kv_affordable(vram_budget_mb=budget, n_layers=30, n_kv_heads=8, cache_type=8)
        assert ctx >= prev
        prev = ctx


def test_kv_term_single_source_no_drift():
    # 1b-F3: `_slope_offset`'s KV term must BE `_C1 × kv_bytes_per_token × ctx` — the
    # slope delta across two ctx values equals the helper-derived delta exactly, pinning
    # both consumers to the ONE extracted factor.
    from llm_runner.runner import fit as fitmod
    a1 = fitmod._slope_offset(1000, 10, 8, 2048, 4096, 8)[0]
    a2 = fitmod._slope_offset(1000, 10, 8, 2048, 8192, 8)[0]
    expected = fitmod._C1 * fitmod.kv_bytes_per_token(8, 8) * (8192 - 4096)
    assert abs((a2 - a1) - expected) < 1e-9


# ── Phase 4: the ONE spawn seam + the Windows kill-on-close Job Object (A3) ──

def test_spawn_child_seam_wiring_and_no_job_off_windows():
    # The seam builds the Popen with the shared stdout/stderr wiring; off-Windows
    # the job handle is None (the orphan fix is win32-only by construction).
    import subprocess as sp
    from llm_runner.runner.process import _spawn_child

    calls = {}

    def fake_popen(argv, **kw):
        calls["argv"] = argv
        calls["kw"] = kw
        return object()

    proc, job = _spawn_child(fake_popen, ["exe", "--flag"], None)
    assert job is None
    assert calls["argv"] == ["exe", "--flag"]
    assert calls["kw"]["stdout"] is sp.PIPE and calls["kw"]["text"] is True

    logf = object()
    _spawn_child(fake_popen, ["exe"], logf)
    assert calls["kw"]["stdout"] is logf and "text" not in calls["kw"]


def test_win_job_degrades_gracefully_without_windll(monkeypatch):
    # The job is a SAFETY NET: on a (faked) win32 platform where the ctypes calls
    # fail (no windll on Linux), the spawn must still succeed with job=None —
    # never block a spawn. The real kill-on-parent-death is a §G box check.
    from llm_runner.runner import process as proc_mod

    monkeypatch.setattr(proc_mod.sys, "platform", "win32")
    fake = type("P", (), {"_handle": 123})()
    assert proc_mod._win_job_for_child(fake) is None


def test_stop_closes_the_retained_job_handle(monkeypatch):
    # stop() must close the retained handle (under KILL_ON_JOB_CLOSE that is what
    # guarantees the child tree dies with us) — recorded via a patched closer.
    from llm_runner.runner import process as proc_mod

    closed = []
    monkeypatch.setattr(proc_mod, "_close_job", lambda j: closed.append(j))

    class FakeProc:
        def poll(self):
            return None

        def terminate(self):
            pass

    sentinel = object()
    h = proc_mod.Runner(process=FakeProc(), url="http://x", n_gpu_layers=1, n_cpu_moe=0,
                        job_handle=sentinel)
    h.stop()
    assert closed == [sentinel]
