// SPDX-License-Identifier: MIT
// How the window's requests reach its server. Every request the kit's UI makes (serverApi.js,
// client.js, SyncPanel.vue) goes through `serverFetch`: on a computer that is the platform's
// `fetch`; on the phone the app's server runs inside a web worker in the app (the kit's
// docs/plans/2026-10-08-the-phone.md), and `setServerTransport(workerFetch(worker))` sends the
// requests there. Nothing else in the UI calls `fetch` for the server.

const platformFetch = (input, init) => globalThis.fetch(input, init);
let current = platformFetch;

/** `fetch`, through the transport the app chose. */
export const serverFetch = (input, init) => current(input, init);

/** Replace the transport (null → the platform's fetch again). */
export function setServerTransport(fn) {
  current = fn ?? platformFetch;
}

/** True when requests go somewhere other than the network (the phone's in-app server). */
export const inAppServer = () => current !== platformFetch;

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function headerPairs(headers) {
  const out = new Headers();
  for (const [k, v] of Object.entries(headers ?? {})) {
    for (const one of Array.isArray(v) ? v : [v]) if (one != null) out.append(k, String(one));
  }
  return out;
}

/**
 * A fetch-shaped function answered by a worker running the kit's `serveInWorker`
 * (server/src/platform/worker/runtime.js): the request goes over as a message, the answer comes
 * back as a Response whose body streams. An aborted request (its signal, or the body's reader
 * cancelled) tells the worker to stop.
 */
export function workerFetch(worker) {
  let next = 0;
  const pending = new Map();
  worker.addEventListener("message", (event) => {
    const m = event.data;
    const p = m && pending.get(m.id);
    if (!p) return;
    if (m.type === "head") p.head(m);
    else if (m.type === "chunk") p.chunk(m.data);
    else if (m.type === "end") p.end();
    else if (m.type === "error") p.fail(new TypeError(m.message));
  });
  return async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
    const id = ++next;
    return new Promise((resolve, reject) => {
      let controller = null;
      let settled = false;
      const stop = () => {
        if (pending.delete(id)) worker.postMessage({ type: "abort", id });
      };
      const stream = new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel: stop,
      });
      pending.set(id, {
        head(m) {
          settled = true;
          const empty = NULL_BODY.has(m.status) || request.method === "HEAD";
          resolve(new Response(empty ? null : stream, { status: m.status, statusText: m.statusText, headers: headerPairs(m.headers) }));
        },
        chunk: (data) => controller.enqueue(data),
        end() {
          pending.delete(id);
          controller.close();
        },
        fail(err) {
          pending.delete(id);
          if (settled) controller.error(err);
          else reject(err);
        },
      });
      const signal = init.signal ?? request.signal;
      signal?.addEventListener(
        "abort",
        () => {
          stop();
          const err = signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
          if (settled) controller.error(err);
          else reject(err);
        },
        { once: true },
      );
      const headers = Object.fromEntries(request.headers);
      worker.postMessage({ type: "request", id, method: request.method, url: url.pathname + url.search, headers, body }, body ? [body.buffer] : []);
    });
  };
}

/**
 * Answer the worker's calls (the kit's `callWindow`, server/src/platform/worker/runtime.js): what
 * only the window can do — the phone's native plugins. `handlers` maps an op to an async function
 * of its args; register before the worker's app is built (it may ask while starting).
 */
export function answerWorkerCalls(worker, handlers) {
  worker.addEventListener("message", async (event) => {
    const m = event.data;
    if (m?.type !== "call") return;
    try {
      const fn = handlers[m.op];
      if (!fn) throw new Error(`no window handler for ${m.op}`);
      worker.postMessage({ type: "call-result", id: m.id, ok: true, value: await fn(m.args) });
    } catch (e) {
      worker.postMessage({ type: "call-result", id: m.id, ok: false, error: String(e?.message ?? e) });
    }
  });
}
