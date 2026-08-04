<!-- SPDX-License-Identifier: MIT -->
<!--
  ConnectionError — shown in place of the whole app when the server can't be
  reached at boot. The renderer holds no data of its own, so rather than render
  empty stores (which look broken and silently fail to save) the host mounts
  this as the root. App-agnostic: the host passes its brand + server URL + copy
  as props — createApp(ConnectionError, { appName, serverUrl, need, devHint }).
  Supersedes the per-app ConnectionError.vue forks.
-->
<script setup>
import { computed } from "vue";
import { familyLabels } from "../services/familyLabels.js";

const props = defineProps({
  appName: { type: String, default: "the app" },
  serverUrl: { type: String, default: "" },
  // The clause after "{appName} needs its server to ___".
  need: { type: String, default: "load and save your work" },
  // Dev-only hint (shown only when import.meta.env.DEV); plain text.
  devHint: { type: String, default: "" },
});
const isDev = import.meta.env.DEV;
const L = familyLabels.connectionError; // reactive canon — group capture is safe, the door assigns in place
const title = computed(() => L.title.replace("{appName}", props.appName));
function retry() { location.reload(); }
</script>

<template>
  <div class="conn-err">
    <div class="conn-err__card">
      <div class="conn-err__icon">⚠️</div>
      <h1>{{ title }}</h1>
      <p>
        {{ appName }} needs its server to {{ need }}. It isn't responding at
        <code>{{ serverUrl }}</code>.
      </p>
      <p v-if="isDev && devHint" class="conn-err__hint">{{ devHint }}</p>
      <button class="conn-err__btn" type="button" @click="retry">{{ L.retry }}</button>
    </div>
  </div>
</template>

<style scoped>
.conn-err { position: fixed; inset: 0; display: grid; place-items: center; background: var(--bg, var(--app-bg, #f7f5f0)); padding: 24px; }
.conn-err__card { max-width: 460px; text-align: center; background: var(--surface, #fff); border: 1px solid var(--border, #e6e1d8); border-radius: 14px; padding: 32px 28px; box-shadow: 0 8px 30px rgba(0,0,0,.06); }
.conn-err__icon { font-size: 34px; line-height: 1; }
.conn-err__card h1 { font-size: 18px; margin: 14px 0 8px; color: var(--ink, #2b2620); }
.conn-err__card p { color: var(--muted, #6b6357); font-size: 13.5px; line-height: 1.55; margin: 0 0 10px; }
.conn-err__hint { font-size: 12.5px; }
.conn-err code { background: var(--surface-2, #f0ece4); padding: 1px 6px; border-radius: 5px; font-size: 12px; }
.conn-err__btn { margin-top: 16px; padding: 9px 22px; border: 0; border-radius: 8px; background: var(--accent, #2f6e4f); color: var(--on-accent, #fff); font-size: 13px; font-weight: 600; cursor: pointer; }
.conn-err__btn:hover { filter: brightness(1.06); }
</style>
