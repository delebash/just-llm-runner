// SPDX-License-Identifier: MIT
// Port of tests/test_class_tunes.py — the hardware-class tune library (ROUND 8 Task C): the
// /v1/ai/class-tunes CRUD (server-derived current class via the injected classKeyFn; PUT
// replaces the (model, class) set wholesale and marks it user-owned) and the seeder's
// merge-by-(model, class) guarantee — a user-edited config is never clobbered.
import { beforeEach, expect, test, vi } from "vitest";
import { makeClassTunesRouter } from "../src/llm/class_tunes_api.js";
import * as db from "../src/llm/db.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

// stores.js imports two wave-2 modules; stand-ins until they land (fixtures/wave-stubs.js).
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

let client;
beforeEach(() => {
  freshDb();
  const app = createServer({ typeBase: "https://example.test/errors/" });
  // classKeyFn injected — the SERVER derives the box's class (one source).
  app.register(makeClassTunesRouter(stores.getClassTuneStore, () => "dgpu-vram8|ram32"));
  client = app;
});

async function put(modelId, switches, classKey = "") {
  const r = await client.inject({
    method: "PUT",
    url: "/v1/ai/class-tunes",
    payload: { modelId, classKey, switches: Object.entries(switches).map(([flagName, flagValue]) => ({ flagName, flagValue })) },
  });
  return r.json();
}

const pairs = (rows) => new Set(rows.map((x) => `${x.flagName}=${x.flagValue}`));

test("put_defaults_to_the_current_class_and_round_trips", async () => {
  // Omitted classKey → the box's own class (the Tune modal's "Save for hardware class"
  // path). The response is the whole library + the current class.
  const r = await put("m1", { n_cpu_moe: "21", ctx_len: "32768" });
  expect(r.classKey).toBe("dgpu-vram8|ram32");
  expect(r.tunes).toHaveLength(1);
  const t = r.tunes[0];
  expect([t.modelId, t.classKey, t.builtIn]).toEqual(["m1", "dgpu-vram8|ram32", false]);
  expect(pairs(t.rows)).toEqual(new Set(["n_cpu_moe=21", "ctx_len=32768"]));
});

test("put_explicit_class_and_wholesale_replace", async () => {
  // An explicit classKey targets ANY class (add a row for a box you don't own / import
  // another user's config); PUT replaces the whole set — verbatim snapshot.
  await put("m1", { threads: "8", batch_size: "512" }, "vram16|ram64");
  const r = await put("m1", { threads: "6" }, "vram16|ram64");
  const t = r.tunes.find((x) => x.classKey === "vram16|ram64");
  expect(t.rows.map((x) => [x.flagName, x.flagValue])).toEqual([["threads", "6"]]);
});

test("delete_removes_one_config_only", async () => {
  await put("m1", { threads: "8" });
  await put("m1", { threads: "4" }, "cpu|ram16");
  const r = (await client.inject({ method: "DELETE", url: "/v1/ai/class-tunes?modelId=m1&classKey=cpu%7Cram16" })).json();
  expect(r.tunes.map((t) => [t.modelId, t.classKey])).toEqual([["m1", "dgpu-vram8|ram32"]]);
});

test("validation_400s", async () => {
  const sw = [{ flagName: "threads", flagValue: "8" }];
  expect((await client.inject({ method: "PUT", url: "/v1/ai/class-tunes", payload: { modelId: " ", switches: sw } })).statusCode).toBe(400);
  // a config with no usable switch rows is a mistake, not an empty save
  expect((await client.inject({ method: "PUT", url: "/v1/ai/class-tunes", payload: { modelId: "m1", switches: [] } })).statusCode).toBe(400);
  expect((await client.inject({ method: "DELETE", url: "/v1/ai/class-tunes?modelId=m1&classKey=%20" })).statusCode).toBe(400);
});

test("builtin_flag_reads_seeded_rows_and_edit_takes_ownership", async () => {
  // Plant a seeded (built-in) config directly, the way seedDefaultClassTunes writes it; the
  // library reports builtIn until a PUT replaces it as user rows.
  db.session().insert("class_tunes", {
    model_id: "m9",
    class_key: "dgpu-vram8|ram32",
    flag_name: "n_cpu_moe",
    flag_value: "21",
    built_in: true,
  });
  let t = (await client.inject({ method: "GET", url: "/v1/ai/class-tunes" })).json().tunes[0];
  expect(t.builtIn).toBe(true);
  t = (await put("m9", { n_cpu_moe: "19" })).tunes[0];
  expect(t.builtIn).toBe(false);
});

test("seeder_never_clobbers_an_edited_config", async () => {
  // The boot seeder inserts a built-in config only when its (model, class) has NO rows — an
  // edit through the API survives every later seed pass. (Deleting a built-in config
  // re-seeds it on the next pass — the documented flip side.)
  await put("gemma-4-26b-a4b-qat", { n_cpu_moe: "19" }); // the seeded row's keys, edited
  const h = db.session();
  h.tx(() => seed.seedDefaultClassTunes(h));
  const rows = h.all("select * from class_tunes where model_id = ? and class_key = ?", ["gemma-4-26b-a4b-qat", "dgpu-vram8|ram32"], "class_tunes");
  expect(new Set(rows.map((r) => `${r.flag_name}=${r.flag_value}`))).toEqual(new Set(["n_cpu_moe=19"]));
  expect(rows.every((r) => r.built_in === false)).toBe(true);
});
