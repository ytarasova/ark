/**
 * Test setup preload — isolate test state from production.
 *
 * Sets ARK_TEST_DIR for legacy code paths that haven't migrated to AppContext.
 * Tests using AppContext.forTest() create their own isolated temp dir and
 * don't need this — they get full isolation via app.boot() + app.shutdown().
 */

import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

if (!process.env.ARK_TEST_DIR) {
  const testDir = mkdtempSync(join(tmpdir(), "ark-test-"));
  process.env.ARK_TEST_DIR = testDir;
  process.env.NODE_ENV = "test";
}
