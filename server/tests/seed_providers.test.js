// SPDX-License-Identifier: MIT
// Port of tests/test_seed_providers.py — pin the seeded DEFAULT_PROVIDERS to their NATIVE
// provider types (#15 C1, the 2026-07-17 SDK pivot): official SDK adapters back
// claude/gemini/ollama, so the seed rows carry the real types + the SDK-native base URLs
// (no `/v1` on Anthropic, no `/v1beta/openai` shim on Gemini, and the local Ollama row
// loses `/v1` — the native adapter appends `/api/chat`). Also proves ProviderStore.remove
// CASCADES the provider's reasoning-map rows — else a delete+re-add leaves the old alias's
// rows behind and poisons the retyped provider.
import { expect, test, vi } from "vitest";
import { DEFAULT_PROVIDERS } from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { freshDb } from "./helpers.js";

// Interim: wave-2 modules, stood in only while their file is missing
// (fixtures/wave-stubs.js explains the raw-specifier keys).
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));
vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));

// The native-type end state — id -> [provider_type, base_url]. One source: any seed drift
// breaks this pin.
const EXPECTED = {
  "local-llamacpp": ["local-llamacpp", "http://127.0.0.1:8080/v1"],
  "openai-compat-local": ["ollama", "http://localhost:11434"],
  // LM Studio rides the generic openai-compat adapter (2026-07-19) — seeded so it is
  // PRESENT out of the box like Ollama, not merely reachable via the preset chip.
  lmstudio: ["openai-compat", "http://localhost:1234/v1"],
  // Unsloth Studio joins on the same terms (2026-07-28); deliberately absent from
  // detect-local because its API requires a Bearer key an unauthenticated probe can't send.
  unsloth: ["openai-compat", "http://localhost:8888/v1"],
  openai: ["openai", "https://api.openai.com/v1"],
  claude: ["anthropic", "https://api.anthropic.com"],
  gemini: ["gemini", "https://generativelanguage.googleapis.com"],
  deepseek: ["deepseek", "https://api.deepseek.com/v1"],
  openrouter: ["openrouter", "https://openrouter.ai/api/v1"],
  // xAI + Mistral join as dedicated SDK-chat-completions types (#15 C4, D4).
  xai: ["xai", "https://api.x.ai/v1"],
  mistral: ["mistral", "https://api.mistral.ai/v1"],
};

test("default_providers_carry_native_types_and_urls", () => {
  const byId = Object.fromEntries(DEFAULT_PROVIDERS.map((p) => [p.id, p]));
  expect(new Set(Object.keys(byId))).toEqual(new Set(Object.keys(EXPECTED)));
  for (const [pid, [ptype, baseUrl]] of Object.entries(EXPECTED)) {
    expect(byId[pid].provider_type, pid).toBe(ptype);
    expect(byId[pid].base_url, pid).toBe(baseUrl);
  }
  // the local row is renamed to its native adapter (Ollama).
  expect(byId["openai-compat-local"].name).toBe("Ollama (local)");
});

test("remove_cascades_reasoning_map_rows", () => {
  freshDb();
  const store = stores.getProviderStore();
  store.add({ id: "tmp-anthropic", name: "Tmp", providerType: "anthropic", baseUrl: "https://api.anthropic.com", local: false });
  // add() fills the type's five reasoning-map rows (fill-if-missing on create).
  const rmap = stores.getReasoningMapStore();
  expect(rmap.forProvider("tmp-anthropic")).toHaveLength(5);

  store.remove("tmp-anthropic");
  // the map rows go with the provider — this FAILS on the pre-cascade remove().
  expect(rmap.forProvider("tmp-anthropic")).toEqual([]);
});
