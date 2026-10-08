// SPDX-License-Identifier: MIT
// Which engine + model caches exist on this box, so a second family app can offer to SHARE
// one instead of downloading the same gigabytes again (the port of
// llm_runner/runner/cache_registry.py).
//
// Measured on the author's box 2026-08-03: JustWrite and just_ai_i18n_docgen each kept their
// own `<data>/ai-cache`, holding the SAME artifact twice — `unsloth/gemma-4-26B-A4B-it-qat-GGUF
// @ UD-Q4_K_XL`, snapshot `7b92b5b2…`, **14,249,047,104 bytes in both** — plus two full
// llama.cpp installs (`ggml-cuda.dll` alone is 533 MB each). Identical, content-addressed
// gigabytes duplicated, while the one genuinely exclusive resource — the router port — was
// the thing they shared. Both halves are now the other way round (see
// `process.findFreePort` for the port half).
//
// WHY A REGISTRY AND NOT A SCAN: an app's data dir can be anywhere — `%LOCALAPPDATA%` for an
// installed build, a dev root for a dev run — so no scan finds them all. Each app writes one
// line about itself here at boot; discovery is then reading that file. It records WHERE a
// cache is, never what is in it.
//
// Nothing here may throw into boot: a missing, unreadable or corrupt registry means "no
// siblings known", which is exactly the state of a machine with one app on it.
//
// Synchronous, as in Python: one small file, and a walk over a cache's folders. `familyHome`
// and `gettempdir` are called through the module namespace so a test can replace them
// (`vi.spyOn(cacheRegistry, "familyHome")` — the Python tests' monkeypatch).

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePathJs } from "node:path";
import { getLogger } from "../platform/log.js";
import { IS_WIN, isJsonObject, pySorted, SYS_PLATFORM } from "../platform/py.js";
import { pyJson } from "../platform/pyjson.js";
import * as self from "./cache_registry.js";

const log = getLogger("llm_runner.runner.cache_registry");

const FILENAME = "caches.json";
const VERSION = 1;
const HOME_ENV = "JUST_AI_HOME";

// ── path helpers (candidates for platform/) ────────────────────────────────────────────

/**
 * `str(Path(p))` — pathlib's normal form: on Windows `/` becomes `\`, repeated separators
 * collapse (a UNC `\\` lead stays), `.` parts drop, a trailing separator drops (a root
 * keeps its own); `..` stays as written; "" is ".". POSIX alike with `/` (a leading `//`
 * is kept, as POSIX allows).
 */
export function pyPath(p) {
  let s = String(p);
  if (s === "") return ".";
  if (IS_WIN) {
    s = s.replaceAll("/", "\\");
    let prefix = "";
    let rest = s;
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(s);
    if (unc) {
      prefix = unc[0];
      rest = s.slice(prefix.length);
    } else if (/^[A-Za-z]:/.test(s)) {
      prefix = s.slice(0, 2);
      rest = s.slice(2);
    }
    const rooted = rest.startsWith("\\");
    const parts = rest.split("\\").filter((x) => x !== "" && x !== ".");
    if (unc) return `${prefix}\\${parts.join("\\")}`;
    const body = parts.join("\\");
    if (rooted) return `${prefix}\\${body}`;
    if (!body) return prefix || ".";
    return prefix + body;
  }
  const lead = s.startsWith("//") && !s.startsWith("///") ? "//" : s.startsWith("/") ? "/" : "";
  const parts = s.split("/").filter((x) => x !== "" && x !== ".");
  const body = parts.join("/");
  if (lead) return lead + body;
  return body || ".";
}

/** Path.resolve() (strict=False): absolute, symlinks of the existing part resolved, the
 * rest appended as written. */
function resolvePath(p) {
  let abs = resolvePathJs(String(p));
  const tail = [];
  while (true) {
    try {
      const real = realpathSync.native(abs);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(abs);
      if (parent === abs) return resolvePathJs(String(p));
      tail.push(basename(abs));
      abs = parent;
    }
  }
}

/** PurePath.is_relative_to — part-wise, case-insensitive on Windows. */
function isRelativeTo(child, parent) {
  const norm = (x) => {
    const s = pyPath(x);
    return IS_WIN ? s.toLowerCase() : s;
  };
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  const sepCh = IS_WIN ? "\\" : "/";
  return c.startsWith(p.endsWith(sepCh) ? p : p + sepCh);
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** tempfile.gettempdir() — exported so a test can point it elsewhere. */
export function gettempdir() {
  return tmpdir();
}

// ── the registry ───────────────────────────────────────────────────────────────────────

/**
 * false inside a test run that hasn't pointed `JUST_AI_HOME` somewhere safe.
 *
 * Found the hard way, minutes after this shipped: app suites call `installLlm` with a tmp
 * data dir, so test runs in THREE repos wrote their tmp cache paths into the author's real
 * registry — and, keyed by product at the time, erased JustWrite's genuine row on the way.
 *
 * The guard is here rather than in each suite's setup deliberately. This is a machine-wide
 * file that any consumer's tests can reach, including a stranger's app we will never see;
 * "every suite remembers to set an env var" is the protected-by-luck pattern that has cost
 * this codebase a dependency, a placeholder and a shared port. An explicit `JUST_AI_HOME`
 * always wins, so a test that means to exercise the registry still can. (vitest sets
 * VITEST; Python's pytest sets PYTEST_CURRENT_TEST — both count.)
 */
function writesAllowed() {
  return !!process.env[HOME_ENV] || !(process.env.VITEST || process.env.PYTEST_CURRENT_TEST);
}

/**
 * true when `root` lives under the OS temp dir — a scratch install, not a cache.
 *
 * Smoke gates snapshot an app into `%TEMP%` and boot a real server there, and that server
 * registers itself like any other boot. The 2026-08-08 ghost: a surviving `jw-smoke-*`
 * scratch stayed in the registry, Quick Setup offered it as a real sibling, pre-selected
 * "share", and one proceed click repointed a 248 GB install at a Temp dir — the next model
 * download landed there while the real cache sat full. A cache root the OS is allowed to
 * sweep is never worth registering or offering.
 */
function ephemeral(root) {
  try {
    return isRelativeTo(resolvePath(root), resolvePath(self.gettempdir()));
  } catch {
    return false;
  }
}

/** The check above, minus the `JUST_AI_HOME` escape (a harness that redirects the family
 * home has already isolated its registry). */
function ephemeralBlocked(root) {
  return !process.env[HOME_ENV] && ephemeral(root);
}

/** The one place the family keeps cross-app facts. Deliberately NOT inside any app's data
 * dir — the whole point is that it outlives the app that wrote it. `JUST_AI_HOME` overrides
 * it — see `writesAllowed` for why that matters. */
export function familyHome() {
  const override = process.env[HOME_ENV];
  if (override) return pyPath(override);
  if (SYS_PLATFORM === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return pyPath(join(base, "just-ai"));
  }
  if (SYS_PLATFORM === "darwin") return join(homedir(), "Library", "Application Support", "just-ai");
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return pyPath(join(base, "just-ai"));
}

/** The cache root an app gets if the user chooses "share" with no sibling to point at — a
 * family location rather than any one app's data dir. */
export function defaultSharedCache() {
  return join(self.familyHome(), "ai-cache");
}

function registryPath() {
  return join(self.familyHome(), FILENAME);
}

/** dict.get(k, d): a present-but-null value stays null. */
const get = (e, k, d) => (Object.hasOwn(e, k) ? e[k] : d);

/** Known entries, DROPPING any whose cache root has since been deleted — or lives under the
 * OS temp dir (a scratch row an older registry may still carry). An entry is a claim about
 * the disk, not a subscription: an uninstalled app, a relocated data root, or a throwaway run
 * leaves a path that no longer exists, and offering "share JustWrite's 0 B cache" is worse
 * than saying nothing. Cheap — one `isDir` per row. */
function read(prune = true) {
  let rows;
  const path = registryPath();
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const entries = isJsonObject(raw) ? raw.apps : null;
    rows = (Array.isArray(entries) ? entries : []).filter((e) => isJsonObject(e) && e.cacheRoot);
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    log.warning("cache registry unreadable — treating this box as having no siblings", e);
    return [];
  }
  return rows.filter((e) => !prune || (isDir(e.cacheRoot) && !ephemeralBlocked(e.cacheRoot)));
}

/** isoformat(timespec="seconds") of now in UTC: 2026-10-07T12:34:56+00:00. */
const nowIso = () => `${new Date().toISOString().slice(0, 19)}+00:00`;

/**
 * Record (or refresh) this app's cache location. Best-effort by contract — a read-only or
 * missing family home must not stop a boot.
 *
 * KEYED BY (product, dataDir) — the INSTALL, which is the thing that has one cache. Not
 * product alone: a dev build and a release build are two installs of one app, and that key
 * let whichever booted last erase the other's row. Not (product, cacheRoot) either: an
 * install that RE-POINTS its cache then leaves its old row behind, claiming to cache
 * somewhere it no longer does — seen live. The data dir identifies the install; the cache
 * root is only what that install currently says about itself.
 */
export function register(product, cacheRoot, dataDir = null) {
  if (!product || !cacheRoot || !writesAllowed()) return;
  if (ephemeralBlocked(cacheRoot)) {
    log.debug(
      `not registering ${cacheRoot} — a cache under the OS temp dir is a scratch install, not a sibling worth offering`,
    );
    return;
  }
  const where = dataDir ? pyPath(dataDir) : "";
  const entry = { product, cacheRoot: pyPath(cacheRoot), dataDir: where, lastSeen: nowIso() };
  const apps = read().filter((e) => !(e.product === product && (e.dataDir || "") === where));
  apps.push(entry);
  const path = registryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), "caches.tmp"); // Path.with_suffix(".tmp")
    // Path.write_text writes in text mode: each LF becomes CRLF on Windows.
    const text = pyJson({ version: VERSION, apps }, { indent: 2 });
    writeFileSync(tmp, IS_WIN ? text.replaceAll("\n", "\r\n") : text, "utf8");
    renameSync(tmp, path); // atomic: two apps booting together can't leave half a file
  } catch (e) {
    log.warning(`could not record this app's cache root in ${path}`, e);
  }
}

// A download still in progress (or abandoned) — never a model the cache HAS.
const UNFINISHED = [".part", ".incomplete", ".tmp"];
const finished = (name) => !UNFINISHED.some((s) => name.endsWith(s));

/** Any finished FILE under `dir` (rglob("*") + is_file, which follows a symlink). */
function hasFinishedFile(dir) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of ents) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (hasFinishedFile(p)) return true;
      continue;
    }
    let file = ent.isFile();
    if (ent.isSymbolicLink()) {
      try {
        file = statSync(p).isFile();
      } catch {
        file = false;
      }
    }
    if (file && finished(ent.name)) return true;
  }
  return false;
}

/** os.walk's byte total: every non-directory entry's (followed) size; a symlinked folder is
 * listed but not descended, as os.walk(followlinks=False) does. */
function walkBytes(dir) {
  let total = 0;
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of ents) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      total += walkBytes(p);
      continue;
    }
    if (ent.isSymbolicLink()) {
      let st;
      try {
        st = statSync(p);
      } catch {
        continue; // a broken link: stat fails → skipped
      }
      if (st.isDirectory()) continue; // a linked folder: listed with the dirs, not walked
      if (finished(ent.name)) total += st.size;
      continue;
    }
    if (!finished(ent.name)) continue;
    try {
      total += statSync(p).size;
    } catch {
      /* gone meanwhile */
    }
  }
  return total;
}

/**
 * What is actually in a cache root: engine builds, cached model repos, bytes. The wizard
 * shows this so "share" is a decision about real contents, not a path.
 *
 * A repo counts as a model only when a FINISHED file sits in its `snapshots/`, and `bytes`
 * leaves out unfinished downloads (2026-10-06): a `models--…` folder holding nothing but a
 * `.part` had made JustVoice's own empty cache look like one with models, and the setup's
 * "share" pick chose it — 14 GB fetched again.
 */
export function summarize(root) {
  root = pyPath(root);
  let builds = [];
  let models = [];
  const llamacpp = join(root, "llamacpp");
  if (isDir(llamacpp)) {
    builds = pySorted(
      readdirSync(llamacpp).filter((n) => n !== "logs" && isDir(join(llamacpp, n))),
    );
  }
  const hf = join(root, "hf");
  if (isDir(hf)) {
    // The HF layout is `models--<owner>--<repo>`; render it back as `owner/repo`.
    models = pySorted(
      readdirSync(hf)
        .filter((n) => n.startsWith("models--") && isDir(join(hf, n)) && hasFinishedFile(join(hf, n, "snapshots")))
        .map((n) => n.replace("models--", "").replaceAll("--", "/")),
    );
  }
  const exists = isDir(root);
  const total = exists ? walkBytes(root) : 0;
  return { root, exists, engineBuilds: builds, models, bytes: total };
}

/** The app whose cache `root` is: the first install recorded against it other than the one
 * at `dataDir` (an app sharing a sibling's cache records that root too); "" when none is. */
export function productOf(root, dataDir = null) {
  const want = pyPath(root);
  const mine = dataDir ? pyPath(dataDir) : "";
  for (const e of read()) {
    if (pyPath(e.cacheRoot) === want && (e.dataDir || "") !== mine) return get(e, "product", "");
  }
  return "";
}

/**
 * Every cache root this box knows about except the excluded ones, summarized.
 *
 * `exclude` takes one path or several — a caller normally excludes BOTH the cache in use and
 * its own private one, because it presents "keep my own" itself. Passing only the current
 * root listed the app's own cache twice the moment it started sharing (seen live,
 * 2026-08-03): the registry still held its own row from boot. Roots are de-duplicated, so
 * two apps sharing one cache offer it once.
 */
export function discover(exclude = null) {
  let excluded;
  if (exclude === null || exclude === undefined) excluded = new Set();
  else if (typeof exclude === "string") excluded = new Set([pyPath(exclude)]);
  else excluded = new Set([...exclude].filter((p) => p).map((p) => pyPath(p)));
  const out = [];
  const seen = new Set(excluded);
  for (const e of read()) {
    const root = pyPath(e.cacheRoot);
    if (seen.has(root)) continue;
    seen.add(root);
    out.push({ ...summarize(root), product: get(e, "product", ""), lastSeen: get(e, "lastSeen", "") });
  }
  const shared = pyPath(self.defaultSharedCache());
  if (!seen.has(shared) && isDir(shared)) out.push({ ...summarize(shared), product: "", lastSeen: "" });
  return out;
}
