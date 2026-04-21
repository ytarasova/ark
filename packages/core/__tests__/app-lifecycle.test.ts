/**
 * Tests for AppContext lifecycle -- singleton clearing on shutdown,
 * accessor guards before boot, accessor availability after boot.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

describe("AppContext lifecycle", async () => {
  let app: AppContext | null = null;

  afterEach(async () => {
    if (app) {
      await app.shutdown();
      clearApp();
      app = null;
    }
  });

  // The old test "getApp() throws after shutdown() clears the singleton"
  // exercised a module-level service locator that no longer exists --
  // AppContext is now injected explicitly or resolved via the DI container.

  it("todos accessor throws before boot()", async () => {
    app = await AppContext.forTestAsync();
    // Not booted yet -- todos should throw
    expect(() => app!.todos).toThrow("AppContext not booted");
  });

  it("todos accessor works after boot()", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    // Should not throw -- todos initialized during boot
    expect(() => app!.todos).not.toThrow();
    expect(app!.todos).toBeDefined();
  });

  it("other accessors throw before boot()", async () => {
    app = await AppContext.forTestAsync();
    expect(() => app!.sessions).toThrow("AppContext not booted");
    expect(() => app!.events).toThrow("AppContext not booted");
    expect(() => app!.messages).toThrow("AppContext not booted");
    expect(() => app!.computes).toThrow("AppContext not booted");
    expect(() => app!.db).toThrow("AppContext not booted");
  });

  // The old test "shutdown only clears singleton when it matches the
  // current app" relied on a global AppContext singleton that has been
  // removed. Tests that need concurrent AppContexts now hold their own
  // references.
});
