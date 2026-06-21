<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// The bundled-runner model catalog (from the shared-ai-models mock's
// modelsSection) — shown inside the built-in "llama.cpp" provider's form. Lists
// the manifest models with a hardware Fit estimate + on-disk/loaded status, and
// loads/unloads them via the runner endpoints. Self-contained on the shared
// client; token-styled (lu-*) so it renders native in either app.
//
// Scope (vs the mock): this catalog backs the BUNDLED runner only — it's the one
// provider with a manifest + VRAM-fit + HF-GGUF download/spawn lifecycle
// (/v1/llm-runner/*). Ollama / LM Studio manage their own models, so they keep
// the Fetch-models combobox instead of this table (a documented divergence).
import { computed, onUnmounted, ref } from "vue";

import { request } from "../client.js";
import LuButton from "./LuButton.vue";

const data = ref(null);
const loading = ref(true);
const error = ref("");
const detail = ref(""); // live status detail while a model is loading
const busy = ref(""); // model id whose action is in flight (button feedback)
let timer = null;

const models = computed(() => data.value?.models || []);
const vramMb = computed(() => data.value?.vramMb || 0);
const anyLoading = computed(() => models.value.some((m) => m.status === "loading"));

const FIT_LABEL = { ok: "Fits", tight: "Tight", no: "Won't fit", cpu: "CPU", unknown: "—" };
const gb = (mb) => (mb >= 10240 ? `${Math.round(mb / 1024)}` : `${(mb / 1024).toFixed(1)}`);
function fitLabel(m) {
  return FIT_LABEL[m.fit] || "—";
}
function fitTitle(m) {
  if (m.fit === "cpu") return "No GPU detected — runs on CPU (slower).";
  if (m.fit === "unknown") return "VRAM requirement unknown for this model.";
  if (!m.minVramMb) return "";
  const have = vramMb.value ? ` · you have ${gb(vramMb.value)} GB` : "";
  return `needs ~${gb(m.minVramMb)} GB VRAM${have}`;
}
function sizeLabel(m) {
  if (!m.params) return "—";
  return m.activeParams ? `${m.params} · ${m.activeParams} active` : m.params;
}

async function refresh() {
  try {
    data.value = await request("/v1/llm-runner/models");
    error.value = "";
    if (anyLoading.value) {
      try {
        const st = await request("/v1/llm-runner/status");
        detail.value = st.detail || (st.status === "downloading" ? "downloading…" : "starting…");
      } catch {
        detail.value = "";
      }
      startPoll();
    } else {
      detail.value = "";
      stopPoll();
    }
  } catch (e) {
    error.value = e.message || "Couldn't load the model catalog.";
  } finally {
    loading.value = false;
  }
}

function startPoll() {
  if (timer) return;
  timer = setInterval(refresh, 1500);
}
function stopPoll() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function load(m) {
  busy.value = m.id;
  try {
    await request("/v1/llm-runner/load", { method: "POST", body: { modelId: m.id } });
    await refresh();
  } catch (e) {
    error.value = e.message || "Load failed.";
  } finally {
    busy.value = "";
  }
}
async function unload() {
  busy.value = "stop";
  try {
    await request("/v1/llm-runner/stop", { method: "POST" });
    await refresh();
  } catch (e) {
    error.value = e.message || "Unload failed.";
  } finally {
    busy.value = "";
  }
}

refresh();
onUnmounted(stopPoll);
</script>

<template>
  <div class="lu-mcat">
    <div class="lu-mcat-head">
      Models — <b>Fit</b> estimates how well each runs on your GPU · downloaded models load on first use
    </div>

    <div v-if="error" class="lu-error lu-mcat-err">{{ error }}</div>
    <div v-else-if="loading" class="lu-mcat-empty">Loading catalog…</div>
    <div v-else-if="!models.length" class="lu-mcat-empty">No models in the catalog.</div>

    <div v-else class="lu-mcat-wrap">
      <table class="lu-mgrid">
        <thead>
          <tr><th>Model</th><th>Params</th><th>Fit</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="m in models" :key="m.id">
            <td class="lu-mn">{{ m.name }}<div class="lu-mid">{{ m.id }}</div></td>
            <td class="lu-mm">{{ sizeLabel(m) }}</td>
            <td>
              <span class="lu-fit" :class="`lu-fit--${m.fit}`" :title="fitTitle(m)">{{ fitLabel(m) }}</span>
            </td>
            <td>
              <span v-if="m.status === 'loaded'" class="lu-pill lu-pill--run">● loaded</span>
              <span v-else-if="m.status === 'loading'" class="lu-pill lu-pill--load">{{ detail || "loading…" }}</span>
              <span v-else-if="m.status === 'error'" class="lu-mstat lu-mstat--err">failed</span>
              <span v-else-if="m.status === 'disk'" class="lu-pill lu-pill--disk">on disk</span>
              <span v-else class="lu-mstat">not downloaded</span>
            </td>
            <td class="lu-mact">
              <LuButton v-if="m.status === 'loaded'" intent="secondary" size="small"
                :loading="busy === 'stop'" @click="unload">Unload</LuButton>
              <span v-else-if="m.status === 'loading'" class="lu-muted lu-mwait">working…</span>
              <LuButton v-else-if="m.status === 'error'" intent="secondary" size="small"
                :loading="busy === m.id" @click="load(m)">Retry</LuButton>
              <LuButton v-else-if="m.status === 'disk'" intent="primary" size="small"
                :loading="busy === m.id" @click="load(m)">Load</LuButton>
              <LuButton v-else-if="m.fit === 'no'" intent="secondary" size="small" :disabled="true">Too large</LuButton>
              <LuButton v-else intent="primary" size="small"
                :loading="busy === m.id" @click="load(m)">Download &amp; load</LuButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="lu-muted lu-mcat-foot">
      Models download from
      <a class="lu-mlink" href="https://huggingface.co/models?library=gguf" target="_blank" rel="noopener">Hugging Face ↗</a>
      — the open model hub. One model loads at a time; loading a new one replaces the running one.
    </div>
  </div>
</template>

<style scoped>
.lu-mcat { margin-top: 14px; }
.lu-mcat-head { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.lu-mcat-head b { color: var(--ink-2); }
.lu-mcat-err { margin-bottom: 8px; }
.lu-mcat-empty { font-size: 12.5px; color: var(--muted); padding: 14px; text-align: center; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm, 8px); }
.lu-mcat-wrap { max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-sm, 8px); background: var(--surface); }
.lu-mgrid { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.lu-mgrid th {
  position: sticky; top: 0; z-index: 1; background: var(--surface-2); text-align: left;
  font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
  font-weight: 700; padding: 7px 11px; border-bottom: 1px solid var(--border);
}
.lu-mgrid td { padding: 8px 11px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.lu-mgrid tr:last-child td { border-bottom: 0; }
.lu-mn { font-weight: 600; color: var(--ink); min-width: 150px; }
.lu-mid { font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--muted); font-weight: 400; margin-top: 1px; }
.lu-mm { color: var(--ink-2); white-space: nowrap; }
.lu-mact { text-align: right; white-space: nowrap; }
.lu-mwait { font-size: 11px; }

.lu-fit {
  display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 9px;
  font-size: 11px; font-weight: 700; border: 1px solid var(--border-strong); color: var(--ink-2); background: var(--surface);
}
.lu-fit--ok { background: var(--accent-soft); border-color: var(--accent-line, var(--accent)); color: var(--accent-ink, var(--accent)); }
.lu-fit--tight { background: var(--gold-soft, #f5edda); border-color: var(--gold-line, #e2d2b0); color: var(--gold, #b08a3e); }
.lu-fit--no { background: var(--danger-bg, #f7e7e4); border-color: var(--danger-line, var(--danger)); color: var(--danger); }
.lu-fit--cpu, .lu-fit--unknown { background: var(--surface-3); }

.lu-pill { font-size: 10px; font-weight: 700; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
.lu-pill--run { background: var(--accent); color: var(--on-accent, #fff); }
.lu-pill--load { background: var(--gold-soft, #f5edda); color: var(--gold, #b08a3e); border: 1px solid var(--gold-line, #e2d2b0); }
.lu-pill--disk { background: var(--surface-3); color: var(--ink-2); border: 1px solid var(--border); }
.lu-mstat { font-size: 11px; color: var(--muted); }
.lu-mstat--err { color: var(--danger); }

.lu-mcat-foot { font-size: 11px; margin-top: 7px; }
.lu-mlink { color: var(--accent-ink, var(--accent)); }
</style>
