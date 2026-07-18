<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// LuBookSearchSetup — the "Book search" section of the Set-as-default dialog for an
// ONLINE provider that carries no embedding model of its own (the 2026-07-18 plan:
// the wizard SUGGESTS book search + says why it makes chat smarter; the user can
// skip — chat then answers from the story bible only, the JW bible-only mode).
//
// States (read from the routing doc on mount):
//   · an embedding is already routed (any provider) → one calm "unchanged" line;
//     setting a chat default never silently clobbers the embedding.
//   · none anywhere → the recommendation block: set up the LOCAL embedding —
//     engine install if needed + model download, riding THE shared channels
//     (useDownloadTask) + DownloadBar, so progress/cancel/retry come free — or use
//     a configured Ollama row's embedding (zero download), or skip (passively:
//     the copy states the consequence; Apply never blocks on this section).
//
// Self-healing rather than transactional: closing the dialog mid-download leaves
// the server-side fetch running; re-opening re-runs the steps (engine installed →
// skipped, weights on disk → instant done) and the routing write lands then.
// The embed pick reuses pickBestEmbedId (ONE rule — modelPick.js); next to an
// online chat default no local chat co-resides, so the full card is the budget.
import { computed, onMounted, ref } from "vue";

import DownloadBar from "../common/components/DownloadBar.vue";
import UiButton from "../common/components/UiButton.vue";
import { pickBestEmbedId } from "../common/services/modelPick.js";
import { useCatalogMeta } from "../composables/useCatalogMeta.js";
import { createDownloadTask, engineInstallChannel, modelDownloadChannel } from "../composables/useDownloadTask.js";
import { useEngine } from "../composables/useEngine.js";
import { useRouting } from "../composables/useRouting.js";
import { models, vramMb, refresh as refreshModels } from "../composables/useRunnerModels.js";
import { LOCAL_RUNNER_ID, setAsEmbedding } from "../services/modelApply.js";

const props = defineProps({
  // The page's provider list — for the "use Ollama's embedding" zero-download offer.
  providers: { type: Array, default: () => [] },
});

const routing = useRouting();
const engine = useEngine();
const meta = useCatalogMeta();

const loaded = ref(false);
const routedId = ref("");     // routing.default.embeddingId at open
const routedModel = ref("");
const busy = ref(false);      // a setup run (engine → download → routing write) in flight
const doneModel = ref("");    // set when THIS dialog session finished the setup
const error = ref("");

const routedName = computed(() => routing.providerName(routedId.value));
const ollamaRow = computed(() =>
  props.providers.find((p) => p.providerType === "ollama" && p.embeddingModel) || null);

const engineTask = createDownloadTask(engineInstallChannel());
const pickedEmbedId = ref("");
const embedTask = createDownloadTask(modelDownloadChannel(() => pickedEmbedId.value));

onMounted(async () => {
  try {
    await Promise.all([routing.loadRouting(), engine.refreshEngine?.(), meta.refresh?.()]);
    routedId.value = routing.routing.value?.default?.embeddingId || "";
    routedModel.value = routing.routing.value?.default?.embeddingModel || "";
  } catch { /* the block renders its recommendation; setup re-checks live state */ }
  loaded.value = true;
});

// The §10-family embed pick over the live catalog: CPU-band rows always qualify
// (the ROUND-4 law), GPU rows against the full card (no local chat co-resides here).
function bestLocalEmbedId() {
  const isEmbed = (m) => meta.embeddingById.value[m.id] === true || /embed/i.test(m.id || "") || /embed/i.test(m.name || "");
  return pickBestEmbedId(models.value, {
    leftoverMb: vramMb.value,
    qualityOf: (m) => meta.qualityById.value[m.id] ?? 100,
    isEmbed,
    minVramOf: (m) => meta.minVramById.value[m.id] || 0,
    tierOf: (m) => meta.tierById.value[m.id] || "mid",
  });
}

// Await a task run: resolves true on done, false on cancel/error (the bar shows why).
function awaitTask(task) {
  return new Promise((resolve) => {
    const tick = () => {
      if (task.state === "done") return resolve(true);
      if (task.state === "error" || task.state === "cancelled") return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function setupLocal() {
  busy.value = true;
  error.value = "";
  try {
    await refreshModels();
    pickedEmbedId.value = bestLocalEmbedId();
    if (!pickedEmbedId.value) {
      error.value = "No embedding model in the catalog fits this PC.";
      return;
    }
    if (!engine.installed.value) {
      engineTask.start();
      if (!(await awaitTask(engineTask))) return; // the bar carries cancel/retry + the error
    }
    embedTask.start();
    if (!(await awaitTask(embedTask))) return;
    await setAsEmbedding(LOCAL_RUNNER_ID, pickedEmbedId.value);
    doneModel.value = pickedEmbedId.value;
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function useOllama() {
  const p = ollamaRow.value;
  if (!p) return;
  busy.value = true;
  error.value = "";
  try {
    await setAsEmbedding(p.id, p.embeddingModel);
    doneModel.value = `${p.embeddingModel} (${p.name || "Ollama"})`;
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="loaded" class="lu-bss">
    <!-- Already routed anywhere → the truth in one line, nothing to do. -->
    <p v-if="doneModel" class="lu-sd-line lu-bss-done">Book search ready ✓ — <b>{{ doneModel }}</b>.</p>
    <p v-else-if="routedId === 'local-llamacpp' && routedModel" class="lu-sd-line lu-muted">
      Book search keeps running on your local embedding (<b>{{ routedModel }}</b>) — unchanged.
    </p>
    <p v-else-if="routedId" class="lu-sd-line lu-muted">
      Book search keeps running on <b>{{ routedName }}</b> — unchanged.
    </p>

    <!-- No embedding anywhere → the recommendation (skippable — Apply never blocks). -->
    <template v-else>
      <p class="lu-sd-line"><b>Book search</b> <span class="lu-muted">— recommended.</span>
        Lets chat find and quote your actual scenes, not just your story bible. Runs on this PC — private, no rate limits.</p>
      <p class="lu-sd-line lu-muted">Skip it and chat answers from your story bible only — you can add book search here any time.</p>
      <div class="lu-bss-actions">
        <UiButton intent="secondary" size="small" :loading="busy" @click="setupLocal">Set up book search</UiButton>
        <UiButton v-if="ollamaRow" intent="ghost" size="small" :disabled="busy" @click="useOllama">
          Use {{ ollamaRow.name || "Ollama" }} — nothing to download
        </UiButton>
      </div>
      <DownloadBar v-if="engineTask.state" title="Local engine" role="one-time install" :task="engineTask" />
      <DownloadBar v-if="embedTask.state" title="Book-search model" :role="pickedEmbedId" :task="embedTask" />
      <p v-if="error" class="lu-sd-line lu-bss-err">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.lu-bss { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.lu-bss-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lu-bss-done { color: var(--ok-ink, var(--accent-ink)); }
.lu-bss-err { color: var(--danger-ink, #b91c1c); }
</style>
