// SPDX-License-Identifier: MIT
// Port of tests/test_load_failure_message.py — what a failed model load tells the user
// (2026-09-29): the message leads with what is MEASURED (other processes holding GPU memory,
// then llama.cpp's own error line) and lists the causes after, unranked.
//
// Every test here drives runner/lifecycle.js (`_router_load_with_backoff`, `_gpu_holders_note`,
// `_engine_error_line`, `_other_gpu_holders`) through test_lifecycle's fixtures, so all ten
// wait for the lifecycle port (wave 3). The names are kept as `test.todo` so the count
// compares 1:1; nothing here depends on process.js or arbiter.js alone.
import { test } from "vitest";

// Waits for runner/lifecycle.js (wave 3):
test.todo("mtp_failure_names_the_other_gpu_holders_first");
test.todo("mtp_failure_with_nobody_else_on_the_gpu");
test.todo("a_failing_probe_never_breaks_the_message");
test.todo("holders_note_lists_four_and_counts_the_rest");
test.todo("holders_note_is_empty_when_unmeasurable");
test.todo("engine_error_line_drops_the_log_prefix");
test.todo("other_programs_on_the_gpu_skip_the_restart");
test.todo("nobody_else_on_the_gpu_still_gets_the_one_restart");
test.todo("when_the_gpu_cant_be_read_it_restarts_as_before");
test.todo("unmeasurable_is_not_a_holder");
