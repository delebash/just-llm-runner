// SPDX-License-Identifier: MIT
// node:https for a worker — Fastify imports it only to make an HTTPS server, which an in-app
// server never does; the same stand-ins as node:http.
export * from "./http.js";
export { default } from "./http.js";
