// SPDX-License-Identifier: MIT
// THE family data-folder ladder (platform/data_paths.js + shell/dataRoot.js) — the one module
// the desktop shell and the headless server share since the Electron move, with the answers
// of 2026-10-08: the OS fallback is %LOCALAPPDATA%\<App>\<App>, its pointer
// %LOCALAPPDATA%\<App>\dataroot.txt, Chromium's folder `electron`. JS-only (the Python ladder
// never read the pointer — the kit FINDING this closes).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as dataPaths from "../src/platform/data_paths.js";
import { CHROME_DIR, relocate, resolveDataRoot, storageInfo, sweepOldChromeDir } from "../src/shell/dataRoot.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "ladder-"));
const opts = (repoRoot, env = {}) => ({ appName: "TestApp", dataDirEnv: "TESTAPP_DATA_DIR", repoRoot, packaged: false, env });

test("the variable wins over everything", () => {
  const repo = tmp();
  const chosen = path.join(tmp(), "mine");
  writeFileSync(path.join(repo, "dataroot.txt"), path.join(tmp(), "elsewhere"));
  expect(resolveDataRoot(opts(repo, { TESTAPP_DATA_DIR: chosen }))).toBe(chosen);
});

test("development defaults to <repo>/data", () => {
  const repo = tmp();
  expect(resolveDataRoot(opts(repo))).toBe(path.join(repo, "data"));
});

test("a Change-folder pointer is honoured; one naming the default is residue and deleted", () => {
  const repo = tmp();
  const moved = path.join(tmp(), "moved");
  writeFileSync(path.join(repo, "dataroot.txt"), moved);
  expect(resolveDataRoot(opts(repo))).toBe(moved);
  writeFileSync(path.join(repo, "dataroot.txt"), path.join(repo, "data"));
  expect(resolveDataRoot(opts(repo))).toBe(path.join(repo, "data"));
  expect(existsSync(path.join(repo, "dataroot.txt"))).toBe(false);
});

test("an unwritable install falls back to the OS folder, its pointer beside it", () => {
  const repo = tmp();
  const local = tmp();
  vi.stubEnv("WIN_PD_OVERRIDE_LOCAL_APPDATA", local);
  vi.stubEnv("XDG_DATA_HOME", local);
  const real = dataPaths._isWritable;
  vi.spyOn(dataPaths, "_isWritable").mockImplementation((d) => (path.resolve(d).startsWith(path.resolve(repo)) ? false : real(d)));
  const root = resolveDataRoot(opts(repo));
  const pointer = dataPaths.pointerFile({ appName: "TestApp", sourceRoot: repo });
  if (process.platform === "win32") {
    expect(root).toBe(path.join(local, "TestApp", "TestApp"));
    expect(pointer).toBe(path.join(local, "TestApp", "dataroot.txt"));
  } else {
    expect(root).toBe(path.join(local, "TestApp"));
    expect(pointer).toBe(path.join(local, "TestApp.dataroot.txt"));
  }
  // the pointer sits outside the root, so a move can't delete it
  expect(pointer.startsWith(root + path.sep)).toBe(false);
});

test("a move copies, commits the pointer, empties the old root and sweeps Chromium's next start", () => {
  const repo = tmp();
  const old = path.join(repo, "data");
  mkdirSync(path.join(old, "logs"), { recursive: true });
  mkdirSync(path.join(old, CHROME_DIR), { recursive: true });
  writeFileSync(path.join(old, "app.db"), "db");
  writeFileSync(path.join(old, "logs", "a.log"), "log");
  writeFileSync(path.join(old, CHROME_DIR, "Cookies"), "open while running");
  const target = path.join(tmp(), "NewHome");
  expect(relocate({ oldRoot: old, newRoot: target, appName: "TestApp", packaged: false, repoRoot: repo })).toBe(target);
  expect(readFileSync(path.join(target, "app.db"), "utf8")).toBe("db");
  expect(readFileSync(path.join(target, "logs", "a.log"), "utf8")).toBe("log");
  expect(existsSync(path.join(target, CHROME_DIR, "Cookies"))).toBe(false); // Chromium rebuilds its own
  expect(readFileSync(path.join(repo, "dataroot.txt"), "utf8")).toBe(target);
  expect(existsSync(path.join(old, "app.db"))).toBe(false);
  expect(existsSync(path.join(old, CHROME_DIR))).toBe(true); // still held by the running app
  expect(resolveDataRoot(opts(repo))).toBe(target);
  sweepOldChromeDir(target); // the next start
  expect(existsSync(old)).toBe(false);
  expect(storageInfo({ root: target, appName: "TestApp", repoRoot: repo, packaged: false })).toEqual({
    root: target,
    default: path.join(repo, "data"),
    portable: false,
  });
});
