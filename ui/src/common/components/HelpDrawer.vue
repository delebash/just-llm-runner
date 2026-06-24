<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  HelpDrawer — shared right-side slide-in help panel. Mounted ONCE in the host's
  App.vue; opens when helpState.slug !== null (set by openHelp(), which every
  HelpTrigger calls). Renders the host's docs/<slug>.md via the shared
  helpMarkdown renderer; intra-doc links jump within the drawer rather than
  navigating the app. The "Open full docs" / "Open on the web" footer buttons
  appear only when the host wired onOpenFull / onOpenWeb via configureHelp().
  App-agnostic; token-driven; supersedes the per-app *HelpDrawer.vue forks.
-->
<script setup>
import { computed, watch, nextTick, ref } from "vue";
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "reka-ui";
import Icon from "./Icon.vue";
import UiButton from "./UiButton.vue";
import { helpState, helpConfig, openHelp, closeHelp } from "../services/help.js";
import { renderHelpMarkdown } from "../services/helpMarkdown.js";

const open = computed({
  get: () => helpState.slug !== null,
  set: (v) => { if (!v) closeHelp(); },
});

const slug = computed(() => helpState.slug || "");
const anchor = computed(() => helpState.anchor || "");
const title = computed(() => helpConfig.titleForSlug(slug.value));
const exists = computed(() => helpConfig.hasDoc(slug.value));
const rawDoc = ref(null);
// Load the doc lazily when the drawer opens / navigates (not at app boot).
watch(slug, async (s) => { rawDoc.value = s ? await helpConfig.loadDoc(s) : null; }, { immediate: true });
const renderedHtml = computed(() => renderHelpMarkdown(rawDoc.value));

const contentEl = ref(null);

// Scroll to the named anchor when the drawer opens with one (or when the
// slug/anchor changes while open). Falls back to scroll-to-top otherwise.
// Two nextTicks because v-html mounts the new prose tree on the first tick
// and querySelector needs the element actually in the DOM on the second.
watch([slug, anchor], async () => {
  await nextTick();
  await nextTick();
  const root = contentEl.value;
  if (!root) return;
  const a = anchor.value;
  if (a) {
    const el = root.querySelector(`[id="${CSS.escape(a)}"]`);
    if (el) { el.scrollIntoView({ behavior: "auto", block: "start" }); return; }
  }
  root.scrollTo({ top: 0, behavior: "auto" });
}, { immediate: true });

function onContentClick(e) {
  const a = e.target.closest("a[data-help-link]");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") || "";
  // Internal help links jump within the drawer. Preserve any #section anchor
  // so cross-doc links land on the right heading.
  const m = href.match(/^\/help(?:\/([^#]+))?(?:#(.+))?$/);
  if (m) openHelp(m[1] || "", m[2] || "");
}

function openFull() { helpConfig.onOpenFull?.(slug.value); }
function openWeb() { helpConfig.onOpenWeb?.(slug.value); }
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="help-drawer-overlay" />
      <DialogContent class="help-drawer" aria-label="Help">
        <header class="help-drawer-header">
          <DialogTitle as-child>
            <div class="help-drawer-titleblock">
              <div class="help-drawer-eyebrow">Help</div>
              <div class="help-drawer-title">{{ title }}</div>
            </div>
          </DialogTitle>
          <DialogClose class="help-drawer-close" aria-label="Close help">
            <Icon name="Close" :size="14" />
          </DialogClose>
        </header>

        <div ref="contentEl" class="help-drawer-body" @click="onContentClick">
          <article v-if="renderedHtml" class="help-drawer-prose" v-html="renderedHtml" />
          <div v-else class="help-drawer-empty">
            <p>No help article for this surface yet.</p>
            <UiButton v-if="helpConfig.onOpenFull" intent="ghost" size="small" @click="openFull">
              <template #icon><Icon name="Book" :size="13" /></template>
              Browse all docs
            </UiButton>
          </div>
        </div>

        <footer
          v-if="exists && (helpConfig.onOpenFull || helpConfig.onOpenWeb)"
          class="help-drawer-footer">
          <UiButton v-if="helpConfig.onOpenFull" intent="ghost" size="small" @click="openFull">
            <template #icon><Icon name="Book" :size="13" /></template>
            Open full docs
          </UiButton>
          <UiButton v-if="helpConfig.onOpenWeb" intent="ghost" size="small" @click="openWeb">
            <template #icon><Icon name="ExternalLink" :size="13" /></template>
            Open on the web
          </UiButton>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.help-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 250;
  background: color-mix(in oklab, black 28%, transparent);
  animation: helpFadeIn 160ms ease;
}
.help-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(480px, 92vw);
  z-index: 251;
  background: var(--surface);
  color: var(--ink);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  animation: helpSlideIn 220ms cubic-bezier(.22, 1, .36, 1);
  outline: none;
}
@keyframes helpFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes helpSlideIn {
  from { transform: translateX(8%); opacity: 0; }
  to   { transform: translateX(0); opacity: 1; }
}

.help-drawer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--border);
}
.help-drawer-titleblock { min-width: 0; }
.help-drawer-eyebrow {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 2px;
}
.help-drawer-title {
  font-family: var(--font-display, inherit);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
}
.help-drawer-close {
  appearance: none;
  border: 0;
  background: transparent;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm, 6px);
  cursor: pointer;
  color: var(--muted);
}
.help-drawer-close:hover { background: var(--hover, var(--surface-2)); color: var(--ink); }

.help-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 22px 28px;
}
.help-drawer-prose {
  font-family: var(--font-body, inherit);
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--ink);
}
.help-drawer-prose :deep(h2),
.help-drawer-prose :deep(h3) {
  font-family: var(--font-display, inherit);
  line-height: 1.25;
  margin-top: 1.4em;
  margin-bottom: 0.5em;
  color: var(--ink);
}
.help-drawer-prose :deep(h2) {
  font-size: 17px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  padding-bottom: 4px;
}
.help-drawer-prose :deep(h3) { font-size: 14.5px; font-weight: 600; }
.help-drawer-prose :deep(p) { margin: 0 0 0.9em; }
.help-drawer-prose :deep(ul),
.help-drawer-prose :deep(ol) { margin: 0 0 0.9em 1.3em; padding: 0; }
.help-drawer-prose :deep(li) { margin-bottom: 0.3em; }
.help-drawer-prose :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
.help-drawer-prose :deep(a:hover) { text-decoration-thickness: 2px; }
.help-drawer-prose :deep(code) {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.88em;
  background: color-mix(in oklab, var(--ink) 8%, transparent);
  padding: 1px 5px;
  border-radius: 4px;
}
.help-drawer-prose :deep(pre) {
  background: color-mix(in oklab, var(--ink) 6%, transparent);
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.5;
  margin: 0 0 0.9em;
}
.help-drawer-prose :deep(pre code) { background: transparent; padding: 0; }
.help-drawer-prose :deep(blockquote) {
  margin: 0 0 0.9em;
  padding: 4px 12px;
  border-left: 3px solid var(--accent);
  color: var(--muted);
  font-style: italic;
}
.help-drawer-prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 1em;
  font-size: 13px;
}
.help-drawer-prose :deep(th),
.help-drawer-prose :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
.help-drawer-prose :deep(th) {
  background: color-mix(in oklab, var(--ink) 5%, transparent);
  font-weight: 600;
}
.help-drawer-prose :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 1.5em 0;
}
.help-drawer-prose :deep(strong) { font-weight: 600; }

.help-drawer-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}

.help-drawer-footer {
  display: flex;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}
</style>
