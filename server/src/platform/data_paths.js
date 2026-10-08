// SPDX-License-Identifier: MIT
// THE family data-location policy — one implementation, every app (the port of
// llm_runner/platform/data_paths.py).
//
// The user's ruling (2026-08-14, after JustVoice drifted): *"none of the apps should have
// anything stored in [an OS app-data folder]... absolutely no data for any of these apps
// should be stored anywhere but where the user has set the storage directory, which by
// default will be the install directory for the app"* and *"don't hardcode anything —
// app-data is not banned, what is banned is anything that the user has not decided"*.
//
// So the policy, in strict order:
//   1. The user's explicit choice — the app's data-dir env var (which the desktop shell
//      also uses to hand down a `Change folder` selection, and headless `--data-dir`
//      sets). Always wins, no questions.
//   2. Beside the app — a `data/` folder in the install directory: next to the packaged
//      executable, next to the source checkout root in development. This is the DEFAULT:
//      portable, visible, deletable, and nothing lands in a hidden per-user folder the
//      user never chose.
//   3. The OS app-data dir — ONLY when the install directory is not writable (Program
//      Files, a read-only bundle). Not a preference: the last resort that keeps a
//      locked-down install from failing outright.
//
// Each app's paths module is a thin call into `resolveDataDir` — the shape may never be
// re-implemented per app (that divergence is what produced JustVoice writing to Roaming
// while JustWrite ran portable, and cost an audit to find). The desktop shell resolves
// the same ladder before the server exists; keep the two in lock-step.
//
// Paths are strings here (Python handed out `Path`s): each one comes out in the form
// `str(Path(…))` gives — native separators, no "." parts, no trailing separator.

import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as self from "./data_paths.js";
import { IS_MAC, IS_WIN } from "./py.js";

// PyInstaller's `sys.frozen` / `sys.executable`. A packaged Electron app runs its server on
// the app's own executable (main, a utilityProcess, or ELECTRON_RUN_AS_NODE headless);
// development and the tests run it on `electron`/`node` from node_modules or the PATH —
// that difference is the "frozen" test. Tests assign these two (Python monkeypatched sys).
export const runtime = {
  frozen: Boolean(process.versions.electron) && !/^(electron|node)(\.exe)?$/i.test(path.basename(process.execPath)),
  executable: process.execPath,
};

/** `str(PurePath(p))` for this platform: native separators, repeated separators and "."
 * parts dropped, no trailing separator; ".." is KEPT (pathlib never resolves it).
 * Candidate for platform/. */
export function purePath(p) {
  let s = String(p);
  if (s === "") return ".";
  if (IS_WIN) {
    s = s.replace(/\//g, "\\");
    let prefix = "";
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(s);
    if (unc) {
      prefix = `${unc[0]}\\`; // a UNC drive always carries its root
      s = s.slice(unc[0].length).replace(/^\\+/, "");
    } else {
      const drive = /^[A-Za-z]:/.exec(s);
      if (drive) {
        prefix = drive[0];
        s = s.slice(2);
      }
      if (s.startsWith("\\")) {
        prefix += "\\";
        s = s.replace(/^\\+/, "");
      }
    }
    const parts = s.split("\\").filter((x) => x !== "" && x !== ".");
    return prefix + parts.join("\\") || ".";
  }
  // POSIX: exactly two leading slashes are kept (pathlib does), more collapse to one.
  const prefix = s.startsWith("//") && !s.startsWith("///") ? "//" : s.startsWith("/") ? "/" : "";
  const parts = s.split("/").filter((x) => x !== "" && x !== ".");
  return prefix + parts.join("/") || ".";
}

/** `Path.is_absolute()` — on Windows a drive AND a root (or a UNC share). */
function isAbsolutePy(p) {
  const s = String(p);
  if (!IS_WIN) return s.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(s);
}

/** `Path(base) / p` — pathlib's join (a rooted right side keeps the left's drive on
 * Windows; a different drive replaces it). */
function joinPy(base, p) {
  const b = String(base);
  const s = String(p);
  if (isAbsolutePy(s)) return purePath(s);
  if (IS_WIN) {
    const drive = /^[A-Za-z]:/.exec(s);
    const baseDrive = /^[A-Za-z]:/.exec(b);
    if (drive && (!baseDrive || drive[0].toLowerCase() !== baseDrive[0].toLowerCase())) return purePath(s);
    if (drive) return purePath(`${b}\\${s.slice(2)}`);
    if (/^[\\/]/.test(s)) return purePath((baseDrive ? baseDrive[0] : "") + s);
    return purePath(`${b}\\${s}`);
  }
  return purePath(`${b}/${s}`);
}

/** `Path(p).resolve()` (strict=False): absolute, symlinks resolved as far as the path
 * exists, the missing tail kept as given. */
function resolveLoose(p) {
  let head = path.resolve(String(p));
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.resolve(String(p));
      tail.push(path.basename(head));
      head = up;
    }
  }
}

/** The parts of an absolute, normalized path: [anchor, ...names]. */
function partsOf(abs) {
  const { root } = path.parse(abs);
  return [root, ...abs.slice(root.length).split(path.sep).filter(Boolean)];
}

// pathlib compares Windows paths case-insensitively (its normcase is lower()).
const norm = (s) => (IS_WIN ? s.toLowerCase() : s);

/**
 * Can we actually create files here? Probe, never guess — a path can exist and still be
 * read-only (Program Files, a mounted bundle). (Python's `_is_writable`; a test patches it.)
 */
export function _isWritable(directory) {
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    return false;
  }
  const probe = path.join(directory, ".llm_runner_write_probe");
  try {
    writeFileSync(probe, "x");
  } catch {
    return false;
  }
  try {
    unlinkSync(probe);
  } catch {
    /* left behind — still writable */
  }
  return true;
}

/**
 * The string to STORE for a media file (user ruling 2026-08-14).
 *
 * A file inside the data root is stored RELATIVE to it, POSIX-style, so the row survives
 * the user moving their data folder — the whole point of the Change-folder verb, which
 * used to copy the files and leave every absolute row pointing at the deleted original.
 * It also makes a backup restore onto another machine (or another drive) resolve.
 *
 * A path OUTSIDE the data root keeps its absolute form: it is not ours to relocate, and
 * rewriting it would break the reference.
 */
export function toDataRelative(p, dataDir) {
  try {
    const abs = partsOf(resolveLoose(p));
    const base = partsOf(resolveLoose(dataDir));
    if (base.length > abs.length) return purePath(p);
    for (let i = 0; i < base.length; i++) if (norm(abs[i]) !== norm(base[i])) return purePath(p);
    const rest = abs.slice(base.length);
    return rest.length ? rest.join("/") : ".";
  } catch {
    return purePath(p);
  }
}

/**
 * Resolve a stored media path back to a real one.
 *
 * Absolute values pass through unchanged — that covers both deliberately external files
 * and rows written before the relative-path rule, so no migration is needed and nothing
 * breaks in place.
 */
export function fromDataRelative(stored, dataDir) {
  return isAbsolutePy(stored) ? purePath(stored) : joinPy(dataDir, stored);
}

/**
 * The app's install directory: the packaged executable's folder (`runtime.frozen`), else
 * the caller's source checkout root. null when neither is knowable.
 */
export function installDir(sourceRoot = null) {
  if (runtime.frozen) return path.dirname(resolveLoose(runtime.executable));
  return sourceRoot != null ? resolveLoose(sourceRoot) : null;
}

/**
 * platformdirs' `user_data_dir(app)` (4.10.1, appauthor unset, roaming off), read from its
 * source: Windows `%LOCALAPPDATA%\<app>\<app>` (WIN_PD_OVERRIDE_LOCAL_APPDATA first);
 * macOS `$XDG_DATA_HOME/<app>` else `~/Library/Application Support/<app>`; elsewhere
 * `$XDG_DATA_HOME/<app>` else `~/.local/share/<app>`. Nothing is created.
 * (Python resolves Windows' Local AppData through the shell API; the LOCALAPPDATA variable
 * names the same folder.)
 */
export function userDataDir(appName) {
  if (IS_WIN) {
    const override = (process.env.WIN_PD_OVERRIDE_LOCAL_APPDATA || "").trim();
    const base = override || process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    return path.join(path.normalize(base), appName, appName);
  }
  const xdg = (process.env.XDG_DATA_HOME || "").trim();
  if (xdg) return purePath(`${xdg}/${appName}`);
  const base = IS_MAC ? "Library/Application Support" : ".local/share";
  return purePath(`${homedir()}/${base}/${appName}`);
}

/**
 * The family data root for `appName` per the module policy.
 *
 * `envVar` — the app's data-dir variable (`JUSTVOICE_DATA_DIR`, `JUSTWRITE_DATA_DIR`):
 * the user's/shell's explicit choice. `sourceRoot` — the app's checkout root, used in
 * development when not packaged (an app passes its own; the kit cannot guess it).
 * `env` — override the environment (tests).
 */
export function resolveDataDir({ appName, envVar, sourceRoot = null, env = null } = {}) {
  const environ = env == null ? process.env : env;
  const chosen = String(environ[envVar] || "").trim();
  if (chosen) return purePath(chosen);

  const base = installDir(sourceRoot);
  if (base != null) {
    const candidate = path.join(base, "data");
    if (self._isWritable(candidate)) return candidate;
  }

  // Last resort only — a non-writable install (see the header).
  return userDataDir(appName);
}

/** `Path(a) == Path(b)` — the same normalized path (case-insensitive on Windows).
 * Candidate for platform/. */
export function samePath(a, b) {
  return norm(purePath(a)) === norm(purePath(b));
}
