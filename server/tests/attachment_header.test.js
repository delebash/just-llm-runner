// SPDX-License-Identifier: MIT
// `attachment(filename)` — the family's download header. A header carries latin-1 only, so a
// name outside printable ASCII travels as RFC 5987's filename*= beside an ASCII fallback
// (RFC 6266 §4.3); a plain ASCII name keeps the exact header every route wrote before.
import { expect, test } from "vitest";
import { attachment } from "../src/platform/server.js";

test("an_ascii_name_is_the_header_routes_always_wrote", () => {
  expect(attachment("backup.zip")).toBe('attachment; filename="backup.zip"');
  expect(attachment("My Book (2).zip")).toBe('attachment; filename="My Book (2).zip"');
});

test("a_name_outside_ascii_travels_as_filename_star", () => {
  expect(attachment("日本の本.zip")).toBe("attachment; filename=\"____.zip\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E3%81%AE%E6%9C%AC.zip");
  expect(attachment("Café.zip")).toBe("attachment; filename=\"Caf_.zip\"; filename*=UTF-8''Caf%C3%A9.zip");
  // One fallback character per code point, an emoji included.
  expect(attachment("📕.zip")).toMatch(/^attachment; filename="_\.zip"; /);
});

test("the_encoded_name_holds_only_rfc5987_attr_chars_and_reads_back", () => {
  const name = "Ünder 'the' (old) *star*.zip";
  const value = attachment(name);
  const encoded = value.split("filename*=UTF-8''")[1];
  expect(encoded).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
  expect(decodeURIComponent(encoded)).toBe(name);
  expect([...value].every((c) => c >= " " && c <= "~")).toBe(true);
});

test("a_quote_or_backslash_goes_to_the_fallback_safely", () => {
  expect(attachment('a"b\\c.zip')).toBe("attachment; filename=\"a_b_c.zip\"; filename*=UTF-8''a%22b%5Cc.zip");
});
