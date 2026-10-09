// SPDX-License-Identifier: MIT
// Node's timer globals a worker lacks (the polyfilled stream and buffer modules schedule with them).
if (typeof globalThis.setImmediate !== "function") {
  globalThis.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
  globalThis.clearImmediate = (id) => clearTimeout(id);
}
