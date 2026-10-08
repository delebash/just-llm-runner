// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    // One temp folder per run, removed at the end (the kit's platform/vitest_tmp.js).
    globalSetup: [fileURLToPath(new URL("./src/platform/vitest_tmp.js", import.meta.url))],
    pool: "forks",
    testTimeout: 20000,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
