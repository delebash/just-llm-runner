<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared Quick Setup — a MODAL WIZARD (the old JustWrite quick-setup concept,
// rebuilt for the current shared stack). Restores what the old static card lost:
// a stepped modal, EDITABLE per-role picks, a card/VRAM chooser, and an apply
// that downloads + loads. On the current stack it uses the shared runner
// endpoints (/v1/llm-runner/*) + the routing endpoint (/v1/ai/routing) — NOT the
// old Ollama-pull path — and the kit components (AppModal/UiSelect/UiButton/Icon)
// instead of the old Jw* forks. Both apps mount it (it's exported from the kit).
//
// Steps: detect -> confirm (edit the picks) -> apply (download+load) -> done.
// Picks persist in the DB via /v1/ai/routing; the curated recommendation defaults
// + the manual editor are a SQL-backed layer added next (this version pre-fills
// from the runner's Fit estimate).
import { computed, ref } from "vue";

import { request } from "../client.js";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import UiTag from "../common/components/UiTag.vue";
import AppModal from "../common/components/AppModal.vue";

const emit = defineEmits(["changed"]);

const LOCAL_RUNNER_ID = "local-llamacpp";
const FIT_RUNNABLE = new Set(["ok", "tight", "cpu"]);
const FIT_LABEL = { ok: "Fits", tight: "Tight", cpu: "CPU", no: "Won't fit", unknown: "—" };

// Role rows the wizard renders. `job` keys into /v1/ai/recommendations rows
// (the curated 'this model is good FOR' layer); `fallback` is the heuristic to
// use when no recommendation exists for that job (smallest/largest fitting).
// `blurb` is the per-role description shown under the picker — what the role
// actually handles in the app, so the user knows what they're choosing.
const ROLE_DEFS = [
  {
    key: "default",
    job: "accuracy",       // default = "main brain", borrow the accuracy curated list
    fallback: "largest",
    label: "Default model",
    blurb: "The main model — runs every feature that isn't pinned to Quick, Accuracy, or a specific provider. Pick the strongest model that fits comfortably.",
  },
  {
    key: "quick",
    job: "quick",
    fallback: "smallest",
    label: "Quick role",
    blurb: "Snappy / interactive work — brainstorm, inline rewrites, quick drafts, recaps. Picks a small model so responses feel instant.",
  },
  {
    key: "accuracy",
    job: "accuracy",
    fallback: "largest",
    label: "Accuracy role",
    blurb: "Careful passes — critique, plot-hole audit, multi-reader, extraction. Picks the strongest model that fits, accepts a slower response for higher quality.",
  },
];

// ── modal + wizard state ────────────────────────────────────────────────────
const open = ref(false);
const step = ref("detect"); // detect | confirm | apply | done
const loading = ref(true);
const error = ref("");

const hw = ref(null);
const models = ref([]);
const recommendations = ref([]); // /v1/ai/recommendations rows — the Q3 curated layer
const detectedVramMb = ref(0);
// Card/VRAM override — re-scores Fit for a card other than this machine's.
const cardOverride = ref("auto");
const CARD_OPTIONS = [
  { value: "auto", label: "This machine" },
  { value: "0", label: "CPU only (no GPU)" },
  { value: "8192", label: "8 GB card" },
  { value: "12288", label: "12 GB card" },
  { value: "16384", label: "16 GB card" },
  { value: "24576", label: "24 GB card" },
];

// Editable per-role picks (model ids). Pre-filled from Fit, fully overridable.
const pick = ref({ default: "", quick: "", accuracy: "", embeddingId: "", embeddingModel: "" });

// ── derived ─────────────────────────────────────────────────────────────────
function paramsNum(p) {
  const n = Number.parseFloat(String(p || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 999;
}
const fitting = computed(() =>
  models.value
    .filter((m) => FIT_RUNNABLE.has(m.fit))
    .sort((a, b) => paramsNum(a.params) - paramsNum(b.params)),
);
const modelById = computed(() => Object.fromEntries(models.value.map((m) => [m.id, m])));
// One <option> per catalog model, Fit annotated, so a role can pick any of them.
const modelOptions = computed(() =>
  models.value.map((m) => ({
    value: m.id,
    label: `${m.name} · ${FIT_LABEL[m.fit] || "—"}${m.params ? ` · ${m.params}` : ""}`,
  })),
);

const hwLine = computed(() => {
  const h = hw.value;
  if (!h) return "";
  const g = h.gpus && h.gpus[0];
  const vram = g?.vramMb ? ` · ${Math.round(g.vramMb / 1024)} GB VRAM` : "";
  const ram = h.ramMb ? ` · ${Math.round(h.ramMb / 1024)} GB RAM` : "";
  const os = h.platform ? ` · ${h.platform}` : "";
  return `${g ? g.name : "CPU only"}${vram}${ram}${os}`;
});
function fitOf(id) {
  return modelById.value[id]?.fit || "unknown";
}

// ── load hardware + catalog + recommendations (optionally for an overridden card)
async function loadAll() {
  loading.value = true;
  error.value = "";
  try {
    const vramQ = cardOverride.value === "auto" ? "" : `?vram_mb=${cardOverride.value}`;
    const [h, m, r] = await Promise.all([
      request("/v1/llm-runner/hardware"),
      request(`/v1/llm-runner/models${vramQ}`),
      request("/v1/ai/recommendations").catch(() => ({ rows: [] })), // optional — older servers
    ]);
    hw.value = h;
    models.value = m.models || [];
    recommendations.value = r.rows || [];
    detectedVramMb.value = (h.gpus && h.gpus[0]?.vramMb) || 0;
    prefillRoles();
  } catch (e) {
    error.value = `Couldn't read hardware / catalog: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

// Pre-fill each role from curated recommendations (filter by job + Fit-OK, rank
// ascending). If no recommendation fits the user's card for that job, fall back
// to the role's heuristic (smallest/largest fitting model). Editable either way.
function prefillRoles() {
  const fittingIds = new Set(fitting.value.map((m) => m.id));
  for (const role of ROLE_DEFS) {
    if (pick.value[role.key]) continue;  // never overwrite a user pick
    // 1. curated recommendation: rows matching this job, only models that fit.
    const recs = recommendations.value
      .filter((row) => row.job === role.job && fittingIds.has(row.modelId))
      .sort((a, b) => (a.rank ?? 100) - (b.rank ?? 100));
    if (recs.length) { pick.value[role.key] = recs[0].modelId; continue; }
    // 2. heuristic fallback by role.
    const good = fitting.value.filter((m) => m.fit === "ok" || m.fit === "tight");
    const pool = good.length ? good : fitting.value;
    const candidate = role.fallback === "smallest" ? pool[0] : pool[pool.length - 1];
    pick.value[role.key] = candidate?.id || "";
  }
}

// Curated "why" line for the chosen model under a role — for the inline blurb.
function whyFor(roleKey) {
  const role = ROLE_DEFS.find((r) => r.key === roleKey);
  if (!role) return "";
  const chosen = pick.value[roleKey];
  if (!chosen) return "";
  const rec = recommendations.value.find((row) => row.job === role.job && row.modelId === chosen);
  return rec?.why || "";
}

async function loadRouting() {
  try {
    const r = await request("/v1/ai/routing");
    pick.value.embeddingId = r.default?.embeddingId || "";
    pick.value.embeddingModel = r.default?.embeddingModel || "";
  } catch {
    /* routing may be empty on a fresh install — leave embedding blank */
  }
}

// ── open / close ────────────────────────────────────────────────────────────
async function openWizard() {
  open.value = true;
  step.value = "detect";
  pick.value = { default: "", quick: "", accuracy: "", embeddingId: "", embeddingModel: "" };
  await Promise.all([loadAll(), loadRouting()]);
  step.value = fitting.value.length ? "confirm" : "confirm"; // confirm shows the empty-state if none fit
}
function onModalClose() {
  open.value = false;
}
async function onCardChange() {
  // Re-score Fit for the chosen card, then re-pick (clear picks so prefill runs).
  pick.value.default = pick.value.quick = pick.value.accuracy = "";
  await loadAll();
}

// ── apply: persist routing (DB) + download/load the default model ────────────
const applying = ref(false);
const applyDetail = ref("");
async function apply() {
  applying.value = true;
  error.value = "";
  step.value = "apply";
  try {
    // Merge into existing routing: keep current per-feature pins, set default +
    // both roles to the bundled runner with the chosen models, carry embedding.
    const r = await request("/v1/ai/routing");
    const pins = {};
    for (const f of r.features || []) {
      if (f.providerId || f.role) pins[f.key] = { providerId: f.providerId, model: f.model, role: f.role };
    }
    await request("/v1/ai/routing", {
      method: "PUT",
      body: {
        default: {
          llmId: LOCAL_RUNNER_ID,
          model: pick.value.default,
          embeddingId: pick.value.embeddingId || "",
          embeddingModel: pick.value.embeddingModel || "",
        },
        quick: { providerId: LOCAL_RUNNER_ID, model: pick.value.quick },
        accuracy: { providerId: LOCAL_RUNNER_ID, model: pick.value.accuracy || pick.value.default },
        pins,
      },
    });
    // Download (if needed) + load the default model as the active one, polling
    // status so the user sees progress (the Accuracy model downloads on first use).
    const target = pick.value.default || pick.value.quick;
    if (target) {
      await request("/v1/llm-runner/load", { method: "POST", body: { modelId: target } });
      await pollLoad();
    }
    step.value = "done";
    emit("changed");
  } catch (e) {
    error.value = `Apply failed: ${e.message}`;
    step.value = "confirm";
  } finally {
    applying.value = false;
  }
}

async function pollLoad() {
  for (let i = 0; i < 600; i++) {
    let st;
    try {
      st = await request("/v1/llm-runner/status");
    } catch {
      return;
    }
    applyDetail.value = st.detail || st.status || "";
    if (st.status === "running") return;
    if (st.status === "error") {
      error.value = st.error || "Model failed to load.";
      return;
    }
    await new Promise((res) => setTimeout(res, 1200));
  }
}

defineExpose({ openWizard });
</script>

<template>
  <div class="lu-qs">
    <!-- Trigger (replaces the old inline card; opens the wizard) -->
    <div class="lu-qs-head">
      <div>
        <b class="lu-qs-title">Quick Setup</b>
        <span class="lu-muted lu-qs-sub">Detect your hardware, pick free local models that fit, and set your routing — all editable.</span>
      </div>
      <UiButton intent="primary" size="small" @click="openWizard">Run Quick Setup</UiButton>
    </div>

    <AppModal
      v-if="open"
      eyebrow="Local LLM"
      :title="step === 'detect' ? 'Probing your hardware…' : step === 'apply' ? 'Setting up…' : step === 'done' ? 'All set' : 'Recommended setup'"
      :max-width="'640px'"
      :closable="step !== 'apply'"
      @close="onModalClose"
    >
      <!-- DETECT -->
      <div v-if="step === 'detect'" class="lu-muted lu-qs-loading">Reading GPU + model catalog…</div>

      <!-- CONFIRM (editable) -->
      <template v-else-if="step === 'confirm'">
        <div v-if="error" class="lu-error">{{ error }}</div>

        <section class="lu-qs-sec">
          <div class="lu-qs-k">Detected</div>
          <div class="lu-qs-detected"><b>{{ hwLine }}</b></div>
        </section>

        <section class="lu-qs-sec">
          <div class="lu-qs-k">Plan for card</div>
          <UiSelect v-model="cardOverride" :options="CARD_OPTIONS" @update:model-value="onCardChange" />
          <p class="lu-muted lu-qs-hint">Re-scores Fit for another card — plan ahead, or force CPU-only.</p>
        </section>

        <div v-if="loading" class="lu-muted">Re-scoring…</div>
        <template v-else-if="fitting.length">
          <!-- Each role gets its own labelled section with a real description
               of what it handles + the Fit chip inline. Stacked, not crammed
               into a single row (the old JW shape). -->
          <section v-for="r in ROLE_DEFS" :key="r.key" class="lu-qs-sec">
            <div class="lu-qs-k">
              {{ r.label }}
              <span class="lu-fit lu-qs-fit" :class="`lu-fit--${fitOf(pick[r.key])}`">{{ FIT_LABEL[fitOf(pick[r.key])] }}</span>
            </div>
            <UiSelect v-model="pick[r.key]" :options="modelOptions" />
            <p class="lu-muted lu-qs-hint">{{ r.blurb }}</p>
            <p v-if="whyFor(r.key)" class="lu-qs-why">
              <b>Why this pick:</b> {{ whyFor(r.key) }}
            </p>
          </section>

          <!-- What will happen on Apply — mirrors the old JW Routing summary. -->
          <section class="lu-qs-sec lu-qs-routing">
            <div class="lu-qs-k">What happens when you click Apply</div>
            <ul class="lu-qs-rlist">
              <li v-if="modelById[pick.default]"><b>{{ modelById[pick.default].name }}</b> <span class="lu-muted">— default for everything not pinned to Quick or Accuracy.</span></li>
              <li v-if="modelById[pick.quick] && pick.quick !== pick.default"><b>{{ modelById[pick.quick].name }}</b> <span class="lu-muted">— Quick role (snappy/interactive features).</span></li>
              <li v-if="modelById[pick.accuracy] && pick.accuracy !== pick.default"><b>{{ modelById[pick.accuracy].name }}</b> <span class="lu-muted">— Accuracy role (careful analysis / extraction).</span></li>
              <li>Default model <b>downloads now</b> if it isn't already on disk; the others download on first use.</li>
              <li>Embedding stays as set in Providers<span v-if="pick.embeddingModel"> (currently <code>{{ pick.embeddingModel }}</code>)</span>.</li>
              <li>Per-feature pins you've set stay as they are — this only touches the global default + the two roles.</li>
            </ul>
          </section>
        </template>
        <div v-else class="lu-muted lu-qs-empty">
          No catalog models fit this card. Pick a larger card above, add a smaller model, or connect a cloud provider in Providers.
        </div>
      </template>

      <!-- APPLY -->
      <template v-else-if="step === 'apply'">
        <p class="lu-qs-applying">Saving routing and loading <b>{{ modelById[pick.default]?.name || pick.default }}</b>…</p>
        <p class="lu-muted">{{ applyDetail || "working…" }}</p>
      </template>

      <!-- DONE -->
      <template v-else-if="step === 'done'">
        <p><b>Setup applied.</b></p>
        <ul class="lu-qs-summary">
          <li>Default · <code>{{ modelById[pick.default]?.name || pick.default }}</code></li>
          <li>Quick · <code>{{ modelById[pick.quick]?.name || pick.quick }}</code></li>
          <li>Accuracy · <code>{{ modelById[pick.accuracy]?.name || pick.accuracy }}</code></li>
        </ul>
        <p class="lu-muted">Tune any of this per feature in the Features tab.</p>
      </template>

      <template #footer>
        <template v-if="step === 'confirm'">
          <UiButton intent="ghost" @click="onModalClose">Cancel</UiButton>
          <span class="lu-qs-spacer" />
          <UiButton intent="primary" :disabled="!fitting.length || !pick.default" :loading="applying" @click="apply">
            Apply setup
          </UiButton>
        </template>
        <template v-else-if="step === 'done'">
          <span class="lu-qs-spacer" />
          <UiButton intent="primary" @click="onModalClose">Close</UiButton>
        </template>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.lu-qs { border: 1px solid var(--border); border-radius: var(--r-md, 10px); background: var(--surface); padding: 12px 16px; }
.lu-qs-head { display: flex; align-items: center; gap: 12px; }
.lu-qs-head > div { flex: 1; min-width: 0; }
.lu-qs-title { font-size: 14px; color: var(--ink); }
.lu-qs-sub { font-size: 11.5px; margin-left: 8px; }
.lu-qs-loading { text-align: center; padding: 24px 0; }
.lu-qs-sec { margin-bottom: 18px; }
.lu-qs-k {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); margin-bottom: 8px; font-weight: 700;
  display: flex; align-items: center; gap: 8px;
}
.lu-qs-fit { margin-left: auto; }
.lu-qs-detected { font-size: 13px; color: var(--ink-2); }
.lu-qs-hint { font-size: 11.5px; line-height: 1.55; margin: 6px 0 0; }
.lu-qs-why {
  font-size: 12px; line-height: 1.5; margin: 8px 0 0;
  padding: 8px 10px; background: var(--surface-2); border-radius: 6px;
  color: var(--ink-2); border-left: 2px solid var(--accent);
}
.lu-qs-why b { color: var(--ink); }
.lu-qs-routing { background: var(--surface-2); padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border); }
.lu-qs-rlist { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; line-height: 1.45; }
.lu-qs-rlist li { padding-left: 14px; position: relative; }
.lu-qs-rlist li::before { content: "•"; position: absolute; left: 0; color: var(--muted); }
.lu-qs-rlist code { font-family: var(--font-mono, monospace); font-size: 11.5px; }
.lu-qs-empty { font-size: 12.5px; padding: 8px 0; }
.lu-qs-applying { font-size: 13px; }
.lu-qs-summary { margin: 8px 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.lu-qs-spacer { flex: 1; }
.lu-fit { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 10.5px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); flex: none; }
.lu-fit--ok { background: var(--accent-soft); border-color: var(--accent-line, var(--accent)); color: var(--accent-ink, var(--accent)); }
.lu-fit--tight { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }
.lu-fit--no { background: var(--danger-bg, #f7e7e4); border-color: var(--danger-line, var(--danger)); color: var(--danger); }
.lu-fit--cpu, .lu-fit--unknown { background: var(--surface-3); }
</style>
