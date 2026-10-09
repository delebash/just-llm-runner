// SPDX-License-Identifier: MIT
// The template's server app — the family server's shape: the kit's Fastify server, the three
// family guards in their order (CSRF origin check, CORS, bearer auth), the app's routes, and the
// built UI for the headless path (a browser at the server's address is the whole app).
import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { BearerAuthMiddleware, CorsMiddleware, CsrfOriginMiddleware, createServer } from "@delebash/llm-runner/platform";

const TYPE_BASE = "https://family-template.local/errors/";
/** The desktop window's origin (the kit's shell loads app://<id>). */
export const DESKTOP_ORIGIN = "app://familytemplate";
/** The renderer's own origins: the desktop window and Quasar's dev server. */
export const APP_ORIGINS = [DESKTOP_ORIGIN, "http://localhost:9000", "http://127.0.0.1:9000"];

/**
 * @param {{ dataDir: string | null, uiDir?: string | null, readAuth?: () => [string[], boolean] }} opts
 *   uiDir: the built renderer (Quasar's dist/spa) to serve at "/" when present
 *   readAuth: [tokens, requireForLoopback] — the app's settings; no tokens = auth off
 */
export async function createApp({ dataDir, uiDir = null, readAuth = () => [[], false] }) {
  const app = createServer({ typeBase: TYPE_BASE });
  // outermost first: a CSRF 403 carries no CORS headers; CORS answers preflights before auth
  app.register(CsrfOriginMiddleware, { appOrigins: APP_ORIGINS, typeBase: TYPE_BASE });
  app.register(CorsMiddleware, { allowOrigins: ["*"], allowMethods: ["*"], allowHeaders: ["*"] });
  app.register(BearerAuthMiddleware, { readAuth, typeBase: TYPE_BASE });

  app.get("/v1/health", async () => ({ ok: true, app: "family-template" }));
  app.get("/v1/hello", async () => ({ message: "Hello from the family template's server", dataDir }));
  if (uiDir && existsSync(path.join(uiDir, "index.html"))) {
    await app.register(fastifyStatic, { root: uiDir, prefix: "/" });
  }
  return app;
}
