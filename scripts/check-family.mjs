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
import { basename, dirname, extname, join, resolve } from "node:path";
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
  ]],
  ["docgen", [
    /just_ai_i18n_docgen\/csrf\.py\b/,
    /make_workspace_router\b/,
    /app\.state\.workspace\b/,
    // P9: renderer prefs left localStorage for the family /v1/prefs door —
    // the three storage keys died with the conversion.
    /jaid\.(appearance|aiOfferShown|keepServerRunning)/,
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
}
checkCrossAppTwins(perApp, kitFiles);
checkRetired("kit", KIT, KIT_RETIRED);

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
