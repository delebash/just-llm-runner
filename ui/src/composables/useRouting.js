// SPDX-License-Identifier: GPL-3.0-or-later
// useRouting — the shared routing document (default + per-job map + per-feature
// pins) load/save/mutations, so the "Routing by job" tab and the "Routing by
// feature" workbench don't each re-implement it (RULE #7: extract, don't copy).
// Each consumer calls useRouting() and gets its own instance; both tabs are
// v-if-mounted (never simultaneously), so per-instance state + reload-on-mount is
// correct. Mutations persist immediately via PUT /v1/ai/routing.
import { computed, ref } from "vue";

import { request } from "../client.js";

export function useRouting() {
  const routing = ref(null);     // {default, jobs:{jobId→{providerId,model}}, features:[…], pins:{key→{providerId,model}}}
  const providers = ref([]);
  const jobs = ref([]);          // [{id,label,description,…}]
  const featureJobs = ref({});   // featureKey → jobId

  const byId = computed(() => Object.fromEntries(providers.value.map((p) => [p.id, p])));
  const featMeta = computed(() => Object.fromEntries((routing.value?.features || []).map((f) => [f.key, f])));
  const providerName = (id) => byId.value[id]?.name || id || "—";
  const jobLabel = (id) => jobs.value.find((j) => j.id === id)?.label || id;

  // The features classified into a job (for a job card's "Used for:" line).
  function jobUsedFor(jobId) {
    const labels = (routing.value?.features || [])
      .filter((f) => (featureJobs.value[f.key] || "") === jobId)
      .map((f) => f.label);
    if (!labels.length) return "nothing yet";
    return labels.slice(0, 4).join(" · ") + (labels.length > 4 ? ` +${labels.length - 4} more` : "");
  }
  function pin(key) { return routing.value?.pins?.[key] || null; }

  async function loadRouting() {
    const [r, pl, jb, fj] = await Promise.all([
      request("/v1/ai/routing"), request("/v1/llm-providers"),
      request("/v1/ai/jobs"), request("/v1/ai/feature-jobs"),
    ]);
    routing.value = r;
    if (!routing.value.pins) routing.value.pins = {};
    if (!routing.value.jobs) routing.value.jobs = {};
    providers.value = pl.providers || [];
    jobs.value = jb.rows || [];
    featureJobs.value = Object.fromEntries((fj.rows || []).map((x) => [x.featureKey, x.jobId]));
  }
  async function reloadJobs() { jobs.value = (await request("/v1/ai/jobs")).rows || []; }
  async function reloadFeatureJobs() {
    const fj = await request("/v1/ai/feature-jobs");
    featureJobs.value = Object.fromEntries((fj.rows || []).map((x) => [x.featureKey, x.jobId]));
  }

  async function saveRouting() {
    const r = routing.value;
    routing.value = await request("/v1/ai/routing", {
      method: "PUT",
      body: { default: r.default, jobs: r.jobs || {}, pins: r.pins || {} },
    });
    if (!routing.value.pins) routing.value.pins = {};
    if (!routing.value.jobs) routing.value.jobs = {};
  }

  // A job's model (the routing unit). Empty → that job falls back to the Default LLM.
  function setJob(jobId, val) {
    const m = routing.value.jobs || (routing.value.jobs = {});
    if (!val || !val.providerId) delete m[jobId];
    else m[jobId] = { providerId: val.providerId, model: val.model || "" };
    saveRouting();
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
  // A per-feature/action explicit pin (overrides its job). Empty → inherit the job.
  function setPin(key, val) {
    const pins = routing.value.pins || (routing.value.pins = {});
    if (!val || !val.providerId) delete pins[key];
    else pins[key] = { providerId: val.providerId, model: val.model || "" };
    saveRouting();
  }
  // A feature's job classification (separate endpoint), persisted immediately.
  async function setFeatureJob(feature, jobId) {
    if (!jobId) await request(`/v1/ai/feature-jobs/${encodeURIComponent(feature)}`, { method: "DELETE" });
    else await request("/v1/ai/feature-jobs", { method: "PUT", body: { featureKey: feature, jobId } });
    await reloadFeatureJobs();
  }

  return {
    routing, providers, jobs, featureJobs,
    byId, featMeta, providerName, jobLabel, jobUsedFor, pin,
    loadRouting, reloadJobs, reloadFeatureJobs, saveRouting,
    setJob, setDefaultLlm, setDefaultEmbedding, setPin, setFeatureJob,
  };
}
