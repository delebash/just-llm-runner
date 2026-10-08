// SPDX-License-Identifier: MIT
// Shared test doubles for the official-SDK adapters (the port of tests/_sdk_fakes.py): ONE
// params-capture base + ONE fixture loader, so each per-SDK fake (gemini / openai /
// anthropic) is a thin subclass. Plus the two pieces the JS port needs: `camelize` (the
// fixtures are Python SDK dumps — snake_case; the JS SDK keeps the camelCase wire) and an
// SSE/JSON Response builder for the http.fetch spy.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A committed live-proof capture, e.g. `loadFixture("gemini-sdk/chat-create.json")` — the
 * real 2026-07-17 API shapes as the Python SDK dumped them. */
export function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, ...name.split("/")), "utf8"));
}

/** snake_case keys → camelCase, recursively: a Python google-genai dump back into the
 * REST wire shape the JS SDK's response classes carry. */
export function camelize(v) {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camelize(x)]));
  }
  return v;
}

/** A fake SDK surface that records the params of its last call into `this.last`. Subclass
 * and give it the SDK-shaped method(s), each stashing params via `_capture`. (The JS SDKs
 * take ONE params object where the Python SDKs took **kwargs — same keys.) */
export class KwargsCapture {
  constructor() {
    this.last = {};
  }

  _capture(params) {
    this.last = params;
    return params;
  }
}

/** A fetch Response carrying `text` (an SSE body, JSON, …). */
export function textResponse(text, { status = 200, contentType = "text/event-stream" } = {}) {
  return new Response(text, { status, headers: { "content-type": contentType } });
}

/** A fetch Response carrying a JSON body. */
export const jsonResponse = (obj, { status = 200 } = {}) =>
  textResponse(JSON.stringify(obj), { status, contentType: "application/json" });
