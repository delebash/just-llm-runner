// SPDX-License-Identifier: MIT
// The desktop app: the family's shared shell (`runDesktopApp` from the kit) — the data folder,
// the server in a utilityProcess, the tray, the window on app://<id>, the security settings —
// with this app's names. Quasar builds this file (Rolldown, ESM) and runs it in Electron's main
// process; nothing app-specific lives here but the settings below.
import path from "node:path";
import { runDesktopApp } from "@delebash/llm-runner/shell";
import { resolveElectronAssetsPath } from "#q-app/electron/main";

const here = import.meta.dirname;
const dev = Boolean(import.meta.env.QUASAR_DEV);

runDesktopApp({
  id: "familytemplate",
  appName: "FamilyTemplate",
  productName: "Family Template",
  port: 17490, // the family port registry: JW 17495 · JV 17494 · docgen 8742 · template 17490
  // the server package (server/): its source in development, the installed copy when packaged
  serverEntry: dev ? path.resolve("server", "src", "serve.js") : path.join(here, "node_modules", "family-template-server", "src", "serve.js"),
  dataDirEnv: "FAMILY_TEMPLATE_DATA_DIR",
  repoRoot: dev ? path.resolve(".") : null, // development: the data root is <repo>/data
  distDir: here, // Quasar puts the built renderer beside this file
  devUrl: import.meta.env.QUASAR_APP_URL,
  preload: path.join(here, "electron-preload.cjs"),
  window: { title: "Family Template", width: 1200, height: 800, minWidth: 800, minHeight: 600, backgroundColor: "#fafaf7" },
  icon: resolveElectronAssetsPath("icons/icon.png"),
  logFile: path.join("logs", "family-template.log"),
});
