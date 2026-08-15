// SPDX-License-Identifier: MIT
// THE one door for "put this file on the user's disk" — every app, every export
// (2026-08-15). Before this there were seven implementations of the same three
// lines: five hand-rolled copies inside JustVoice views (audiobook .m4b, project
// .zip, voiceline .zip, mastered audio, lexicon JSON — each dumping into
// Downloads with no folder choice), one in JustWrite's services/download.js, and
// one inline in this kit's DataManagement. None of them shared anything, and no
// search could find them together: `a.download = filename` is not a name.
//
// TWO delivery paths, one decision made here so no caller repeats it:
//   - a NATIVE save dialog, when the host wired one (choose the folder, and the
//     path comes back so the app can remember it)
//   - otherwise the browser download, straight to the Downloads folder
//
// The browser path is NOT a broken fallback: driven inside a real Tauri webview
// on 2026-08-15 (Edg/151) it wrote the file and the bytes verified. JustWrite's
// download.js used to claim WebView2 ignores `<a download>` on blob: URLs —
// that is no longer true, so the fallback is a real delivery, just a silent one.
//
// The host wires its native saver once at boot, next to configureExternal:
//
//   configureFileSave({ save: (blob, opts) => window.myShell.saveFile(...) });
//
// `save` resolves { ok: true, path } on success, null when the user cancelled,
// and throws on a real failure.

import { isTauriShell } from "./external.js";

const config = { save: null };

/** Wire the host's native "save as". Merge semantics, like configureExternal. */
export function configureFileSave({ save } = {}) {
  if (save !== undefined) config.save = save || null;
}

/** Will `saveBlob` open a real dialog, or drop the file into Downloads? Lets a
 *  caller word its button honestly ("Save as…" vs "Download"). */
export function canSaveNatively() {
  return !!config.save && isTauriShell();
}

/**
 * Deliver `blob` to the user as `filename`.
 *
 * @param opts.title       dialog title (native path only)
 * @param opts.filterName  file-type label, e.g. "JustWrite book"
 * @param opts.filterExt   extension(s), e.g. "zip"
 * @param opts.defaultDir  where the dialog opens (native path only)
 * @returns { ok: true, path }        saved via the native dialog
 *          { ok: true, downloaded }  written to the Downloads folder
 *          { ok: false, cancelled }  user dismissed the dialog
 */
export async function saveBlob(blob, filename, opts = {}) {
  if (canSaveNatively()) {
    const res = await config.save(blob, { filename, ...opts });
    if (!res || res.cancelled) return { ok: false, cancelled: true };
    if (res.ok === false) throw new Error(res.error || "save failed");
    return { ok: true, path: res.path };
  }
  downloadBlob(blob, filename);
  return { ok: true, downloaded: true };
}

/** The browser download on its own — no dialog, straight to Downloads. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a timer, not immediately: Safari and Firefox have both been seen
  // to abort a download whose object URL is released in the same tick as click().
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
