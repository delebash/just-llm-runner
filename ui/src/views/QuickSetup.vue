<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared Quick Setup — one-click local bootstrap, Fit-based (the mock's design;
// an improvement over JW's old static GB-tier recipes). Reads detected hardware
// + the runner catalog, recommends a fast "Quick" model and a careful "Accuracy"
// model that fit this machine, and on Apply sets the default + Quick/Accuracy
// roles via /v1/ai/routing and downloads+loads the Quick model. Built on the
// shared runner endpoints, so both apps get the same wizard (replacing the
// per-app Ollama-pull versions; Ollama stays addable via the provider form).
import { computed, ref } from "vue";

import { request } from "../client.js";
import LuButton from "../components/LuButton.vue";

const LOCAL_RUNNER_ID = "local-llamacpp";

const open = ref(false);
const loading = ref(true);
const error = ref("");
const hw = ref(null);
const models = ref([]);
const applying = ref(false);
const applied = ref(false);

// Models that will run here: ok/tight on a GPU, or cpu (no GPU but RAM is enough).
const FIT_RUNNABLE = new Set(["ok", "tight", "cpu"]);
function paramsNum(p) {
  const n = Number.parseFloat(String(p || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 999;
}
const fitting = computed(() =>
  models.value.filter((m) => FIT_RUNNABLE.has(m.fit)).sort((a, b) => paramsNum(a.params) - paramsNum(b.params)),
);
// Quick = smallest that fits (snappiest). Accuracy = largest that fits well
// (prefer real GPU fit over cpu-only), for the careful passes.
const quickPick = computed(() => fitting.value[0] || null);
const accuracyPick = computed(() => {
  const good = fitting.value.filter((m) => m.fit === "ok" || m.fit === "tight");
  const pool = good.length ? good : fitting.value;
  return pool[pool.length - 1] || null;
});

const hwLine = computed(() => {
  const h = hw.value;
  if (!h) return "";
  const g = h.gpus && h.gpus[0];
  const vram = g?.vramMb ? ` · ${Math.round(g.vramMb / 1024)} GB VRAM` : "";
  const ram = h.ramMb ? ` · ${Math.round(h.ramMb / 1024)} GB RAM` : "";
  return `${g ? g.name : "CPU only"}${vram}${ram}`;
});

async function loadAll() {
  loading.value = true;
  error.value = "";
  applied.value = false;
  try {
    const [h, m] = await Promise.all([
      request("/v1/llm-runner/hardware"),
      request("/v1/llm-runner/models"),
    ]);
    hw.value = h;
    models.value = m.models || [];
  } catch (e) {
    error.value = `Couldn't read hardware / catalog: ${e.message}`;
  } finally {
    loading.value = false;
  }
}
function toggle() {
  open.value = !open.value;
  if (open.value) loadAll();
}

const FIT_LABEL = { ok: "Fits", tight: "Tight", cpu: "CPU", no: "Won't fit", unknown: "—" };

async function apply() {
  if (!quickPick.value) return;
  applying.value = true;
  error.value = "";
  try {
    // Merge into current routing: set default + both roles to the bundled runner.
    const r = await request("/v1/ai/routing");
    const pins = {};
    for (const f of r.features || []) {
      if (f.providerId || f.role) pins[f.key] = { providerId: f.providerId, model: f.model, role: f.role };
    }
    await request("/v1/ai/routing", {
      method: "PUT",
      body: {
        default: { llmId: LOCAL_RUNNER_ID, embeddingId: r.default?.embeddingId || "" },
        quick: { providerId: LOCAL_RUNNER_ID, model: quickPick.value.id },
        accuracy: { providerId: LOCAL_RUNNER_ID, model: (accuracyPick.value || quickPick.value).id },
        pins,
      },
    });
    // Download (if needed) + load the Quick model as the active one. Heavy +
    // GPU/network-gated; the Accuracy model is downloadable from the catalog.
    await request("/v1/llm-runner/load", { method: "POST", body: { modelId: quickPick.value.id } });
    applied.value = true;
  } catch (e) {
    error.value = `Apply failed: ${e.message}`;
  } finally {
    applying.value = false;
  }
}

defineEmits(["changed"]);
</script>

<template>
  <div class="lu-qs">
    <div class="lu-qs-head">
      <div>
        <b class="lu-qs-title">Quick Setup</b>
        <span class="lu-muted lu-qs-sub">Reads your hardware and picks free local models that fit, then sets your routing.</span>
      </div>
      <LuButton intent="secondary" size="small" @click="toggle">
        {{ open ? "Hide" : "Recommend for my hardware" }} {{ open ? "▴" : "▾" }}
      </LuButton>
    </div>

    <div v-if="open" class="lu-qs-body">
      <div v-if="error" class="lu-error">{{ error }}</div>
      <div v-else-if="loading" class="lu-muted">Reading hardware…</div>

      <template v-else>
        <div class="lu-qs-row"><span class="lu-qs-k">Detected</span> <b>{{ hwLine }}</b></div>

        <div v-if="quickPick" class="lu-qs-picks">
          <div class="lu-qs-pick">
            <span class="lu-rchip lu-rchip--quick">QUICK</span>
            <b>{{ quickPick.name }}</b>
            <span class="lu-fit" :class="`lu-fit--${quickPick.fit}`">{{ FIT_LABEL[quickPick.fit] }}</span>
            <span class="lu-muted">{{ quickPick.params }} · snappy / interactive</span>
          </div>
          <div class="lu-qs-pick">
            <span class="lu-rchip lu-rchip--accuracy">ACCURACY</span>
            <b>{{ (accuracyPick || quickPick).name }}</b>
            <span class="lu-fit" :class="`lu-fit--${(accuracyPick || quickPick).fit}`">{{ FIT_LABEL[(accuracyPick || quickPick).fit] }}</span>
            <span class="lu-muted">{{ (accuracyPick || quickPick).params }} · careful passes</span>
          </div>
          <div class="lu-muted lu-qs-note">
            Apply sets <b>Default + Quick + Accuracy</b> to the built-in engine and downloads + loads the Quick model
            (the Accuracy model can be downloaded from the catalog below). Re-run any time after a hardware change — it re-scores Fit.
          </div>
          <div class="lu-qs-foot">
            <span v-if="applied" class="lu-saved">✓ Applied — routing set, Quick model loading.</span>
            <span class="lu-pf-spacer" />
            <LuButton intent="primary" :loading="applying" @click="apply">Apply setup</LuButton>
          </div>
        </div>

        <div v-else class="lu-muted lu-qs-empty">
          No local models in the catalog fit this machine. Add a smaller model, or connect a cloud provider below for the heavy work.
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lu-qs { border: 1px solid var(--border); border-radius: var(--r-md, 10px); background: var(--surface); padding: 12px 16px; }
.lu-qs-head { display: flex; align-items: center; gap: 12px; }
.lu-qs-head > div { flex: 1; min-width: 0; }
.lu-qs-title { font-size: 14px; color: var(--ink); }
.lu-qs-sub { font-size: 11.5px; margin-left: 8px; }
.lu-qs-body { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px; }
.lu-qs-row { font-size: 12.5px; color: var(--ink-2); margin-bottom: 10px; }
.lu-qs-k { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-right: 6px; }
.lu-qs-picks { display: flex; flex-direction: column; gap: 8px; }
.lu-qs-pick { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.lu-qs-pick b { color: var(--ink); }
.lu-qs-note { font-size: 11.5px; line-height: 1.5; margin-top: 4px; }
.lu-qs-empty { font-size: 12.5px; padding: 8px 0; }
.lu-qs-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.lu-pf-spacer { flex: 1; }
.lu-saved { color: var(--success, var(--accent)); font-size: 12px; font-weight: 600; }

.lu-rchip { font-size: 9.5px; font-weight: 800; letter-spacing: .04em; border-radius: 999px; padding: 2px 8px; flex: none; }
.lu-rchip--quick { background: var(--accent-soft); color: var(--accent-ink, var(--accent)); border: 1px solid var(--accent-line, var(--accent)); }
.lu-rchip--accuracy { background: var(--gold-soft, #f5edda); color: var(--gold, #b08a3e); border: 1px solid var(--gold-line, #e2d2b0); }
.lu-fit { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 10.5px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); }
.lu-fit--ok { background: var(--accent-soft); border-color: var(--accent-line, var(--accent)); color: var(--accent-ink, var(--accent)); }
.lu-fit--tight { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }
.lu-fit--no { background: var(--danger-bg, #f7e7e4); border-color: var(--danger-line, var(--danger)); color: var(--danger); }
.lu-fit--cpu, .lu-fit--unknown { background: var(--surface-3); }
</style>
