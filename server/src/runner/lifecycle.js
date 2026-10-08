// SPDX-License-Identifier: MIT
// SKELETON — the runner service (the port of llm_runner/runner/lifecycle.py) is being ported
// now (wave 3, runner D). This file holds only the public names, so modules that import
// `./lifecycle.js` (autotune, calibrate, the runner API, disk_api) load while it's written;
// every call throws until the real service replaces this file.

const notYet = (name) => () => {
  throw new Error(`runner/lifecycle.js is not ported yet (${name})`);
};

export class CorruptModelError extends Error {
  constructor(m, options) {
    super(m, options);
    this.name = "CorruptModelError";
  }
}

export class RunnerService {
  constructor() {
    throw new Error("runner/lifecycle.js is not ported yet (RunnerService)");
  }
}

export const configureService = notYet("configureService");
export const getService = notYet("getService");
/** The configured service, or null — the one name that answers before the port lands. */
export const configuredService = () => null;
