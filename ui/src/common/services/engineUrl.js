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

// The binaries to PUT for an update to `build`. Substitution alone is not enough: upstream
// RENAMES its release files between builds (Windows AMD hip-radeon → rocm-7.14 → rocm-10.0,
// Linux AMD absent for ~180 builds, Windows CUDA 13.3 → 13.4 — plan
// docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md §3.4), and a substituted
// name that no longer exists 404s mid-update. A row the SERVER resolved carries the file that
// build really publishes; every other row keeps the substitution. `plan` = the
// /engine/resolve-assets payload, or null when that call failed (offline, rate-limited) —
// then every row is substituted, exactly as before this existed.
export function planBinaries(binaries, plan, build) {
  const byKey = new Map((plan?.binaries || []).map((r) => [`${r.platform}/${r.gpu}`, r]));
  return (binaries || []).map((b) => {
    const r = byKey.get(`${b.platform}/${b.gpu}`);
    if (r && r.resolved === true) return { ...b, assetUrl: r.assetUrl, runtimeUrl: r.runtimeUrl };
    return { ...b, assetUrl: applyBuildToUrl(b.assetUrl, build), runtimeUrl: applyBuildToUrl(b.runtimeUrl, build) };
  });
}

// True when an update that already wrote `pending.target` as the pin ended with some OTHER
// build on disk — it failed, was cancelled, or the install-time checks refused it. The pin and
// the URLs must then go back to what they were, or the app is left pointing at an engine it
// does not have. Still installing → not yet decided.
export function shouldRollback(pending, status) {
  if (!pending || !status || status.status === "installing") return false;
  return (status.build || "") !== pending.target;
}
