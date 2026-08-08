// SPDX-License-Identifier: MIT
// The docs/*.md content-adapter factory for the shared Help system — the
// counterpart to configureHelp() in help.js. The three apps each carried a
// hand-copy of this logic (JW the donor, JV lifted with attribution, docgen a
// smaller re-implementation); the logic now lives HERE once, and each app's
// services/helpDocs.js shrinks to its compile-time parts + this call.
//
// What CANNOT move into the kit: `import.meta.glob` is resolved by vite
// relative to the DECLARING file, so the glob and the toc.json import stay in
// the app. The app passes both in:
//
//   import toc from "../../docs/toc.json";
//   import { makeDocsHelpAdapter } from "@delebash/llm-ui";
//   const adapter = makeDocsHelpAdapter(
//     import.meta.glob("../../docs/*.md", { query: "?raw", import: "default" }),
//     toc,
//     { webBase: "https://…/docs" },   // only if a public docs site exists
//   );
//   export const { loadDoc, hasDoc, titleForSlug, webUrlFor } = adapter;
//
// Semantics (the JW/JV lineage, byte-for-byte behavior):
// - docs/README.md is addressable as slug "index"; an empty slug means "index".
// - Markdown loads LAZILY (the glob has no `eager`) — a doc is fetched only
//   when its Help surface opens, never on the boot path — and is cached for
//   the session.
// - titleForSlug walks the toc groups ([{ items: [{ slug, title }] }]) and
//   falls back to the slug itself; empty/index → "Help".

/**
 * Build the Help content adapter over an `import.meta.glob` loader map + toc.
 *
 * @param {Record<string, () => Promise<string>>} loaders  the glob result
 * @param {Array<{items: Array<{slug: string, title: string}>}>} toc
 * @param {{webBase?: string}} [opts]  public docs base URL, if the app has one
 * @returns {{loadDoc, hasDoc, titleForSlug, webUrlFor}}
 */
export function makeDocsHelpAdapter(loaders, toc, { webBase = "" } = {}) {
  // slug → () => Promise<rawMarkdown>
  const docLoaders = {};
  for (const path in loaders) {
    const slug = path.split("/").pop().replace(/\.md$/, "");
    const key = slug === "README" ? "index" : slug;
    docLoaders[key] = loaders[path];
  }

  const cache = {};

  // Async: loads (and caches) a doc's markdown on demand. Returns null if absent.
  async function loadDoc(slug) {
    const key = slug || "index";
    if (key in cache) return cache[key];
    const loader = docLoaders[key];
    if (!loader) return null;
    const raw = await loader();
    cache[key] = raw;
    return raw;
  }

  function hasDoc(slug) {
    return Boolean(docLoaders[slug || "index"]);
  }

  function titleForSlug(slug) {
    if (!slug || slug === "index") return "Help";
    for (const group of toc) {
      const hit = group.items.find((i) => i.slug === slug);
      if (hit) return hit.title;
    }
    return slug;
  }

  // Public web URL for the same doc — meaningful only when the app passed a
  // webBase (JW's marketing-site docs); returns null otherwise.
  function webUrlFor(slug) {
    if (!webBase) return null;
    if (!slug || slug === "index") return webBase;
    return `${webBase}/${slug}`;
  }

  return { loadDoc, hasDoc, titleForSlug, webUrlFor };
}
