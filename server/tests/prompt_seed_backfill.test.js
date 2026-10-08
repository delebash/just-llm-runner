// SPDX-License-Identifier: MIT
// Port of tests/test_prompt_seed_backfill.py — nav-metadata backfill on prompt reseed
// (parity batch 2026-08-06). A seed revision may ADD label/description to a row that
// predates them (the approved copy landing on live DBs). The backfill fills ONLY rows
// whose stored label+description are both empty — a row anyone named keeps its name, and
// non-built-in rows are never touched.
import { afterEach, expect, test, vi } from "vitest";
import * as db from "../src/llm/db.js";
import * as seed from "../src/llm/seed.js";
import { freshDb } from "./helpers.js";

// Interim: wave-2 modules, stood in only while their file is missing
// (fixtures/wave-stubs.js explains the raw-specifier keys).
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

function seedWith(prompts) {
  seed.configureAppSeed({ featurePrompts: prompts });
  const s = db.session();
  s.tx(() => seed.seedDefaultFeaturePrompts(s));
}

const row = (key) => db.session().get("feature_prompts", key);

afterEach(() => seed.configureAppSeed({ featurePrompts: {} }));

test("backfill_fills_empty_nav_metadata_only", () => {
  freshDb();
  // v1 of the seed: no labels yet — rows land with empty nav metadata.
  seedWith({
    "attr.guided": { feature: "attr", system: "S1", user_template: "U" },
    "attr.named": { feature: "attr", system: "S2", user_template: "U" },
  });
  expect(row("attr.guided").label).toBe("");

  // The user names one row via the editor (label survives everything).
  db.session().update("feature_prompts", { label: "My name" }, { key: "attr.named" });

  // v2 of the seed carries the approved copy — reseed (same DB).
  seedWith({
    "attr.guided": {
      feature: "attr",
      system: "S1",
      user_template: "U",
      label: "Reading instructions",
      description: "What the AI is told.",
    },
    "attr.named": { feature: "attr", system: "S2", user_template: "U", label: "Seed name", description: "Seed words." },
  });
  const filled = row("attr.guided");
  expect(filled.label).toBe("Reading instructions");
  expect(filled.description).toBe("What the AI is told.");
  // The named row keeps the user's name — backfill is empty-only.
  const named = row("attr.named");
  expect(named.label).toBe("My name");
  expect(named.description).toBe("");
});

test("backfill_skips_non_builtin_rows", () => {
  freshDb();
  seedWith({});
  db.session().insert("feature_prompts", {
    key: "user.own",
    feature: "own",
    system: "S",
    user_template: "U",
    built_in: false,
    label: "",
    description: "",
  });

  seedWith({
    "user.own": { feature: "own", system: "S", user_template: "U", label: "Seed label", description: "Seed words." },
  });
  expect(row("user.own").label).toBe("");
});
