// SPDX-License-Identifier: MIT
// The shared LLM stack's setup on the app's database — steps 1–4 of installLlm (install.js),
// shared with installCloudLlm (install_cloud.js, the phone's in-app server): the shared tables
// and their storage, the app's feature DATA for the seeder, the extra catalog rows, the usage
// ledger, and the dispatch-config builder. It imports none of the bundled runner, so a server
// with no runner (a web worker) can use it.
import { buildLlmConfig } from "./config_builder.js";
import * as db from "./db.js";
import * as seed from "./seed.js";
import { setLedger } from "./usage.js";
import { DbUsageSink } from "./usage_sink.js";

/**
 * Prepare the stack on `handle` (the kit's database handle). `hwKeyFn` is this machine's tuning
 * key (installLlm's hardware detection; a server with no runner passes `() => ""`). Returns the
 * dispatch-config builder the feature router takes.
 */
export function prepareLlm(
  handle,
  {
    featureCatalog = [],
    featurePrompts = {},
    enginePresets = null,
    featurePresets = null,
    defaultPresetId = "",
    modelCatalogExtra = [],
    modelTunesSeed = [],
    classTunesSeed = [],
    classTuneIdentity = {},
    embedTemplates = [],
    testSamples = null,
    featurePromptHeals = null,
    preferLocalFeatures = null,
    hwKeyFn,
  },
) {
  // 1. storage — the app's own database backs every shared table.
  db.createAll(handle);
  db.configureStorage(handle);
  // 2. register the app's feature DATA (the only per-app inputs).
  seed.configureAppSeed({
    featureCatalog: [...(featureCatalog || [])],
    featurePrompts: { ...(featurePrompts || {}) },
    enginePresets,
    featurePresets,
    defaultPresetId,
    modelCatalogExtra: [...(modelCatalogExtra || [])],
    modelTunesSeed: [...(modelTunesSeed || [])],
    classTunesSeed: [...(classTunesSeed || [])],
    classTuneIdentity: { ...(classTuneIdentity || {}) },
    embedTemplates: [...(embedTemplates || [])],
    hwKeyFn,
    testSamples,
    featurePromptHeals,
  });
  // 2b. the boot-order guarantee: the app's extra catalog rows + this box's tune seed exist
  // the moment the routers mount, before the host's own seedLlm call runs.
  if (modelCatalogExtra?.length || modelTunesSeed?.length) {
    handle.tx(() => {
      if (modelCatalogExtra?.length) seed.seedExtraCatalog(handle, modelCatalogExtra);
      if (modelTunesSeed?.length) seed.seedModelTunesIfMissing(handle, hwKeyFn(), modelTunesSeed);
    });
  }
  // 3. the DB-backed usage ledger.
  setLedger(new DbUsageSink());
  // 4. the dispatch-config builder for the feature-execution router.
  const plf = new Set(preferLocalFeatures || []);
  return () => buildLlmConfig(plf);
}
