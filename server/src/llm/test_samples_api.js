// SPDX-License-Identifier: MIT
// The Lab test-samples router — the port of llm/test_samples_api.py (§7.3, 2026-07-08;
// re-keyed per ACTION 2026-07-15 — the task tier is gone): the canned per-ACTION Lab samples
// ("sample data we have in database", the user's #30). GET lists (all, or one action's) for
// the Lab's Sample button; PUT/DELETE keep the rows editable (the seed is fill-if-empty, so
// an edit sticks). Sibling precedent: class_tunes_api (the same store + router seam).

import { HttpError } from "../platform/errors.js";
import { model, nullable, opt, T } from "../platform/models.js";

export const TestSampleRow = T.Object({
  id: T.Integer(),
  action: T.String(),
  label: T.String(),
  variables: opt(T.Record(T.String(), T.String()), {}),
});

export const TestSamplesResponse = T.Object({
  rows: T.Array(TestSampleRow),
});

export const TestSamplePut = T.Object({
  id: opt(nullable(T.Integer()), null), // null → create
  action: T.String(),
  label: T.String(),
  variables: opt(T.Record(T.String(), T.String()), {}),
});

const strip = (s) => String(s ?? "").trim();

/** GET (?action= filters) / PUT (upsert one) / DELETE (?id=). `getStore()` →
 * {listForAction(action), upsert(action, label, variables, id), delete(id)}. */
export function makeTestSamplesRouter(getStore) {
  return async function testSamplesRouter(app) {
    const rows = (action = "") =>
      model(TestSamplesResponse, { rows: getStore().listForAction(action).map((r) => model(TestSampleRow, r)) });

    app.get(
      "/v1/ai/test-samples",
      { schema: { querystring: T.Object({ action: opt(T.String(), "") }) } },
      async (req) => rows(strip(req.query.action)),
    );

    app.put("/v1/ai/test-samples", { schema: { body: TestSamplePut } }, async (req) => {
      const body = model(TestSamplePut, req.body);
      if (!strip(body.action) || !strip(body.label)) throw new HttpError(400, "action and label are required");
      getStore().upsert(strip(body.action), strip(body.label), body.variables || {}, body.id);
      return rows(strip(body.action));
    });

    app.delete(
      "/v1/ai/test-samples",
      { schema: { querystring: T.Object({ id: T.Integer() }) } },
      async (req) => {
        getStore().delete(req.query.id);
        return rows();
      },
    );
  };
}
