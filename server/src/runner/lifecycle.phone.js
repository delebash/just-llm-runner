// SPDX-License-Identifier: MIT
// The phone's twin of lifecycle.js: the in-app server (docs/plans/2026-10-08-the-phone.md) has no
// local AI engine — no llama.cpp processes on a phone. The cloud stack (llm/install_cloud.js)
// reaches this module only for the local provider (llm/api.js), which answers why.
export function getService() {
  throw new Error("The local AI engine isn't on this device — pick an online provider.");
}
