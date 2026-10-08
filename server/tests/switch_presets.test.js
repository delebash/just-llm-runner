// SPDX-License-Identifier: MIT
// Port of tests/test_switch_presets.py — the switch_presets store: seeded + editable +
// reset-to-factory (design §6.5). Plus (not in the Python file) the router's answers.
import { beforeEach, expect, test, vi } from "vitest";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { makeSwitchPresetsRouter } from "../src/llm/switch_presets_api.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

// stores.js imports identity.js (wave 2, another slice): its stand-in until the file lands.
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

beforeEach(() => {
  const h = freshDb({ foreignKeys: false });
  h.tx(() => seed.seedDefaultSwitchPresets(h));
});

const flags = (row) => Object.fromEntries(row.switches.map((s) => [s.flagName, s.flagValue]));

test("list_seeded", () => {
  const rows = stores.getSwitchPresetStore().list();
  const ids = new Set(rows.map((r) => r.id));
  for (const id of ["base", "moe", "mtp"]) expect(ids.has(id)).toBe(true); // mtp re-seeded 2026-07-05 (Plan B)
  const moe = rows.find((r) => r.id === "moe");
  expect(flags(moe)).toEqual({ no_mmap: "true" }); // only no_mmap is MoE-specific
  expect(moe.appliesTo).toBe("moe");
  const mtp = rows.find((r) => r.id === "mtp");
  // spec_n_max=2 is the user-MEASURED value and ≠ the knob default (3) — a value equal to the
  // knob default must never be seeded here (one-source guardrail).
  expect(flags(mtp)).toEqual({ spec_type: "draft-mtp", spec_n_max: "2" });
  expect(mtp.appliesTo).toBe("mtp");
});

test("upsert_replaces_switches", () => {
  const st = stores.getSwitchPresetStore();
  st.upsert({ id: "base", label: "Base", appliesTo: "all", switches: [{ flagName: "flash_attn", flagValue: "off" }] });
  const base = st.list().find((r) => r.id === "base");
  expect(flags(base)).toEqual({ flash_attn: "off" }); // whole set replaced
});

test("add_delete_user_preset", () => {
  const st = stores.getSwitchPresetStore();
  st.upsert({ id: "turbo", label: "Turbo", appliesTo: "dense", switches: [{ flagName: "cache_type_k", flagValue: "turbo4" }] });
  expect(st.list().some((r) => r.id === "turbo")).toBe(true);
  st.delete("turbo");
  expect(st.list().some((r) => r.id === "turbo")).toBe(false);
});

test("reset_restores_factory", () => {
  const st = stores.getSwitchPresetStore();
  st.upsert({ id: "moe", label: "x", appliesTo: "moe", switches: [] }); // wipe moe
  expect(st.list().find((r) => r.id === "moe").switches).toEqual([]);
  st.resetToFactory();
  const moe = st.list().find((r) => r.id === "moe");
  expect(new Set(moe.switches.map((s) => s.flagName))).toEqual(new Set(["no_mmap"]));
});

// Not in the Python file: the router's answers (verified against the Python router).
test("the switch-presets router answers as FastAPI did", async () => {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(makeSwitchPresetsRouter(stores.getSwitchPresetStore));
  let r = await app.inject({ method: "GET", url: "/v1/ai/switch-presets" });
  expect(r.statusCode).toBe(200);
  expect(r.json().rows.map((x) => x.id)).toEqual(stores.getSwitchPresetStore().list().map((x) => x.id));
  r = await app.inject({ method: "PUT", url: "/v1/ai/switch-presets", payload: { id: "turbo", junk: 1, switches: [{ flagName: "x" }] } });
  expect(r.statusCode).toBe(200);
  expect(r.json().rows.find((x) => x.id === "turbo")).toEqual({
    id: "turbo",
    label: "",
    appliesTo: "all",
    position: 0,
    builtIn: false,
    switches: [{ flagName: "x", flagValue: "" }],
  });
  r = await app.inject({ method: "PUT", url: "/v1/ai/switch-presets", payload: { id: "  " } });
  expect(r.statusCode).toBe(400);
  expect(r.json().detail).toBe("id is required");
  r = await app.inject({ method: "DELETE", url: "/v1/ai/switch-presets" });
  expect(r.statusCode).toBe(422);
  expect(r.json().errors).toEqual([{ loc: ["query", "presetId"], msg: "Field required", type: "missing" }]);
  r = await app.inject({ method: "DELETE", url: "/v1/ai/switch-presets?presetId=%20" });
  expect(r.statusCode).toBe(400);
  r = await app.inject({ method: "DELETE", url: "/v1/ai/switch-presets?presetId=turbo" });
  expect(r.json().rows.some((x) => x.id === "turbo")).toBe(false);
  r = await app.inject({ method: "POST", url: "/v1/ai/switch-presets/reset" });
  expect(r.statusCode).toBe(200);
});
