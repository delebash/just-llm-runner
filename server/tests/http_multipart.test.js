// SPDX-License-Identifier: MIT
// platform/http.js `multipart`: the body it writes reads back as the same fields and files.
// (It replaced FormData, which this module's own undici copy sent as "[object FormData]"
// when another copy made it — found by JustVoice's port, 2026-10-08.)
import { expect, test } from "vitest";
import { multipart } from "../src/platform/http.js";

test("multipart_reads_back_as_its_parts", async () => {
  const wav = Buffer.from([0, 1, 2, 255, 13, 10]);
  const { body, contentType } = multipart([
    { name: "text", data: 'a "quoted" line\r\nand é' },
    { name: "audio", filename: "clip.wav", contentType: "audio/wav", data: wav },
  ]);
  expect(contentType).toMatch(/^multipart\/form-data; boundary=[0-9a-f]{32}$/);
  const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  expect(form.get("text")).toBe('a "quoted" line\r\nand é');
  const file = form.get("audio");
  expect(file.name).toBe("clip.wav");
  expect(file.type).toBe("audio/wav");
  expect(Buffer.from(await file.arrayBuffer())).toEqual(wav);
});
