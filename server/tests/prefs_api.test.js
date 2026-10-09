// SPDX-License-Identifier: MIT
// Port of tests/test_prefs_api.py — the shared /v1/prefs router contract
// (platform/prefs_api.js). Object-backed hooks: the router's own semantics are what's
// under test; each host's storage is pinned by that app's suite.
import { expect, test } from "vitest";
import { makePrefsRouter } from "../src/platform/prefs_api.js";
import { createServer } from "../src/platform/server.js";

// A payload as the tests send it: an object as JSON with its content type, a string as it
// is with no content type (as bytes — a string body would carry text/plain).
function init(method, payload) {
  if (payload === undefined) return { method };
  if (typeof payload === "string") return { method, body: new TextEncoder().encode(payload) };
  return { method, body: JSON.stringify(payload), headers: { "content-type": "application/json" } };
}

function makeClient() {
  const store = {};
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route(
    "/",
    makePrefsRouter({
      readAll: () => ({ ...store }),
      writeMany: (patch) => Object.assign(store, patch),
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    }),
  );
  const call = (method) => (url, payload) => app.request(url, init(method, payload));
  return { client: { get: call("GET"), patch: call("PATCH"), delete: call("DELETE") }, store };
}

test("get_starts_empty", async () => {
  const { client } = makeClient();
  const r = await client.get("/v1/prefs");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({});
});

test("patch_upserts_and_returns_merged_document", async () => {
  const { client } = makeClient();
  let r = await client.patch("/v1/prefs", { appearance: { mode: "dark" }, n: 1 });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ appearance: { mode: "dark" }, n: 1 });
  r = await client.patch("/v1/prefs", { n: 2 });
  expect(await r.json()).toEqual({ appearance: { mode: "dark" }, n: 2 });
});

test("patch_is_wholesale_per_key_not_a_deep_merge", async () => {
  // The donor contract's reason to exist: sending the SMALLER map removes the dropped
  // entry — a deep merge could never express the deletion.
  const { client } = makeClient();
  await client.patch("/v1/prefs", { hidden: { a: true, b: true } });
  const r = await client.patch("/v1/prefs", { hidden: { a: true } });
  expect((await r.json()).hidden).toEqual({ a: true });
});

test("delete_clears_via_the_host_hook", async () => {
  const { client, store } = makeClient();
  await client.patch("/v1/prefs", { x: [1, 2, 3] });
  const r = await client.delete("/v1/prefs");
  expect(r.status).toBe(204);
  expect(await r.text()).toBe("");
  expect(store).toEqual({});
  expect(await (await client.get("/v1/prefs")).json()).toEqual({});
});

// Not in the Python file: the 422s, as the Python router answered them (measured
// 2026-10-07).
test("a_body_that_is_not_a_dict_answers_pydantics_422", async () => {
  const { client } = makeClient();
  const errorsOf = async (body) => {
    // the JSON text exactly as sent (Python's probe used `json=`)
    const r = await client.patch("/v1/prefs", body);
    expect(r.status).toBe(422);
    expect(r.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    return (await r.json()).errors;
  };
  const notDict = [{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }];
  expect(await errorsOf([1, 2])).toEqual(notDict);
  expect(await errorsOf(JSON.stringify("x"))).toEqual(notDict);
  expect(await errorsOf(undefined)).toEqual([{ loc: ["body"], msg: "Field required", type: "missing" }]);
});
