// SPDX-License-Identifier: MIT
// Port of tests/test_router_port.py — the router port is ALLOCATED, and the local adapter
// FOLLOWS it (2026-08-03).
//
// The incident these are written against: every family app spawned its llama-server router
// on the same hardcoded :8080. On a box running two of them the second app's child could not
// bind — and the spawn's `/health` probe passed anyway, because that port was answered by the
// FIRST app's router. JustWrite's `POST /models/load 'gemma-4-26b-a4b-qat'` reached
// just_ai_i18n_docgen's engine, which knows that model under a different id, and answered 404
// in 31 ms. It reads exactly like a corrupt install; it was a shared constant.
//
// Two halves, both needed: the spawn takes a port nobody holds (health-by-port is not
// identity), and the `local-llamacpp` adapter asks the live service where to send a request
// instead of trusting the port seeded on its provider row.
//
// JS shape: `findFreePort` / `_portIsFree` are async (a bind is an event in Node). Node can
// only bind a TCP socket by listening, so `a_really_held_port_reads_as_taken` holds the port
// with a LISTENING server where Python held a bound-but-not-listening socket.
//
// Waiting for runner/lifecycle.js (wave 3) — `RunnerService` (`test.todo` keeps the names):
//   - spawn_uses_the_allocated_port_not_the_constant
//   - router_url_is_empty_while_nothing_is_running
import net from "node:net";
import { afterEach, expect, test } from "vitest";
import * as dispatch from "../src/llm/dispatch.js";
import { OpenAICompatAdapter } from "../src/llm/openai_compat.js";
import { _portIsFree, DEFAULT_HOST, DEFAULT_PORT, findFreePort, NoFreePortError } from "../src/runner/process.js";

// ── allocation ───────────────────────────────────────────────────────────────

test("prefers_the_preferred_port_when_it_is_free", async () => {
  // A box running ONE app must keep behaving exactly as before — :8080, no scan.
  expect(await findFreePort(DEFAULT_HOST, DEFAULT_PORT, { _isFree: () => true })).toBe(DEFAULT_PORT);
});

test("skips_ports_that_are_taken", async () => {
  const taken = new Set([8080, 8081]);
  expect(await findFreePort("127.0.0.1", 8080, { _isFree: (h, p) => !taken.has(p) })).toBe(8082);
});

test("raises_when_the_whole_range_is_held", async () => {
  const err = await findFreePort("127.0.0.1", 8080, { span: 4, _isFree: () => false }).catch((e) => e);
  expect(err).toBeInstanceOf(NoFreePortError);
  expect(err.message).toContain("8080-8083");
});

test("a_really_held_port_reads_as_taken", async () => {
  // The bind-probe against a REAL socket — the fake above only proves the loop. A
  // connect-probe would answer 'is anyone listening', which is a different (and wrong)
  // question: a bound-but-not-listening socket still blocks llama-server.
  const s = net.createServer();
  await new Promise((r) => s.listen({ host: "127.0.0.1", port: 0 }, r));
  const { port } = s.address();
  try {
    expect(await _portIsFree("127.0.0.1", port)).toBe(false);
    expect((await findFreePort("127.0.0.1", port, { span: 8 })) > port).toBe(true);
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test.todo("spawn_uses_the_allocated_port_not_the_constant"); // waits for runner/lifecycle.js

test.todo("router_url_is_empty_while_nothing_is_running"); // waits for runner/lifecycle.js

// ── the adapter follows it ───────────────────────────────────────────────────

afterEach(() => {
  dispatch.setLocalRunnerBaseUrl(null);
});

const adapter = (providerType = "local-llamacpp", baseUrl = "") =>
  new OpenAICompatAdapter("p", providerType, { apiKey: "", baseUrl });

test("local_adapter_targets_the_live_router", () => {
  dispatch.setLocalRunnerBaseUrl(() => "http://127.0.0.1:8137");
  // The provider row still carries the seeded :8080 — and is overruled by the running
  // engine, which is the entire point.
  const a = adapter("local-llamacpp", "http://127.0.0.1:8080/v1");
  expect(a._apiBase).toBe("http://127.0.0.1:8137/v1");
});

test("local_adapter_refuses_to_guess_when_the_engine_is_down", () => {
  // Falling back to the configured port is the ORIGINAL defect: :8080 may well answer — as
  // somebody else's engine — so a down router must fail loudly.
  dispatch.setLocalRunnerBaseUrl(() => "");
  const a = adapter("local-llamacpp", "http://127.0.0.1:8080/v1");
  expect(() => a._apiBase).toThrow(/isn't running/);
});

test("local_adapter_keeps_its_configured_url_with_no_runner_wired", () => {
  // Standalone host / adapter unit tests: nothing changes off the runner path.
  const a = adapter("local-llamacpp", "http://127.0.0.1:9999/v1");
  expect(a._apiBase).toBe("http://127.0.0.1:9999/v1");
});

test("a_user_endpoint_is_never_hijacked", () => {
  // `openai-compat` is a URL the USER chose (LM Studio, vLLM, a self-hosted box). The seam
  // resolves the BUNDLED runner only.
  dispatch.setLocalRunnerBaseUrl(() => "http://127.0.0.1:8137");
  const a = adapter("openai-compat", "http://192.168.1.5:1234/v1");
  expect(a._apiBase).toBe("http://192.168.1.5:1234/v1");
});
