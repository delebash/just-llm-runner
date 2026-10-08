// SPDX-License-Identifier: MIT
// Port of tests/test_install_llm.py — `installLlm`, the drop-in entry point, called the way a
// consuming app calls it.
//
// WHY THIS FILE EXISTS (2026-08-01). The one-call installer is the sentence the whole
// shared-package standard rests on, and it had ZERO direct coverage. The entry point mutates
// five process singletons and mounts ~20 routers — exactly the wiring a refactor breaks
// without noticing.
//
// Two shapes, both real:
//   - THE BARE MINIMAL CALL — `await installLlm(app, {db, dataDir})` with no feature data at
//     all: the minimal contract for "any app". Nothing in the family exercises it (JW, JV and
//     docgen all pass catalogs), which is why only a test protects it.
//   - THE WITH-FEATURES CALL + DOUBLE SEED — JustWrite's real boot: installLlm registers the
//     app's feature data, then the host calls `seedLlm()` in its own seed pass. Seeding is
//     insert-if-missing; a second seedLlm is a no-op.
//
// HERMETICITY. installLlm mutates process singletons: the storage handle
// (`db.configureStorage`), the app seed registration (`seed.cfg._APP`), the usage ledger
// (`setLedger`), the runner service (`lifecycle.state.service` via `configureService`), and
// it starts the catalog-derive-backfill background task. `beforeEach` snapshots and
// `afterEach` restores the service, the seed registration, the ledger and the hardware memo;
// `dataDir = tmp` keeps the runner's cache out of the user's real cache, and `JUST_AI_HOME`
// points the family registry at a temp folder (the install registers its cache there).
//
// PYTHON FAILS TWO OF THESE ON THIS BOX TODAY; THE JS PASSES THEM (build sheet rule 21).
// `bare_minimal_call_yields_a_working_stack` and `headless_boot_app_none_wires_everything_
// but_mounts_nothing` assert the runner's cache is `<tmp>/ai-cache`. Python's `hermetic`
// fixture never redirects JUST_AI_HOME, and since the 2026-10-06 sibling adoption a fresh
// database (no `cache_root` row) whose own cache holds no models adopts the registry's sibling
// cache that does — so on a machine whose real registry lists one (here: JustWrite's dev
// cache), Python's run reads the user's real `caches.json` and points the service at that
// cache (measured 2026-10-08: `E:\Dev\Web\justwrite-app\src-tauri\target\debug\data\ai-cache`).
// It passes on a box with no family registry. The JS points JUST_AI_HOME at a temp folder
// (nothing reads or writes the real registry), so both pass. Fix for Python: set
// `JUST_AI_HOME` to a tmp folder in `hermetic`.
//
// The no-dataDir warning names the JS parameter (`dataDir`), where Python's named `data_dir`;
// the test checks for the JS name.
//
// Hardware: Python's install never probed (its key functions were lazy); the JS installLlm
// awaits `hardware.ensureDetected()`, so the memo is filled with a fake box first
// (`hardware.setDetected`) and `hardware.detect` answers that box — no nvidia-smi from this
// file. `GET /v1/llm-runner/models` kicks the ~2 s RAM-bandwidth probe in the background; it
// is answered "unmeasurable" here so a late result can't land in the next test's database.
//
// NOTE: installLlm deliberately does NOT mount the runner router (`runnerRouter`, Python's
// `llm_runner.router`) — the host does — so the app here mounts both, the documented
// two-line adoption every app copies.
//
// FILE-BACKED SQLITE, as Python insists: its first version used one shared in-memory
// connection, and the backfill thread's boot-time session interleaved transactions with
// seed_llm's on that one connection — the seed's inserts were silently rolled back.
// better-sqlite3 is synchronous and a transaction never spans an await, so the JS can't hit
// that, but a real host hands installLlm a file, so the test does too. Foreign keys OFF, as
// Python's sqlite3 opens a file.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installLlm } from "../src/llm/install.js";
import { FeatureCatalogEntry } from "../src/llm/routing_api.js";
import * as seed from "../src/llm/seed.js";
import { seedLlm } from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { getLedger, setLedger } from "../src/llm/usage.js";
import { createServer } from "../src/platform/server.js";
import { openDatabase } from "../src/platform/sql.js";
import { runnerRouter } from "../src/runner/api.js";
import * as bandwidth from "../src/runner/bandwidth.js";
import { pyPath } from "../src/runner/cache_registry.js";
import * as hardware from "../src/runner/hardware.js";
import * as lifecycle from "../src/runner/lifecycle.js";
import { captureLogs, fakeHw } from "./_lifecycle_fakes.js";

let tmp;
let h;
let saved;

beforeEach(() => {
  saved = {
    service: lifecycle.state.service,
    app: { ...seed.cfg._APP },
    ledger: getLedger(),
    hw: hardware.memo.hw,
  };
  lifecycle.state.service = null;
  tmp = mkdtempSync(join(tmpdir(), "kit-install-"));
  vi.stubEnv("JUST_AI_HOME", join(tmp, "family"));
  // The no-dataDir case falls back to LLM_RUNNER_CACHE — a temp folder, never the user cache.
  vi.stubEnv("LLM_RUNNER_CACHE", join(tmp, "user-cache"));
  const box = fakeHw(8192);
  hardware.setDetected(box);
  vi.spyOn(hardware, "detect").mockImplementation(async () => box);
  vi.spyOn(bandwidth, "probeRamCopyGbps").mockResolvedValue(null);
  h = openDatabase(join(tmp, "app.db"), { foreignKeys: false });
});

afterEach(() => {
  lifecycle.state.service = saved.service;
  seed.cfg._APP = saved.app;
  setLedger(saved.ledger);
  hardware.memo.hw = saved.hw;
});

/** The documented two-line adoption: the host mounts the runner router itself, installLlm
 * mounts the rest. */
async function mountedApp(opts = {}) {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(runnerRouter);
  await installLlm(app, { db: h, dataDir: tmp, ...opts });
  return app;
}

const get = (app, url) => app.inject({ method: "GET", url });

/** A host catalog row (every app seeds its own since decision ④). */
const hostRow = (fields) => ({
  quant: "Q4_K_M",
  total_params: "7B",
  type: "dense",
  min_vram_mb: 4096,
  min_ram_mb: 8192,
  tier: "small",
  license: "Apache-2.0",
  position: 0,
  quality_rank: 1,
  architecture: "llama",
  experts: 0,
  ...fields,
});

test("bare_minimal_call_yields_a_working_stack", async () => {
  // The stranger's app: db + dataDir, nothing else.
  const app = await mountedApp();
  seedLlm();

  // Providers: seeded rows exist and the endpoint serves them.
  const providers = await get(app, "/v1/llm-providers");
  expect(providers.statusCode).toBe(200);
  expect(providers.json().providers.length).toBeGreaterThan(0); // seedLlm should have seeded providers

  // Routing: mounted and answering, with the (empty) feature catalog.
  expect((await get(app, "/v1/ai/routing")).statusCode).toBe(200);

  // Usage ledger: the DB sink is wired.
  expect((await get(app, "/v1/ai-usage")).statusCode).toBe(200);

  // The runner: catalog is WIRED (installLlm called configureService). Since decision ④ the
  // shared seed carries no models, so the bare call legally serves an EMPTY list.
  const models = await get(app, "/v1/llm-runner/models");
  expect(models.statusCode).toBe(200);
  const body = models.json();
  expect(body.catalogWired).toBe(true);
  expect(body.models).toEqual([]);

  // dataDir honoured: the runner's cache landed under the app's data root.
  expect(String(lifecycle.getService().cacheRoot)).toBe(pyPath(join(tmp, "ai-cache")));
});

test("with_features_and_double_seed_is_a_noop", async () => {
  // JustWrite's real boot shape: features registered, then the host's own seed pass — and a
  // SECOND seed pass changes nothing, because seeding is insert-if-missing.
  const app = await mountedApp({
    featureCatalog: [FeatureCatalogEntry({ key: "translate", label: "Translate", group: "i18n" })],
    featurePrompts: {
      translate: { feature: "translate", system: "S", user_template: "U", json_mode: false },
    },
    // The host's catalog row — also the flow-through exhibit: it must reach /models.
    modelCatalogExtra: [hostRow({ id: "host-model", name: "Host Model", hf_repo: "example/host-GGUF" })],
  });
  seedLlm();

  const providersBefore = (await get(app, "/v1/llm-providers")).json().providers.length;
  const promptsBefore = stores.getPromptStore().list().length;
  const catalogBefore = stores.getModelCatalogStore().list().length;
  expect(providersBefore > 0 && promptsBefore > 0 && catalogBefore > 0).toBe(true);

  // The host's row flows through the wired runner catalog to /models.
  expect((await get(app, "/v1/llm-runner/models")).json().models.some((m) => m.id === "host-model")).toBe(true);

  seedLlm(); // the double seed — JW calls seedLlm after installLlm already part-seeded

  expect((await get(app, "/v1/llm-providers")).json().providers.length).toBe(providersBefore);
  expect(stores.getPromptStore().list().length).toBe(promptsBefore);
  expect(stores.getModelCatalogStore().list().length).toBe(catalogBefore);

  // The registered feature reached the routing surface.
  const routing = await get(app, "/v1/ai/routing");
  expect(routing.statusCode).toBe(200);
  expect((routing.json().features || []).some((f) => f.key === "translate")).toBe(true);
});

test("bare_call_needs_no_feature_arguments", async () => {
  // The minimal contract is a SIGNATURE guarantee: featureCatalog and featurePrompts have
  // defaults. If someone makes them required again this fails at the call.
  const app = createServer({ typeBase: "https://example.test/errors/" });
  await installLlm(app, { db: h, dataDir: tmp });
  // And the empties actually REGISTERED (null would have left prior state in place).
  expect(seed.appFeatureCatalog()).toEqual([]);
  expect(seed.appFeaturePrompts()).toEqual({});
});

test("no_data_dir_warns_about_the_user_cache", async () => {
  // Without dataDir the runner caches to the user cache — legal, but it must say so: silence
  // here is how an uninstalled app strands multi-GB weights.
  const records = captureLogs("llm_runner.llm.install");
  const app = createServer({ typeBase: "https://example.test/errors/" });
  await installLlm(app, { db: h });
  expect(records.some((r) => r.levelno >= 30 && r.msg.includes("dataDir"))).toBe(true);
});

test("the_hosts_rows_are_the_whole_catalog", async () => {
  // Decision ④ (family parity batch 2026-08-05): the shared DEFAULT_CATALOG is EMPTY — a
  // model ladder is app data — so a host's modelCatalogExtra IS the whole catalog.
  expect(seed.cfg.DEFAULT_CATALOG).toEqual([]);
  const app = createServer({ typeBase: "https://example.test/errors/" });
  await installLlm(app, {
    db: h,
    dataDir: tmp,
    modelCatalogExtra: [hostRow({ id: "host-only-model", name: "Host Only", hf_repo: "example/host-only-GGUF" })],
  });
  seedLlm();
  const ids = new Set(stores.getModelCatalogStore().list().map((r) => r.id));
  // the host's rows must be the whole catalog
  expect([...ids]).toEqual(["host-only-model"]);
});

test("headless_boot_app_none_wires_everything_but_mounts_nothing", async () => {
  // app = null — the CLI door's boot (2026-08-02): storage, seeds registration, the ledger,
  // the runner-catalog wiring; no routes.
  await installLlm(null, { db: h, dataDir: tmp });
  seedLlm();

  expect(stores.getProviderStore().list().length).toBeGreaterThan(0); // seeded through the same path
  // Decision ④: the shared seed carries no models — a bare call gets an empty catalog.
  expect(stores.getModelCatalogStore().list().length).toBe(0);
  // The runner catalog is WIRED (the CLI's makeSend needs the stores AND the runner).
  expect(lifecycle.getService().catalogWired).toBe(true);
  expect(String(lifecycle.getService().cacheRoot)).toBe(pyPath(join(tmp, "ai-cache")));
});

test("measured_class_tunes_bind_to_the_HOSTS_id_for_the_same_gguf", async () => {
  // The most expensive knowledge in this package is a measured class tune, and it was
  // addressable only by model_id: an app that seeds the SAME GGUF under its own id inherited
  // nothing — silently. Measured 2026-08-03: the i18n app's `gemma-4-26b-a4b-qat-xl` IS
  // unsloth/gemma-4-26B-A4B-it-qat-GGUF @ UD-Q4_K_XL, byte-for-byte JustWrite's
  // `gemma-4-26b-a4b-qat`. Since decision ④ the tunes + identity are the HOST's registration
  // (classTunesSeed / classTuneIdentity) — this exercises that whole path.
  await installLlm(null, {
    db: h,
    dataDir: tmp,
    modelCatalogExtra: [
      {
        id: "gemma-4-26b-a4b-qat-xl",
        name: "Gemma 4 26B-A4B (QAT)",
        // the SAME artifact the registered tunes were measured on, under another id
        hf_repo: "unsloth/gemma-4-26B-A4B-it-qat-GGUF",
        quant: "UD-Q4_K_XL",
        total_params: "26B",
        type: "moe",
        min_vram_mb: 4096,
        min_ram_mb: 24576,
        tier: "low-vram-moe",
        license: "Apache-2.0",
        position: 0,
        quality_rank: 1,
        architecture: "gemma4",
        experts: 128,
      },
    ],
    classTunesSeed: [
      {
        model_id: "gemma-4-26b-a4b-qat",
        class_key: "dgpu-vram8|ram32",
        switches: {
          n_gpu_layers: "99",
          n_cpu_moe: "21",
          ctx_len: "32768",
          batch_size: "512",
          ubatch_size: "512",
          threads: "8",
          reasoning_budget: "1024",
        },
      },
    ],
    classTuneIdentity: {
      "gemma-4-26b-a4b-qat": { hf_repo: "unsloth/gemma-4-26B-A4B-it-qat-GGUF", quant: "UD-Q4_K_XL" },
    },
  });
  captureLogs("llm_runner.llm.seed");
  seedLlm();

  const rows = h.all(
    "select * from class_tunes where model_id = ? and class_key = ?",
    ["gemma-4-26b-a4b-qat-xl", "dgpu-vram8|ram32"],
    "class_tunes",
  );
  const got = Object.fromEntries(rows.map((r) => [r.flag_name, r.flag_value]));
  // the measured tune must bind to the id THIS catalog uses
  expect(Object.keys(got).length).toBeGreaterThan(0);
  // The two knobs that were actually missing on the user's box.
  expect(got.n_cpu_moe).toBe("21");
  expect(got.ctx_len).toBe("32768");
});

test("a_class_tune_that_can_bind_to_nothing_warns_and_is_retired", async () => {
  // Dead weight must announce itself — and then LEAVE. Pre-④ the shared seed pushed all 13
  // measured tunes into every adopter's DB and 6 sat orphaned. retireOrphanBuiltinClassTunes
  // removes exactly the unbindable BUILT-IN residue (a user's own config is built_in=false and
  // is never touched).
  await installLlm(null, {
    db: h,
    dataDir: tmp,
    modelCatalogExtra: [
      hostRow({ id: "something-else", name: "Unrelated", hf_repo: "example/unrelated-GGUF", license: "MIT" }),
    ],
  });
  // Simulate the pre-④ state: a seeded (built_in) tune for a model this catalog doesn't
  // carry + a USER's own (built_in=false) row for the same absent model.
  h.tx(() => {
    h.insert("class_tunes", {
      model_id: "not-in-this-catalog",
      class_key: "dgpu-vram8|ram32",
      flag_name: "ctx_len",
      flag_value: "32768",
      built_in: true,
    });
    h.insert("class_tunes", {
      model_id: "not-in-this-catalog",
      class_key: "igpu-mem32",
      flag_name: "ctx_len",
      flag_value: "16384",
      built_in: false,
    });
  });

  const records = captureLogs("llm_runner.llm.seed");
  seedLlm();
  // an unbindable tune must warn — silence reads as coverage
  expect(records.some((r) => r.levelno >= 30 && r.msg.includes("match no model in this catalog"))).toBe(true);

  const rows = h.all("select * from class_tunes where model_id = ?", ["not-in-this-catalog"], "class_tunes");
  const flags = rows.map((r) => [r.class_key, r.built_in]);
  // The seeded residue is gone; the user's own row survives untouched.
  expect(flags).toEqual([["igpu-mem32", false]]);
});
