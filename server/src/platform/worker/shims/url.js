// SPDX-License-Identifier: MIT
// node:url for a worker: the WHATWG URL the platform already has, and the two file-path helpers.
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export function fileURLToPath(url) {
  const u = typeof url === "string" ? new URL(url) : url;
  return decodeURIComponent(u.pathname);
}

export function pathToFileURL(path) {
  return new URL(`file://${encodeURI(String(path).replace(/\\/g, "/"))}`);
}

export default { URL, URLSearchParams, fileURLToPath, pathToFileURL };
