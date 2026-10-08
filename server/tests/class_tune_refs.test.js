// SPDX-License-Identifier: MIT
// Port of tests/test_class_tune_refs.py — the class-config recommendation refs + the
// class-key override (§9 final ruled shape, 2026-07-22): the hidden class→model pick table
// is DELETED — the recommendation IS the visible class-tunes library. `listClassTuneRefs()`
// serves the distinct (model, class) pairs on the catalog response; the
// `class_key_override` setting decides which class this box FILES UNDER ("detection
// proposes, never dictates"). Pure data; no GPU needed.
//
// `override_wins_at_the_choke_point` reaches `llm/install.js`'s `_currentClassKey` (wave 4,
// the integrator's): it is written against that name and skips until the file exists.
import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as db from "../src/llm/db.js";
import { CatalogResponse, ClassTuneRef } from "../src/llm/model_catalog_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { model } from "../src/platform/models.js";
import { freshDb } from "./helpers.js";

const INSTALL = new URL("../src/llm/install.js", import.meta.url);

// Since decision ④ (2026-08-05) the shared DEFAULT_CLASS_TUNES is EMPTY — class tunes are
// the APP's registration (installLlm classTunesSeed; JW carries the family's 13 measured
// rows). The refs MECHANISM is what this file tests, so the fixture registers a small app set
// of its own: a seven-flag config, a second class for the same model, a ONE-flag config
// (proving one ref per (model, class), never per flag), and a second model.
const APP_TUNES = [
  {
    model_id: "flagship",
    class_key: "dgpu-vram8|ram32",
    switches: {
      n_gpu_layers: "99",
      n_cpu_moe: "21",
      ctx_len: "32768",
      batch_size: "512",
      ubatch_size: "512",
      threads: "8",
      reasoning_budget: "1024",
    },
  },
  { model_id: "flagship", class_key: "igpu-mem32", switches: { n_gpu_layers: "99", ctx_len: "32768", flash_attn: "off" } },
  { model_id: "styletune", class_key: "dgpu-vram8|ram32", switches: { spec_type: "none" } },
  { model_id: "small", class_key: "igpu-mem16", switches: { n_gpu_layers: "99", ctx_len: "32768" } },
];

beforeEach(() => {
  const h = freshDb();
  seed.configureAppSeed({ classTunesSeed: APP_TUNES });
  h.tx(() => seed.seedDefaultClassTunes(h));
});
afterEach(() => {
  seed.configureAppSeed({ classTunesSeed: [] }); // never leak into sibling tests
});

test("refs_are_distinct_model_class_pairs", () => {
  // Each registered config holds one-to-many flag rows — exactly ONE ref per (model, class)
  // comes out (distinct pairs, not one ref per flag; the one-flag styletune row proves it).
  // Order = SQLite DISTINCT's (model_id, class_key) sort.
  expect(stores.listClassTuneRefs()).toEqual([
    { modelId: "flagship", classKey: "dgpu-vram8|ram32" },
    { modelId: "flagship", classKey: "igpu-mem32" },
    { modelId: "small", classKey: "igpu-mem16" },
    { modelId: "styletune", classKey: "dgpu-vram8|ram32" },
  ]);
});

test("a_manually_authored_class_becomes_a_ref", () => {
  // §9: manual class authoring is first-class — a config saved for hardware the author does
  // NOT own (a discrete 20 GB / 100 GB box) is a recommendation ref.
  const h = db.session();
  h.tx(() => {
    for (const [fname, fval] of [
      ["n_gpu_layers", "99"],
      ["ctx_len", "65536"],
    ]) {
      h.insert("class_tunes", { model_id: "m-big", class_key: "dgpu-vram20|ram100", flag_name: fname, flag_value: fval, built_in: false });
    }
  });
  const refs = stores.listClassTuneRefs();
  expect(refs).toContainEqual({ modelId: "m-big", classKey: "dgpu-vram20|ram100" });
  expect(refs).toHaveLength(5); // the 4 registered app configs + the manual one
});

test("catalog_response_carries_refs_and_my_class", () => {
  const resp = model(CatalogResponse, {
    rows: [],
    myClassKey: "dgpu-vram8|ram32",
    classTuneRefs: stores.listClassTuneRefs().map((r) => model(ClassTuneRef, r)),
  });
  expect(resp.myClassKey).toBe("dgpu-vram8|ram32");
  // The wire shape is what's under test — a registered (model, class) pair rides the
  // response (membership, not position — DISTINCT's sort owns the order).
  expect(resp.classTuneRefs.map((r) => [r.modelId, r.classKey])).toContainEqual(["flagship", "dgpu-vram8|ram32"]);
});

test("override_absent_or_blank_means_auto", () => {
  expect(stores.getClassKeyOverride()).toBe("");
});

test.skipIf(!existsSync(INSTALL))("override_wins_at_the_choke_point", async () => {
  // installLlm's _currentClassKey is THE one accessor every class-key consumer reads through
  // (resolve layers, class-tunes router, catalog response, tune badges). A set override
  // short-circuits detection entirely — no hardware probe runs.
  const { _currentClassKey } = await import("../src/llm/install.js");
  stores.getRunnerConfigStore().setSetting("class_key_override", "dgpu-vram20|ram100");
  expect(stores.getClassKeyOverride()).toBe("dgpu-vram20|ram100");
  expect(_currentClassKey()).toBe("dgpu-vram20|ram100");
});
