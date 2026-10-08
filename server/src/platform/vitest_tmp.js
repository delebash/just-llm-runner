// SPDX-License-Identifier: MIT
// The vitest globalSetup every family server suite shares: a test run gets ONE temp folder,
// and TMP / TEMP / TMPDIR point the test workers at it, so everything a test makes through
// os.tmpdir() lands there — and the whole folder goes when the run ends. Before 2026-10-08 the
// suites left a folder per test behind (7,500 `jv-test-*` in one %TEMP%).
//
//   // vitest.config.js
//   globalSetup: [fileURLToPath(import.meta.resolve("@delebash/llm-runner/platform/vitest_tmp"))]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const VARS = ["TMP", "TEMP", "TMPDIR"];

export default function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "vitest-run-"));
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  // Set before the workers start, so each inherits it (os.tmpdir() reads TEMP/TMP on Windows,
  // TMPDIR elsewhere).
  for (const k of VARS) process.env[k] = root;
  return () => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.warn(`[vitest] could not remove the run's temp folder ${root}: ${e.message}`);
    }
  };
}
