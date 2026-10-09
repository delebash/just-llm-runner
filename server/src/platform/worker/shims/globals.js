// SPDX-License-Identifier: MIT
// Node's timer globals a worker lacks (stream and Fastify internals schedule with them).
if (typeof globalThis.setImmediate !== "function") {
  globalThis.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
  globalThis.clearImmediate = (id) => clearTimeout(id);
}
