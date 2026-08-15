// SPDX-License-Identifier: MIT
// The family divergence check — the three apps against the kit and each other.
//
// Every finding of the 2026-08-07 structure audit (docs/family-structure-audit.md) was
// something a script could have caught the DAY it appeared: a fork of a component the kit
// already exports, a copy of a kit file that had quietly drifted, a missing npm script, a
// server entry module that isn't `serve.py`. Instead they accumulated for months and were
// found by hand. This is that script. Nothing clever — it reads files and compares them.
//
//   Run:  node scripts/check-family.mjs            (exit 0 = clean, 1 = violations)
//         node scripts/check-family.mjs --info     (also print the advisory findings)
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
//     docs/family-structure-audit.md.
//  3. Whether a concept SHOULD be shared at all is judgement. Everything under ADVISORY is
//     a question, not a verdict.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAMILY = resolve(KIT, "..");

const APPS = [
  { name: "JustWrite", dir: join(FAMILY, "justwrite-app") },
  { name: "JustVoice", dir: join(FAMILY, "JustVioce") },
  { name: "docgen", dir: join(FAMILY, "just_ai_i18n_docgen") },
];

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

// ── check 3 · npm script names are the contract (app-structure §2) ────────────
// §2's list, plus the two §10 names ("same names in every app") for the e2e harness.
const REQUIRED_SCRIPTS = [
  "dev", "dev:vite", "build", "build:vite", "preview:vite", "server", "lint", "test:server", "tauri",
  "test", "screenshots",
];

function checkScripts(app) {
  const pkgPath = join(app.dir, "package.json");
  if (!existsSync(pkgPath)) return fail(app.name, "no package.json");
  const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts || {};
  for (const need of REQUIRED_SCRIPTS) {
    if (!scripts[need]) fail(app.name, `package.json has no "${need}" script (§2 names are the contract)`);
  }
  const server = scripts.server || "";
  if (server && !/\.serve serve/.test(server)) {
    fail(app.name, `"server" runs \`${server.replace(/^cd server && /, "")}\` — §6 says \`-m <snake>.serve serve\``);
  }
  return undefined;
}

// ── check 4 · the Python server layout (app-structure §6) ─────────────────────
function checkServer(app) {
  const serverDir = join(app.dir, "server");
  if (!existsSync(serverDir)) return info(app.name, "no server/ directory");
  // A server package is a directory with an __init__.py. Without that test this picked up
  // .pytest_cache, .ruff_cache, and JustVoice's nested justvoice_plugin/ sub-project (which
  // has its own pyproject.toml and is not a second server).
  const pkgs = readdirSync(serverDir).filter((d) => {
    if (SKIP.has(d) || d.startsWith(".") || d.endsWith(".egg-info") || d === "tests") return false;
    if (!statSync(join(serverDir, d)).isDirectory()) return false;
    return existsSync(join(serverDir, d, "__init__.py"));
  });
  if (pkgs.length !== 1) return fail(app.name, `expected exactly one server package, found: ${pkgs.join(", ") || "none"}`);
  const pkg = pkgs[0];
  if (!existsSync(join(serverDir, pkg, "serve.py"))) {
    const alt = ["cli.py", "main.py"].find((f) => existsSync(join(serverDir, pkg, f)));
    fail(app.name, `server/${pkg}/ has no serve.py${alt ? ` (entry is ${alt})` : ""} — §6`);
  }
  const proj = join(serverDir, "pyproject.toml");
  if (existsSync(proj)) {
    const text = readFileSync(proj, "utf8");
    const script = text.match(/^([a-z0-9-]+-server)\s*=\s*"([^"]+)"/m);
    if (!script) fail(app.name, "pyproject has no `<name>-server = ...` console script — §6");
    else if (!script[2].endsWith(".serve:main")) fail(app.name, `console script targets \`${script[2]}\` — §6 says \`<snake>.serve:main\``);
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
// a command's name-as-a-string exists in exactly one place per app.
function checkOneShellDoor(app, files) {
  for (const file of files) {
    if (![".js", ".vue"].includes(extname(file))) continue;
    const rel = file.slice(app.dir.length + 1).replace(/\\/g, "/");
    if (rel === "src/services/native.js") continue;   // THE door itself
    if (!/@tauri-apps\/api\/core/.test(codeOf(file))) continue;
    fail(app.name, `${rel} imports Tauri's invoke directly — every command goes through services/native.js (family shape 2026-08-15)`);
  }
}

// check 13 · no renderer installs a global on `window`. That was the shape of
// JustWrite's Electron-era `window.justwrite` bridge, deleted 2026-08-14.
function checkNoWindowGlobal(app, files) {
  for (const file of files) {
    if (![".js", ".vue"].includes(extname(file))) continue;
    const m = codeOf(file).match(/\bwindow\.([A-Za-z_$][\w$]*)\s*=\s*\{/);
    if (!m || ["fetch", "onerror", "onload"].includes(m[1])) continue;
    const rel = file.slice(app.dir.length + 1).replace(/\\/g, "/");
    fail(app.name, `${rel} installs a window.${m[1]} global — apps import modules, they do not publish bridges (the window.justwrite shim died 2026-08-14)`);
  }
}

// check 14 · the shells declare the SAME Tauri surface — same plugins, same
// permissions — and declare nothing they don't use.
function checkShellParity() {
  const plugins = new Map();
  const perms = new Map();
  for (const app of APPS) {
    const cargo = join(app.dir, "src-tauri/Cargo.toml");
    const libRs = join(app.dir, "src-tauri/src/lib.rs");
    const capDir = join(app.dir, "src-tauri/capabilities");
    if (!existsSync(cargo) || !existsSync(libRs)) continue;

    const declared = [...readFileSync(cargo, "utf8").matchAll(/^tauri-plugin-([\w-]+)\s*=/gm)].map((m) => m[1]);
    plugins.set(app.name, declared.sort().join(","));

    // Declared but never initialised = dead weight (http/fs/process were all
    // init-only in two shells until 2026-08-15).
    const rs = readFileSync(libRs, "utf8");
    for (const p of declared) {
      const snake = p.replace(/-/g, "_");
      if (!new RegExp(`tauri_plugin_${snake}::`).test(rs)) {
        fail(app.name, `Cargo declares tauri-plugin-${p} but lib.rs never uses it`);
      }
    }

    if (existsSync(capDir)) {
      const ids = [];
      for (const f of readdirSync(capDir).filter((f) => f.endsWith(".json"))) {
        const cap = JSON.parse(readFileSync(join(capDir, f), "utf8"));
        for (const p of cap.permissions || []) ids.push(typeof p === "string" ? p : p.identifier);
      }
      perms.set(app.name, ids.sort().join(","));
    }
  }
  for (const [label, map] of [["plugin set", plugins], ["capability permissions", perms]]) {
    const values = new Set(map.values());
    if (values.size > 1) {
      const detail = [...map].map(([a, v]) => `${a}=[${v}]`).join("  ");
      fail("family", `the three shells declare different ${label}: ${detail}`);
    }
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
  ["JustVoice/server/justvoice/cli.py", "docstring records the --no-docs flag's death (P3)"],
  ["JustWrite/tests/smoke/headless-smoke.js", "comment records the stale-selector incident the fix closed"],
  ["JustVoice/src/router/index.js", "the /overview redirect's comment records the P8 rename it serves"],
  ["docgen/server/pyproject.toml", "the ruff-pin comment records the wide-defaults fixture ignore it retired (P10)"],
]);

// report/ = committed GENERATED artifacts (jscpd) — point-in-time captures,
// same standing as docs/plans history.
const RETIRED_SKIP = /docs[\\/]plans[\\/]|report[\\/]|family-structure-audit\.md|target-tree\.md|check-family\.mjs/;
const RETIRED_TEXT = new Set([".js", ".mjs", ".cjs", ".vue", ".py", ".md", ".rs", ".json",
  ".toml", ".html", ".css", ".txt", ".yml", ".yaml", ".ps1", ".sh"]);
// "models" = downloaded engine/bench model artifacts (HF caches carry BPE
// vocab.json files where every English word is a token — untracked downloads,
// never repo references; the only tracked models/ entry family-wide is a .gitkeep).
const RETIRED_DIR_SKIP = new Set(["node_modules", "dist", ".git", "__pycache__", ".venv",
  "build", "target", "samples", "coverage", "models"]);

function walkRetired(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (RETIRED_DIR_SKIP.has(entry) || entry.endsWith(".egg-info")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkRetired(full, out);
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

// ── check 8 · the family skeleton — target-tree.md §1–§3, executed P2–P10 ─────
// The ratified page as assertions, INCLUDING its recorded N/As: docgen has no
// database/ (domain persistence = workspace sidecars + the shared runner DB),
// no KeyboardCheatsheet (feature absent), and — like its i18n — no composables/
// until it has a composable. api/ may hold leading-underscore PRIVATE helpers
// beside the `<area>_api.py` route files (JV's _persona_helpers.py).
const SERVER_SKELETON = ["serve.py", "app.py", "app_state.py", "paths.py", "version.py", "auth.py"];
const RENDERER_LANES = ["components", "views", "stores", "services", "router", "styles"];
const SKELETON_FILES = [
  "src/styles/tokens.css", "src/styles/styles.css", "src/views/HomeView.vue",
  "src/boot.smoke.test.js", "src/services/helpDocs.js", "src/stores/ui.js",
  "scripts/py.js", ".gitattributes", "biome.json", "vite.config.js", "vitest.config.js",
];
const DEV_PORTS = { JustWrite: 1420, JustVoice: 1430, docgen: 1450 };
const APP_HAS = {
  composables: new Set(["JustWrite", "JustVoice"]),
  database: new Set(["JustWrite", "JustVoice"]),
  cheatsheet: new Set(["JustWrite", "JustVoice"]),
  errorsAlias: new Set(["JustWrite", "JustVoice"]),
};
const RUFF_PIN = 'select = ["E4", "E7", "E9", "F"]';

// The kit-door content pins: the named file must actually ride the kit, or the
// adapter has been re-forked in place (name intact, implementation regrown).
const DOOR_PINS = [
  ["src/boot.smoke.test.js", /registerBootSmoke/, "the kit bootSmoke skeleton"],
  ["src/services/helpDocs.js", /makeDocsHelpAdapter/, "the kit helpDocs factory"],
  ["src/stores/ui.js", /useUiStore/, "the family store name"],
  // JW's py.js rides the kit via its ONE intra-repo door (tests/lib/smoke-common.js);
  // JV/docgen import the kit file directly — both forms are the ratified P7 shape.
  ["scripts/py.js", /exec-resolve\.mjs|smoke-common\.js/, "the kit exec resolver (directly or via the app's door)"],
];

function serverPkgOf(app) {
  const serverDir = join(app.dir, "server");
  if (!existsSync(serverDir)) return null;
  const pkgs = readdirSync(serverDir).filter((d) => {
    if (SKIP.has(d) || d.startsWith(".") || d.endsWith(".egg-info") || d === "tests") return false;
    if (!statSync(join(serverDir, d)).isDirectory()) return false;
    return existsSync(join(serverDir, d, "__init__.py"));
  });
  return pkgs.length === 1 ? join(serverDir, pkgs[0]) : null; // check 4 reports the !=1 case
}

function checkSkeleton(app) {
  const name = app.name;
  // ── server package ──
  const pkg = serverPkgOf(app);
  if (pkg) {
    for (const f of SERVER_SKELETON) {
      if (!existsSync(join(pkg, f))) fail(name, `server package has no ${f} — the skeleton (§1)`);
    }
    if (existsSync(join(pkg, "csrf.py"))) fail(name, "server package has csrf.py — CSRF is pure kit (P2)");
    const errors = join(pkg, "errors.py");
    if (APP_HAS.errorsAlias.has(name)) {
      if (!existsSync(errors)) fail(name, "errors.py alias missing — §3b says it re-exports the platform helpers");
      else if (!/from llm_runner\.platform/.test(readFileSync(errors, "utf8"))) {
        fail(name, "errors.py does not import llm_runner.platform — the alias has regrown an implementation");
      }
    } else if (existsSync(errors)) {
      fail(name, "errors.py appeared — the ratified state has no docgen alias (nothing imported it)");
    }
    const api = join(pkg, "api");
    if (!existsSync(api)) fail(name, "no api/ package — the skeleton (§1)");
    else {
      for (const f of readdirSync(api)) {
        if (!f.endsWith(".py") || f === "__init__.py" || f.startsWith("_")) continue;
        if (!f.endsWith("_api.py")) fail(name, `api/${f} breaks the <area>_api.py naming (§1)`);
      }
      if (!existsSync(join(api, "health_api.py"))) fail(name, "api/ has no health_api.py (§1)");
    }
    const pyText = walk(pkg).filter((f) => f.endsWith(".py")).map((f) => readFileSync(f, "utf8")).join("\n");
    if (!pyText.includes("make_prefs_router")) fail(name, "no make_prefs_router mount — the family /v1/prefs door (P9)");
    const db = join(pkg, "database");
    if (APP_HAS.database.has(name)) {
      for (const f of ["session.py", "models.py", "seed.py"]) {
        if (!existsSync(join(db, f))) fail(name, `database/${f} missing — the SQL skeleton (§1)`);
      }
    } else if (existsSync(db)) {
      fail(name, "database/ appeared — docgen's ratified state is NO app-owned SQL package (§1 N/A)");
    }
    const proj = join(app.dir, "server", "pyproject.toml");
    if (existsSync(proj) && !readFileSync(proj, "utf8").includes(RUFF_PIN)) {
      fail(name, `pyproject has no family ruff pin \`${RUFF_PIN}\` (P10)`);
    }
  }
  // ── renderer ──
  for (const lane of RENDERER_LANES) {
    if (!existsSync(join(app.dir, "src", lane))) fail(name, `src/${lane}/ lane missing (§2)`);
  }
  if (APP_HAS.composables.has(name) && !existsSync(join(app.dir, "src", "composables"))) {
    fail(name, "src/composables/ lane missing (§2)");
  }
  for (const rel of SKELETON_FILES) {
    if (!existsSync(join(app.dir, rel))) fail(name, `${rel} missing — the skeleton (§2/§3)`);
  }
  if (APP_HAS.cheatsheet.has(name) && !existsSync(join(app.dir, "src/components/KeyboardCheatsheet.vue"))) {
    fail(name, "KeyboardCheatsheet.vue missing (§2)");
  }
  for (const [rel, re, what] of DOOR_PINS) {
    const p = join(app.dir, rel);
    if (existsSync(p) && !re.test(readFileSync(p, "utf8"))) {
      fail(name, `${rel} no longer rides ${what} — the door has been re-forked in place`);
    }
  }
  for (const f of walk(join(app.dir, "src"))) {
    if (basename(dirname(f)) === "__tests__") { fail(name, "a src/**/__tests__/ dir is back — tests live BESIDE their files (P8)"); break; }
  }
  // ── config ──
  const vite = join(app.dir, "vite.config.js");
  if (existsSync(vite)) {
    const text = readFileSync(vite, "utf8");
    if (!text.includes('"@renderer"')) fail(name, "vite.config.js has no @renderer alias (§3)");
    if (!text.includes(`port: ${DEV_PORTS[name]}`)) fail(name, `vite.config.js is not on this app's dev port ${DEV_PORTS[name]} (§3)`);
  }
  const vitest = join(app.dir, "vitest.config.js");
  if (existsSync(vitest) && !readFileSync(vitest, "utf8").includes('"@renderer"')) {
    fail(name, "vitest.config.js has no @renderer alias (§3 — vite/vitest in lock-step)");
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

// Cross-app: ONE biome config means byte-one — hash-compare the three files;
// and the pinned biome version must be the SAME exact version everywhere.
function checkSkeletonCrossApp() {
  const entries = APPS.filter((a) => existsSync(join(a.dir, "biome.json")))
    .map((a) => [a.name, hash(join(a.dir, "biome.json"))]);
  const distinct = new Set(entries.map(([, h]) => h));
  if (entries.length === APPS.length && distinct.size > 1) {
    fail("family", `biome.json differs between apps (${entries.map(([n]) => n).join(" / ")}) — one config, byte-identical (P10)`);
  }
  const versions = new Set(APPS.map((a) => {
    const p = join(a.dir, "package.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).devDependencies?.["@biomejs/biome"] : undefined;
  }).filter(Boolean));
  if (versions.size > 1) fail("family", `@biomejs/biome versions differ: ${[...versions].join(" vs ")} (P10)`);
}

// Kit self: the family answers apply to this repo too.
function checkSkeletonKit() {
  if (!existsSync(join(KIT, ".gitattributes"))) fail("kit", ".gitattributes missing (P10)");
  const proj = join(KIT, "pyproject.toml");
  if (existsSync(proj) && !readFileSync(proj, "utf8").includes(RUFF_PIN)) {
    fail("kit", `pyproject has no family ruff pin \`${RUFF_PIN}\` (P10)`);
  }
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
  checkScripts(app);
  checkServer(app);
  checkHandRolled(app, files);
  checkRetired(app.name, app.dir, RETIRED.get(app.name));
  checkSkeleton(app);
  checkDocs(app);
  checkTaskLifecycle(app, files);
  checkOneSaveDoor(app, files);
  checkOneShellDoor(app, files);
  checkNoWindowGlobal(app, files);
}
checkShellParity();
checkCrossAppTwins(perApp, kitFiles);
checkDocsCrossApp();
checkTrackerFormat();
checkSkeletonCrossApp();
checkRetired("kit", KIT, KIT_RETIRED);
checkSkeletonKit();

const showInfo = process.argv.includes("--info");
console.log(`\nfamily check — ${APPS.length} apps against the kit (${exports_.size} kit exports)\n`);
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
