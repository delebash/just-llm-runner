<script setup>
// SPDX-License-Identifier: MIT
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
import UiSegmented from "../common/components/UiSegmented.vue";
import UiTable from "../common/components/UiTable.vue";
import FeatureWorkbench from "./FeatureWorkbench.vue";
import { familyLabels } from "../common/services/familyLabels.js";

const TAB_LABELS = familyLabels.aiTabs; // reactive canon — group capture is safe, the door assigns in place
import ProviderForm from "./ProviderForm.vue";
import QuickSetup from "./QuickSetup.vue";
import PricingEditor from "./PricingEditor.vue";
import ConsolePanel from "../components/ConsolePanel.vue";
import LuBookSearchSetup from "../components/LuBookSearchSetup.vue";
import LuEngineInstallButton from "../components/LuEngineInstallButton.vue";
import LuEngineUpdateButton from "../components/LuEngineUpdateButton.vue";
import LuWarmStartupToggle from "../components/LuWarmStartupToggle.vue";
import { pushToast } from "../common/services/toastBridge.js";
import { request } from "../client.js";
import { useHardware } from "../composables/useHardware.js";
import { useModelApply } from "../services/modelApply.js";
import { useEngine } from "../composables/useEngine.js";
import { refresh as refreshRunnerModels } from "../composables/useRunnerModels.js";
import { usePoll } from "../common/composables/usePoll.js";
import { llmUiCapabilities } from "../installLlmUi.js";

// Engine state here feeds only the debug snapshot — the engine ACTIONS
// (Install / Uninstall / Update available / Reinstall + progress + errors) all
// live on the Local-engine panel inside the built-in provider's ProviderForm —
// reached by Edit on its row since 2026-07-19; same shared useEngine state, so
// no surface can disagree.
// `updateInfo` gates the row's engine-update affordance (LuEngineUpdateButton owns
// the label/title/action, bound to the same useEngine singleton — one control, two
// surfaces, can't drift).
const { engineState: engState, checkForUpdate, refreshEngine, updateInfo: engineUpdateInfo, statusKnown: engineStatusKnown, installed: engineInstalled, installing: engineInstalling } = useEngine();

// Host-contributed tab: an app passes a label + fills the #app-tab slot with its
// own AI-domain settings (e.g. JustWrite's "Writing AI" — voice canon, RAG
// auto-rebuild, variations). Keeps ALL AI settings in this one shared area while
// each app's specifics stay app-side. Empty label → no extra tab.
// A no-embeddings host hides every embed affordance (the capability, not per-flag).
const embedsOn = llmUiCapabilities().embeddings !== false;

const props = defineProps({
  appTabLabel: { type: String, default: "" },
  // Host runner forwarded to the Feature Workbench test panel (streaming +
  // cancel + the app's batch AI list). See FeatureWorkbench `runStream`.
  runStream: { type: Function, default: null },
  // Forwarded to the promptless Lab: the app's doors to its prompt-feeding data
  // (Option-A seam, ruling 2026-08-04). [{label, href}].
  dataLinks: { type: Array, default: () => [] },
  // Deep-link seam: when a host routes here to run Quick Setup (JW's welcome
  // screen, QC-46, via ?quicksetup=1), open the wizard ONCE after the first
  // load. Off by default — JustVoice inherits it inert.
  autoOpenQuickSetup: { type: Boolean, default: false },
  // Deep-link seam for the provider TABS: "online" lands the provider list on the
  // Online tab (JW's first-run AI setup dialog, "Connect an online provider", via
  // ?providers=online). Anything else — including the default "" — starts on Local.
  initialProviderScope: { type: String, default: "" },
  // The setup-wizard seam (2026-08-03): an app passes its OWN thin wizard component
  // (must expose openWizard(), emit changed/closed, accept `inline`) and the whole
  // local-setup band renders it instead of the default QuickSetup. Machinery stays
  // in the kit composables; the wizard's steps and words belong to the app.
  wizard: { type: [Object, Function], default: null },
});
const emit = defineEmits(["quick-setup-closed"]);

// The subnav tab. (Was the shared `activeAiTab` from labHandoff.js — that channel
// existed only for the Tune→Tasks switch-carry handoff, removed with §7.1: engine
// switches live on the model, so there is nothing to hand to the Lab anymore.)
const tab = ref("providers");
// Local vs Online is a TAB on the provider list (not two stacked eyebrow groups) —
// deliberately NOT named `tab`, which is the page subnav above.
const providerScope = ref(props.initialProviderScope === "online" ? "online" : "local");
const providers = ref([]);
// The box probe comes from the SHARED singleton (2026-07-27) — this file used to hold
// TWO independent fetches of /v1/llm-runner/hardware, the strip below and the change
// detector, alongside three more across the kit.
const { hardwareInfo: hardware, mainGpu, largestGpu, refresh: refreshHardware } = useHardware();
const usage = ref(null);
const loading = ref(true);
const error = ref("");
const editingId = ref(null); // "new" | provider id | null
const status = ref({}); // provider id -> "checking" | "ok" | "fail"

// Group by the provider's stored Local/Online choice (set in the form), not a
// URL guess — a local provider at a LAN IP still groups under Local.
// 2026-07-19: the built-in is IN the local list (the promoted card is gone) and is
// always its FIRST row. `.filter()` already returns a fresh array, so sorting it in
// place never touches `providers.value`.
const isBuiltin = (p) => p.providerType === "local-llamacpp";
const localProviders = computed(() => providers.value
  .filter((p) => p.local)
  .sort((a, b) => Number(isBuiltin(b)) - Number(isBuiltin(a))));
const cloudProviders = computed(() => providers.value.filter((p) => !p.local));
// ONE row template renders whichever scope the tab is on.
const shownProviders = computed(() => (providerScope.value === "online" ? cloudProviders.value : localProviders.value));

const hwLabel = computed(() => {
  const h = hardware.value;
  if (!h) return null;
  // The LARGEST GPU, not the first: on a laptop that enumerates its iGPU first, `gpus[0]`
  // made this strip name the wrong card (fixed 2026-07-27 — the rule now lives once, in
  // useHardware, and matches the server's own `max_vram_mb`).
  const gpu = mainGpu.value;
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
    // ONE workflow (2026-07-21): a model-load button can now install the engine (retryLoad) — so
    // keep the engine panel live while it's NOT yet installed, so that install shows here too, not
    // just on the boot splash. Once installed, useEngine's own poll owns any further transitions.
    if (!engineInstalled.value) refreshEngine();
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
// The usage breakdowns (by feature, by provider) are the same five columns with a different
// first-column label — one config, used twice, instead of the same <table> written out twice.
// Every column sorts: the panel exists to answer "what is costing me the most".
const usageColumns = (firstLabel) => [
  { id: "key", accessorKey: "key", header: firstLabel, sortable: true },
  { id: "calls", accessorKey: "calls", header: "Calls", sortable: true },
  { id: "prompt", accessorKey: "prompt", header: "Prompt", sortable: true },
  { id: "completion", accessorKey: "completion", header: "Completion", sortable: true },
  { id: "cost", accessorKey: "cost", header: "Cost", sortable: true },
];
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
  await refreshHardware(); // self-swallowing → null, which the strip already renders as blanks
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

// Only a DEEP-LINKED run (the first-run AI setup dialog) hands control back to
// the host; a wizard the user opened by clicking the button leaves them here.
function onQuickSetupClosed() {
  if (props.autoOpenQuickSetup) emit("quick-setup-closed");
}

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
    // A FRESH read on purpose: this compares against the stored fingerprint, so reading a
    // cached value could miss the very change it exists to notice.
    const h = await refreshHardware();
    // The LARGEST GPU, matching the strip and the server's own `max_vram_mb` rule. Read
    // through the shared pure helper rather than the reactive accessor, so the fingerprint
    // is built from THIS response and cannot depend on when the ref was last read.
    // Changing this rule (2026-07-27, the user's go — "but it is ok, continue") makes the
    // fingerprint DIFFER on any box whose first-listed GPU is not its largest, so one
    // stale `ackHwFingerprint` fires a single "your graphics hardware changed" toast that
    // no hardware change caused. Accepted knowingly: it is one notice, once, on multi-GPU
    // machines only, against a strip and a fit calculation that were naming the wrong card
    // permanently.
    const g = largestGpu(h?.gpus);
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
  // the providers tab's template, so the ref is only populated on the render
  // that follows the resolve — it is still null on the resolve tick itself.
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

    <!-- Tab words come from the FAMILY CONTRACT (one canon, every app); only the
         5th tab is host voice via appTabLabel. -->
    <nav class="lu-subnav">
      <a :class="{ on: tab === 'providers' }" @click="tab = 'providers'">{{ TAB_LABELS.providers }}</a>
      <a :class="{ on: tab === 'features' }" @click="tab = 'features'">{{ TAB_LABELS.routing }}</a>
      <a v-if="props.appTabLabel" :class="{ on: tab === 'app' }" @click="tab = 'app'">{{ props.appTabLabel }}</a>
      <a :class="{ on: tab === 'usage' }" @click="tab = 'usage'">{{ TAB_LABELS.usage }}</a>
      <!-- QC-43c: live server-console tab — the server log ring + the engine child's output. -->
      <a :class="{ on: tab === 'console' }" @click="tab = 'console'">{{ TAB_LABELS.console }}</a>
    </nav>

    <div v-if="error" class="lu-error" style="margin-top:14px">{{ error }}</div>

    <!-- ── Providers & models ── -->
    <section v-show="tab === 'providers'" class="lu-tab">
      <!-- 2026-07-19 (user ruling): the QC-39 (b) PROMOTION is reversed — the
           built-in provider is now a NORMAL first row in the Local list with the
           same inline Edit as every other provider (the Local tab gives the
           findability the promotion existed to give). What stays lifted out is
           the Quick-Setup band: it sits at the TOP of the Local scope in its own
           right, because it is the first-run path and no longer has a card to
           live in. -->
      <!-- The scope term is v-SHOW, not v-if, and deliberately so: this QuickSetup
           mount carries `qsRef`, and TWO openers outside this block reach it (the
           hardware-change toast's action, and the auto-open deep link). A v-if here
           would unmount the wizard on the Online tab and turn both into silent
           optional-chain no-ops. -->
      <div v-show="providerScope === 'local'" class="lu-qs-band">
        <component :is="props.wizard || QuickSetup" ref="qsRef" inline @changed="loadProviders" @closed="onQuickSetupClosed" />
      </div>

      <div class="lu-providers">
        <div class="lu-pcard-head">
          <span class="lu-pcard-title">Providers</span>
          <span class="lu-muted lu-pcard-count">{{ providers.length }} configured</span>
          <UiButton intent="primary" size="small" @click="editingId = editingId === 'new' ? null : 'new'">
            <template #icon><span class="lu-plus">＋</span></template>Add provider
          </UiButton>
        </div>

        <ProviderForm v-if="editingId === 'new'" class="lu-newform" :initial-local="providerScope === 'local'" @saved="onSaved" @cancel="editingId = null" />

        <!-- Local vs Online are TABS (user, 2026-07-19), not two stacked eyebrow
             groups — ONE row template renders the scope you're standing on, so the
             two near-duplicate lists that used to drift are gone. -->
        <UiSegmented v-model="providerScope" variant="connected" class="lu-scope"
          :options="[
            { value: 'local', label: 'Local · free', sublabel: 'Runs on your machine — no API key, no per-token cost' },
            { value: 'online', label: 'Online · metered', sublabel: 'Your account — API key + URL; pay per token' },
          ]" />
        <template v-for="p in shownProviders" :key="p.id">
          <ProviderForm v-if="editingId === p.id" :provider="p" @saved="onSaved" @deleted="onSaved" @cancel="editingId = null" />
          <div v-else class="lu-prow">
            <span class="lu-prow-ic">
              <!-- The ONLY difference the two old row templates had: the chip glyph on
                   local, the sparkle on online. -->
              <svg v-if="providerScope === 'local'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" /><path d="M6.2 1.5v2.7M9.8 1.5v2.7M6.2 11.8v2.7M9.8 11.8v2.7M1.5 6.2h2.7M1.5 9.8h2.7M11.8 6.2h2.7M11.8 9.8h2.7" stroke-linecap="round" /></svg>
              <svg v-else viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.4l1.4 4.1 4.2 1.5-4.2 1.5L8 12.6 6.6 8.5 2.4 7l4.2-1.5z" /></svg>
            </span>
            <div class="lu-prow-info">
              <div class="lu-prow-name">
                <b>{{ p.name || p.id }}</b><span v-for="c in capList(p)" :key="c" class="lu-cap">{{ c }}</span>
                <!-- 2026-07-19: the built-in is a normal row now, so the ONE thing that
                     still marks it out is this tag (same .lu-cap badge, no new style). -->
                <span v-if="isBuiltin(p)" class="lu-cap">Built-in</span>
                <!-- 2026-07-21 (user): the built-in provider is collapsed to a row, so an
                     available engine update was only visible after Edit. Surface it here too,
                     next to the tag — the SAME control the panel uses (LuEngineUpdateButton,
                     bound to the useEngine singleton), so the two can never disagree in look
                     OR wording. Intentional redundancy (row + panel), okayed by the user. -->
                <!-- `installed` is part of the gate, exactly as the panel has it
                     (LuRunnerEngine.vue:227). update_check answers updateAvailable even
                     with NOTHING installed — by design, `current` then falls back to the
                     pinned build, i.e. "an install would fetch something newer"
                     (lifecycle.py:893). Without the installed clause this row offered
                     "Update to b10246" beside "Install engine": update what? -->
                <LuEngineUpdateButton
                  v-if="isBuiltin(p) && engineInstalled && !engineInstalling && engineUpdateInfo?.updateAvailable"
                />
                <!-- 2026-07-21 (user): "we moved the update button but not the install
                     button move it now" — the engine isn't installed until the user acts,
                     and that was only reachable via Edit. Surface Install on the row too,
                     the SAME shared control the panel uses (LuEngineInstallButton, bound to
                     the useEngine singleton). Same gate as the panel's inline button. -->
                <LuEngineInstallButton v-if="isBuiltin(p) && engineStatusKnown && !engineInstalled && !engineInstalling" />
                <!-- The default indicator is the right-aligned green "Default ✓" button
                     in the actions cell (2026-07-17); the left "Default" tag was removed
                     so it lives in one place, consistent with the model catalog. -->
              </div>
              <div class="lu-prow-url">{{ p.baseUrl }}</div>
              <!-- Warm-on-startup (2026-07-21, user "in the card below http"): the
                   load-default-model-into-VRAM knob lives INSIDE the built-in provider's
                   card, right under its URL — not in Edit, not above the card. Built-in
                   only (it's the local engine's knob). Shared control bound to useEngine. -->
              <LuWarmStartupToggle v-if="isBuiltin(p)" class="lu-warmbar" />
              <!-- ONE meta line for every row. The built-in needs no API key, so the key
                   clause is the ONE part it drops — "no key" on a provider that requires
                   none reads as a missing setting rather than a fact. Separators LEAD each
                   clause (not trail), so dropping any one clause can't strand a dangling
                   "·" and a new clause is added in exactly one place. -->
              <div class="lu-prow-meta">
                <template v-if="p.defaultModel">chat: <b>{{ p.defaultModel }}</b></template>
                <template v-if="p.embeddingModel"><template v-if="p.defaultModel"> · </template>embed: <b>{{ p.embeddingModel }}</b></template>
                <template v-if="!isBuiltin(p)"><template v-if="p.defaultModel || p.embeddingModel"> · </template>{{ p.hasApiKey ? "API key set" : "no key" }}</template>
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
        <div v-if="!loading && !shownProviders.length" class="lu-pempty">
          <template v-if="providerScope === 'local'">No local providers yet. Click “Add provider” and point at <span class="lu-mono">http://localhost:…</span></template>
          <template v-else>No cloud providers. Click “Add provider” and paste a key from OpenAI / Anthropic / OpenRouter.</template>
        </div>

        <!-- B2-9 (§7.2): the set-as-default confirm — ONE flow for every provider.
             Apply branch when the row has a chat model; else the guard branch
             (built-in: "pick manually or run Quick Setup" — the user's recorded
             offer; other rows: set the Default model in Edit first). -->
        <AppModal v-if="setDefaultFor" title="Set as default provider" :max-width="'480px'" @close="setDefaultFor = null">
          <template v-if="sdModel">
            <p class="lu-sd-line"><b>{{ setDefaultFor.name || setDefaultFor.id }}</b> becomes the default for your AI tasks — they run on <b>{{ sdModel }}</b>.</p>
            <!-- QC-21: the built-in's embedding lives in the routing default already —
                 say so instead of the false "no embedding model set". The WHOLE embed
                 block hides in a no-embeddings host (llmUiCapabilities — the docgen
                 "we dont use embedding" report, gated 2026-08-04). -->
            <template v-if="embedsOn">
              <p v-if="sdEmbedModel && sdIsBuiltin" class="lu-sd-line lu-muted">Your embedding (<b>{{ sdEmbedModel }}</b>) already runs here — unchanged.</p>
              <p v-else-if="sdEmbedModel" class="lu-sd-line lu-muted">Also becomes the embeddings (search) provider: <b>{{ sdEmbedModel }}</b>.</p>
              <!-- ONLINE row with no embedding of its own → the Book-search section
                   (2026-07-18): truthful "unchanged" line when an embedding already
                   routes; otherwise recommend the local setup (engine + embed model,
                   shared DownloadBars, cancel free) / a configured Ollama / skip —
                   skipping is passive, Apply never blocks, chat runs bible-only. -->
              <LuBookSearchSetup v-else-if="!sdIsBuiltin" :providers="providers" />
              <p v-else class="lu-sd-line lu-muted">Search embeddings keep their current provider — this provider has no embedding model set.</p>
            </template>
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
      <FeatureWorkbench v-if="tab === 'features'" :run-stream="props.runStream" :data-links="props.dataLinks" />
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
        <!-- Both breakdowns are the SAME table with a different first-column label, so they
             share one column config (usageColumns) on the shared UiTable rather than being
             two hand-rolled copies. Sorting comes with it — "which feature costs the most"
             is the question this panel exists to answer, and it used to need a spreadsheet. -->
        <div class="lu-usage-section">
          <div class="lu-usage-h">By feature</div>
          <UiTable class="lu-utable" :data="usageView.feat" :columns="usageColumns('Feature')"
            data-key="key" :default-sort="{ id: 'calls', desc: true }">
            <template #calls="{ row }">{{ row.calls.toLocaleString() }}</template>
            <template #prompt="{ row }">{{ row.prompt.toLocaleString() }}</template>
            <template #completion="{ row }">{{ row.completion.toLocaleString() }}</template>
            <template #cost="{ row }">{{ fmtUsd(row.cost) }}</template>
          </UiTable>
        </div>
        <div class="lu-usage-section">
          <div class="lu-usage-h">By provider</div>
          <UiTable class="lu-utable" :data="usageView.prov" :columns="usageColumns('Provider')"
            data-key="key" :default-sort="{ id: 'calls', desc: true }">
            <template #calls="{ row }">{{ row.calls.toLocaleString() }}</template>
            <template #prompt="{ row }">{{ row.prompt.toLocaleString() }}</template>
            <template #completion="{ row }">{{ row.completion.toLocaleString() }}</template>
            <template #cost="{ row }">{{ fmtUsd(row.cost) }}</template>
          </UiTable>
        </div>
      </template>
      <div v-else class="lu-card lu-usage-empty lu-muted">No usage recorded yet.</div>
      <PricingEditor v-if="tab === 'usage'" />
    </section>

    <!-- ── AI engine console — live follow of the server log ring + the engine
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

/* naked control — the host wraps it in its own page card (.pane-card in JW) */
.lu-pcard-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.lu-pcard-title { font-weight: 700; font-size: 14px; color: var(--ink); }
.lu-pcard-count { font-size: 12px; }
.lu-pcard-head .lu-btn { margin-left: auto; }
.lu-plus { font-weight: 700; }

/* The Local/Online tab strip. The kit's connected UiSegmented flexes its buttons,
   so the caller owns the row width (a full-width strip over a wide provider list
   reads as a banner, not a control). */
.lu-scope { display: flex; margin: 10px 0 4px; max-width: 520px; }
.lu-warmbar { margin: 6px 0 0; }

.lu-prow {
  /* 4 columns: icon · info · status · the ONE actions cell (Test/Edit + the Built-in
     row's engine buttons live INSIDE it — loose grid children wrapped to a new row). */
  display: grid; grid-template-columns: auto minmax(0,1fr) auto auto; gap: 14px; align-items: center;
  padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); margin-top: 8px;
}
.lu-prow-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
/* B2-9 set-as-default confirm — body lines above the overwrite choice. */
.lu-sd-line { margin: 0 0 10px; }
/* The Quick-Setup band, lifted out of the (now deleted) promoted built-in card
   2026-07-19 — it keeps the same seating that card gave it: its own centered row
   at the top of the Local scope, closed by a rule. */
.lu-qs-band { padding-bottom: 14px; border-bottom: 1px solid var(--border); margin-bottom: 14px; text-align: center; }
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
/* These two breakdowns are the shared UiTable now, so the table mechanics (layout, header
   chrome, sort caret) come from common/styles.css. What is left here is what is specific to a
   usage ledger: figures right-aligned and tabular so digits line up down the column, with the
   name column left and emphasised. `:deep` because the table markup belongs to UiTable. */
.lu-utable :deep(.ui-table) { font-size: 12.5px; }
.lu-utable :deep(th) { text-align: right; }
.lu-utable :deep(th:first-child), .lu-utable :deep(td:first-child) { text-align: left; }
.lu-utable :deep(tbody td) { text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--border); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.lu-utable :deep(tbody td:first-child) { color: var(--ink); font-weight: 600; }
.lu-utable :deep(tbody tr:last-child td) { border-bottom: 0; }
</style>
