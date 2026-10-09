// SPDX-License-Identifier: MIT
// The shared LLM stack WITHOUT the bundled runner — for a server that only calls online providers:
// the phone's in-app server (docs/plans/2026-10-08-the-phone.md; JustWrite's TASKS, Sync decision
// 8: "the phone runs the book, its images and versions, sync, and online AI providers"). The same
// setup as installLlm (install_core.js) and the routers a window uses with online providers: the
// providers and their keys, routing, presets, prompts and feature runs (the AI stream), usage,
// pricing, reasoning maps, model-list rules, the engine config the window reads at start. Not the
// runner's: no hardware probe, no model catalog or downloads, no tunes, no processes. The runner's
// modules aren't imported here — only as far as the routers' own imports reach them, never run.
import * as api from "./api.js";
import { makeEmbedTemplatesRouter } from "./embed_templates_api.js";
import { prepareLlm } from "./install_core.js";
import { makeKnobCatalogRouter } from "./knob_catalog_api.js";
import { makeModelListRulesRouter } from "./model_list_rules_api.js";
import { makePresetsRouter } from "./presets_api.js";
import { makePricingRouter } from "./pricing_api.js";
import { makeFeatureRouter, makePromptRouter } from "./prompts.js";
import { makeProviderRouter } from "./provider_api.js";
import { makeReasoningMapRouter } from "./reasoning_map_api.js";
import { makeRoutingRouter } from "./routing_api.js";
import { makeRunnerConfigRouter } from "./runner_config_api.js";
import * as seed from "./seed.js";
import * as stores from "./stores.js";
import { makeSwitchPresetsRouter } from "./switch_presets_api.js";
import { makeTestSamplesRouter } from "./test_samples_api.js";

/**
 * installLlm's options (the app's feature data, `allowKeyReveal`) minus the runner's
 * (`dataDir`, `cacheRoot`, `runnerCatalog`, `product`, `modelTunesSeed`).
 */
export async function installCloudLlm(app, { db: handle, allowKeyReveal = false, ...data } = {}) {
  if (!handle) throw new Error("installCloudLlm: pass db (the host's database handle)");
  const { featurePrompts = {} } = data;
  const config = prepareLlm(handle, { ...data, modelTunesSeed: [], hwKeyFn: () => "" });
  app.route("/", api.router());
  app.route("/", makeProviderRouter(stores.getProviderStore, allowKeyReveal));
  app.route("/", makePromptRouter(stores.getPromptStore, featurePrompts));
  app.route("/", makeFeatureRouter(stores.getPromptStore, config));
  app.route("/", makeRoutingRouter(stores.getRoutingStore, seed.appFeatureCatalog));
  app.route(
    "/",
    makePresetsRouter(
      stores.getEnginePresetStore,
      stores.getDefaultPresetId,
      stores.setDefaultPresetId,
      stores.getFeaturePresetRefStore,
      seed.resetRoutingToFactory,
      seed.resetPresetToFactory,
    ),
  );
  app.route("/", makeKnobCatalogRouter(stores.listKnobCatalog));
  app.route("/", makeTestSamplesRouter(stores.getTestSampleStore));
  app.route("/", makePricingRouter(stores.getPricingStore));
  app.route("/", makeReasoningMapRouter(stores.getReasoningMapStore));
  app.route("/", makeEmbedTemplatesRouter(stores.getEmbedTemplateStore));
  api.setEmbedTemplateResolver((mid) => stores.getEmbedTemplateStore().get(mid));
  app.route("/", makeModelListRulesRouter(stores.getModelListRules, stores.setModelListRules, stores.resetModelListRules));
  api.setModelListRulesResolver(() => {
    const d = stores.getModelListRules();
    return Object.hasOwn(d, "rules") ? d.rules : {};
  });
  app.route("/", makeRunnerConfigRouter(stores.getRunnerConfigStore));
  app.route("/", makeSwitchPresetsRouter(stores.getSwitchPresetStore));
}
