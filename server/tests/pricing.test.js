// SPDX-License-Identifier: MIT
// Port of tests/test_pricing.py — cloud pricing lives in the DB: priceFor reads the live
// model_pricing table (seeded from DEFAULT_PRICING), and operator edits take effect.
import { expect, test } from "vitest";
import * as pricing from "../src/llm/pricing.js";
import { makePricingRouter } from "../src/llm/pricing_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

function freshSeeded() {
  const h = freshDb();
  h.tx(() => seed.seedDefaultPricing(h));
}

test("price_for reads seeded db", () => {
  freshSeeded();
  expect(pricing.priceFor("gpt-5")).toEqual(pricing.DEFAULT_PRICING["gpt-5"]);
  // dated suffix → prefix match (as before, but now from the DB)
  expect(pricing.priceFor("gpt-5-2026-01-01")).toEqual(pricing.DEFAULT_PRICING["gpt-5"]);
  // unknown / local model → null (cost 0)
  expect(pricing.priceFor("some-local-model")).toBeNull();
});

test("price_for reflects edits and deletes", () => {
  freshSeeded();
  stores.getPricingStore().upsert({ modelId: "gpt-5", inputPerM: 99.0, outputPerM: 88.0 });
  expect(pricing.priceFor("gpt-5")).toEqual([99.0, 88.0]); // edit takes effect
  stores.getPricingStore().delete("gpt-5");
  expect(pricing.priceFor("gpt-5")).toBeNull(); // delete → cost 0
});

test("pricing store lowercases and lists", () => {
  freshSeeded();
  const st = stores.getPricingStore();
  st.upsert({ modelId: "MyCloud-X", inputPerM: 1.0, outputPerM: 2.0 });
  const row = st.list().find((r) => r.modelId === "mycloud-x");
  expect(row.inputPerM).toBe(1.0);
  expect(row.outputPerM).toBe(2.0);
  expect(pricing.priceFor("MyCloud-X")).toEqual([1.0, 2.0]); // case-insensitive
});

// Not in the Python file: the router's answers, including FastAPI's 422 and 400 shapes.
test("the pricing router answers as FastAPI did", async () => {
  freshSeeded();
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", makePricingRouter(stores.getPricingStore));
  const put = (payload) =>
    app.request("/v1/ai/pricing", { method: "PUT", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
  let r = await put({ modelId: "x-1", inputPerM: "2.5", junk: 1 });
  expect(r.status).toBe(200);
  expect((await r.json()).rows.find((x) => x.modelId === "x-1")).toEqual({ modelId: "x-1", inputPerM: 2.5, outputPerM: 0 });
  r = await put({ inputPerM: 1 });
  expect(r.status).toBe(422);
  expect(r.headers.get("content-type")).toMatch(/application\/problem\+json/);
  expect(await r.json()).toEqual({
    type: "https://example.test/errors/validation-error",
    title: "Validation Error",
    status: 422,
    detail: "Request body failed validation.",
    errors: [{ loc: ["body", "modelId"], msg: "Field required", type: "missing" }],
    instance: "/v1/ai/pricing",
  });
  r = await put({ modelId: "  " });
  expect(r.status).toBe(400);
  expect(await r.json()).toMatchObject({ type: "https://example.test/errors/bad-request", detail: "modelId is required" });
  r = await app.request("/v1/ai/pricing?modelId=X-1", { method: "DELETE", headers: { "content-type": "application/json" } });
  expect(r.status).toBe(200);
  expect((await r.json()).rows.some((x) => x.modelId === "x-1")).toBe(false);
  r = await app.request("/v1/ai/pricing", { method: "DELETE" });
  expect(r.status).toBe(422);
  expect((await r.json()).errors).toEqual([{ loc: ["query", "modelId"], msg: "Field required", type: "missing" }]);
  r = await app.request("/v1/nothing-here", { method: "GET" });
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ detail: "Not Found" });
});
