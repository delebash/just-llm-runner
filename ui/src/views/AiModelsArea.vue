<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The shared "AI / Models" area (from the shared-ai-models mock) — ONE UI for
// both apps: Providers & models · Features · Usage, with a hardware strip. Built
// in plain-JS Vue on the shared client; the host mounts it at a top-level route
// and passes its appName. Wired to the real shared endpoints (/v1/llm-providers*,
// /v1/llm-runner/hardware, /v1/ai-usage). The provider card + rows mirror
// JustWrite's polished Settings → AI engines (outer card, icon, name, URL on its
// own line, model + key on the next, status + Test + Edit). The Features routing
// table + the per-provider local-model/Fit section are the next chunks.
import { computed, onMounted, ref } from "vue";

import UiButton from "../common/components/UiButton.vue";
import FeatureWorkbench from "./FeatureWorkbench.vue";
import TaskKinds from "./TaskKinds.vue";
import ProviderForm from "./ProviderForm.vue";
import QuickSetup from "./QuickSetup.vue";
import RecommendationGrid from "./RecommendationGrid.vue";
import LuModelCatalog from "../components/LuModelCatalog.vue";
import RecommendationsEditor from "./RecommendationsEditor.vue";
import PricingEditor from "./PricingEditor.vue";
import { activeAiTab } from "../common/services/labHandoff.js";
import { request } from "../client.js";

// Host-contributed tab: an app passes a label + fills the #app-tab slot with its
// own AI-domain settings (e.g. JustWrite's "Writing AI" — voice canon, RAG
// auto-rebuild, variations). Keeps ALL AI settings in this one shared area while
// each app's specifics stay app-side. Empty label → no extra tab.
const props = defineProps({
  appTabLabel: { type: String, default: "" },
  // Host runner forwarded to the Feature Workbench test panel (streaming +
  // cancel + the app's batch AI list). See FeatureWorkbench `runStream`.
  runStream: { type: Function, default: null },
});

// The subnav tab is backed by the SHARED `activeAiTab` (labHandoff.js) so a Tune→Tasks
// handoff fired from a modal under the Models tab can switch us to "tasks". A computed
// get/set (not the raw imported ref) so the template's `tab = 'x'` writes unambiguously
// hit `.value`. Side effect (benign): the tab now persists across AiModelsArea remounts.
const tab = computed({ get: () => activeAiTab.value, set: (v) => { activeAiTab.value = v; } });
const providers = ref([]);
const hardware = ref(null);
const usage = ref(null);
const loading = ref(true);
const error = ref("");
const editingId = ref(null); // "new" | provider id | null
const status = ref({}); // provider id -> "checking" | "ok" | "fail"

// Group by the provider's stored Local/Online choice (set in the form), not a
// URL guess — a local provider at a LAN IP still groups under Local.
const localProviders = computed(() => providers.value.filter((p) => p.local));
const cloudProviders = computed(() => providers.value.filter((p) => !p.local));

const hwLabel = computed(() => {
  const h = hardware.value;
  if (!h) return null;
  const gpu = h.gpus && h.gpus[0];
  const accel = Object.entries(h.runtimes || {}).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(" / ");
  return {
    os: h.os || "—",
    cpu: h.cpuCores ? `${h.cpuCores} threads` : "—",
    gpu: gpu ? gpu.name : "CPU only",
    vram: gpu?.vramMb ? `${(gpu.vramMb / 1024).toFixed(0)} GB` : null,
    ram: h.ramMb ? `${(h.ramMb / 1024).toFixed(0)} GB` : "—",
    accel: accel || "—",
  };
});

const fmtUsd = (n) => (n ? `$${Number(n).toFixed(n < 1 ? 4 : 2)}` : "$0");
// The full ledger view (rollup + by-feature + by-provider) from /v1/ai-usage —
// cost is server-computed (the host sink prices each row), so this renders
// identically in any app that mounts the area. Null until something's recorded.
const usageView = computed(() => {
  const s = usage.value;
  if (!s || !s.total_calls) return null;
  const shape = (obj) => Object.entries(obj || {}).map(([key, v]) => ({
    key, calls: v.calls || 0, prompt: v.prompt_tokens || 0,
    completion: v.completion_tokens || 0, cost: v.cost || 0,
  })).sort((a, b) => b.calls - a.calls);
  const prompt = s.total_prompt_tokens || 0;
  const completion = s.total_completion_tokens || 0;
  return {
    calls: s.total_calls || 0, prompt, completion, tokens: prompt + completion,
    cost: s.total_cost || 0, feat: shape(s.by_feature), prov: shape(s.by_provider),
  };
});
async function clearUsage() {
  try { await request("/v1/ai-usage", { method: "DELETE" }); } catch { /* ignore */ }
  await loadUsage();
}

async function loadProviders() {
  const r = await request("/v1/llm-providers");
  providers.value = r.providers || [];
}
async function loadHardware() {
  try { hardware.value = await request("/v1/llm-runner/hardware"); } catch { hardware.value = null; }
}
async function loadUsage() {
  try { usage.value = await request("/v1/ai-usage"); } catch { usage.value = null; }
}
async function loadAll() {
  loading.value = true; error.value = "";
  try {
    await loadProviders();
    await Promise.all([loadHardware(), loadUsage()]);
  } catch (e) {
    error.value = `Couldn't load: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

function capList(p) {
  return p.embeddingModel ? ["LLM", "EMBED"] : ["LLM"];
}
async function testProvider(p) {
  status.value = { ...status.value, [p.id]: "checking" };
  try {
    const r = await request(`/v1/llm-providers/${encodeURIComponent(p.id)}/ping`, { method: "POST" });
    status.value = { ...status.value, [p.id]: r.ok ? "ok" : "fail" };
  } catch {
    status.value = { ...status.value, [p.id]: "fail" };
  }
}
const STATUS_LABEL = { checking: "Checking…", ok: "Connected", fail: "Failed" };
const STATUS_COLOR = { checking: "var(--gold, #b08a3e)", ok: "var(--success, #3a7d63)", fail: "var(--danger)" };
const statusLabel = (id) => STATUS_LABEL[status.value[id]] || "Not checked";
const statusColor = (id) => STATUS_COLOR[status.value[id]] || "var(--border-strong)";

function onSaved() { editingId.value = null; loadProviders(); }

onMounted(loadAll);
</script>

<template>
  <div class="lu-area">
    <p class="lu-muted lu-lede">Connect AI providers — free local or metered cloud — and manage which models power each feature.</p>

    <!-- One-line hardware strip (OS · CPU · Memory · GPU · Acceleration). -->
    <div v-if="hwLabel" class="lu-hwstrip">
      <div class="lu-hwstat"><span class="lu-hwstat-k">OS</span><span class="lu-hwstat-v">{{ hwLabel.os }}</span></div>
      <div class="lu-hwstat"><span class="lu-hwstat-k">CPU</span><span class="lu-hwstat-v">{{ hwLabel.cpu }}</span></div>
      <div class="lu-hwstat"><span class="lu-hwstat-k">Memory</span><span class="lu-hwstat-v">{{ hwLabel.ram }}</span></div>
      <div class="lu-hwstat"><span class="lu-hwstat-k">GPU</span><span class="lu-hwstat-v">{{ hwLabel.gpu }}<span v-if="hwLabel.vram" class="lu-hwstat-sub"> · {{ hwLabel.vram }} VRAM</span></span></div>
      <div class="lu-hwstat"><span class="lu-hwstat-k">Acceleration</span><span class="lu-hwstat-v">{{ hwLabel.accel }}</span></div>
    </div>

    <nav class="lu-subnav">
      <a :class="{ on: tab === 'providers' }" @click="tab = 'providers'">Providers &amp; models</a>
      <a :class="{ on: tab === 'tasks' }" @click="tab = 'tasks'">Tasks</a>
      <a :class="{ on: tab === 'features' }" @click="tab = 'features'">Routing by feature</a>
      <a :class="{ on: tab === 'models' }" @click="tab = 'models'">Models</a>
      <a :class="{ on: tab === 'usage' }" @click="tab = 'usage'">Usage</a>
      <a v-if="props.appTabLabel" :class="{ on: tab === 'app' }" @click="tab = 'app'">{{ props.appTabLabel }}</a>
    </nav>

    <div v-if="error" class="lu-error" style="margin-top:14px">{{ error }}</div>

    <!-- ── Providers & models ── -->
    <section v-show="tab === 'providers'" class="lu-tab">
      <QuickSetup class="lu-qs-wrap" @changed="loadProviders" />
      <div class="lu-providers">
        <div class="lu-pcard-head">
          <span class="lu-pcard-title">Providers</span>
          <span class="lu-muted lu-pcard-count">{{ providers.length }} configured</span>
          <UiButton intent="primary" size="small" @click="editingId = editingId === 'new' ? null : 'new'">
            <template #icon><span class="lu-plus">＋</span></template>Add provider
          </UiButton>
        </div>

        <ProviderForm v-if="editingId === 'new'" class="lu-newform" @saved="onSaved" @cancel="editingId = null" />

        <div class="lu-eyebrow-row">
          <span class="lu-eyebrow">Local · free</span>
          <span class="lu-muted lu-eyebrow-sub">Runs on your machine. No API key, no per-token cost — your prose never leaves the box.</span>
        </div>
        <template v-for="p in localProviders" :key="p.id">
          <ProviderForm v-if="editingId === p.id" :provider="p" @saved="onSaved" @deleted="onSaved" @cancel="editingId = null" />
          <div v-else class="lu-prow">
            <span class="lu-prow-ic">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" /><path d="M6.2 1.5v2.7M9.8 1.5v2.7M6.2 11.8v2.7M9.8 11.8v2.7M1.5 6.2h2.7M1.5 9.8h2.7M11.8 6.2h2.7M11.8 9.8h2.7" stroke-linecap="round" /></svg>
            </span>
            <div class="lu-prow-info">
              <div class="lu-prow-name"><b>{{ p.name || p.id }}</b><span v-for="c in capList(p)" :key="c" class="lu-cap">{{ c }}</span></div>
              <div class="lu-prow-url">{{ p.baseUrl }}</div>
              <div class="lu-prow-meta">
                <template v-if="p.defaultModel">chat: <b>{{ p.defaultModel }}</b> · </template>
                <template v-if="p.embeddingModel">embed: <b>{{ p.embeddingModel }}</b> · </template>
                {{ p.hasApiKey ? "API key set" : "no key" }}
              </div>
            </div>
            <span class="lu-prow-status"><span class="lu-sdot" :style="{ background: statusColor(p.id) }" />{{ statusLabel(p.id) }}</span>
            <UiButton intent="secondary" size="small" @click="testProvider(p)">Test</UiButton>
            <UiButton intent="primary" size="small" @click="editingId = p.id">Edit</UiButton>
          </div>
        </template>
        <div v-if="!loading && !localProviders.length" class="lu-pempty">No local providers yet. Click “Add provider” and point at <span class="lu-mono">http://localhost:…</span></div>

        <div class="lu-eyebrow-row lu-eyebrow-cloud">
          <span class="lu-eyebrow">Cloud · metered</span>
          <span class="lu-muted lu-eyebrow-sub">Your account — API key + URL. Pay per token; every call leaves the machine.</span>
        </div>
        <template v-for="p in cloudProviders" :key="p.id">
          <ProviderForm v-if="editingId === p.id" :provider="p" @saved="onSaved" @deleted="onSaved" @cancel="editingId = null" />
          <div v-else class="lu-prow">
            <span class="lu-prow-ic">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.4l1.4 4.1 4.2 1.5-4.2 1.5L8 12.6 6.6 8.5 2.4 7l4.2-1.5z" /></svg>
            </span>
            <div class="lu-prow-info">
              <div class="lu-prow-name"><b>{{ p.name || p.id }}</b><span v-for="c in capList(p)" :key="c" class="lu-cap">{{ c }}</span></div>
              <div class="lu-prow-url">{{ p.baseUrl }}</div>
              <div class="lu-prow-meta">
                <template v-if="p.defaultModel">chat: <b>{{ p.defaultModel }}</b> · </template>
                <template v-if="p.embeddingModel">embed: <b>{{ p.embeddingModel }}</b> · </template>
                {{ p.hasApiKey ? "API key set" : "no key" }}
              </div>
            </div>
            <span class="lu-prow-status"><span class="lu-sdot" :style="{ background: statusColor(p.id) }" />{{ statusLabel(p.id) }}</span>
            <UiButton intent="secondary" size="small" @click="testProvider(p)">Test</UiButton>
            <UiButton intent="primary" size="small" @click="editingId = p.id">Edit</UiButton>
          </div>
        </template>
        <div v-if="!loading && !cloudProviders.length" class="lu-pempty">No cloud providers. Click “Add provider” and paste a key from OpenAI / Anthropic / OpenRouter.</div>
      </div>
    </section>

    <!-- ── Tasks — create / test / assign the LLM-work tasks + their engine presets. ── -->
    <section v-show="tab === 'tasks'" class="lu-tab lu-tab-fill">
      <TaskKinds v-if="tab === 'tasks'" />
    </section>

    <!-- ── Routing by feature — the Feature Workbench: per-feature task + which
         engine preset it runs (model/switches/params live in the preset). ── -->
    <section v-show="tab === 'features'" class="lu-tab lu-tab-fill">
      <FeatureWorkbench v-if="tab === 'features'" :run-stream="props.runStream" />
    </section>

    <!-- ── Models — the unified surface (Phase 4): the per-hardware recommendation grid
         (discover → download → load → tune) + the full catalog "Manage all models"
         (Add-your-own-GGUF · edit · delete · reset), + the advanced recommendations
         editor under a disclosure. Both the grid and the catalog share one live model
         status (useRunnerModels). ── -->
    <section v-show="tab === 'models'" class="lu-tab">
      <template v-if="tab === 'models'">
        <RecommendationGrid />
        <div class="lu-models-manage">
          <div class="lu-models-h">Manage all models</div>
          <LuModelCatalog />
        </div>
        <details class="lu-adv-recs">
          <summary>Advanced: edit recommendations</summary>
          <RecommendationsEditor />
        </details>
      </template>
    </section>

    <!-- ── Usage — full ledger: rollup + by-feature + by-provider + reset ── -->
    <section v-show="tab === 'usage'" class="lu-tab">
      <template v-if="usageView">
        <div class="lu-usagehead">
          <span class="lu-pcard-title">Usage</span>
          <span class="lu-muted lu-usagesub">Tokens + estimated cost across every AI call. Local providers are recorded at $0.</span>
          <UiButton intent="ghost" size="small" @click="clearUsage">Reset ledger</UiButton>
        </div>
        <div class="lu-usage">
          <div class="lu-card lu-ucard"><div class="lu-uval">{{ usageView.calls.toLocaleString() }}</div><div class="lu-ulabel">calls</div></div>
          <div class="lu-card lu-ucard"><div class="lu-uval">{{ usageView.tokens.toLocaleString() }}</div><div class="lu-ulabel">tokens</div></div>
          <div class="lu-card lu-ucard"><div class="lu-uval">{{ usageView.prompt.toLocaleString() }}</div><div class="lu-ulabel">prompt</div></div>
          <div class="lu-card lu-ucard"><div class="lu-uval">{{ usageView.completion.toLocaleString() }}</div><div class="lu-ulabel">completion</div></div>
          <div class="lu-card lu-ucard"><div class="lu-uval">{{ fmtUsd(usageView.cost) }}</div><div class="lu-ulabel">est. cost</div></div>
        </div>
        <div class="lu-usage-section">
          <div class="lu-usage-h">By feature</div>
          <table class="lu-utable">
            <thead><tr><th>Feature</th><th>Calls</th><th>Prompt</th><th>Completion</th><th>Cost</th></tr></thead>
            <tbody>
              <tr v-for="f in usageView.feat" :key="f.key">
                <td>{{ f.key }}</td><td>{{ f.calls.toLocaleString() }}</td><td>{{ f.prompt.toLocaleString() }}</td><td>{{ f.completion.toLocaleString() }}</td><td>{{ fmtUsd(f.cost) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="lu-usage-section">
          <div class="lu-usage-h">By provider</div>
          <table class="lu-utable">
            <thead><tr><th>Provider</th><th>Calls</th><th>Prompt</th><th>Completion</th><th>Cost</th></tr></thead>
            <tbody>
              <tr v-for="p in usageView.prov" :key="p.key">
                <td>{{ p.key }}</td><td>{{ p.calls.toLocaleString() }}</td><td>{{ p.prompt.toLocaleString() }}</td><td>{{ p.completion.toLocaleString() }}</td><td>{{ fmtUsd(p.cost) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <div v-else class="lu-card lu-usage-empty lu-muted">No usage recorded yet.</div>
      <PricingEditor v-if="tab === 'usage'" />
    </section>

    <!-- ── App-contributed tab (host fills #app-tab; e.g. JW "Writing AI") ── -->
    <section v-if="props.appTabLabel" v-show="tab === 'app'" class="lu-tab">
      <slot name="app-tab" />
    </section>
  </div>
</template>

<style scoped>
/* Full width — the host card frames it; no inner cap (matches JV's settings). */
.lu-area { width: 100%; flex: 1; display: flex; flex-direction: column; min-height: 0; }
.lu-h1 { font-size: 22px; font-weight: 600; margin: 0; color: var(--ink); }
.lu-lede { font-size: 13px; margin: 4px 0 0; }
/* One-line hardware strip — labelled stat blocks (OS · CPU · Memory · GPU · Accel),
   stacked label-over-value, in a wrapping row (matches JV's settings strip). */
.lu-hwstrip { display: flex; flex-wrap: wrap; gap: 8px 40px; align-items: baseline; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 18px; margin-top: 12px; }
.lu-hwstat { display: flex; flex-direction: column; gap: 2px; }
.lu-hwstat-k { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; }
.lu-hwstat-v { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.lu-hwstat-sub { color: var(--muted); font-weight: 500; }

/* Sticky tab strip — stays put while a long providers/features list scrolls
   under it. var(--surface) backing matches the host card so rows pass cleanly
   beneath; the pseudo-element bleeds the bg over the host's scroll padding so
   nothing peeks above the bar. */
.lu-subnav { display: flex; gap: 4px; margin-top: 22px; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 5; background: var(--surface); }
/* Cover the host card's scroll padding above the stuck bar so rows don't peek
   through. Height == the subnav's top margin so it fills that gap exactly when
   unstuck (over the same surface bg → invisible) and the padding band when stuck. */
.lu-subnav::before { content: ""; position: absolute; left: 0; right: 0; top: -22px; height: 22px; background: var(--surface); }
.lu-subnav a { padding: 11px 16px; font-size: 12.5px; color: var(--ink-2); border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; font-weight: 600; }
.lu-subnav a.on { color: var(--ink); border-bottom-color: var(--accent); }
.lu-tab { padding-top: 14px; flex: 1; min-height: 0; overflow-y: auto; }
/* Routing-by-feature fills its height (its own nav + content panes scroll); it
   does not scroll as a whole. */
.lu-tab.lu-tab-fill { overflow: hidden; display: flex; flex-direction: column; }
.lu-qs-wrap { display: block; margin-bottom: 14px; }

/* Models tab — the grid, then the "Manage all models" catalog, then the advanced editor. */
.lu-models-manage { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border); }
.lu-models-h { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.lu-adv-recs { margin-top: 22px; border-top: 1px solid var(--border); padding-top: 12px; }
.lu-adv-recs > summary { font-size: 12px; font-weight: 600; color: var(--ink-2); cursor: pointer; list-style: revert; padding: 4px 0; }
.lu-adv-recs[open] > summary { margin-bottom: 12px; }

/* naked control — the host wraps it in its own page card (.pane-card in JW) */
.lu-pcard-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.lu-pcard-title { font-weight: 700; font-size: 14px; color: var(--ink); }
.lu-pcard-count { font-size: 12px; }
.lu-pcard-head .lu-btn { margin-left: auto; }
.lu-plus { font-weight: 700; }

.lu-eyebrow-row { display: flex; align-items: baseline; gap: 10px; margin: 6px 0 2px; }
.lu-eyebrow-cloud { margin-top: 16px; }
.lu-eyebrow { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.lu-eyebrow-sub { font-size: 11.5px; }

.lu-prow {
  display: grid; grid-template-columns: auto minmax(0,1fr) auto auto auto; gap: 14px; align-items: center;
  padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); margin-top: 8px;
}
.lu-prow-ic { width: 36px; height: 36px; border-radius: 8px; background: var(--surface-3); color: var(--ink-2); display: grid; place-items: center; }
.lu-prow-ic svg { width: 17px; height: 17px; }
.lu-prow-info { min-width: 0; }
.lu-prow-name { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.lu-prow-name b { font-size: 13.5px; color: var(--ink); }
.lu-cap { font-size: 9px; font-weight: 700; letter-spacing: .05em; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--ink-2); background: var(--surface); }
.lu-prow-url { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lu-prow-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
.lu-prow-meta b { color: var(--ink-2); }
.lu-prow-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ink-2); white-space: nowrap; }
.lu-sdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.lu-pempty { font-size: 12px; text-align: center; padding: 14px; background: var(--surface-2); border-radius: 8px; font-style: italic; color: var(--muted); margin-top: 8px; }
.lu-newform { margin-top: 8px; border: 1px solid var(--accent); border-radius: 10px; overflow: hidden; }
.lu-mono { font-family: var(--font-mono, monospace); }

/* Usage — header + rollup metric cards + per-feature/provider tables. */
.lu-usagehead { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.lu-usagesub { font-size: 11.5px; flex: 1; }
.lu-usage { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; max-width: 760px; }
.lu-ucard { display: flex; flex-direction: column; gap: 4px; }
.lu-uval { font-size: 23px; font-weight: 700; color: var(--ink); line-height: 1.1; }
.lu-ulabel { font-size: 12px; color: var(--muted); }
.lu-usage-empty { text-align: center; font-size: 12.5px; }
.lu-usage-section { margin-top: 20px; }
.lu-usage-h { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.lu-utable { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lu-utable th { text-align: right; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.lu-utable th:first-child, .lu-utable td:first-child { text-align: left; }
.lu-utable td { text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--border); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.lu-utable td:first-child { color: var(--ink); font-weight: 600; }
.lu-utable tbody tr:last-child td { border-bottom: 0; }
</style>
