// SPDX-License-Identifier: MIT
// The shared switch-presets router — the port of llm/switch_presets_api.py. The
// capability/type switch bundles (`base`/`moe`/`dense`) the resolver layers (see
// `switch_resolve`). Seeded + user-editable + reset-to-factory, exactly like the model
// catalog. A preset is a row (id / label / appliesTo) plus its flag rows
// (`preset_switches`); the PUT replaces a preset's WHOLE flag set (the editor sends the full
// preset).
//
// `appliesTo`: `all` (every model) · `moe`/`dense` (matches `model_catalog.type`) · `mtp`
// (the GATED auto-enable layer, re-added 2026-07-05 Plan B — applied only to a model with MTP
// enabled; an opt-out saves `spec_type=none` into `model_tunes`, which wins).

import { Hono } from "hono";
import { HttpError } from "../platform/errors.js";
import { model, opt, T } from "../platform/models.js";
import { strip } from "../platform/py.js";
import { input } from "../platform/server.js";

export const PresetSwitchRow = T.Object({
  flagName: T.String(),
  flagValue: opt(T.String(), ""),
});

export const SwitchPresetRow = T.Object({
  id: T.String(),
  label: opt(T.String(), ""),
  appliesTo: opt(T.String(), "all"), // all | moe | dense
  position: opt(T.Integer(), 0),
  builtIn: opt(T.Boolean(), false),
  switches: opt(T.Array(PresetSwitchRow), []),
});

export const SwitchPresetsResponse = T.Object({
  rows: T.Array(SwitchPresetRow),
});

// The host boundary (Python's SwitchPresetStore Protocol): list() → SwitchPresetRow[],
// upsert(row) (replaces the preset's switches), delete(presetId), resetToFactory().

/** CRUD + reset for the capability/type switch presets. */
export function makeSwitchPresetsRouter(getStore) {
  const app = new Hono();
  const list = () => model(SwitchPresetsResponse, { rows: getStore().list() });

  app.get("/v1/ai/switch-presets", async (c) => c.json(list()));

  app.put("/v1/ai/switch-presets", input({ body: SwitchPresetRow }), async (c) => {
    const body = c.req.valid("json");
    if (!strip(body.id)) throw new HttpError(400, "id is required");
    getStore().upsert(body);
    return c.json(list());
  });

  app.delete(
    "/v1/ai/switch-presets",
    input({ querystring: T.Object({ presetId: T.String() }) }),
    async (c) => {
      const { presetId } = c.req.valid("query");
      if (!strip(presetId)) throw new HttpError(400, "presetId is required");
      getStore().delete(presetId);
      return c.json(list());
    },
  );

  app.post("/v1/ai/switch-presets/reset", async (c) => {
    getStore().resetToFactory();
    return c.json(list());
  });
  return app;
}
