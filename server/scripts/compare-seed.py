# SPDX-License-Identifier: MIT
"""The Python half of scripts/compare-seed.mjs (run it through that script).

  compare-seed.py dump <out.json>              JustWrite's registered app seed as JSON
                                               (floats marked {"$float": x} so JavaScript
                                               keeps them floats) + ids the ops refer to
  compare-seed.py run <dir> <ops.json>         Python seeds <dir>/py-1.db, applies the
                                               mutations + reseeds (py-2.db), replays the
                                               store ops (py-3.db)
  compare-seed.py compare <a.db> <b.db>        every table's DDL + every cell (rowid order,
                                               SQLite's quote() — type and bytes) compared
  compare-seed.py reads <db> <out.json>        every store read + module getter, as JSON
  compare-seed.py compare-reads <a> <b>        two reads files compared (key order, bool vs
                                               number, null)

Needs a Python with the kit's dependencies and JustWrite's server importable
(../justwrite-app/.venv)."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

KIT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(KIT))
sys.path.insert(0, str(KIT.parent / "justwrite-app" / "server"))
sys.stdout.reconfigure(encoding="utf-8")


def _app_seed():
    from justwrite_server.feature_catalog import FEATURE_CATALOG
    from justwrite_server.seed_feature_prompts import DEFAULT_FEATURE_PROMPTS, FEATURE_PROMPT_HEALS
    from justwrite_server.seed_presets import (
        DEFAULT_ENGINE_PRESETS,
        DEFAULT_FEATURE_PRESETS,
        DEFAULT_MODEL_CATALOG_EXTRA,
        DEFAULT_PRESET_ID,
        DEFAULT_TEST_SAMPLES,
        JW_CLASS_TUNE_IDENTITY,
        JW_CLASS_TUNES,
        JW_CURATED_CATALOG,
        JW_EMBED_TEMPLATES,
    )

    catalog = [*DEFAULT_MODEL_CATALOG_EXTRA, *JW_CURATED_CATALOG]
    return {
        "feature_catalog": [vars(e) for e in FEATURE_CATALOG],
        "feature_prompts": DEFAULT_FEATURE_PROMPTS,
        "engine_presets": DEFAULT_ENGINE_PRESETS,
        "feature_presets": DEFAULT_FEATURE_PRESETS,
        "default_preset_id": DEFAULT_PRESET_ID,
        "model_catalog_extra": catalog,
        "class_tunes_seed": JW_CLASS_TUNES,
        "class_tune_identity": JW_CLASS_TUNE_IDENTITY,
        "embed_templates": JW_EMBED_TEMPLATES,
        "test_samples": DEFAULT_TEST_SAMPLES,
        "feature_prompt_heals": FEATURE_PROMPT_HEALS,
        # Not in JustWrite's call — added so the per-machine tune seed runs too (a float
        # 1.0 among its values, which str() writes "1.0").
        "model_tunes_seed": [{"model_id": catalog[0]["id"],
                              "flags": {"n_cpu_moe": 3, "flash_attn": "on", "ratio": 1.0, "share": 0.25}}],
    }


def _mark(v):
    if isinstance(v, float):
        return {"$float": v}
    if isinstance(v, dict):
        return {str(k): _mark(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_mark(x) for x in v]
    return v


def dump(out: str) -> None:
    app = _app_seed()
    refs = {
        "preset": app["default_preset_id"],
        "presets": [p["id"] for p in app["engine_presets"]],
        "catalog": [c["id"] for c in app["model_catalog_extra"]],
        "embed": [t["id"] for t in app["embed_templates"]],
        "prompt": next(iter(app["feature_prompts"])),
        "actions": list(app["feature_presets"]),
    }
    Path(out).write_text(json.dumps({"app": _mark(app), "refs": refs}, ensure_ascii=False, indent=1), encoding="utf-8")


def _configure(path: Path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from llm_runner.llm import db

    engine = create_engine(f"sqlite:///{path}")
    db.create_all(engine)
    db.configure_storage(sessionmaker(bind=engine, autocommit=False, autoflush=False))
    return engine


def run(d: str, ops_file: str) -> None:
    from llm_runner.llm import seed, stores
    from llm_runner.llm.model_catalog_api import CatalogRow
    from llm_runner.llm.model_measurements_api import MeasurementFlag
    from llm_runner.llm.model_tunes_api import ModelTuneFlag
    from llm_runner.llm.class_tunes_api import ClassTuneFlag
    from llm_runner.llm.embed_templates_api import EmbedTemplateRow
    from llm_runner.llm.presets_api import EnginePresetRow
    from llm_runner.llm.pricing_api import PricingRow
    from llm_runner.llm.prompts import FeaturePromptRow
    from llm_runner.llm.reasoning_map_api import ReasoningLevelRow
    from llm_runner.llm.routing_api import RoutingConfig
    from llm_runner.llm.runner_config_api import RunnerBinaryRow
    from llm_runner.llm.schema import LLMProviderConfig
    from llm_runner.llm.switch_presets_api import SwitchPresetRow

    d = Path(d)
    spec = json.loads(Path(ops_file).read_text(encoding="utf-8"))
    db_path = d / "py.db"
    engine = _configure(db_path)
    app = _app_seed()
    seed.configure_app_seed(
        feature_catalog=app["feature_catalog"], feature_prompts=app["feature_prompts"],
        engine_presets=app["engine_presets"], feature_presets=app["feature_presets"],
        default_preset_id=app["default_preset_id"], model_catalog_extra=app["model_catalog_extra"],
        model_tunes_seed=app["model_tunes_seed"], hw_key_fn=lambda: "cmp-hw",
        test_samples=app["test_samples"], feature_prompt_heals=app["feature_prompt_heals"],
        class_tunes_seed=app["class_tunes_seed"], class_tune_identity=app["class_tune_identity"],
        embed_templates=app["embed_templates"],
    )
    seed.seed_llm()
    engine.dispose()
    shutil.copyfile(db_path, d / "py-1.db")

    engine = _configure(db_path)
    with engine.begin() as c:
        for sql in spec["mutations"]:
            c.exec_driver_sql(sql)
    seed.seed_llm()
    engine.dispose()
    shutil.copyfile(db_path, d / "py-2.db")

    engine = _configure(db_path)
    st = stores
    for op, *args in spec["ops"]:
        if op == "provider.add":
            st.get_provider_store().add(LLMProviderConfig(**args[0]))
        elif op == "provider.replace":
            st.get_provider_store().replace(args[0], LLMProviderConfig(**args[1]))
        elif op == "provider.remove":
            st.get_provider_store().remove(args[0])
        elif op == "routing.set":
            st.get_routing_store().set_routing(RoutingConfig(**args[0]))
        elif op == "prompt.upsert":
            st.get_prompt_store().upsert(FeaturePromptRow(**args[0]))
        elif op == "catalog.upsert":
            st.get_model_catalog_store().upsert(CatalogRow(**args[0]))
        elif op == "catalog.setType":
            st.get_model_catalog_store().set_type(*args)
        elif op == "catalog.setDerived":
            k = args[1]
            st.get_model_catalog_store().set_derived(
                args[0], model_type=k["modelType"], mtp_builtin=k["mtpBuiltin"], trained_ctx=k["trainedCtx"],
                total_params=k.get("totalParams"), samplers=k.get("samplers"), architecture=k.get("architecture"),
                experts=k.get("experts"), size_label=k.get("sizeLabel"), size_bytes=k.get("sizeBytes"),
                est_vram_mb=k.get("estVramMb"), physics_facts=k.get("physicsFacts"))
        elif op == "catalog.delete":
            st.get_model_catalog_store().delete(args[0])
        elif op == "catalog.reset":
            st.get_model_catalog_store().reset_to_factory()
        elif op == "switchPreset.upsert":
            st.get_switch_preset_store().upsert(SwitchPresetRow(**args[0]))
        elif op == "switchPreset.delete":
            st.get_switch_preset_store().delete(args[0])
        elif op == "switchPreset.reset":
            st.get_switch_preset_store().reset_to_factory()
        elif op == "enginePreset.save":
            st.get_engine_preset_store().save(EnginePresetRow(**args[0]))
        elif op == "enginePreset.delete":
            st.get_engine_preset_store().delete(args[0])
        elif op == "ref.set":
            st.get_feature_preset_ref_store().set(*args)
        elif op == "pricing.upsert":
            st.get_pricing_store().upsert(PricingRow(**args[0]))
        elif op == "pricing.delete":
            st.get_pricing_store().delete(args[0])
        elif op == "reasoning.upsert":
            st.get_reasoning_map_store().upsert(args[0], ReasoningLevelRow(**args[1]))
        elif op == "embed.upsert":
            st.get_embed_template_store().upsert(EmbedTemplateRow(**args[0]))
        elif op == "embed.delete":
            st.get_embed_template_store().delete(args[0])
        elif op == "runner.upsertBinary":
            st.get_runner_config_store().upsert_binary(RunnerBinaryRow(**args[0]))
        elif op == "runner.setSetting":
            st.get_runner_config_store().set_setting(*args)
        elif op == "runner.setCacheRoot":
            st.get_runner_config_store().set_cache_root(args[0])
        elif op == "runner.reset":
            st.get_runner_config_store().reset_to_defaults()
        elif op == "modelTune.replace":
            st.get_model_tune_store().replace(args[0], args[1], [ModelTuneFlag(**r) for r in args[2]],
                                              baseline=args[3])
        elif op == "modelTune.delete":
            st.get_model_tune_store().delete(*args)
        elif op == "classTune.replace":
            st.get_class_tune_store().replace(args[0], args[1], [ClassTuneFlag(**r) for r in args[2]])
        elif op == "classTune.delete":
            st.get_class_tune_store().delete(*args)
        elif op == "hwClass.save":
            st.get_hardware_class_store().save(*args)
        elif op == "hwClass.ensure":
            st.get_hardware_class_store().ensure(*args)
        elif op == "hwClass.delete":
            st.get_hardware_class_store().delete(*args)
        elif op == "sample.upsert":
            st.get_test_sample_store().upsert(*args)
        elif op == "sample.delete":
            st.get_test_sample_store().delete(*args)
        elif op == "measure.record":
            k = args[1]
            st.get_model_measurement_store().record(
                args[0], machine_key=k["machineKey"], source=k["source"], label=k["label"],
                tokens_per_sec=k["tokensPerSec"], vram_total_mb=k["vramTotalMb"], at=k["at"],
                rows=[MeasurementFlag(**r) for r in k["rows"]], vram_model_mb=k.get("vramModelMb", 0),
                kind=k.get("kind", "llm"), realtime_x=k.get("realtimeX", 0.0), backend=k.get("backend"))
        elif op == "measure.prune":
            st.get_model_measurement_store().prune_load_rows(
                args[0], args[1], st.list_fit_relevant_flags(), args[2], source=args[3])
        elif op == "measure.clear":
            st.get_model_measurement_store().clear(*args)
        elif op == "defaultPreset.set":
            st.set_default_preset_id(args[0])
        elif op == "rules.set":
            st.set_model_list_rules(args[0])
        elif op == "rules.reset":
            st.reset_model_list_rules()
        elif op == "seed.resetRouting":
            seed.reset_routing_to_factory()
        elif op == "seed.resetPreset":
            seed.reset_preset_to_factory(args[0])
        elif op == "seed.llm":
            seed.seed_llm()
        else:
            raise SystemExit(f"unknown op {op}")
    engine.dispose()
    shutil.copyfile(db_path, d / "py-3.db")


def _plain(v):
    """A read's answer as JSON data: pydantic models by their wire names, dataclasses as
    dicts, sets sorted, tuples as lists."""
    import dataclasses

    from pydantic import BaseModel

    if isinstance(v, BaseModel):
        return _plain(v.model_dump(by_alias=True))
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return _plain(dataclasses.asdict(v))
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, (set, frozenset)):
        return sorted(_plain(x) for x in v)
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return v


def reads(db_file: str, out: str) -> None:
    """Every store read + module getter, on an already-written database."""
    from llm_runner.llm import stores as st

    _configure(Path(db_file))
    r = {
        "provider.list": st.get_provider_store().list(),
        "provider.get": st.get_provider_store().get("tmp-a"),
        "provider.get.none": st.get_provider_store().get("nope"),
        "routing.get": st.get_routing_store().get_routing(),
        "prompt.list": st.get_prompt_store().list(),
        "prompt.get": st.get_prompt_store().get("x.new"),
        "catalog.list": st.get_model_catalog_store().list(),
        "switchPreset.list": st.get_switch_preset_store().list(),
        "enginePreset.list": st.get_engine_preset_store().list(),
        "ref.list": st.get_feature_preset_ref_store().list(),
        "pricing.list": st.get_pricing_store().list(),
        "pricing.asMap": st.get_pricing_store().as_map(),
        "reasoning.openai": st.get_reasoning_map_store().for_provider("openai"),
        "reasoning.local": st.get_reasoning_map_store().map_for("local-llamacpp"),
        "reasoning.new": st.get_reasoning_map_store().for_provider("new-prov"),
        "embed.list": st.get_embed_template_store().list(),
        "embed.get": st.get_embed_template_store().get(" m-e "),
        "runner.getConfig": st.get_runner_config_store().get_config(),
        "runner.cacheRoot": [st.get_runner_config_store().get_cache_root(),
                             st.get_runner_config_store().cache_root_chosen()],
        "modelTune.get": st.get_model_tune_store().get("m1", "hw1"),
        "modelTune.baseline": st.get_model_tune_store().get_baseline("m1", "hw1"),
        "modelTune.baseline.none": st.get_model_tune_store().get_baseline("zz", "hw1"),
        "modelTune.forMachine": st.get_model_tune_store().list_for_machine("hw1"),
        "classTune.listAll": st.get_class_tune_store().list_all(),
        "hwClass.listAll": st.get_hardware_class_store().list_all(),
        "hwClass.bwFor": [st.get_hardware_class_store().bw_for("dgpu-vram11|ram32"),
                          st.get_hardware_class_store().bw_for("nope")],
        "sample.all": st.get_test_sample_store().list_for_action(),
        "sample.act2": st.get_test_sample_store().list_for_action("act2"),
        "measure.all": st.get_model_measurement_store().list(),
        "measure.m1": st.get_model_measurement_store().list("m1"),
        "fitRelevant": st.list_fit_relevant_flags(),
        "loadRowsKeep": st.load_rows_keep(),
        "defaultPreset": st.get_default_preset_id(),
        "rules": st.get_model_list_rules(),
        "classTuneRefs": st.list_class_tune_refs(),
        "classKeyOverride": st.get_class_key_override(),
        "knobCatalog": st.list_knob_catalog(),
        "knobBackends": st.list_knob_backends(),
        "buildRunnerConfig": st.build_runner_config(),
    }
    Path(out).write_text(json.dumps(_plain(r), ensure_ascii=False), encoding="utf-8")


def _diff(a, b, path, out):
    if isinstance(a, bool) or isinstance(b, bool):
        if type(a) is not type(b) or a != b:
            out.append(f"{path}: {a!r} != {b!r}")
    elif isinstance(a, dict) and isinstance(b, dict):
        if list(a) != list(b):
            out.append(f"{path}: keys {list(a)} != {list(b)}")
        for k in a:
            if k in b:
                _diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: {len(a)} items != {len(b)} items")
        for i, (x, y) in enumerate(zip(a, b)):
            _diff(x, y, f"{path}[{i}]", out)
    elif a != b or (a is None) != (b is None):
        out.append(f"{path}: {a!r:.100} != {b!r:.100}")


def compare_reads(a: str, b: str) -> int:
    ra = json.loads(Path(a).read_text(encoding="utf-8"))
    rb = json.loads(Path(b).read_text(encoding="utf-8"))
    out: list[str] = []
    _diff(ra, rb, "", out)
    for line in out[:40]:
        print("  " + line)
    print(f"  {len(ra)} reads compared, {len(out)} difference(s)")
    return len(out)


def compare(a: str, b: str) -> int:
    import sqlite3

    ca, cb = sqlite3.connect(a), sqlite3.connect(b)
    q = "select name, sql from sqlite_master where type in ('table', 'index') and name not like 'sqlite_%' order by name"
    sa, sb = dict(ca.execute(q).fetchall()), dict(cb.execute(q).fetchall())
    diffs = 0
    tables = cells = 0
    for name in sorted(set(sa) | set(sb)):
        if sa.get(name) != sb.get(name):
            print(f"  DDL differs: {name}")
            diffs += 1
    for (name,) in ca.execute("select name from sqlite_master where type = 'table' order by name").fetchall():
        if name not in sb:
            continue
        cols = [r[1] for r in ca.execute(f'pragma table_info("{name}")')]
        sel = "select rowid, " + ", ".join(f'quote("{c}")' for c in cols) + f' from "{name}" order by rowid'
        ra, rb = ca.execute(sel).fetchall(), cb.execute(sel).fetchall()
        tables += 1
        if len(ra) != len(rb):
            print(f"  {name}: {len(ra)} rows vs {len(rb)} rows")
            diffs += 1
        shown = 0
        for x, y in zip(ra, rb):
            for i, (u, v) in enumerate(zip(x, y)):
                cells += 1
                if u != v:
                    diffs += 1
                    if shown < 5:
                        col = "rowid" if i == 0 else cols[i - 1]
                        print(f"  {name} rowid {x[0]} {col}: {u!s:.120} != {v!s:.120}")
                        shown += 1
    print(f"  {tables} tables, {cells} cells compared, {diffs} difference(s)")
    return diffs


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "dump":
        dump(sys.argv[2])
    elif cmd == "run":
        run(sys.argv[2], sys.argv[3])
    elif cmd == "compare":
        sys.exit(1 if compare(sys.argv[2], sys.argv[3]) else 0)
    elif cmd == "reads":
        reads(sys.argv[2], sys.argv[3])
    elif cmd == "compare-reads":
        sys.exit(1 if compare_reads(sys.argv[2], sys.argv[3]) else 0)
