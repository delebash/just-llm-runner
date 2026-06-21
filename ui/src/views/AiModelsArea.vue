<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The shared "AI / Models" area (from the shared-ai-models mock) — ONE UI for
// both apps: Providers & models · Features · Usage, with a hardware strip. Built
// in plain-JS Vue on the shared client; the host mounts it at a top-level route
// and passes its appName. Wired to the real shared endpoints (/v1/llm-providers*,
// /v1/llm-runner/hardware, /v1/ai-usage). The Features routing table + the
// per-provider local-model/Fit section are the next chunks (this is the
// Providers-tab + Usage working example).
import { computed, onMounted, ref } from "vue";

import LuButton from "../components/LuButton.vue";
import ProviderForm from "./ProviderForm.vue";
import { request } from "../client.js";

const props = defineProps({
  appName: { type: String, default: "" },
});

const tab = ref("providers");
const providers = ref([]);
const hardware = ref(null);
const usage = ref(null);
const loading = ref(true);
const error = ref("");
const editingId = ref(null); // "new" | provider id | null

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
  let calls = s.total_calls || 0;
  let tokens = 0;
  let busy = "—";
  let busyCalls = -1;
  for (const [f, v] of Object.entries(byF)) {
    tokens += (v.prompt_tokens || 0) + (v.completion_tokens || 0);
    if ((v.calls || 0) > busyCalls) { busyCalls = v.calls || 0; busy = f; }
  }
  return { calls, tokens, busy, busyCalls: busyCalls < 0 ? 0 : busyCalls };
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
  const caps = ["LLM"];
  if (p.embeddingModel) caps.push("EMBED");
  return caps;
}
function summary(p) {
  const host = (p.baseUrl || "").replace(/^https?:\/\//, "");
  const key = isLocalUrl(p.baseUrl) ? "no key" : (p.hasApiKey ? "key set" : "no key");
  return `${host} · chat ${p.defaultModel || "—"} · ${key}`;
}

function onSaved() { editingId.value = null; loadProviders(); }

onMounted(loadAll);
</script>

<template>
  <div class="lu-area">
    <header class="lu-topbar">
      <span class="lu-brand">{{ appName || "App" }}</span>
      <span class="lu-shared">shared · @delebash/llm-ui</span>
    </header>
    <h1 class="lu-h1">Models</h1>
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
      <div class="lu-sech">
        <h2>Providers &amp; models</h2>
        <span class="lu-sech-right">
          <LuButton intent="primary" size="small" @click="editingId = editingId === 'new' ? null : 'new'">+ Add provider</LuButton>
        </span>
      </div>

      <ProviderForm v-if="editingId === 'new'" class="lu-newform" @saved="onSaved" @cancel="editingId = null" />

      <div class="lu-psplit"><span class="lu-tag-free">LOCAL · FREE</span> on your machine — no key, nothing leaves the device</div>
      <template v-for="p in localProviders" :key="p.id">
        <ProviderForm v-if="editingId === p.id" :provider="p" @saved="onSaved" @deleted="onSaved" @cancel="editingId = null" />
        <div v-else class="lu-prov">
          <span class="lu-dot" :class="{ off: !p.registered }" />
          <div class="lu-pmid">
            <span class="lu-pn">{{ p.name || p.id }}</span> <span class="lu-pid">{{ p.id }}</span>
            <span class="lu-caps"><span v-for="c in capList(p)" :key="c" class="lu-cap">{{ c }}</span></span>
            <div class="lu-muted lu-psum">{{ summary(p) }}</div>
          </div>
          <LuButton intent="secondary" size="small" @click="editingId = p.id">Edit</LuButton>
        </div>
      </template>
      <div v-if="!loading && !localProviders.length" class="lu-muted lu-empty">No local providers yet. Click “Add provider” and point at <span class="lu-mono">http://localhost:…</span></div>

      <div class="lu-psplit"><span class="lu-tag-paid">CLOUD · METERED</span> your account — API key + URL · billed by the provider</div>
      <template v-for="p in cloudProviders" :key="p.id">
        <ProviderForm v-if="editingId === p.id" :provider="p" @saved="onSaved" @deleted="onSaved" @cancel="editingId = null" />
        <div v-else class="lu-prov">
          <span class="lu-dot" :class="{ off: !p.registered }" />
          <div class="lu-pmid">
            <span class="lu-pn">{{ p.name || p.id }}</span> <span class="lu-pid">{{ p.id }}</span>
            <span class="lu-caps"><span v-for="c in capList(p)" :key="c" class="lu-cap">{{ c }}</span></span>
            <div class="lu-muted lu-psum">{{ summary(p) }}</div>
          </div>
          <LuButton intent="secondary" size="small" @click="editingId = p.id">Edit</LuButton>
        </div>
      </template>
      <div v-if="!loading && !cloudProviders.length" class="lu-muted lu-empty">No cloud providers. Click “Add provider” and paste a key from OpenAI / Anthropic / OpenRouter.</div>
    </section>

    <!-- ── Features (placeholder — routing table is the next chunk) ── -->
    <section v-show="tab === 'features'" class="lu-tab">
      <div class="lu-sech"><h2>Features</h2></div>
      <div class="lu-card lu-muted">
        Feature routing (provider ▸ model per feature, roles, defaults) + the per-action Lab land next.
        The per-feature <b>prompt</b> editor is live at the Feature prompts view.
      </div>
    </section>

    <!-- ── Usage ── -->
    <section v-show="tab === 'usage'" class="lu-tab">
      <div class="lu-sech"><h2>Usage</h2><span class="lu-muted" style="font-size:12px">tokens + calls</span></div>
      <div class="lu-card">
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
.lu-topbar { display: flex; align-items: center; gap: 12px; }
.lu-brand { font-weight: 800; font-size: 15px; color: var(--ink); }
.lu-shared { font-size: 11px; color: var(--accent-ink, var(--accent)); background: var(--accent-soft); border: 1px solid var(--accent-line, var(--accent)); border-radius: 999px; padding: 3px 10px; font-weight: 700; }
.lu-h1 { font-size: 22px; font-weight: 600; margin: 10px 0 0; color: var(--ink); }
.lu-lede { font-size: 13px; margin: 4px 0 0; }
.lu-hwtop { display: flex; gap: 24px; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 11px 18px; margin-top: 12px; font-size: 12.5px; }
.lu-hw-title { font-size: 11px; font-weight: 700; color: var(--muted); }
.lu-hw-k { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.lu-hw-note { margin-left: auto; font-size: 11.5px; }
.lu-subnav { display: flex; gap: 4px; margin-top: 14px; border-bottom: 1px solid var(--border); }
.lu-subnav a { padding: 9px 16px; font-size: 12.5px; color: var(--ink-2); border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; font-weight: 600; }
.lu-subnav a.on { color: var(--ink); border-bottom-color: var(--accent); }
.lu-tab { padding-top: 4px; }
.lu-sech { display: flex; align-items: baseline; gap: 10px; margin: 18px 0 0; padding-bottom: 8px; border-bottom: 2px solid var(--border); }
.lu-sech h2 { font-size: 17px; font-weight: 600; margin: 0; color: var(--ink); }
.lu-sech-right { margin-left: auto; }
.lu-psplit { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 16px 0 8px; display: flex; align-items: center; gap: 8px; }
.lu-tag-free { color: var(--accent-ink, var(--accent)); background: var(--accent-soft); border: 1px solid var(--accent-line, var(--accent)); border-radius: 999px; padding: 1px 8px; }
.lu-tag-paid { color: var(--gold, #b08a3e); background: var(--gold-soft, #f5edda); border: 1px solid var(--gold, #b08a3e); border-radius: 999px; padding: 1px 8px; }
.lu-prov { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-top: 8px; padding: 12px 16px; }
.lu-newform { margin-top: 8px; border: 1px solid var(--accent); border-radius: 10px; overflow: hidden; }
.lu-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.lu-dot.off { background: var(--border-strong); }
.lu-pmid { flex: 1; min-width: 0; }
.lu-pn { font-weight: 700; color: var(--ink); }
.lu-pid { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--muted); }
.lu-caps { display: inline-flex; gap: 4px; margin-left: 2px; }
.lu-cap { font-size: 9px; font-weight: 700; letter-spacing: .05em; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--ink-2); background: var(--surface); }
.lu-psum { font-size: 11.5px; margin-top: 2px; }
.lu-empty { padding: 10px 2px; font-size: 12.5px; }
.lu-mono { font-family: var(--font-mono, monospace); }
.lu-usage { display: flex; gap: 30px; flex-wrap: wrap; }
.lu-u { font-size: 13px; }
.lu-u b { display: block; font-size: 18px; color: var(--ink); }
.lu-u small { color: var(--muted); }
</style>
