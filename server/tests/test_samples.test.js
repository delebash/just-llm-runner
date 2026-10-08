// SPDX-License-Identifier: MIT
// Port of tests/test_test_samples.py — the §7.3 Lab test samples: /v1/ai/test-samples CRUD
// (keyed per ACTION, 2026-07-15) + the fill-if-empty seed with author-once fan-out.
import { beforeEach, expect, test } from "vitest";
import * as db from "../src/llm/db.js";
import * as stores from "../src/llm/stores.js";
import { makeTestSamplesRouter } from "../src/llm/test_samples_api.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

let app;
beforeEach(() => {
  freshDb();
  app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(makeTestSamplesRouter(stores.getTestSampleStore));
});
const put = async (payload) => app.inject({ method: "PUT", url: "/v1/ai/test-samples", payload });
const list = async (action) =>
  (await app.inject({ method: "GET", url: `/v1/ai/test-samples?action=${encodeURIComponent(action)}` })).json().rows;

test("put_get_delete_round_trip", async () => {
  const r = (
    await put({
      action: "writerAI.continue",
      label: "Storm scene",
      variables: { passage: "The lighthouse keeper counted the storm's breaths." },
    })
  ).json();
  expect(r.rows).toHaveLength(1);
  const row = r.rows[0];
  expect(row.action).toBe("writerAI.continue");
  expect(row.variables.passage.startsWith("The lighthouse")).toBe(true);
  // action filter: another action sees nothing
  expect(await list("brainstorm")).toEqual([]);
  // upsert by id replaces the variable set wholesale
  const r2 = (
    await put({ id: row.id, action: "writerAI.continue", label: "Storm scene", variables: { passage: "New text.", voiceCanon: "grim" } })
  ).json();
  expect(r2.rows[0].variables).toEqual({ passage: "New text.", voiceCanon: "grim" });
  const d = (await app.inject({ method: "DELETE", url: `/v1/ai/test-samples?id=${row.id}` })).json();
  expect(d.rows).toEqual([]);
});

test("put_requires_action_and_label", async () => {
  expect((await put({ action: " ", label: "x" })).statusCode).toBe(400);
  expect((await put({ action: "k", label: "" })).statusCode).toBe(400);
});

test("seed_fill_fans_actions_and_skips_present", async () => {
  // ONE authored blob fans to its sibling actions (no copy-paste); fill-if-empty.
  const rows = [
    { actions: ["writerAI.expand", "writerAI.continue"], label: "Storm", variables: { passage: "A storm." } },
    { action: "brainstorm", label: "Seed", variables: { user_content: "A city that forgets." } },
  ];
  const h = db.session();
  // 2 actions in row 1 + 1 in row 2 = 3 rows
  expect(h.tx(() => stores.getTestSampleStore().seedFill(h, rows))).toBe(3);
  // each sibling action got its own row from the one blob
  expect((await list("writerAI.expand"))[0].label).toBe("Storm");
  expect((await list("writerAI.continue"))[0].label).toBe("Storm");

  // the user EDITS one …
  const got = (await list("brainstorm"))[0];
  await put({ id: got.id, action: "brainstorm", label: "Seed", variables: { user_content: "MY edited premise." } });
  // … and a reseed adds nothing / clobbers nothing.
  expect(h.tx(() => stores.getTestSampleStore().seedFill(h, rows))).toBe(0);
  const kept = (await list("brainstorm"))[0];
  expect(kept.variables.user_content).toBe("MY edited premise.");
});
