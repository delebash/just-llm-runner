// SPDX-License-Identifier: GPL-3.0-or-later
import { resolve } from "node:path";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Library build: emit ESM + UMD with Vue externalized, so both apps consume
// the components without bundling a second Vue. Components land in later
// Phase 2 items; for now the entry exports the shared contract types.
export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "LlmUi",
      fileName: "llm-ui",
    },
    rollupOptions: {
      external: ["vue"],
      output: { globals: { vue: "Vue" } },
    },
  },
});
