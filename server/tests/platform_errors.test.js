// SPDX-License-Identifier: MIT
// Port of tests/test_platform_errors.py — the RFC 7807 problem envelope
// (platform/errors.js): an ApiError's `extra` members ride in the problem body — so a
// client can act on WHICH refusal it got (JustVoice's Pocket TTS terms prompt,
// 2026-10-02) — and never override the standard members.
import { expect, test } from "vitest";
import { ApiError, badRequest } from "../src/platform/errors.js";
import { createServer } from "../src/platform/server.js";

async function boom(exc) {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.get("/boom", async () => {
    throw exc;
  });
  return app.request("/boom", { method: "GET" });
}

test("extra_members_ride_in_the_problem_body", async () => {
  const r = await boom(new ApiError(403, "terms-required", "Terms not accepted", "accept them first", { engine: "pocket" }));
  expect(r.status).toBe(403);
  const body = await r.json();
  expect(body.type).toBe("https://example.test/errors/terms-required");
  expect(body.detail).toBe("accept them first");
  expect(body.engine).toBe("pocket");
});

test("extra_never_overrides_a_standard_member", async () => {
  const r = await boom(
    new ApiError(403, "terms-required", "Terms not accepted", "real detail", { detail: "spoofed", status: 200 }),
  );
  const body = await r.json();
  expect(body.detail).toBe("real detail");
  expect(body.status).toBe(403);
});

test("a_plain_error_has_no_extras", async () => {
  const body = await (await boom(badRequest("nope"))).json();
  expect(new Set(Object.keys(body))).toEqual(new Set(["type", "title", "status", "detail", "instance"]));
});
