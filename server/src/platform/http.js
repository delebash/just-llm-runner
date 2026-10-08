// SPDX-License-Identifier: MIT
// The kit's one HTTP client (Python's `requests` / `httpx`): undici's fetch on an agent
// whose header and body timeouts sit past JustVoice's 900 s request limit (undici's
// defaults are 300 s — study §3.3), and which honours HTTP(S)_PROXY / NO_PROXY (plain
// `fetch` ignores them unless NODE_USE_ENV_PROXY=1).
//
// `fetch` is called through this module's namespace everywhere, so a test replaces it
// with `vi.spyOn(http, "fetch")` — the Python tests' monkeypatch of requests.get.

import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import * as self from "./http.js";

const LONG_MS = 15 * 60 * 1000;

const agent = new EnvHttpProxyAgent({
  headersTimeout: LONG_MS,
  bodyTimeout: LONG_MS,
  connectTimeout: 30_000,
});

/** fetch(url, init) on the kit's agent. `init.timeoutMs` aborts the whole request. */
export function fetch(url, init = {}) {
  const { timeoutMs, signal, ...rest } = init;
  let sig = signal;
  if (timeoutMs != null) {
    const t = AbortSignal.timeout(timeoutMs);
    sig = signal ? AbortSignal.any([signal, t]) : t;
  }
  return undiciFetch(url, { dispatcher: agent, ...rest, signal: sig });
}

/** An HTTP status the caller didn't accept (requests' raise_for_status). */
export class HttpStatusError extends Error {
  constructor(status, url, body = "") {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** GET a JSON document; a non-2xx status throws HttpStatusError. */
export async function getJson(url, { headers, timeoutMs = 30_000 } = {}) {
  const r = await self.fetch(url, { headers, timeoutMs });
  if (!r.ok) throw new HttpStatusError(r.status, url, await r.text().catch(() => ""));
  return r.json();
}
