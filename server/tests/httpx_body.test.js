// SPDX-License-Identifier: MIT
// The LLM request body is the text httpx writes for `json=` (httpx 0.28.1's encode_json:
// json.dumps(ensure_ascii=False, separators=(",", ":"), allow_nan=False)), so a request
// from the JavaScript server is byte for byte the one Python sent. Found by JustVoice's
// extraction comparison, 2026-10-08: JSON.stringify wrote a preset's temperature 0.0 as 0.
import { afterEach, expect, test, vi } from "vitest";
import { httpxBody, httpxRequest, LLMMessage } from "../src/llm/base.js";
import { getLocalRunnerBaseUrl, setLocalRunnerBaseUrl } from "../src/llm/dispatch.js";
import { OllamaAdapter } from "../src/llm/ollama.js";
import { OpenAICompatAdapter } from "../src/llm/openai_compat.js";
import { _plane2Extra, FeaturePromptRow, RunRequest } from "../src/llm/prompts.js";
import { EnginePresetRow } from "../src/llm/presets_api.js";
import * as http from "../src/platform/http.js";
import { model } from "../src/platform/models.js";
import { ValueError } from "../src/platform/py.js";
import { pyFloatValue } from "../src/platform/pyjson.js";

afterEach(() => vi.restoreAllMocks());

test("body_is_the_text_httpx_writes", () => {
  // The expected text is httpx's own output for the same dict.
  const body = {
    model: "m",
    messages: [{ role: "user", content: 'Zoë —   "hi"' }],
    temperature: pyFloatValue(0),
    top_p: pyFloatValue(1),
    min_p: 0.05,
    max_tokens: 5,
    samplers: ["top_k"],
  };
  expect(httpxBody(body)).toBe(
    '{"model":"m","messages":[{"role":"user","content":"Zoë —   \\"hi\\""}],"temperature":0.0,"top_p":1.0,"min_p":0.05,"max_tokens":5,"samplers":["top_k"]}',
  );
  expect(httpxBody(undefined)).toBeUndefined();
});

test("a_nan_is_refused_before_anything_is_sent", async () => {
  // allow_nan=False: httpx raises ValueError while encoding — not a transport error.
  const fetch = vi.spyOn(http, "fetch");
  expect(() => httpxBody({ t: Number.NaN })).toThrow("Out of range float values are not JSON compliant: nan");
  await expect(httpxRequest("POST", "http://127.0.0.1:1", { json: { t: pyFloatValue(Infinity) } })).rejects.toThrow(ValueError);
  await expect(httpxRequest("POST", "http://127.0.0.1:1", { json: { t: -Infinity } })).rejects.toThrow(": -inf");
  expect(fetch).not.toHaveBeenCalled();
});

function captureFetch(reply) {
  const sent = [];
  vi.spyOn(http, "fetch").mockImplementation(async (_url, init) => {
    sent.push(init.body);
    return Response.json(reply);
  });
  return sent;
}

test("the_adapters_send_temperature_and_samplers_as_floats", async () => {
  // Python types temperature and top_p as floats (a FLOAT column, a pydantic float), and a
  // sampler value parses to a float when it isn't an int — each goes out with its ".0".
  const preset = model(EnginePresetRow, { name: "p", topP: 1, samplers: [{ flagName: "repeat_penalty", flagValue: "1.0" }, { flagName: "top_k", flagValue: "40" }] });
  const spec = FeaturePromptRow({ key: "k", feature: "f", system: "", user_template: "", built_in: false });
  const extra = _plane2Extra(spec, model(RunRequest, { action: "k" }), preset);

  const sent = captureFetch({
    model: "m",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const saved = getLocalRunnerBaseUrl();
  setLocalRunnerBaseUrl(() => "http://127.0.0.1:1");
  try {
    await new OpenAICompatAdapter("p", "local-llamacpp", { apiKey: "" }).chat([LLMMessage("user", "hi")], { model: "m", temperature: 0, extra });
  } finally {
    setLocalRunnerBaseUrl(saved);
  }
  expect(sent[0]).toContain('"temperature":0.0');
  expect(sent[0]).toContain('"top_p":1.0,"repeat_penalty":1.0,"top_k":40');

  vi.restoreAllMocks();
  const ollamaSent = captureFetch({ model: "m", message: { role: "assistant", content: "ok" }, done: true });
  await new OllamaAdapter("o", { baseUrl: "http://127.0.0.1:1" }).chat([LLMMessage("user", "hi")], { model: "m", temperature: 1, extra });
  expect(ollamaSent[0]).toContain('"options":{"temperature":1.0,"top_p":1.0,"repeat_penalty":1.0,"top_k":40}');
});
