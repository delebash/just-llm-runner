// SPDX-License-Identifier: MIT
// The family's ONE implementation of "find a platform-specific executable" for
// node-side dev tooling — browser (Playwright Chromium) and project Python —
// plus the tiny wait/poll helpers the smoke gates share.
//
// Consumed by FILE-RELATIVE import from each app's adapter (the vite alias only
// exists inside the renderer build; `node scripts/py.js` runs plain node):
//   JustWrite  tests/lib/smoke-common.js  + scripts/py.js
//   JustVoice  scripts/lib/smoke-common.js + scripts/py.js
//   docgen     scripts/py.js
// The sibling-checkout layout (E:\Dev\Web\<repo>) is already load-bearing for
// the renderer (the @delebash/llm-ui alias) and the kit's own pytest recipe.
//
// WHY one home: both JW and JV independently learned that per-script copies of
// findChrome() rot — JW counted 20 intra-repo copies before extracting its
// shared version (2026-07-19), JV's seven verify scripts hardcoded a Linux path
// pinned to a browser version so the gate could not run on Windows at all
// (fixed 2026-07-29). Then the two "one homes" forked ACROSS repos — the exact
// disease they each cured intra-repo. This file ends that: apps keep thin
// adapters that bind their env-var names and venv layout, nothing more.
//
// Per-app facts stay in the adapters, passed explicitly: the env override names
// (JW_CHROME/JW_PYTHON, JV_CHROME/JV_PYTHON, JAID_PYTHON) and the venv location
// (JW: .venv at the repo root; JV + docgen: server/.venv).

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-platform browser layout under <root>/<chromium-dir>/, in probe order.
// The Linux entry is what the dev container ships; win64/win + mac cover the
// user's Windows box and macOS (verified 2026-07-19:
// chromium-1228/chrome-win64/chrome.exe).
const LAYOUTS = [
  "chrome-linux/chrome",
  "chrome-win64/chrome.exe",
  "chrome-win/chrome.exe",
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
];

function browserRoots() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return [
    // The dev container's PREBUILT browsers. This path is not a Playwright
    // registry location, which is the whole reason this scan exists.
    "/opt/pw-browsers",
    home ? join(home, ".cache", "ms-playwright") : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "",
  ].filter(Boolean);
}

/**
 * Path to a usable Chromium executable, or `undefined`.
 *
 * `undefined` is a SUCCESS value, not a failure: with `executablePath` omitted,
 * Playwright resolves the browser from its own registry, which is the normal
 * path on a stock Windows/macOS dev box. The scan below exists for installs
 * Playwright does NOT know about (the container's /opt/pw-browsers). The app's
 * env var (`env`, e.g. "JV_CHROME") overrides everything.
 *
 * headless_shell builds are skipped on purpose — they lack the full browser
 * surface the smoke scripts drive, and selecting one breaks the launch.
 */
export function findChrome({ env } = {}) {
  const override = env ? process.env[env] : "";
  if (override && existsSync(override)) return override;
  for (const root of browserRoots()) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue; // unreadable root — try the next one
    }
    for (const dir of entries) {
      if (!dir.startsWith("chromium") || dir.includes("headless_shell")) continue;
      for (const layout of LAYOUTS) {
        const exe = join(root, dir, layout);
        if (existsSync(exe)) return exe;
      }
    }
  }
  return undefined;
}

/**
 * Launch options carrying the resolved browser, if one was found. Spread into
 * `chromium.launch({ ...chromeLaunchOptions({ env: "JV_CHROME" }), headless: true })`
 * so an `undefined` result omits `executablePath` entirely.
 */
export function chromeLaunchOptions({ env } = {}) {
  const exe = findChrome({ env });
  return exe ? { executablePath: exe } : {};
}

// Venv interpreter locations under a venv dir. Windows puts it in Scripts/,
// POSIX in bin/.
const VENV_PYTHON = ["Scripts/python.exe", "bin/python"];

/**
 * Path to THE PROJECT'S Python interpreter — its venv if present, else whatever
 * PATH offers. The app's env var (`env`, e.g. "JW_PYTHON") overrides everything.
 *
 * `root` is the app's repo root; `venvs` lists its venv dirs RELATIVE to root in
 * probe order (JW passes [".venv"], JV/docgen ["server/.venv"]).
 *
 * WHY this is not just the string "python": bare `python` resolves to whatever
 * is first on PATH — on the user's Windows box a stock F:\Python312 with none
 * of the project's dependencies — and every symptom reads as broken test
 * config rather than a missing install ("unrecognized arguments: -n" from
 * missing pytest-xdist; "No module named 'llm_runner'" from the bench
 * autostart). The venv is PREFERRED, not required: the Linux dev container has
 * no venv and runs the interpreter straight off PATH.
 */
export function findPython({ env, root, venvs = [] } = {}) {
  const override = env ? process.env[env] : "";
  if (override && existsSync(override)) return override;
  for (const venv of venvs) {
    for (const rel of VENV_PYTHON) {
      const exe = join(root, ...venv.split("/"), ...rel.split("/"));
      if (existsSync(exe)) return exe;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * The scripts/py.js body: resolve the project interpreter (findPython opts) and
 * exec it with `args`, inheriting stdio and preserving the exit code so npm
 * still fails the script when pytest fails. Kills the process on a signal exit.
 */
export function runPython(args, opts) {
  if (!args.length) {
    console.error("scripts/py.js: no arguments — expected e.g. `-m pytest -q`");
    process.exit(2);
  }
  const python = findPython(opts);
  const child = spawn(python, args, { stdio: "inherit", shell: false });
  child.on("error", (err) => {
    console.error(`scripts/py.js: could not run ${python}\n  ${err.message}`);
    const where = (opts?.venvs || []).join(" or ") || "the project venv";
    console.error(`  Expected ${where} — create it, or put a suitable python on PATH.`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}

/** One probe: is something answering at `url` right now? (404 counts — the
 *  process is up, the path just isn't a route.) */
export async function isUp(url) {
  try {
    const r = await fetch(url);
    return r.ok || r.status === 404;
  } catch {
    return false;
  }
}

/** Poll `url` until it answers, or throw after `tries` attempts. */
export async function waitReady(url, label = url, tries = 60, intervalMs = 500) {
  for (let i = 0; i < tries; i++) {
    if (await isUp(url)) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label} at ${url}`);
}
