// SPDX-License-Identifier: MIT
// The model catalog's wire models and router — the port of llm/model_catalog_api.py.
//
// The downloadable llama.cpp model catalog lives in the host DB so users can add/edit/
// curate without re-shipping. One store + one router: ModelCatalogStore →
// /v1/ai/model-catalog (GET/PUT/DELETE/reset), plus the read-only resolved-defaults, the
// HF list-files and the pre-download inspect when the host wires them.
//
// `builtIn` marks seeded rows; reset = restore factory values for seeded keys, preserve
// user-added rows. (There is no per-model spawn-flag table — a model's switches are its
// type baseline in `switch_presets` (resolved by `resolveModelSwitches`) plus the
// per-preset `engine_presets` config tuned in the Lab.)
//
// Every response goes through its model (`model(Schema, value)`) as FastAPI's
// response_model did: only the declared fields, in declaration order. Several comments
// below say a field MUST be declared or the wire strips it — keep every one.

import { Hono } from "hono";
import { HttpError, RequestValidationError } from "../platform/errors.js";
import { model, nullable, opt, T } from "../platform/models.js";
import { FileNotFoundError, pyStr, truthy } from "../platform/py.js";
import { pyStrScalar } from "../platform/pyjson.js";
import { input } from "../platform/server.js";

// ── Catalog ──────────────────────────────────────────────────────────────────

/** One downloadable llama.cpp model — catalog fields only. `builtIn` marks a seeded row
 * (so the editor can offer 'reset to factory'). */
export const CatalogRow = T.Object({
  id: T.String(),
  name: opt(T.String(), ""),
  hfRepo: opt(T.String(), ""),
  quant: opt(T.String(), ""),
  mmproj: opt(nullable(T.String()), null),
  totalParams: opt(T.String(), ""),
  activeParams: opt(T.String(), ""),
  // MTP ENABLED/intent — the user-facing "use MTP" flag (checkbox + grid badge +
  // switch_resolve's auto-mtp layer). Seed/user-owned; identity NEVER writes it.
  mtp: opt(T.Boolean(), false),
  // MTP BUILT-IN — header `nextn_predict_layers>0` (Qwen/GLM in-file heads). Written only
  // by the GGUF identity read; read-only display + auto-detect provenance. A Gemma
  // external-draft model is mtpBuiltin=false yet can still be mtp=true.
  mtpBuiltin: opt(T.Boolean(), false),
  type: opt(T.String(), "dense"), // dense | moe — drives which switch preset applies (§6.5)
  // Gemma-style SEPARATE MTP draft file — facts about the model, feeds --model-draft at
  // load (Plan B, D7). "" everywhere = no external draft (Qwen builds MTP in).
  mtpDraftRepo: opt(T.String(), ""), // "" = the draft lives in the SAME repo as hfRepo
  mtpDraftFile: opt(T.String(), ""), // exact path within the repo (e.g. "MTP/…-Q4_0-MTP.gguf")
  mtpDraftQuant: opt(T.String(), ""), // display/selection metadata; the file path is authoritative
  trainedCtx: opt(nullable(T.Integer()), null), // GGUF `<arch>.context_length`, file-derived (null until read)
  samplers: opt(T.Record(T.String(), T.String()), {}), // file-derived recommended samplers (read-only)
  minVramMb: opt(nullable(T.Integer()), null),
  minRamMb: opt(nullable(T.Integer()), null),
  tier: opt(T.String(), "mid"), // cpu | low-vram-moe | mid | high | high-ram
  license: opt(T.String(), ""), // SPDX id (Apache-2.0 | MIT | Llama-Community | …); "" = unknown
  useLimited: opt(T.Boolean(), false), // not free for unrestricted/commercial use → the ⚠ badge (DB-stored)
  embedding: opt(T.Boolean(), false), // an embedding model (RAG index), not a chat LLM — explicit editable flag
  pooling: opt(T.String(), ""), // embedding pooling: "" | mean | cls | last | rank (intrinsic per-model)
  qualityRank: opt(T.Integer(), 100), // curated overall-quality order (LOWER = better); 100 = unranked
  // FILE/LINK-OWNED since 2026-07-07 (user decree): Read-from-link regenerates it.
  description: opt(T.String(), ""),
  // The user's OWN notes — persistent, never written by read/download/backfill/seed.
  notes: opt(T.String(), ""),
  // File-derived identity facts (#141 — persisted so Edit-open == Read-from-link):
  architecture: opt(T.String(), ""), // e.g. "gemma4"
  experts: opt(T.Integer(), 0), // MoE expert count (0 = dense)
  sizeLabel: opt(T.String(), ""), // e.g. "128x2.6B" / "27B"
  sizeBytes: opt(nullable(T.Integer()), null), // the GGUF file size — QUANT-SPECIFIC (cleared on quant change)
  // Pre-download VRAM estimate (full GPU · 8K ctx) — persisted so Edit-open shows the
  // same "≈ N MB VRAM" line Read-from-link does; null until a header read.
  estVramMb: opt(nullable(T.Integer()), null),
  // The physics FACTS (fit-redesign §13.11): immutable file properties the floors/est/
  // badge are computed FRESH from. Filled by inspect / download / seed refresh; null =
  // header never read (fidelity falls back). Snake keys ON PURPOSE — they mirror the DB
  // columns 1:1 through one dict.
  physicsFacts: opt(nullable(T.Record(T.String(), T.Number())), null),
  position: opt(T.Integer(), 0),
  builtIn: opt(T.Boolean(), false),
});

/**
 * One (model, class) pair that HAS a class config — the §9 final ruled shape (user,
 * 2026-07-22): the recommendation IS the visible class-config list. A model with a config
 * for YOUR class outranks the §10 formula; no match → §10 fallback.
 */
export const ClassTuneRef = T.Object({
  modelId: T.String(),
  classKey: T.String(),
});

export const CatalogResponse = T.Object({
  rows: T.Array(CatalogRow),
  // The (model, class) config pairs + THIS box's class ride the catalog response (one
  // fetch, no extra endpoint) — QuickSetup's recommendation reads the SAME rows the user
  // sees in the class panel (§9 final ruled shape, 2026-07-22).
  classTuneRefs: opt(T.Array(ClassTuneRef), []),
  myClassKey: opt(T.String(), ""),
});

/**
 * The file-derived facts the Add-a-model form pre-fills from the GGUF header, read
 * PRE-download over the HF link (`POST /model-catalog/inspect`). type/mtp/trainedCtx/
 * samplers are the read-only "auto-detected from the file" facts; sizeBytes/estVramMb
 * ground the fit estimate in the real file, not a guess.
 */
export const InspectResponse = T.Object({
  architecture: opt(T.String(), ""),
  type: opt(T.String(), "dense"),
  // HEADER truth (`nextn_predict_layers>0`) — the read-only auto-detected fact. The form
  // computes the ENABLE flag from this OR a draft OR the inherited drafter below.
  mtpBuiltin: opt(T.Boolean(), false),
  trainedCtx: opt(nullable(T.Integer()), null),
  experts: opt(T.Integer(), 0), // expert_count (0 = dense)
  sizeLabel: opt(T.String(), ""), // general.size_label ("27B" dense; "128x9.4B" MoE expert-config)
  totalParams: opt(T.String(), ""), // param count file-derived from size_label — dense only; "" for MoE
  samplers: opt(T.Record(T.String(), T.String()), {}), // recommended samplers (read-only fact)
  sizeBytes: opt(T.Integer(), 0), // real total weight size (summed shards) — the download size
  estVramMb: opt(nullable(T.Integer()), null), // est. VRAM to fully offload at 8K ctx (real header + size)
  physicsFacts: opt(nullable(T.Record(T.String(), T.Number())), null), // §13.11 file facts — the form persists them via the row PUT
  // est. system RAM floor from the download size (file + 4 GB, snapped to a real RAM
  // rung). Declared HERE because this response model would otherwise silently strip it —
  // the Add form's Min RAM would stay blank and the model would match no PC class.
  estRamMb: opt(nullable(T.Integer()), null),
  // Tier-C (2026-07-13): a borrowable OFFICIAL companion drafter, discovered when the
  // model has no built-in MTP and none in its own repo — "" when none was found.
  mtpInheritedRepo: opt(T.String(), ""),
  mtpInheritedFile: opt(T.String(), ""),
  mtpInheritedQuant: opt(T.String(), ""),
});

/**
 * One quant available in an HF repo (shards summed) — the quant DROPDOWN row. `kind`
 * labels the family (Q | IQ | special); `qat` flags quantization-aware-trained weights,
 * detected from the file PATH (QAT is a training property with no GGUF header key).
 */
export const RepoQuantRow = T.Object({
  quant: T.String(),
  sizeMb: opt(T.Integer(), 0),
  files: opt(T.Integer(), 1),
  kind: opt(T.String(), ""),
  qat: opt(T.Boolean(), false),
  // ≥4-bit pick floor (fit-redesign §4 0.4) — declared HERE or the wire silently strips
  // it: the server computed it, the wire dropped it, the form's find() saw undefined
  // everywhere and fell back to the smallest quant — the IQ1_M ghost SURVIVING its own fix
  // (caught live 2026-08-13).
  q4OrBetter: opt(T.Boolean(), false),
});

/**
 * One detected MTP draft file in the repo (`MTP/` dir, `-MTP.gguf`, or a `dspark` own-repo
 * drafter) — picked by exact path; its quant + size ride along for the label.
 *
 * EVERY field the form needs must be declared here: this model is the wire, and anything
 * `classifyGgufEntries` adds but this model doesn't name is silently DROPPED. That is
 * exactly how `q4OrBetter` reached the browser as `undefined` on its first cut
 * (2026-07-19), collapsing the draft pre-select back to plain smallest-wins with no floor.
 */
export const RepoDraftRow = T.Object({
  path: T.String(),
  quant: opt(T.String(), ""),
  sizeMb: opt(T.Integer(), 0),
  qat: opt(T.Boolean(), false),
  // The shared 4-bit pick floor (`_q4OrBetter`) — the form's pre-select orders by it.
  q4OrBetter: opt(T.Boolean(), false),
  // Can our pinned engine load this draft's ARCHITECTURE? false for a known-unsupported
  // arch (`unsupportedArch` names the token, e.g. dspark); the form must NOT pre-pick or
  // auto-enable MTP on it, and the Lab sweep must not A/B it. Like q4OrBetter it MUST be
  // declared here or the wire strips it before the browser sees it (the 2026-07-19 miss).
  loadable: opt(T.Boolean(), true),
  unsupportedArch: opt(T.String(), ""),
});

export const ListFilesResponse = T.Object({
  quants: T.Array(RepoQuantRow),
  drafts: T.Array(RepoDraftRow),
});

/**
 * One resolved model default (a Plane-1 engine switch OR a Plane-2 recommended sampler),
 * read-only: `flagName`/`flagValue` in OUR catalog namespace, so the Lab + the model-card
 * KnobGrid seed from the model's real launch flags + sampler baseline.
 */
export const ResolvedFlag = T.Object({
  flagName: T.String(),
  flagValue: opt(T.String(), ""),
});

/**
 * A model's resolved run defaults — Plane-1 engine `switches` (layered base→type) +
 * Plane-2 recommended `samplers` (the file-derived per-model baseline, in the catalog
 * namespace) + `mtpCapable`. ONE call feeds BOTH the Lab's switch grid AND sampler grid
 * seed and Tune & measure — one source, one fetch.
 */
export const ResolvedModelDefaultsResponse = T.Object({
  modelId: T.String(),
  switches: T.Array(ResolvedFlag),
  // the model's file-derived recommended samplers, seeded into the Lab's Plane-2 sampler
  // grid so what you see is what runs (seen = run).
  samplers: opt(T.Array(ResolvedFlag), []),
  // the model's GGUF ships MTP draft layers → the UI surfaces Speculative decode
  // (spec_type) as a measurable opt-in (Phase 3), default off.
  mtpCapable: opt(T.Boolean(), false),
  // Fix 2 (2026-07-07): the engine's fit-COMPUTED launch values (n_gpu_layers / n_cpu_moe
  // / ctx_len) for keys NO resolution layer pins on this box — what the launch actually
  // uses on a wholly-untuned box/model. Kept SEPARATE from `switches`: merging them into
  // the editable grid would let Save tune pin today's fit as explicit values, which the
  // strict-beat rule exists to prevent.
  computed: opt(T.Array(ResolvedFlag), []),
  // PROVENANCE (2026-07-07): flagName → the layer that last wrote it (base | type | mtp |
  // class | tune) — the Tune grid's per-row origin tags ride this; fit-computed rows carry
  // their own provenance by living in `computed`. Empty when the host wires no origins
  // resolver.
  origins: opt(T.Record(T.String(), T.String()), {}),
});

// ── query helpers (candidates for platform/) ─────────────────────────────────

const BOOL_TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const BOOL_FALSE = new Set(["0", "off", "f", "false", "n", "no"]);

/**
 * A FastAPI `bool` query parameter, read as pydantic reads it: 1/0/yes/no/on/off/true/
 * false/t/f/y/n in any case (no trimming — " true" is refused). An absent value is `dflt`;
 * anything else answers pydantic's 422 at ["query", name]. Candidate for platform/.
 */
export function queryBool(value, name, dflt = false) {
  if (value === undefined || value === null) return dflt;
  const s = String(value).toLowerCase();
  if (BOOL_TRUE.has(s)) return true;
  if (BOOL_FALSE.has(s)) return false;
  throw new RequestValidationError([
    { loc: ["query", name], msg: "Input should be a valid boolean, unable to interpret input", type: "bool_parsing" },
  ]);
}

/** `str(e)` of a caught exception, for a detail string. Candidate for platform/. */
export const excStr = (e) => (e instanceof Error ? e.message : pyStr(e));

const strip = (s) => String(s ?? "").trim();

/**
 * CRUD + reset for the per-model llama.cpp catalog. `getStore()` → {list(), upsert(row),
 * delete(modelId), resetToFactory()}. The options are the injected functions (each mounts
 * or enriches a route only when given):
 *   - `resolveSwitches(modelId)` → {flag: value}: mounts GET /model-catalog/resolved-defaults
 *     — the model's resolved Plane-1 switch defaults PLUS its Plane-2 recommended samplers
 *     (read from the catalog row), so the Lab + the model-card KnobGrid seed the real launch
 *     flags + sampler baseline before tuning — read-only;
 *   - `resolveOrigins(modelId)` → [merged, origins] (provenance-aware, preferred when given);
 *   - `resolveBaselineOrigins(modelId)` → [merged, origins]: the same resolve WITHOUT the
 *     machine tune — serves resolved-defaults?excludeTune=1, which "Refresh from defaults"
 *     loads into the Tune grid (§7.6, 2026-07-08);
 *   - `previewFitFn(modelId)` → the runner's fit preview (may be async);
 *   - `listFilesFn(repo, revision)` → ListFilesResponse data (async): mounts POST list-files;
 *   - `inspectFn(repo, quant, revision)` → InspectResponse data (async): mounts POST inspect;
 *   - `classTuneRefsFn()` → [{modelId, classKey}], `classKeyFn()` → this box's class;
 *   - `onReset()`: a catalog reset is a config clean-slate (2026-07-11, user decision) — the
 *     host wires the runner's full stop() so no child keeps running under pre-reset facts.
 */
export function makeCatalogRouter(
  getStore,
  {
    resolveSwitches = null,
    inspectFn = null,
    listFilesFn = null,
    classTuneRefsFn = null,
    classKeyFn = null,
    previewFitFn = null,
    resolveOrigins = null,
    resolveBaselineOrigins = null,
    onReset = null,
  } = {},
) {
  const app = new Hono();
  const list = () => {
    const refs = (classTuneRefsFn ? classTuneRefsFn() : []).map((r) => model(ClassTuneRef, r));
    return model(CatalogResponse, {
      rows: getStore().list(),
      classTuneRefs: refs,
      myClassKey: classKeyFn ? classKeyFn() : "",
    });
  };

  app.get("/v1/ai/model-catalog", async (c) => c.json(list()));

  app.put("/v1/ai/model-catalog", input({ body: CatalogRow }), async (c) => {
    const body = model(CatalogRow, c.req.valid("json"));
    if (!strip(body.id)) throw new HttpError(400, "id is required");
    body.builtIn = false; // user edit, even if id matches a built-in
    getStore().upsert(body);
    return c.json(list());
  });

  app.delete(
    "/v1/ai/model-catalog",
    input({ querystring: T.Object({ modelId: T.String() }) }),
    async (c) => {
      const { modelId } = c.req.valid("query");
      if (!strip(modelId)) throw new HttpError(400, "modelId is required");
      getStore().delete(modelId);
      return c.json(list());
    },
  );

  app.post("/v1/ai/model-catalog/reset", async (c) => {
    getStore().resetToFactory();
    if (onReset != null) await onReset();
    return c.json(list());
  });

  if (resolveSwitches != null) {
    app.get(
      "/v1/ai/model-catalog/resolved-defaults",
      input({ querystring: T.Object({ modelId: T.String(), excludeTune: opt(T.String()) }) }),
      async (c) => {
        const query = c.req.valid("query");
        const { modelId } = query;
        const excludeTune = queryBool(query.excludeTune, "excludeTune");
        if (!strip(modelId)) throw new HttpError(400, "modelId is required");
        // Provenance-aware resolve when wired (one call yields values + origins); the
        // plain resolver stays the fallback so hosts without origins keep working.
        // excludeTune=1 (§7.6) answers with the LAYER baseline — the machine tune skipped
        // — for the Tune modal's "Refresh from defaults"; when no baseline resolver is
        // wired it falls through to the normal resolve (honest fallback).
        let merged;
        let origins;
        if (excludeTune && resolveBaselineOrigins != null) {
          [merged, origins] = await resolveBaselineOrigins(modelId);
        } else if (resolveOrigins != null) {
          [merged, origins] = await resolveOrigins(modelId);
        } else {
          merged = await resolveSwitches(modelId);
          origins = {};
        }
        merged = truthy(merged) ? merged : {};
        origins = truthy(origins) ? origins : {};
        // ONE store read serves BOTH the mtp flag and the model's recommended samplers.
        const row = getStore()
          .list()
          .find((r) => r.id === modelId) ?? null;
        const samplers = (row ? row.samplers : null) || {};
        // Fix 2: the fit-COMPUTED launch values for keys no layer pins — read from the
        // runner's pure fit preview (needs the GGUF on disk; errors soft → empty, the grid
        // simply shows what it always showed). n_cpu_moe only means anything on a MoE
        // model.
        let computed = [];
        if (previewFitFn != null) {
          let pv;
          try {
            pv = (await previewFitFn(modelId)) || {};
          } catch {
            pv = {}; // an enrichment must never break the grid seed
          }
          if (truthy(pv.ok)) {
            const fitVals = [
              ["n_gpu_layers", pv.nGpuLayers],
              ["ctx_len", pv.ctxLen],
            ];
            if (truthy(pv.isMoe)) fitVals.push(["n_cpu_moe", pv.nCpuMoe]);
            computed = fitVals
              .filter(([k, v]) => v != null && !Object.hasOwn(merged, k))
              .map(([k, v]) => ({ flagName: k, flagValue: pyStrScalar(v) }));
          }
        }
        return c.json(
          model(ResolvedModelDefaultsResponse, {
            modelId,
            // mtpCapable = MTP is AVAILABLE to enable — built-in header MTP OR a configured
            // external draft (2026-07-13: reads `mtpBuiltin`, the header truth, NOT the
            // `mtp` ENABLE flag — availability is a fact, enablement is the user's switch).
            // The Tune modal's spec-decode hint rides this.
            mtpCapable: !!(row && (row.mtpBuiltin || row.mtpDraftFile)),
            switches: Object.entries(merged).map(([k, v]) => ({ flagName: k, flagValue: pyStrScalar(v) })),
            samplers: Object.entries(samplers).map(([k, v]) => ({ flagName: k, flagValue: pyStrScalar(v) })),
            computed,
            origins,
          }),
        );
      },
    );
  }

  if (listFilesFn != null) {
    // ONE HF tree call → the repo's quant dropdown rows (shards summed, Q/IQ/QAT labels)
    // + detected MTP draft files (Plan B D9). Powers the Add/Edit form's quant + draft
    // pickers.
    app.post(
      "/v1/ai/model-catalog/list-files",
      input({ querystring: T.Object({ repo: T.String(), revision: opt(T.String(), "main") }) }),
      async (c) => {
        const { repo, revision } = c.req.valid("query");
        if (!strip(repo)) throw new HttpError(400, "repo is required");
        let data;
        try {
          data = await listFilesFn(strip(repo), strip(revision || "main"));
        } catch (e) {
          // network/bad-repo → a clean 502
          throw new HttpError(502, `couldn't list ${repo}: ${excStr(e)}`);
        }
        return c.json(model(ListFilesResponse, data));
      },
    );
  }

  if (inspectFn != null) {
    // Pre-download: read the GGUF header from the HF link (no weights) so the Add-a-model
    // form fills the file-derived fields (type/mtp/trainedCtx/samplers) + the real size +
    // a VRAM estimate before committing to a multi-GB download.
    app.post(
      "/v1/ai/model-catalog/inspect",
      input({
        querystring: T.Object({ repo: T.String(), quant: opt(T.String(), ""), revision: opt(T.String(), "main") }),
      }),
      async (c) => {
        const { repo, quant, revision } = c.req.valid("query");
        if (!strip(repo)) throw new HttpError(400, "repo is required");
        let data;
        try {
          data = await inspectFn(strip(repo), strip(quant), strip(revision || "main"));
        } catch (e) {
          if (e instanceof FileNotFoundError || e?.code === "ENOENT") {
            throw new HttpError(404, excStr(e) || "no GGUF for that repo/quant");
          }
          if (e instanceof HttpError) throw e;
          // network/parse failure → 502 with the reason
          throw new HttpError(502, `inspect failed: ${excStr(e)}`);
        }
        return c.json(model(InspectResponse, data));
      },
    );
  }
  return app;
}
