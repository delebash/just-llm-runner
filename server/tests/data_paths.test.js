// SPDX-License-Identifier: MIT
// Port of tests/test_data_paths.py — THE family data-location policy (user ruling
// 2026-08-14): the user's explicit choice first, a `data/` folder beside the app by
// default, and the OS app-data dir ONLY when the install directory can't be written.
// Python's `sys.frozen` / `sys.executable` patches become `dataPaths.runtime`.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as dp from "../src/platform/data_paths.js";

let tmp;
const saved = { ...dp.runtime };
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kit-dp-"));
  dp.runtime.frozen = false; // pytest never runs frozen
});
afterEach(() => Object.assign(dp.runtime, saved));

const write = (p) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "x");
};

test("env_var_is_the_users_choice_and_always_wins", () => {
  const chosen = join(tmp, "somewhere", "the-user-picked");
  const got = dp.resolveDataDir({
    appName: "JustVoice",
    envVar: "JV_DATA",
    sourceRoot: join(tmp, "checkout"),
    env: { JV_DATA: chosen },
  });
  expect(got).toBe(chosen);
  // And nothing was created beside the app just by asking.
  expect(existsSync(join(tmp, "checkout", "data"))).toBe(false);
});

test("default_is_data_beside_the_app", () => {
  const root = join(tmp, "checkout");
  mkdirSync(root);
  expect(dp.resolveDataDir({ appName: "JustVoice", envVar: "JV_DATA", sourceRoot: root, env: {} })).toBe(
    join(root, "data"),
  );
});

test("blank_env_var_is_not_a_choice", () => {
  const root = join(tmp, "checkout");
  mkdirSync(root);
  const got = dp.resolveDataDir({ appName: "JustVoice", envVar: "JV_DATA", sourceRoot: root, env: { JV_DATA: "   " } });
  expect(got).toBe(join(root, "data"));
});

test("os_dir_only_when_the_install_dir_is_not_writable", () => {
  // The last-resort arm: a Program-Files-style read-only install. Never a preference —
  // only reached when the probe fails.
  vi.spyOn(dp, "_isWritable").mockReturnValue(false);
  const got = dp.resolveDataDir({ appName: "JustVoice", envVar: "JV_DATA", sourceRoot: join(tmp, "readonly"), env: {} });
  expect(got).not.toBe(join(tmp, "readonly", "data"));
  expect(got).toContain("JustVoice");
});

test("no_source_root_and_not_frozen_falls_back", () => {
  // A host that passes no checkout root (bare library use) still resolves honestly
  // rather than inventing a path.
  expect(dp.resolveDataDir({ appName: "JustWrite", envVar: "JW_DATA", env: {} })).toContain("JustWrite");
});

test("install_dir_is_the_exe_folder_when_frozen", () => {
  const exe = join(tmp, "app", "justvoice.exe");
  write(exe);
  dp.runtime.frozen = true;
  dp.runtime.executable = exe;
  expect(dp.installDir(join(tmp, "ignored"))).toBe(path.dirname(exe));
});

test("frozen_default_lands_beside_the_executable", () => {
  const exe = join(tmp, "app", "justvoice.exe");
  write(exe);
  dp.runtime.frozen = true;
  dp.runtime.executable = exe;
  expect(dp.resolveDataDir({ appName: "JustVoice", envVar: "JV_DATA", env: {} })).toBe(join(path.dirname(exe), "data"));
});

test("probe_leaves_nothing_behind", () => {
  const root = join(tmp, "checkout");
  mkdirSync(root);
  dp.resolveDataDir({ appName: "X", envVar: "X_DATA", sourceRoot: root, env: {} });
  expect(readdirSync(join(root, "data"))).toEqual([]);
});

test("the_two_apps_resolve_to_their_own_folders", () => {
  // Same policy, per-app roots — no shared/global location.
  const jvRoot = join(tmp, "jv");
  const jwRoot = join(tmp, "jw");
  mkdirSync(jvRoot);
  mkdirSync(jwRoot);
  const jv = dp.resolveDataDir({ appName: "JustVoice", envVar: "JUSTVOICE_DATA_DIR", sourceRoot: jvRoot, env: {} });
  const jw = dp.resolveDataDir({ appName: "JustWrite", envVar: "JUSTWRITE_DATA_DIR", sourceRoot: jwRoot, env: {} });
  expect(jv).toBe(join(jvRoot, "data"));
  expect(jw).toBe(join(jwRoot, "data"));
  expect(jv).not.toBe(jw);
});

// ── Media rows store paths relative to the data root ─────────────────

test("inside_the_data_root_is_stored_relative", () => {
  const data = join(tmp, "data");
  const f = join(data, "captures", "abc.wav");
  write(f);
  expect(dp.toDataRelative(f, data)).toBe("captures/abc.wav");
});

test("relative_survives_the_data_folder_moving", () => {
  // THE point: Change-folder copies the files and the rows still resolve — before
  // this, every absolute row pointed at the deleted original.
  const old = join(tmp, "old");
  const neu = join(tmp, "new");
  write(join(old, "captures", "a.wav"));
  const stored = dp.toDataRelative(join(old, "captures", "a.wav"), old);

  write(join(neu, "captures", "a.wav"));
  expect(dp.fromDataRelative(stored, neu)).toBe(join(neu, "captures", "a.wav"));
  expect(statSync(dp.fromDataRelative(stored, neu)).isFile()).toBe(true);
});

test("outside_the_data_root_stays_absolute", () => {
  const data = join(tmp, "data");
  mkdirSync(data);
  const outside = join(tmp, "elsewhere", "sample.wav");
  write(outside);
  const stored = dp.toDataRelative(outside, data);
  expect(path.isAbsolute(stored)).toBe(true);
  expect(dp.fromDataRelative(stored, data)).toBe(outside);
});

test("legacy_absolute_rows_still_resolve", () => {
  // No migration: rows written before the rule pass through untouched.
  const data = join(tmp, "data");
  const legacy = join(tmp, "somewhere", "old.wav");
  expect(dp.fromDataRelative(legacy, data)).toBe(legacy);
});

test("round_trip_is_stable", () => {
  const data = join(tmp, "data");
  const f = join(data, "generations", "g1.wav");
  write(f);
  expect(dp.fromDataRelative(dp.toDataRelative(f, data), data)).toBe(f);
});

// Not in the Python file: pathlib's string form, which every path above comes out in.
test("pure_path_matches_pathlib_str", () => {
  if (process.platform === "win32") {
    expect(dp.purePath("C:/a//b/./c/")).toBe("C:\\a\\b\\c");
    expect(dp.purePath("a/../b")).toBe("a\\..\\b");
    expect(dp.purePath("\\\\srv\\share")).toBe("\\\\srv\\share\\");
    expect(dp.fromDataRelative("\\rooted\\x.wav", "D:\\data")).toBe("D:\\rooted\\x.wav");
  } else {
    expect(dp.purePath("/a//b/./c/")).toBe("/a/b/c");
    expect(dp.purePath("//a")).toBe("//a");
    expect(dp.purePath("///a")).toBe("/a");
  }
  expect(dp.purePath("")).toBe(".");
});
