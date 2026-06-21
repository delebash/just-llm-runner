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

import LuButton from "../components/LuButton.vue";
import ProviderForm from "./ProviderForm.vue";
import { request } from "../client.js";

const tab = ref("providers");
const providers = ref([]);
const hardware = ref(null);
const usage = ref(null);
const loading = ref(true);
const error = ref("");
const editingId = ref(null); // "new" | provider id | null
const status = ref({}); // provider id -> "checking" | "ok" | "fail"

const isLocalUrl = (u) => /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(u || "");
const localProviders = computed(() => providers.value.filter((p) => isLocalUrl(p.baseUrl)));
const cloudProviders = computed(() => providers.value.filter((p) => !isLocalUrl(p.baseUrl)));

const hwLabel = computed(() => {
  const h = hardware.value;
  if (!h) return null;
  const gpu = h.gpus && h.gpus[0];
  const vram = gpu?.vramMb ? `${(gpu.vramMb / 1024).toFixed(0)} GB VRAM` : "";
  const accel = Object.entries(h.runtimes || {}).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(" / ");
  return {
    gpu: gpu ? `${gpu.name}${vram ? ` · ${vram}` : ""}` : "CPU only",
    ram: h.ramMb ? `${(h.ramMb / 1024).toFixed(0)} GB` : "—",
    accel: accel || "—",
  };
});

const usageStats = computed(() => {
  const s = usage.value;
  if (!s) return null;
  const byF = s.by_feature || {};
  let tokens = 0;
  let busy = "—";
  let busyCalls = -1;
  for (const [f, v] of Object.entries(byF)) {
    tokens += (v.prompt_tokens || 0) + (v.completion_tokens || 0);
    if ((v.calls || 0) > busyCalls) { busyCalls = v.calls || 0; busy = f; }
  }
  return { calls: s.total_calls || 0, tokens, busy, busyCalls: busyCalls < 0 ? 0 : busyCalls };
});

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
    const r = await request(`/v1/llm-providers/${encodeURIComponent(p.id)}/ping`);
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

    <div v-if="hwLabel" class="lu-hwtop">
      <span class="lu-hw-title">YOUR HARDWARE</span>
      <div><span class="lu-hw-k">GPU</span> <b>{{ hwLabel.gpu }}</b></div>
      <div><span class="lu-hw-k">RAM</span> <b>{{ hwLabel.ram }}</b></div>
      <div><span class="lu-hw-k">Accel</span> <b>{{ hwLabel.accel }}</b></div>
      <span class="lu-muted lu-hw-note">drives the Fit scores</span>
    </div>

    <nav class="lu-subnav">
      <a :class="{ on: tab === 'providers' }" @click="tab = 'providers'">Providers &amp; models</a>
      <a :class="{ on: tab === 'features' }" @click="tab = 'features'">Features</a>
      <a :class="{ on: tab === 'usage' }" @click="tab = 'usage'">Usage</a>
    </nav>

    <div v-if="error" class="lu-error" style="margin-top:14px">{{ error }}</div>

    <!-- ── Providers & models ── -->
    <section v-show="tab === 'providers'" class="lu-tab">
      <div class="lu-providers">
        <div class="lu-pcard-head">
          <span class="lu-pcard-title">Providers</span>
          <span class="lu-muted lu-pcard-count">{{ providers.length }} configured</span>
          <LuButton intent="primary" size="small" @click="editingId = editingId === 'new' ? null : 'new'">
            <template #icon><span class="lu-plus">＋</span></template>Add provider
          </LuButton>
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
            <LuButton intent="secondary" size="small" @click="testProvider(p)">Test</LuButton>
            <LuButton intent="primary" size="small" @click="editingId = p.id">Edit</LuButton>
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
            <LuButton intent="secondary" size="small" @click="testProvider(p)">Test</LuButton>
            <LuButton intent="primary" size="small" @click="editingId = p.id">Edit</LuButton>
          </div>
        </template>
        <div v-if="!loading && !cloudProviders.length" class="lu-pempty">No cloud providers. Click “Add provider” and paste a key from OpenAI / Anthropic / OpenRouter.</div>
      </div>
    </section>

    <!-- ── Features (placeholder — routing table is the next chunk) ── -->
    <section v-show="tab === 'features'" class="lu-tab">
      <div class="lu-muted">
        Feature routing (provider ▸ model per feature, roles, defaults) + the per-action Lab land next.
        The per-feature <b>prompt</b> editor is live at the Feature prompts view.
      </div>
    </section>

    <!-- ── Usage ── -->
    <section v-show="tab === 'usage'" class="lu-tab">
      <div>
        <div v-if="usageStats" class="lu-usage">
          <div class="lu-u"><b>{{ usageStats.calls.toLocaleString() }}</b><small>calls recorded</small></div>
          <div class="lu-u"><b>{{ usageStats.tokens.toLocaleString() }}</b><small>tokens</small></div>
          <div class="lu-u"><b>{{ usageStats.busy }}</b><small>busiest · {{ usageStats.busyCalls.toLocaleString() }} calls</small></div>
        </div>
        <div v-else class="lu-muted">No usage recorded yet.</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.lu-area { max-width: 1100px; }
.lu-h1 { font-size: 22px; font-weight: 600; margin: 0; color: var(--ink); }
.lu-lede { font-size: 13px; margin: 4px 0 0; }
.lu-hwtop { display: flex; gap: 24px; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 11px 18px; margin-top: 12px; font-size: 12.5px; }
.lu-hw-title { font-size: 11px; font-weight: 700; color: var(--muted); }
.lu-hw-k { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.lu-hw-note { margin-left: auto; font-size: 11.5px; }
.lu-subnav { display: flex; gap: 4px; margin-top: 14px; border-bottom: 1px solid var(--border); }
.lu-subnav a { padding: 9px 16px; font-size: 12.5px; color: var(--ink-2); border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; font-weight: 600; }
.lu-subnav a.on { color: var(--ink); border-bottom-color: var(--accent); }
.lu-tab { padding-top: 14px; }

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

.lu-usage { display: flex; gap: 30px; flex-wrap: wrap; }
.lu-u { font-size: 13px; }
.lu-u b { display: block; font-size: 18px; color: var(--ink); }
.lu-u small { color: var(--muted); }
</style>
