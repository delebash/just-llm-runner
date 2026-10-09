// SPDX-License-Identifier: MIT
// node:perf_hooks for a worker: the platform's own performance object. The browser polyfill copies
// its methods off it unbound, and a copied `now` throws "Illegal invocation" when Fastify times a
// reply.
export const performance = globalThis.performance;
export const PerformanceObserver = globalThis.PerformanceObserver;
export const constants = {};
export default { performance, PerformanceObserver, constants };
