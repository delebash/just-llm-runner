// SPDX-License-Identifier: MIT
// node:async_hooks for a worker: Fastify wraps body parsing in an AsyncResource to keep Node's
// async context; a worker has none to keep, so running the function is the whole job.
export class AsyncResource {
  constructor(type) {
    this.type = type;
  }
  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args);
  }
  bind(fn) {
    return fn.bind(this);
  }
  static bind(fn) {
    return fn;
  }
  emitDestroy() {
    return this;
  }
  asyncId() {
    return 0;
  }
  triggerAsyncId() {
    return 0;
  }
}
/** The store lives for the synchronous run only (no async context to carry it in a worker). */
export class AsyncLocalStorage {
  #store = undefined;
  getStore() {
    return this.#store;
  }
  run(store, fn, ...args) {
    const prev = this.#store;
    this.#store = store;
    try {
      return fn(...args);
    } finally {
      this.#store = prev;
    }
  }
  enterWith(store) {
    this.#store = store;
  }
  disable() {
    this.#store = undefined;
  }
}
export const executionAsyncId = () => 0;
export const triggerAsyncId = () => 0;
export const createHook = () => ({ enable() {}, disable() {} });
export default { AsyncResource, AsyncLocalStorage, executionAsyncId, triggerAsyncId, createHook };
