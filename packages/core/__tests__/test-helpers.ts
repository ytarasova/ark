/**
 * Shared test context helper — eliminates boilerplate for beforeEach/afterAll
 * context setup across core test files.
 *
 * Usage:
 *   import { withTestContext } from "./test-helpers.js";
 *   const { getCtx } = withTestContext();
 *
 *   import { waitFor } from "./test-helpers.js";
 *   await waitFor(() => someCondition());
 */

import { beforeEach, afterAll } from "bun:test";
import { createTestContext, setContext, resetContext, type TestContext } from "../context.js";

/**
 * Sets up beforeEach/afterAll hooks for test context isolation.
 * Returns a getter for the current context (since it's recreated each test).
 */
export function withTestContext(): { getCtx: () => TestContext } {
  let ctx: TestContext;

  beforeEach(() => {
    if (ctx) ctx.cleanup();
    ctx = createTestContext();
    setContext(ctx);
  });

  afterAll(() => {
    if (ctx) ctx.cleanup();
    resetContext();
  });

  return { getCtx: () => ctx };
}

/** Poll a condition until it's true or timeout. Better than arbitrary setTimeout. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  opts?: { timeout?: number; interval?: number; message?: string }
): Promise<void> {
  const timeout = opts?.timeout ?? 5000;
  const interval = opts?.interval ?? 50;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(opts?.message ?? `waitFor timed out after ${timeout}ms`);
}
