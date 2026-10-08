// SPDX-License-Identifier: MIT
// THE family data-folder ladder — one module for the desktop shell AND the headless server
// (the kit FINDING "the data-dir ladder's four copies disagree": the three Rust shells and
// llm_runner/platform/data_paths.py each had their own; only the Rust read the pointer).
//
// The policy (the user's 2026-08-14 ruling: nothing is stored where the user didn't choose;
// the default is the install directory), in order:
//   1. the app's data-dir variable (`<APP>_DATA_DIR`) — the shell hands it to the server,
//      headless `--data-dir` sets it;
//   2. the Change-folder pointer, `dataroot.txt` in the install directory — a pointer
//      holding exactly the computed default is residue of the removed first-run lock,
//      not a choice, and is deleted (family ruling 2026-08-14);
//   3. `data/` in the install directory — beside the exe when packaged, the checkout root
//      in development (`<repo>/data`, ruling 6 of 2026-10-05);
//   4. the OS fallback, only when the install directory is not writable.
//
// INTEGRATION NOTE: this merges into platform/data_paths.js (the port of data_paths.py) once
// that slice lands, so the headless server reads the same pointer.

import fs from "node:fs";
import path from "node:path";

const POINTER = "dataroot.txt";
/** Chromium's files (profile, cache, window state) under the data root. */
export const CHROME_DIR = "electron";
const OLD_MARKER = "old-root.txt";

export function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".llm_runner_write_probe");
    fs.writeFileSync(probe, "x");
    try {
      fs.unlinkSync(probe);
    } catch {
      /* fine */
    }
    return true;
  } catch {
    return false;
  }
}

/** The install directory: beside the exe when packaged, the checkout root in development. */
export const installDir = ({ packaged, exeDir, repoRoot }) => (packaged ? exeDir : repoRoot);

/**
 * The OS fallback for a non-writable install directory. OPEN QUESTION (asked 2026-10-07):
 * Tauri used `%APPDATA%\<identifier>`, the kit's Python `%LOCALAPPDATA%\<App>\<App>` —
 * the one ladder needs one answer. Until it's given, reaching here is an error rather than
 * a guess: only a packaged install in a read-only folder gets here, and none exists yet.
 */
export function osFallbackRoot() {
  throw new Error(
    "the install folder is not writable, and the OS fallback folder for app data is not decided yet " +
      "(the Electron move — asked 2026-10-07)",
  );
}

/** Where the data lives by default (step 3), or the OS fallback (step 4). */
export function defaultRoot(opts) {
  const base = installDir(opts);
  const candidate = path.join(base, "data");
  return isWritable(base) ? candidate : osFallbackRoot(opts);
}

/** Resolve the data root (steps 1–4 above). */
export function resolveDataRoot({ dataDirEnv, repoRoot, packaged, exeDir, env = process.env }) {
  const chosen = (env[dataDirEnv] || "").trim();
  if (chosen) return path.resolve(chosen);
  const opts = { packaged, exeDir, repoRoot };
  const pointer = path.join(installDir(opts), POINTER);
  const def = defaultRoot(opts);
  try {
    const p = fs.readFileSync(pointer, "utf8").trim();
    if (p) {
      if (path.resolve(p) === path.resolve(def)) fs.rmSync(pointer, { force: true });
      else return path.resolve(p);
    }
  } catch {
    /* no pointer */
  }
  return def;
}

/** `{root, default, portable}` — the Storage panel's three facts (JustWrite's shape). */
export function storageInfo({ root, exeDir, repoRoot, packaged }) {
  const base = installDir({ packaged, exeDir, repoRoot });
  const rel = path.relative(path.resolve(base), path.resolve(root));
  return {
    root,
    default: defaultRoot({ packaged, exeDir, repoRoot }),
    portable: !rel.startsWith("..") && !path.isAbsolute(rel),
  };
}

function writePointer(dir, root) {
  const pointer = path.join(dir, POINTER);
  const tmp = `${pointer}.tmp`;
  fs.writeFileSync(tmp, root);
  fs.renameSync(tmp, pointer); // atomic: a torn write never strands the app
}

/**
 * Move every file to `newRoot` (the Change-folder verb). Crash-safe as the Rust was: copy
 * to a staging sibling, rename it into place, commit the pointer, and only THEN delete the
 * old root — a crash before the commit leaves the old root intact and resolvable. Returns
 * the new root, or null when it equals the old one.
 */
export function relocate({ oldRoot, newRoot, packaged = true, exeDir, repoRoot }) {
  const target = path.resolve(String(newRoot).trim());
  if (target === path.resolve(oldRoot)) return null;
  if (!isWritable(path.dirname(target))) throw new Error(`cannot write to ${target}`);
  const staging = path.join(path.dirname(target), `${path.basename(target) || "data"}.moving`);
  fs.rmSync(staging, { recursive: true, force: true });
  // Chromium's own folder is open while the app runs: it isn't copied (it rebuilds), and
  // the old one is deleted at the next start (`sweepOldChromeDir`), when nothing holds it.
  const chrome = path.join(path.resolve(oldRoot), CHROME_DIR);
  try {
    fs.cpSync(oldRoot, staging, { recursive: true, filter: (src) => path.resolve(src) !== chrome });
  } catch (e) {
    throw new Error(`copy failed: ${e.message}`);
  }
  try {
    fs.renameSync(staging, target);
  } catch (e) {
    throw new Error(`finalize failed: ${e.message}`);
  }
  try {
    writePointer(installDir({ packaged, exeDir, repoRoot }), target);
  } catch (e) {
    throw new Error(`pointer write failed: ${e.message}`);
  }
  for (const name of fs.readdirSync(oldRoot)) {
    if (name !== CHROME_DIR) fs.rmSync(path.join(oldRoot, name), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(target, CHROME_DIR), { recursive: true });
  fs.writeFileSync(path.join(target, CHROME_DIR, OLD_MARKER), path.resolve(oldRoot));
  return target;
}

/** At start, before Chromium opens anything: delete the old root a move left behind. */
export function sweepOldChromeDir(root) {
  const marker = path.join(root, CHROME_DIR, OLD_MARKER);
  try {
    const old = fs.readFileSync(marker, "utf8").trim();
    if (old && path.resolve(old) !== path.resolve(root)) fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  } catch {
    /* nothing to sweep */
  }
}
