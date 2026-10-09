// SPDX-License-Identifier: MIT
// Port of tests/test_config.py — the runner config (A7: was runner-manifest.json, now the DB
// + engine defaults): the standalone `defaultConfig()`, the camelCase /v1/llm-runner/config
// endpoint, and the host-side DB builder `stores.buildRunnerConfig()` (seeded runner_binary +
// runner_setting → RunnerConfig).
//
// `config_endpoint_camelcase` re-configures the runner singleton, as Python did; the JS
// restores it afterwards. `hardware_endpoint` runs the REAL hardware probe, as Python's did —
// it checks the probe's own answer shape.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { createServer } from "../src/platform/server.js";
import { runnerRouter } from "../src/runner/api.js";
import * as rconfig from "../src/runner/config.js";
import { defaultConfig } from "../src/runner/config.js";
import * as lifecycle from "../src/runner/lifecycle.js";
import { freshDb } from "./helpers.js";

let savedService;
beforeEach(() => {
  savedService = lifecycle.state.service;
});
afterEach(() => {
  lifecycle.state.service = savedService;
});

function client() {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", runnerRouter());
  return app;
}

test("default_config_validates", () => {
  const c = defaultConfig();
  expect(c.llamacpp.pinnedBuild && c.llamacpp.pinnedBuild !== "latest").toBeTruthy();
  expect(c.llamacpp.binaries.length).toBeGreaterThan(0);
  for (const b of c.llamacpp.binaries) {
    expect(b.assetUrl || b.image).toBeTruthy(); // every binary is fetchable
  }
  expect(c.safetyMarginMb).toBeGreaterThan(0);
});

test("config_endpoint_camelcase", async () => {
  // Force a clean default-backed service (the singleton may be configured by another test);
  // then the endpoint serves defaultConfig(). Its cache root (never written here) points at a
  // temp folder rather than the user cache.
  vi.stubEnv("LLM_RUNNER_CACHE", mkdtempSync(join(tmpdir(), "kit-config-")));
  lifecycle.configureService({ configFn: defaultConfig });
  const r = await client().request("/v1/llm-runner/config");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect("safetyMarginMb" in body && body.safetyMarginMb > 0).toBe(true);
  expect(body.llamacpp.pinnedBuild).toBeTruthy();
  expect("pinned_build" in body.llamacpp).toBe(false); // snake_case must not leak
  expect(body.llamacpp.binaries.length).toBeGreaterThan(0);
});

test("hardware_endpoint", async () => {
  const r = await client().request("/v1/llm-runner/hardware");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(["windows", "macos", "linux"]).toContain(body.platform);
  expect("cpuCores" in body && "runtimes" in body).toBe(true);
});

test("build_runner_config_from_db", () => {
  // The host path: seed runner_binary + runner_setting, then build a RunnerConfig from the DB
  // (the configFn installLlm injects). In memory, foreign keys off — Python's sqlite3.
  const h = freshDb({ foreignKeys: false });
  h.tx(() => {
    seed.seedDefaultRunnerBinaries(h);
    seed.seedDefaultRunnerSettings(h);
  });

  const cfg = stores.buildRunnerConfig();
  expect(cfg.llamacpp.pinnedBuild).toBe(rconfig.DEFAULT_PINNED_BUILD);
  expect(cfg.safetyMarginMb).toBe(rconfig.DEFAULT_SAFETY_MARGIN_MB);
  expect(cfg.llamacpp.binaries.length).toBe(rconfig.DEFAULT_BINARIES.length);
  const gpus = new Set(cfg.llamacpp.binaries.map((b) => `${b.platform}|${b.gpu}`));
  expect(gpus.has("windows|cuda12") && gpus.has("macos|metal")).toBe(true);
});

// Not in the Python file (decided 2026-10-08): reading the hardware panel refreshes the
// detection the runner service and the tune keys read — Python re-detected on every call.
test("hardware_endpoint_refreshes_the_stored_detection", async () => {
  const hardware = await import("../src/runner/hardware.js");
  const before = hardware.detected();
  const box = { os: "Windows", platform: "windows", cpuCores: 4, ramMb: 16384, gpus: [], runtimes: {} };
  vi.spyOn(hardware, "detect").mockResolvedValue(box);
  try {
    const app = createServer({ typeBase: "t/" });
    app.route("/", runnerRouter());
    const r = await app.request("/v1/llm-runner/hardware");
    expect(r.status).toBe(200);
    expect(hardware.detected()).toEqual(box);
  } finally {
    hardware.setDetected(before);
  }
});
