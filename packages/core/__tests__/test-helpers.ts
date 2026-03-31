/**
 * Shared test context helper — eliminates boilerplate for beforeEach/afterAll
 * context setup across core test files.
 *
 * Usage:
 *   import { withTestContext } from "./test-helpers.js";
 *   const { getCtx } = withTestContext();
 */

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
