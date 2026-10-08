// SPDX-License-Identifier: MIT
// `model()` refusing a value says what pydantic's ValidationError said: the count and the model,
// then each field and its reason — and a nullable field that fails counts once (the null
// branch's "must be null" is not an error). Found by JustVoice's API wave, 2026-10-08: Python
// said "1 validation error for Delivery\nspeed\n  Input should be a valid number…", the kit
// said "2 validation errors for Delivery".
import { expect, test } from "vitest";
import { model, ModelValidationError, nullable, opt, T } from "../src/platform/models.js";

const Delivery = T.Object({ speed: opt(nullable(T.Number()), null), pitch: opt(nullable(T.Number()), null) }, { title: "Delivery" });

const refusal = (value) => {
  try {
    model(Delivery, value);
  } catch (e) {
    expect(e).toBeInstanceOf(ModelValidationError);
    return e;
  }
  throw new Error("accepted");
};

test("a_nullable_field_that_fails_is_one_error", () => {
  const e = refusal({ speed: "fast" });
  expect(e.errors.length).toBe(1);
  expect(e.message).toBe("1 validation error for Delivery\nspeed\n  Input should be a valid number, unable to parse string as a number");
});

test("each_failing_field_gets_its_lines", () => {
  const e = refusal({ speed: "fast", pitch: "high" });
  expect(e.message.split("\n")).toEqual([
    "2 validation errors for Delivery",
    "speed",
    "  Input should be a valid number, unable to parse string as a number",
    "pitch",
    "  Input should be a valid number, unable to parse string as a number",
  ]);
});

test("a_good_value_and_null_still_pass", () => {
  expect(model(Delivery, { speed: 1.5, pitch: null })).toEqual({ speed: 1.5, pitch: null });
});
