// SPDX-License-Identifier: MIT
// undici for a worker: the platform's fetch, so an AI provider's answer streams as on a computer.
// A call the platform refuses — a provider that doesn't accept a webview's call (CORS) shows as a
// TypeError — goes again through the window's native HTTP (the app's `http.request` handler for
// the kit's `callWindow`: Capacitor's CapacitorHttp on the phone), whole rather than streamed
// (decided 2026-10-08 — the kit's docs/plans/2026-10-08-the-phone.md §4, question 3). undici's
// agents have nothing to configure here.
import { callWindow } from "../runtime.js";

export class EnvHttpProxyAgent {
  close() {}
}
export class Agent extends EnvHttpProxyAgent {}
export class ProxyAgent extends EnvHttpProxyAgent {}
export const setGlobalDispatcher = () => {};
export const getGlobalDispatcher = () => null;

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

async function bodyBytes(body) {
  if (body == null) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export async function fetch(input, init = {}) {
  const { dispatcher: _dispatcher, ...rest } = init;
  try {
    return await globalThis.fetch(input, rest);
  } catch (e) {
    if (!(e instanceof TypeError) || rest.signal?.aborted) throw e;
    let answer;
    try {
      answer = await callWindow("http.request", {
        url: String(input?.url ?? input),
        method: rest.method ?? "GET",
        headers: Object.fromEntries(new Headers(rest.headers ?? {})),
        body: await bodyBytes(rest.body),
      });
    } catch {
      throw e; // no native HTTP either: the platform's own error
    }
    return new Response(NULL_BODY.has(answer.status) ? null : answer.body, { status: answer.status, headers: answer.headers });
  }
}

export default { fetch, EnvHttpProxyAgent, Agent, ProxyAgent, setGlobalDispatcher, getGlobalDispatcher };
