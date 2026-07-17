<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// QC-43c — the live server console (a tab under the AI settings area). Two
// live-follow sources: the app server's in-memory log RING (/v1/logs/tail,
// level-coloured — the same grammar LogsPanel renders) and the ENGINE child's
// spawn output (/v1/llm-runner/engine/log — plain llama-server stdout, no level
// tokens). ONE poll (~2s) tails the picked source while this tab is mounted;
// leaving the tab unmounts the component and usePoll stops the interval, so the
// follow runs only while visible. The view auto-scrolls to the newest line
// unless the reader has scrolled up to read history — then it un-pins and offers
// a jump-to-latest. Pause freezes the follow. Transient poll errors are
// swallowed (the last good content stays on screen; a quiet stale note appears
// after a few consecutive failures). Rendering reuses the shared .lu-logbox /
// .lu-logline* grammar + logLines.js — no fork of LogsPanel's line markup.
import { computed, nextTick, onMounted, ref } from "vue";
import { request } from "../client.js";
import { usePoll } from "../common/composables/usePoll.js";
import UiButton from "../common/components/UiButton.vue";
import UiSelect from "../common/components/UiSelect.vue";
import { filterRowsByMinLevel, logLineClass, parseEngineRows, parseLogRows } from "../services/logLines.js";

// The server ring holds 500 (logs_api capacity); the engine log is tailed to 500
// too — fetch and render the same cap so the box never grows unbounded.
const LINE_CAP = 500;
const POLL_MS = 2000;
const STALE_AFTER = 3; // consecutive poll failures before the stale note shows
const BOTTOM_SLACK = 24; // px from the bottom still counts as "following"

const SOURCES = [
  { value: "server", label: "Server log" },
  { value: "engine", label: "Engine output" },
];

// Minimum-level filter (user, 2026-07-17: "filter by log level"). Both sources parse
// levels now — server via its [LEVEL] token, engine via llama.cpp's I/W/E/D grammar —
// so this filters either. "ALL" = no floor.
const LEVELS = [
  { value: "ALL", label: "All levels" },
  { value: "INFO", label: "Info +" },
  { value: "WARNING", label: "Warnings +" },
  { value: "ERROR", label: "Errors only" },
];

const source = ref("server");
const minLevel = ref("ALL");
const text = ref("");
const enginePath = ref("");
const paused = ref(false);
const pinned = ref(true); // auto-scroll follows the newest line until the reader scrolls up
const fails = ref(0);
const loadedOnce = ref(false);
let inFlight = false;

const box = ref(null);

const isServer = computed(() => source.value === "server");
// Server log → the shared level-aware grammar. Engine output is plain
// llama-server stdout with no [LEVEL] tokens → bare monospace lines (level "").
// Parse to level-tagged rows (server [LEVEL] grammar / engine I-W-E-D grammar),
// cap, THEN filter by the chosen minimum level. Filtering after the cap keeps the
// box bounded and the newest window in view.
const rows = computed(() => {
  const parsed = isServer.value ? parseLogRows(text.value) : parseEngineRows(text.value);
  return filterRowsByMinLevel(parsed.slice(-LINE_CAP), minLevel.value);
});
const hasContent = computed(() => !!text.value && rows.value.length > 0);
const stale = computed(() => fails.value >= STALE_AFTER);
const emptyLabel = computed(() => {
  if (!loadedOnce.value) return "Loading…";
  // Content exists but the level filter hid it all — say so, don't imply the log is empty.
  if (text.value && minLevel.value !== "ALL") return `No ${minLevel.value.toLowerCase()}-or-higher lines in view.`;
  return isServer.value
    ? "No log lines yet."
    : "No engine output yet — start a model to spawn the engine and see its output.";
});

// Raising/lowering the floor changes what's visible — re-pin to the newest line.
function onPickLevel(v) {
  minLevel.value = v;
  if (pinned.value) nextTick(scrollToBottom);
}

function scrollToBottom() {
  const el = box.value;
  if (el) el.scrollTop = el.scrollHeight;
}
// The reader scrolled: re-pin when they land back at the bottom, un-pin (pausing
// the auto-follow) the moment they move up. Programmatic scrollToBottom lands at
// the bottom → stays pinned, so it never fights a following reader.
function onScroll() {
  const el = box.value;
  if (!el) return;
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
}
function jumpToLatest() {
  pinned.value = true;
  scrollToBottom();
}

async function fetchOnce() {
  if (inFlight) return;
  inFlight = true;
  try {
    if (isServer.value) {
      const r = await request(`/v1/logs/tail?lines=${LINE_CAP}`);
      text.value = r?.text || "";
      enginePath.value = "";
    } else {
      const r = await request(`/v1/llm-runner/engine/log?tail=${LINE_CAP}`);
      text.value = r?.text || "";
      enginePath.value = r?.path || "";
    }
    fails.value = 0;
    loadedOnce.value = true;
    if (pinned.value) nextTick(scrollToBottom);
  } catch {
    // Transient — keep the last good content; the stale note surfaces only once a
    // few polls in a row have failed (a single blip stays silent).
    fails.value += 1;
  } finally {
    inFlight = false;
  }
}

const poll = usePoll(fetchOnce, POLL_MS);

function togglePause() {
  paused.value = !paused.value;
  if (paused.value) {
    poll.stop();
  } else {
    fetchOnce(); // resume with a fresh snapshot immediately, then keep polling
    poll.start();
  }
}

async function onPickSource(v) {
  source.value = v;
  text.value = "";
  enginePath.value = "";
  fails.value = 0;
  loadedOnce.value = false;
  pinned.value = true;
  await fetchOnce();
  if (!paused.value) poll.start(); // idempotent — keeps the single interval
}

onMounted(async () => {
  await fetchOnce();
  if (!paused.value) poll.start();
});
</script>

<template>
  <div class="lu-console">
    <div class="lu-console-head">
      <span class="lu-pcard-title">Server console</span>
      <span class="lu-muted lu-console-sub">Live tail of the app server log and the engine child's output.</span>
      <span class="lu-console-spacer" />
      <UiSelect :model-value="minLevel" :options="LEVELS" @update:model-value="onPickLevel" />
      <UiSelect :model-value="source" :options="SOURCES" @update:model-value="onPickSource" />
      <UiButton intent="secondary" size="small" @click="togglePause">{{ paused ? "Resume" : "Pause" }}</UiButton>
    </div>
    <div v-if="!isServer && enginePath" class="lu-muted lu-console-path">Spawn log: {{ enginePath }}</div>
    <div v-if="stale" class="lu-console-stale">Live tail stalled — can't reach the server. Showing the last snapshot.</div>
    <div class="lu-console-boxwrap">
      <div ref="box" class="lu-logbox lu-console-box" role="log" @scroll="onScroll">
        <template v-if="hasContent">
          <div v-for="(r, i) in rows" :key="i" class="lu-logline" :class="logLineClass(r.level)">{{ r.line }}</div>
        </template>
        <div v-else class="lu-muted">{{ emptyLabel }}</div>
      </div>
      <div v-if="!pinned && hasContent" class="lu-console-jump">
        <UiButton intent="secondary" size="small" @click="jumpToLatest">↓ Following paused — jump to latest</UiButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lu-console { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
.lu-console-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lu-console-sub { font-size: 11.5px; }
.lu-console-spacer { flex: 1; }
.lu-console-path { font-family: var(--font-mono, monospace); font-size: 11px; word-break: break-all; }
.lu-console-stale { font-size: 11.5px; color: var(--warning-ink, #b54708); font-style: italic; }
/* The box fills the pane and is the single scroller (.lu-logbox brings overflow +
   the monospace chrome); the jump affordance floats over its bottom edge. */
.lu-console-boxwrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.lu-console-box { flex: 1; min-height: 0; }
.lu-console-jump {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 2;
  filter: drop-shadow(0 3px 10px color-mix(in oklab, var(--ink) 22%, transparent));
}
</style>
