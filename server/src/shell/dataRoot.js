// SPDX-License-Identifier: MIT
// The desktop shell's side of THE family data-folder ladder. The ladder itself is ONE module,
// `platform/data_paths.js` — the shell and the headless server read the same env variable,
// the same Change-folder pointer and the same default (the kit FINDING "the data-dir ladder's
// four copies disagree" closes here). The policy, in order (the user's 2026-08-14 ruling:
// nothing is stored where the user didn't choose; the default is the install directory):
//   1. the app's data-dir variable (`<APP>_DATA_DIR`);
//   2. the Change-folder pointer `dataroot.txt` (a pointer naming the computed default is
//      residue and is deleted);
//   3. `data/` in the install directory — beside the exe when packaged, the checkout root in
//      development (`<repo>/data`, ruling 6 of 2026-10-05);
//   4. the OS fallback when the install directory is not writable —
//      `%LOCALAPPDATA%\<App>\<App>`, its pointer `%LOCALAPPDATA%\<App>\dataroot.txt` (decided
//      2026-10-08).
// What only the shell does lives here: moving the data (Change folder) and Chromium's own
// folder under the root.

import fs from "node:fs";
import path from "node:path";
import * as dataPaths from "../platform/data_paths.js";

/** Chromium's files (profile, cache, window state) under the data root (decided 2026-10-08). */
export const CHROME_DIR = "electron";
const OLD_MARKER = "old-root.txt";

export const isWritable = (dir) => dataPaths._isWritable(dir);

const sourceRootOf = ({ packaged, repoRoot }) => (packaged ? null : repoRoot);

/** Resolve the data root (the ladder above). */
export function resolveDataRoot({ appName, dataDirEnv, repoRoot, packaged, env = process.env }) {
  return dataPaths.resolveDataDir({ appName, envVar: dataDirEnv, sourceRoot: sourceRootOf({ packaged, repoRoot }), env });
}

/** `{root, default, portable}` — the Storage panel's three facts (JustWrite's shape). */
export function storageInfo({ root, appName, repoRoot, packaged }) {
  const sourceRoot = sourceRootOf({ packaged, repoRoot });
  return {
    root,
    default: dataPaths.defaultDataDir({ appName, sourceRoot }),
    portable: dataPaths.isPortable(root, { sourceRoot }),
  };
}

function writePointer(pointer, root) {
  fs.mkdirSync(path.dirname(pointer), { recursive: true });
  const tmp = `${pointer}.tmp`;
  fs.writeFileSync(tmp, root);
  fs.renameSync(tmp, pointer); // atomic: a torn write never strands the app
}

/**
 * Move every file to `newRoot` (the Change-folder verb). Crash-safe as the Rust was: copy
 * to a staging sibling, rename it into place, commit the pointer, and only THEN delete the
 * old root — a crash before the commit leaves the old root intact and resolvable. Chromium's
 * own folder is open while the app runs: it isn't copied (it rebuilds), and the old one is
 * deleted at the next start (`sweepOldChromeDir`). Returns the new root, or null when it
 * equals the old one.
 */
export function relocate({ oldRoot, newRoot, appName, packaged = true, repoRoot }) {
  const target = path.resolve(String(newRoot).trim());
  if (target === path.resolve(oldRoot)) return null;
  if (!isWritable(path.dirname(target))) throw new Error(`cannot write to ${target}`);
  const staging = path.join(path.dirname(target), `${path.basename(target) || "data"}.moving`);
  fs.rmSync(staging, { recursive: true, force: true });
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
    writePointer(dataPaths.pointerFile({ appName, sourceRoot: sourceRootOf({ packaged, repoRoot }) }), target);
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
