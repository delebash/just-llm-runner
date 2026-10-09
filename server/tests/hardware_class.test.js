// SPDX-License-Identifier: MIT
// Port of tests/test_hardware_class.py — the NAMED, TYPE-FIRST hardware class (2026-07-22
// redesign): a class is identified by its memory architecture + memory — discrete (VRAM +
// RAM, the offload split), integrated (one shared pool), unified (one SoC pool). Covers the
// format/parse convention (ONE source), `memArch` detection (platform+vendor), the store
// (save/relocate/collision/ensure/cascade-delete), and the extended /v1/ai/class-tunes
// router (the `classes` list + the class PUT/DELETE). Pure data; no GPU.
//
// The hardware objects are the runner's camelCase HardwareInfo shape (`vramMb`, `ramMb`)
// where Python's test classes used snake attributes.
import { expect, test } from "vitest";
import { makeClassTunesRouter } from "../src/llm/class_tunes_api.js";
import * as db from "../src/llm/db.js";
import * as stores from "../src/llm/stores.js";
import { ValueError } from "../src/platform/py.js";
import { createServer } from "../src/platform/server.js";
import { bandedClassKey, classKey, formatClassKey, memArch, parseClassKey, snapRamGb } from "../src/runner/hardware.js";
import { freshDb } from "./helpers.js";

// ── the class_key convention: ONE source, type-first, round-trips ─────────────
test("format_and_parse_round_trip", () => {
  expect(formatClassKey("discrete", 8, 32)).toBe("dgpu-vram8|ram32");
  expect(formatClassKey("integrated", 0, 16)).toBe("igpu-mem16");
  expect(formatClassKey("unified", 0, 192)).toBe("unified-mem192");
  expect(parseClassKey("dgpu-vram8|ram32")).toEqual(["discrete", 8, 32]);
  expect(parseClassKey("igpu-mem16")).toEqual(["integrated", 0, 16]);
  expect(parseClassKey("unified-mem192")).toEqual(["unified", 0, 192]);
  expect(parseClassKey("garbage")).toEqual(["integrated", 0, 0]);
});

// ── memArch: platform + vendor, no heavy deps ────────────────────────────────
test("mem_arch_from_platform_and_vendor", () => {
  const G = (vramMb, name = "GPU") => ({ vramMb, name });
  const H = ({ platform = "linux", runtimes = null, gpus = [] } = {}) => ({ platform, runtimes: runtimes || {}, gpus: [...gpus] });
  expect(memArch(H({ platform: "macos" }))).toBe("unified"); // Apple Silicon
  expect(memArch(H({ runtimes: { cuda: true } }))).toBe("discrete"); // NVIDIA
  expect(memArch(H({ gpus: [G(16384, "Radeon RX 7800")] }))).toBe("discrete"); // >=4 GB dGPU
  expect(memArch(H({ gpus: [G(0, "Intel UHD")] }))).toBe("integrated"); // iGPU (no dedicated VRAM)
  expect(memArch(H())).toBe("integrated"); // no GPU → one-pool fallback
  // THE LAPTOP SHAPE (detect-facts 2026-07-23): registry name "Intel(R) Graphics",
  // qwMemorySize ABSENT (vram null) → integrated. And the name-regex kill: an iGPU whose
  // DriverDesc DOES say Arc(TM) (Lunar Lake style) with no dedicated VRAM must classify
  // integrated — a name is marketing, not architecture. A discrete Arc still classifies via
  // its real board VRAM.
  expect(memArch(H({ gpus: [G(null, "Intel(R) Graphics")] }))).toBe("integrated");
  expect(memArch(H({ gpus: [G(null, "Intel(R) Arc(TM) Graphics")] }))).toBe("integrated");
  expect(memArch(H({ gpus: [G(16384, "Intel(R) Arc(TM) A770 Graphics")] }))).toBe("discrete");
});

test("snap_ram_gb_standard_ladder", () => {
  // THE FRAGMENTATION CASE (2026-07-23): the Core Ultra laptop reports 31.5 GB (33777467392
  // bytes) and the desktop 31.9 GB (34280230912 bytes) — raw rounding split two nominal-32
  // GB machines into mem31 vs ram32. Both snap to 32.
  expect(snapRamGb(Math.floor(33777467392 / (1024 * 1024)))).toBe(32); // the laptop, exact bytes
  expect(snapRamGb(Math.floor(34280230912 / (1024 * 1024)))).toBe(32); // the desktop, exact bytes
  expect(snapRamGb(16384)).toBe(16);
  expect(snapRamGb(15872)).toBe(16); // 15.5 GB (OEM reserve) → 16
  expect(snapRamGb(65536)).toBe(64);
  expect(snapRamGb(196608)).toBe(192); // Mac Studio pool
  expect(snapRamGb(0)).toBe(2); // degenerate floor: the lowest rung
});

test("class_key_bands_discrete", () => {
  // THE BAND RULING (user, 2026-07-25: "I never thought exact matches should be used"): the
  // discrete class key IS the band, so plain exact-match lookup covers every real card
  // without fallback machinery — 10/11 GB cards are the 8 band, 20 → 16, and everything ≥ 24
  // is ONE 24+ band. RAM down-snaps the coarse rungs (24 → 16, 48 → 32, 96 → 64). DOWN on
  // both dimensions because it can never overstate a box. Sub-band values pass through: a 6
  // GB card is honestly sub-band and matches no band seed.
  const H = (vramMb, ramGb) => ({ platform: "windows", runtimes: { cuda: true }, gpus: [{ vramMb, name: "GPU" }], ramMb: ramGb * 1024 });
  expect(classKey(H(8192, 32))).toBe("dgpu-vram8|ram32"); // the 2070S box — unchanged
  expect(classKey(H(8188, 32))).toBe("dgpu-vram8|ram32"); // jitter round FIRST, then band
  expect(classKey(H(10240, 32))).toBe("dgpu-vram8|ram32"); // 3080 10 GB → the 8 band
  expect(classKey(H(11264, 32))).toBe("dgpu-vram8|ram32"); // 2080 Ti 11 GB → the 8 band
  expect(classKey(H(12288, 32))).toBe("dgpu-vram12|ram32");
  expect(classKey(H(20480, 32))).toBe("dgpu-vram16|ram32"); // 20 GB → the 16 band
  expect(classKey(H(24576, 32))).toBe("dgpu-vram24|ram32"); // 4090
  expect(classKey(H(32768, 32))).toBe("dgpu-vram24|ram32"); // 5090 — the SAME 24+ band
  expect(classKey(H(6144, 32))).toBe("dgpu-vram6|ram32"); // sub-band passes through
  expect(classKey(H(8192, 16))).toBe("dgpu-vram8|ram16");
  expect(classKey(H(8192, 24))).toBe("dgpu-vram8|ram16"); // 24 GB RAM → the 16 rung
  expect(classKey(H(8192, 48))).toBe("dgpu-vram8|ram32");
  expect(classKey(H(8192, 96))).toBe("dgpu-vram8|ram64");
});

test("banded_class_key_builder", () => {
  // The one banded builder (detection + the panel's create-class derive share it): discrete
  // numbers band; one-pool types pass straight through to the raw formatter.
  expect(bandedClassKey("discrete", 10, 48)).toBe("dgpu-vram8|ram32");
  expect(bandedClassKey("discrete", 8, 32)).toBe("dgpu-vram8|ram32"); // band values: identity
  expect(bandedClassKey("integrated", 0, 16)).toBe("igpu-mem16"); // untouched
  expect(bandedClassKey("unified", 0, 192)).toBe("unified-mem192"); // untouched
});

// ── the store ────────────────────────────────────────────────────────────────
const addTune = (model_id, class_key, flag_name, flag_value) =>
  db.session().insert("class_tunes", { model_id, class_key, flag_name, flag_value, built_in: false });

test("save_lists_and_edits_name", () => {
  freshDb();
  const st = stores.getHardwareClassStore();
  st.save("dgpu-vram8|ram32", "discrete", 8, 32, "My PC");
  expect(st.listAll()).toEqual([
    { classKey: "dgpu-vram8|ram32", memType: "discrete", vramGb: 8, ramGb: 32, name: "My PC", builtIn: false, vramBwGbps: 0.0, ramBwGbps: 0.0 },
  ]);
  st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Renamed", "dgpu-vram8|ram32");
  expect(st.listAll()[0].name).toBe("Renamed");
});

test("save_a_unified_class", () => {
  freshDb();
  const st = stores.getHardwareClassStore();
  st.save("unified-mem192", "unified", 0, 192, "Mac Studio");
  const row = st.listAll()[0];
  expect([row.memType, row.vramGb, row.ramGb]).toEqual(["unified", 0, 192]);
});

test("editing_relocates_and_cascades_configs", () => {
  freshDb();
  const st = stores.getHardwareClassStore();
  st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Box");
  addTune("m1", "dgpu-vram8|ram32", "n_cpu_moe", "21");
  // edit VRAM 8 → 16: the key moves, configs cascade, the old sidecar is gone
  st.save("dgpu-vram16|ram32", "discrete", 16, 32, "Box", "dgpu-vram8|ram32");
  expect(new Set(st.listAll().map((r) => r.classKey))).toEqual(new Set(["dgpu-vram16|ram32"]));
  const h = db.session();
  const moved = h.all("select * from class_tunes where model_id = ?", ["m1"]);
  expect(moved).toHaveLength(1);
  expect(moved[0].class_key).toBe("dgpu-vram16|ram32");
  expect(h.value("select count(*) from class_tunes where class_key = ?", ["dgpu-vram8|ram32"])).toBe(0);
});

test("duplicate_hardware_is_rejected", () => {
  freshDb();
  const st = stores.getHardwareClassStore();
  st.save("dgpu-vram8|ram32", "discrete", 8, 32, "First");
  expect(() => st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Second")).toThrow(ValueError);
  st.save("dgpu-vram16|ram16", "discrete", 16, 16, "Other");
  expect(() => st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Other", "dgpu-vram16|ram16")).toThrow(ValueError);
});

test("ensure_creates_blank_named_then_noops", () => {
  freshDb();
  const st = stores.getHardwareClassStore();
  st.ensure("dgpu-vram8|ram32", "discrete", 8, 32);
  expect(st.listAll()[0].name).toBe("");
  st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Named", "dgpu-vram8|ram32");
  st.ensure("dgpu-vram8|ram32", "discrete", 8, 32); // must NOT clobber the name
  expect(st.listAll()[0].name).toBe("Named");
});

test("delete_removes_class_and_its_configs", () => {
  freshDb();
  const st = stores.getHardwareClassStore();
  st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Box");
  addTune("m1", "dgpu-vram8|ram32", "threads", "8");
  st.delete("dgpu-vram8|ram32");
  expect(st.listAll()).toEqual([]);
  expect(db.session().value("select count(*) from class_tunes where class_key = ?", ["dgpu-vram8|ram32"])).toBe(0);
});

// ── the router (the wired seam) ──────────────────────────────────────────────
// Each store/router test opens its own fresh database (Python's `configured` fixture).
{
  let client;
  const setup = () => {
    freshDb();
    const app = createServer({ typeBase: "https://example.test/errors/" });
    app.route(
      "/",
      makeClassTunesRouter(stores.getClassTuneStore, () => "dgpu-vram8|ram32", {
        hwClassStore: stores.getHardwareClassStore,
        // the BANDED derive, mirroring installLlm (2026-07-25): typed numbers land in their
        // band, so a hand-made class always matches what detection emits.
        deriveKeyFn: bandedClassKey,
        parseKeyFn: parseClassKey,
      }),
    );
    client = app;
  };
  /** A PUT with a JSON body. */
  const put = (url, payload) =>
    client.request(url, { method: "PUT", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
  const putClass = async (payload) => put("/v1/ai/hardware-class", payload);

  test("put_discrete_class_derives_key", async () => {
    setup();
    const r = await (await putClass({ name: "My PC", memType: "discrete", vramGb: 16, ramGb: 16 })).json();
    const cls = r.classes.find((c) => c.classKey === "dgpu-vram16|ram16");
    expect([cls.name, cls.memType, cls.vramGb, cls.ramGb]).toEqual(["My PC", "discrete", 16, 16]);
  });

  test("put_discrete_class_bands_typed_numbers", async () => {
    // A hand-typed micro-class lands in its BAND (the derive is bandedClassKey, mirroring
    // installLlm) — otherwise a user typing their card's true 10 GB would mint a class
    // detection can never match. The stored row's numbers are re-read FROM the banded key,
    // so row and key can never disagree.
    setup();
    const r = await (await putClass({ name: "3080 rig", memType: "discrete", vramGb: 10, ramGb: 48 })).json();
    const cls = r.classes.find((c) => c.classKey === "dgpu-vram8|ram32");
    expect([cls.vramGb, cls.ramGb]).toEqual([8, 32]); // key-derived, not the typed 10/48
  });

  test("put_unified_class_zeroes_vram_and_keys_on_memory", async () => {
    setup();
    const r = await (await putClass({ name: "Mac", memType: "unified", vramGb: 999, ramGb: 192 })).json();
    const cls = r.classes.find((c) => c.classKey === "unified-mem192");
    expect(cls.vramGb).toBe(0); // one-pool types carry no separate VRAM even if sent
  });

  test("put_discrete_without_vram_is_rejected", async () => {
    setup();
    expect((await putClass({ name: "x", memType: "discrete", vramGb: 0, ramGb: 32 })).status).toBe(400);
  });

  test("put_rejects_zero_memory_and_bad_type", async () => {
    setup();
    expect((await putClass({ name: "x", memType: "integrated", vramGb: 0, ramGb: 0 })).status).toBe(400);
    expect((await putClass({ name: "x", memType: "gpu", vramGb: 0, ramGb: 16 })).status).toBe(400);
  });

  test("config_put_auto_ensures_its_class", async () => {
    setup();
    const r = await (
      await put("/v1/ai/class-tunes", { modelId: "m1", classKey: "dgpu-vram8|ram32", switches: [{ flagName: "n_cpu_moe", flagValue: "21" }] })
    ).json();
    const cls = r.classes.find((c) => c.classKey === "dgpu-vram8|ram32");
    expect(cls.memType).toBe("discrete"); // parsed from the key by ensure
    expect(r.tunes.some((t) => t.modelId === "m1")).toBe(true);
  });

  test("delete_hardware_class_via_router", async () => {
    setup();
    await putClass({ name: "z", memType: "integrated", vramGb: 0, ramGb: 16 });
    const r = await (await client.request("/v1/ai/hardware-class?classKey=igpu-mem16", { method: "DELETE" })).json();
    expect(r.classes.every((c) => c.classKey !== "igpu-mem16")).toBe(true);
  });
}
