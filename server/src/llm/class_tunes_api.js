// SPDX-License-Identifier: MIT
// The editable HARDWARE-CLASS library — the port of llm/class_tunes_api.py.
//
// TWO levels (2026-07-22 user redesign — "a named hardware class that holds several
// model-configs"):
//   • a HARDWARE CLASS = a NAMED bucket with editable whole-GB VRAM/RAM fields
//     (`HardwareClassRow`); its `classKey` (`dgpu-vram<GB>|ram<GB>` / `igpu-mem<GB>` /
//     `unified-mem<GB>`) is the identity + join and is DERIVED from VRAM/RAM ("i reverse that
//     vram and ram is key"). `name` is a free label ("but name can be anything"), never
//     matched on.
//   • a MODEL-CONFIG = one model's measured launch switches under a class (`ClassTune`),
//     keyed by (model_id, class_key). `switch_resolve` applies it BELOW a machine's own
//     ModelTune and ABOVE the base/type/mtp bundles.
//
// Sibling precedent: model_tunes_api (the same store + router-factory seam). GET returns the
// whole library (small); it also carries `classKey` — the CURRENT box's class
// (server-derived via `classKeyFn`, one source, override-aware). The config PUT `ensure()`s
// its class exists first (the Tune-modal 'Save for hardware class' path saves a config for
// the box's class before any class form ran). Config PUT always writes `built_in=false` (an
// edited config is the user's now; a fully DELETED built-in re-seeds next start — the UI
// offers Edit, not Delete, on built-ins).

import { HttpError } from "../platform/errors.js";
import { model, nullable, opt, T } from "../platform/models.js";
import { pyInt, ValueError } from "../platform/py.js";

export const ClassTuneFlag = T.Object({
  flagName: T.String(),
  flagValue: opt(T.String(), ""),
});

/** One (model, hardware-class) launch config — a row group in the library. */
export const ClassTuneConfig = T.Object({
  modelId: T.String(),
  classKey: T.String(),
  builtIn: opt(T.Boolean(), false),
  rows: T.Array(ClassTuneFlag),
});

/**
 * A named hardware class — the label + editable fields the form binds to. `classKey` is the
 * derived identity; `memType` is discrete|integrated|unified. Discrete uses vramGb+ramGb;
 * integrated/unified use ramGb as the one memory pool. `name` blank → the UI shows
 * plain-words hardware (2026-07-22).
 */
export const HardwareClassRow = T.Object({
  classKey: T.String(),
  memType: opt(T.String(), "discrete"),
  vramGb: opt(T.Integer(), 0),
  ramGb: opt(T.Integer(), 0),
  name: opt(T.String(), ""),
  builtIn: opt(T.Boolean(), false),
  // Class-typical RAW pool bandwidths, GB/s (fit-redesign Phase 3, §5.5 ladder source 3) —
  // seeded from vendor/JEDEC arithmetic, editable here, superseded by any
  // measurement/device-reported number. 0 = unknown. One-pool classes carry the pool in
  // ramBwGbps only.
  vramBwGbps: opt(T.Number(), 0.0),
  ramBwGbps: opt(T.Number(), 0.0),
});

export const ClassTunesResponse = T.Object({
  classKey: T.String(), // the CURRENT box's class (server-derived, override-aware)
  classes: opt(T.Array(HardwareClassRow), []), // the named classes (name + VRAM/RAM)
  tunes: T.Array(ClassTuneConfig), // the model-configs — every model × class
});

export const ClassTunePut = T.Object({
  modelId: T.String(),
  classKey: opt(T.String(), ""), // "" → the current box's class (Save-for-this-class)
  switches: opt(T.Array(ClassTuneFlag), []),
});

/**
 * Add/edit a hardware class. `classKey` is DERIVED server-side from memType+vramGb+ramGb.
 * `origClassKey` (edit only) names the class being changed — when the key moved
 * (type/VRAM/RAM changed), its model-configs cascade across.
 */
export const HardwareClassPut = T.Object({
  name: opt(T.String(), ""),
  memType: opt(T.String(), "discrete"),
  vramGb: opt(T.Integer(), 0),
  ramGb: opt(T.Integer(), 0),
  origClassKey: opt(T.String(), ""),
  // null = leave the stored bandwidth untouched (an older client that doesn't send the
  // fields must not zero them); 0 = the user explicitly cleared it.
  vramBwGbps: opt(nullable(T.Number()), null),
  ramBwGbps: opt(nullable(T.Number()), null),
});

const strip = (s) => String(s ?? "").trim();

/**
 * GET (the whole library) / config PUT+DELETE / class PUT+DELETE. `getStore()` →
 * {listAll(), replace(modelId, classKey, rows), delete(modelId, classKey)}; `classKeyFn()`
 * → this box's class. The class-level routes + the `classes` list mount only when the
 * hardware-class seam is wired (`hwClassStore()` → {listAll(), save(…), ensure(…),
 * delete(classKey)}, `deriveKeyFn(memType, vramGb, ramGb)`, `parseKeyFn(key)` →
 * [memType, vramGb, ramGb]) — both apps wire it via installLlm; the options stay optional
 * for a bare mount.
 */
export function makeClassTunesRouter(getStore, classKeyFn, { hwClassStore = null, deriveKeyFn = null, parseKeyFn = null } = {}) {
  return async function classTunesRouter(app) {
    const classes = () => (hwClassStore ? hwClassStore().listAll().map((r) => model(HardwareClassRow, r)) : []);
    const response = () =>
      model(ClassTunesResponse, { classKey: classKeyFn(), classes: classes(), tunes: getStore().listAll() });

    app.get("/v1/ai/class-tunes", async () => response());

    app.put("/v1/ai/class-tunes", { schema: { body: ClassTunePut } }, async (req) => {
      const body = model(ClassTunePut, req.body);
      if (!strip(body.modelId)) throw new HttpError(400, "modelId is required");
      const classKey = strip(body.classKey) || classKeyFn();
      if (!body.switches.some((f) => strip(f.flagName || ""))) {
        throw new HttpError(400, "at least one switch is required");
      }
      // Ensure the class row exists (the 'Save for hardware class' path may save a config
      // for the box's class before any class form created it).
      if (hwClassStore && parseKeyFn) {
        const [mt, v, r] = parseKeyFn(classKey);
        hwClassStore().ensure(classKey, mt, v, r);
      }
      getStore().replace(strip(body.modelId), classKey, body.switches);
      return response();
    });

    app.delete(
      "/v1/ai/class-tunes",
      { schema: { querystring: T.Object({ modelId: T.String(), classKey: T.String() }) } },
      async (req) => {
        const { modelId, classKey } = req.query;
        if (!strip(modelId) || !strip(classKey)) throw new HttpError(400, "modelId and classKey are required");
        getStore().delete(strip(modelId), strip(classKey));
        return response();
      },
    );

    if (hwClassStore && deriveKeyFn) {
      app.put("/v1/ai/hardware-class", { schema: { body: HardwareClassPut } }, async (req) => {
        const body = model(HardwareClassPut, req.body);
        let memType = strip(body.memType || "discrete").toLowerCase();
        if (!["discrete", "integrated", "unified"].includes(memType)) {
          throw new HttpError(400, "memType must be discrete, integrated, or unified");
        }
        let vram = pyInt(body.vramGb || 0);
        let ram = pyInt(body.ramGb || 0); // discrete: system RAM · integrated/unified: the pool
        if (ram <= 0) throw new HttpError(400, "memory must be a positive whole number of GB");
        if (memType === "discrete" && vram <= 0) throw new HttpError(400, "a discrete GPU class needs its VRAM in GB");
        if (memType !== "discrete") vram = 0; // one-pool types carry no separate VRAM
        const classKey = deriveKeyFn(memType, vram, ram);
        if (parseKeyFn) {
          // The stored numbers come FROM the derived key (2026-07-25): derive is the BANDED
          // builder (a typed vram 10 keys as the 8 band), and a row whose own numbers
          // disagreed with its key would lie to every parseClassKey consumer. With an
          // un-banded derive this is identity.
          [memType, vram, ram] = parseKeyFn(classKey);
        }
        try {
          hwClassStore().save(
            classKey,
            memType,
            vram,
            ram,
            body.name || "",
            body.origClassKey || "",
            body.vramBwGbps,
            body.ramBwGbps,
          );
        } catch (e) {
          if (e instanceof ValueError) throw new HttpError(409, e.message);
          throw e;
        }
        return response();
      });

      app.delete(
        "/v1/ai/hardware-class",
        { schema: { querystring: T.Object({ classKey: T.String() }) } },
        async (req) => {
          const { classKey } = req.query;
          if (!strip(classKey)) throw new HttpError(400, "classKey is required");
          hwClassStore().delete(strip(classKey));
          return response();
        },
      );
    }
  };
}
