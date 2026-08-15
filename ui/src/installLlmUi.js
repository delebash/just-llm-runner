// SPDX-License-Identifier: MIT
// The UI twin of the server's `install_llm` — one call that wires the whole shared
// LLM front end into a host app.
//
// WHY IT EXISTS. The Python half has had one installer since 2026-08-01; the UI half
// had none, and that asymmetry is not cosmetic — it is where every silent breakage
// landed. Measured on just_ai_i18n_docgen (2026-08-03): four separate `configure*()`
// calls, `<Toast>` and `<AppDialog>` mounted by hand, and a nav row that had to carry
// an exact `data-panel-toggle` attribute. Each was a step someone had to KNOW about,
// and forgetting one failed quietly:
//   • `<AppDialog/>` unmounted → `confirmDialog()`'s promise never settles, so every
//     confirmed action in the app was a button that did nothing at all.
//   • `configureLlmUi({})` with no baseUrl → defaults to `window.location.origin`,
//     which in the production webview is `tauri.localhost`, so every kit LLM view
//     rendered EMPTY — in production only.
//   • the missing `data-panel-toggle` → the AI-tasks panel opened and instantly
//     closed, because the click that opened it counted as the outside-click.
//
// So this installer's job is not to save typing. It is to make those three states
// unreachable: ONE base URL feeds both transports, the hosts arrive as a single
// component, and the nav row's required attribute comes from the composable.

import { configureExternal, isTauriShell } from "./common/services/external.js";
import { configureServerApi, makeOriginAwareResolver } from "./common/services/serverApi.js";
import { configureLlmUi } from "./client.js";
import { configureQuickSetupCopy } from "./common/services/quickSetupCopy.js";
import { registerFeaturePanels, registerLabAdapters, registerSectionedFeatures } from "./services/labAdapters.js";
import LlmUiHosts from "./components/LlmUiHosts.vue";

// What this app's LLM stack can do. Declared by the host, read by the kit — an app
// that has no embedding features says so ONCE here, instead of switching off each
// surface that would have shown one.
const _capabilities = { embeddings: true };

/** What the host declared. NOTHING IN THE KIT READS THIS YET — today `embeddings:
 *  false` is honoured by mapping it onto the catalog's `showEmbedding` flag (see
 *  `_copyFor`), which hides the slot while model rows still ship `embedPlacement` /
 *  `embedLeftoverMb` for an app that has no embeddings. This accessor is the seam the
 *  rest of that job hangs off: a kit surface should ask here rather than take another
 *  copy flag. Stated plainly so nobody reads the export as a finished contract. */
export function llmUiCapabilities() {
  return { ..._capabilities };
}

/** A desktop shell that wires no opener at all: `external.js` still falls back to
 *  window.open, but the Tauri webview swallows that, so every About/help link in
 *  the app is silently dead. Say so instead of pretending. (The plugin stays the
 *  APP's dependency — importing `@tauri-apps/plugin-opener` in the kit breaks
 *  every non-Tauri consumer's build, measured 2026-08-04.)
 *
 *  The second copy of the "are we in Tauri?" test lived here until 2026-08-14 and
 *  tested something else (protocol/hostname); external.js owns the one test now. */
function warnNoOpener() {
  if (isTauriShell()) {
    console.warn(
      "[llm-ui] external links and Open folder will do nothing in this webview: pass " +
      'installLlmUi(app, { external: { open: openUrl, openPath } }) from "@tauri-apps/plugin-opener".',
    );
  }
}

/**
 * Wire the shared LLM UI into `app`.
 *
 * @param app                Vue application instance
 * @param opts.devPorts      Vite dev ports that must NOT be treated as same-origin
 * @param opts.fallbackBase  loopback base for dev + the Tauri webview
 * @param opts.serverOverrideKey localStorage key that, when set, points the app at
 *                           a remote server and beats the origin-aware default
 * @param opts.resolveBase   supply a resolver instead of devPorts/fallbackBase
 * @param opts.catalogCopy   this app's words on the shared model-catalog surface
 * @param opts.quickSetupCopy this app's VOICE on the shared Quick Setup wizard
 *                           (band caption · confirm title · model hint · bar roles ·
 *                           done body · onApplied hook) — canon words stay in the
 *                           labels store, never here
 * @param opts.capabilities  e.g. `{ embeddings: false }`
 * @param opts.labAdapters   per-FEATURE Lab adapters `{ featureKey: { run, render,
 *                           configExtra } }` — the app's real pipeline behind that
 *                           feature's Lab columns (see services/labAdapters.js)
 * @param opts.sectionedFeatures array of FEATURE keys whose prompt rows compose
 *                           into ONE call (the `<key>.base` row is the template,
 *                           its `{{section}}` markers fill from the other rows):
 *                           one nav card, every text edited on the pane, the Lab
 *                           over the app's prompt-preview (decided 2026-08-08 —
 *                           retires the 2026-08-06 pieces concept)
 * @param opts.featurePanels `{ featureKey: Component }` — an app control mounted on
 *                           that feature's routing pane (JV's reading-style dial)
 * @param opts.external      your openers, straight from `@tauri-apps/plugin-opener`:
 *                           `{ open: openUrl, openPath }` — the identical line in
 *                           all three apps. `(url) => …` is the older links-only
 *                           form; `false` skips wiring. Both are gated on being in
 *                           a Tauri webview by `common/services/external.js`, so a
 *                           browser keeps window.open for links and reports "can't"
 *                           for folders rather than firing a dead menu item.
 */
export function installLlmUi(app, {
  devPorts = [],
  fallbackBase = "",
  serverOverrideKey = "",
  resolveBase,
  catalogCopy,
  quickSetupCopy,
  capabilities,
  labAdapters,
  sectionedFeatures,
  featurePanels,
  external = true,
} = {}) {
  const resolve = resolveBase
    || makeOriginAwareResolver({ devPorts, fallback: fallbackBase, overrideKey: serverOverrideKey });

  // THE invariant: the app transport and the kit's LLM views resolve to the SAME
  // base. They were two calls, and the day they disagreed the kit views 404'd into
  // empty lists in the production webview only. One resolver, called once, both fed.
  configureServerApi({ resolveBase: resolve });
  const base = resolve();
  if (!base && typeof window !== "undefined" && window.location?.hostname === "tauri.localhost") {
    // Loud in dev, because the silent version of this shipped: no base inside the
    // webview means every /v1 call goes to tauri.localhost and quietly returns nothing.
    console.warn(
      "[llm-ui] no base URL resolved inside the Tauri webview — pass fallbackBase " +
      "(e.g. http://127.0.0.1:<your server port>) or every /v1 call will 404 into an empty view.",
    );
  }
  configureLlmUi({ baseUrl: base, catalogCopy: _copyFor(catalogCopy, capabilities) });
  if (quickSetupCopy) configureQuickSetupCopy(quickSetupCopy);

  if (capabilities) Object.assign(_capabilities, capabilities);
  if (labAdapters) registerLabAdapters(labAdapters);
  if (sectionedFeatures) registerSectionedFeatures(sectionedFeatures);
  if (featurePanels) registerFeaturePanels(featurePanels);
  if (external !== false) {
    // `{ open, openPath }` is the shape all three apps pass (both straight from
    // @tauri-apps/plugin-opener). A bare function is the older links-only form and
    // still works. external.js gates both on being in a Tauri webview, so nothing
    // here has to ask what kind of host this is.
    const open = typeof external === "function" ? external : (external && external.open) || null;
    const openPath = (typeof external === "object" && external && external.openPath) || null;
    if (!open) warnNoOpener();
    configureExternal({ open, openPath });
  }

  // Registered, not imported: an app that forgets `<LlmUiHosts />` in its shell has
  // one thing missing rather than three, and that one thing is named after the job.
  app.component("LlmUiHosts", LlmUiHosts);
  return { resolveBase: resolve, base };
}

/** Capabilities are the host's vocabulary; `catalogCopy` flags are the kit's. Declaring
 *  `embeddings: false` should not ALSO require knowing that the catalog calls it
 *  `showEmbedding` — an explicit copy flag still wins if a host sets both.
 *  NOTE (2026-08-04): this covers the catalog's embedding slot. Model rows still ship
 *  `embedPlacement`/`embedLeftoverMb` regardless; honouring the capability all the way
 *  down is the rest of that job. */
function _copyFor(catalogCopy, capabilities) {
  if (!capabilities || capabilities.embeddings !== false) return catalogCopy;
  return { showEmbedding: false, ...(catalogCopy || {}) };
}
