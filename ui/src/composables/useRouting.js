// SPDX-License-Identifier: GPL-3.0-or-later
// useRouting — the shared routing document (default LLM/embedding + per-feature
// pins) load/save/mutations, so the routing surfaces don't each re-implement it
// (RULE #7: extract, don't copy). Each consumer calls useRouting() and gets its
// own instance; reload-on-mount is correct. Mutations persist immediately via
// PUT /v1/ai/routing.
import { computed, ref } from "vue";

import { request } from "../client.js";

export function useRouting() {
  const routing = ref(null);     // {default, features:[…], pins:{key→{providerId,model}}}
  const providers = ref([]);

  const byId = computed(() => Object.fromEntries(providers.value.map((p) => [p.id, p])));
  const featMeta = computed(() => Object.fromEntries((routing.value?.features || []).map((f) => [f.key, f])));
  const providerName = (id) => byId.value[id]?.name || id || "—";
  function pin(key) { return routing.value?.pins?.[key] || null; }

  async function loadRouting() {
    const [r, pl] = await Promise.all([
      request("/v1/ai/routing"), request("/v1/llm-providers"),
    ]);
    routing.value = r;
    if (!routing.value.pins) routing.value.pins = {};
    providers.value = pl.providers || [];
  }

  async function saveRouting() {
    const r = routing.value;
    routing.value = await request("/v1/ai/routing", {
      method: "PUT",
      body: { default: r.default, pins: r.pins || {} },
    });
    if (!routing.value.pins) routing.value.pins = {};
  }

  function setDefaultLlm(val) {
    routing.value.default.llmId = val?.providerId || "";
    routing.value.default.model = val?.model || "";
    saveRouting();
  }
  function setDefaultEmbedding(val) {
    routing.value.default.embeddingId = val?.providerId || "";
    routing.value.default.embeddingModel = val?.model || "";
    saveRouting();
  }
  // A per-feature/action explicit pin. Empty → no override (falls through to the
  // feature's preset, then the global default).
  function setPin(key, val) {
    const pins = routing.value.pins || (routing.value.pins = {});
    if (!val || !val.providerId) delete pins[key];
    else pins[key] = { providerId: val.providerId, model: val.model || "" };
    saveRouting();
  }

  return {
    routing, providers,
    byId, featMeta, providerName, pin,
    loadRouting, saveRouting,
    setDefaultLlm, setDefaultEmbedding, setPin,
  };
}
