// SPDX-License-Identifier: MIT
// node:diagnostics_channel for a worker: channels nobody subscribes to (Fastify publishes its
// request tracing there; on the phone nothing listens).
const channel = (name) => ({
  name,
  hasSubscribers: false,
  publish() {},
  subscribe() {},
  unsubscribe() {},
  bindStore() {},
  unbindStore() {},
  runStores(_data, fn, thisArg, ...args) {
    return fn.apply(thisArg, args);
  },
});
export { channel };
export const hasSubscribers = () => false;
export function subscribe() {}
export function unsubscribe() {}
export function tracingChannel(name) {
  const run = (fn, _ctx, thisArg, ...args) => fn.apply(thisArg, args);
  return {
    start: channel(`tracing:${name}:start`),
    end: channel(`tracing:${name}:end`),
    asyncStart: channel(`tracing:${name}:asyncStart`),
    asyncEnd: channel(`tracing:${name}:asyncEnd`),
    error: channel(`tracing:${name}:error`),
    hasSubscribers: false,
    subscribe() {},
    unsubscribe() {},
    traceSync: run,
    tracePromise: run,
    traceCallback: (fn, _pos, _ctx, thisArg, ...args) => fn.apply(thisArg, args),
  };
}
export default { channel, hasSubscribers, subscribe, unsubscribe, tracingChannel };
