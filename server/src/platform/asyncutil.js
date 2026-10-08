// SPDX-License-Identifier: MIT
// What Python's threads gave the kit, for one event loop: sleeping, a lock for a critical
// section that crosses an `await` (one that doesn't cross one needs no lock — nothing
// else runs in between), an event, and a deadline.

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** An async lock: `await m.run(async () => …)` runs one holder at a time, in arrival order. */
export class Mutex {
  #tail = Promise.resolve();
  #held = 0;
  get locked() {
    return this.#held > 0;
  }
  run(fn) {
    const prev = this.#tail;
    let release;
    const next = new Promise((r) => {
      release = r;
    });
    this.#tail = prev.then(() => next);
    return prev.then(async () => {
      this.#held += 1;
      try {
        return await fn();
      } finally {
        this.#held -= 1;
        release();
      }
    });
  }
}

/** threading.Event: set / clear / isSet / wait(timeoutMs) → true when set. */
export class AsyncEvent {
  #set = false;
  #waiters = [];
  isSet() {
    return this.#set;
  }
  set() {
    this.#set = true;
    for (const w of this.#waiters.splice(0)) w(true);
  }
  clear() {
    this.#set = false;
  }
  wait(timeoutMs) {
    if (this.#set) return Promise.resolve(true);
    return new Promise((resolve) => {
      let t = null;
      const w = (v) => {
        if (t) clearTimeout(t);
        resolve(v);
      };
      this.#waiters.push(w);
      if (timeoutMs != null) {
        t = setTimeout(() => {
          const i = this.#waiters.indexOf(w);
          if (i >= 0) this.#waiters.splice(i, 1);
          resolve(false);
        }, timeoutMs);
      }
    });
  }
}

export class TimeoutError extends Error {
  constructor(message = "timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Resolve `p`, or reject with TimeoutError after `ms`. */
export function withTimeout(p, ms, message) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new TimeoutError(message)), ms);
    }),
  ]);
}

/** A background task (Python's daemon thread): runs `fn`, logs and swallows its error. */
export function background(name, fn, log) {
  return Promise.resolve()
    .then(fn)
    .catch((e) => log?.warning?.(`${name} failed: ${e?.stack || e}`));
}
