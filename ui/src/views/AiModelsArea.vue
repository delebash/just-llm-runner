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
import { computed, nextTick, onMounted, ref } from "vue";

import AppModal from "../common/components/AppModal.vue";
import UiButton from "../common/components/UiButton.vue";
import UiCheckbox from "../common/components/UiCheckbox.vue";
import FeatureWorkbench from "./FeatureWorkbench.vue";
import ProviderForm from "./ProviderForm.vue";
import QuickSetup from "./QuickSetup.vue";
import PricingEditor from "./PricingEditor.vue";
import ConsolePanel from "../components/ConsolePanel.vue";
import LuBookSearchSetup from "../components/LuBookSearchSetup.vue";
import { pushToast } from "../common/services/toastBridge.js";
import { request } from "../client.js";
import { useModelApply } from "../services/modelApply.js";
import { useEngine } from "../composables/useEngine.js";
import { refresh as refreshRunnerModels } from "../composables/useRunnerModels.js";
import { usePoll } from "../common/composables/usePoll.js";

// Engine state here feeds only the debug snapshot — the engine ACTIONS
// (Install / Uninstall / Update available / Reinstall + progress + errors) all
// live on the Local-engine panel inside the promoted built-in section (QC-39:
// the built-in's list row is gone, so the panel is THE engine surface; same
// shared useEngine state, so no surface can disagree).
const { engineState: engState, checkForUpdate, refreshEngine } = useEngine();

// Host-contributed tab: an app passes a label + fills the #app-tab slot with its
// own AI-domain settings (e.g. JustWrite's "Writing AI" — voice canon, RAG
// auto-rebuild, variations). Keeps ALL AI settings in this one shared area while
// each app's specifics stay app-side. Empty label → no extra tab.
const props = defineProps({
  appTabLabel: { type: String, default: "" },
  // Host runner forwarded to the Feature Workbench test panel (streaming +
  // cancel + the app's batch AI list). See FeatureWorkbench `runStream`.
  runStream: { type: Function, default: null },
  // Deep-link seam: when a host routes here to run Quick Setup (JW's welcome
  // screen, QC-46, via ?quicksetup=1), open the wizard ONCE after the first
  // load. Off by default — JustVoice inherits it inert.
  autoOpenQuickSetup: { type: Boolean, default: false },
});

// The subnav tab. (Was the shared `activeAiTab` from labHandoff.js — that channel
// existed only for the Tune→Tasks switch-carry handoff, removed with §7.1: engine
// switches live on the model, so there is nothing to hand to the Lab anymore.)
const tab = ref("providers");
const providers = ref([]);
const hardware = ref(null);
const usage = ref(null);
const loading = ref(true);
const error = ref("");
const editingId = ref(null); // "new" | provider id | null
const status = ref({}); // provider id -> "checking" | "ok" | "fail"

// QC-39 (b), the user's pick: the BUILT-IN provider is promoted OUT of the
// accordion into its own permanent top section — its Edit contents ARE the
// page. Every OTHER provider (local openai-compat ones included — the user's
// explicit check) stays in the grouped list below with the small inline Edit.
const builtinProvider = computed(() => providers.value.find((p) => p.providerType === "local-llamacpp") || null);
// Group by the provider's stored Local/Online choice (set in the form), not a
// URL guess — a local provider at a LAN IP still groups under Local.
const localProviders = computed(() => providers.value.filter((p) => p.local && p.providerType !== "local-llamacpp"));
const cloudProviders = computed(() => providers.value.filter((p) => !p.local));

const hwLabel = computed(() => {
  const h = hardware.value;
  if (!h) return null;
  const gpu = h.gpus && h.gpus[0];
  // Every detected runtime, with the one the engine actually uses marked (priority =
  // select_binary's pick order: cuda → rocm → vulkan → cpu). A bare "CUDA / VULKAN"
  // read as a question (user, 2026-07-06) — both APIs ship with the ONE GPU driver;
  // nothing extra is installed.
  const order = ["cuda", "rocm", "vulkan", "cpu"];
  const rank = (k) => (order.indexOf(k) < 0 ? 99 : order.indexOf(k));
  const rts = Object.entries(h.runtimes || {}).filter(([, v]) => v).map(([k]) => k)
    .sort((a, b) => rank(a) - rank(b));
  const active = rts[0] || "";
  const accel = rts
    .map((k) => (k === active ? `${k.toUpperCase()} (in use)` : `${k.toUpperCase()} (supported)`))
    .join(" · ");
  return {
    os: h.os || "—",
    cpu: h.cpuCores ? `${h.cpuCores} threads` : "—",
    gpu: gpu ? gpu.name : "CPU only",
    vram: gpu?.vramMb ? `${(gpu.vramMb / 1024).toFixed(0)} GB` : null,
    ram: h.ramMb ? `${(h.ramMb / 1024).toFixed(0)} GB` : "—",
    accel: accel || "—",
  };
});

// ── Live VRAM + debug info on the strip (user, 2026-07-07) ───────────────────
// GET /resident is read-only + safe to poll (never spawns the router — the
// LuRunnerEngine precedent); it carries the measured VRAM ledger (total /
// committed / free) + the loaded-models list the debug snapshot includes.
const resident = ref(null);
// The catalog rows' status comes from useRunnerModels, whose own poller only runs
// while a load IT started is in flight — a load from another surface (Quick Setup,
// a chat leg's ensure, an eviction) left the rows stale ("loads on first use" beside
// a 6.6 GB header, 2026-07-11). This poll already sees the live resident set every
// tick, so a CHANGE in the loaded set kicks the shared models refresh — one truth.
let _loadedSig = "";
const { start: startResPoll } = usePoll(async () => {
  try {
    resident.value = await request("/v1/llm-runner/resident");
    const sig = (resident.value?.models || [])
      .filter((m) => m.status === "loaded" || m.status === "sleeping")
      .map((m) => m.id)
      .sort()
      .join("|");
    if (_loadedSig !== null && sig !== _loadedSig) refreshRunnerModels();
    _loadedSig = sig;
  } catch { /* keep last */ }
}, 2500);
const gb1 = (mb) => (mb / 1024).toFixed(1);
const vramLine = computed(() => {
  const r = resident.value;
  if (!r?.vramTotalMb) return ""; // no detectable GPU VRAM → no stat block
  return `${gb1(r.committedMb || 0)} / ${gb1(r.vramTotalMb)} GB · ${gb1(r.remainingMb || 0)} free`;
});

// "Copy debug info" — the whole box picture as ONE pasteable text block (hardware +
// tuning keys + engine build + the live resident set). Beats more UI: a bug report
// or a support chat gets the machine's true state in one paste.
const debugCopied = ref(false);
function debugInfoText() {
  const h = hardware.value || {};
  const gpu = h.gpus?.[0];
  const st = engState.value || {};
  const r = resident.value;
  const lines = [
    `OS: ${h.os || "?"} (${h.platform || "?"}) · CPU ${h.cpuCores ?? "?"} threads · RAM ${h.ramMb ? gb1(h.ramMb) : "?"} GB`,
    `GPU: ${gpu ? `${gpu.name} · ${gpu.vramMb ? gb1(gpu.vramMb) : "?"} GB VRAM · driver ${gpu.driver || "?"}` : "none detected"}`,
    `Acceleration: ${hwLabel.value?.accel || "—"}`,
    `Engine: ${st.installed ? `installed · ${st.build || "?"} · ${st.gpu || "?"}` : "not installed"}`,
    `Tuning keys: machine ${h.machineKey || "?"} · class ${h.classKey || "?"}`,
    r?.vramTotalMb
      ? `VRAM: ${r.committedMb || 0} / ${r.vramTotalMb} MB committed · ${r.remainingMb || 0} MB free`
      : "VRAM: n/a",
    `Loaded models: ${
      r?.models?.length
        ? r.models.map((m) => `${m.id} (${m.status}${m.vramMb ? ` · ${m.vramMb} MB` : ""}${m.nCtx ? ` · ctx ${m.nCtx}` : ""})`).join(", ")
        : "none"
    }`,
  ];
  return lines.join("\n");
}
async function copyDebugInfo() {
  try {
    await navigator.clipboard.writeText(debugInfoText());
    debugCopied.value = true;
    setTimeout(() => { debugCopied.value = false; }, 1500);
  } catch {
    pushToast({ message: "Couldn't reach the clipboard — select and copy from the console instead.", kind: "error" });
  }
}

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

// ── Task E — the hardware-change notification (user, 2026-07-06/07 dispositions:
// "counts as changed just gpu vram" · "appears dismissinle toast" · fires ONCE per
// change via a persisted acknowledged fingerprint; the enable/disable toggle is a
// deferred App-Settings todo). The fingerprint is gpu-name|vramMb — cores/RAM
// deliberately excluded. First sight of a box seeds the baseline SILENTLY (a fresh
// install is not a change). The acknowledgment is written BEFORE the toast shows so
// the notice fires once even across restarts/dismissals. The toast's button opens
// Quick Setup (a better model may now fit); re-tuning the current model stays a
// pointer in the message (the Tune dialog lives inside the Built-in provider's Edit
// view — a direct-open handoff is a possible follow-up).
const qsRef = ref(null); // the inline QuickSetup mount (exposes openWizard)

// ── B2-9 (§7.2): "Set as default" on every provider row. ONE flow local/online:
// chat/tasks repoint always; the embedding default too WHEN the row has an
// embedding model (else the dialog says it stays, in one line); the overwrite
// choice at apply — every task vs keep-my-customized (a task whose preset
// provider/model differs from the current default keeps its own routing).
const { currentDefaultId, currentDefaultProviderId, currentEmbeddingId, refreshApplied, setAsDefault, setAsEmbedding, LOCAL_RUNNER_ID } = useModelApply();
const setDefaultFor = ref(null);   // the provider being confirmed (null = closed)
const overwriteTasks = ref(false); // §7.2's choice; off = keep-my-customized
const settingDefault = ref(false);

// QC-20 ("the default provider is not set for llama after running quicksetup"):
// the provider LIST shows which row IS the current default — derived from the
// same dominant pair the dialog uses (one source), tagged like the catalog's
// Default badge; that row's Set-as-default reads "Default ✓" (the catalog's
// already-set affordance, LuModelCatalog:806-811). The built-in row matches on
// the runner id (presets carry LOCAL_RUNNER_ID, not the provider row's own id).
const isDefaultProvider = (p) => (p.providerType === "local-llamacpp"
  ? currentDefaultProviderId.value === LOCAL_RUNNER_ID
  : !!p.id && currentDefaultProviderId.value === p.id);

const sdIsBuiltin = computed(() => setDefaultFor.value?.providerType === "local-llamacpp");
// The chat model the default would run on: the built-in's is its assigned local
// pick (the dominant across the task presets); an online/local-URL row's is its
// "Default model" field. Empty → the guard branch renders instead of Apply.
const sdModel = computed(() =>
  sdIsBuiltin.value ? currentDefaultId.value : (setDefaultFor.value?.defaultModel || ""));
// QC-21 ("falsely reports no embinding model is set even thghout quick setp set
// one as default"): the provider ROW's embeddingModel field is only how ONLINE
// rows carry an embedding — the built-in's lives in the ROUTING default
// (QuickSetup writes it there via setAsEmbedding), so the built-in reads the
// current LOCAL embedding instead and the dialog line tells the truth.
const sdEmbedModel = computed(() =>
  sdIsBuiltin.value ? currentEmbeddingId.value : (setDefaultFor.value?.embeddingModel || ""));

async function openSetDefault(p) {
  overwriteTasks.value = false;
  // The built-in's pick can be stale (another surface may have re-pointed the
  // presets) — refresh BEFORE the dialog decides between Apply and the guard.
  if (p.providerType === "local-llamacpp") await refreshApplied();
  setDefaultFor.value = p;
}

async function applySetDefault() {
  const p = setDefaultFor.value;
  if (!p || !sdModel.value) return;
  settingDefault.value = true;
  try {
    const pid = sdIsBuiltin.value ? LOCAL_RUNNER_ID : p.id;
    await setAsDefault(pid, sdModel.value, { overwrite: overwriteTasks.value });
    // QC-21: the built-in's sdEmbedModel IS the current routing embedding — the
    // write would rewrite the identical value, so it is skipped (the dialog line
    // says "already runs here — unchanged"). Online rows still repoint it.
    if (sdEmbedModel.value && !sdIsBuiltin.value) await setAsEmbedding(pid, sdEmbedModel.value);
    pushToast({ message: `${p.name || p.id} is now the default provider — tasks run on ${sdModel.value}.` });
    setDefaultFor.value = null;
  } catch (e) {
    pushToast({ message: `Set as default failed: ${e?.message || e}` });
  } finally {
    settingDefault.value = false;
  }
}

function sdRunQuickSetup() {
  setDefaultFor.value = null;
  qsRef.value?.openWizard?.();
}

function sdEditProvider() {
  editingId.value = setDefaultFor.value?.id || null;
  setDefaultFor.value = null;
}
async function checkHardwareChange() {
  try {
    const h = await request("/v1/llm-runner/hardware");
    const g = (h?.gpus && h.gpus[0]) || null;
    const fp = g ? `${g.name}|${g.vramMb || 0}` : "cpu|0";
    const cfg = await request("/v1/ai/engine-config");
    const stored = (cfg?.ackHwFingerprint || "").trim();
    if (stored === fp) return;
    await request("/v1/ai/engine-config", { method: "PUT", body: { ackHwFingerprint: fp } });
    if (!stored) return; // baseline seeded — never toast a first sight
    pushToast({
      title: "Your graphics hardware changed",
      message: "A different model may now fit this PC — run Quick Setup to re-check, or re-tune your current model from its Tune dialog (Edit the built-in server).",
      kind: "info",
      duration: 30000,
      action: { label: "Run Quick Setup", fn: () => qsRef.value?.openWizard?.() },
    });
  } catch { /* detection is best-effort — never block the page */ }
}

onMounted(() => {
  // autoOpenQuickSetup (QC-46): open the wizard ONCE after the FIRST loadAll()
  // resolves, so it has the provider list + hardware it needs before showing.
  // nextTick first: the QuickSetup mount (qsRef) sits inside
  // v-if="builtinProvider", which only renders AFTER the providers land —
  // the template ref is still null on the resolve tick itself.
  loadAll().then(async () => {
    if (!props.autoOpenQuickSetup) return;
    await nextTick();
    qsRef.value?.openWizard?.();
  });
  startResPoll(); // the strip's live VRAM stat + the debug snapshot's resident set
  refreshEngine(); // the Built-in row's Install/Update/Uninstall state
  checkForUpdate(); // A5 — policy-gated (Off = silent); notify surfaces a line, never auto-applies
  checkHardwareChange(); // Task E — gpu/vram change → one dismissible toast
  refreshApplied(); // QC-20 — the provider rows' Default tag needs the dominant pair at open
});
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
      <!-- Live measured VRAM (user, 2026-07-07) — the resident ledger, polled; hidden on
           a no-GPU box. The Copy button snapshots the whole picture (hardware · tuning
           keys · engine build · loaded models) as one pasteable debug block. -->
      <div v-if="vramLine" class="lu-hwstat"><span class="lu-hwstat-k">VRAM used</span><span class="lu-hwstat-v">{{ vramLine }}</span></div>
      <UiButton intent="ghost" size="small" class="lu-hwcopy"
        title="Copy this machine's AI state — hardware, driver, engine build, tuning keys, VRAM, loaded models — for a bug report"
        @click="copyDebugInfo">{{ debugCopied ? "Copied ✓" : "Copy debug info" }}</UiButton>
    </div>

    <nav class="lu-subnav">
      <a :class="{ on: tab === 'providers' }" @click="tab = 'providers'">Providers &amp; models</a>
      <a :class="{ on: tab === 'features' }" @click="tab = 'features'">Routing by feature</a>
      <a v-if="props.appTabLabel" :class="{ on: tab === 'app' }" @click="tab = 'app'">{{ props.appTabLabel }}</a>
      <a :class="{ on: tab === 'usage' }" @click="tab = 'usage'">Usage</a>
      <!-- QC-43c: live server-console tab — the server log ring + the engine child's output. -->
      <a :class="{ on: tab === 'console' }" @click="tab = 'console'">Server console</a>
    </nav>

    <div v-if="error" class="lu-error" style="margin-top:14px">{{ error }}</div>

    <!-- ── Providers & models ── -->
    <section v-show="tab === 'providers'" class="lu-tab">
      <!-- QC-39 (b), the user's pick: the built-in provider PROMOTED out of the
           accordion — its own permanent top section whose contents ARE its old
           Edit view (field grid · engine panel · slot cards · Model Catalog ·
           libraries). Order preserves the old card 1:1: the Quick-Setup band at
           the TOP (#4 law), then the identity row (name · caps · Default tag ·
           Set as default), then the form. The old row's engine buttons +
           progress/error live on the Local-engine panel inside (one surface);
           the old row's Test/status is the form footer's Test connection (one
           check, the composed-health one — #139). -->
      <div v-if="builtinProvider" class="lu-builtin">
        <div class="lu-builtin-qs">
          <QuickSetup ref="qsRef" inline @changed="loadProviders" />
        </div>
        <div class="lu-builtin-head">
          <!-- The DB name already says what it is (seeded "Built-in provider —
               llama.cpp", user-renamable) — the title adds only the mockup's
               "(your machine)" tail. -->
          <h3 class="lu-builtin-title">{{ builtinProvider.name || builtinProvider.id }} (your machine)</h3>
          <span v-for="c in capList(builtinProvider)" :key="c" class="lu-cap">{{ c }}</span>
          <span class="lu-builtin-spacer" />
          <!-- The default indicator is THIS right-aligned button, green when set
               (2026-07-17, user: "make it green… more obvious", "align right"); the
               separate left "Default" tag was removed so it lives in one place. QC-20:
               reads already-set but stays CLICKABLE — the dialog on the current default
               is where QC-21's truthful embedding line shows. -->
          <UiButton :intent="isDefaultProvider(builtinProvider) ? 'success' : 'secondary'" size="small"
            @click="openSetDefault(builtinProvider)">{{ isDefaultProvider(builtinProvider) ? "Default ✓" : "Set as default" }}</UiButton>
        </div>
        <ProviderForm :provider="builtinProvider" permanent @saved="onSaved" />
      </div>

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
              <div class="lu-prow-name">
                <b>{{ p.name || p.id }}</b><span v-for="c in capList(p)" :key="c" class="lu-cap">{{ c }}</span>
                <!-- The default indicator is the right-aligned green "Default ✓" button
                     in the actions cell (2026-07-17); the left "Default" tag was removed
                     so it lives in one place, consistent with the model catalog. -->
              </div>
              <div class="lu-prow-url">{{ p.baseUrl }}</div>
              <div class="lu-prow-meta">
                <template v-if="p.defaultModel">chat: <b>{{ p.defaultModel }}</b> · </template>
                <template v-if="p.embeddingModel">embed: <b>{{ p.embeddingModel }}</b> · </template>
                {{ p.hasApiKey ? "API key set" : "no key" }}
              </div>
            </div>
            <span class="lu-prow-status"><span class="lu-sdot" :style="{ background: statusColor(p.id) }" />{{ statusLabel(p.id) }}</span>
            <!-- ONE actions cell (the row is a grid — loose buttons would wrap to a new
                 grid row, which is exactly the misplacement the user screenshotted). -->
            <div class="lu-prow-actions">
              <UiButton intent="secondary" size="small" @click="testProvider(p)">Test</UiButton>
              <UiButton intent="primary" size="small" @click="editingId = p.id">Edit</UiButton>
              <!-- Default/Set-as-default is the RIGHTMOST action (2026-07-17) — matches the
                   model catalog's "Default ✓" position + the built-in header, so the default
                   indicator is far-right on every surface. -->
              <UiButton :intent="isDefaultProvider(p) ? 'success' : 'secondary'" size="small"
                @click="openSetDefault(p)">{{ isDefaultProvider(p) ? "Default ✓" : "Set as default" }}</UiButton>
            </div>
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
            <div class="lu-prow-actions">
              <UiButton intent="secondary" size="small" @click="testProvider(p)">Test</UiButton>
              <UiButton intent="primary" size="small" @click="editingId = p.id">Edit</UiButton>
              <!-- Default/Set-as-default is the RIGHTMOST action (2026-07-17) — matches the
                   model catalog's "Default ✓" position + the built-in header, so the default
                   indicator is far-right on every surface. -->
              <UiButton :intent="isDefaultProvider(p) ? 'success' : 'secondary'" size="small"
                @click="openSetDefault(p)">{{ isDefaultProvider(p) ? "Default ✓" : "Set as default" }}</UiButton>
            </div>
          </div>
        </template>
        <div v-if="!loading && !cloudProviders.length" class="lu-pempty">No cloud providers. Click “Add provider” and paste a key from OpenAI / Anthropic / OpenRouter.</div>

        <!-- B2-9 (§7.2): the set-as-default confirm — ONE flow for every provider.
             Apply branch when the row has a chat model; else the guard branch
             (built-in: "pick manually or run Quick Setup" — the user's recorded
             offer; other rows: set the Default model in Edit first). -->
        <AppModal v-if="setDefaultFor" title="Set as default provider" :max-width="'480px'" @close="setDefaultFor = null">
          <template v-if="sdModel">
            <p class="lu-sd-line"><b>{{ setDefaultFor.name || setDefaultFor.id }}</b> becomes the default for your AI tasks — they run on <b>{{ sdModel }}</b>.</p>
            <!-- QC-21: the built-in's embedding lives in the routing default already —
                 say so instead of the false "no embedding model set". -->
            <p v-if="sdEmbedModel && sdIsBuiltin" class="lu-sd-line lu-muted">Your embedding (<b>{{ sdEmbedModel }}</b>) already runs here — unchanged.</p>
            <p v-else-if="sdEmbedModel" class="lu-sd-line lu-muted">Also becomes the embeddings (search) provider: <b>{{ sdEmbedModel }}</b>.</p>
            <!-- ONLINE row with no embedding of its own → the Book-search section
                 (2026-07-18): truthful "unchanged" line when an embedding already
                 routes; otherwise recommend the local setup (engine + embed model,
                 shared DownloadBars, cancel free) / a configured Ollama / skip —
                 skipping is passive, Apply never blocks, chat runs bible-only. -->
            <LuBookSearchSetup v-else-if="!sdIsBuiltin" :providers="providers" />
            <p v-else class="lu-sd-line lu-muted">Search embeddings keep their current provider — this provider has no embedding model set.</p>
            <UiCheckbox v-model="overwriteTasks">Also overwrite presets I customized</UiCheckbox>
          </template>
          <template v-else-if="sdIsBuiltin">
            <p class="lu-sd-line">Assign a chat model first — pick one in the Model Catalog (Edit this provider), or run Quick Setup.</p>
          </template>
          <template v-else>
            <p class="lu-sd-line">Set this provider's chat model first — open Edit and fill <b>Default model</b>.</p>
          </template>
          <template #footer>
            <template v-if="sdModel">
              <UiButton intent="secondary" @click="setDefaultFor = null">Cancel</UiButton>
              <UiButton intent="primary" :loading="settingDefault" @click="applySetDefault">Set as default</UiButton>
            </template>
            <template v-else-if="sdIsBuiltin">
              <UiButton intent="secondary" @click="setDefaultFor = null">Close</UiButton>
              <UiButton intent="primary" @click="sdRunQuickSetup">Run Quick Setup</UiButton>
            </template>
            <template v-else>
              <UiButton intent="secondary" @click="setDefaultFor = null">Close</UiButton>
              <UiButton intent="primary" @click="sdEditProvider">Edit provider</UiButton>
            </template>
          </template>
        </AppModal>
      </div>
    </section>

    <!-- ── Routing by feature — the Feature Workbench: per-feature preset (model +
         ask-params/samplers live in the preset; launch switches live on the MODEL —
         Tune & measure, §7.1). ── -->
    <section v-show="tab === 'features'" class="lu-tab lu-tab-fill">
      <FeatureWorkbench v-if="tab === 'features'" :run-stream="props.runStream" />
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

    <!-- ── Server console — live follow of the server log ring + the engine
         child's output (QC-43c). Mounted only while active (v-if) so its poll
         stops when the reader leaves the tab. Fills its height (one scroller). ── -->
    <section v-show="tab === 'console'" class="lu-tab lu-tab-fill">
      <ConsolePanel v-if="tab === 'console'" />
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
.lu-hwcopy { margin-left: auto; align-self: center; }
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
  /* 4 columns: icon · info · status · the ONE actions cell (Test/Edit + the Built-in
     row's engine buttons live INSIDE it — loose grid children wrapped to a new row). */
  display: grid; grid-template-columns: auto minmax(0,1fr) auto auto; gap: 14px; align-items: center;
  padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); margin-top: 8px;
}
.lu-prow-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
/* B2-9 set-as-default confirm — body lines above the overwrite choice. */
.lu-sd-line { margin: 0 0 10px; }
/* QC-39 (b) — the promoted built-in section (mockup (b) verbatim: one neutral
   card at the top of the tab; the accent stays at chip/focus scale). The
   Quick-Setup band keeps the old card-top law (#4): its own centered row,
   seated as the section's header band by the bottom border. */
.lu-builtin { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.lu-builtin-qs { text-align: center; padding-bottom: 10px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
.lu-builtin-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
.lu-builtin-title { margin: 0; font-size: 15px; font-weight: 700; color: var(--ink); }
.lu-builtin-spacer { flex: 1; }
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
/* The add-provider form carries the card chrome itself (QC-39 neutral .lu-pform);
   "new" keeps only the accent border-color as its affordance (chip-scale accent). */
.lu-newform { border-color: var(--accent); }
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
