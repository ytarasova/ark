/**
 * Test setup - isolate test state from production.
 * Sets ARK_TEST_DIR so tests use a temporary database, not ~/.ark/ark.db.
 */

import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

if (!process.env.ARK_TEST_DIR) {
  const testDir = mkdtempSync(join(tmpdir(), "ark-test-"));
  process.env.ARK_TEST_DIR = testDir;
  process.env.NODE_ENV = "test";
}
