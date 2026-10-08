// SPDX-License-Identifier: MIT
// Test helpers shared by the kit's suites.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/llm/db.js";
import { openDatabase } from "../src/platform/sql.js";

/** A fresh database with every LLM table, configured as the shared storage. In memory by
 * default; `{ file: true }` puts it in a temp folder (for code that reopens it). */
export function freshDb({ file = false, foreignKeys = true } = {}) {
  const path = file ? join(mkdtempSync(join(tmpdir(), "kit-test-")), "test.db") : ":memory:";
  const h = openDatabase(path, { foreignKeys });
  db.createAll(h);
  db.configureStorage(h);
  return h;
}
