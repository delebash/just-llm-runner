// SPDX-License-Identifier: MIT
// The ONE place the pin → download-URL substitution lives (reused by the engine
// Binaries panel's reactive rewrite AND the update-to-latest flow, so the two never
// drift). The DB stores CONCRETE URLs; when the pinned build changes, this swaps the
// build tag in the URL to the new pin — both the `/releases/download/<tag>/` path and
// the `llama-<tag>-` filename carry it, so replacing the tag string covers both. A
// legacy `{build}` template (from an un-reseeded DB) resolves too, so the GUI never
// shows a placeholder. A custom URL with neither is returned unchanged.
export function applyBuildToUrl(url, build) {
  if (!url) return url || "";
  const b = (build || "").trim();
  if (!b) return url;
  if (url.includes("{build}")) return url.replaceAll("{build}", b);
  const m = url.match(/\/releases\/download\/(b\d+)\//);
  return m ? url.replaceAll(m[1], b) : url;
}
