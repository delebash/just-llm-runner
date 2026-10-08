// SPDX-License-Identifier: MIT
// `@delebash/llm-runner` — the family's shared server kit in JavaScript (the port of
// Python's `llm_runner`). The root exports what Python's package root did — the runner
// router every app mounts — plus the one-call installer. Everything else is reached by
// subpath: `@delebash/llm-runner/llm`, `/platform`, `/runner/<module>`, `/llm/<module>`,
// `/platform/<module>`, and the desktop shell at `/shell`.

export { installLlm } from "./llm/install.js";
export { runnerRouter as router, runnerRouter } from "./runner/api.js";
