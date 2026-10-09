// SPDX-License-Identifier: MIT
// The family divergence check — the three apps against the kit and each other.
//
// Every finding of the 2026-08-07 structure audit (docs/plans/archive/family-structure-audit.md) was
// something a script could have caught the DAY it appeared: a fork of a component the kit
// already exports, a copy of a kit file that had quietly drifted, a missing npm script, a
// server entry module that isn't `serve.py`. Instead they accumulated for months and were
// found by hand. This is that script. Nothing clever — it reads files and compares them.
//
//   Run:  node scripts/check-family.js            (exit 0 = clean, 1 = violations)
//         node scripts/check-family.js --info     (also print the advisory findings)
//
// LIMITATIONS, stated plainly so a clean run is not mistaken for a clean family:
//
//  1. It needs all four repos side by side on disk, so it cannot run in CI unless every
//     repo is checked out. It is a thing a developer (or an agent) runs.
//  2. It matches by NAME. It therefore CANNOT see a fork that was renamed — JustVoice's
//     TaskStrip.vue / TaskStatusPanel.vue / renderTasks.js duplicate the kit's AiTaskStrip
//     / AiStatusPanel / aiTasks and this script is blind to all three, because the names
//     differ. That fork is the reason this script exists and it is the one thing it misses.
//     Same-concept-different-name still needs a human, or an audit like the one in
//     docs/plans/archive/family-structure-audit.md.
//  3. Whether a concept SHOULD be shared at all is judgement. Everything under ADVISORY is
//     a question, not a verdict.
//
// ONE KIND OF APP: every family app is a Quasar app (app-structure.md §Q) — `quasar.config.js`
// exists; an app without one is a violation and its layout checks (scripts 3, server 4, the
// desktop main 14, the Quasar layout) don't run. The kit's `template/` — the §Q reference app —
// is checked against §Q too (its layout checks only: it is not a product, so the docs checks
// don't apply). The Tauri + Python kind and its checks were deleted 2026-10-08, the Electron +
// Vite kind and its checks 2026-10-09: no family app runs either.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAMILY = resolve(KIT, "..");

// FAMILY_<NAME>_DIR checks another checkout of an app — a branch in its own worktree before it's
// merged (FAMILY_DOCGEN_DIR=../docgen-quasar).
const APPS = [
  { name: "JustWrite", dir: process.env.FAMILY_JUSTWRITE_DIR || join(FAMILY, "justwrite-app") },
  { name: "JustVoice", dir: process.env.FAMILY_JUSTVOICE_DIR || join(FAMILY, "JustVioce") },
  { name: "docgen", dir: process.env.FAMILY_DOCGEN_DIR || join(FAMILY, "just_ai_i18n_docgen") },
];

/** The §Q reference app (`template/`), checked against §Q's layout rules only. */
const TEMPLATE = { name: "template", dir: join(KIT, "template"), template: true };

/** "quasar" (§Q), or "unknown" — which is a violation. */
const kindOf = (app) => (existsSync(join(app.dir, "quasar.config.js")) ? "quasar" : "unknown");
for (const app of [...APPS, TEMPLATE]) app.kind = kindOf(app);

// The family port registry (app-structure §1) — an app's desktop main passes it as `port`.
const APP_PORTS = { JustWrite: 17495, JustVoice: 17494, docgen: 8742, template: 17490 };

// Ruled exceptions. An entry here means a human looked and decided it is NOT a fork —
// with the reason, so the next reader doesn't have to re-derive it. Keep this short: a
// long allowlist means the rule is wrong, not that the code is fine.
const ALLOW = new Map([
  ["JustVoice/QuickSetup.vue", "TTS-engine wizard; the kit's QuickSetup is the LLM one (ruling 6, 2026-08-05)"],
]);

const problems = [];
const infos = [];
const fail = (app, msg) => problems.push(`${app.padEnd(10)} ${msg}`);
const info = (app, msg) => infos.push(`${app.padEnd(10)} ${msg}`);

// ── file walking ──────────────────────────────────────────────────────────────
const SKIP = new Set(["node_modules", "dist", ".git", "__pycache__", ".venv", "build", "target", "e2e"]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const hash = (p) => createHash("sha1").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");

// ── what the kit exports ──────────────────────────────────────────────────────
// Two forms: `export { default as Name } from …` and `export { a, b } from …`, plus one
// `export * from "./common/index.js"` that has to be followed or half the surface is missed.
function kitExports() {
  const names = new Set();
  const read = (file) => {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const star = line.match(/^export \* from "(.+)"/);
      if (star) { read(resolve(dirname(file), star[1])); continue; }
      const block = line.match(/^export \{([^}]+)\}/);
      if (!block) continue;
      for (const raw of block[1].split(",")) {
        const name = raw.trim().replace(/^default as /, "").split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
  };
  read(join(KIT, "ui/src/index.js"));
  return names;
}

// ── check 1 · an app defining what the kit already exports ────────────────────
// The distinction that matters, and the one a filename alone gets WRONG: docgen's
// TitleBar.vue *imports* the kit's TitleBar and fills its slot — a wrapper, which is the
// intended pattern. JustWrite's does not — that's the fork. So: match by name, then read
// the file to see whether it consumes the kit's version.
function checkForks(app, files, exports_) {
  for (const file of files) {
    const stem = basename(file, extname(file));
    if (!exports_.has(stem)) continue;
    if (ALLOW.has(`${app.name}/${basename(file)}`)) continue;
    const src = readFileSync(file, "utf8");
    const wraps = new RegExp(`import[^;]*\\b${stem}\\b[^;]*from\\s+["']@delebash/llm-ui["']`, "s").test(src);
    const rel = file.slice(app.dir.length + 1).replace(/\\/g, "/");
    if (wraps) info(app.name, `${rel} wraps the kit's ${stem} — OK`);
    else fail(app.name, `${rel} redefines ${stem}, which the kit exports (and does not import it)`);
  }
}

// ── check 2 · a copy of a kit file that has drifted ───────────────────────────
// A SHARED NAME IS NOT A COPY. The first version of this check compared by filename and
// reported an app's `router/index.js` as a drifted copy of the kit's `index.js` — nonsense,
// and exactly the by-the-filename error the audit exists to stop. So: same name AND the
// contents actually overlap. Jaccard over trimmed non-blank lines; a genuine copy scores
// high even after edits, two unrelated `index.js` files score ~0.
const COPY_THRESHOLD = 0.35;
const MIN_LINES = 10;

function lineSet(p) {
  return new Set(readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 3));
}
function similarity(a, b) {
  const A = lineSet(a);
  const B = lineSet(b);
  if (A.size < MIN_LINES || B.size < MIN_LINES) return 0;
  let shared = 0;
  for (const line of A) if (B.has(line)) shared += 1;
  return shared / (A.size + B.size - shared);
}

function checkDrift(app, files, kitFiles) {
  for (const file of files) {
    const name = basename(file);
    const twin = kitFiles.get(name);
    if (!twin) continue;
    if (ALLOW.has(`${app.name}/${name}`)) continue;
    const rel = file.slice(app.dir.length + 1).replace(/\\/g, "/");
    if (hash(file) === hash(twin)) {
      fail(app.name, `${rel} is a byte-identical copy of the kit's ${name} — delete it and import`);
      continue;
    }
    const score = similarity(file, twin);
    if (score >= COPY_THRESHOLD) {
      fail(app.name, `${rel} is a DRIFTED copy of the kit's ${name} — ${Math.round(score * 100)}% shared lines, ${lineCount(file)} vs ${lineCount(twin)}`);
    }
  }
}
const lineCount = (p) => readFileSync(p, "utf8").split("\n").length;

// ── check 3 · npm script names are the contract (app-structure §Q.9) ───────────
// §Q.9's list; the e2e names (`test`, `screenshots`) are not required.
const REQUIRED_SCRIPTS = ["dev", "build", "build:spa", "server", "lint"];

function checkScripts(app) {
  const pkgPath = join(app.dir, "package.json");
  if (!existsSync(pkgPath)) return fail(app.name, "no package.json");
  const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts || {};
  for (const need of REQUIRED_SCRIPTS) {
    if (!scripts[need]) fail(app.name, `package.json has no "${need}" script (§Q.9 names are the contract)`);
  }
  if (scripts.tauri) fail(app.name, `package.json still has a "tauri" script — the Tauri CLI went with the move (§Q.9)`);
  // §Q.9: the desktop app is the default; the browser build is build:spa; the server is its
  // own package, run from source on Electron's own Node, through scripts/node24.js.
  const want = [
    ["dev", "quasar dev -m electron", /^quasar dev -m electron\b/],
    ["build", "quasar build -m electron", /^quasar build -m electron\b/],
    ["build:spa", "quasar build", /^quasar build\s*$/],
    ["server", "node scripts/node24.js server/src/serve.js serve", /^node scripts\/node24\.js server\/src\/serve\.js serve\b/],
  ];
  for (const [name, text, re] of want) {
    if (scripts[name] && !re.test(scripts[name])) fail(app.name, `"${name}" runs \`${scripts[name]}\` — §Q.9 says \`${text}\``);
  }
  return undefined;
}

// ── check 4 · the server layout (app-structure §Q.3) ──────────────────────────
// The server is plain JavaScript in server/src/, entered by serve.js; its tests are vitest
// files in server/tests/. It is also its own package (the packaged app installs only what
// src-electron/package.json names).
function checkServer(app) {
  const serverDir = join(app.dir, "server");
  const section = "§Q.3";
  if (!existsSync(join(serverDir, "src", "serve.js"))) {
    fail(app.name, `server/src/serve.js missing — the server's entry (\`serve\`), what the shell and the launcher run (${section})`);
  }
  const pkgPath = join(serverDir, "package.json");
  if (!existsSync(pkgPath)) {
    fail(app.name, "server/package.json missing — the server is its own package (§Q.3)");
  } else {
    const p = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (p.type !== "module") fail(app.name, `server/package.json "type" is ${JSON.stringify(p.type)} — the family is "module"`);
    if (!/-server$/.test(p.name || "")) fail(app.name, `server/package.json is named ${JSON.stringify(p.name)} — §Q.3 says "<app>-server"`);
    // The family's servers are Hono, and ONE Hono: the kit's (2026-10-09 — the kit's TASKS, "The
    // family's servers move to Hono"; docs/plans/2026-10-09-hono-standard.md §10).
    for (const d of Object.keys({ ...(p.dependencies || {}), ...(p.devDependencies || {}) })) {
      if (/^(fastify|@fastify\/(static|multipart|cors|formbody))$/.test(d)) {
        fail(app.name, `server/package.json depends on ${d} — the family's servers are Hono (${section})`);
      }
      if (/^(hono|@hono\/.+)$/.test(d)) {
        fail(app.name, `server/package.json depends on ${d} — one Hono for the family: an app takes Hono, stream and serveStatic from the kit (${section})`);
      }
    }
  }
  if (app.template) return undefined; // the template's server has no tests of its own
  const testsDir = join(serverDir, "tests");
  const jsTests = existsSync(testsDir) ? readdirSync(testsDir).filter((f) => f.endsWith(".test.js")) : [];
  if (!jsTests.length) fail(app.name, `no server/tests/*.test.js — the server's tests are vitest files (${section})`);
  const vitestCfg = join(serverDir, "vitest.config.js");
  if (existsSync(vitestCfg) && !readFileSync(vitestCfg, "utf8").includes("tests/**/*.test.js")) {
    fail(app.name, `server/vitest.config.js does not include \`tests/**/*.test.js\` — \`test:server\` would run nothing (${section})`);
  }
  return undefined;
}

// ── check 5 · hand-rolled where the kit exports the helper ────────────────────
// Deliberately worded as a question, not a verdict. A static check cannot tell a POLL
// (re-fetch on a timer — usePoll's job) from a UI TICKER (advance a clock so an elapsed
// readout re-renders — not usePoll's job, and rewriting one would be wrong). JustVoice's
// DictateWindow elapsed timer and renderTasks' 100 ms `now` tick are tickers; TrainView's
// 2 s job refresh is a poll. Only a human can sort them, so the line asks rather than tells.
const HAND_ROLLED = [
  { pattern: /setInterval\s*\(/, kit: "usePoll", note: "uses setInterval — if it POLLS (vs ticking a clock)" },
];

function checkHandRolled(app, files) {
  for (const file of files) {
    if (![".js", ".vue"].includes(extname(file))) continue;
    const src = readFileSync(file, "utf8");
    for (const { pattern, kit, note } of HAND_ROLLED) {
      if (!pattern.test(src)) continue;
      const rel = file.slice(app.dir.length + 1).replace(/\\/g, "/");
      info(app.name, `${rel} hand-rolls ${note} — the kit exports ${kit}`);
    }
  }
}

// ── checks 11-14 · THE SHELL LAYER (added 2026-08-15) ─────────────────────────
// Why these exist: on 2026-08-14 this guard reported "✓ no violations" while the
// three apps opened a folder three different ways (a hand-rolled per-platform
// spawn, the `open` crate, and tauri-plugin-opener), shipped three different
// plugin sets, installed an Electron-era `window.justwrite` global, and carried
// SEVEN copies of `a.download = filename`. Every check below would have FAILED
// that day. A check that would have passed is decoration and does not belong.
//
// The rule they encode: you cannot grep for the same job done differently, so
// each of these asserts the ONE door instead of hunting for its copies.

/** Renderer file → the source, minus its comments (so a comment naming a banned
 *  pattern doesn't trip the check). Crude but adequate: strips // and /* *​/. */
function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// check 11 · ONE save door. `a.download = …` is the shape of a hand-rolled
// download; the kit's fileSave.js is the only place allowed to write it.
function checkOneSaveDoor(app, files) {
  for (const file of files) {
    if (![".js", ".vue"].includes(extname(file))) continue;
    if (!/\.download\s*=/.test(codeOf(file))) continue;
    const rel = file.slice(app.dir.length + 1).replace(/\\/g, "/");
    fail(app.name, `${rel} hand-rolls a file download (\`a.download =\`) — the kit exports saveBlob/downloadBlob (common/services/fileSave.js). JustVoice had FIVE of these.`);
  }
}

// check 12 · ONE door to the shell. `invoke()` belongs in services/native.js, so
// a command's name-as-a-string exists in exactly one place per app. No `@tauri-apps/*`
// import anywhere in src/ (native.js included), and the ONE bridge object — the kit
// preload's `window.appShell` — plus the kit's `isDesktopShell` test are read only by
// native.js (§Q.2, §5; the rule that replaced "no window.<app> global", 2026-10-08).
// check · one Hono. An app's server code takes Hono from the kit, never its own copy: the kit is
// linked (`file:`), and Hono's `app.route()` recognises a sub-app's default error handler by
// identity — a sub-app from a second copy answers errors with Hono's plain 500 (found 2026-10-09).
// Fastify is gone from the family the same day.
function checkOneHono(app, files) {
  for (const file of files) {
    if (extname(file) !== ".js") continue;
    const rel = file.slice(app.dir.length + 1).replace(/\\/g, "/");
    if (!rel.startsWith("server/")) continue;
    const code = codeOf(file);
    if (/\bfrom\s+["'](hono|hono\/[^"']+|@hono\/[^"']+)["']/.test(code)) {
      fail(app.name, `${rel} imports Hono itself — one Hono for the family: take Hono, stream and serveStatic from "@delebash/llm-runner/platform" (§Q.3)`);
    }
    if (/\bfrom\s+["'](fastify|@fastify\/(static|multipart|cors|formbody))["']/.test(code)) {
      fail(app.name, `${rel} imports Fastify — the family's servers are Hono (§Q.3)`);
    }
  }
}

function checkOneShellDoor(app, files) {
  for (const file of files) {
    if (![".js", ".vue"].includes(extname(file))) continue;
    const rel = file.slice(app.dir.length + 1).replace(/\\/g, "/");
    const isDoor = rel === "src/services/native.js";
    const code = codeOf(file);
    if (/@tauri-apps\//.test(code)) {
      fail(app.name, `${rel} imports @tauri-apps — the family has no Tauri; the shell is window.appShell through services/native.js (§Q.2)`);
    }
    if (isDoor) continue;   // THE door itself
    if (/\bwindow\.appShell\b|\bappShell\.(invoke|on)\b/.test(code)) {
      fail(app.name, `${rel} reads window.appShell — the one bridge object is read only by services/native.js (§Q.2)`);
    }
    if (/\bisDesktopShell\b/.test(code)) {
      fail(app.name, `${rel} asks isDesktopShell itself — native.js is the one place that asks (its hasShell) (§Q.2)`);
    }
  }
}

// check 13 · no renderer installs a global on `window`. That was the shape of
// JustWrite's Electron-era `window.justwrite` bridge, deleted 2026-08-14. The one bridge
// is the kit PRELOAD's `window.appShell` — the renderer publishes nothing.
function checkNoWindowGlobal(app, files) {
  for (const file of files) {
    if (![".js", ".vue"].includes(extname(file))) continue;
    const m = codeOf(file).match(/\bwindow\.([A-Za-z_$][\w$]*)\s*=\s*\{/);
    if (!m || ["fetch", "onerror", "onload"].includes(m[1])) continue;
    const rel = file.slice(app.dir.length + 1).replace(/\\/g, "/");
    fail(app.name, `${rel} installs a window.${m[1]} global — apps import modules, they do not publish bridges (the window.justwrite shim died 2026-08-14)`);
  }
}

// check 14 · there is ONE shell, the kit's `runDesktopApp`. An app's desktop main,
// src-electron/electron-main.js (§Q.2), imports it from `@delebash/llm-runner/shell`, passes
// the required config fields, claims its registered port, and imports nothing else but
// `node:*` and `#q-app/electron/main` (for the icon path) — no logic in main. The preload is
// the kit's too: src-electron/electron-preload.js imports it.
const MAIN_REQUIRED_FIELDS = ["id", "appName", "productName", "port", "serverEntry", "dataDirEnv", "repoRoot", "distDir"];
const DESKTOP_MAIN = { rel: "src-electron/electron-main.js", section: "§Q.2", allowed: ["@delebash/llm-runner/shell", "#q-app/electron/main"] };

function checkDesktopMain(app) {
  const { rel, section, allowed } = DESKTOP_MAIN;
  const mainPath = join(app.dir, rel);
  if (!existsSync(mainPath)) return fail(app.name, `${rel} missing — the desktop app is the kit's runDesktopApp (${section})`);
  const code = codeOf(mainPath);
  if (!/import\s*\{[^}]*\brunDesktopApp\b[^}]*\}\s*from\s*["']@delebash\/llm-runner\/shell["']/.test(code)) {
    fail(app.name, `${rel} does not import runDesktopApp from @delebash/llm-runner/shell — the family's one shell (${section})`);
  }
  for (const [, spec] of code.matchAll(/(?:^|\n)\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g)) {
    if (spec.startsWith("node:") || allowed.includes(spec)) continue;
    fail(app.name, `${rel} imports ${spec} — main is the kit's runDesktopApp plus config; no logic lives there (${section})`);
  }
  const at = code.indexOf("runDesktopApp(");
  if (at < 0) return fail(app.name, `${rel} never calls runDesktopApp(…) (${section})`);
  const call = code.slice(at);
  const missing = MAIN_REQUIRED_FIELDS.filter((f) => !new RegExp(`[{,\\s]${f}\\s*[:,}]`).test(call));
  if (missing.length) fail(app.name, `${rel}'s runDesktopApp config has no ${missing.join(", ")} (§Q.2 required fields)`);
  const port = call.match(/[{,\s]port\s*:\s*(\d+)/);
  if (port && APP_PORTS[app.name] && Number(port[1]) !== APP_PORTS[app.name]) {
    fail(app.name, `${rel} passes port ${port[1]} — the registry says ${APP_PORTS[app.name]} (§1)`);
  }
  const preload = join(app.dir, "src-electron", "electron-preload.js");
  if (!existsSync(preload) || !/import\s+["']@delebash\/llm-runner\/shell\/preload["']/.test(codeOf(preload))) {
    fail(app.name, "src-electron/electron-preload.js does not import the kit's preload (@delebash/llm-runner/shell/preload) — §Q.2");
  }
  return undefined;
}

// ── the Quasar layout (app-structure §Q.10) ───────────────────────────────────
// What makes a Quasar app the family's shape rather than Quasar's default: the packaging
// (electron-builder, the main process's local packages installed as real copies), the server
// package beside it, the CSP that lets the page reach its server, the npm traps handled, the
// dev data folder unwatched and uncommitted, and nothing left of the Electron + Vite layout.
function checkQuasar(app) {
  const name = app.name;
  const read = (rel) => (existsSync(join(app.dir, rel)) ? readFileSync(join(app.dir, rel), "utf8") : null);
  const json = (rel) => { const t = read(rel); return t === null ? null : JSON.parse(t); };

  const root = json("package.json") || {};
  if (root.type !== "module") fail(name, `package.json "type" is ${JSON.stringify(root.type)} — the family is "module"`);
  if (!root.allowScripts) fail(name, `package.json has no "allowScripts" — npm 11 refuses the installs Quasar spawns without it (§Q.6)`);
  if (!(root.workspaces || []).includes("server")) fail(name, `package.json "workspaces" doesn't name "server" — one install for the renderer and the server, one copy of what they share (§Q.3)`);
  const node24 = read("scripts/node24.js");
  if (node24 === null) fail(name, "scripts/node24.js missing — the server and its tests run on Electron's own Node (§Q.9)");
  else if (!/ELECTRON_RUN_AS_NODE/.test(node24) || !/src-electron/.test(node24)) {
    fail(name, "scripts/node24.js doesn't run src-electron's Electron as Node (ELECTRON_RUN_AS_NODE) — §Q.9");
  }
  for (const dep of Object.keys({ ...root.dependencies, ...root.devDependencies })) {
    if (dep.startsWith("@tauri-apps/")) fail(name, `package.json depends on ${dep} — the family has no Tauri`);
  }

  const cfg = read("quasar.config.js") || "";
  const needs = [
    [/vueRouterMode:\s*['"]hash['"]/, "build.vueRouterMode 'hash' (§Q.4)"],
    [/bundler:\s*['"]builder['"]/, "electron.bundler 'builder' — electron-builder (§Q.2)"],
    [/extendElectronPackageJson/, "electron.extendElectronPackageJson making the file: dependencies absolute (§Q.2)"],
    [/--install-links/, "electron.unPackagedInstallParams with --install-links (§Q.2)"],
    [/\*\*\/data\/\*\*/, "the dev watcher ignoring **/data/** (§Q.8)"],
    [/delete\s+process\.env\.npm_config_allow_scripts/, "the npm_config_allow_scripts delete (§Q.6)"],
  ];
  for (const [re, what] of needs) if (!re.test(cfg)) fail(name, `quasar.config.js has no ${what}`);

  const electronPkg = json("src-electron/package.json");
  if (!electronPkg) fail(name, "src-electron/package.json missing — the main process's dependencies (§Q.1)");
  else {
    const ver = electronPkg.devDependencies?.electron || electronPkg.dependencies?.electron || "";
    if (!/^\d+\.\d+\.\d+$/.test(ver)) fail(name, `src-electron/package.json pins electron as "${ver}" — exact versions only (§Q.1)`);
    const serverName = json("server/package.json")?.name;
    if (serverName && !electronPkg.dependencies?.[serverName]) {
      fail(name, `src-electron/package.json does not depend on ${serverName} — the packaged app installs only what it names (§Q.3)`);
    }
    if (!electronPkg.allowScripts) fail(name, `src-electron/package.json has no "allowScripts" (§Q.6)`);
  }
  if (existsSync(join(app.dir, "src-capacitor", "package.json")) && !json("src-capacitor/package.json").allowScripts) {
    fail(name, `src-capacitor/package.json has no "allowScripts" (§Q.6)`);
  }

  const html = read("index.html") || "";
  // the policy itself is full of single quotes ('self'), so the attribute is read by its own quote
  const csp = html.match(/http-equiv=["']Content-Security-Policy["'][\s\S]*?content=(?:"([^"]*)"|'([^']*)')/i);
  const policy = csp ? (csp[1] ?? csp[2]) : "";
  if (!csp) fail(name, "index.html has no CSP <meta> — §Q.5");
  else if (!/connect-src[^;]*\bhttp:/.test(policy)) fail(name, "index.html's CSP has no connect-src allowing http: — the page can't reach its server (§Q.5)");

  if (!existsSync(join(app.dir, "biome.json"))) fail(name, "biome.json missing — Biome is the family's linter (§Q.1)");
  if (!/dropQuasarDisabledRule\(\)/.test(read("postcss.config.js") || "")) {
    fail(name, "postcss.config.js doesn't run the kit's dropQuasarDisabledRule() — Quasar's global disabled rule would override every control's own disabled look (§Q.4)");
  }
  if (!/quasarBaseLayer\(\)/.test(read("postcss.config.js") || "")) {
    fail(name, "postcss.config.js doesn't run the kit's quasarBaseLayer() — Quasar's stylesheet would compete with the kit's and the app's rules by specificity and load order (§Q.4)");
  }
  const variables = read("src/css/quasar.variables.scss") || "";
  if (!/@delebash\/llm-ui\/quasar\/variables\.scss/.test(variables)) {
    fail(name, "src/css/quasar.variables.scss doesn't import the kit's @delebash/llm-ui/quasar/variables.scss — the family theme (§Q.4)");
  }
  const qconf = read("quasar.config.js") || "";
  if (!/framework:\s*\{[\s\S]*?config:\s*\{[^}]*\bripple:\s*false/.test(qconf)) {
    fail(name, "quasar.config.js's framework.config doesn't turn the ripple off (ripple: false) — the family draws no Material ripple (§Q.4)");
  }
  if (!/framework:\s*\{[\s\S]*?plugins:\s*\[[^\]]*["']Notify["']/.test(qconf)) {
    fail(name, "quasar.config.js's framework.plugins doesn't list 'Notify' — the kit's pushToast() runs on it (§Q.4)");
  }
  // The kit's controls import Quasar by bare name from the kit's own folder, which has no
  // node_modules: one copy of Quasar comes from the app's, as for the kit's other peers.
  for (const rel of ["quasar.config.js", "vitest.config.js"]) {
    // the spread of Vite's own list (`...(viteConf.resolve.dedupe || [])`) is dropped first — its
    // `[]` would end the match before the app's list
    const text = (read(rel) || "").replace(/\.\.\.\([^)]*\)/g, "");
    const list = text.match(/dedupe\s*(?:=|:)\s*\[([\s\S]*?)\]/);
    if (list && !/["']quasar["']/.test(list[1])) {
      fail(name, `${rel}'s resolve.dedupe has no "quasar" — the kit's controls would load a second Quasar (§Q.4)`);
    }
  }
  const gi = read(".gitignore") || "";
  if (!/^\/?data\/?\s*$/m.test(gi)) fail(name, ".gitignore does not ignore data/ — the dev data folder is never committed (§Q.8)");
  for (const rel of ["vite.config.js", "src/main.js", "electron/main.js", "src-tauri"]) {
    if (existsSync(join(app.dir, rel))) fail(name, `${rel} exists — a Quasar app has none (quasar.config.js is the one build config, boot files replace main.js; §Q.1)`);
  }
  for (const rel of ["src/router/index.js", "src/router/routes.js", "src/stores/index.js", "src/css/quasar.variables.scss", "src/App.vue"]) {
    if (!existsSync(join(app.dir, rel))) fail(name, `${rel} missing — Quasar's layout (§Q.1)`);
  }
  // The renderer is laid out as Quasar's CLI creates a project (the user, 2026-10-09: "whatever the
  // layout that the quassar cli crete for new project is what we use"): the chrome in
  // layouts/MainLayout.vue, the screens in pages/, the stylesheets in css/, and a bare root.
  if (!existsSync(join(app.dir, "src/layouts/MainLayout.vue"))) {
    fail(name, "src/layouts/MainLayout.vue missing — the app's chrome is Quasar's layout, as the CLI creates it (§Q.1)");
  }
  const pagesDir = join(app.dir, "src/pages");
  if (!existsSync(pagesDir) || !walk(pagesDir).some((f) => f.endsWith(".vue"))) {
    fail(name, "src/pages/ has no pages — the screens are <Name>Page.vue there, as the CLI creates them (§Q.1)");
  }
  for (const rel of ["src/views", "src/styles", "src/AppShell.vue"]) {
    if (existsSync(join(app.dir, rel))) fail(name, `${rel} exists — the CLI's layout has pages/, css/ and layouts/MainLayout.vue in its place (§Q.1)`);
  }
  const appVue = read("src/App.vue") || "";
  const appTemplate = (appVue.match(/<template>([\s\S]*)<\/template>/) || [])[1] || "";
  if (appTemplate.replace(/<!--[\s\S]*?-->/g, "").trim() !== "<router-view />") {
    fail(name, "src/App.vue's template is not a bare <router-view /> — what shows is the routes' choice, as the CLI creates the root (§Q.1)");
  }
}

// ── check 6 · the same file in two apps and in neither the kit nor the standard ─
function checkCrossAppTwins(perApp, kitFiles) {
  const seen = new Map();
  for (const [app, files] of perApp) {
    for (const file of files) {
      const name = basename(file);
      if (kitFiles.has(name)) continue;
      if (!seen.has(name)) seen.set(name, []);
      seen.get(name).push({ app, file });
    }
  }
  for (const [name, hits] of seen) {
    if (hits.length < 2) continue;
    // Identical, or near enough that one was copied from the other. Two apps each having
    // their OWN SettingsView.vue is expected and scores ~0; a copied helper scores high.
    const score = similarity(hits[0].file, hits[1].file);
    if (hash(hits[0].file) === hash(hits[1].file)) {
      info("family", `${name} is IDENTICAL in ${hits.map((h) => h.app).join(" + ")} and absent from the kit — should it be shared?`);
    } else if (score >= COPY_THRESHOLD) {
      info("family", `${name} is ${Math.round(score * 100)}% shared between ${hits.map((h) => h.app).join(" + ")} and absent from the kit — a copy nobody promoted?`);
    }
  }
}

// ── check 7 · retired names must not be referenced anywhere ───────────────────
// A move or delete is finished only when nothing points at the old name — code,
// scripts, docs, comments, anything. The convergence pieces retired the names
// below (derived from `git log --diff-filter=DR` over the piece commits; the
// 2026-08-08 backfill sweep). The misses this rule exists to prevent were real:
// JW's smoke.js and bench drive.js spawned the DELETED justwrite_server.cli for
// a day after P3, and JV's __main__.py froze the dead cli.app into the sidecar
// entry. History is exempt (docs/plans/**, the audit ledger, the target tree);
// RETIRED_ALLOW marks per-file provenance prose that DESCRIBES a retirement.
const RETIRED = new Map([
  ["JustWrite", [
    /api\/(autosave|book_transfer|chat|health|images|projects|rag|server_auth|sessions|settings|sweep_draft|versions)\.py\b/,
    /justwrite_server\/(models|seed|demo_seed|database|cli|csrf)\.py\b/,
    /justwrite_server\.(models|seed|demo_seed|cli|csrf)\b/,
    /justwrite_server\/llm\//,
    // The splash skip died in the 2026-08-04 kit BootModelLoad adoption; the
    // stale selector silently broke the smoke's escape for four days.
    /jw-bw-skip\b/,
    // P8: tests live BESIDE their files (the 2-of-3 convention) — the five
    // __tests__/ dirs flattened; ShortcutCheatsheet became KeyboardCheatsheet;
    // tokens.css + styles.css moved to src/styles/.
    /__tests__/,
    /ShortcutCheatsheet/,
    /src\/(tokens|styles)\.css|"\.\/(tokens|styles)\.css"/,
    // P10: the lint script covers the whole include surface; biome schema
    // rides the pinned 2.5.x CLI.
    /"lint": "biome check src"/,
    /schemas\/2\.4\./,
  ]],
  ["JustVoice", [
    /components\/TaskStrip\.vue|components\/TaskStatusPanel\.vue|stores\/renderTasks/,
    /justvoice\/csrf\.py\b|justvoice\.csrf\b/,
    /--no-docs\b/,
    /justvoice\.cli serve\b/,
    // P6: the one api file off the _api naming pattern died into health_api.py.
    /api\/health\.py\b/,
    // P8: OverviewView became HomeView (route name/id "overview" → "home";
    // /overview lives on as a redirect only); useUIStore recased to useUiStore;
    // tokens.css + styles.css moved to src/styles/.
    /OverviewView/,
    /useUIStore/,
    /name: "overview"|id: "overview"|"overview":/,
    /src\/(tokens|styles)\.css|"\.\/(tokens|styles)\.css"/,
    // P11: check 8 found the two JV __tests__ files the JW-scoped P8 pattern
    // missed — flattened, and the name is retired HERE too.
    /__tests__/,
    // P10: the extra "@" src alias died (zero imports used it); lint + schema
    // as in JW.
    /"@": path\.resolve|"@": resolve\(/,
    /"lint": "biome check src"/,
    /schemas\/2\.4\./,
  ]],
  ["docgen", [
    /just_ai_i18n_docgen\/csrf\.py\b/,
    /make_workspace_router\b/,
    /app\.state\.workspace\b/,
    // P9: renderer prefs left localStorage for the family /v1/prefs door —
    // the three storage keys died with the conversion.
    /jaid\.(appearance|aiOfferShown|keepServerRunning)/,
    // P10: docgen left JW's dev port for its own 1450/1451 pair; the FLY002
    // fixture ignore died with the family ruff pin; lint + schema as in JW.
    /localhost:1420|127\.0\.0\.1:1420|"1420"|port: 1420|port: 1421/,
    /FLY002/,
    /"lint": "biome check src && /,
    /schemas\/2\.4\./,
  ]],
]);

const KIT_RETIRED = [
  // Only the five form primitives died in the Ui rename — Lu* FEATURE
  // components (LuRunnerEngine, LuModelCatalog, …) are alive and legitimate.
  /ui\/src\/components\/Lu(Button|Input|Segmented|Textarea|Checkbox)\.vue/,
  /ui\/src\/views\/(PromptLab|RoutingPresets)\.vue/,
  /llm\/(tiers|feature_presets_api)\.py\b/,
  // runner-manifest.json is NOT here: it died long before the program and the
  // codebase deliberately documents that death in prose everywhere it matters.
  /runner\/manifest\.py\b/,
];

// Provenance prose — a line that DESCRIBES a retirement is not a stale
// reference. File-scoped with the reason, same contract as ALLOW above.
const RETIRED_ALLOW = new Map([
  ["JustWrite/tests/smoke/headless-smoke.js", "comment records the stale-selector incident the fix closed"],
  // in Quasar's layout router/routes.js holds the routes (it was router/index.js before the move)
  ["JustVoice/src/router/routes.js", "the /overview redirect's comment records the P8 rename it serves"],
]);

// report/ = committed GENERATED artifacts (jscpd) — point-in-time captures,
// same standing as docs/plans history.
const RETIRED_SKIP = /docs[\\/]plans[\\/]|report[\\/]|check-family\.js/;
const RETIRED_TEXT = new Set([".js", ".mjs", ".cjs", ".vue", ".py", ".md", ".rs", ".json",
  ".toml", ".html", ".css", ".txt", ".yml", ".yaml", ".ps1", ".sh"]);
// "models" = downloaded engine/bench model artifacts (HF caches carry BPE
// vocab.json files where every English word is a token — untracked downloads,
// never repo references; the only tracked models/ entry family-wide is a .gitkeep).
// "release" = electron-builder's output (build output, like dist/ and target/). The repo
// root's "data" = the dev data folder (§Q.8, gitignored in every app): user data and
// downloaded models, never a repo reference — skipped at the root only.
const RETIRED_DIR_SKIP = new Set(["node_modules", "dist", ".git", "__pycache__", ".venv",
  "build", "target", "samples", "coverage", "models", "release"]);

function walkRetired(dir, out = [], root = dir) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (RETIRED_DIR_SKIP.has(entry) || entry.endsWith(".egg-info")) continue;
    if (dir === root && entry === "data") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkRetired(full, out, root);
    else out.push(full);
  }
  return out;
}

function checkRetired(name, dir, patterns) {
  if (!patterns || !patterns.length) return;
  for (const file of walkRetired(dir)) {
    if (!RETIRED_TEXT.has(extname(file))) continue;
    const rel = file.slice(dir.length + 1).replace(/\\/g, "/");
    if (RETIRED_SKIP.test(rel)) continue;
    if (RETIRED_ALLOW.has(`${name}/${rel}`)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const re of patterns) {
        if (re.test(line)) {
          fail(name, `retired name in ${rel}:${i + 1} — ${line.trim().slice(0, 90)}`);
          break;
        }
      }
    });
  }
}

// ── check 8 · the family skeleton (app-structure §14) ────────────────────────────
// For every app: tests live beside their files, the lint script gates the whole include
// surface, and Biome is pinned exact. The Quasar layout itself is checkQuasar's (§Q.10); §14's
// renderer lanes and files are not asserted (the Electron + Vite kind's checks for them went
// with that kind, 2026-10-09).
function checkSkeleton(app) {
  const name = app.name;
  for (const f of walk(join(app.dir, "src"))) {
    if (basename(dirname(f)) === "__tests__") { fail(name, "a src/**/__tests__/ dir is back — tests live BESIDE their files (P8)"); break; }
  }
  const pkgJson = join(app.dir, "package.json");
  if (existsSync(pkgJson)) {
    const p = JSON.parse(readFileSync(pkgJson, "utf8"));
    if (!(p.scripts?.lint || "").startsWith("biome check .")) {
      fail(name, `"lint" is \`${p.scripts?.lint}\` — the include surface needs \`biome check .\` (P10)`);
    }
    const biome = p.devDependencies?.["@biomejs/biome"] || p.dependencies?.["@biomejs/biome"] || "";
    if (/[\^~]/.test(biome)) fail(name, `@biomejs/biome "${biome}" is a RANGE — the family pins exact (P10)`);
  }
}

// Cross-app: ONE biome config means byte-one — hash-compare the apps' files; and the pinned
// biome version must be the SAME exact version everywhere, the template included.
function checkSkeletonCrossApp() {
  const apps = APPS.filter((a) => a.kind === "quasar" && existsSync(join(a.dir, "biome.json")));
  const distinct = new Set(apps.map((a) => hash(join(a.dir, "biome.json"))));
  if (apps.length > 1 && distinct.size > 1) {
    fail("family", `biome.json differs between the apps (${apps.map((a) => a.name).join(" / ")}) — one config, byte-identical (P10)`);
  }
  const versions = new Set([...APPS, TEMPLATE].map((a) => {
    const p = join(a.dir, "package.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).devDependencies?.["@biomejs/biome"] : undefined;
  }).filter(Boolean));
  if (versions.size > 1) fail("family", `@biomejs/biome versions differ: ${[...versions].join(" vs ")} (P10)`);
}

// Kit self: the family answers apply to this repo too.
function checkSkeletonKit() {
  if (!existsSync(join(KIT, ".gitattributes"))) fail("kit", ".gitattributes missing (P10)");
}


// ── check 9 · the family docs standard (decided 2026-08-08, docs/dev/TASKS.md) ─
// ADVISORY ON PURPOSE, and this is a judgement, not laziness: the backlog it
// measures is known and large (JustWrite ships no ai-features page and no
// troubleshooting page at all), so promoting these to fail() today would leave
// the script exiting 1 until the whole docs program lands — which is precisely
// how a gate stops being read. Promote to fail() once the reported gap is closed.
//
// What this check does NOT do, by ruling: compare prose between apps. Each app
// writes its own pages. Every failure on record was naming, coverage or accuracy
// — never cross-app wording — so nothing here hashes or diffs a page body.
const DOC_REQUIRED = ["getting-started", "ai-features", "ai-providers", "troubleshooting", "whats-new"];

// An app need not document a concept; if it does, it uses the family's name.
const DOC_RENAME = new Map([
  ["providers", "ai-providers"],
  ["ai-setup", "ai-providers"],
  ["backup-restore", "backups-and-data"],
  ["import-formats", "import-and-export"],
  ["export", "import-and-export"],
]);

// One topic, one page, PER APP. JustWrite documents Quick Setup twice in its own
// repo (ai-providers.md + models.md) — the duplication a cross-app check can
// never see, and the reason this one is scoped inside an app.
const DOC_TOPICS = new Map([
  ["Quick Setup", /^quick setup\b/],
  ["routing by feature", /\brouting (by )?features?\b/],
  ["the model catalog", /\bmodel catalog\b/],
]);

const docSlugs = (dir) => (existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md"))
  : []);
const normHeading = (h) => h.replace(/[—–:].*$/, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

function readToc(app) {
  const p = join(app.dir, "docs/toc.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function checkDocs(app) {
  const dir = join(app.dir, "docs");
  const slugs = docSlugs(dir);
  if (!slugs.length) return;

  // Renames first: a page that exists under the wrong name is ONE finding, not
  // two. Reporting "ai-providers.md missing" beside "providers.md should be
  // ai-providers.md" doubles the noise and overstates the gap.
  const renamesTo = new Set();
  for (const slug of slugs) {
    const canonical = DOC_RENAME.get(slug);
    if (!canonical) continue;
    renamesTo.add(canonical);
    info(app.name, `docs/${slug}.md — the family name for this page is ${canonical}.md`);
  }
  for (const want of DOC_REQUIRED) {
    if (slugs.includes(want) || renamesTo.has(want)) continue;
    info(app.name, `docs/${want}.md missing — family required page (docs standard)`);
  }

  const toc = readToc(app);
  if (!toc) { info(app.name, "docs/toc.json missing or unparseable"); return; }
  // JW keys its groups `section`, JV/docgen `group` — both are named groups.
  // (The first run of this check misread JW's key and reported 5 unnamed
  // groups that were named all along — a checker bug, not a docs gap.)
  const unnamed = toc.filter((g) => !String(g.group || g.section || "").trim()).length;
  if (unnamed) info(app.name, `docs/toc.json has ${unnamed} unnamed group(s) — groups carry names in every app`);

  // one topic, one page
  const byTopic = new Map();
  for (const slug of slugs) {
    const src = readFileSync(join(dir, `${slug}.md`), "utf8");
    for (const line of src.split("\n")) {
      if (!line.startsWith("## ")) continue;
      const h = normHeading(line.slice(3));
      for (const [topic, re] of DOC_TOPICS) {
        if (!re.test(h)) continue;
        if (!byTopic.has(topic)) byTopic.set(topic, new Set());
        byTopic.get(topic).add(slug);
      }
    }
  }
  for (const [topic, pages] of byTopic) {
    if (pages.size > 1) info(app.name, `"${topic}" is documented in ${pages.size} pages — ${[...pages].join(", ")} (one topic, one page)`);
  }
}

// A slug must mean the same thing everywhere. The toc TITLE is the derivable
// signal: JustVoice's `presets` was titled "Render presets" (audio) while
// JustWrite's is the LLM preset bar — same filename, different subject (JV's
// renamed to render-presets, 2026-08-08). Title comparison is a PROXY — an
// app-voiced title over the SAME subject is legitimate, so ruled cases live in
// TITLE_ALLOW with the reason, same contract as ALLOW above.
const TITLE_ALLOW = new Map([
  ["ai-providers", "same subject, app-voiced: JV's page genuinely covers TTS providers too; docgen's is its first-run setup door (2026-08-08)"],
]);
function checkDocsCrossApp() {
  const titles = new Map();
  for (const app of APPS) {
    for (const group of readToc(app) || []) {
      for (const item of group.items || []) {
        if (!titles.has(item.slug)) titles.set(item.slug, new Map());
        titles.get(item.slug).set(app.name, item.title);
      }
    }
  }
  for (const [slug, perApp_] of titles) {
    if (perApp_.size < 2) continue;
    if (TITLE_ALLOW.has(slug)) continue;
    const distinct = new Set([...perApp_.values()].map((t) => normHeading(t)));
    if (distinct.size > 1) {
      const shown = [...perApp_].map(([a, t]) => `${a}="${t}"`).join(" vs ");
      info("family", `slug "${slug}" carries different titles — ${shown} (a slug means one thing family-wide)`);
    }
  }
}

// ── check 10 · a tracker item carries its decision (format ruling 2026-08-08) ──
// Twice this failed: prose that restated code and went stale, then stubs that
// dropped the decision and made a later session excavate it from a transcript.
// The format is six fields; the two that cannot be reconstructed from code are
// STATE (what was decided, in the user's words) and GO. Advisory for the same
// reason as check 9 — JustWrite's and the kit's trackers predate the ruling.
function checkTrackerFormat() {
  const trackers = [...APPS.map((a) => [a.name, join(a.dir, "docs/dev/TASKS.md")]), ["kit", join(KIT, "docs/dev/TASKS.md")]];
  for (const [name, file] of trackers) {
    if (!existsSync(file)) { info(name, "docs/dev/TASKS.md missing"); continue; }
    let heading = null;
    let body = [];
    const flush = () => {
      if (!heading) return;
      const text = body.join("\n");
      const missing = ["STATE", "GO"].filter((f) => !new RegExp(`^${f}:`, "m").test(text));
      if (missing.length) info(name, `TASKS.md item "${heading.slice(0, 60)}" has no ${missing.join(" / ")} line (format ruling)`);
    };
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.startsWith("### ")) { flush(); heading = line.slice(4).trim(); body = []; }
      else if (line.startsWith("## ")) { flush(); heading = null; body = []; }
      else if (heading) body.push(line);
    }
    flush();
  }
}

// ── check 15 · research lands in the register (decided 2026-10-04) ─────────────
// The day this was born, four review agents re-read JustVoice's code to learn
// that installing a model restarts its speech runtime — written three days
// earlier as one bullet in a 376-line plan doc that nothing pointed at. The rule
// (app-structure §13): every repo keeps docs/dev/RESEARCH.md, organised by
// subject; research is not done until its facts are there. This check can see
// the LINK, not that the facts came with it — that half stays the rule. Plans
// dated before the rule are indexed by hand, not policed.
const RESEARCH_SINCE = "2026-10-04";

function checkResearchRegister(name, repoDir) {
  const reg = join(repoDir, "docs/dev/RESEARCH.md");
  if (!existsSync(reg)) { fail(name, "docs/dev/RESEARCH.md missing — the research register (app-structure §13)"); return; }
  const text = readFileSync(reg, "utf8");
  const plans = join(repoDir, "docs/plans");
  for (const f of existsSync(plans) ? readdirSync(plans) : []) {
    const m = /^(\d{4}-\d{2}-\d{2})-.+\.md$/.exec(f);
    if (!m || m[1] < RESEARCH_SINCE) continue;
    if (!text.includes(f)) fail(name, `docs/plans/${f} is not linked from docs/dev/RESEARCH.md — research lands in the register`);
  }
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const path = target.split("#")[0];
    if (!path || /^(https?|mailto):/.test(path)) continue;
    if (!existsSync(resolve(dirname(reg), decodeURIComponent(path)))) {
      fail(name, `docs/dev/RESEARCH.md links ${target}, which does not exist`);
    }
  }
}

// ── check 11 · app code never owns a task lifecycle (AI-call convention, §8) ──
// The day this was born (2026-08-08): 17 hand-managed task sites in JustVoice,
// every finish() bare, no LLM task ever showed a token — while the server
// returned usage on every response. The convention: app code calls the kit
// runners (runAiFeature / withAiTask / runAiEndpoint) and never CREATES a task
// itself. READING the store is free and common (App.vue's global stack, the
// modals that hand their inline AiTaskStrip its task, dashboards, guards) — the
// first draft of this check flagged imports and immediately proved 19 of 23
// flagged files were readers, so the crime is the CALL, not the import:
// `<store>.start({` in a file that imports the store. `.start()` without an
// object stays legal (job-channel objects like an engine download task have
// their own start()).
const TASK_START_ALLOW = new Map([
  // "App/file" → the human ruling. EMPTY is the healthy state; an entry means
  // a ruled exception, and a growing list means call sites are dodging the
  // runners, not that the code is fine.
]);

function checkTaskLifecycle(app, files) {
  for (const f of files) {
    if (!/\.(vue|js)$/.test(f) || f.includes(".test.")) continue;
    const src = readFileSync(f, "utf8");
    if (!/useAiTasksStore/.test(src) || !/\.start\(\{/.test(src)) continue;
    const rel = relative(app.dir, f).replaceAll("\\", "/");
    if (TASK_START_ALLOW.has(`${app.name}/${rel}`)) continue;
    fail(app.name, `${rel} starts a task on useAiTasksStore directly — lifecycles belong to the kit runners withAiTask/runAiEndpoint/runAiFeature (app-structure §8, AI-call convention)`);
  }
}

// ── run ───────────────────────────────────────────────────────────────────────
const exports_ = kitExports();
const kitFiles = new Map();
for (const f of walk(join(KIT, "ui/src"))) kitFiles.set(basename(f), f);

const perApp = [];
for (const app of APPS) {
  if (!existsSync(app.dir)) { fail(app.name, `not found at ${app.dir}`); continue; }
  const files = walk(join(app.dir, "src"));
  perApp.push([app.name, files]);
  checkForks(app, files, exports_);
  checkDrift(app, files, kitFiles);
  // the layout checks need a Quasar app; one without quasar.config.js gets one violation instead
  if (app.kind === "unknown") {
    fail(app.name, "no quasar.config.js — every family app is a Quasar app (§Q); the layout checks can't run");
  } else {
    checkScripts(app);
    checkServer(app);
    checkSkeleton(app);
    checkDesktopMain(app);
    checkQuasar(app);
  }
  checkHandRolled(app, files);
  checkRetired(app.name, app.dir, RETIRED.get(app.name));
  checkDocs(app);
  checkTaskLifecycle(app, files);
  checkOneSaveDoor(app, files);
  checkOneShellDoor(app, files);
  checkOneHono(app, [...walk(join(app.dir, "server", "src")), ...walk(join(app.dir, "server", "tests"))]);
  checkNoWindowGlobal(app, files);
  checkResearchRegister(app.name, app.dir);
}
// The §Q reference app: the layout checks and the shell doors only (it is not a product).
if (TEMPLATE.kind !== "quasar") {
  fail(TEMPLATE.name, `${TEMPLATE.dir} has no quasar.config.js — the template is the §Q reference app`);
} else {
  const files = walk(join(TEMPLATE.dir, "src"));
  checkScripts(TEMPLATE);
  checkServer(TEMPLATE);
  checkSkeleton(TEMPLATE);
  checkDesktopMain(TEMPLATE);
  checkQuasar(TEMPLATE);
  checkOneSaveDoor(TEMPLATE, files);
  checkOneShellDoor(TEMPLATE, files);
  checkOneHono(TEMPLATE, walk(join(TEMPLATE.dir, "server", "src")));
  checkNoWindowGlobal(TEMPLATE, files);
}
checkCrossAppTwins(perApp, kitFiles);
checkDocsCrossApp();
checkTrackerFormat();
checkSkeletonCrossApp();
checkRetired("kit", KIT, KIT_RETIRED);
checkSkeletonKit();
checkResearchRegister("kit", KIT);

const showInfo = process.argv.includes("--info");
console.log(`\nfamily check — ${APPS.length} apps + the template against the kit (${exports_.size} kit exports)`);
console.log(`  kinds: ${[...APPS, TEMPLATE].map((a) => `${a.name} ${a.kind}`).join(" · ")}\n`);
if (problems.length) {
  console.log("VIOLATIONS\n");
  for (const p of problems) console.log(`  ✗ ${p}`);
} else {
  console.log("  ✓ no violations");
}
if (showInfo && infos.length) {
  console.log("\nADVISORY (not failures — judgement required)\n");
  for (const i of infos) console.log(`  · ${i}`);
} else if (infos.length) {
  console.log(`\n  (${infos.length} advisory findings — re-run with --info to see them)`);
}
console.log("");
process.exit(problems.length ? 1 : 0);
